"""Synthetic contract fixtures only; no HCM map or OSRM graph is generated here."""
import json
from pathlib import Path
import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from backend.app import config
from backend.app.config import Settings, Region, PROJECT_ROOT
from backend.app.dataset import pbf_status, artifact_status, GRAPH_FILES
from backend.app.main import create_app
from backend.app.schemas import RouteRequest
from scripts.pipeline import main, refuse_existing


@pytest.fixture
def settings(tmp_path, monkeypatch):
    region_path = PROJECT_ROOT / "config/region.json"
    monkeypatch.setattr(config, "PROJECT_ROOT", tmp_path)
    return Settings(_env_file=None, region_config_path=str(region_path))


def mock_osrm(monkeypatch, body=None, unavailable=False, status=200):
    original = httpx.AsyncClient
    calls = []
    def handler(request):
        calls.append(request)
        if unavailable:
            raise httpx.ConnectError("fixture: router offline", request=request)
        return httpx.Response(status, json=body or {"code": "Ok"}, request=request)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    return calls


def fixture_graph(settings):
    # Dummy bytes are contract fixtures; never used to launch OSRM.
    settings.pbf_path.parent.mkdir(parents=True)
    settings.pbf_path.write_bytes(b"TEST FIXTURE, NOT PBF")
    settings.routing_dir.mkdir(parents=True)
    for name in GRAPH_FILES:
        (settings.routing_dir / name).write_bytes(b"TEST FIXTURE, NOT GRAPH")
    (settings.routing_dir / "manifest.json").write_text(json.dumps({"algorithm": "mld", "profile": "car", "routing_bbox": settings.region.routing_bbox,
        "image_digest": "TEST FIXTURE, NOT IMAGE", "artifact_sizes": {name: (settings.routing_dir / name).stat().st_size for name in GRAPH_FILES}}))
    settings.map_path.parent.parent.mkdir(parents=True, exist_ok=True)
    (settings.map_path.parent.parent / "source-verification.json").write_text(json.dumps({"path": str(settings.pbf_path),
        "size_bytes": settings.pbf_path.stat().st_size, "mtime_ns": settings.pbf_path.stat().st_mtime_ns, "format_verified": True}))


def test_relative_paths_ignore_cwd(settings, tmp_path, monkeypatch):
    another = tmp_path / "another"
    another.mkdir()
    monkeypatch.chdir(another)
    assert settings.pbf_path == tmp_path / "data/raw/vietnam-latest.osm.pbf"


def test_missing_pbf_backend_starts(settings, monkeypatch):
    mock_osrm(monkeypatch, unavailable=True)
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/health").json()["backend_ready"] is True
        result = client.get("/api/dataset/status").json()
        assert result["state"] == "missing_pbf" and result["ready"] is False
        assert result["osrm"]["state"] == "unavailable"
        response = client.post("/api/route", json={"start": [106.69, 10.77], "end": [106.70, 10.78]})
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "DATASET_NOT_READY"
        assert "coordinates" not in response.json()
        assert client.get("/api/map/streets").status_code == 503


@pytest.mark.parametrize("name,data,state", [("bad.txt", b"x", "invalid_extension"), ("empty.osm.pbf", b"", "empty_pbf"), ("good.osm.pbf", b"fixture", "present_unverified")])
def test_pbf_states(settings, tmp_path, name, data, state):
    path = tmp_path / name
    path.write_bytes(data)
    settings.osm_pbf_path = str(path)
    result = pbf_status(settings)
    assert result["state"] == state and result["format_verified"] is False


def test_unreadable_pbf(settings, tmp_path, monkeypatch):
    path = tmp_path / "private.osm.pbf"
    path.write_bytes(b"fixture")
    settings.osm_pbf_path = str(path)
    def deny(*args, **kwargs):
        raise PermissionError("fixture")
    monkeypatch.setattr(Path, "open", deny)
    assert pbf_status(settings)["state"] == "unreadable_pbf"


@pytest.mark.parametrize("url", ["https://router.project-osrm.org", "http://192.168.1.2:5000", "http://localhost:5000/route", "http://user:pass@localhost:5000"])
def test_public_router_rejected(url):
    with pytest.raises(ValidationError):
        Settings(_env_file=None, osrm_base_url=url)


@pytest.mark.parametrize("start", [[10.77, 106.69], [181, 10], [106, 91], [106], [True, 10.77], ["106.69", 10.77], [float("nan"), 10.77], [float("inf"), 10.77]])
def test_coordinate_validation(start):
    with pytest.raises(ValidationError):
        RouteRequest(start=start, end=[106.70, 10.78])


def test_api_validation_structured(settings):
    client = TestClient(create_app(settings))
    for payload in ({"start": [181, 10], "end": [106.7, 10.78]}, {"start": [106.69, 10.77], "end": [106.7, 10.78], "path": "private"}):
        response = client.post("/api/route", json=payload)
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "INVALID_COORDINATES"
    assert client.post("/api/route", json={"start": [105, 10], "end": [106.7, 10.78]}).json()["error"]["code"] == "OUTSIDE_ROUTING_REGION"
    assert client.post("/api/route", json={"start": [106.7, 10.78], "end": [106.7, 10.78]}).json()["error"]["code"] == "IDENTICAL_POINTS"


def test_graph_manifest_bbox_drift(settings):
    fixture_graph(settings)
    assert artifact_status(settings)["graph_ready"] is True
    (settings.routing_dir / "manifest.json").write_text('{"algorithm":"mld","profile":"car","routing_bbox":[]}')
    assert artifact_status(settings)["graph_ready"] is False


def test_route_contract_and_local_parameters(settings, monkeypatch):
    fixture_graph(settings)
    body = {"code": "Ok", "routes": [{"geometry": {"type": "LineString", "coordinates": [[106.69, 10.77], [106.695, 10.78], [106.70, 10.78]]}, "distance": 1234, "duration": 200}], "waypoints": [{"location": [106.69, 10.77], "distance": 5}, {"location": [106.70, 10.78], "distance": 8}]}
    calls = mock_osrm(monkeypatch, body)
    response = TestClient(create_app(settings)).post("/api/route", json={"start": [106.69, 10.77], "end": [106.70, 10.78]})
    assert response.status_code == 200
    assert len(response.json()["coordinates"]) == 3
    assert calls[0].url.host == "127.0.0.1"
    assert calls[0].url.params["overview"] == "full"
    assert calls[0].url.params["geometries"] == "geojson"
    assert calls[0].url.params["annotations"] == "duration,distance"
    assert [float(value) for value in calls[0].url.params["radiuses"].split(";")] == [100, 100]


def test_segment_annotations_are_returned_and_misalignment_rejected(settings, monkeypatch):
    fixture_graph(settings)
    body = {"code": "Ok", "routes": [{"geometry": {"type": "LineString", "coordinates": [[106.69, 10.77], [106.695, 10.77], [106.70, 10.77]]}, "distance": 1000, "duration": 110,
        "legs": [{"annotation": {"duration": [10, 90], "distance": [500, 500]}}]}],
        "waypoints": [{"location": [106.69, 10.77], "distance": 0}, {"location": [106.70, 10.77], "distance": 0}]}
    mock_osrm(monkeypatch, body)
    client = TestClient(create_app(settings))
    request = {"start": [106.69, 10.77], "end": [106.70, 10.77]}
    response = client.post('/api/route', json=request)
    assert response.status_code == 200
    assert response.json()['segment_durations'] == [10, 90]
    assert response.json()['duration'] == 110  # Total retains turn costs.
    body['routes'][0]['legs'][0]['annotation']['duration'] = [10]
    response = client.post('/api/route', json=request)
    assert response.status_code == 502
    assert response.json()['error']['code'] == 'ROUTER_BAD_RESPONSE'


def test_simulation_bbox_inside_verified_display(settings):
    values = settings.region.model_dump()
    assert values['simulation_bbox'] == [106.6935, 10.768, 106.7075, 10.782] or values['simulation_bbox'] == (106.6935, 10.768, 106.7075, 10.782)
    values['simulation_bbox'] = [106.65, 10.76, 106.70, 10.78]
    with pytest.raises(ValidationError, match='inside display coverage'):
        Region(**values)


@pytest.mark.parametrize("body,unavailable,status,code", [({"code": "NoRoute"}, False, 200, "NOROUTE"), ({"code": "NoSegment"}, False, 400, "NOSEGMENT"), ({"code": "Ok", "routes": []}, False, 200, "ROUTER_BAD_RESPONSE"), ({}, True, 200, "ROUTER_UNAVAILABLE")])
def test_router_errors_no_fallback(settings, monkeypatch, body, unavailable, status, code):
    fixture_graph(settings)
    mock_osrm(monkeypatch, body, unavailable, status)
    response = TestClient(create_app(settings)).post("/api/route", json={"start": [106.69, 10.77], "end": [106.70, 10.78]})
    assert response.status_code in {422, 502, 503}
    assert response.json()["error"]["code"] == code
    assert "coordinates" not in response.json()


def test_snap_too_far(settings, monkeypatch):
    fixture_graph(settings)
    body = {"code": "Ok", "routes": [{"geometry": {"type": "LineString", "coordinates": [[106.69, 10.77], [106.7, 10.78]]}, "distance": 1234, "duration": 200}], "waypoints": [{"location": [106.69, 10.77], "distance": 101}, {"location": [106.7, 10.78], "distance": 5}]}
    mock_osrm(monkeypatch, body)
    response = TestClient(create_app(settings)).post("/api/route", json={"start": [106.69, 10.77], "end": [106.7, 10.78]})
    assert response.json()["error"]["code"] == "SNAP_TOO_FAR"


def test_bbox_buffer_and_invalid_region(settings):
    assert settings.region.routing_bbox == pytest.approx([106.660, 10.735, 106.740, 10.810])
    values = settings.region.model_dump()
    values["display_bbox"] = [107, 11, 106, 10]
    with pytest.raises(ValidationError):
        Region(**values)


def test_pipeline_dry_run_never_executes(monkeypatch, capsys):
    monkeypatch.setenv("OSRM_BASE_URL", "http://127.0.0.1:5000")
    def forbidden(*args, **kwargs):
        raise AssertionError("dry-run executed subprocess")
    monkeypatch.setattr("subprocess.run", forbidden)
    for action in ["verify", "extract", "display", "routing", "serve"]:
        assert main([action, "--dry-run"]) == 0
    output = capsys.readouterr().out
    assert "types=multipolygon,restriction" in output and "--algorithm mld" in output
    assert "127.0.0.1:5000:5000" in output


def test_refuse_overwrite(tmp_path):
    path = tmp_path / "user-artifact"
    path.write_text("preserve me")
    with pytest.raises(RuntimeError):
        refuse_existing([path])
    assert path.read_text() == "preserve me"
