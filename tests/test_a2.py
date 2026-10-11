import hashlib
import json
import os

import pytest
from fastapi.testclient import TestClient
from backend.app.config import Settings
from backend.app.main import create_app
from backend.app.fleet import select_candidates, candidate_catalog


def test_candidates_are_deterministic_osm_vertices_inside_display():
    # Explicit synthetic geometry fixture only; not runtime HCMC data.
    features = [{"id": "w-fixture", "properties": {"highway": "residential"},
                 "geometry": {"type": "LineString", "coordinates": [[1, 1], [2, 2], [9, 9]]}},
                {"id": "pedestrian-fixture", "properties": {"highway": "footway"},
                 "geometry": {"type": "LineString", "coordinates": [[3, 3], [4, 4]]}}]
    data = {"type": "FeatureCollection", "features": features}
    candidates = select_candidates(data, [0, 0, 5, 5])
    assert candidates == select_candidates({**data, "features": list(reversed(features))}, [0, 0, 5, 5])
    assert len(candidates) == 2
    assert all(c["coordinate"] in [[1, 1], [2, 2]] and c["osm_id"] == "w-fixture" for c in candidates)


def test_missing_dataset_does_not_return_candidates(tmp_path):
    settings = Settings(osm_pbf_path=str(tmp_path / "missing.osm.pbf"))
    response = TestClient(create_app(settings)).get("/api/fleet/candidates")
    assert response.status_code == 503 and response.json()["error"]["code"] == "DATASET_NOT_READY"


@pytest.mark.skipif(os.environ.get("RUN_REAL_DATA") != "1", reason="Requires verified local OSM and OSRM")
def test_real_candidate_provenance_and_routes():
    settings = Settings()
    catalog = candidate_catalog(settings)
    assert len(catalog["candidates"]) >= 10
    assert catalog["provenance"]["streets_sha256"] == hashlib.sha256(settings.map_path.read_bytes()).hexdigest()
    collection = json.loads(settings.map_path.read_text(encoding="utf-8"))
    by_id = {str(f["id"]): f for f in collection["features"]}
    for candidate in catalog["candidates"]:
        assert candidate["coordinate"] in by_id[candidate["osm_id"]]["geometry"]["coordinates"]
    client = TestClient(create_app(settings))
    assert client.get("/api/fleet/candidates").status_code == 200
    # Real distinct directed OD routes, not fixture/mocked HTTP.
    successful = []
    for start, end in zip(catalog["candidates"][:10], catalog["candidates"][10:20]):
        response = client.post("/api/route", json={"start": start["coordinate"], "end": end["coordinate"]})
        assert response.status_code == 200, response.text
        route = response.json()
        assert route["duration"] > 0 and route["distance"] > 0 and len(route["coordinates"]) > 2
        assert all(point["distance"] <= 100 for point in route["snap_points"])
        successful.append(json.dumps(route["coordinates"]))
    assert len(set(successful)) == 10
