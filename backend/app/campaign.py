"""Stateful voucher campaign with observed-state, paired nonrecursive rollout.

OSRM supplies travel; learned synthetic WP2 supplies response. Planning forecasts
never receive the realized evaluation quote tape or its latent response draws.
"""
import heapq
import math
import statistics
from copy import deepcopy
from datetime import datetime, timedelta, timezone

from .simulation import draw, validate_network

POLICIES = ('no_offer', 'response', 'state_aware')
BASE_TIME = datetime(2026, 1, 1, tzinfo=timezone.utc)
DEFAULT_PLANNER = {'draws': 32, 'epsilon_q': 1e-6, 'epsilon_n': .02,
                   'minimum_requests': 20, 'minimum_pickups': 10,
                   'unserved_increase': .01, 'wait_tail_increase': .05,
                   'maximum_unserved': .20, 'admission_queue_per_car': 2}


def timing_cdf(mass, elapsed):
    """Linear interpolation inside each one-minute bin, fixed across offers."""
    minute = max(0, min(12., elapsed/60))
    whole = min(len(mass), int(minute))
    return math.fsum(mass[:whole]) + (mass[whole]*(minute-whole) if whole < len(mass) else 0)


def timing_quantile(mass, uniform):
    """Interpolate timing to nanosecond resolution, avoiding bin-boundary drift."""
    target = min(1-1e-15, max(0, uniform))
    for i, value in enumerate(mass):
        cumulative = math.fsum(mass[:i])
        if target < math.fsum(mass[:i+1]):
            return round(60*(i+(target-cumulative)/value), 9)
    raise ValueError('Invalid timing distribution')


def remaining_request(q, mass, elapsed, response_draw, timing_draw):
    cdf = timing_cdf(mass, elapsed)
    denominator = 1-q*cdf
    if denominator <= 0:
        raise ValueError('Pending episode has zero conditional support')
    probability = q*(1-cdf)/denominator
    return timing_quantile(mass, cdf+(1-cdf)*timing_draw) if response_draw < probability else None


def choose(candidates, score, epsilon):
    best = max((c[score] for c in candidates), default=0.)
    if best <= epsilon:
        return None
    tied = [c for c in candidates if best-c[score] <= epsilon]
    return min(tied, key=lambda c: (c['liability'], c['arm']))


def quote_tape(config, bundle, namespace):
    pool = bundle.data['profiles']
    # Independent synthetic episodes sampled without replacement. Histories
    # stay frozen; within-campaign repeat-customer dependence is not modeled.
    indices = sorted(range(len(pool)), key=lambda i: draw(namespace, f'profile:{i}'))[:config['quotes']]
    return [{'id': f'Q{i+1:03}', 'arrival': (i+draw(namespace, f'arrival:Q{i+1:03}'))*config['minutes']*60/config['quotes'],
             'profile': deepcopy(pool[index]), 'profile_index': index, 'origin': int(pool[index]['origin_anchor']),
             'destination': int(pool[index]['destination_anchor'])} for i, index in enumerate(indices)]


class Campaign:
    def __init__(self, config, network, bundle, namespace, planner=None, record=True):
        validate_network(network)
        self.config, self.network, self.bundle, self.namespace = dict(config), network, bundle, namespace
        self.planner = dict(DEFAULT_PLANNER if planner is None else planner)
        self.vehicles = [{'id': f'V{i+1:02}', 'initial': int(draw(config['seed'], f'vehicle:{i}')*len(network['anchors'])),
                          'position': 0, 'available': 0.} for i in range(config['fleet'])]
        for v in self.vehicles:
            v['position'] = v['initial']
        self.quotes, self.queue, self.heap, self.events, self.legs, self.decisions = {}, [], [], [], [], []
        self.spent = self.reserved = self.sequence = self.issued = 0
        self.now, self.record = 0., record
        self.end = config['minutes']*60
        self.endpoint = self.end+720+config['patience_seconds']+2*max(map(max, network['durations']))*config['traffic_factor']

    def schedule(self, time, priority, kind, qid):
        self.sequence += 1
        heapq.heappush(self.heap, (time, priority, qid, self.sequence, kind))

    def event(self, kind, qid):
        if not 0 <= self.spent <= self.spent+self.reserved <= self.config['budget_vnd']:
            raise ValueError('Campaign liability invariant violated')
        if self.record:
            self.events.append({'time': self.now, 'kind': kind, 'request_id': qid,
                                'spent_vnd': self.spent, 'reserved_vnd': self.reserved})

    def eta(self, origin):
        d, factor = self.network['durations'], self.config['traffic_factor']
        return min(max(0, v['available']-self.now)+d[v['position']][origin]*factor for v in self.vehicles)

    def feasible(self, quote):
        eta = self.eta(quote['origin'])
        candidates = self.bundle.candidates(quote['profile'], round(eta/60, 2), BASE_TIME+timedelta(seconds=self.now))
        for c in candidates:
            c['quoted_eta'] = eta
        remaining = self.config['budget_vnd']-self.spent-self.reserved
        # Same development-frozen current-state envelope in both rankings/pi_0.
        admitted = eta <= self.config['patience_seconds'] and len(self.queue) <= self.config['fleet']*self.planner['admission_queue_per_car']
        return [c for c in candidates if c['arm'] == 'none' or (admitted and c['liability'] <= remaining)]

    def issue(self, quote, action, response_scale=1.):
        if quote['id'] in self.quotes:
            raise ValueError('Duplicate episode')
        liability = action['liability']
        if (isinstance(liability, bool) or not isinstance(liability, int) or liability < 0
                or self.spent+self.reserved+liability > self.config['budget_vnd']):
            raise ValueError('Campaign liability invariant violated')
        q = dict(quote)
        q0 = self.bundle.candidates(q['profile'], round(action['quoted_eta']/60, 2), BASE_TIME+timedelta(seconds=self.now))[0]['q']
        p = max(1e-7, min(1-1e-7, q0+response_scale*(action['q']-q0)))
        q.update(offer_id=action['arm'], offer_vnd=action['liability'], probability=action['q'],
                 quoted_eta=action['quoted_eta'], accepted=False, status='pending', expires=self.now+720, offer_expires=self.now+720)
        self.quotes[q['id']] = q
        self.issued += 1
        self.reserved += q['offer_vnd']
        self.event('offered', q['id'])
        self.schedule(q['expires'], 2, 'offer_expire', q['id'])
        if draw(self.namespace, f'response:{q["id"]}') < p:
            delay = timing_quantile(self.bundle.data['timing'], draw(self.namespace, f'timing:{q["id"]}'))
            self.schedule(self.now+delay, 1, 'request', q['id'])

    def dispatch(self):
        for qid in list(self.queue):
            q = self.quotes[qid]
            eligible = [(self.network['durations'][v['position']][q['origin']]*self.config['traffic_factor'], v['id'], v)
                        for v in self.vehicles if v['available'] <= self.now and
                        self.now+self.network['durations'][v['position']][q['origin']]*self.config['traffic_factor'] <= q['expires']]
            if not eligible:
                continue
            pickup_duration, _, v = min(eligible, key=lambda r: (r[0], r[1]))
            self.queue.remove(qid)
            pickup = self.now+pickup_duration
            finish = pickup+self.network['durations'][q['origin']][q['destination']]*self.config['traffic_factor']
            q.update(status='assigned', assigned=self.now, pickup=pickup, completed=finish, vehicle_id=v['id'])
            if self.record:
                if pickup_duration > 0:
                    self.legs.append({'vehicle_id': v['id'], 'request_id': qid, 'kind': 'pickup', 'start': self.now,
                                      'end': pickup, 'origin': v['position'], 'destination': q['origin'],
                                      'path_id': f'{v["position"]}-{q["origin"]}'})
                self.legs.append({'vehicle_id': v['id'], 'request_id': qid, 'kind': 'trip', 'start': pickup,
                                  'end': finish, 'origin': q['origin'], 'destination': q['destination'],
                                  'path_id': f'{q["origin"]}-{q["destination"]}'})
            v.update(position=q['destination'], available=finish)
            self.event('assigned', qid)
            self.schedule(pickup, 1, 'pickup', qid)
            self.schedule(finish, 0, 'complete', qid)

    def advance(self, until):
        if not math.isfinite(until) or until < self.now:
            raise ValueError('Campaign clock cannot move backward or become nonfinite')
        while self.heap and self.heap[0][0] <= until:
            self.now, _, qid, _, kind = heapq.heappop(self.heap)
            q = self.quotes[qid]
            if kind == 'request' and q['status'] == 'pending':
                q.update(status='queued', accepted=True, requested=self.now, expires=self.now+self.config['patience_seconds'])
                self.queue.append(qid)
                self.schedule(q['expires'], 2, 'queue_expire', qid)
                self.event('accepted', qid)
                self.dispatch()
            elif kind == 'pickup' and q['status'] == 'assigned':
                q['status'] = 'onboard'
                self.event('pickup', qid)
            elif kind == 'complete' and q['status'] == 'onboard':
                q['status'] = 'completed'
                self.reserved -= q['offer_vnd']
                self.spent += q['offer_vnd']
                self.event('completed', qid)
                self.dispatch()
            elif kind == 'offer_expire' and q['status'] == 'pending':
                q['status'] = 'rejected'
                self.reserved -= q['offer_vnd']
                self.event('rejected', qid)
            elif kind == 'queue_expire' and q['status'] == 'queued':
                q['status'] = 'expired'
                self.queue.remove(qid)
                self.reserved -= q['offer_vnd']
                self.event('expired', qid)
        self.now = until

    def observed(self):
        # No event heap: scheduled customer draws are evaluator-only latent state.
        return {'now': self.now, 'issued': self.issued, 'spent': self.spent, 'reserved': self.reserved,
                'vehicles': deepcopy(self.vehicles),
                'quotes': {qid: {k:v for k,v in q.items() if k!='profile'} for qid,q in self.quotes.items()},
                'queue': list(self.queue)}

    def fork(self, snapshot, namespace):
        branch = Campaign(self.config, self.network, self.bundle, namespace, self.planner, record=False)
        branch.now, branch.issued, branch.spent, branch.reserved = (snapshot[k] for k in ('now','issued','spent','reserved'))
        branch.vehicles = deepcopy(snapshot['vehicles'])
        branch.quotes = {qid: dict(q) for qid,q in snapshot['quotes'].items()}
        branch.queue = list(snapshot['queue'])
        for qid, q in branch.quotes.items():
            if q['status'] == 'pending':
                branch.schedule(q['expires'], 2, 'offer_expire', qid)
                elapsed = branch.now-q['arrival']
                delay = remaining_request(q['probability'], self.bundle.data['timing'], elapsed,
                    draw(namespace, f'pending-response:{qid}'), draw(namespace, f'pending-timing:{qid}'))
                if delay is not None:
                    branch.schedule(q['arrival']+delay, 1, 'request', qid)
            elif q['status'] == 'queued':
                branch.schedule(q['expires'], 2, 'queue_expire', qid)
            elif q['status'] in ('assigned','onboard'):
                if q['pickup'] > branch.now:
                    branch.schedule(q['pickup'], 1, 'pickup', qid)
                branch.schedule(q['completed'], 0, 'complete', qid)
        return branch

    def forecast(self, namespace):
        remaining = max(0, self.config['quotes']-self.issued-1)
        pool, quotes = self.bundle.data['profiles'], []
        for i in range(remaining):
            qid = f'F{self.issued+i+2:03}'
            index = int(draw(namespace, f'forecast-profile:{qid}')*len(pool))
            p = pool[index]
            arrival = self.now+(i+draw(namespace, f'forecast-arrival:{qid}'))*(self.end-self.now)/max(1, remaining)
            quotes.append({'id': qid, 'arrival': arrival, 'profile': p, 'profile_index': index,
                           'origin': int(p['origin_anchor']), 'destination': int(p['destination_anchor'])})
        return quotes

    def continuation(self, quotes):
        for quote in quotes:
            self.advance(quote['arrival'])
            candidates = self.feasible(quote)
            selected = choose(candidates[1:], 'delta', self.planner['epsilon_q']) or candidates[0]
            self.issue(quote, selected)
        self.advance(self.endpoint)

    def outcomes(self):
        requested = [q for q in self.quotes.values() if q['accepted']]
        completed = [q for q in requested if q['status'] == 'completed']
        waits = [q['pickup']-q['requested'] for q in completed]
        return {'requested': len(requested), 'completed': len(completed),
                'unserved': sum(q['status'] == 'expired' for q in requested), 'cancelled': 0, 'waits': waits}

    def rank(self, quote, policy):
        candidates = self.feasible(quote)
        if policy == 'no_offer' or len(candidates) == 1:
            return candidates[0], {'fallback': candidates[0].get('fallback') or 'no paid candidate', 'candidates': candidates}
        snapshot = self.observed()
        samples = [[] for _ in candidates]
        for r in range(self.planner['draws']):
            namespace = f'planning:{self.config["seed"]}:{quote["id"]}:{r}'
            forecast = self.forecast(namespace)
            for i, action in enumerate(candidates):
                branch = self.fork(snapshot, namespace)
                branch.issue(quote, action)
                branch.continuation(forecast)
                samples[i].append(branch.outcomes())
        baseline = service(samples[0])
        surviving = []
        for i, action in enumerate(candidates):
            measured = service(samples[i])
            diffs = [s['completed']-b['completed'] for s,b in zip(samples[i], samples[0])]
            action.update(gain=statistics.mean(diffs), mc_std=statistics.stdev(diffs) if len(diffs)>1 else None,
                          service=measured, screen=screen(measured, baseline, self.config, self.planner))
            if i and action['screen']['passed']:
                surviving.append(action)
        score, eps = ('delta', self.planner['epsilon_q']) if policy == 'response' else ('gain', self.planner['epsilon_n'])
        selected = choose(surviving, score, eps) or candidates[0]
        return selected, {'score': score, 'draws': self.planner['draws'], 'baseline': baseline,
                          'baseline_screen': candidates[0]['screen'], 'candidates': candidates,
                          'fallback': None if selected['arm'] != 'none' else 'no surviving positive score'}


def service(samples):
    requests = sum(s['requested'] for s in samples)
    waits = sorted(w for s in samples for w in s['waits'])
    return {'requests': requests, 'pickups': len(waits),
            'unserved': sum(s['unserved'] for s in samples)/requests if requests else None,
            'cancelled': sum(s['cancelled'] for s in samples)/requests if requests else None,
            'wait_p95': waits[max(0, math.ceil(.95*len(waits))-1)] if waits else None}


def screen(value, baseline, config, planner):
    reasons = []
    for s in (value, baseline):
        if s['requests'] < planner['minimum_requests'] or s['pickups'] < planner['minimum_pickups']:
            reasons.append('insufficient service events')
    if not reasons:
        if value['unserved'] > planner['maximum_unserved']:
            reasons.append('absolute unserved limit')
        if value['unserved'] > baseline['unserved']+planner['unserved_increase']:
            reasons.append('unserved relative to action zero')
        if value['wait_p95'] > config['patience_seconds'] or value['wait_p95'] > baseline['wait_p95']*(1+planner['wait_tail_increase'])+1e-9:
            reasons.append('pickup wait tail')
    return {'passed': not reasons, 'reasons': sorted(set(reasons))}


def simulate_campaign(config, network, bundle, policy, planner=None):
    if policy not in POLICIES:
        raise ValueError('Unknown integrated policy')
    campaign = Campaign(config, network, bundle, f'evaluation:{config["seed"]}', planner)
    for quote in quote_tape(config, bundle, f'exogenous:{config["seed"]}'):
        campaign.advance(quote['arrival'])
        action, detail = campaign.rank(quote, policy)
        campaign.decisions.append({'quote_id': quote['id'], 'time': campaign.now, 'selected': action['arm'], **detail})
        campaign.issue(quote, action, config.get('response_scale', 1.))
    campaign.advance(campaign.endpoint)
    if campaign.reserved or campaign.queue or any(q['status'] in ('pending','queued','assigned','onboard') for q in campaign.quotes.values()):
        raise ValueError('Clearance did not resolve every commitment')
    outcome = campaign.outcomes()
    refund, cost_events = 0, []
    kernel = bundle.data['completion_cost']
    for q in campaign.quotes.values():
        if q['status'] == 'completed' and q['offer_vnd'] and draw(campaign.namespace, f'refund:{q["id"]}') < kernel['refund_probability']:
            delay = kernel['refund_delay_seconds'][int(draw(campaign.namespace, f'refund-delay:{q["id"]}')*len(kernel['refund_delay_seconds']))]
            refund += q['offer_vnd']
            cost_events.append({'time': q['completed']+delay, 'request_id': q['id'], 'kind': 'refund', 'amount_vnd': -q['offer_vnd']})
    summary = {'quoted': len(campaign.quotes), 'accepted': outcome['requested'], 'completed': outcome['completed'],
               'expired': outcome['unserved'], 'actual_spend_vnd': campaign.spent, 'mature_net_spend_vnd': campaign.spent-refund,
               'reserved_vnd': campaign.reserved, 'mean_pickup_seconds': statistics.mean(outcome['waits']) if outcome['waits'] else None,
               'deadhead_km': sum(network['distances'][l['origin']][l['destination']] for l in campaign.legs if l['kind']=='pickup')/1000,
               'passenger_km': sum(network['distances'][l['origin']][l['destination']] for l in campaign.legs if l['kind']=='trip')/1000}
    quotes = [{k:v for k,v in q.items() if k!='profile'} for q in campaign.quotes.values()]
    return {'policy': policy, 'vehicles': [{'id':v['id'], 'initial':v['initial']} for v in campaign.vehicles],
            'quotes': quotes, 'legs': campaign.legs, 'events': campaign.events, 'decisions': campaign.decisions,
            'summary': summary, 'duration': campaign.endpoint, 'cost_events': sorted(cost_events, key=lambda e:e['time']),
            'cost_mature_at': campaign.endpoint+max(kernel['refund_delay_seconds']), 'planner': campaign.planner}
