"""Contract fixtures are synthetic. Real integration checks explicitly opt in with RUN_REAL_DATA=1."""
import copy
import json
import os
from pathlib import Path, PureWindowsPath
import httpx
import pytest
from fastapi.testclient import TestClient
from test_backend import settings, fixture_graph, mock_osrm
from backend.app.config import Settings, PROJECT_ROOT
from backend.app.dataset import artifact_status, pbf_status
from backend.app.main import create_app
from scripts.pipeline import sha256
from scripts.render_data import validate_geometry

BODY = {"code": "Ok", "routes": [{"geometry": {"type": "LineString", "coordinates": [[106.69, 10.77], [106.70, 10.78]]}, "distance": 1200, "duration": 180}],
        "waypoints": [{"location": [106.69, 10.77], "distance": 2}, {"location": [106.70, 10.78], "distance": 3}]}
PAYLOAD = {"start": [106.69, 10.77], "end": [106.70, 10.78]}


@pytest.mark.parametrize("change", ["missing_geometry", "missing_type", "wrong_geometry", "one_point", "nan", "no_distance", "zero_distance", "negative_distance", "no_duration", "zero_duration", "one_snap", "outside_region"])
def test_malformed_router_fails_closed(settings, monkeypatch, change):
    fixture_graph(settings)
    body = copy.deepcopy(BODY)
    route = body["routes"][0]
    if change == "missing_geometry": del route["geometry"]
    elif change == "missing_type": del route["geometry"]["type"]
    elif change == "wrong_geometry": route["geometry"]["type"] = "Polygon"
    elif change == "one_point": route["geometry"]["coordinates"] = [[106.69, 10.77]]
    elif change == "nan": route["geometry"]["coordinates"] = [[181, 10], [106.69, 10.77]]
    elif change == "no_distance": del route["distance"]
    elif change == "zero_distance": route["distance"] = 0
    elif change == "negative_distance": route["distance"] = -1
    elif change == "no_duration": del route["duration"]
    elif change == "zero_duration": route["duration"] = 0
    elif change == "one_snap": body["waypoints"].pop()
    elif change == "outside_region": route["geometry"]["coordinates"][1] = [107, 11]
    mock_osrm(monkeypatch, body)
    response = TestClient(create_app(settings)).post("/api/route", json=PAYLOAD)
    assert response.status_code == 502
    assert "coordinates" not in response.json()


def test_timeout_has_distinct_code(settings, monkeypatch):
    fixture_graph(settings)
    original = httpx.AsyncClient
    def timeout(request):
        raise httpx.ReadTimeout("fixture timeout", request=request)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: original(transport=httpx.MockTransport(timeout), **kw))
    response = TestClient(create_app(settings)).post("/api/route", json=PAYLOAD)
    assert response.status_code == 503 and response.json()["error"]["code"] == "ROUTER_TIMEOUT"


def test_source_verification_invalidated_by_change(settings):
    fixture_graph(settings)
    assert pbf_status(settings)["format_verified"]
    settings.pbf_path.write_bytes(b"changed fixture bytes")
    assert not pbf_status(settings)["format_verified"]
    assert TestClient(create_app(settings)).post("/api/route", json=PAYLOAD).json()["error"]["code"] == "DATASET_NOT_READY"


def test_incomplete_or_changed_graph_not_ready(settings):
    fixture_graph(settings)
    marker = settings.routing_dir / ".incomplete"
    marker.write_text("fixture")
    assert not artifact_status(settings)["graph_ready"]
    marker.unlink()
    assert artifact_status(settings)["graph_ready"]
    (settings.routing_dir / "hcm-center.osrm.mldgr").write_bytes(b"truncated")
    assert not artifact_status(settings)["graph_ready"]


@pytest.mark.parametrize("sizes", [None, ["not-a-size-map"]])
def test_corrupt_artifact_manifest_is_not_ready(settings, sizes):
    fixture_graph(settings)
    path = settings.routing_dir / "manifest.json"
    manifest = json.loads(path.read_text())
    manifest["artifact_sizes"] = sizes
    path.write_text(json.dumps(manifest))
    assert not artifact_status(settings)["graph_ready"]


def test_dataset_lifecycle_and_router_down(settings, monkeypatch):
    fixture_graph(settings)
    settings.map_path.parent.mkdir()
    settings.map_path.write_text('{"type":"FeatureCollection","features":[]}')
    manifest = {"display_bbox": settings.region.display_bbox, "layers": {"streets.geojson": {"features": 1, "size_bytes": settings.map_path.stat().st_size}}}
    (settings.map_path.parent / "manifest.json").write_text(json.dumps(manifest))
    original = httpx.AsyncClient
    mock_osrm(monkeypatch, {"code": "Ok", "waypoints": BODY["waypoints"]})
    client = TestClient(create_app(settings))
    assert client.get("/api/dataset/status").json()["ready"] is True
    monkeypatch.setattr(httpx, "AsyncClient", original)
    mock_osrm(monkeypatch, unavailable=True)
    data = client.get("/api/dataset/status").json()
    assert data["ready"] is False and data["artifacts"]["graph_built"] is True and data["artifacts"]["graph_ready"] is False


def test_map_layer_allowlist(settings):
    client = TestClient(create_app(settings))
    assert client.get("/api/map/private").status_code == 404
    assert client.get("/api/map/water").status_code == 503


@pytest.mark.parametrize("geometry", [
    {"type": "Point", "coordinates": [181, 10]},
    {"type": "LineString", "coordinates": [[106, 10]]},
    {"type": "Polygon", "coordinates": [[[106, 10], [107, 10], [107, 11], [106, 11]]]},
])
def test_geojson_validator_rejects_bad_geometry(geometry):
    with pytest.raises(ValueError):
        validate_geometry(geometry)


real = pytest.mark.skipif(os.environ.get("RUN_REAL_DATA") != "1", reason="Explicit real-data integration opt-in required")


@real
def test_real_geojson_and_protected_inputs():
    s = Settings()
    before = json.loads((PROJECT_ROOT / "docs/evidence/a1/preflight.json").read_text(encoding="utf-8"))
    # The original national snapshot is still protected. Resolve its path in
    # this checkout without changing the independently recorded checksum.
    entry = before['inputs'][0]
    assert sha256(s.pbf_path).upper() == entry['sha256'].upper()
    source = pbf_status(s)['verification']
    assert source['format_verified'] and sha256(s.pbf_path) == source['sha256']
    manifest = json.loads((s.map_path.parent / "manifest.json").read_text(encoding="utf-8"))
    for filename, entry in manifest["layers"].items():
        path = s.map_path.parent / filename
        assert sha256(path) == entry["sha256"]
        collection = json.loads(path.read_text(encoding="utf-8"))
        assert collection["type"] == "FeatureCollection" and len(collection["features"]) == entry["features"] > 0
        for f in collection["features"]:
            validate_geometry(f["geometry"])
    graph = artifact_status(s)["routing_manifest"]
    assert sha256(s.resolve(graph["input_path"])) == graph["extract_sha256"] == sha256(s.resolve(graph["extract_path"]))
    extract = json.loads((s.routing_dir.parent / 'extracted/hcm-center.osm.metadata.json').read_text())
    assert extract['source_sha256'] == source['sha256']
    assert extract['extract_sha256'] == graph['extract_sha256']


@real
def test_archived_manual_input_checksum():
    before = json.loads((PROJECT_ROOT / 'docs/evidence/a1/preflight.json').read_text())
    entry = before['inputs'][1]
    parts = PureWindowsPath(entry['path']).parts
    path = PROJECT_ROOT / Path(*parts[parts.index('data'):])
    if not path.is_file():
        pytest.skip('Archived Windows A1 manual PBF is not installed; active smart extract is checked separately')
    assert sha256(path).upper() == entry['sha256'].upper()


@real
def test_real_local_api_route_and_nosegment():
    client = TestClient(create_app(Settings()))  # Real local HTTP OSRM, no mock transport.
    assert client.get("/api/dataset/status").json()["ready"] is True
    response = client.post("/api/route", json={"start": [106.6983, 10.7723], "end": [106.6995, 10.7799]})
    assert response.status_code == 200
    data = response.json()
    assert len(data["coordinates"]) > 2 and data["distance"] > 0 and data["duration"] > 0
    assert all(p["distance"] <= 100 for p in data["snap_points"])
    response = client.post("/api/route", json={"start": [106.719, 10.776], "end": [106.6983, 10.7723]})
    assert response.status_code == 422 and response.json()["error"]["code"] == "NOSEGMENT"
