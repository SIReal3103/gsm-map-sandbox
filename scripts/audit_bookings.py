"""Real local API integration evidence; read-only against map/PBF/OSRM artifacts."""
import json
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "docs/evidence/a3"


def audit(plan):
    assert len({b["id"] for b in plan["demand"]}) == len(plan["demand"])
    assert len({v["id"] for v in plan["vehicles"]}) == len(plan["vehicles"])
    deadline = {b["id"]: b["requestTimeSeconds"]+plan["config"]["maxWaitSeconds"] for b in plan["demand"]}
    end = {}
    for a in plan["assignments"]:
        assert a["assignedAtSeconds"] >= end.get(a["vehicleId"], 0)
        assert a["pickupAtSeconds"] <= deadline[a["bookingId"]]
        end[a["vehicleId"]] = a["dropoffAtSeconds"]
        eligible = [(c["etaSeconds"], c["vehicleId"]) for c in a["dispatchCandidates"]
                    if c["etaSeconds"] is not None and a["assignedAtSeconds"]+c["etaSeconds"] <= deadline[a["bookingId"]]]
        assert min(eligible) == (a["tableEtaSeconds"], a["vehicleId"])
        for route in (a["pickupRoute"], a["tripRoute"]):
            if route:
                assert route["distance"] > 0 and route["duration"] > 0
                assert len(route["coordinates"]) > 1
                w, s, e, n = plan["provenance"]["display_bbox"]
                assert all(w <= x <= e and s <= y <= n for x, y in route["coordinates"])
                assert all(p["distance"] <= plan["provenance"]["max_snap_meters"] for p in route["snap_points"])
    completed = sum(e["type"] == "TRIP_COMPLETED" for e in plan["events"])
    unserved = sum(e["type"] == "BOOKING_UNSERVED" for e in plan["events"])
    assert completed == len(plan["assignments"]) and completed+unserved == len(plan["demand"])
    return {"vehicles": len(plan["vehicles"]), "bookings": len(plan["demand"]), "completed": completed,
            "unserved": unserved, "preparationMilliseconds": plan["preparationMilliseconds"],
            "routingRequests": plan["routingRequests"], "eventCount": len(plan["events"]),
            "durationSeconds": plan["simulationDurationSeconds"], "assignmentAudit": "PASS"}


if __name__ == "__main__":
    DEST.mkdir(parents=True, exist_ok=True)
    summary = []
    with httpx.Client(base_url="http://127.0.0.1:8000", timeout=120, trust_env=False) as client:
        cases = [("scenario-5-20", {}), ("scenario-5-20-repeat", {}),
                 ("scenario-10-30", {"fleetSize": 10, "bookingCount": 30}),
                 ("scenario-unserved", {"fleetSize": 1, "bookingCount": 30, "preset": "High",
                                        "horizonSeconds": 60, "maxWaitSeconds": 10})]
        first = None
        for name, config in cases:
            response = client.post("/api/booking-simulation/prepare", json=config)
            response.raise_for_status()
            plan = response.json()
            result = {"case": name, **audit(plan)}
            if first is None:
                first = plan
            elif name.endswith("repeat"):
                assert all(first[k] == plan[k] for k in ("id", "demand", "vehicles", "assignments", "events"))
                result["deterministicReplay"] = "PASS"
            (DEST / f"{name}.json").write_text(json.dumps(plan, ensure_ascii=False), encoding="utf-8")
            summary.append(result)
            print(json.dumps(result))
    (DEST / "real-integration-summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
