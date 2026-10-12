"""Independent Python audit of browser DOM projections against real OSRM plans."""
import json
import math
from pathlib import Path

DEST = Path(__file__).resolve().parents[1] / "docs/evidence/a3"


def interpolate(route, progress):
    points = route["coordinates"]
    lengths = [math.hypot((b[0]-a[0])*math.cos(math.radians((a[1]+b[1])/2)), b[1]-a[1])
               for a, b in zip(points, points[1:])]
    target = sum(lengths)*progress
    for a, b, length in zip(points, points[1:], lengths):
        if length > 0 and target <= length:
            return [a[i]+(b[i]-a[i])*target/length for i in (0, 1)]
        target -= length
    return points[-1]


def project(plan, timestamp):
    vehicles, empty, occupied, busy = {}, 0, 0, 0
    for v in plan["vehicles"]:
        position, status, progress = v["initialPosition"], "idle", 0
        for a in plan["assignments"]:
            if a["vehicleId"] != v["id"] or a["assignedAtSeconds"] > timestamp:
                continue
            pickup = a["pickupRoute"]
            pp = min(1, max(0, (timestamp-a["assignedAtSeconds"])/pickup["duration"])) if pickup else 1
            tp = min(1, max(0, (timestamp-a["pickupAtSeconds"])/a["tripRoute"]["duration"]))
            empty += (pickup["distance"] if pickup else 0)*pp
            occupied += a["tripRoute"]["distance"]*tp
            busy += min(timestamp, a["dropoffAtSeconds"])-a["assignedAtSeconds"]
            if timestamp >= a["dropoffAtSeconds"]:
                position = a["tripRoute"]["coordinates"][-1]
            else:
                status = "en_route_to_pickup" if timestamp < a["pickupAtSeconds"] else "on_trip"
                route, progress = (pickup, pp) if status == "en_route_to_pickup" else (a["tripRoute"], tp)
                position = interpolate(route, progress)
        vehicles[v["id"]] = {"coordinate": position, "status": status, "progress": progress}
    requested = sum(b["requestTimeSeconds"] <= timestamp for b in plan["demand"])
    assigned = [a for a in plan["assignments"] if a["assignedAtSeconds"] <= timestamp]
    picked = [a for a in assigned if a["pickupAtSeconds"] <= timestamp]
    completed = [a for a in assigned if a["dropoffAtSeconds"] <= timestamp]
    request_times = {b["id"]: b["requestTimeSeconds"] for b in plan["demand"]}
    avg = lambda values: sum(values)/len(values) if values else None
    metrics = {"requested": requested, "assigned": len(assigned), "completed": len(completed),
               "unserved": sum(e["type"] == "BOOKING_UNSERVED" and e["timestampSeconds"] <= timestamp for e in plan["events"]),
               "serviceRate": len(picked)/requested if requested else None,
               "completionRate": len(completed)/requested if requested else None,
               "averageWaitingSeconds": avg([a["pickupAtSeconds"]-request_times[a["bookingId"]] for a in picked]),
               "averageTripSeconds": avg([a["tripRoute"]["duration"] for a in completed]),
               "averageEstimatedPickupEtaSeconds": avg([a["estimatedPickupEtaSeconds"] for a in assigned]),
               "emptyMeters": empty, "occupiedMeters": occupied,
               "utilization": busy/(len(vehicles)*timestamp) if timestamp else None}
    return vehicles, metrics


if __name__ == "__main__":
    qa = json.loads((DEST / "browser-qa.json").read_text(encoding="utf-8"))
    plans = {name: json.loads((DEST / f"{name}.json").read_text(encoding="utf-8"))
             for name in ("scenario-5-20", "scenario-10-30", "scenario-unserved")}
    checks = []
    for sample in qa["samples"]:
        plan = plans[sample.get("planCase", "scenario-5-20")]
        expected, _ = project(plan, sample["time"])
        assert len(sample["markers"]) == len(plan["vehicles"])
        assert sample["canvasCount"] == 1
        for marker in sample["markers"]:
            want = expected[marker["id"]]
            error = math.hypot(*(marker["coordinate"][i]-want["coordinate"][i] for i in (0, 1)))
            assert error < 1e-10 and marker["status"] == want["status"] and abs(marker["progress"]-want["progress"]) < 1e-10, (sample["label"], marker["id"], want, marker)
            checks.append({"sample": sample["label"], "vehicle": marker["id"], "coordinateErrorDegrees": error})
        # Validate each visible booking row from event history at this time (filter may omit others).
        states = {b["id"]: "scheduled" for b in plan["demand"]}
        status = {"BOOKING_REQUESTED": "waiting", "BOOKING_ASSIGNED": "assigned", "TRIP_STARTED": "picked_up",
                  "TRIP_COMPLETED": "completed", "BOOKING_UNSERVED": "unserved"}
        for e in plan["events"]:
            if e["timestampSeconds"] <= sample["time"] and e["type"] in status:
                states[e["bookingId"]] = status[e["type"]]
        assert all(states[row["id"]] == row["status"] for row in sample["rows"])
    for sample in qa["metricSamples"]:
        _, metrics = project(plans[sample["planCase"]], sample["time"])
        for key, expected in metrics.items():
            actual = sample["metrics"][key]
            assert actual is None if expected is None else abs(actual-expected) < 1e-8, (key, actual, expected)
    result = {"status": "PASS", "vehicleProjections": len(checks), "metricSnapshots": len(qa["metricSamples"]),
              "maxCoordinateErrorDegrees": max(c["coordinateErrorDegrees"] for c in checks), "checks": checks,
              "note": "Independent Python projection of actual full OSRM geometries and stored event log; browser DOM telemetry."}
    (DEST / "projection-audit.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"PASS: {len(checks)} vehicle projections, booking histories, {len(qa['metricSamples'])} metric snapshots")
