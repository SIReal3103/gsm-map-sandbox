"""Fit the existing simulation time multiplier against independent observed trips.

Input JSON contains a source description and trips with explicit train/holdout
splits. Only local API requests are allowed. No observations are synthesized.
"""
import argparse
import json
import math
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


def validate_input(data, bbox):
    if not isinstance(data.get('source'), str) or not data['source'].strip():
        raise ValueError('A description of independent observed data is required')
    trips = data.get('trips')
    if not isinstance(trips, list) or not trips:
        raise ValueError('At least one train and one holdout trip are required')
    ids = set()
    for trip in trips:
        if not isinstance(trip.get('id'), str) or not trip['id'] or trip['id'] in ids:
            raise ValueError('Trip IDs must be unique nonempty strings')
        ids.add(trip['id'])
        if trip.get('split') not in {'train', 'holdout'}:
            raise ValueError('Each trip needs an explicit train or holdout split')
        observed = trip.get('observed_seconds')
        if isinstance(observed, bool) or not isinstance(observed, (int, float)) or not math.isfinite(observed) or observed <= 0:
            raise ValueError('Observed travel seconds must be finite and positive')
        for key in ('start', 'end'):
            point = trip.get(key)
            if not isinstance(point, list) or len(point) != 2 or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in point):
                raise ValueError('Trip endpoints must be finite [longitude, latitude]')
            lon, lat = point
            if not (bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]):
                raise ValueError('Trip endpoints must be inside the small study area')
        if trip['start'] == trip['end']:
            raise ValueError('Trip endpoints must differ')
    if {trip['split'] for trip in trips} != {'train', 'holdout'}:
        raise ValueError('Independent holdout trips are required; do not fit on all trips')
    return trips


def fit_multiplier(rows):
    # Weighted median of y/x minimizes sum |y - factor*x| in seconds.
    pairs = sorted((r['observed_seconds'] / r['osrm_seconds'], r['osrm_seconds']) for r in rows)
    half = sum(weight for _, weight in pairs) / 2
    cumulative = 0
    for ratio, weight in pairs:
        cumulative += weight
        if cumulative >= half:
            return ratio
    raise ValueError('No training observations')


def metrics(rows, factor):
    errors = [abs(r['observed_seconds'] - factor * r['osrm_seconds']) for r in rows]
    return {'n': len(rows), 'mae_seconds': sum(errors) / len(errors),
            'mape_percent': 100 * sum(e / r['observed_seconds'] for e, r in zip(errors, rows)) / len(rows),
            'bias_seconds': sum(factor*r['osrm_seconds'] - r['observed_seconds'] for r in rows) / len(rows)}


def fetch(api, path, body=None):
    request = Request(api + path, data=json.dumps(body).encode() if body is not None else None,
                      headers={'Content-Type': 'application/json'})
    with urlopen(request, timeout=30) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--api', default='http://127.0.0.1:8000')
    args = parser.parse_args()
    url = urlsplit(args.api)
    if url.scheme != 'http' or url.hostname not in {'127.0.0.1', 'localhost', '::1'} or url.username or url.password or url.query or url.fragment or url.path not in {'', '/'}:
        parser.error('API must be a local loopback HTTP URL')
    api = args.api.rstrip('/')
    status = fetch(api, '/api/dataset/status')
    if not status['ready']:
        raise ValueError('The verified local map and OSRM must be ready')
    bbox = status['region'].get('simulation_bbox')
    if not bbox:
        raise ValueError('Small simulation bbox must be configured')
    data = json.loads(args.input.read_text())
    trips = validate_input(data, bbox)
    rows = []
    for trip in trips:
        route = fetch(api, '/api/route', {'start': trip['start'], 'end': trip['end']})
        rows.append({'id': trip['id'], 'split': trip['split'], 'observed_seconds': trip['observed_seconds'],
                     'osrm_seconds': route['duration'], 'distance_meters': route['distance'],
                     'snap_meters': [p['distance'] for p in route['snap_points']]})
    train = [r for r in rows if r['split'] == 'train']
    holdout = [r for r in rows if r['split'] == 'holdout']
    unconstrained = fit_multiplier(train)
    factor = max(1.0, min(3.0, unconstrained))
    report = {'status': 'fitted_on_user_observations', 'source': data['source'],
              'simulation_bbox': bbox, 'traffic_factor': factor, 'unconstrained_factor': unconstrained,
              'constrained_to_existing_range': factor != unconstrained,
              'train': {'baseline_osrm': metrics(train, 1), 'fitted': metrics(train, factor)},
              'holdout': {'baseline_osrm': metrics(holdout, 1), 'fitted': metrics(holdout, factor)},
              'routing_provenance': status['artifacts']['routing_manifest'], 'rows': rows,
              'limitations': ['Observed durations must exclude waiting/pickup/dwell and match trip endpoints.',
                              'Split by day or session before fitting; no independent split is inferred by this tool.',
                              'One scalar multiplier; does not fit hourly traffic, driver behavior, demand or voucher response.',
                              'Not auto-applied; inspect holdout error and sample size before changing the UI multiplier.']}
    if args.output.exists():
        raise FileExistsError('Choose a new output; existing calibration evidence is immutable')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps({key: report[key] for key in ['traffic_factor', 'holdout', 'constrained_to_existing_range']}, indent=2))


if __name__ == '__main__':
    main()
