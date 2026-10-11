"""Real-data audit only. Requires completed extract and a running loopback OSRM."""
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.app.config import Settings
from scripts.pipeline import Osmium, sha256, write_json
from scripts.render_data import validate_geometry


def main():
    settings = Settings()
    output = ROOT / "data/processed/graph-audit"
    output.mkdir(exist_ok=True)
    extracted = ROOT / "data/extracted/hcm-center.osm.pbf"
    osmium = Osmium(settings, False)
    xml_path = output / "roads-restrictions.osm"
    if not xml_path.exists():
        filtered = output / "roads-restrictions.osm.pbf"
        osmium.run(["tags-filter", extracted, "w/highway", "r/type=restriction", "-o", filtered], output)
        osmium.run(["cat", filtered, "-f", "osm", "-o", xml_path], output)
    nodes, ways, restrictions = {}, {}, []
    for _, el in ET.iterparse(xml_path, events=["end"]):
        if el.tag == "node":
            nodes[int(el.attrib["id"])] = [float(el.attrib["lon"]), float(el.attrib["lat"])]
            el.clear()
        elif el.tag == "way":
            ways[int(el.attrib["id"])] = {"nodes": [int(nd.attrib["ref"]) for nd in el.findall("nd")],
                                          "tags": {t.attrib["k"]: t.attrib["v"] for t in el.findall("tag")}}
            el.clear()
        elif el.tag == "relation":
            tags = {t.attrib["k"]: t.attrib["v"] for t in el.findall("tag")}
            if tags.get("type") == "restriction":
                restrictions.append({"id": int(el.attrib["id"]), "tags": tags,
                                     "members": [dict(m.attrib) for m in el.findall("member")]})
            el.clear()
    missing = [{"relation": r["id"], **m} for r in restrictions for m in r["members"]
               if int(m["ref"]) not in (ways if m["type"] == "way" else nodes if m["type"] == "node" else {r["id"]: r for r in restrictions})]
    edges = {}
    oneway_ways = 0
    for way_id, way in ways.items():
        tags = way["tags"]
        if not tags.get("highway"):
            continue
        direction = tags.get("oneway", "yes" if tags.get("junction") == "roundabout" else "no")
        if tags.get("oneway:motor_vehicle") == "no" or tags.get("oneway:motorcar") == "no":
            direction = "no"
        if direction in {"yes", "1", "true", "-1"}:
            oneway_ways += 1
        for a, b in zip(way["nodes"], way["nodes"][1:]):
            edges.setdefault((a, b), []).append((way_id, direction != "-1"))
            edges.setdefault((b, a), []).append((way_id, direction not in {"yes", "1", "true"}))
    with httpx.Client(base_url=settings.osrm_base_url, timeout=10, trust_env=False) as client:
        def route(a, b):
            return client.get(f'/route/v1/driving/{a[0]},{a[1]};{b[0]},{b[1]}', params={"overview": "full", "geometries": "geojson", "annotations": "nodes", "radiuses": "100;100"}).json()
        a, b = [106.6983, 10.7723], [106.6995, 10.7799]
        smoke = route(a, b)
        assert smoke["code"] == "Ok"
        result = smoke["routes"][0]
        validate_geometry(result["geometry"])
        assert result["distance"] > 0 and result["duration"] > 0 and max(p["distance"] for p in smoke["waypoints"]) <= 100
        write_json(ROOT / "docs/evidence/a1/osrm-smoke.json", {"start": a, "end": b, "response": smoke})
        route_nodes = list(result["legs"][0]["annotation"]["nodes"])
        violations = [{"from": x, "to": y, "ways": edges[(x, y)]} for x, y in zip(route_nodes, route_nodes[1:])
                      if (x, y) in edges and not any(allowed for _, allowed in edges[(x, y)])]
        directed_checked = sum((x, y) in edges and any(not allowed for _, allowed in edges[(y, x)]) for x, y in zip(route_nodes, route_nodes[1:]))
        # Sample a 3x3 grid of actual nearest road points across the configured display region.
        w, s, e, n = settings.region.display_bbox
        samples = []
        for ix in range(3):
            for iy in range(3):
                lon, lat = w + (ix + .5) / 3 * (e - w), s + (iy + .5) / 3 * (n - s)
                data = client.get(f'/nearest/v1/driving/{lon},{lat}').json()
                assert data["code"] == "Ok"
                samples.append({"query": [lon, lat], "location": data["waypoints"][0]["location"], "snap_meters": data["waypoints"][0]["distance"]})
        coordinates = ";".join(f'{p["location"][0]},{p["location"][1]}' for p in samples)
        table = client.get(f'/table/v1/driving/{coordinates}').json()
        assert table["code"] == "Ok"
        connected_pairs = sum(v is not None for row in table["durations"] for v in row)
        restriction_tests = []
        for r in restrictions:
            if len(restriction_tests) >= 10:
                break
            tags = r["tags"]
            if tags.get("restriction") not in {"no_left_turn", "no_right_turn", "no_straight_on"} or tags.get("except") or tags.get("restriction:conditional"):
                continue
            members = {m["role"]: m for m in r["members"]}
            if not {"from", "via", "to"} <= members.keys() or members["via"]["type"] != "node":
                continue
            via = int(members["via"]["ref"])
            if via not in nodes or not (w <= nodes[via][0] <= e and s <= nodes[via][1] <= n):
                continue
            f, t = int(members["from"]["ref"]), int(members["to"]["ref"])
            if f not in ways or t not in ways:
                continue
            incoming = [x for x in ways[f]["nodes"] if (x, via) in edges and any(wid == f and allowed for wid, allowed in edges[(x, via)])]
            outgoing = [y for y in ways[t]["nodes"] if (via, y) in edges and any(wid == t and allowed for wid, allowed in edges[(via, y)])]
            if not incoming or not outgoing:
                continue
            prev, nxt = incoming[0], outgoing[0]
            # Start farther back on from-way so annotation includes the turn approach.
            f_nodes, t_nodes = ways[f]["nodes"], ways[t]["nodes"]
            starts = [x for x in f_nodes if (x, prev) in edges and x != via and any(wid == f and ok for wid, ok in edges[(x, prev)])]
            ends = [y for y in t_nodes if (nxt, y) in edges and y != via and any(wid == t and ok for wid, ok in edges[(nxt, y)])]
            if not starts or not ends:
                continue
            response = route(nodes[starts[0]], nodes[ends[0]])
            if response.get("code") != "Ok":
                continue
            annotations = response["routes"][0]["legs"][0]["annotation"]["nodes"]
            prohibited = any(tuple(annotations[i:i+3]) == (prev, via, nxt) for i in range(len(annotations)-2))
            approached_from = any(tuple(annotations[i:i+2]) == (prev, via) for i in range(len(annotations)-1))
            if not approached_from or response["routes"][0]["distance"] <= 0:
                continue  # A snap to a different approach cannot verify this restriction.
            restriction_tests.append({"relation": r["id"], "restriction": tags["restriction"], "from_way": f, "to_way": t,
                "via_node": via, "prohibited_turn_present": prohibited, "approached_from_way": approached_from,
                "distance": response["routes"][0]["distance"], "geometry_points": len(response["routes"][0]["geometry"]["coordinates"])})
        # River interior: a genuine NoSegment response using the configured snap threshold.
        nosegment = route([106.719, 10.776], a)
    manual = json.loads((ROOT / "data/processed/manual-audit/roads.geojson").read_text(encoding="utf-8"))
    current = json.loads(settings.map_path.read_text(encoding="utf-8"))
    def coverage(features):
        bins, ids = [[0]*5 for _ in range(5)], set()
        for f in features:
            inside = False
            for lon, lat in validate_geometry(f["geometry"]):
                if w <= lon < e and s <= lat < n:
                    bins[min(4, int((lat-s)/(n-s)*5))][min(4, int((lon-w)/(e-w)*5))] += 1
                    inside = True
            if inside:
                ids.add(f.get("id"))
        return bins, ids
    manual_bins, manual_ids = coverage(manual["features"])
    new_bins, new_ids = coverage(current["features"])
    report = {"extract_sha256": sha256(extracted), "road_ways": sum(bool(w["tags"].get("highway")) for w in ways.values()),
              "oneway_ways": oneway_ways, "restriction_relations": len(restrictions), "missing_restriction_members": missing,
              "coverage": {"manual_grid_vertices": manual_bins, "new_grid_vertices": new_bins, "roads_in_display_manual": len(manual_ids),
                           "roads_in_display_new": len(new_ids), "new_road_ids_absent_manual": len(new_ids-manual_ids)},
              "connectivity": {"samples": samples, "connected_table_entries": connected_pairs, "table_entries": 81, "durations": table["durations"]},
              "smoke_oneway_check": {"annotation_nodes": len(route_nodes), "directed_edges_checked": directed_checked, "violations": violations},
              "restriction_smoke_tests": restriction_tests, "river_nosegment": nosegment}
    write_json(ROOT / "docs/evidence/a1/graph-audit.json", report)
    assert not missing and not violations and connected_pairs == 81
    assert restriction_tests and not any(r["prohibited_turn_present"] for r in restriction_tests)
    assert nosegment["code"] == "NoSegment"
    print(json.dumps({"road_ways": report["road_ways"], "missing_restriction_members": missing,
                      "connected_table_entries": connected_pairs, "oneway_violations": violations,
                      "restriction_tests": len(restriction_tests), "nosegment": nosegment["code"]}))
    return report


if __name__ == "__main__":
    main()
