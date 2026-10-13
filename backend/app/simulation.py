"""Deterministic WP3 pilot. Demand and response are assumptions, roads are not.

All prices are integer VND. A voucher is reserved on acceptance, released on
expiry and paid only on completion. Conversion draws are keyed by quote ID.
"""
import hashlib
import heapq
import math
from copy import deepcopy

POLICIES = ("no_offer", "fixed", "response", "state_aware")


def draw(seed, key):
    return int.from_bytes(hashlib.sha256(f"{seed}:{key}".encode()).digest()[:8], "big") / 2**64


def scenario(config, count):
    seed = config["seed"]
    quotes = []
    for i in range(config["quotes"]):
        origin = min(count - 1, int(draw(seed, f"origin:{i}") * count))
        destination = (origin + 1 + int(draw(seed, f"destination:{i}") * (count - 1))) % count
        quotes.append({"id": f"Q{i+1:03}", "arrival": round((i + draw(seed, f"arrival:{i}")) * config["minutes"] * 60 / config["quotes"], 3),
                       "origin": origin, "destination": destination, "draw": draw(seed, f"conversion:{i}")})
    initial = [min(count - 1, int(draw(seed, f"vehicle:{i}") * count)) for i in range(config["fleet"])]
    return quotes, initial


def validate_network(network):
    count = len(network["anchors"])
    if count < 2:
        raise ValueError("At least two routed anchors required")
    for matrix in (network["durations"], network["distances"]):
        if len(matrix) != count or any(len(row) != count for row in matrix):
            raise ValueError("Invalid routing matrix shape")
        for i, row in enumerate(matrix):
            for j, value in enumerate(row):
                if value is None or not math.isfinite(value) or value < 0 or (i != j and value <= 0):
                    raise ValueError("Disconnected or invalid routing matrix; no fallback allowed")


def simulate(config, network, policy):
    validate_network(network)
    if policy not in POLICIES:
        raise ValueError("Unknown policy")
    inputs, initial = scenario(config, len(network["anchors"]))
    quotes = deepcopy(inputs)
    vehicles = [{"id": f"V{i+1:02}", "initial": pos, "position": pos, "available": 0} for i, pos in enumerate(initial)]
    durations, distances = network["durations"], network["distances"]
    traffic = config["traffic_factor"]
    patience, budget = config["patience_seconds"], config["budget_vnd"]
    queue, events, legs, heap = [], [], [], []
    spent, reserved = 0, 0
    sequence = 0

    def schedule(time, priority, kind, index):
        nonlocal sequence
        sequence += 1
        heapq.heappush(heap, (time, priority, sequence, kind, index))

    def record(time, kind, quote):
        assert 0 <= spent <= spent + reserved <= budget
        events.append({"time": time, "kind": kind, "request_id": quote["id"], "spent_vnd": spent, "reserved_vnd": reserved})

    def dispatch(time):
        # Every eligible idle driver accepts the assignment. Customer conversion
        # is drawn separately at quote arrival; no driver rejection is sampled.
        for index in list(queue):
            quote = quotes[index]
            eligible = [(durations[v["position"]][quote["origin"]] * traffic, v["id"], v) for v in vehicles
                        if v["available"] <= time and time + durations[v["position"]][quote["origin"]] * traffic <= quote["expires"]]
            if not eligible:
                continue
            deadhead, _, vehicle = min(eligible, key=lambda x: (x[0], x[1]))
            queue.remove(index)
            pickup = time + deadhead
            finish = pickup + durations[quote["origin"]][quote["destination"]] * traffic
            quote.update(status="assigned", vehicle_id=vehicle["id"], assigned=time, pickup=pickup, completed=finish)
            if deadhead > 0:
                legs.append({"vehicle_id": vehicle["id"], "request_id": quote["id"], "kind": "pickup", "start": time, "end": pickup,
                             "origin": vehicle["position"], "destination": quote["origin"], "path_id": f'{vehicle["position"]}-{quote["origin"]}'})
            legs.append({"vehicle_id": vehicle["id"], "request_id": quote["id"], "kind": "trip", "start": pickup, "end": finish,
                         "origin": quote["origin"], "destination": quote["destination"], "path_id": f'{quote["origin"]}-{quote["destination"]}'})
            vehicle["available"] = finish
            # This is its *next available* position, never its current map position.
            vehicle["position"] = quote["destination"]
            record(time, "assigned", quote)
            schedule(pickup, 1, "pickup", index)
            schedule(finish, 0, "complete", index)

    for i, quote in enumerate(quotes):
        schedule(quote["arrival"], 2, "quote", i)
    while heap:
        time, _, _, kind, index = heapq.heappop(heap)
        quote = quotes[index]
        if kind == "quote":
            # Observable ETA incorporates each vehicle's remaining committed work.
            eta = min(max(0, v["available"] - time) + durations[v["position"]][quote["origin"]] * traffic for v in vehicles)
            q0 = max(.12, .52 - .00055 * eta)
            lift = config["voucher_effect"]
            offer = 0
            if policy == "fixed":
                offer = 10000
            elif policy in {"response", "state_aware"}:
                # Response-only control maximizes assumed conversion. State-aware
                # abstains when the observed pickup commitment exceeds patience,
                # or the FIFO queue has already consumed idle capacity.
                offer = 10000 if q0 < .4 else 5000
                idle = sum(v["available"] <= time for v in vehicles)
                if policy == "state_aware" and (eta > patience * .75 or len(queue) >= idle + 1):
                    offer = 0
            if spent + reserved + offer > budget:
                offer = 0
            probability = min(.95, q0 + lift * offer / 10000)
            accepted = quote["draw"] < probability  # Customer sends a booking.
            quote.update(offer_vnd=offer, probability=probability, quoted_eta=eta, accepted=accepted,
                         status="queued" if accepted else "rejected", expires=time + patience)
            if accepted:
                reserved += offer
                queue.append(index)
                schedule(quote["expires"], 3, "expire", index)
            record(time, "accepted" if accepted else "rejected", quote)
            dispatch(time)
        elif kind == "pickup":
            quote["status"] = "onboard"
            record(time, "pickup", quote)
        elif kind == "complete":
            quote["status"] = "completed"
            reserved -= quote["offer_vnd"]
            spent += quote["offer_vnd"]
            record(time, "completed", quote)
            dispatch(time)
        elif kind == "expire" and quote["status"] == "queued":
            quote["status"] = "expired"
            queue.remove(index)
            reserved -= quote["offer_vnd"]
            record(time, "expired", quote)
    assert reserved == 0 and not queue
    completed = [q for q in quotes if q["status"] == "completed"]
    waits = [q["pickup"] - q["arrival"] for q in completed]
    summary = {"quoted": len(quotes), "accepted": sum(q["accepted"] for q in quotes), "completed": len(completed),
               "expired": sum(q["status"] == "expired" for q in quotes), "actual_spend_vnd": spent, "reserved_vnd": reserved,
               "mean_pickup_seconds": sum(waits) / len(waits) if waits else None,
               "deadhead_km": sum(distances[l["origin"]][l["destination"]] for l in legs if l["kind"] == "pickup") / 1000,
               "passenger_km": sum(distances[l["origin"]][l["destination"]] for l in legs if l["kind"] == "trip") / 1000}
    return {"policy": policy, "vehicles": [{"id": v["id"], "initial": v["initial"]} for v in vehicles], "quotes": quotes,
            "legs": legs, "events": events, "summary": summary, "duration": max(config["minutes"] * 60, max((l["end"] for l in legs), default=0), max((e["time"] for e in events), default=0))}
