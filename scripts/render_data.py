"""Osmium exports real geometry; Python only validates/reduces its GeoJSON output."""
import json
import math
from pathlib import Path


def positions(geometry):
    def walk(value):
        if value and isinstance(value[0], (float, int)):
            yield value
        else:
            for child in value:
                yield from walk(child)
    yield from walk(geometry["coordinates"])


def validate_geometry(geometry):
    if geometry.get("type") not in {"Point", "LineString", "MultiLineString", "Polygon", "MultiPolygon"}:
        raise ValueError("Unsupported OSM render geometry")
    points = list(positions(geometry))
    if not points or any(len(p) != 2 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in p)
                         or not (-180 <= p[0] <= 180 and -90 <= p[1] <= 90) for p in points):
        raise ValueError("Invalid WGS84 geometry")
    if geometry["type"] == "LineString" and len(points) < 2:
        raise ValueError("Degenerate line")
    polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"] if geometry["type"] == "MultiPolygon" else []
    for polygon in polygons:
        if not polygon or any(len(ring) < 4 or ring[0] != ring[-1] for ring in polygon):
            raise ValueError("Invalid polygon ring")
    return points


def prepare_display(settings, extracted, osmium, dry):
    from scripts.pipeline import refuse_existing, sha256, write_json
    output = settings.map_path.parent
    manifest_path = output / "manifest.json"
    if not dry and manifest_path.exists():
        old = json.loads(manifest_path.read_text(encoding="utf-8"))
        if old.get("extract_sha256") == sha256(extracted) and all(sha256(output / name) == entry["sha256"] for name, entry in old.get("layers", {}).items()):
            print("REUSE verified render layers")
            return
    if not dry:
        refuse_existing([manifest_path, output / "render-input.osm.pbf", output / "export.geojson"])
    filtered, exported = output / "render-input.osm.pbf", output / "export.geojson"
    osmium.run(["tags-filter", extracted, "w/highway", "wr/natural=water", "w/waterway",
                "wr/leisure=park,garden", "wr/landuse=grass,forest,recreation_ground", "wr/building",
                "n/tourism=attraction,museum", "n/historic", "n/amenity=marketplace", "-o", filtered], output)
    osmium.run(["export", filtered, "--geometry-types=linestring,polygon,point", "--add-unique-id=type_id",
                "--stop-on-error", "-o", exported], output)
    if dry:
        return
    source = json.loads(exported.read_text(encoding="utf-8"))
    if source.get("type") != "FeatureCollection" or not source.get("features"):
        raise ValueError("Empty Osmium export")
    layers = {name: [] for name in ["streets", "water", "green", "buildings", "places"]}
    seen, duplicates, outside = set(), 0, 0
    w, s, e, n = settings.region.display_bbox
    # Small render buffer for pan continuity, independent of the untouched routing PBF.
    w, s, e, n = w - .005, s - .005, e + .005, n + .005
    for feature in source["features"]:
        geometry, props = feature["geometry"], feature.get("properties", {})
        points = validate_geometry(geometry)
        if max(p[0] for p in points) < w or min(p[0] for p in points) > e or max(p[1] for p in points) < s or min(p[1] for p in points) > n:
            outside += 1
            continue
        kind = geometry["type"]
        key = (feature.get("id"), kind, json.dumps(geometry["coordinates"], separators=(",", ":")))
        if key in seen:
            duplicates += 1
            continue
        seen.add(key)
        area = kind in {"Polygon", "MultiPolygon"}
        line = kind in {"LineString", "MultiLineString"}
        layer = None
        if line and props.get("highway"):
            layer = "streets"
        elif props.get("natural") == "water" and area or props.get("waterway") and line:
            layer = "water"
        elif area and (props.get("leisure") in {"park", "garden"} or props.get("landuse") in {"grass", "forest", "recreation_ground"}):
            layer = "green"
        elif area and props.get("building"):
            layer = "buildings"
        elif kind == "Point" and props.get("name"):
            layer = "places"
        if layer:
            # No routing tags are removed from the OSRM input, only from these rendering copies.
            feature["properties"] = {k: v for k, v in props.items() if k in {"name", "highway", "waterway", "natural", "leisure", "landuse", "building", "tourism", "historic", "amenity", "oneway"}}
            layers[layer].append(feature)
    if not layers["streets"]:
        raise ValueError("No real roads in display region")
    metadata = {"source": settings.region.source, "attribution": settings.region.attribution,
                "extract_sha256": sha256(extracted), "display_bbox": settings.region.display_bbox,
                "render_bbox": [w, s, e, n], "osmium_image": osmium.image,
                "exported_features": len(source["features"]), "duplicate_features_removed": duplicates,
                "outside_features_removed": outside, "layers": {}}
    for name, features in layers.items():
        path = output / f"{name}.geojson"
        refuse_existing([path])
        path.write_text(json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        metadata["layers"][path.name] = {"features": len(features), "size_bytes": path.stat().st_size, "sha256": sha256(path)}
    if sum(v["size_bytes"] for v in metadata["layers"].values()) > 64 * 1024 * 1024:
        raise ValueError("Render data exceeds 64 MiB; measure before considering tiles")
    write_json(manifest_path, metadata)
