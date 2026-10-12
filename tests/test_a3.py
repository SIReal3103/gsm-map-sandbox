"""Synthetic unit fixtures are never used as runtime HCMC demand/roads."""
import asyncio
import json
import os
import httpx

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from backend.app.booking import (PrepareRequest, DemandBooking, InitialVehicle, LocalTravel,
                                 build_plan, demand_inputs, table_durations, EVENT_ORDER, SimulationEvent, ScenarioPlan)
from backend.app.config import Settings
from backend.app.main import create_app, meters
from backend.app.schemas import RouteResponse


CATALOG = {"candidates": [{"id": f"fixture-{i}", "coordinate": [float(i), 0.0]} for i in range(12)],
           "datasetFingerprint": "synthetic-test-only", "routingSource": "test fixture", "provenance": {}}


def road(a, b, duration=10):
    return RouteResponse(coordinates=[a, b], distance=100, duration=duration,
                         snap_points=[{"location": a, "distance": 0}, {"location": b, "distance": 0}])


def demand(id, time=0, pickup=(2.0, 0.0), dropoff=(3.0, 0.0)):
    return DemandBooking(id=id, passengerId="synthetic-passenger", requestTimeSeconds=time,
                         pickup=pickup, dropoff=dropoff, pickupCandidateId="fixture-a", dropoffCandidateId="fixture-b")


class FixtureTravel:
    counts = {"table": 0, "route": 0}
    distance = staticmethod(meters)

    def __init__(self, eta=lambda point, pickup: 10):
        self.eta = eta

    async def nearest(self, p):
        return p

    async def table(self, positions, pickup):
        return [self.eta(p, pickup) for p in positions]

    async def route(self, start, end):
        return road(start, end, 40 if end[0] == 3 else self.eta(start, end) or 10)


def run(monkeypatch, bookings, travel=None, fleet=1, wait=300):
    monkeypatch.setattr("backend.app.booking.demand_inputs", lambda *_: (
        [InitialVehicle(id=f"GSM-{i+1:02}", candidateId="fixture", initialPosition=(float(i), 0.0)) for i in range(fleet)], bookings))
    return asyncio.run(build_plan(CATALOG, PrepareRequest(fleetSize=fleet, maxWaitSeconds=wait), travel or FixtureTravel()))


@pytest.mark.parametrize("preset", ["Low", "Medium", "High"])
def test_demand_deterministic_unique_bounded_and_outcome_independent(preset):
    config = PrepareRequest(preset=preset, fleetSize=10, bookingCount=30)
    vehicles, bookings = demand_inputs(CATALOG, config)
    assert (vehicles, bookings) == demand_inputs(CATALOG, config)
    assert len({b.id for b in bookings}) == 30
    assert len({v.id for v in vehicles}) == 10
    assert all(b.pickup != b.dropoff and 0 <= b.requestTimeSeconds <= 1800 for b in bookings)
    if preset == "High":
        assert max(b.requestTimeSeconds for b in bookings) <= 450
    assert bookings != demand_inputs(CATALOG, config.model_copy(update={"seed": "different"}))[1]
    assert bookings == demand_inputs(CATALOG, config.model_copy(update={"maxWaitSeconds": 10}))[1]


@pytest.mark.parametrize("body", [{"fleetSize": 11}, {"bookingCount": 9}, {"preset": "bad"},
                                    {"horizonSeconds": 0}, {"maxWaitSeconds": 0}, {"seed": ""},
                                    {"routerUrl": "http://example.com"}, {"fleetSize": True}])
def test_prepare_api_rejects_invalid_config(body):
    r = TestClient(create_app()).post("/api/booking-simulation/prepare", json=body)
    assert r.status_code == 422 and r.json()["error"]["code"] == "INVALID_SCENARIO_CONFIG"


def test_prepare_missing_data(tmp_path):
    r = TestClient(create_app(Settings(osm_pbf_path=str(tmp_path / "missing.osm.pbf")))).post("/api/booking-simulation/prepare", json={})
    assert r.status_code == 503 and r.json()["error"]["code"] == "DATASET_NOT_READY"


def test_dispatch_chooses_table_eta_not_euclidean_and_id_ties(monkeypatch):
    plan = run(monkeypatch, [demand("B1")], FixtureTravel(lambda p, _: 20 if p[0] == 1 else 10), fleet=2)
    assert plan.assignments[0].vehicleId == "GSM-01"  # farther coordinate, lower OSRM ETA
    tie = run(monkeypatch, [demand("B1")], fleet=2)
    assert tie.assignments[0].vehicleId == "GSM-01"


def test_busy_vehicle_queue_release_idle_at_dropoff_and_no_double_assignment(monkeypatch):
    plan = run(monkeypatch, [demand("B1"), demand("B2", 5)])
    a, b = plan.assignments
    assert a.dropoffAtSeconds == 50 and b.assignedAtSeconds == 50
    assert b.pickupRoute.coordinates[0] == a.tripRoute.coordinates[-1]
    same_time = [e.type for e in plan.events if e.timestampSeconds == 50]
    assert same_time[0] == "TRIP_COMPLETED"
    assert plan.events == sorted(plan.events, key=lambda e: (e.timestampSeconds, EVENT_ORDER[e.type], e.bookingId, e.id))


def test_pickup_deadline_rejects_assignment_even_if_assignment_time_is_valid(monkeypatch):
    plan = run(monkeypatch, [demand("B1")], FixtureTravel(lambda *_: 25), wait=20)
    assert not plan.assignments
    assert plan.events[-1].type == "BOOKING_UNSERVED" and plan.events[-1].timestampSeconds == 20


def test_release_on_deadline_can_assign_stationary_pickup_without_fabricated_route(monkeypatch):
    plan = run(monkeypatch, [demand("B1"), demand("B2", pickup=(3.0, 0.0), dropoff=(4.0, 0.0))],
               FixtureTravel(lambda p, target: 0 if tuple(p) == tuple(target) else 10), wait=50)
    assert len(plan.assignments) == 2
    assert plan.assignments[1].assignedAtSeconds == 50
    assert plan.assignments[1].pickupRoute is None and plan.assignments[1].pickupAtSeconds == 50
    assert [e.type for e in plan.events if e.bookingId == "B2"] == [
        "BOOKING_REQUESTED", "BOOKING_ASSIGNED", "VEHICLE_ARRIVED_PICKUP", "TRIP_STARTED", "TRIP_COMPLETED"]


def test_null_table_does_not_assign_unreachable_vehicle(monkeypatch):
    plan = run(monkeypatch, [demand("B1")], FixtureTravel(lambda *_: None), wait=20)
    assert not plan.assignments and plan.events[-1].type == "BOOKING_UNSERVED"
    assert table_durations({"durations": [[None], [12]]}, 2) == [None, 12]


@pytest.mark.parametrize("rows", [[], [[-1]], [[float('nan')]], [[True]], [[1, 2]], [["10"]]])
def test_malformed_table_rejected(rows):
    with pytest.raises(ValueError):
        table_durations({"durations": rows}, 1)


def test_invalid_booking_route_has_reason_and_no_assignment(monkeypatch):
    class Invalid(FixtureTravel):
        async def route(self, *_):
            raise HTTPException(422, {"code": "NOSEGMENT", "message": "test fixture"})
    plan = run(monkeypatch, [demand("B1")], Invalid(), wait=20)
    assert not plan.assignments and plan.events[-1].payload["failureReason"] == "NOSEGMENT"


def test_router_outage_stops_preparation_instead_of_success(monkeypatch):
    class Outage(FixtureTravel):
        async def table(self, *_):
            raise HTTPException(503, {"code": "ROUTER_TIMEOUT", "message": "fixture"})
    with pytest.raises(HTTPException) as exc:
        run(monkeypatch, [demand("B1")], Outage())
    assert exc.value.detail["code"] == "ROUTER_TIMEOUT"


def test_full_route_confirms_deadline_after_table(monkeypatch):
    class Slow(FixtureTravel):
        async def route(self, start, end):
            return road(start, end, 200)
    plan = run(monkeypatch, [demand("B1")], Slow(), wait=20)
    assert not plan.assignments


def test_payload_validation_rejects_invalid_event_eta():
    with pytest.raises(ValueError):
        SimulationEvent(id="E-test", timestampSeconds=0, type="BOOKING_ASSIGNED", bookingId="B-test",
                        vehicleId="V-test", payload={"tableEtaSeconds": float('nan'),
                        "estimatedPickupEtaSeconds": 10, "dispatchCandidates": []})


def test_plan_validation_rejects_future_event_timestamp(monkeypatch):
    plan = run(monkeypatch, [demand("B1")])
    raw = plan.model_dump()
    raw["events"][0]["timestampSeconds"] = 1
    with pytest.raises(ValueError):
        ScenarioPlan.model_validate(raw)


def test_cancelled_client_stops_preparation(monkeypatch):
    monkeypatch.setattr("backend.app.booking.demand_inputs", lambda *_: (
        [InitialVehicle(id="V-test", candidateId="fixture", initialPosition=(0.0, 0.0))], [demand("B1")]))
    async def cancelled():
        return True
    with pytest.raises(HTTPException) as exc:
        asyncio.run(build_plan(CATALOG, PrepareRequest(), FixtureTravel(), cancelled))
    assert exc.value.status_code == 499


@pytest.mark.parametrize("case", ["null", "bad_snap", "missing_duration", "timeout", "unavailable"])
def test_local_table_http_contract_errors_and_no_fallback(case):
    positions = [(106.695, 10.77), (106.70, 10.78)]
    target = (106.69, 10.775)
    def handler(request):
        assert request.url.host == "127.0.0.1" and request.url.path.startswith("/table/")
        assert "fallback_speed" not in request.url.params and request.url.params["sources"] == "0;1"
        if case == "timeout":
            raise httpx.ReadTimeout("fixture timeout", request=request)
        if case == "unavailable":
            raise httpx.ConnectError("fixture unavailable", request=request)
        data = {"code": "Ok", "durations": [[None], [15]],
                "sources": [{"location": p, "distance": 0} for p in positions],
                "destinations": [{"location": target, "distance": 0}]}
        if case == "bad_snap":
            data["sources"][0]["distance"] = 1000
        if case == "missing_duration":
            del data["durations"]
        return httpx.Response(200, json=data)
    async def exercise():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            travel = LocalTravel(Settings(), None, meters, client)
            if case == "null":
                assert await travel.table(positions, target) == [None, 15]
                assert await travel.table(positions, target) == [None, 15]
                assert travel.counts["table"] == 1 and travel.counts["tableCacheHits"] == 1
            else:
                with pytest.raises(HTTPException) as exc:
                    await travel.table(positions, target)
                assert exc.value.detail["code"] == {"bad_snap": "ROUTER_BAD_RESPONSE", "missing_duration": "ROUTER_BAD_RESPONSE", "timeout": "ROUTER_TIMEOUT", "unavailable": "ROUTER_UNAVAILABLE"}[case]
    asyncio.run(exercise())


@pytest.mark.skipif(os.environ.get("RUN_REAL_DATA") != "1", reason="Requires real local OSM/OSRM")
def test_real_booking_scenario_osrm_table_two_legs_and_replayable_events():
    response = TestClient(create_app()).post("/api/booking-simulation/prepare", json={})
    assert response.status_code == 200, response.text
    plan = response.json()
    assert len(plan["vehicles"]) == 5 and len(plan["demand"]) == 20 and plan["assignments"]
    assert plan["routingRequests"]["table"] > 0
    by_vehicle = {}
    for a in plan["assignments"]:
        assert a["pickupAtSeconds"] <= next(b["requestTimeSeconds"] for b in plan["demand"] if b["id"] == a["bookingId"])+300
        assert a["assignedAtSeconds"] >= by_vehicle.get(a["vehicleId"], 0)
        by_vehicle[a["vehicleId"]] = a["dropoffAtSeconds"]
        for route in [a["pickupRoute"], a["tripRoute"]]:
            if route is not None:
                assert route["duration"] > 0 and route["distance"] > 0 and len(route["coordinates"]) >= 2
                assert all(p["distance"] <= 100 for p in route["snap_points"])
    assert sum(e["type"] == "TRIP_COMPLETED" for e in plan["events"]) == len(plan["assignments"])
