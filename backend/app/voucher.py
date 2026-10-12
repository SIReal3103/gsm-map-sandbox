"""Paired hypothetical price-response experiments over the shared A3 dispatcher."""
import hashlib
import json
import math
import time
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .booking import PrepareRequest, build_plan, demand_inputs, recoverable
from fastapi import HTTPException


class ConfigModel(BaseModel):
    model_config = ConfigDict(extra="forbid", validate_default=True)


class FareConfig(ConfigModel):
    baseFare: int = Field(default=10000, ge=0, le=100000, strict=True)
    perKm: int = Field(default=12000, ge=0, le=100000, strict=True)


class BehaviorConfig(ConfigModel):
    alpha: float = Field(default=1.5, ge=-20, le=20, allow_inf_nan=False)
    beta: float = Field(default=2, ge=0, le=20, allow_inf_nan=False)
    referenceFare: int = Field(default=50000, ge=1, le=1000000, strict=True)


class VoucherConfig(ConfigModel):
    type: Literal["fixed", "percentage"] = "fixed"
    fixedAmount: int = Field(default=20000, ge=0, le=1000000, strict=True)
    rate: float = Field(default=.3, ge=0, le=1, allow_inf_nan=False)
    cap: int = Field(default=25000, ge=0, le=1000000, strict=True)
    minimumFare: int = Field(default=0, ge=0, le=1000000, strict=True)


class ExperimentRequest(ConfigModel):
    seed: str = Field(default="hcm-voucher-2026", min_length=1, max_length=80)
    fleetSize: int = Field(default=5, ge=1, le=10, strict=True)
    potentialCount: int = Field(default=30, ge=10, le=30, strict=True)
    horizonSeconds: int = Field(default=1800, ge=60, le=3600, strict=True)
    maxWaitSeconds: int = Field(default=300, ge=10, le=900, strict=True)
    preset: Literal["Low", "Medium", "High"] = "Medium"
    fare: FareConfig = Field(default_factory=FareConfig)
    behavior: BehaviorConfig = Field(default_factory=BehaviorConfig)
    voucher: VoucherConfig = Field(default_factory=VoucherConfig)
    campaignBudget: int = Field(default=200000, ge=0, le=10000000, strict=True)


def money(value):
    """Integer VND; decimal half-up, never Python banker's rounding."""
    return int(Decimal(str(value)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def fare_quote(distance_meters, config):
    if not math.isfinite(distance_meters) or distance_meters < 0:
        raise ValueError("Invalid OSRM distance")
    return money(Decimal(config.baseFare)+Decimal(config.perKm)*Decimal(str(distance_meters))/1000)


def sigmoid(z):
    if not math.isfinite(z):
        raise ValueError("Non-finite logit")
    return 1/(1+math.exp(-z)) if z >= 0 else math.exp(z)/(1+math.exp(z))


def probability(fare, discount, behavior):
    if fare < 0 or not 0 <= discount <= fare:
        raise ValueError("Invalid effective fare")
    return sigmoid(behavior.alpha-behavior.beta*(fare-discount)/behavior.referenceFare)


def stable_draw(seed, fingerprint, passenger_id):
    # 53 bits produce an exact binary draw in [0,1), independent of arm/call order.
    raw = f"price-response-v1:{seed}:{fingerprint}:{passenger_id}".encode()
    return (int.from_bytes(hashlib.sha256(raw).digest()[:8], "big") >> 11)/2**53


def discount_for(fare, policy):
    if fare < policy.minimumFare:
        return 0
    value = policy.fixedAmount if policy.type == "fixed" else min(
        Decimal(fare)*Decimal(str(policy.rate)), Decimal(policy.cap))
    return min(fare, money(value))


class BudgetLedger:
    def __init__(self, total):
        if not isinstance(total, int) or total < 0:
            raise ValueError("Invalid budget")
        self.total, self.spent = total, 0
        self.reservations, self.terminal, self.events = {}, set(), []

    @property
    def reserved(self):
        return sum(self.reservations.values())

    @property
    def available(self):
        return self.total-self.reserved-self.spent

    def snapshot(self):
        return {"total": self.total, "reserved": self.reserved,
                "spent": self.spent, "available": self.available}

    def transact(self, kind, timestamp, booking_id, amount):
        if not isinstance(amount, int) or amount <= 0:
            raise ValueError("Positive integer voucher amount required")
        if self.events and timestamp < self.events[-1]["timestampSeconds"]:
            raise ValueError("Non-chronological transaction")
        if kind == "RESERVED":
            if booking_id in self.reservations or booking_id in self.terminal or amount > self.available:
                raise ValueError("Duplicate/over-budget reservation")
            self.reservations[booking_id] = amount
        elif kind in {"SETTLED", "RELEASED"}:
            if self.reservations.get(booking_id) != amount or booking_id in self.terminal:
                raise ValueError("Missing/duplicate settlement or release")
            del self.reservations[booking_id]
            self.terminal.add(booking_id)
            if kind == "SETTLED":
                self.spent += amount
        elif kind != "OFFERED":
            raise ValueError("Invalid ledger event")
        assert self.reserved >= 0 and self.spent >= 0 and self.available >= 0
        event = {"id": f"VL-{len(self.events)+1:04}", "type": kind,
                 "timestampSeconds": timestamp, "bookingId": booking_id,
                 "amountVnd": amount, **self.snapshot()}
        self.events.append(event)


def arm_metrics(potential, arm, total_budget, timestamp):
    plan = arm["plan"]
    decisions = [d for d in arm["decisions"] if d["timestampSeconds"] <= timestamp]
    accepted = [d for d in decisions if d["accepted"]]
    valid = sum(p["valid"] and p["requestTimeSeconds"] <= timestamp for p in potential)
    assignments = [a for a in plan["assignments"] if a["assignedAtSeconds"] <= timestamp]
    picked = [a for a in assignments if a["pickupAtSeconds"] <= timestamp]
    completed = [a for a in assignments if a["dropoffAtSeconds"] <= timestamp]
    unserved = sum(e["type"] == "BOOKING_UNSERVED" and e["timestampSeconds"] <= timestamp for e in plan["events"])
    budget = {"total": total_budget, "reserved": 0, "spent": 0, "available": total_budget}
    settled = {}
    counts = {kind: 0 for kind in ("OFFERED", "RESERVED", "SETTLED", "RELEASED")}
    for event in arm["ledger"]:
        if event["timestampSeconds"] <= timestamp:
            budget = {k: event[k] for k in budget}
            counts[event["type"]] += 1
            if event["type"] == "SETTLED":
                settled[event["bookingId"]] = event["amountVnd"]
    by_id = {p["id"]: p for p in potential}
    gross = sum(by_id[a["bookingId"]]["quotedFareVnd"] for a in completed)
    subsidy = sum(settled.get(a["bookingId"], 0) for a in completed)
    average = lambda v: sum(v)/len(v) if v else None
    busy, empty, occupied = 0, 0, 0
    for a in assignments:
        busy += max(0, min(timestamp, a["dropoffAtSeconds"])-a["assignedAtSeconds"])
        pickup = a["pickupRoute"]
        if pickup:
            empty += pickup["distance"]*min(1, max(0, (timestamp-a["assignedAtSeconds"])/pickup["duration"]))
        occupied += a["tripRoute"]["distance"]*min(1, max(0, (timestamp-a["pickupAtSeconds"])/a["tripRoute"]["duration"]))
    if gross-subsidy < 0 or subsidy != budget["spent"]:
        raise ValueError("Financial identity mismatch")
    return {"validPotential": valid, "invalidPotential": len(decisions)-valid,
            "accepted": len(accepted), "assigned": len(assignments), "pickedUp": len(picked),
            "completed": len(completed), "unserved": unserved,
            "conversionRate": len(accepted)/valid if valid else None,
            "completionRate": len(completed)/len(accepted) if accepted else None,
            "averageWaitSeconds": average([a["pickupAtSeconds"]-by_id[a["bookingId"]]["requestTimeSeconds"] for a in picked]),
            "averagePickupEtaSeconds": average([a["estimatedPickupEtaSeconds"] for a in assignments]),
            "averageTripSeconds": average([a["tripRoute"]["duration"] for a in completed]),
            "emptyMeters": empty, "occupiedMeters": occupied,
            "utilization": busy/(len(plan["vehicles"])*timestamp) if timestamp > 0 else None,
            "grossFareVnd": gross, "riderPaymentsVnd": gross-subsidy,
            "voucherSpendVnd": subsidy, "budget": budget, "voucherCounts": counts}


def comparison(baseline, treatment):
    incremental = treatment["completed"]-baseline["completed"]
    return {"bookingUplift": treatment["accepted"]-baseline["accepted"],
            "incrementalCompleted": incremental,
            "costPerIncrementalCompletionVnd": treatment["voucherSpendVnd"]/incremental if incremental > 0 else None}


async def prepare_experiment(catalog, config, travel, cancelled=None):
    start = time.perf_counter()
    core_config = PrepareRequest(seed=config.seed, fleetSize=config.fleetSize,
        bookingCount=config.potentialCount, horizonSeconds=config.horizonSeconds,
        maxWaitSeconds=config.maxWaitSeconds, preset=config.preset)
    initial, inputs = demand_inputs(catalog, core_config)
    potential = []
    for booking in inputs:
        if cancelled and await cancelled():
            raise HTTPException(499, {"code": "PREPARATION_CANCELLED", "message": "Experiment đã hủy."})
        p = {**booking.model_dump(), "alpha": config.behavior.alpha, "beta": config.behavior.beta,
             "referenceFareVnd": config.behavior.referenceFare,
             "randomDraw": stable_draw(config.seed, catalog["datasetFingerprint"], booking.passengerId),
             "datasetFingerprint": catalog["datasetFingerprint"], "valid": True,
             "invalidReason": None, "quotedFareVnd": None, "quotedRoute": None}
        try:
            route = await travel.route(booking.pickup, booking.dropoff)
            p.update(quotedFareVnd=fare_quote(route.distance, config.fare), quotedRoute=route.model_dump())
        except HTTPException as exc:
            if not recoverable(exc):
                raise
            p.update(valid=False, invalidReason=exc.detail["code"])
        potential.append(p)
    by_id = {p["id"]: p for p in potential}
    arms = {}
    for name in ("baseline", "treatment"):
        ledger = BudgetLedger(config.campaignBudget if name == "treatment" else 0)
        decisions = []

        def decide(booking, now):
            p = by_id[booking.id]
            available_before = ledger.available
            discount, reason = 0, p["invalidReason"]
            if p["valid"]:
                eligible_discount = discount_for(p["quotedFareVnd"], config.voucher) if name == "treatment" else 0
                if eligible_discount > 0 and eligible_discount <= ledger.available:
                    discount = eligible_discount
                    ledger.transact("OFFERED", now, booking.id, discount)
                elif eligible_discount > ledger.available:
                    reason = "BUDGET_UNAVAILABLE"
                prob = probability(p["quotedFareVnd"], discount, config.behavior)
                accepted = p["randomDraw"] < prob
            else:
                prob, accepted = None, False
            if accepted and discount > 0:
                ledger.transact("RESERVED", now, booking.id, discount)
            decisions.append({"potentialId": booking.id, "timestampSeconds": now,
                "valid": p["valid"], "discountVnd": discount,
                "effectiveFareVnd": p["quotedFareVnd"]-discount if p["valid"] else None,
                "probability": prob, "accepted": accepted, "reason": reason,
                "availableBeforeVnd": available_before, "availableAfterVnd": ledger.available})
            return accepted

        def observe(kind, now, booking_id):
            amount = ledger.reservations.get(booking_id)
            if amount:
                ledger.transact("SETTLED" if kind == "TRIP_COMPLETED" else "RELEASED", now, booking_id, amount)

        plan = await build_plan(catalog, core_config, travel, cancelled, inputs=inputs,
            initial=initial, arrival_decider=decide, outcome_observer=observe)
        if ledger.reserved != 0:
            raise ValueError("Unresolved voucher reservation")
        arms[name] = {"plan": plan.model_dump(), "decisions": decisions, "ledger": ledger.events}
    duration = max(config.horizonSeconds, *(arm["plan"]["simulationDurationSeconds"] for arm in arms.values()))
    final = {name: arm_metrics(potential, arm, config.campaignBudget if name == "treatment" else 0, duration)
             for name, arm in arms.items()}
    timestamps = {0, duration, *range(60, int(duration), 60)}
    for p in potential:
        timestamps.add(p["requestTimeSeconds"])
    for arm in arms.values():
        timestamps.update(e["timestampSeconds"] for e in [*arm["plan"]["events"], *arm["ledger"]])
    series = [{"timeSeconds": t, **{name: arm_metrics(potential, arm,
               config.campaignBudget if name == "treatment" else 0, t) for name, arm in arms.items()}}
              for t in sorted(timestamps)]
    assumptions = {"fare": "Hypothetical integer VND; decimal half-up; OSRM car distance",
        "priceResponse": "Homogeneous configured alpha/beta, stable sigmoid; uncalibrated assumptions",
        "draw": "Common random numbers: identity/seed/fingerprint SHA256 53-bit draw",
        "budgetPolicy": "Full eligible voucher or zero; offered costs nothing; reserve on acceptance; settle on completion; release on unserved",
        "sameTimestamp": "Completions settle/release cars; existing FIFO dispatch/deadlines release; new demand in (time,ID) order; FIFO dispatch then remaining deadlines",
        "dispatch": "Shared A3 FIFO + minimum OSRM Table ETA, vehicle ID tie, full-route confirmation",
        "horizon": "Arrivals within configured horizon; drain accepted trips; both arms measured through common final duration",
        "invalidQuote": "Excluded from valid potential denominator; no decisions/fare fallback in either arm",
        "versions": {"fare": "fare-v1", "behavior": "price-response-v1", "voucher": "ledger-v1", "orchestrator": "paired-v1", "dispatch": "dispatch-v1"},
        "interpretation": "Hypothetical counterfactual simulation; not calibrated causal/business evidence"}
    identity = hashlib.sha256(json.dumps({"config": config.model_dump(), "potential": potential,
        "fingerprint": catalog["datasetFingerprint"], "versions": assumptions["versions"]}, sort_keys=True).encode()).hexdigest()
    return {"id": identity, "seed": config.seed, "config": config.model_dump(), "potential": potential,
        "baseline": arms["baseline"], "treatment": arms["treatment"], "final": final,
        "comparison": comparison(final["baseline"], final["treatment"]), "timeSeries": series,
        "simulationDurationSeconds": duration, "datasetFingerprint": catalog["datasetFingerprint"],
        "provenance": catalog["provenance"], "assumptions": assumptions,
        "createdAt": datetime.now(timezone.utc).isoformat(), "preparationMilliseconds": (time.perf_counter()-start)*1000,
        "routingRequests": travel.counts}
