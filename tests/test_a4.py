"""Math/accounting fixtures are synthetic only; real OSRM integration is opt-in."""
import asyncio
import copy
import os
import math
from decimal import Decimal

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend.app.voucher import (ExperimentRequest, FareConfig, BehaviorConfig, VoucherConfig,
    money, fare_quote, sigmoid, probability, stable_draw, discount_for, BudgetLedger,
    prepare_experiment, arm_metrics, comparison)
from backend.app.booking import InitialVehicle
from backend.app.main import create_app
from backend.app.config import Settings
from test_a3 import CATALOG, FixtureTravel, demand


@pytest.mark.parametrize('z', [-100000, -1000, -20, 0, 20, 1000, 100000])
def test_stable_sigmoid(z):
    assert 0 <= sigmoid(z) <= 1
    assert sigmoid(z) == pytest.approx(1-sigmoid(-z))


def test_monotonic_price_discount_and_reference():
    b = BehaviorConfig()
    values = [probability(f, 0, b) for f in range(0, 100001, 1000)]
    assert values == sorted(values, reverse=True)
    discounts = [probability(100000, d, b) for d in range(0, 100001, 1000)]
    assert discounts == sorted(discounts)
    assert probability(100000, 0, BehaviorConfig(beta=0)) == probability(1, 0, BehaviorConfig(beta=0))
    with pytest.raises(ValueError):
        probability(10, 11, b)


def test_currency_half_up_fare_uses_osrm_distance():
    assert money(Decimal('2.5')) == 3 and money(Decimal('2.49')) == 2
    assert fare_quote(2500, FareConfig()) == 40000
    assert fare_quote(50, FareConfig(baseFare=0, perKm=10)) == 1
    with pytest.raises(ValueError):
        fare_quote(math.nan, FareConfig())


def test_discount_caps_minimum_and_rounding():
    assert discount_for(1000, VoucherConfig(fixedAmount=2000)) == 1000
    assert discount_for(1000, VoucherConfig(minimumFare=1001)) == 0
    assert discount_for(100001, VoucherConfig(type='percentage', rate=.3, cap=20000)) == 20000
    assert discount_for(15, VoucherConfig(type='percentage', rate=.5)) == 8
    assert discount_for(1000, VoucherConfig(fixedAmount=0)) == 0


def test_draw_independent_identity_arm_and_call_order():
    a = stable_draw('seed', 'graph', 'P1')
    stable_draw('other', 'graph', 'P2')
    assert a == stable_draw('seed', 'graph', 'P1') and 0 <= a < 1
    assert a != stable_draw('seed', 'graph', 'P2')


def test_default_and_explicit_config_have_canonical_fingerprint_inputs():
    default = ExperimentRequest()
    explicit = ExperimentRequest.model_validate(default.model_dump())
    assert default.model_dump_json() == explicit.model_dump_json()
    assert isinstance(default.behavior.beta, float)


@pytest.mark.parametrize('body', [{'fare': {'baseFare': -1}}, {'fare': {'perKm': True}},
    {'behavior': {'alpha': float('inf')}}, {'behavior': {'beta': -1}}, {'behavior': {'referenceFare': 0}},
    {'voucher': {'rate': 1.1}}, {'voucher': {'cap': -1}}, {'campaignBudget': -1},
    {'potentialCount': 31}, {'potentialCount': 9}, {'fleetSize': 0}, {'routerUrl': 'https://router.example'}])
def test_invalid_config(body):
    with pytest.raises(ValidationError):
        ExperimentRequest.model_validate(body)


def test_api_errors_and_readiness(tmp_path):
    c = TestClient(create_app(Settings(osm_pbf_path=str(tmp_path/'missing.osm.pbf'))))
    assert c.post('/api/voucher-experiment/prepare', json={}).json()['error']['code'] == 'DATASET_NOT_READY'
    assert c.post('/api/voucher-experiment/prepare', json={'campaignBudget': -1}).json()['error']['code'] == 'INVALID_EXPERIMENT_CONFIG'


def test_ledger_offered_reserve_settle_release_once():
    l = BudgetLedger(100)
    l.transact('OFFERED', 0, 'B1', 30)
    assert l.snapshot() == {'total': 100, 'reserved': 0, 'spent': 0, 'available': 100}
    l.transact('RESERVED', 0, 'B1', 30)
    l.transact('RESERVED', 1, 'B2', 50)
    l.transact('RELEASED', 2, 'B2', 50)
    assert l.available == 70
    l.transact('SETTLED', 3, 'B1', 30)
    assert l.reserved == 0 and l.spent == 30
    for kind in ['SETTLED', 'RELEASED', 'RESERVED']:
        with pytest.raises(ValueError):
            l.transact(kind, 4, 'B1', 30)
    with pytest.raises(ValueError):
        l.transact('RESERVED', 4, 'B3', 71)


def experiment(monkeypatch, inputs=None, **config):
    if inputs is not None:
        monkeypatch.setattr('backend.app.voucher.demand_inputs', lambda *_: (
            [InitialVehicle(id='GSM-01', candidateId='fixture', initialPosition=(0, 0))], inputs))
    return asyncio.run(prepare_experiment(CATALOG, ExperimentRequest(**config), FixtureTravel()))


@pytest.mark.parametrize('control', [{'voucher': {'fixedAmount': 0}}, {'campaignBudget': 0},
    {'voucher': {'type': 'percentage', 'rate': 0}}, {'voucher': {'minimumFare': 1000000}}])
def test_zero_discount_exact_semantic_parity(monkeypatch, control):
    e = experiment(monkeypatch, **control)
    assert e['baseline']['decisions'] == e['treatment']['decisions'] or all(
        (a['accepted'], a['probability'], a['discountVnd']) == (b['accepted'], b['probability'], b['discountVnd'])
        for a, b in zip(e['baseline']['decisions'], e['treatment']['decisions']))
    for key in ['demand', 'vehicles', 'assignments', 'events']:
        assert e['baseline']['plan'][key] == e['treatment']['plan'][key]
    assert not e['treatment']['ledger'] and e['final']['treatment']['voucherSpendVnd'] == 0
    for key in ['accepted', 'completed', 'grossFareVnd', 'riderPaymentsVnd', 'utilization']:
        assert e['final']['baseline'][key] == e['final']['treatment'][key]


def test_rejected_offer_does_not_reserve(monkeypatch):
    monkeypatch.setattr('backend.app.voucher.stable_draw', lambda *_: .999)
    e = experiment(monkeypatch, behavior={'alpha': -20, 'beta': 0})
    assert not e['treatment']['plan']['demand'] and not e['baseline']['plan']['events']
    assert all(l['type'] == 'OFFERED' and l['reserved'] == l['spent'] == 0 for l in e['treatment']['ledger'])
    assert e['final']['baseline']['completionRate'] is None


def test_release_before_same_time_arrival_settlement_and_no_retroactive_discount(monkeypatch):
    inputs = [demand('B1', 0), demand('B2', 5), demand('B3', 15), demand('B4', 50)]
    monkeypatch.setattr('backend.app.voucher.stable_draw', lambda *_: 0)
    e = experiment(monkeypatch, inputs, fleetSize=1, maxWaitSeconds=10, horizonSeconds=60,
        fare={'baseFare': 100, 'perKm': 0}, voucher={'fixedAmount': 20}, campaignBudget=40)
    events = e['treatment']['ledger']
    at15 = [v for v in events if v['timestampSeconds'] == 15]
    assert [v['type'] for v in at15] == ['RELEASED', 'OFFERED', 'RESERVED']
    at50 = [v for v in events if v['timestampSeconds'] == 50]
    assert at50[0]['type'] == 'SETTLED'
    assert e['final']['treatment']['voucherCounts']['RELEASED'] == 2
    assert e['final']['treatment']['voucherSpendVnd'] == 40
    assert all(v['available'] >= 0 and v['reserved']+v['spent'] <= 40 for v in events)
    # Low budget: B2 accepts at full fare; later release must not upgrade its decision.
    low = experiment(monkeypatch, inputs, fleetSize=1, maxWaitSeconds=10, horizonSeconds=60,
        fare={'baseFare': 100, 'perKm': 0}, voucher={'fixedAmount': 20}, campaignBudget=20)
    d2 = next(d for d in low['treatment']['decisions'] if d['potentialId'] == 'B2')
    assert d2['accepted'] and d2['discountVnd'] == 0 and d2['reason'] == 'BUDGET_UNAVAILABLE'


def test_same_seed_fair_inputs_and_no_forced_completion(monkeypatch):
    e = experiment(monkeypatch)
    repeat = experiment(monkeypatch)
    for key in ['id', 'potential', 'final', 'comparison', 'timeSeries']:
        assert e[key] == repeat[key]
    assert e['baseline']['plan']['vehicles'] == e['treatment']['plan']['vehicles']
    for b, t in zip(e['baseline']['decisions'], e['treatment']['decisions']):
        assert t['probability'] >= b['probability']
        assert not b['accepted'] or t['accepted']
    # Certain acceptance in both worlds can spend subsidy without any incremental completion.
    monkeypatch.setattr('backend.app.voucher.stable_draw', lambda *_: 0)
    both = experiment(monkeypatch)
    assert both['comparison']['incrementalCompleted'] == 0
    assert both['final']['treatment']['voucherSpendVnd'] > 0
    assert both['comparison']['costPerIncrementalCompletionVnd'] is None


def test_invalid_quote_and_global_router_failure(monkeypatch):
    class Invalid(FixtureTravel):
        async def route(self, *args):
            raise HTTPException(422, {'code': 'NOROUTE'})
    e = asyncio.run(prepare_experiment(CATALOG, ExperimentRequest(), Invalid()))
    assert all(not p['valid'] and p['quotedFareVnd'] is None for p in e['potential'])
    assert e['final']['treatment']['conversionRate'] is None and not e['treatment']['plan']['demand']
    class Outage(FixtureTravel):
        async def route(self, *args):
            raise HTTPException(503, {'code': 'ROUTER_UNAVAILABLE'})
    with pytest.raises(HTTPException):
        asyncio.run(prepare_experiment(CATALOG, ExperimentRequest(), Outage()))


def test_observed_financial_identity_seek_and_denominators(monkeypatch):
    e = experiment(monkeypatch)
    original = copy.deepcopy(e)
    for t in [0, 100, e['simulationDurationSeconds'], 0]:
        for arm in ['baseline', 'treatment']:
            m = arm_metrics(e['potential'], e[arm], e['config']['campaignBudget'] if arm == 'treatment' else 0, t)
            assert m['grossFareVnd'] == m['riderPaymentsVnd']+m['voucherSpendVnd']
            assert m['budget']['available'] >= 0
            if t == 0:
                assert m['utilization'] is None
            if m['accepted']:
                assert m['completionRate'] == m['completed']/m['accepted']
    assert e == original
    assert comparison({'completed': 3, 'accepted': 4}, {'completed': 2, 'accepted': 5, 'voucherSpendVnd': 100})['costPerIncrementalCompletionVnd'] is None


@pytest.mark.skipif(os.environ.get('RUN_REAL_DATA') != '1', reason='Requires real local dataset/OSRM')
def test_real_osrm_paired_prepare():
    r = TestClient(create_app()).post('/api/voucher-experiment/prepare', json={})
    assert r.status_code == 200, r.text
    e = r.json()
    assert e['baseline']['plan']['vehicles'] == e['treatment']['plan']['vehicles']
    assert e['final']['baseline']['completed'] > 0 and e['final']['treatment']['completed'] > 0
    for arm in ['baseline', 'treatment']:
        for a in e[arm]['plan']['assignments']:
            assert len(a['tripRoute']['coordinates']) >= 2 and a['tripRoute']['distance'] > 0
        assert e['final'][arm]['grossFareVnd'] == e['final'][arm]['riderPaymentsVnd']+e['final'][arm]['voucherSpendVnd']
