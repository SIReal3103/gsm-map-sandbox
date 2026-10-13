"""Small synthetic road matrix tests business invariants, not OSM correctness."""
from copy import deepcopy
import pytest
from backend.app.simulation import POLICIES, simulate, scenario, validate_network

CONFIG = dict(seed="ledger-test", fleet=2, quotes=80, minutes=5, budget_vnd=30000, patience_seconds=90, traffic_factor=1.4, voucher_effect=.25)
NETWORK = {"anchors": [{"coordinate": [106.69 + i*.001, 10.77]} for i in range(4)],
           "durations": [[0 if i == j else 45 + 15*abs(i-j) for j in range(4)] for i in range(4)],
           "distances": [[0 if i == j else 400 + 100*abs(i-j) for j in range(4)] for i in range(4)]}


@pytest.mark.parametrize("policy", POLICIES)
def test_ledger_capacity_and_expiry(policy):
    run = simulate(CONFIG, NETWORK, policy)
    assert all(0 <= e["spent_vnd"] <= e["spent_vnd"] + e["reserved_vnd"] <= CONFIG["budget_vnd"] for e in run["events"])
    assert run["summary"]["reserved_vnd"] == 0
    assert run["summary"]["actual_spend_vnd"] == sum(q["offer_vnd"] for q in run["quotes"] if q["status"] == "completed")
    assert run["summary"]["accepted"] == run["summary"]["completed"] + run["summary"]["expired"]
    assert run["summary"]["expired"] > 0  # Capacity pressure actually exercised.
    spent, reserved = 0, 0
    by_id = {q["id"]: q for q in run["quotes"]}
    for event in run["events"]:
        amount = by_id[event["request_id"]]["offer_vnd"]
        if event["kind"] == "accepted": reserved += amount
        elif event["kind"] == "expired": reserved -= amount
        elif event["kind"] == "completed": reserved -= amount; spent += amount
        assert (spent, reserved) == (event["spent_vnd"], event["reserved_vnd"])
    for vehicle in run["vehicles"]:
        legs = [l for l in run["legs"] if l["vehicle_id"] == vehicle["id"]]
        for a, b in zip(legs, legs[1:]):
            assert a["end"] <= b["start"]
            assert a["destination"] == b["origin"]
        if legs:
            assert legs[0]["origin"] == vehicle["initial"]
    for q in run["quotes"]:
        if q["status"] == "completed":
            assert q["arrival"] <= q["assigned"] <= q["pickup"] <= q["expires"]
            assert q["pickup"] < q["completed"]
        if q["status"] == "expired":
            assert not any(l["request_id"] == q["id"] for l in run["legs"])


def test_reproducibility_and_common_draws():
    assert simulate(CONFIG, NETWORK, "state_aware") == simulate(CONFIG, NETWORK, "state_aware")
    inputs, _ = scenario(CONFIG, len(NETWORK["anchors"]))
    for policy in POLICIES:
        run = simulate(CONFIG, NETWORK, policy)
        assert [(q["id"], q["draw"], q["origin"], q["arrival"]) for q in inputs] == [(q["id"], q["draw"], q["origin"], q["arrival"]) for q in run["quotes"]]


def test_zero_effect_identical_physical_outcomes():
    config = {**CONFIG, "voucher_effect": 0}
    baseline = simulate(config, NETWORK, "no_offer")
    for policy in POLICIES:
        run = simulate(config, NETWORK, policy)
        assert run["legs"] == baseline["legs"]
        assert [(q["accepted"], q["status"], q.get("pickup")) for q in run["quotes"]] == [(q["accepted"], q["status"], q.get("pickup")) for q in baseline["quotes"]]


def test_zero_budget_collapses_to_no_offer():
    config = {**CONFIG, "budget_vnd": 0}
    baseline = simulate(config, NETWORK, "no_offer")
    assert all(simulate(config, NETWORK, policy) == {**baseline, "policy": policy} for policy in POLICIES)


def test_disconnected_network_never_falls_back():
    invalid = deepcopy(NETWORK)
    invalid["durations"][1][2] = None
    with pytest.raises(ValueError, match="Disconnected"):
        validate_network(invalid)


def test_wp3_api_validation_and_missing_data(tmp_path):
    from fastapi.testclient import TestClient
    from backend.app.config import Settings
    from backend.app.main import create_app
    client = TestClient(create_app(Settings(osm_pbf_path=str(tmp_path / "absent.osm.pbf"))))
    assert client.post('/api/wp3/simulate', json={"fleet": 21}).json()["error"]["code"] == "INVALID_SCENARIO"
    assert client.post('/api/wp3/simulate', json={"fleet": True}).status_code == 422
    response = client.post('/api/wp3/simulate', json={})
    assert response.status_code == 503 and response.json()["error"]["code"] == "DATASET_NOT_READY"


@pytest.fixture
def dispatch_world(monkeypatch):
    # Controlled customer bookings and a hand-calculated directed travel matrix.
    # This verifies dispatch mechanics, not demand or real-world driver compliance.
    from backend.app import simulation
    quotes = [{"id": "Q1", "arrival": 0, "origin": 0, "destination": 1, "draw": 0}]
    monkeypatch.setattr(simulation, 'scenario', lambda config, count: (deepcopy(quotes), [1, 2]))
    graph = {'anchors': [{'coordinate': [106.69, 10.77]},
                         {'coordinate': [106.6901, 10.77]},
                         {'coordinate': [106.71, 10.77]}],
             'durations': [[0, 15, 25], [60, 0, 30], [10, 35, 0]],
             'distances': [[0, 150, 250], [600, 0, 300], [100, 350, 0]]}
    config = {**CONFIG, 'fleet': 2, 'quotes': 1, 'patience_seconds': 90, 'traffic_factor': 1}
    return quotes, graph, config


def test_nearest_idle_driver_always_accepts_by_road_eta(dispatch_world):
    _, graph, config = dispatch_world
    run = simulate(config, graph, 'no_offer')
    quote = run['quotes'][0]
    # V01 is geometrically closer, but V02 has the shortest road pickup time.
    assert quote['accepted'] is True
    assert quote['vehicle_id'] == 'V02'
    assert (quote['assigned'], quote['pickup'], quote['completed']) == (0, 10, 25)
    assert [e['kind'] for e in run['events']] == ['accepted', 'assigned', 'pickup', 'completed']


def test_busy_closest_driver_does_not_receive_a_second_booking(dispatch_world):
    quotes, graph, config = dispatch_world
    quotes.append({**quotes[0], 'id': 'Q2', 'arrival': .001})
    run = simulate({**config, 'quotes': 2}, graph, 'no_offer')
    assert [q['vehicle_id'] for q in run['quotes']] == ['V02', 'V01']
    assert run['quotes'][1]['assigned'] == .001
    assert run['quotes'][1]['pickup'] == pytest.approx(60.001)
    assert run['summary']['completed'] == 2


def test_equal_pickup_eta_uses_stable_driver_id(dispatch_world):
    _, graph, config = dispatch_world
    graph['durations'][2][0] = 60
    run = simulate(config, graph, 'no_offer')
    assert run['quotes'][0]['vehicle_id'] == 'V01'


def test_driver_acceptance_does_not_guarantee_feasible_supply(dispatch_world):
    _, graph, config = dispatch_world
    graph['durations'][1][0] = graph['durations'][2][0] = 100
    run = simulate({**config, 'patience_seconds': 30}, graph, 'no_offer')
    quote = run['quotes'][0]
    assert quote['accepted'] is True  # Customer booked.
    assert quote['status'] == 'expired' and 'vehicle_id' not in quote
    assert not run['legs']
    assert [e['kind'] for e in run['events']] == ['accepted', 'expired']
