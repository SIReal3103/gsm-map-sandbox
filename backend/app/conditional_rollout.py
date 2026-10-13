"""Integrate the focal first-request Bernoulli, retaining full fleet/budget paths.

Only planning uses conditional branches. Executed worlds use the unchanged
Campaign.issue request/timing law, integer commitments and dispatch engine.
"""
import heapq
import math
import statistics

from .campaign import Campaign, POLICIES, choose, quote_tape, screen, timing_quantile
from .simulation import draw


def probability(value):
    if not math.isfinite(value) or not 0 <= value <= 1:
        raise ValueError('Invalid focal request probability')
    return min(1-1e-7,max(1e-7,value))


def weighted_service(samples):
    requests=math.fsum(weight*s['requested'] for weight,s in samples)
    waits=sorted((wait,weight) for weight,s in samples for wait in s['waits'] if weight>0)
    pickups=math.fsum(weight for _,weight in waits)
    tail=None
    if waits:
        cumulative=correction=0.
        for wait,weight in waits:
            increment=weight-correction
            next_mass=cumulative+increment
            correction=(next_mass-cumulative)-increment
            cumulative=next_mass
            if cumulative>=.95*pickups:
                tail=wait;break
    return {'requests':requests,'pickups':pickups,
            'unserved':math.fsum(w*s['unserved'] for w,s in samples)/requests if requests else None,
            'cancelled':math.fsum(w*s['cancelled'] for w,s in samples)/requests if requests else None,
            'wait_p95':tail}


def conditional_branch(world, snapshot, namespace, quote, action, requested):
    branch=world.fork(snapshot,namespace)
    branch.issue(quote,action)
    branch.heap=[event for event in branch.heap if not (event[2]==quote['id'] and event[4]=='request')]
    heapq.heapify(branch.heap)
    if requested:
        delay=timing_quantile(branch.bundle.data['timing'],draw(namespace,f'timing:{quote["id"]}'))
        branch.schedule(branch.now+delay,1,'request',quote['id'])
    return branch


class ConditionalCampaign(Campaign):
    def rank(self,quote,policy):
        candidates=self.feasible(quote)
        if policy=='no_offer' or len(candidates)==1:
            return candidates[0],{'fallback':candidates[0].get('fallback') or 'no paid candidate','candidates':candidates}
        draws=self.planner['draws']
        if isinstance(draws,bool) or not isinstance(draws,int) or draws<1:
            raise ValueError('Positive integer planning draw count required')
        snapshot=self.observed();samples=[[] for _ in candidates];expected=[[] for _ in candidates]
        for r in range(draws):
            namespace=f'planning:{self.config["seed"]}:{quote["id"]}:{r}'
            forecast=self.forecast(namespace)
            for i,action in enumerate(candidates):
                p=probability(action['q']);count=0.
                for requested,weight in ((False,1-p),(True,p)):
                    branch=conditional_branch(self,snapshot,namespace,quote,action,requested)
                    branch.continuation(forecast)
                    outcome=branch.outcomes()
                    samples[i].append((weight,outcome));count+=weight*outcome['completed']
                expected[i].append(count)
        baseline=weighted_service(samples[0]);surviving=[]
        for i,action in enumerate(candidates):
            measured=weighted_service(samples[i])
            diffs=[a-b for a,b in zip(expected[i],expected[0])]
            action.update(gain=statistics.mean(diffs),mc_std=statistics.stdev(diffs) if len(diffs)>1 else None,
                          service=measured,screen=screen(measured,baseline,self.config,self.planner))
            if i and action['screen']['passed']:surviving.append(action)
        score,eps=('delta',self.planner['epsilon_q']) if policy=='response' else ('gain',self.planner['epsilon_n'])
        selected=choose(surviving,score,eps) or candidates[0]
        return selected,{'score':score,'draws':draws,'focal_states':2,'estimator':'conditional focal Bernoulli',
            'baseline':baseline,'baseline_screen':candidates[0]['screen'],'candidates':candidates,
            'fallback':None if selected['arm']!='none' else 'no surviving positive score'}


def simulate_conditional_campaign(config,network,bundle,policy,planner=None):
    if policy not in POLICIES:raise ValueError('Unknown conditional campaign policy')
    world=ConditionalCampaign(config,network,bundle,f'evaluation:{config["seed"]}',planner)
    for quote in quote_tape(config,bundle,f'exogenous:{config["seed"]}'):
        world.advance(quote['arrival']);action,detail=world.rank(quote,policy)
        world.decisions.append({'quote_id':quote['id'],'time':world.now,'selected':action['arm'],**detail})
        world.issue(quote,action,config.get('response_scale',1.))
    world.advance(world.endpoint)
    if world.reserved or world.queue or any(q['status'] in ('pending','queued','assigned','onboard') for q in world.quotes.values()):
        raise ValueError('Conditional campaign clearance left unresolved state')
    outcome=world.outcomes();kernel=bundle.data['completion_cost'];cost_events=[]
    for q in world.quotes.values():
        if q['status']=='completed' and q['offer_vnd'] and draw(world.namespace,f'refund:{q["id"]}')<kernel['refund_probability']:
            delay=kernel['refund_delay_seconds'][int(draw(world.namespace,f'refund-delay:{q["id"]}')*len(kernel['refund_delay_seconds']))]
            cost_events.append({'time':q['completed']+delay,'request_id':q['id'],'kind':'refund','amount_vnd':-q['offer_vnd']})
    summary={'quoted':len(world.quotes),'accepted':outcome['requested'],'completed':outcome['completed'],
        'expired':outcome['unserved'],'actual_spend_vnd':world.spent,
        'mature_net_spend_vnd':world.spent+sum(e['amount_vnd'] for e in cost_events),'reserved_vnd':world.reserved,
        'mean_pickup_seconds':statistics.mean(outcome['waits']) if outcome['waits'] else None,
        'deadhead_km':sum(network['distances'][l['origin']][l['destination']] for l in world.legs if l['kind']=='pickup')/1000,
        'passenger_km':sum(network['distances'][l['origin']][l['destination']] for l in world.legs if l['kind']=='trip')/1000}
    return {'policy':policy,'estimator':'conditional focal Bernoulli',
        'vehicles':[{'id':v['id'],'initial':v['initial']} for v in world.vehicles],
        'quotes':[{k:v for k,v in q.items() if k!='profile'} for q in world.quotes.values()],
        'legs':world.legs,'events':world.events,'decisions':world.decisions,'summary':summary,'duration':world.endpoint,
        'cost_events':sorted(cost_events,key=lambda e:e['time']),
        'cost_mature_at':world.endpoint+max(kernel['refund_delay_seconds']),'planner':world.planner}
