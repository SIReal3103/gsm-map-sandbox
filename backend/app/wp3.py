"""Bounded local routing adapter and scenario endpoint for the WP3 pilot."""
import asyncio
import math
import json

import httpx
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .dataset import dataset_status, pbf_status
from .fleet import candidate_catalog
from .schemas import RouteRequest
from .simulation import POLICIES, simulate, validate_network
from .campaign import POLICIES as CAMPAIGN_POLICIES, simulate_campaign
from .response_bundle import ResponseBundle


class ScenarioRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    seed: str = Field(default="hcm-wp3-2026", min_length=1, max_length=80)
    fleet: int = Field(default=6, ge=1, le=20, strict=True)
    quotes: int = Field(default=60, ge=1, le=200, strict=True)
    minutes: int = Field(default=20, ge=5, le=60, strict=True)
    budget_vnd: int = Field(default=150000, ge=0, le=10000000, strict=True)
    patience_seconds: int = Field(default=300, ge=30, le=900, strict=True)
    traffic_factor: float = Field(default=1.0, ge=1, le=3, allow_inf_nan=False)


class SimulationRequest(ScenarioRequest):
    voucher_effect: float = Field(default=.25, ge=0, le=.5, allow_inf_nan=False)


class CampaignRequest(ScenarioRequest):
    response_scale: float = Field(default=1., ge=0, le=1.5, allow_inf_nan=False)


def fail(code, message, status=503):
    raise HTTPException(status, detail={"code": code, "message": message})


def register_wp3(app, settings, route):
    lock = asyncio.Lock()
    run_lock = asyncio.Lock()
    route_slots = asyncio.Semaphore(2)
    cached = {}

    async def network():
        catalog = candidate_catalog(settings, sampling_bbox=settings.region.simulation_bbox)
        fingerprint = catalog["datasetFingerprint"]
        async with lock:
            if cached.get("fingerprint") == fingerprint:
                return cached["network"]
            async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
                anchors = []
                w, s, e, n = settings.region.routing_bbox
                coordinates = ";".join(f'{a["coordinate"][0]},{a["coordinate"][1]}' for a in catalog["candidates"])
                count = len(catalog["candidates"])
                response = await client.get(f"{settings.osrm_base_url}/table/v1/driving/{coordinates}", params={"annotations": "duration,distance", "radiuses": ";".join([str(settings.max_snap_meters)] * count)})
                response.raise_for_status()
                data = response.json()
                if data.get("code") != "Ok":
                    fail("ROUTING_TABLE_UNAVAILABLE", "Không tính được ma trận tuyến ô tô local.")
                if len(data["sources"]) != count or len(data["destinations"]) != count:
                    raise ValueError("Incomplete table waypoints")
                hints = []
                # Table can move a nearest point off a disconnected car segment.
                # Bind geometry to its exact table waypoint, including the OSRM hint.
                for candidate, point, destination in zip(catalog["candidates"], data["sources"], data["destinations"]):
                    lon, lat = point["location"]
                    if not all(math.isfinite(v) for v in [lon, lat, point["distance"]]) or not 0 <= point["distance"] <= settings.max_snap_meters or not (w <= lon <= e and s <= lat <= n):
                        fail("ANCHOR_UNSNAPPABLE", "Điểm snap nằm quá xa hoặc ngoài vùng routing.")
                    if point["location"] != destination["location"] or not isinstance(point["hint"], str) or not point["hint"]:
                        raise ValueError("Inconsistent table waypoints")
                    if any(a["coordinate"] == point["location"] for a in anchors):
                        raise ValueError("Duplicate table waypoints")
                    anchors.append({**candidate, "source_coordinate": candidate["coordinate"], "coordinate": point["location"], "snap_meters": point["distance"], "routing_name": point["name"]})
                    hints.append(point["hint"])
                result = {"anchors": anchors, "durations": data["durations"], "distances": data["distances"],
                          "hints": hints, "fingerprint": fingerprint, "provenance": catalog["provenance"]}
                validate_network(result)
                cached.update(fingerprint=fingerprint, network=result)
                return result

    async def produce(request: ScenarioRequest):
        if not (await dataset_status(settings))["ready"]:
            fail("DATASET_NOT_READY", "WP3 cần bản đồ OSM và OSRM local đã xác minh.")
        try:
            graph = await network()
            source = pbf_status(settings)["verification"]
            extract = json.loads((settings.routing_dir.parent / "extracted/hcm-center.osm.metadata.json").read_text())
            if extract["extract_sha256"] != graph["provenance"]["extract_sha256"] or extract["source_sha256"] != source["sha256"]:
                fail("DATASET_SOURCE_DRIFT", "PBF đã xác minh không khớp nguồn của graph. Chạy lại pipeline đúng bộ dữ liệu.", 502)
            config = request.model_dump()
            integrated = isinstance(request, CampaignRequest)
            bundle = None
            if integrated:
                try:
                    spec = json.loads(settings.resolve('config/campaign-model.json').read_text())
                    bundle = ResponseBundle(settings.resolve(spec['path']), spec['sha256'])
                except (OSError, ValueError, KeyError):
                    fail('CAMPAIGN_MODEL_UNAVAILABLE', 'Thiếu bundle WP1/WP2 đúng checksum. Không dùng xác suất thay thế.')
                transport = bundle.data['provenance']['transport']
                if any(transport[key] != graph[key] for key in ('anchors','durations','distances','hints')):
                    fail('CAMPAIGN_NETWORK_DRIFT', 'Network hiện tại khác miền fit WP1/WP2. Cần refit và xác minh bundle.', 502)
                runs = []
                for policy in CAMPAIGN_POLICIES:
                    runs.append(await asyncio.to_thread(simulate_campaign, config, graph, bundle, policy))
            else:
                runs = [simulate(config, graph, policy) for policy in POLICIES]
            paths = {}
            # One geometry per directed OD pair, independent of the animation.
            pairs = sorted({(leg["origin"], leg["destination"]) for run in runs for leg in run["legs"]})

            async def geometry(pair):
                origin, destination = pair
                async with route_slots:
                    result = await route(RouteRequest(start=graph["anchors"][origin]["coordinate"], end=graph["anchors"][destination]["coordinate"]), hints=f'{graph["hints"][origin]};{graph["hints"][destination]}')
                    if abs(result.duration - graph["durations"][origin][destination]) > max(1, result.duration * .01):
                        fail("ROUTING_MATRIX_DRIFT", "Geometry và ma trận thời gian không khớp; không phát lại scenario.", 502)
                    for endpoint, index in [(result.coordinates[0], origin), (result.coordinates[-1], destination)]:
                        anchor = graph["anchors"][index]["coordinate"]
                        if any(abs(a-b) > .000005 for a, b in zip(endpoint, anchor)):
                            fail("ROUTING_ANCHOR_DRIFT", "Đầu/cuối geometry không khớp điểm snap của scenario.", 502)
                    if result.segment_durations is None:
                        fail("ROUTING_TIMING_UNAVAILABLE", "OSRM thiếu thời gian từng đoạn; không phát lại simulation.", 502)
                    paths[f"{origin}-{destination}"] = result.model_dump()

            tasks = [asyncio.create_task(geometry(pair)) for pair in pairs]
            try:
                await asyncio.gather(*tasks)
            except BaseException:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                raise
            result = {"version": "wp3-osrm-pilot-v2", "config": config, "anchors": graph["anchors"], "runs": runs,
                    "paths": {key: paths[key] for key in sorted(paths)}, "datasetFingerprint": graph["fingerprint"], "provenance": {**graph["provenance"], "source_sha256": source["sha256"], "source_timestamp": source["fileinfo"]["header"]["option"]["timestamp"]},
                    "assumptions": {"demand": "Synthetic seeded quotes; not GSM bookings", "response": "Assumed conversion q=max(.12,.52-.00055*ETA)+effect*offer/10000, capped .95; not an estimated treatment effect",
                                    "traffic": "OSRM car-profile duration × scenario factor; no live traffic",
                                    "playback": "OSRM segment-duration weights scaled to each leg total; turn delays distributed proportionally, not measured GPS",
                                    "study_area": "Small technical central District 1 bbox; route detours may use the verified routing buffer; not an administrative boundary",
                                    "driver_acceptance": "100% conditional on assignment to an eligible idle vehicle; no driver rejection or cancellation is sampled. Customer booking remains probabilistic; no feasible car means queue/expiry, not guaranteed service.",
                                    "dispatcher": "Oldest feasible booking first, nearest idle vehicle by directed OSRM pickup time; pickup must fit patience",
                                    "budget": "Integer VND; reserve on acceptance, release on expiry, pay on completion", "comparison": "Identical quote stream and keyed draws; shared budget cap, actual spend differs; not a matched-spend or SOTA claim"}}
            if integrated:
                result['version'] = 'wp3-integrated-campaign-v1'
                result['model'] = {'sha256': bundle.sha256, 'selected_wp2': bundle.data['selected'], **bundle.data['provenance']}
                result['assumptions'].update(
                    demand='TRAIN-only synthetic feature/OD profiles; fixed quote count, independent exogenous arrivals; histories frozen for short campaign, no factual GMS bookings',
                    response='Exact WP2 logistic + Platt; support train ranges and minimum cell20; unsupported paid actions withheld; evaluator response scale separate from planner',
                    timing='One first request within12minutes; common train-fitted12-bin timing, uniform within bin; pending posterior conditions on observed silence',
                    planner='Fixed32 paired draws, whole remaining campaign plus common clearance, TRAIN forecast in separate namespace, nonrecursive response-only pi_0; same service screening, delta-q versus completion-gain ranking',
                    cancellation='No additional customer cancellation after request. Unserved queue expiry remains modeled. Driver accepts100% conditional on eligible idle assignment.',
                    budget='Reserve maximum liability at offer issuance; no request/queue expiry releases; completion settles gross. Immediate completion settlement is an adapter assumption, not fitted ledger settlement timing.',
                    cost='Request-conditioned WP2 cost remains diagnostic. Gross completion cost is operational proxy; pooled TRAIN completed/mature full-refund kernel gives delayed mature net cost separately.',
                    comparison='Same quote tape, initial fleet and keyed evaluator draws; cap common, spending may differ; scenario evidence only, no factual H2 or SOTA claim')
            return result
        except httpx.TimeoutException:
            fail("ROUTER_TIMEOUT", "OSRM local hết thời gian khi chuẩn bị WP3.")
        except httpx.HTTPError:
            fail("ROUTER_UNAVAILABLE", "Không kết nối được OSRM local; không có tuyến thay thế.")
        except (ValueError, KeyError, TypeError, IndexError, AttributeError, OSError):
            fail("SCENARIO_UNROUTABLE", "Ma trận routing không đầy đủ hoặc phản hồi không hợp lệ; không tạo simulation giả.", 502)

    @app.post("/api/wp3/simulate")
    async def run(request: SimulationRequest):
        if run_lock.locked():
            fail("SIMULATION_BUSY", "Một scenario đang chuẩn bị. Chờ hoàn tất rồi chạy lại.", 409)
        async with run_lock:
            return await produce(request)

    @app.post('/api/wp3/campaign')
    async def campaign(request: CampaignRequest):
        if run_lock.locked():
            fail('SIMULATION_BUSY', 'Một scenario đang chuẩn bị. Chờ hoàn tất rồi chạy lại.', 409)
        async with run_lock:
            return await produce(request)
