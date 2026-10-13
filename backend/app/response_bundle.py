"""Portable calibrated WP2 inference; unsupported offers are withheld."""
import hashlib
import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path
from collections import OrderedDict


def sigmoid(value):
    if value >= 0:
        return 1 / (1 + math.exp(-value))
    e = math.exp(value)
    return e / (1 + e)


def predict(spec, features):
    score = spec['intercept']
    for name, weight in spec['numeric'].items():
        value = features.get(name)
        value = float(value) if value is not None else math.nan
        if not math.isfinite(value):
            value = 43200 if name == 'minutes_since_prior_request' else 0
        score += value * weight
    for name, mapping in spec['category'].items():
        score += mapping.get(str(features.get(name)), 0)
    raw = min(1-1e-7, max(1e-7, sigmoid(score)))
    cal = spec['calibration']
    return min(1-1e-7, max(1e-7, sigmoid(cal['slope'] * math.log(raw/(1-raw)) + cal['intercept'])))


class ResponseBundle:
    def __init__(self, path, expected_hash=None):
        raw = Path(path).read_bytes()
        self.sha256 = hashlib.sha256(raw).hexdigest()
        if expected_hash is not None and self.sha256 != expected_hash:
            raise ValueError('Campaign model checksum mismatch')
        self.data = json.loads(raw)
        if self.data['version'] != 'q1-campaign-model/v1':
            raise ValueError('Unsupported campaign model')
        self.offers = {o['offer_id']: o for o in self.data['offers']}
        self._candidate_cache = OrderedDict()
        self.cells = {(r['offerId'], r['origin'], r['fareBand'], r['etaBand'], r['historyBand']): r['count']
                      for r in self.data['support']['cells']['rows']}
        if abs(sum(self.data['timing'])-1) > 1e-12:
            raise ValueError('Invalid request timing mass')

    def terms(self, row, arm):
        offer = self.offers[arm]
        base, fee, background = (int(round(row[c])) for c in ('base_fare_vnd', 'fee_vnd', 'background_discount_vnd'))
        if min(base, fee, background) < 0 or background > base:
            raise ValueError('Invalid fare')
        eligible = arm == 'none' or base >= offer['min_fare_vnd']
        nominal = offer['fixed_discount_vnd'] if offer['kind'] == 'fixed' else math.floor((base-background)*offer['percent_off'])
        discount = min(nominal, offer['cap_vnd'], max(0, base-background-offer['min_payable_vnd'])) if eligible else 0
        return {'eligible': eligible, 'discount': discount, 'payable': base+fee-background-discount}

    def features(self, row, arm, eta, time=None):
        r = dict(row)
        terms = self.terms(r, arm)
        r.update(payable_fare_vnd=terms['payable'], eta_minutes=eta)
        t = datetime.fromisoformat(r['index_at'].replace('Z', '+00:00')).astimezone(timezone.utc) if time is None else time
        minute = t.hour*60+t.minute
        r.update(hour_sin=math.sin(2*math.pi*minute/1440), hour_cos=math.cos(2*math.pi*minute/1440),
                 weekday_sin=math.sin(2*math.pi*t.weekday()/7), weekday_cos=math.cos(2*math.pi*t.weekday()/7))
        r['log_payable'] = math.log(terms['payable']/1000)
        r['log_price_x_history_rate'] = r['log_payable']*r['prior_request_rate_28d']
        r['log_price_x_history_quotes'] = r['log_payable']*math.log1p(r['prior_quotes_28d'])
        r['eta_x_history_rate'] = eta*r['prior_request_rate_28d']
        r['eta_x_history_quotes'] = eta*math.log1p(r['prior_quotes_28d'])
        o = self.offers[arm]
        r.update(offer_kind=o['kind'], **{k: o[k] for k in ('percent_off','cap_vnd','min_fare_vnd','automatic','expiry_minutes')})
        return r, terms

    def supported(self, row, arm):
        d = self.data['support']['arms'].get(arm)
        if d is None:
            return False
        for name, (lo, hi) in d['ranges'].items():
            value = float(row.get(name, math.nan))
            if not math.isfinite(value) or value < lo-1e-9 or value > hi+1e-9:
                return False
        for name, values in d['categories'].items():
            if str(row.get(name)) not in values:
                return False
        s = self.data['support']['cells']
        fare = sum(row['base_fare_vnd'] >= t for t in s['fareThresholds'])
        eta = sum(row['eta_minutes'] >= t for t in s['etaThresholds'])
        history = int(row['prior_quotes_28d'] > s['historyThreshold'])
        return self.cells.get((arm, row['origin_zone'], fare, eta, history), 0) >= s['minimumCount']

    def candidates(self, row, eta, time=None):
        calendar = None if time is None else time.replace(second=0, microsecond=0).isoformat()
        key = (tuple(row.items()), eta, calendar)
        if key not in self._candidate_cache:
            self._candidate_cache[key] = self._compute_candidates(row, eta, time)
            if len(self._candidate_cache) > 4096:
                self._candidate_cache.popitem(last=False)
        self._candidate_cache.move_to_end(key)
        # Rollout scores/screens may mutate each returned action, never the cache.
        return [dict(action) for action in self._candidate_cache[key]]

    def _compute_candidates(self, row, eta, time=None):
        f0, terms = self.features(row, 'none', eta, time)
        supported0 = self.supported(f0, 'none')
        q0 = predict(self.data['models'][self.data['selected']], f0) if supported0 else self.data['none_fallback']
        result = [{'arm': 'none', 'q': q0, 'delta': 0., 'liability': 0, 'supported': supported0,
                   'fallback': None if supported0 else 'train-pooled-none; paid actions withheld'}]
        if supported0:
            for arm in self.offers:
                if arm == 'none':
                    continue
                frame, terms = self.features(row, arm, eta, time)
                if terms['eligible'] and terms['discount'] > 0 and self.supported(frame, arm):
                    q = predict(self.data['models'][self.data['selected']], frame)
                    result.append({'arm': arm, 'q': q, 'delta': q-q0, 'liability': terms['discount'],
                                   'supported': True, 'expected_request_cost': q*predict(self.data['models']['cost'], frame)*terms['discount']})
        return result
