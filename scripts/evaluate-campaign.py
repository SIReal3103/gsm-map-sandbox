"""Run a prelocked conditional campaign comparison; no outcome-driven tuning."""
import argparse
from concurrent.futures import ProcessPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path
import random
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.app.campaign import DEFAULT_PLANNER, simulate_campaign
from backend.app.response_bundle import ResponseBundle


def checksum(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check_lock(protocol):
    for path, sha in protocol['code_hashes'].items():
        if checksum(ROOT/path) != sha:
            raise ValueError('Evaluation source drift: '+path)
    for path, sha in protocol['asset_hashes'].items():
        if checksum(ROOT/path) != sha:
            raise ValueError('Evaluation asset drift: '+path)


def job(payload):
    protocol, case, seed, scale, output = payload
    check_lock(protocol)
    model = protocol['model']
    bundle = ResponseBundle(ROOT/model['path'], model['sha256'])
    config = {**protocol['common'], **protocol['workloads'][case], 'seed':seed, 'response_scale':scale}
    network = bundle.data['provenance']['transport']
    results, started = {}, time.monotonic()
    for policy in protocol['policies']:
        results[policy] = simulate_campaign(config, network, bundle, policy, protocol['planner'])
    name = f'{case}-{seed}-response-{scale:g}.json'
    path = Path(output)/name
    path.write_text(json.dumps({'protocol_id':protocol['id'], 'config':config, 'runs':results},separators=(',',':')))
    return {'case':case,'seed':seed,'response_scale':scale,'file':name,'sha256':checksum(path),
            'seconds':time.monotonic()-started,'summaries':{p:r['summary'] for p,r in results.items()}}


def summarize(rows, protocol):
    results = {}
    for scale in protocol['response_scales']:
        group = [r for r in rows if r['response_scale']==scale]
        expected = len(protocol['seeds'])*len(protocol['workloads'])
        if len(group) != expected:
            results[str(scale)] = {'status':'running','worlds':len(group),'expected':expected}
            continue
        baseline = sum(r['summaries']['response']['completed'] for r in group)
        fleet = sum(r['summaries']['state_aware']['completed'] for r in group)
        by_seed = {seed:[r for r in group if r['seed']==seed] for seed in protocol['seeds']}
        rng, diffs, gains = random.Random(protocol['bootstrap_seed']), [], []
        for _ in range(protocol['bootstrap_replicates']):
            sample = [r for seed in rng.choices(protocol['seeds'], k=len(protocol['seeds'])) for r in by_seed[seed]]
            b = sum(r['summaries']['response']['completed'] for r in sample)
            f = sum(r['summaries']['state_aware']['completed'] for r in sample)
            diffs.append((f-b)/len(sample));gains.append((f-b)/b if b else None)
        def interval(values):
            v = sorted(x for x in values if x is not None)
            return [v[int(.025*(len(v)-1))],v[int(.975*(len(v)-1))]] if v else [None,None]
        service = {}
        for p in ('response','state_aware'):
            s = [r['summaries'][p] for r in group]
            served = sum(v['completed'] for v in s)
            requested = sum(v['accepted'] for v in s)
            service[p] = {'requests':requested, 'unserved_rate':sum(v['expired'] for v in s)/requested if requested else None,
                          'mean_pickup':sum(v['mean_pickup_seconds']*v['completed'] for v in s if v['mean_pickup_seconds'] is not None)/served if served else None,
                          'gross_spend':sum(v['actual_spend_vnd'] for v in s), 'net_spend':sum(v['mature_net_spend_vnd'] for v in s)}
        a,b = service['state_aware'],service['response']
        service_pass = (a['unserved_rate'] is not None and b['unserved_rate'] is not None and a['mean_pickup'] is not None and b['mean_pickup'] is not None
                        and a['unserved_rate']<=b['unserved_rate']+.01 and a['mean_pickup']<=b['mean_pickup']*1.05+1e-9)
        ci = interval(diffs)
        results[str(scale)] = {'status':'complete','worlds':len(group),'response_completed':baseline,'fleet_completed':fleet,
                              'relative_gain':(fleet-baseline)/baseline if baseline else None,
                              'mean_paired_difference':(fleet-baseline)/len(group), 'difference_ci':ci,'relative_ci':interval(gains),
                              'service':service,'service_pass':service_pass,
                              'target_pass':bool(baseline and (fleet-baseline)/baseline>=.05 and ci[0]>0 and service_pass)}
    return {'protocol_id':protocol['id'],'primary_response_scale':1.,'results':results,
            'uncertainty':'Paired seed bootstrap retains all workloads per seed. Conditional Monte Carlo-world uncertainty; not held-out GMS days, model/causal uncertainty or factual H2 acceptance.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('protocol',type=Path)
    parser.add_argument('output',type=Path)
    parser.add_argument('--workers',type=int,default=2,choices=(1,2))
    args = parser.parse_args()
    protocol = json.loads(args.protocol.read_text());check_lock(protocol)
    args.output.mkdir(parents=True, exist_ok=True)
    index = args.output/'index.json'
    rows = json.loads(index.read_text()) if index.exists() else []
    for row in rows:
        path = args.output/row['file']
        if checksum(path) != row['sha256'] or json.loads(path.read_text())['protocol_id'] != protocol['id']:
            raise ValueError('Saved evaluation evidence drift')
    done = {(r['case'],r['seed'],r['response_scale']) for r in rows}
    jobs = [(protocol,c,s,scale,str(args.output.resolve())) for scale in protocol['response_scales'] for c in protocol['workloads']
            for s in protocol['seeds'] if (c,s,scale) not in done]
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        for future in as_completed([pool.submit(job,j) for j in jobs]):
            row = future.result();rows.append(row);print(json.dumps(row),flush=True)
            index.write_text(json.dumps(rows,indent=2))
            (args.output/'summary.json').write_text(json.dumps(summarize(rows,protocol),indent=2))


if __name__=='__main__':
    main()
