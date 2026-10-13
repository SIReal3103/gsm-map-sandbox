"""Independent routing/ledger audit for versioned sampled/conditional Dev runs."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import urllib.request


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def audit(folder, network_path):
    index = json.loads((folder/'development-summary.json').read_text())
    inventory = index['inventory']
    assert sha(network_path) == inventory['network_sha256'], 'Network source drift'
    network = json.loads(network_path.read_text())
    coordinates = ';'.join(','.join(map(str, anchor['source_coordinate'])) for anchor in network['anchors'])
    url = 'http://127.0.0.1:5001/table/v1/driving/'+coordinates+'?annotations=duration,distance&radiuses='+';'.join(['100']*len(network['anchors']))
    with urllib.request.urlopen(url, timeout=30) as stream:
        table = json.load(stream)
    assert table['code'] == 'Ok'
    assert table['durations'] == network['durations'] and table['distances'] == network['distances']
    for anchor, source in zip(network['anchors'], table['sources']):
        assert anchor['coordinate'] == source['location']
    tasks = {(label, method, policy): config for label, method, policy, config in inventory['tasks']}
    assignments = prefixes = completions = 0
    for recorded in index['runs']:
        raw = folder/recorded['raw_file']
        assert sha(raw) == recorded['sha256'], 'Raw run checksum mismatch'
        run = json.loads(raw.read_text())
        config = tasks[recorded['workload'], recorded['method'], recorded['policy']]
        quotes = {quote['id']: quote for quote in run['quotes']}
        assert len(quotes) == config['quotes']
        vehicles = {vehicle['id']: {'position': vehicle['initial'], 'available': 0.}
                    for vehicle in run['vehicles']}
        spent = reserved = 0
        requested, finished, expired = set(), set(), set()
        previous_time = -math.inf
        for event in run['events']:
            time = event['time']
            assert time >= previous_time
            previous_time = time
            quote = quotes[event['request_id']]
            amount = quote['offer_vnd']
            assert type(amount) is int and amount >= 0
            kind = event['kind']
            if kind == 'offered':
                reserved += amount
            elif kind == 'accepted':
                assert quote['id'] not in requested
                requested.add(quote['id'])
                assert time == quote['requested'] and quote['arrival'] <= time <= quote['offer_expires']
            elif kind in ('expired', 'rejected'):
                reserved -= amount
                if kind == 'expired':
                    expired.add(quote['id'])
            elif kind == 'completed':
                assert quote['id'] not in finished and quote['id'] in requested
                finished.add(quote['id'])
                reserved -= amount
                spent += amount
                assert time == quote['completed']
            elif kind == 'assigned':
                candidates = sorted((table['durations'][vehicle['position']][quote['origin']]*config['traffic_factor'], key)
                    for key, vehicle in vehicles.items() if vehicle['available'] <= time
                    and time+table['durations'][vehicle['position']][quote['origin']]*config['traffic_factor'] <= quote['expires'])
                assert candidates and candidates[0][1] == quote['vehicle_id']
                assert math.isclose(quote['pickup']-time, candidates[0][0], abs_tol=1e-8)
                assert math.isclose(quote['completed']-quote['pickup'],
                    table['durations'][quote['origin']][quote['destination']]*config['traffic_factor'], abs_tol=1e-8)
                vehicles[quote['vehicle_id']].update(position=quote['destination'], available=quote['completed'])
                assignments += 1
            assert (spent, reserved) == (event['spent_vnd'], event['reserved_vnd'])
            assert 0 <= spent <= spent+reserved <= config['budget_vnd']
            prefixes += 1
        assert reserved == 0 and spent == run['summary']['actual_spend_vnd']
        assert len(finished) == run['summary']['completed']
        assert len(expired) == run['summary']['expired']
        assert requested == finished | expired and not finished & expired
        for key in vehicles:
            legs = [leg for leg in run['legs'] if leg['vehicle_id'] == key]
            for left, right in zip(legs, legs[1:]):
                assert left['end'] <= right['start'] and left['destination'] == right['origin']
            for leg in legs:
                assert math.isclose(leg['end']-leg['start'],
                    table['durations'][leg['origin']][leg['destination']]*config['traffic_factor'], abs_tol=1e-7)
        refunds = run['cost_events']
        assert len({event['request_id'] for event in refunds}) == len(refunds)
        for event in refunds:
            quote = quotes[event['request_id']]
            assert quote['id'] in finished and event['time'] > quote['completed']
            assert event['amount_vnd'] == -quote['offer_vnd']
        assert run['summary']['mature_net_spend_vnd'] == spent+sum(event['amount_vnd'] for event in refunds)
        completions += len(finished)
    return {'status': 'PASS', 'version': 'rollout-development-physical-audit/v1',
            'runs': len(index['runs']), 'nearest_idle_assignments': assignments,
            'executed_completions': completions, 'independent_ledger_prefixes': prefixes,
            'directed_osrm_pairs': len(network['anchors'])*(len(network['anchors'])-1),
            'quality_acceptance': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path)
    parser.add_argument('network', type=Path)
    args = parser.parse_args()
    result = audit(args.folder, args.network)
    (args.folder/'physical-audit.json').write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps(result))
