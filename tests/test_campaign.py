"""Hand oracles for lifecycle, observed-state filtering and paired screening."""
from copy import deepcopy

import pytest

from backend.app import campaign
from backend.app.campaign import Campaign, DEFAULT_PLANNER, choose, remaining_request, screen, service

GRAPH = {'anchors': [{'coordinate': [106.69+i*.001, 10.77]} for i in range(3)],
         'durations': [[0,15,25], [60,0,30], [10,35,0]],
         'distances': [[0,150,250], [600,0,300], [100,350,0]]}
CONFIG = {'seed':'hand-oracle', 'fleet':2, 'quotes':3, 'minutes':5, 'budget_vnd':10000,
          'patience_seconds':90, 'traffic_factor':1., 'response_scale':1.}
QUOTE = {'id':'Q1', 'arrival':0., 'origin':0, 'destination':1, 'profile':{}}


class ControlledResponse:
    # Explicit test distribution, never used by API or product scenarios.
    data = {'timing':[1/12]*12, 'profiles':[], 'completion_cost':{'refund_probability':0., 'refund_delay_seconds':[86400]}}

    def candidates(self, row, eta, time=None):
        return [{'arm':'none','q':.5,'delta':0.,'liability':0},
                {'arm':'paid','q':1.,'delta':.5,'liability':5000}]


def world(monkeypatch, response=.2, timing=.5, **config):
    monkeypatch.setattr(campaign, 'draw', lambda seed,key: timing if 'timing:' in key else response)
    c = Campaign({**CONFIG, **config}, GRAPH, ControlledResponse(), 'actual')
    c.vehicles[0].update(position=1, initial=1)
    c.vehicles[1].update(position=2, initial=2)
    return c


def issue(c, quote=QUOTE, q=1., liability=5000):
    c.issue(quote, {'arm':'paid' if liability else 'none', 'q':q, 'delta':q-.5,
                    'liability':liability, 'quoted_eta':10})


def test_commitment_starts_at_offer_before_customer_request(monkeypatch):
    c = world(monkeypatch)
    issue(c)
    assert c.reserved == 5000 and not c.quotes['Q1']['accepted']
    c.advance(359)
    assert c.quotes['Q1']['status'] == 'pending' and c.reserved == 5000
    c.advance(360)
    q = c.quotes['Q1']
    assert q['accepted'] and q['requested'] == 360
    assert q['vehicle_id'] == 'V02' and q['pickup'] == 370 and q['completed'] == 385
    c.advance(385)
    assert c.spent == 5000 and c.reserved == 0


def test_unrequested_offer_releases_at_request_horizon(monkeypatch):
    c = world(monkeypatch, response=.99)
    issue(c, q=.5)
    c.advance(719)
    assert c.reserved == 5000
    c.advance(720)
    assert c.quotes['Q1']['status'] == 'rejected' and c.reserved == c.spent == 0


def test_timely_request_honors_offer_after_offer_expiry(monkeypatch):
    c = world(monkeypatch, timing=5/6)
    c.network = deepcopy(GRAPH)
    c.network['durations'][0][1] = 300
    issue(c)
    c.advance(720)
    assert c.quotes['Q1']['status'] == 'onboard' and c.reserved == 5000
    c.advance(910)
    assert c.quotes['Q1']['status'] == 'completed' and c.spent == 5000


def test_queue_patience_starts_at_request_and_busy_cars_cannot_accept(monkeypatch):
    c = world(monkeypatch)
    for v in c.vehicles:
        v['available'] = 1000
    issue(c)
    c.advance(360)
    assert c.quotes['Q1']['status'] == 'queued' and c.quotes['Q1']['expires'] == 450
    c.advance(450)
    assert c.quotes['Q1']['status'] == 'expired' and not c.legs and c.reserved == 0


def test_budget_reserves_even_customers_who_never_request(monkeypatch):
    c = world(monkeypatch, response=.99, budget_vnd=5000)
    issue(c, q=.5)
    assert [a['arm'] for a in c.feasible({**QUOTE,'id':'Q2'})] == ['none']
    before = c.observed()
    with pytest.raises(ValueError, match='liability invariant'):
        issue(c, {**QUOTE, 'id':'Q2'}, q=.5)
    assert c.observed() == before


def test_pending_posterior_does_not_restart_probability_or_timing():
    mass = [1/12]*12
    # After six silent minutes: remaining request=.5*.5/(1-.5*.5)=1/3.
    assert remaining_request(.5, mass, 360, .34, .5) is None
    assert remaining_request(.5, mass, 360, .32, .5) == pytest.approx(540)
    assert remaining_request(.5, mass, 720, 0., .5) is None
    with pytest.raises(ValueError, match='zero conditional support'):
        remaining_request(1., mass, 720, 0., .5)


def test_execution_clock_cannot_rewind_or_accept_nan(monkeypatch):
    c = world(monkeypatch)
    c.advance(100)
    before = c.observed()
    for invalid in (99, float('nan'), float('inf')):
        with pytest.raises(ValueError, match='clock'):
            c.advance(invalid)
        assert c.observed() == before


def test_snapshot_excludes_evaluator_heap_and_branch_isolation(monkeypatch):
    c = world(monkeypatch)
    issue(c)
    c.advance(100)
    snapshot = c.observed()
    assert 'heap' not in snapshot and 'namespace' not in snapshot
    assert 'requested' not in snapshot['quotes']['Q1']
    before = deepcopy(snapshot)
    branch = c.fork(snapshot, 'planning')
    branch.vehicles[0]['position'] = 0
    branch.quotes['Q1']['offer_vnd'] = 0
    assert c.observed() == before and snapshot == before
    # Hidden scheduled request differs; observed-state fork remains identical.
    c.heap = []
    assert c.fork(c.observed(), 'planning').heap == c.fork(before, 'planning').heap


def test_continuation_cannot_call_rollout(monkeypatch):
    c = world(monkeypatch)
    monkeypatch.setattr(c, 'rank', lambda *args: (_ for _ in ()).throw(AssertionError('recursive rollout')))
    c.continuation([QUOTE])
    assert c.outcomes()['completed'] == 1


def test_service_counts_are_pooled_and_small_samples_do_not_pass():
    value = service([{'requested':1,'completed':0,'unserved':1,'cancelled':0,'waits':[]},
                     {'requested':9,'completed':9,'unserved':0,'cancelled':0,'waits':[10]*9}])
    assert value['unserved'] == .1  # Not mean of per-world rates (.5).
    assert not screen(value, value, CONFIG, DEFAULT_PLANNER)['passed']


def test_screen_rejects_relative_harm_and_absolute_baseline_violation():
    base = {'requests':100,'pickups':80,'unserved':.1,'cancelled':0.,'wait_p95':40.}
    assert screen(base,base,CONFIG,DEFAULT_PLANNER)['passed']
    assert not screen({**base,'unserved':.12},base,CONFIG,DEFAULT_PLANNER)['passed']
    assert not screen({**base,'wait_p95':43},base,CONFIG,DEFAULT_PLANNER)['passed']
    bad = {**base,'unserved':.3}
    assert not screen(bad,bad,CONFIG,DEFAULT_PLANNER)['passed']


def test_scores_tie_by_liability_then_stable_offer_id():
    actions = [{'arm':'B','gain':1.,'liability':5000}, {'arm':'A','gain':.99,'liability':5000},
               {'arm':'C','gain':.98,'liability':3000}]
    assert choose(actions,'gain',.021)['arm'] == 'C'
    assert choose(actions[:2],'gain',.02)['arm'] == 'A'
    assert choose([{'arm':'A','gain':.02,'liability':1}], 'gain', .02) is None


def test_same_rollout_screening_and_no_evaluator_scale_leak(monkeypatch):
    c = world(monkeypatch, quotes=1)
    c.planner.update(draws=4, minimum_requests=1, minimum_pickups=1)
    _, response = c.rank(QUOTE, 'response')
    _, fleet = c.rank(QUOTE, 'state_aware')
    assert response['candidates'] == fleet['candidates'] and response['baseline'] == fleet['baseline']
    c.config['response_scale'] = 0
    _, altered = c.rank(QUOTE, 'state_aware')
    assert altered == fleet


def test_campaign_api_has_explicit_response_contract_and_no_fake_missing_data(tmp_path):
    from fastapi.testclient import TestClient
    from backend.app.config import Settings
    from backend.app.main import create_app
    client = TestClient(create_app(Settings(osm_pbf_path=str(tmp_path/'missing.osm.pbf'))))
    assert client.post('/api/wp3/campaign',json={'response_scale':1.6}).status_code == 422
    assert client.post('/api/wp3/campaign',json={'voucher_effect':.25}).status_code == 422
    assert client.post('/api/wp3/campaign',json={'fleet':True}).status_code == 422
    result = client.post('/api/wp3/campaign',json={})
    assert result.status_code == 503 and result.json()['error']['code']=='DATASET_NOT_READY'
