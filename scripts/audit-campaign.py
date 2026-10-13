"""Reconcile integrated output using ledger arithmetic and external OSRM table."""
import argparse
import json
import math
from pathlib import Path
import urllib.request


def audit(result):
    assert result['version'] == 'wp3-integrated-campaign-v1'
    transport = result['model']['transport']
    coordinates = ';'.join(','.join(map(str,a['source_coordinate'])) for a in result['anchors'])
    url = 'http://127.0.0.1:5001/table/v1/driving/'+coordinates+'?annotations=duration,distance&radiuses='+';'.join(['100']*len(result['anchors']))
    with urllib.request.urlopen(url, timeout=30) as stream:
        table = json.load(stream)
    assert table['code'] == 'Ok'
    assert table['durations'] == transport['durations'] and table['distances'] == transport['distances']
    for a, b in zip(result['anchors'], table['sources']):
        assert a['coordinate'] == b['location']
    assignments, prefixes = 0, 0
    for run in result['runs']:
        quotes = {q['id']:q for q in run['quotes']}
        assert len(quotes) == result['config']['quotes']
        vehicles = {v['id']:{'position':v['initial'],'busy_until':0} for v in run['vehicles']}
        spent = reserved = 0
        requested = set()
        for e in run['events']:
            q = quotes[e['request_id']]
            amount = q['offer_vnd']
            if e['kind'] == 'offered':
                reserved += amount
            elif e['kind'] == 'accepted':
                assert q['id'] not in requested
                requested.add(q['id'])
                assert e['time'] == q['requested'] and q['arrival'] <= e['time'] <= q['offer_expires']
            elif e['kind'] in ('expired','rejected'):
                reserved -= amount
            elif e['kind'] == 'completed':
                reserved -= amount;spent += amount
                assert e['time'] == q['completed']
            elif e['kind'] == 'assigned':
                eligible = sorted((table['durations'][v['position']][q['origin']]*result['config']['traffic_factor'],vid)
                    for vid,v in vehicles.items() if v['busy_until'] <= e['time'] and
                    e['time']+table['durations'][v['position']][q['origin']]*result['config']['traffic_factor'] <= q['expires'])
                assert eligible and eligible[0][1] == q['vehicle_id']
                assert abs(q['pickup']-e['time']-eligible[0][0]) < 1e-8
                assert abs(q['completed']-q['pickup']-table['durations'][q['origin']][q['destination']]*result['config']['traffic_factor']) < 1e-8
                vehicles[q['vehicle_id']].update(position=q['destination'],busy_until=q['completed'])
                assignments += 1
            assert (spent,reserved) == (e['spent_vnd'],e['reserved_vnd'])
            assert 0 <= spent <= spent+reserved <= result['config']['budget_vnd']
            prefixes += 1
        assert reserved == 0 and spent == run['summary']['actual_spend_vnd']
        assert len(requested) == run['summary']['accepted'] == run['summary']['completed']+run['summary']['expired']
        for v in run['vehicles']:
            legs = [l for l in run['legs'] if l['vehicle_id']==v['id']]
            for left,right in zip(legs,legs[1:]):
                assert left['end'] <= right['start'] and left['destination'] == right['origin']
        for leg in run['legs']:
            path = result['paths'][leg['path_id']]
            assert len(path['segment_durations']) == len(path['coordinates'])-1
            assert path['coordinates'][0] == result['anchors'][leg['origin']]['coordinate']
            assert path['coordinates'][-1] == result['anchors'][leg['destination']]['coordinate']
            assert math.isclose(leg['end']-leg['start'],path['duration']*result['config']['traffic_factor'],abs_tol=1e-7)
        refunds = run['cost_events']
        assert run['summary']['mature_net_spend_vnd'] == spent+sum(e['amount_vnd'] for e in refunds)
        assert len(set(e['request_id'] for e in refunds)) == len(refunds)
        for e in refunds:
            q = quotes[e['request_id']]
            assert q['status']=='completed' and e['time']>q['completed'] and e['amount_vnd']==-q['offer_vnd']
    return {'status':'PASS','version':result['version'],'runs':len(result['runs']),
            'nearest_idle_assignments':assignments,'independent_ledger_prefixes':prefixes,
            'directed_osrm_pairs':len(result['anchors'])*(len(result['anchors'])-1)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('result',type=Path)
    args = parser.parse_args()
    print(json.dumps(audit(json.loads(args.result.read_text())),indent=2))
