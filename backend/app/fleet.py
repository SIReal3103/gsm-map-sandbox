"""Render-derived candidates, not assertions of car access; /api/route must snap them."""
import hashlib
import json
from functools import lru_cache


def select_candidates(collection, bbox):
    w, s, e, n = bbox
    cells = {}
    # Spread anchors across the display area; never sample outside coverage.
    for feature in sorted(collection["features"], key=lambda f: str(f.get("id", ""))):
        props, geometry = feature.get("properties", {}), feature.get("geometry", {})
        if geometry.get("type") != "LineString" or props.get("highway") not in {
            "primary", "secondary", "tertiary", "residential", "unclassified"
        }:
            continue
        for lon, lat in geometry["coordinates"]:
            if not (w < lon < e and s < lat < n):
                continue
            cell = (min(5, int((lon-w)/(e-w)*6)), min(3, int((lat-s)/(n-s)*4)))
            if cell not in cells:
                cells[cell] = {"id": f"{feature['id']}:{lon},{lat}", "osm_id": str(feature["id"]),
                               "name": props.get("name", "Đường OSM không tên"), "coordinate": [lon, lat]}
    return [cells[key] for key in sorted(cells)]


@lru_cache(maxsize=2)
def _read_candidates(path, mtime_ns, size, bbox):
    raw = path.read_bytes()
    return select_candidates(json.loads(raw), bbox), hashlib.sha256(raw).hexdigest()


def candidate_catalog(settings, sampling_bbox=None):
    stat = settings.map_path.stat()
    w, s, e, n = settings.region.display_bbox
    # Keep demo OD points away from the extraction/render edge. This does not
    # change the display/routing bbox and does not assert graph connectivity.
    if sampling_bbox is None:
        sampling_bbox = (w+(e-w)*.2, s+(n-s)*.2, e-(e-w)*.2, n-(n-s)*.2)
    sw, ss, se, sn = sampling_bbox
    if not (w <= sw < se <= e and s <= ss < sn <= n):
        raise ValueError("Sampling bbox must be inside display coverage")
    candidates, streets_hash = _read_candidates(settings.map_path, stat.st_mtime_ns, stat.st_size,
                                               sampling_bbox)
    manifest = json.loads((settings.routing_dir / "manifest.json").read_text(encoding="utf-8"))
    provenance = {"extract_sha256": manifest["extract_sha256"], "streets_sha256": streets_hash,
                  "image_digest": manifest["image_digest"], "profile_sha256": manifest["profile_sha256"],
                  "profile": manifest["profile"], "algorithm": manifest["algorithm"],
                  "router_url": settings.osrm_base_url, "max_snap_meters": settings.max_snap_meters,
                  "display_bbox": list(settings.region.display_bbox), "sampling_bbox": list(sampling_bbox), "candidate_version": 2}
    fingerprint = hashlib.sha256(json.dumps(provenance, sort_keys=True).encode()).hexdigest()
    return {"candidates": candidates, "datasetFingerprint": fingerprint, "provenance": provenance,
            "routingSource": "OSRM local / car / MLD", "candidateSource": "Local OSM streets vertices; car snapping unverified"}
