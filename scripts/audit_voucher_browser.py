"""Audit saved browser DOM against actual local OSRM plans, without opening a browser."""
import csv
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.app.voucher import arm_metrics, comparison
from audit_booking_positions import project

DEST = ROOT / 'docs/evidence/a4'


def close(actual, expected, path=''):
    if isinstance(expected, dict):
        assert actual.keys() == expected.keys(), path
        for key in expected:
            close(actual[key], expected[key], path+'.'+key)
    elif isinstance(expected, (int, float)):
        assert actual is not None and abs(actual-expected) < 1e-8, (path, actual, expected)
    else:
        assert actual == expected, (path, actual, expected)


def main():
    qa = json.loads((DEST/'browser-qa.json').read_text(encoding='utf-8'))
    plans = {name: json.loads((DEST/f'{name}.json').read_text(encoding='utf-8'))
             for name in {'default', 'stress', 'capacity', 'percentage', 'zero', 'regenerated'}}
    positions, snapshots, largest = 0, 0, 0
    for s in qa['samples']:
        e = plans[s['planCase']]
        if s.get('telemetrySelectorInvalid'):
            continue  # Incorrect audit selector recorded explicitly, never accepted as proof.
        assert s['canvasCount'] == 1 and s['scrollWidth'] <= s['width']
        assert len(s['markers']) == e['config']['fleetSize']
        expected, _ = project(e[s['arm']]['plan'], s['time'])
        for m in s['markers']:
            want = expected[m['id']]
            error = math.hypot(*(m['coordinate'][i]-want['coordinate'][i] for i in (0,1)))
            largest = max(largest, error)
            assert error < 1e-10 and m['status'] == want['status'], (s['label'],m,want)
            assert abs(m['progress']-want['progress']) < 1e-10
            positions += 1
        metrics = {a: arm_metrics(e['potential'],e[a],e['config']['campaignBudget'] if a=='treatment' else 0,s['kpiTime'])
                   for a in ['baseline','treatment']}
        close(s['metrics'], metrics, s['label'])
        close(s['delta'], comparison(metrics['baseline'],metrics['treatment']))
        snapshots += 1
    exported = json.loads((DEST/'browser-export.json').read_text(encoding='utf-8'))
    for key in ['id','potential','final','comparison','timeSeries']:
        assert exported[key] == plans['default'][key]
    tables = {}
    for name in ['summary','decisions','bookings','ledger','series']:
        path = DEST/f'browser-{name}.csv'
        assert path.read_bytes().startswith(b'\xef\xbb\xbf')
        with path.open(encoding='utf-8-sig',newline='') as f:
            tables[name] = list(csv.DictReader(f))
    assert len(tables['decisions']) == 2*len(exported['potential'])
    for row in tables['decisions']:
        d = next(d for d in exported[row['arm']]['decisions'] if d['potentialId']==row['potential_id'])
        assert int(row['discount_vnd']) == d['discountVnd']
        assert row['accepted'] == str(d['accepted']).lower()
    for row in tables['summary']:
        expected = exported['comparison'][row['metric']] if row['arm']=='delta' else exported['final'][row['arm']][row['metric']]
        assert row['value']=='' if expected is None else math.isclose(float(row['value']),expected,abs_tol=1e-8)
    assert len(tables['bookings']) == sum(len(exported[a]['plan']['demand']) for a in ['baseline','treatment'])
    for row in tables['bookings']:
        assignment = next((a for a in exported[row['arm']]['plan']['assignments'] if a['bookingId']==row['booking_id']),None)
        assert row['status_final'] == ('completed' if assignment else 'unserved')
        if assignment:
            close(float(row['trip_meters']),assignment['tripRoute']['distance'])
            close(float(row['dropoff_seconds']),assignment['dropoffAtSeconds'])
    assert len(tables['ledger']) == sum(len(exported[a]['ledger']) for a in ['baseline','treatment'])
    for row in tables['ledger']:
        event = next(l for l in exported[row['arm']]['ledger'] if l['id']==row['event_id'])
        for column,key in [('amount_vnd','amountVnd'),('reserved_vnd','reserved'),('spent_vnd','spent'),('available_vnd','available')]:
            close(int(row[column]),event[key])
    assert len(tables['series']) == 2*len(exported['timeSeries'])
    for row in tables['series']:
        metric = next(s[row['arm']] for s in exported['timeSeries'] if s['timeSeconds']==float(row['time_seconds']))
        for column,key in [('accepted','accepted'),('completed','completed'),('gross_fare_vnd','grossFareVnd'),('rider_payments_vnd','riderPaymentsVnd'),('spent_vnd','voucherSpendVnd')]:
            close(float(row[column]),metric[key])
    external = [r for r in qa['resources'] if not r['name'].startswith(('http://127.0.0.1:','blob:http://127.0.0.1:','data:'))]
    assert not external, external
    result = {'status':'PASS','vehicleProjections':positions,'metricSnapshots':snapshots,'maxCoordinateErrorDegrees':largest,
              'csvRows':{k:len(v) for k,v in tables.items()},'externalResourceRequests':external,
              'note':'Positions independently calculated in Python over full OSRM geometry; KPI cross-check against backend; real UI downloads.'}
    (DEST/'browser-audit.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
