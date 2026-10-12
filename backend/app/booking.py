"""Bounded, deterministic precomputation. Only local OSRM supplies travel times/routes."""
import asyncio
import hashlib
import json
import math
import time
from datetime import datetime, timezone
from typing import Literal

import httpx
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .schemas import Coordinate, RouteRequest, RouteResponse, SnapPoint


class PrepareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    seed: str = Field(default="hcm-booking-2026", min_length=1, max_length=80)
    fleetSize: int = Field(default=5, ge=1, le=10, strict=True)
    bookingCount: int = Field(default=20, ge=10, le=30, strict=True)
    horizonSeconds: int = Field(default=1800, ge=60, le=3600, strict=True)
    maxWaitSeconds: int = Field(default=300, ge=10, le=900, strict=True)
    preset: Literal["Low", "Medium", "High"] = "Medium"


class DemandBooking(BaseModel):
    id: str
    passengerId: str
    requestTimeSeconds: float = Field(ge=0, allow_inf_nan=False)
    pickup: Coordinate
    dropoff: Coordinate
    pickupCandidateId: str
    dropoffCandidateId: str

    @model_validator(mode="after")
    def distinct_points(self):
        if self.pickup == self.dropoff:
            raise ValueError("Pickup and dropoff must differ")
        return self


class InitialVehicle(BaseModel):
    id: str
    candidateId: str
    initialPosition: Coordinate


class DispatchCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    vehicleId: str
    etaSeconds: float | None = Field(ge=0, allow_inf_nan=False)


class Assignment(BaseModel):
    bookingId: str
    vehicleId: str
    assignedAtSeconds: float = Field(ge=0, allow_inf_nan=False)
    pickupAtSeconds: float = Field(ge=0, allow_inf_nan=False)
    dropoffAtSeconds: float = Field(ge=0, allow_inf_nan=False)
    estimatedPickupEtaSeconds: float = Field(ge=0, allow_inf_nan=False)
    tableEtaSeconds: float = Field(ge=0, allow_inf_nan=False)
    pickupRoute: RouteResponse | None  # None ONLY when already at the validated pickup.
    tripRoute: RouteResponse
    dispatchCandidates: list[DispatchCandidate]

    @model_validator(mode="after")
    def valid_timing(self):
        pickup_duration = self.pickupRoute.duration if self.pickupRoute else 0
        if (abs(self.pickupAtSeconds-self.assignedAtSeconds-pickup_duration) > 1e-6 or
                abs(self.dropoffAtSeconds-self.pickupAtSeconds-self.tripRoute.duration) > 1e-6 or
                abs(self.estimatedPickupEtaSeconds-pickup_duration) > 1e-6):
            raise ValueError("Assignment time must agree with OSRM durations")
        return self


EVENT_ORDER = {"TRIP_COMPLETED": 0, "BOOKING_REQUESTED": 1, "BOOKING_ASSIGNED": 2,
               "VEHICLE_ARRIVED_PICKUP": 3, "TRIP_STARTED": 4, "BOOKING_UNSERVED": 5}


class SimulationEvent(BaseModel):
    id: str
    timestampSeconds: float = Field(ge=0, allow_inf_nan=False)
    type: Literal["BOOKING_REQUESTED", "BOOKING_ASSIGNED", "VEHICLE_ARRIVED_PICKUP",
                  "TRIP_STARTED", "TRIP_COMPLETED", "BOOKING_UNSERVED"]
    bookingId: str
    vehicleId: str | None = None
    payload: dict

    @model_validator(mode="after")
    def valid_payload(self):
        if self.type == "BOOKING_ASSIGNED":
            if set(self.payload) != {"estimatedPickupEtaSeconds", "tableEtaSeconds", "dispatchCandidates"}:
                raise ValueError("Invalid assignment event payload")
            for key in ("estimatedPickupEtaSeconds", "tableEtaSeconds"):
                value = self.payload[key]
                if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or value < 0:
                    raise ValueError("Invalid assignment event ETA")
            if not isinstance(self.payload["dispatchCandidates"], list):
                raise ValueError("Invalid dispatch candidates")
            for candidate in self.payload["dispatchCandidates"]:
                DispatchCandidate.model_validate(candidate)
        elif self.type == "BOOKING_UNSERVED":
            if set(self.payload) != {"failureReason"} or not isinstance(self.payload["failureReason"], str) or not self.payload["failureReason"]:
                raise ValueError("Invalid failure event payload")
        elif self.payload:
            raise ValueError("Unexpected lifecycle payload")
        return self


class ScenarioPlan(BaseModel):
    id: str
    seed: str
    config: PrepareRequest
    demand: list[DemandBooking]
    vehicles: list[InitialVehicle]
    assignments: list[Assignment]
    events: list[SimulationEvent]
    simulationDurationSeconds: float
    datasetFingerprint: str
    routingSource: str
    provenance: dict
    assumptions: dict
    createdAt: str
    preparationMilliseconds: float
    routingRequests: dict

    @model_validator(mode="after")
    def validate_history(self):
        booking_by_id = {b.id: b for b in self.demand}
        vehicle_ids = {v.id for v in self.vehicles}
        if len(booking_by_id) != len(self.demand) or len(vehicle_ids) != len(self.vehicles):
            raise ValueError("Duplicate identities")
        assignments = {}
        ends = {}
        for a in self.assignments:
            b = booking_by_id.get(a.bookingId)
            if (b is None or a.vehicleId not in vehicle_ids or a.bookingId in assignments or
                    a.assignedAtSeconds < b.requestTimeSeconds or a.assignedAtSeconds < ends.get(a.vehicleId, 0) or
                    a.pickupAtSeconds > b.requestTimeSeconds+self.config.maxWaitSeconds):
                raise ValueError("Invalid assignment or overlapping vehicle usage")
            assignments[a.bookingId] = a
            ends[a.vehicleId] = a.dropoffAtSeconds
        if self.events != sorted(self.events, key=lambda e: (e.timestampSeconds, EVENT_ORDER[e.type], e.bookingId, e.id)):
            raise ValueError("Non-deterministic event ordering")
        states, ids = {}, set()
        allowed = {"BOOKING_REQUESTED": None, "BOOKING_ASSIGNED": "BOOKING_REQUESTED",
                   "VEHICLE_ARRIVED_PICKUP": "BOOKING_ASSIGNED", "TRIP_STARTED": "VEHICLE_ARRIVED_PICKUP",
                   "TRIP_COMPLETED": "TRIP_STARTED", "BOOKING_UNSERVED": "BOOKING_REQUESTED"}
        for event in self.events:
            if event.id in ids or event.bookingId not in booking_by_id or states.get(event.bookingId) != allowed[event.type]:
                raise ValueError("Invalid lifecycle event")
            ids.add(event.id)
            b = booking_by_id[event.bookingId]
            a = assignments.get(event.bookingId)
            if event.type == "BOOKING_REQUESTED":
                timestamp = b.requestTimeSeconds
            elif event.type == "BOOKING_UNSERVED":
                timestamp = b.requestTimeSeconds+self.config.maxWaitSeconds
            else:
                if a is None or event.vehicleId != a.vehicleId:
                    raise ValueError("Event assignment reference mismatch")
                timestamp = {"BOOKING_ASSIGNED": a.assignedAtSeconds, "VEHICLE_ARRIVED_PICKUP": a.pickupAtSeconds,
                             "TRIP_STARTED": a.pickupAtSeconds, "TRIP_COMPLETED": a.dropoffAtSeconds}[event.type]
            if abs(event.timestampSeconds-timestamp) > 1e-6:
                raise ValueError("Event timestamp mismatch")
            states[event.bookingId] = event.type
        if any(states.get(b.id) not in {"TRIP_COMPLETED", "BOOKING_UNSERVED"} for b in self.demand):
            raise ValueError("Scenario leaves unresolved demand")
        if self.simulationDurationSeconds != max((e.timestampSeconds for e in self.events), default=0):
            raise ValueError("Scenario duration mismatch")
        return self


def demand_inputs(catalog, config):
    """SHA256 counter draws; demand independent of dispatch responses/outcomes."""
    # Distinct OSM identities can share a vertex; coordinate duplicates aren't OD pairs.
    unique = {}
    for candidate in sorted(catalog["candidates"], key=lambda c: c["id"]):
        unique.setdefault(tuple(candidate["coordinate"]), candidate)
    candidates = list(unique.values())
    if len(candidates) < config.fleetSize or len(candidates) < 2:
        raise HTTPException(503, {"code": "INSUFFICIENT_CANDIDATES", "message": "Không đủ candidate OSM."})
    counter = 0

    def draw(limit):
        nonlocal counter
        raw = f"demand-v1:{catalog['datasetFingerprint']}:{config.seed}:{counter}".encode()
        counter += 1
        return int.from_bytes(hashlib.sha256(raw).digest()[:8], "big") % limit

    shuffled = list(candidates)
    for i in range(len(shuffled)-1, 0, -1):
        j = draw(i+1)
        shuffled[i], shuffled[j] = shuffled[j], shuffled[i]
    vehicles = [InitialVehicle(id=f"GSM-{i+1:02}", candidateId=c["id"], initialPosition=c["coordinate"])
                for i, c in enumerate(shuffled[:config.fleetSize])]
    bookings = []
    for i in range(config.bookingCount):
        a = draw(len(candidates))
        b = (a + 1 + draw(len(candidates)-1)) % len(candidates)
        # Low: spread/jitter; Medium: uniform arrivals; High: first quarter burst.
        if config.preset == "Low":
            timestamp = (i + draw(1000)/1000) / config.bookingCount * config.horizonSeconds
        else:
            window = config.horizonSeconds if config.preset == "Medium" else config.horizonSeconds/4
            timestamp = draw(1000000)/1000000 * window
        bookings.append(DemandBooking(id=f"BK-{i+1:03}", passengerId=f"SIM-P-{i+1:03}",
            requestTimeSeconds=round(0 if i == 0 else timestamp, 3),
            pickup=candidates[a]["coordinate"], dropoff=candidates[b]["coordinate"],
            pickupCandidateId=candidates[a]["id"], dropoffCandidateId=candidates[b]["id"]))
    return vehicles, sorted(bookings, key=lambda b: (b.requestTimeSeconds, b.id))


def table_durations(data, count):
    rows = data["durations"]
    if not isinstance(rows, list) or len(rows) != count:
        raise ValueError("Table row count")
    values = []
    for row in rows:
        if not isinstance(row, list) or len(row) != 1:
            raise ValueError("Table column count")
        eta = row[0]
        if eta is not None and (isinstance(eta, bool) or not isinstance(eta, (int, float)) or not math.isfinite(eta) or eta < 0):
            raise ValueError("Invalid table ETA")
        values.append(eta)
    return values


class LocalTravel:
    def __init__(self, settings, fetch_route, distance, client=None):
        self.settings, self.fetch_route, self.distance = settings, fetch_route, distance
        self.client = client
        self.counts = {"nearest": 0, "table": 0, "route": 0, "routeCacheHits": 0, "tableCacheHits": 0}
        self.cache = {}
        self.table_cache = {}

    async def service(self, name, points, params):
        self.counts[name] += 1
        coordinates = ";".join(f"{p[0]},{p[1]}" for p in points)
        try:
            async def query(client):
                return await client.get(f"{self.settings.osrm_base_url}/{name}/v1/driving/{coordinates}",
                    params={**params, "radiuses": ";".join(str(self.settings.max_snap_meters) for _ in points)})
            if self.client is not None:
                response = await query(self.client)
            else:
                async with httpx.AsyncClient(timeout=self.settings.osrm_timeout_seconds, trust_env=False) as client:
                    response = await query(client)
            data = response.json()
            if data.get("code") in {"NoSegment", "NoRoute", "NoTable"}:
                raise HTTPException(422, {"code": data["code"].upper(), "message": "Không tiếp cận được trên graph local."})
            response.raise_for_status()
            if data.get("code") != "Ok":
                raise ValueError("OSRM code")
            return data
        except httpx.TimeoutException:
            raise HTTPException(503, {"code": "ROUTER_TIMEOUT", "message": "OSRM local timeout."})
        except httpx.HTTPError:
            raise HTTPException(503, {"code": "ROUTER_UNAVAILABLE", "message": "Không kết nối OSRM local."})
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(502, {"code": "ROUTER_BAD_RESPONSE", "message": "OSRM service response không hợp lệ."})

    def snap(self, raw, original):
        point = SnapPoint.model_validate(raw)
        w, s, e, n = self.settings.region.display_bbox
        if (point.distance > self.settings.max_snap_meters or
                self.distance(original, point.location) > self.settings.max_snap_meters + 1 or
                not (w <= point.location[0] <= e and s <= point.location[1] <= n)):
            raise ValueError("Snap outside threshold/coverage")
        return point.location

    async def nearest(self, point):
        try:
            data = await self.service("nearest", [point], {"number": 1})
            return self.snap(data["waypoints"][0], point)
        except (KeyError, IndexError, ValueError, TypeError):
            raise HTTPException(502, {"code": "INVALID_INITIAL_SNAP", "message": "Không xác minh được vị trí xe."})

    async def table(self, positions, pickup):
        key = tuple(tuple(p) for p in [*positions, pickup])
        if key in self.table_cache:
            self.counts["tableCacheHits"] += 1
            return self.table_cache[key]
        try:
            data = await self.service("table", [*positions, pickup],
                {"sources": ";".join(str(i) for i in range(len(positions))),
                 "destinations": str(len(positions)), "annotations": "duration"})
            values = table_durations(data, len(positions))
            if len(data["sources"]) != len(positions) or len(data["destinations"]) != 1:
                raise ValueError("Missing waypoints")
            for original, snap in zip(positions, data["sources"]):
                if self.distance(self.snap(snap, original), original) > 1:
                    raise ValueError("Vehicle position changed by Table")
            self.snap(data["destinations"][0], pickup)
            self.table_cache[key] = values
            return values
        except (KeyError, IndexError, ValueError, TypeError):
            raise HTTPException(502, {"code": "ROUTER_BAD_RESPONSE", "message": "Table ETA/snaps không hợp lệ."})

    async def route(self, start, end):
        key = (tuple(start), tuple(end))
        if key in self.cache:
            self.counts["routeCacheHits"] += 1
            return self.cache[key]
        self.counts["route"] += 1
        route = await self.fetch_route(RouteRequest(start=start, end=end))
        w, s, e, n = self.settings.region.display_bbox
        if any(not (w <= lon <= e and s <= lat <= n) for lon, lat in route.coordinates):
            raise HTTPException(422, {"code": "ROUTE_OUTSIDE_DISPLAY", "message": "Tuyến vượt render coverage."})
        self.cache[key] = route
        return route


def recoverable(exc):
    return exc.status_code == 422 and isinstance(exc.detail, dict)


async def build_plan(catalog, config, travel, cancelled=None, *, inputs=None, initial=None,
                     arrival_decider=None, outcome_observer=None):
    begun = time.perf_counter()
    if inputs is None:
        initial, demand = demand_inputs(catalog, config)
    else:
        demand = inputs
        initial = [v.model_copy(deep=True) for v in initial]
    for vehicle in initial:
        vehicle.initialPosition = await travel.nearest(vehicle.initialPosition)
    accepted = []
    vehicles = {v.id: {"position": v.initialPosition, "active": None} for v in initial}
    pending, assignments, events, invalid = {}, [], [], {}
    times = {b.requestTimeSeconds for b in demand} | {b.requestTimeSeconds+config.maxWaitSeconds for b in demand}

    def emit(kind, timestamp, booking_id, vehicle_id=None, **payload):
        events.append(SimulationEvent(id=f"EV-{len(events)+1:04}", timestampSeconds=timestamp,
            type=kind, bookingId=booking_id, vehicleId=vehicle_id, payload=payload))
        if outcome_observer and kind in {"TRIP_COMPLETED", "BOOKING_UNSERVED"}:
            outcome_observer(kind, timestamp, booking_id)

    async def dispatch_pending(now):
        for booking in sorted(list(pending.values()), key=lambda b: (b.requestTimeSeconds, b.id)):
            if cancelled and await cancelled():
                raise HTTPException(499, {"code": "PREPARATION_CANCELLED", "message": "Client đã hủy scenario."})
            deadline = booking.requestTimeSeconds + config.maxWaitSeconds
            if booking.id in invalid:
                continue
            idle = sorted(id for id, v in vehicles.items() if v["active"] is None)
            if not idle or now > deadline:
                continue
            try:
                trip = await travel.route(booking.pickup, booking.dropoff)
                etas = await travel.table([vehicles[id]["position"] for id in idle], trip.coordinates[0])
            except HTTPException as exc:
                if not recoverable(exc):
                    raise
                invalid[booking.id] = exc.detail["code"]
                continue
            candidates = [{"vehicleId": id, "etaSeconds": eta} for id, eta in zip(idle, etas)]
            eligible = sorted([(eta, id) for id, eta in zip(idle, etas)
                               if eta is not None and now+eta <= deadline], key=lambda p: (p[0], p[1]))
            for eta, vehicle_id in eligible:
                position = vehicles[vehicle_id]["position"]
                try:
                    # An idle car already AT the pickup requires no invented zero-length road route.
                    pickup = None if travel.distance(position, trip.coordinates[0]) < .1 else await travel.route(position, trip.coordinates[0])
                    pickup_duration = pickup.duration if pickup else 0
                    if pickup and (travel.distance(pickup.coordinates[0], position) > 1 or
                                   travel.distance(pickup.coordinates[-1], trip.coordinates[0]) > 1):
                        raise HTTPException(422, {"code": "DISCONTINUOUS_LEGS", "message": "Snap giữa các leg không khớp."})
                    if now+pickup_duration > deadline:
                        continue
                except HTTPException as exc:
                    if not recoverable(exc):
                        raise
                    continue
                assignment = Assignment(bookingId=booking.id, vehicleId=vehicle_id,
                    assignedAtSeconds=now, pickupAtSeconds=now+pickup_duration,
                    dropoffAtSeconds=now+pickup_duration+trip.duration,
                    estimatedPickupEtaSeconds=pickup_duration, tableEtaSeconds=eta,
                    pickupRoute=pickup, tripRoute=trip, dispatchCandidates=candidates)
                assignments.append(assignment)
                vehicles[vehicle_id]["active"] = booking.id
                del pending[booking.id]
                emit("BOOKING_ASSIGNED", now, booking.id, vehicle_id, estimatedPickupEtaSeconds=pickup_duration,
                     tableEtaSeconds=eta, dispatchCandidates=candidates)
                if pickup_duration == 0:
                    emit("VEHICLE_ARRIVED_PICKUP", now, booking.id, vehicle_id)
                    emit("TRIP_STARTED", now, booking.id, vehicle_id)
                else:
                    times.add(assignment.pickupAtSeconds)
                times.add(assignment.dropoffAtSeconds)
                break

    def expire_pending(now):
        for booking in list(pending.values()):
            if now >= booking.requestTimeSeconds+config.maxWaitSeconds:
                emit("BOOKING_UNSERVED", now, booking.id, failureReason=invalid.get(booking.id, "PICKUP_WAIT_LIMIT"))
                del pending[booking.id]

    while times:
        if cancelled and await cancelled():
            raise HTTPException(499, {"code": "PREPARATION_CANCELLED", "message": "Client đã hủy scenario."})
        now = min(times)
        times.remove(now)
        # Release vehicles FIRST. Then pickup events, requests, FIFO dispatch, deadlines.
        for assignment in assignments:
            vehicle = vehicles[assignment.vehicleId]
            if assignment.dropoffAtSeconds == now:
                vehicle.update(position=assignment.tripRoute.coordinates[-1], active=None)
                emit("TRIP_COMPLETED", now, assignment.bookingId, assignment.vehicleId)
            if assignment.pickupAtSeconds == now:
                emit("VEHICLE_ARRIVED_PICKUP", now, assignment.bookingId, assignment.vehicleId)
                emit("TRIP_STARTED", now, assignment.bookingId, assignment.vehicleId)
        if arrival_decider:
            # Release deadline reservations before new demand at the same timestamp.
            # Existing waiting bookings retain FIFO priority and inclusive deadlines.
            await dispatch_pending(now)
            expire_pending(now)
        for booking in demand:
            if booking.requestTimeSeconds == now and (not arrival_decider or arrival_decider(booking, now)):
                accepted.append(booking)
                pending[booking.id] = booking
                emit("BOOKING_REQUESTED", now, booking.id)
        await dispatch_pending(now)
        expire_pending(now)
    events.sort(key=lambda ev: (ev.timestampSeconds, EVENT_ORDER[ev.type], ev.bookingId, ev.id))
    identity = hashlib.sha256(json.dumps({"config": config.model_dump(), "fingerprint": catalog["datasetFingerprint"],
                                         "version": "dispatch-v1"}, sort_keys=True).encode()).hexdigest()
    return ScenarioPlan(id=identity, seed=config.seed, config=config, demand=accepted, vehicles=initial,
        assignments=assignments, events=events, simulationDurationSeconds=max((ev.timestampSeconds for ev in events), default=0),
        datasetFingerprint=catalog["datasetFingerprint"], routingSource=catalog["routingSource"],
        provenance=catalog["provenance"], assumptions={"demandVersion": "demand-v1", "dispatchVersion": "dispatch-v1",
            "dispatchPolicy": "FIFO waiting queue; lowest OSRM Table ETA; vehicle ID tie-break; full-route confirmation",
            "eventOrder": EVENT_ORDER, "maxWaitDefinition": "Actual predicted pickup minus request <= maxWaitSeconds (inclusive)",
            "invalidBookingPolicy": "No replacement geometry; unserved at deadline with failureReason",
            "travelModel": "Constant distance progress over OSRM estimated duration; no dwell/traffic/GPS",
            "stationaryPickup": "pickupRoute=null only when car is already at snapped pickup (<0.1 m)",
            "coordinateToleranceMeters": 1, "routingConcurrency": 1},
        createdAt=datetime.now(timezone.utc).isoformat(), preparationMilliseconds=(time.perf_counter()-begun)*1000,
        routingRequests=travel.counts)
