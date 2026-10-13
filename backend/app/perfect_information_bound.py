"""Offline perfect-information completion bound; never a serving policy.

Relaxes rollout service screens while retaining supported offers, current-state
admission, exact budget, nearest-idle dispatch and the fixed realized quote tape.
Future response/timing draws are deliberately visible only in this diagnostic.
It bounds achievable completions on that tape, not real GMS or a population mean.
"""
from copy import deepcopy
import math

from . import campaign as kernel


class SearchLimitExceeded(RuntimeError):
    """An unfinished search cannot be reported as an exact upper bound."""


def realized_probability(q0, action, scale):
    value = q0+scale*(action['q']-q0)
    if not math.isfinite(value):
        raise ValueError('Nonfinite oracle response probability')
    return min(1-1e-7, max(1e-7, value))


def outcome_representatives(actions, response_draw, scale):
    # Equal realized request/no-request implies equal timing and physical path.
    # A cheaper commitment leaves every future physical/action option available;
    # therefore only its cheapest representative is needed for each outcome.
    q0 = actions[0]['q']
    groups = {}
    for action in actions:
        accepted = response_draw < realized_probability(q0, action, scale)
        old = groups.get(accepted)
        if old is None or (action['liability'], action['arm']) < (old['liability'], old['arm']):
            groups[accepted] = action
    return list(groups.values())


def perfect_information_bound(config, network, bundle, tape=None, node_limit=100000):
    if isinstance(node_limit, bool) or not isinstance(node_limit, int) or node_limit < 1:
        raise ValueError('Positive integer search limit required')
    scale = config.get('response_scale', 1.)
    if not math.isfinite(scale) or scale < 0:
        raise ValueError('Finite nonnegative response scale required')
    quotes = kernel.quote_tape(config, bundle, f'exogenous:{config["seed"]}') if tape is None else deepcopy(tape)
    if len(quotes) != config['quotes'] or len({q['id'] for q in quotes}) != len(quotes):
        raise ValueError('Oracle quote population mismatch')
    if any(left['arrival'] > right['arrival'] for left, right in zip(quotes, quotes[1:])):
        raise ValueError('Oracle quote tape must be ordered')
    world = kernel.Campaign(config, network, bundle, f'evaluation:{config["seed"]}', record=False)
    visited = leaves = branches = 0

    def clone(state):
        return deepcopy(state, {id(bundle): bundle, id(network): network})

    def solve(state, index, choices):
        nonlocal visited, leaves, branches
        visited += 1
        if visited > node_limit:
            raise SearchLimitExceeded('Perfect-information search incomplete; no exact bound')
        while index < len(quotes):
            quote = quotes[index]
            state.advance(quote['arrival'])
            actions = state.feasible(quote)
            representatives = outcome_representatives(actions, kernel.draw(state.namespace, f'response:{quote["id"]}'), scale)
            if len(representatives) > 1:
                branches += 1
                results = []
                for action in representatives:
                    child = clone(state)
                    child.issue(quote, action, scale)
                    results.append(solve(child, index+1, choices+[(quote['id'], action['arm'])]))
                return max(results, key=lambda result: (result['completed'], -result['spent_vnd']))
            action = representatives[0]
            state.issue(quote, action, scale)
            choices.append((quote['id'], action['arm']))
            index += 1
        state.advance(state.endpoint)
        if state.reserved or state.queue or any(q['status'] in ('pending', 'queued', 'assigned', 'onboard') for q in state.quotes.values()):
            raise ValueError('Unresolved oracle terminal state')
        leaves += 1
        outcome = state.outcomes()
        return {'completed': outcome['completed'], 'requested': outcome['requested'],
                'unserved': outcome['unserved'], 'spent_vnd': state.spent, 'choices': choices}

    result = solve(world, 0, [])
    return {'version': 'perfect-information-completion-bound/v1', 'status': 'EXACT',
            'completion_upper_bound': result['completed'], 'best_witness': result,
            'search_nodes': visited, 'leaf_worlds': leaves, 'binary_decisions': branches,
            'screens_relaxed': True, 'future_draws_visible': True, 'serving_policy': False,
            'interpretation': 'Realized fixed-tape relaxation only; no guarantee about population mean, causal response, service feasibility or real GMS'}
