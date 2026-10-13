"""Audit the running local WP3 API against independently queried OSRM tables.

Run from the repository root. Uses only the Python standard library; never
changes source data or graph. Writes reproducible integration evidence.
"""
import argparse
import hashlib
import json
import math
import re
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def fetch(url, body=None):
    request = Request(url, data=None if body is None else json.dumps(body).encode(),
                      headers={"Content-Type": "application/json"})
    with urlopen(request, timeout=180) as response:
        return json.load(response)


def near(actual, expected, tolerance=1e-6):
    assert math.isfinite(actual) and abs(actual - expected) <= tolerance, (actual, expected)


def audit(result, table):
    anchors = result["anchors"]
    config = result["config"]
    baseline_inputs = None
    path_checks = 0
    for index, anchor in enumerate(anchors):
        assert anchor["coordinate"] == table["sources"][index]["location"] == table["destinations"][index]["location"]
        assert 0 <= anchor["snap_meters"] <= 100
    for path_id, path in result["paths"].items():
        origin, destination = map(int, path_id.split("-"))
        near(path["duration"], table["durations"][origin][destination], .1)
        near(path["distance"], table["distances"][origin][destination], .1)
        assert len(path["coordinates"]) > 1
        assert len(path['segment_durations']) == len(path['coordinates']) - 1
        assert len(path['segment_distances']) == len(path['coordinates']) - 1
        assert all(math.isfinite(v) and v >= 0 for v in path['segment_durations'])
        assert sum(path['segment_durations']) > 0
        for point, index in [(path["coordinates"][0], origin), (path["coordinates"][-1], destination)]:
            for a, b in zip(point, anchors[index]["coordinate"]):
                near(a, b, .000005)
        path_checks += 1
    for run in result["runs"]:
        quotes = {q["id"]: q for q in run["quotes"]}
        dispatch_state = {v['id']: {'position': v['initial'], 'available': 0} for v in run['vehicles']}
        inputs = [(q["id"], q["arrival"], q["origin"], q["destination"], q["draw"]) for q in run["quotes"]]
        if baseline_inputs is None:
            baseline_inputs = inputs
        assert inputs == baseline_inputs
        assert len(inputs) == config["quotes"]
        assert all(q["accepted"] == (q["draw"] < q["probability"]) for q in run["quotes"])
        spent, reserved, prior_time = 0, 0, -1
        observed = {key: [] for key in quotes}
        for event in run["events"]:
            assert event["time"] >= prior_time
            prior_time = event["time"]
            quote = quotes[event["request_id"]]
            amount = quote["offer_vnd"]
            assert isinstance(amount, int) and amount >= 0
            observed[quote["id"]].append(event["kind"])
            if event["kind"] == "accepted":
                reserved += amount
            elif event['kind'] == 'assigned':
                candidates = []
                for vehicle_id, state in dispatch_state.items():
                    eta = table['durations'][state['position']][quote['origin']] * config['traffic_factor']
                    if state['available'] <= event['time'] and event['time'] + eta <= quote['expires']:
                        candidates.append((eta, vehicle_id))
                assert candidates, 'Assignment requires an eligible idle vehicle'
                eta, chosen = min(candidates)
                assert chosen == quote['vehicle_id'], 'Nearest eligible idle vehicle must accept'
                near(quote['pickup'], event['time'] + eta)
                dispatch_state[chosen] = {'position': quote['destination'], 'available': quote['completed']}
            elif event["kind"] == "expired":
                reserved -= amount
            elif event["kind"] == "completed":
                reserved -= amount
                spent += amount
            assert (spent, reserved) == (event["spent_vnd"], event["reserved_vnd"])
            assert 0 <= spent <= spent + reserved <= config["budget_vnd"]
        assert reserved == run["summary"]["reserved_vnd"] == 0
        assert spent == run["summary"]["actual_spend_vnd"] == sum(q["offer_vnd"] for q in quotes.values() if q["status"] == "completed")
        counts = {status: sum(q["status"] == status for q in quotes.values()) for status in ["completed", "expired", "rejected"]}
        assert sum(counts.values()) == config["quotes"]
        assert counts["completed"] == run["summary"]["completed"]
        assert counts["expired"] == run["summary"]["expired"]
        assert run["summary"]["accepted"] == counts["completed"] + counts["expired"]
        for q in quotes.values():
            if q["status"] == "completed":
                assert observed[q["id"]] == ["accepted", "assigned", "pickup", "completed"]
                assert q["arrival"] <= q["assigned"] <= q["pickup"] <= q["expires"]
                assert q["pickup"] < q["completed"]
                trips = [leg for leg in run["legs"] if leg["request_id"] == q["id"] and leg["kind"] == "trip"]
                assert len(trips) == 1
                trip = trips[0]
                assert (trip["origin"], trip["destination"], trip["vehicle_id"], trip["start"], trip["end"]) == (q["origin"], q["destination"], q["vehicle_id"], q["pickup"], q["completed"])
            else:
                assert observed[q["id"]] == (["accepted", "expired"] if q["accepted"] else ["rejected"])
                assert not any(leg["request_id"] == q["id"] for leg in run["legs"])
        for vehicle in run["vehicles"]:
            legs = [leg for leg in run["legs"] if leg["vehicle_id"] == vehicle["id"]]
            position, end = vehicle["initial"], 0
            for leg in legs:
                assert leg["start"] >= end and leg["origin"] == position
                assert leg["path_id"] == f'{leg["origin"]}-{leg["destination"]}'
                assert leg["path_id"] in result["paths"]
                near(leg["end"] - leg["start"], table["durations"][leg["origin"]][leg["destination"]] * config["traffic_factor"])
                position, end = leg["destination"], leg["end"]
        for kind, metric in [("pickup", "deadhead_km"), ("trip", "passenger_km")]:
            near(run["summary"][metric], sum(table["distances"][l["origin"]][l["destination"]] for l in run["legs"] if l["kind"] == kind) / 1000)
    return path_checks


def audit_browser(result, observations):
    """Check visible DOM telemetry with independent local plane projection."""
    def xy(point):
        return (point[0] * 111195 * math.cos(math.radians(10.77)), point[1] * 111195)

    checks = 0
    for observation in observations:
        time = float(observation["time"])
        label = observation['policy']
        if label in {'no_offer', 'fixed', 'response', 'state_aware'}:
            policy = label
        else:
            names = {'Không voucher': 'no_offer', 'Cố định': 'fixed', 'Response': 'response', 'State-aware': 'state_aware'}
            policy = next(value for name, value in names.items() if label.startswith(name))
        run = next(run for run in result["runs"] if run["policy"] == policy)
        vehicles = observation.get('vehicles', observation.get('markers'))
        assert len(vehicles) == result["config"]["fleet"]
        for marker in vehicles:
            vehicle = next(v for v in run["vehicles"] if v["id"] == marker["id"])
            legs = [leg for leg in run["legs"] if leg["vehicle_id"] == marker["id"]]
            active = next((leg for leg in legs if leg["start"] <= time < leg["end"]), None)
            position = xy(marker["coordinate"])
            if active is None:
                completed = [leg for leg in legs if leg["end"] <= time]
                index = completed[-1]["destination"] if completed else vehicle["initial"]
                assert marker["status"] == "idle"
                assert math.dist(position, xy(result["anchors"][index]["coordinate"])) < .05
            else:
                assert marker["status"] == active["kind"]
                points = list(map(xy, result["paths"][active["path_id"]]["coordinates"]))
                total, matches = 0, []
                for a, b in zip(points, points[1:]):
                    length = math.dist(a, b)
                    if length > 0:
                        vector = (b[0]-a[0], b[1]-a[1])
                        fraction = max(0, min(1, sum((p-q)*v for p, q, v in zip(position, a, vector)) / length**2))
                        projected = (a[0]+fraction*vector[0], a[1]+fraction*vector[1])
                        matches.append((math.dist(position, projected), total + fraction*length))
                    total += length
                error, along = min(matches)
                assert error < .5, (marker["id"], error)
                weights = result['paths'][active['path_id']]['segment_durations']
                remaining = sum(weights) * (time-active['start']) / (active['end']-active['start'])
                expected = 0
                for weight, a, b in zip(weights, points, points[1:]):
                    length = math.dist(a, b)
                    if weight > 0 and remaining < weight:
                        expected += length * remaining / weight
                        break
                    expected += length
                    remaining -= weight
                assert abs(along-expected) < max(1, total*.001), (along, expected)
            checks += 1
        events = [event for event in run["events"] if event["time"] <= time]
        ledger = events[-1] if events else {"spent_vnd": 0, "reserved_vnd": 0}
        visible = [int(re.sub(r"\D", "", part)) for part in observation["budget"].split("/")]
        assert visible == [ledger["spent_vnd"], ledger["reserved_vnd"]]
    assert float(observations[1]["time"]) > float(observations[0]["time"])
    assert observations[1]["time"] == observations[2]["time"], "Policy change must preserve paused time"
    return checks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api", default="http://127.0.0.1:8000")
    parser.add_argument("--osrm", default="http://127.0.0.1:5001")
    parser.add_argument("--output", default="plans/20261012-hcm-q1-wp3/reports")
    parser.add_argument("--browser-telemetry", help="Saved visible DOM observations from browser QA")
    parser.add_argument("--browser-export", help="JSON downloaded by the UI's export button")
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    default = fetch(args.api + "/api/wp3/simulate", {})
    replay = fetch(args.api + "/api/wp3/simulate", {})
    assert default == replay, "Same seed and graph must replay identically"
    coords = ";".join(f'{a["source_coordinate"][0]},{a["source_coordinate"][1]}' for a in default["anchors"])
    table = fetch(args.osrm + "/table/v1/driving/" + coords + "?" + urlencode({"annotations": "duration,distance", "radiuses": ";".join(["100"] * len(default["anchors"]))}))
    assert table["code"] == "Ok"
    for path_id, path in default['paths'].items():
        origin, destination = map(int, path_id.split('-'))
        coords = ';'.join(','.join(map(str, default['anchors'][i]['coordinate'])) for i in [origin, destination])
        params = {'overview': 'full', 'geometries': 'geojson', 'annotations': 'duration,distance',
                  'hints': ';'.join(table['sources'][i]['hint'] for i in [origin, destination])}
        direct = fetch(args.osrm + '/route/v1/driving/' + coords + '?' + urlencode(params))['routes'][0]
        annotation = direct['legs'][0]['annotation']
        assert path['segment_durations'] == annotation['duration']
        assert path['segment_distances'] == annotation['distance']
        assert path['coordinates'] == direct['geometry']['coordinates']
    checks = audit(default, table)
    zero_effect = fetch(args.api + "/api/wp3/simulate", {"voucher_effect": 0})
    checks += audit(zero_effect, table)
    for run in zero_effect["runs"][1:]:
        assert run["legs"] == zero_effect["runs"][0]["legs"]
        assert [(q["accepted"], q["status"]) for q in run["quotes"]] == [(q["accepted"], q["status"]) for q in zero_effect["runs"][0]["quotes"]]
    zero_budget = fetch(args.api + "/api/wp3/simulate", {"budget_vnd": 0})
    checks += audit(zero_budget, table)
    for run in zero_budget["runs"][1:]:
        assert run == {**zero_budget["runs"][0], "policy": run["policy"]}
    scenario_bytes = json.dumps(default, ensure_ascii=False, indent=2).encode()
    (output / "scenario.json").write_bytes(scenario_bytes)
    browser = {}
    if args.browser_telemetry:
        browser["vehicle_positions_checked"] = audit_browser(default, json.loads(Path(args.browser_telemetry).read_text()))
        browser["ledger_and_policy_time"] = "PASS"
    if args.browser_export:
        assert default == json.loads(Path(args.browser_export).read_text())
        browser["export_equals_api"] = True
    report = {"status": "PASS", "config": default["config"], "anchors": len(default["anchors"]),
              "default_paths": len(default["paths"]), "audited_paths_across_scenarios": checks,
              "dispatch_assignments_checked": sum(e['kind'] == 'assigned' for data in [default, zero_effect, zero_budget] for run in data['runs'] for e in run['events']),
              "policy_runs_audited": 12, "same_seed_full_response_equal": True,
              "checks": ["OSRM table vs geometry duration/distance/endpoints", "direct OSRM segment annotations vs API", "nearest eligible idle driver accepts every assignment", "event ordering and lifecycle", "integer liability ledger and exact completion settlement", "vehicle continuity and no overlap", "CRN inputs", "zero-effect physical parity", "zero-budget full parity"],
              "scenario_sha256": hashlib.sha256(scenario_bytes).hexdigest(),
              "datasetFingerprint": default["datasetFingerprint"], "provenance": default["provenance"],
              "summaries": [{"policy": run["policy"], **run["summary"]} for run in default["runs"]],
              "browser": browser,
              "limitations": ["Synthetic demand/response; no causal, matched-spend or SOTA result", "No independent optimal-dispatch or traffic validation"]}
    (output / "integration-audit.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
