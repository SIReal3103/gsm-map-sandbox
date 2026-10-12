"""Real local OSRM paired experiments; writes only bounded evidence in this project."""
import json
import sys
from pathlib import Path
import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.app.voucher import arm_metrics, comparison, probability, BehaviorConfig
from backend.app.booking import ScenarioPlan
DEST = ROOT/'docs/evidence/a4'


def audit(e):
    assert e['baseline']['plan']['vehicles'] == e['treatment']['plan']['vehicles']
    by_id = {p['id']: p for p in e['potential']}
    assert len(by_id) == e['config']['potentialCount']
    for name in ['baseline', 'treatment']:
        arm = e[name]
        ScenarioPlan.model_validate(arm['plan'])
        assert len(arm['decisions']) == len(by_id)
        for d in arm['decisions']:
            p = by_id[d['potentialId']]
            if p['valid']:
                assert d['probability'] == probability(p['quotedFareVnd'], d['discountVnd'], BehaviorConfig(**e['config']['behavior']))
                assert d['accepted'] == (p['randomDraw'] < d['probability'])
                assert 0 <= d['discountVnd'] <= p['quotedFareVnd']
                assert d['discountVnd'] <= d['availableBeforeVnd'] if name == 'treatment' else d['discountVnd'] == 0
            else:
                assert p['quotedFareVnd'] is None and not d['accepted']
        assert sorted(d['potentialId'] for d in arm['decisions'] if d['accepted']) == sorted(b['id'] for b in arm['plan']['demand'])
        reserved, spent, last = {}, 0, -1
        for l in arm['ledger']:
            assert l['timestampSeconds'] >= last
            last = l['timestampSeconds']
            if l['type'] == 'RESERVED':
                assert l['bookingId'] not in reserved
                reserved[l['bookingId']] = l['amountVnd']
            if l['type'] in ['SETTLED', 'RELEASED']:
                assert reserved.pop(l['bookingId']) == l['amountVnd']
                outcome = 'TRIP_COMPLETED' if l['type'] == 'SETTLED' else 'BOOKING_UNSERVED'
                assert any(v['type'] == outcome and v['bookingId'] == l['bookingId'] and v['timestampSeconds'] == l['timestampSeconds'] for v in arm['plan']['events'])
                if l['type'] == 'SETTLED':
                    spent += l['amountVnd']
            assert sum(reserved.values()) == l['reserved'] and spent == l['spent']
            assert l['available'] == l['total']-spent-l['reserved'] >= 0
        assert not reserved
        final = arm_metrics(e['potential'], arm, e['config']['campaignBudget'] if name == 'treatment' else 0, e['simulationDurationSeconds'])
        assert final == e['final'][name]
        assert final['grossFareVnd'] == final['riderPaymentsVnd']+final['voucherSpendVnd']
    for b, t in zip(e['baseline']['decisions'], e['treatment']['decisions']):
        if b['valid']:
            assert t['probability'] >= b['probability'] and (not b['accepted'] or t['accepted'])
    assert comparison(e['final']['baseline'], e['final']['treatment']) == e['comparison']
    return {name: {k: e['final'][name][k] for k in ['validPotential','accepted','completed','unserved','grossFareVnd','riderPaymentsVnd','voucherSpendVnd','budget','voucherCounts']} for name in ['baseline','treatment']}


if __name__ == '__main__':
    DEST.mkdir(parents=True, exist_ok=True)
    cases = [('default', {}), ('repeat', {}), ('percentage', {'voucher': {'type': 'percentage'}}),
             ('zero', {'voucher': {'fixedAmount': 0}}), ('exhaustion', {'campaignBudget': 20000}),
             ('capacity', {'fleetSize': 1, 'preset': 'High', 'horizonSeconds': 60, 'maxWaitSeconds': 60, 'campaignBudget': 1000000}),
             ('no-increment', {'behavior': {'alpha': 20, 'beta': 0}, 'campaignBudget': 1000000}),
             ('stress', {'fleetSize': 10, 'potentialCount': 30})]
    summary, first = [], None
    with httpx.Client(base_url='http://127.0.0.1:8000', timeout=120, trust_env=False) as client:
        for name, config in cases:
            response = client.post('/api/voucher-experiment/prepare', json=config)
            response.raise_for_status()
            e = response.json()
            result = {'case': name, 'status': 'PASS', **audit(e), 'comparison': e['comparison'],
                      'durationSeconds': e['simulationDurationSeconds'], 'preparationMilliseconds': e['preparationMilliseconds'],
                      'routingRequests': e['routingRequests'], 'jsonBytes': len(response.content)}
            if name == 'default':
                first = e
            if name == 'repeat':
                for key in ['id','potential','final','comparison','timeSeries']:
                    assert e[key] == first[key]
                for arm in ['baseline','treatment']:
                    for key in ['demand','assignments','events','vehicles']:
                        assert e[arm]['plan'][key] == first[arm]['plan'][key]
                    assert e[arm]['decisions'] == first[arm]['decisions'] and e[arm]['ledger'] == first[arm]['ledger']
                result['determinism'] = 'PASS'
            if name == 'zero':
                for key in ['demand','assignments','events','vehicles']:
                    assert e['baseline']['plan'][key] == e['treatment']['plan'][key]
                for key in ['accepted','completed','grossFareVnd','riderPaymentsVnd','utilization']:
                    assert e['final']['baseline'][key] == e['final']['treatment'][key]
                result['zeroParity'] = 'PASS'
            if name == 'no-increment':
                assert e['comparison']['incrementalCompleted'] == 0 and e['final']['treatment']['voucherSpendVnd'] > 0
            (DEST/f'{name}.json').write_text(json.dumps(e, ensure_ascii=False), encoding='utf-8')
            summary.append(result)
            print(json.dumps(result))
    (DEST/'integration-summary.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
