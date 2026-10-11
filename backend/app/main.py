import math
import httpx
from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, FileResponse
from pydantic import ValidationError

from .config import Settings
from .dataset import dataset_status, artifact_status, pbf_status
from .schemas import RouteRequest, RouteResponse, SnapPoint
from .fleet import candidate_catalog


def api_error(code, message, status=503):
    raise HTTPException(status, detail={"code": code, "message": message})


def meters(a, b):
    lon1, lat1, lon2, lat2 = map(math.radians, (*a, *b))
    h = math.sin((lat2-lat1)/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin((lon2-lon1)/2)**2
    return 6371008.8 * 2 * math.asin(math.sqrt(min(1, h)))


def create_app(settings: Settings | None = None):
    settings = settings or Settings()
    settings.region  # Fail early for invalid configuration, never for a missing PBF.
    app = FastAPI(title="GSM Map Sandbox", version="0.1.0")

    @app.exception_handler(HTTPException)
    async def structured_error(_, exc):
        detail = exc.detail if isinstance(exc.detail, dict) else {"code": "HTTP_ERROR", "message": exc.detail}
        return JSONResponse(status_code=exc.status_code, content={"error": detail})

    @app.exception_handler(RequestValidationError)
    async def validation_error(_, exc):
        return JSONResponse(status_code=422, content={"error": {"code": "INVALID_COORDINATES", "message": "Expected start/end as finite WGS84 [longitude, latitude], with no extra fields."}})

    @app.get("/api/health")
    async def health():
        return {"status": "ok", "backend_ready": True, "version": "0.1.0"}

    @app.get("/api/dataset/status")
    async def status():
        return await dataset_status(settings)

    @app.get("/api/fleet/candidates")
    async def fleet_candidates():
        if not (await dataset_status(settings))["ready"]:
            api_error("DATASET_NOT_READY", "Bản đồ hoặc OSRM local chưa sẵn sàng cho fleet.")
        try:
            result = candidate_catalog(settings)
            if len(result["candidates"]) < 2:
                api_error("INSUFFICIENT_CANDIDATES", "Không đủ điểm OSM trong vùng hiển thị.")
            return result
        except (OSError, ValueError, KeyError, TypeError):
            api_error("CANDIDATES_UNAVAILABLE", "Không đọc được candidate/provenance local.")

    @app.get("/api/map/streets")
    async def streets():
        if not settings.map_path.is_file():
            api_error("DATASET_NOT_READY", "GeoJSON local chưa được tạo.")
        return FileResponse(settings.map_path, media_type="application/geo+json")

    @app.get("/api/map/{layer}")
    async def map_layer(layer: str):
        if layer not in {"water", "green", "buildings", "places"}:
            api_error("UNKNOWN_MAP_LAYER", "Lớp bản đồ không hợp lệ.", 404)
        path = settings.map_path.parent / f"{layer}.geojson"
        if not path.is_file():
            api_error("DATASET_NOT_READY", "Lớp GeoJSON chưa sẵn sàng.")
        return FileResponse(path, media_type="application/geo+json")

    @app.post("/api/route", response_model=RouteResponse)
    async def route(request: RouteRequest):
        w, s, e, n = settings.region.routing_bbox
        if any(not (w <= lon <= e and s <= lat <= n) for lon, lat in (request.start, request.end)):
            api_error("OUTSIDE_ROUTING_REGION", "Điểm nằm ngoài vùng routing đã cấu hình.", 422)
        if request.start == request.end:
            api_error("IDENTICAL_POINTS", "Chọn hai điểm khác nhau.", 422)
        if not pbf_status(settings)["format_verified"] or not artifact_status(settings)["graph_ready"]:
            api_error("DATASET_NOT_READY", "Chưa có PBF đọc được và OSRM graph MLD đã chuẩn bị.")
        coords = ";".join(f"{lon},{lat}" for lon, lat in (request.start, request.end))
        try:
            async with httpx.AsyncClient(timeout=settings.osrm_timeout_seconds, trust_env=False) as client:
                response = await client.get(f"{settings.osrm_base_url}/route/v1/driving/{coords}", params={"geometries": "geojson", "overview": "full", "steps": "false", "radiuses": f"{settings.max_snap_meters};{settings.max_snap_meters}"})
                data = response.json()
                if data.get("code") in {"NoRoute", "NoSegment"}:
                    api_error(data["code"].upper(), "Không tìm thấy tuyến ô tô hoặc điểm snap phù hợp.", 422)
                response.raise_for_status()
                if data.get("code") != "Ok":
                    api_error("ROUTER_BAD_RESPONSE", "OSRM trả về phản hồi không hợp lệ.", 502)
            result = data["routes"][0]
            if result["geometry"].get("type") != "LineString":
                api_error("ROUTER_BAD_RESPONSE", "OSRM geometry phải là LineString.", 502)
            snaps = [SnapPoint(**point) for point in data["waypoints"]]
            if any(point.distance > settings.max_snap_meters for point in snaps):
                api_error("SNAP_TOO_FAR", "Điểm snap quá xa vị trí đã chọn.", 422)
            validated = RouteResponse(coordinates=result["geometry"]["coordinates"], distance=result["distance"], duration=result["duration"], snap_points=snaps)
            if len(set(validated.coordinates)) < 2 or any(meters(p, snap.location) > 5 for p, snap in zip([validated.coordinates[0], validated.coordinates[-1]], snaps)):
                api_error("ROUTER_BAD_RESPONSE", "Geometry không khớp điểm snap hoặc không có độ dài.", 502)
            if any(meters(p, snap.location) > settings.max_snap_meters + 1 for p, snap in zip([request.start, request.end], snaps)):
                api_error("SNAP_TOO_FAR", "Tọa độ snap quá xa điểm đã chọn.", 422)
            if any(not (w <= lon <= e and s <= lat <= n) for lon, lat in [*validated.coordinates, *(p.location for p in snaps)]):
                api_error("ROUTE_OUTSIDE_REGION", "Tuyến vượt vùng routing; cần kiểm tra buffer.", 502)
            return validated
        except httpx.TimeoutException:
            api_error("ROUTER_TIMEOUT", "OSRM local phản hồi quá thời gian cho phép.")
        except httpx.HTTPError:
            api_error("ROUTER_UNAVAILABLE", "Không kết nối được OSRM local.")
        except (ValueError, KeyError, IndexError, TypeError, ValidationError, AttributeError):
            api_error("ROUTER_BAD_RESPONSE", "OSRM trả về dữ liệu tuyến không hợp lệ.", 502)

    return app


app = create_app()
