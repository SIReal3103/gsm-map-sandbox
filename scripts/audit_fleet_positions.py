"""Independent segment-membership check of real browser projections (no PBF parsing)."""
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "docs/evidence/a2"


def point_segment_error(point, a, b):
    scale = math.cos(math.radians(point[1]))
    ax, ay = (a[0]-point[0])*scale, a[1]-point[1]
    bx, by = (b[0]-point[0])*scale, b[1]-point[1]
    dx, dy = bx-ax, by-ay
    length = dx*dx+dy*dy
    t = max(0, min(1, -(ax*dx+ay*dy)/length)) if length else 0
    return math.hypot(ax+t*dx, ay+t*dy) * math.pi/180*6371008.8


def main():
    integrations = json.loads((EVIDENCE / "real-fleet-integration.json").read_text(encoding="utf-8"))
    qa = json.loads((EVIDENCE / "browser-qa.json").read_text(encoding="utf-8"))
    routes = {v["id"]: v for v in integrations[1]["scenario"]["vehicles"]}
    checks = []
    for sample in ["seekAllMoving", "seek50", "stress10After", "stressAfterOptimization", "final10", "mobilePlayback"]:
        for marker in qa[sample]["markers"]:
            vehicle = routes[marker["id"]]
            coordinates = vehicle["route"]["coordinates"]
            error = min(point_segment_error(marker["coordinate"], a, b) for a, b in zip(coordinates, coordinates[1:]))
            expected_progress = max(0, min(1, (qa[sample]["time"]-vehicle["departureOffsetSeconds"])/vehicle["durationSeconds"]))
            assert error < .001, (sample, marker["id"], error)
            assert abs(marker["progress"]-expected_progress) < 1e-10
            checks.append({"sample": sample, "id": marker["id"], "segment_error_meters": error, "progress_error": abs(marker["progress"]-expected_progress)})
    result = {"checks": checks, "count": len(checks), "max_segment_error_meters": max(c["segment_error_meters"] for c in checks), "note": "Independent check of browser DOM telemetry against full, real OSRM polyline. Native marker transforms verified separately in browser QA."}
    (EVIDENCE / "position-audit.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"PASS: {len(checks)} browser vehicle projections lie on their OSRM polylines; progress matches the shared clock.")


if __name__ == "__main__":
    main()
