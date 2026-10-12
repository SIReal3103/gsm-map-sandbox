"""Audit saved A4.1 browser evidence; optionally reproduce two local OSRM plans.

Does not automate the browser or modify map/routing artifacts. Run browser QA first.
"""
import argparse
import json
import math
import sys
from pathlib import Path
from urllib.parse import urlsplit

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.app.voucher import arm_metrics, comparison
from audit_booking_positions import project
from audit_voucher_browser import close

DEST = ROOT / 'docs/evidence/a4.1'


def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepare-evidence', action='store_true', help='Reproduce ten/zero plans via local backend; requires OSRM')
    args = parser.parse_args()
    if args.prepare_evidence:
        with httpx.Client(base_url='http://127.0.0.1:8000', timeout=120) as client:
            for name, config in [('ten', {'seed': 'hcm-a41-ten', 'fleetSize': 10}),
                                 ('zero-budget', {'seed': 'hcm-a41-zero', 'campaignBudget': 0})]:
                response = client.post('/api/voucher-experiment/prepare', json=config)
                response.raise_for_status()
                (DEST / f'{name}.json').write_text(json.dumps(response.json(), ensure_ascii=False, indent=2), encoding='utf-8')
    plans = [read(ROOT / 'docs/evidence/a4/default.json')]
    plans += [read(DEST / f'{name}.json') for name in ['ten', 'zero-budget']]
    by_id = {e['id']: e for e in plans}
    qa = read(DEST / 'browser-qa.json')
    layout_samples = metric_samples = positions = 0
    maximum_position_error = 0
    for state in qa:
        assert state['canvases'] == 1, state['name']
        viewport, document = state['viewport'], state['document']
        assert document['width'] <= viewport['width'] + 1 and document['height'] <= viewport['height'] + 1, state['name']
        if viewport['width'] >= 900 and state['analytics'] and state['analytics']['width'] > 0:
            for key in ['map', 'analytics', 'dock']:
                rect = state[key]
                assert rect['width'] > 0 and rect['height'] > 0
                assert rect['left'] >= -1 and rect['top'] >= -1
                assert rect['right'] <= viewport['width'] + 1 and rect['bottom'] <= viewport['height'] + 1, (state['name'], key)
            layout_samples += 1
        dashboard = state['dashboard']
        experiment = by_id.get(dashboard.get('experimentId'))
        if experiment is None:
            continue  # Other modes/loading states have no A4 metrics to audit.
        time = float(dashboard['kpiTime'])
        expected = {arm: arm_metrics(experiment['potential'], experiment[arm],
                    experiment['config']['campaignBudget'] if arm == 'treatment' else 0, time)
                    for arm in ['baseline', 'treatment']}
        close(json.loads(dashboard['experimentMetrics']), expected, state['name'])
        close(json.loads(dashboard['experimentDelta']), comparison(expected['baseline'], expected['treatment']))
        arm, timestamp = state['clock']['experimentArm'], float(state['clock']['experimentTime'])
        projected, _ = project(experiment[arm]['plan'], timestamp)
        assert len(state['vehicles']) == len(projected)
        for marker in state['vehicles']:
            want = projected[marker['dispatchVehicle']]
            error = math.hypot(*(json.loads(marker['coordinate'])[i] - want['coordinate'][i] for i in (0, 1)))
            maximum_position_error = max(maximum_position_error, error)
            assert error < 1e-10 and marker['status'] == want['status']
            assert abs(float(marker['progress']) - want['progress']) < 1e-10
            positions += 1
        metric_samples += 1
    before, after = read(DEST / 'integrity-before.json'), read(DEST / 'integrity-after.json')
    assert before == after
    resources = read(DEST / 'network.json')
    external = sorted({r['name'] for r in resources if urlsplit(r['name']).scheme in ['http', 'https']
                       and urlsplit(r['name']).hostname not in ['127.0.0.1', 'localhost']})
    assert not external, external
    result = dict(status='PASS', browser_states=len(qa), desktop_layout_samples=layout_samples,
                  metric_samples=metric_samples, marker_projections=positions,
                  maximum_position_error_degrees=maximum_position_error,
                  protected_artifacts=len(before), resource_entries=len(resources), external_requests=external)
    (DEST / 'audit.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
