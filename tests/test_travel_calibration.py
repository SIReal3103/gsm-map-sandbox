"""Hand-calculated synthetic observations test calibration math, not HCM fit."""
import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location('calibration', Path(__file__).parents[1] / 'scripts/calibrate-travel-times.py')
calibration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(calibration)


def test_fit_uses_training_weighted_median_and_holdout_is_independent():
    train = [{'osrm_seconds': 100, 'observed_seconds': 200},
             {'osrm_seconds': 100, 'observed_seconds': 200},
             {'osrm_seconds': 10, 'observed_seconds': 1000}]
    factor = calibration.fit_multiplier(train)
    assert factor == 2
    holdout = [{'osrm_seconds': 100, 'observed_seconds': 180}]
    assert calibration.metrics(holdout, factor)['mae_seconds'] == 20
    assert calibration.metrics(holdout, 1.4)['mae_seconds'] == 40
    assert calibration.metrics(holdout, factor)['bias_seconds'] == 20


def test_input_rejects_missing_holdout_duplicates_and_outside_area():
    bbox = [106.6935, 10.768, 106.7075, 10.782]
    trip = {'id': 't1', 'split': 'train', 'start': [106.695, 10.77], 'end': [106.70, 10.775], 'observed_seconds': 200}
    data = {'source': 'Synthetic unit fixture only', 'trips': [trip]}
    with pytest.raises(ValueError, match='holdout'):
        calibration.validate_input(data, bbox)
    data['trips'].append({**trip, 'split': 'holdout'})
    with pytest.raises(ValueError, match='unique'):
        calibration.validate_input(data, bbox)
    data['trips'][1]['id'] = 't2'
    assert len(calibration.validate_input(data, bbox)) == 2
    data['trips'][1]['start'] = [106.72, 10.77]
    with pytest.raises(ValueError, match='inside'):
        calibration.validate_input(data, bbox)
