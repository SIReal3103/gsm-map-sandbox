"""Exhaustive small-world oracle and budget/negative-response checks."""
from copy import deepcopy

import pytest

from backend.app import campaign as kernel
from backend.app.perfect_information_bound import SearchLimitExceeded, perfect_information_bound
from tests.test_campaign import CONFIG, GRAPH, QUOTE, ControlledResponse


def exhaustive(config, graph, bundle, tape):
    def solve(world, index):
        if index == len(tape):
            world.advance(world.endpoint)
            return world.outcomes()['completed']
        quote = tape[index]
        world.advance(quote['arrival'])
        values = []
        for action in world.feasible(quote):
            child = deepcopy(world, {id(bundle): bundle, id(graph): graph})
            child.issue(quote, action, config.get('response_scale', 1.))
            values.append(solve(child, index+1))
        return max(values)
    return solve(kernel.Campaign(config, graph, bundle, f'evaluation:{config["seed"]}', record=False), 0)


def test_binary_pruning_matches_exhaustive_all_offer_enumeration():
    class Distribution(ControlledResponse):
        def candidates(self, row, eta, time=None):
            return [{'arm': 'none', 'q': .7, 'delta': 0., 'liability': 0},
                    {'arm': 'cheap', 'q': .8, 'delta': .1, 'liability': 1000},
                    {'arm': 'large', 'q': .95, 'delta': .25, 'liability': 3000},
                    {'arm': 'negative', 'q': .1, 'delta': -.6, 'liability': 500}]
    bundle = Distribution()
    tape = [{**QUOTE, 'id': f'Q{i}', 'arrival': i*40.} for i in range(3)]
    before = deepcopy((CONFIG, GRAPH, tape, bundle.data))
    for scale in (0., .5, 1., 1.5):
        config = {**CONFIG, 'response_scale': scale, 'budget_vnd': 3000}
        result = perfect_information_bound(config, GRAPH, bundle, tape)
        assert result['status'] == 'EXACT'
        assert result['completion_upper_bound'] == exhaustive(config, GRAPH, bundle, tape)
        assert result['best_witness']['spent_vnd'] <= config['budget_vnd']
    assert (CONFIG, GRAPH, tape, bundle.data) == before


def test_negative_response_can_free_capacity_and_must_not_be_pruned(monkeypatch):
    monkeypatch.setattr(kernel, 'draw', lambda namespace, key: .5 if key.startswith('response:') else 0.)
    class Distribution(ControlledResponse):
        data = {**ControlledResponse.data, 'timing': [1.]+[0.]*11}
        def candidates(self, row, eta, time=None):
            zero = {'arm': 'none', 'q': .9, 'delta': 0., 'liability': 0}
            return [zero, {'arm': 'negative', 'q': .1, 'delta': -.8, 'liability': 1000}] if row.get('long') else [zero]
    graph = {'anchors': GRAPH['anchors'], 'durations': [[0, 600, 10], [600, 0, 600], [10, 600, 0]],
             'distances': [[0, 6000, 100], [6000, 0, 6000], [100, 6000, 0]]}
    config = {**CONFIG, 'fleet': 1, 'budget_vnd': 1000, 'patience_seconds': 20}
    tape = [{**QUOTE, 'id': 'Q1', 'profile': {'long': True}},
            {**QUOTE, 'id': 'Q2', 'arrival': 30., 'destination': 2},
            {**QUOTE, 'id': 'Q3', 'arrival': 60., 'origin': 2, 'destination': 0}]
    result = perfect_information_bound(config, graph, Distribution(), tape)
    assert result['completion_upper_bound'] == 2
    assert result['best_witness']['choices'][0] == ('Q1', 'negative')
    assert result['best_witness']['spent_vnd'] == 0


def test_search_limit_never_returns_partial_value_as_exact(monkeypatch):
    monkeypatch.setattr(kernel, 'draw', lambda namespace, key: .75 if key.startswith('response:') else 0.)
    config = {**CONFIG, 'quotes': 1}
    with pytest.raises(SearchLimitExceeded, match='incomplete'):
        perfect_information_bound(config, GRAPH, ControlledResponse(), [QUOTE], node_limit=1)
    with pytest.raises(ValueError):
        perfect_information_bound(config, GRAPH, ControlledResponse(), [QUOTE], node_limit=0)


def test_zero_effect_has_only_one_physical_outcome_per_episode():
    tape = [{**QUOTE, 'id': f'Q{i}', 'arrival': i*40.} for i in range(3)]
    result = perfect_information_bound({**CONFIG, 'response_scale': 0}, GRAPH, ControlledResponse(), tape)
    assert result['binary_decisions'] == 0 and result['leaf_worlds'] == 1
    assert result['best_witness']['spent_vnd'] == 0
