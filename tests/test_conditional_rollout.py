"""Exact focal expectation, budget opportunity cost and unchanged execution."""
from copy import deepcopy

import pytest

from backend.app.campaign import DEFAULT_PLANNER, simulate_campaign
from backend.app.conditional_rollout import ConditionalCampaign, probability, weighted_service, simulate_conditional_campaign
from tests.test_campaign import ControlledResponse, GRAPH, CONFIG, QUOTE


def world(bundle=None,**config):
    c=ConditionalCampaign({**CONFIG,'quotes':1,**config},GRAPH,bundle or ControlledResponse(),'evaluation')
    c.vehicles[0].update(position=0,initial=0)
    c.vehicles[1].update(position=2,initial=2)
    c.planner.update(draws=1,minimum_requests=0,minimum_pickups=0)
    return c


def test_focal_probability_is_integrated_even_with_one_future_draw():
    c=world();before=deepcopy(c.observed())
    action,detail=c.rank(QUOTE,'state_aware')
    assert action['arm']=='paid'
    assert action['gain']==pytest.approx((1-1e-7)-.5)
    assert detail['candidates'][0]['gain']==0
    assert detail['baseline']['requests']==.5
    assert c.observed()==before and not c.heap


def test_budget_held_for_focal_offer_cannot_be_ignored_in_gain():
    class Response(ControlledResponse):
        def candidates(self,row,eta,time=None):
            q0=.5 if row.get('role')=='root' else 0.
            return [{'arm':'none','q':q0,'delta':0.,'liability':0},
                    {'arm':'paid','q':1.,'delta':1-q0,'liability':5000}]
    c=world(Response(),quotes=2,budget_vnd=5000)
    c.forecast=lambda namespace:[{**QUOTE,'id':'F2','arrival':30.,'profile':{'role':'future'}}]
    root={**QUOTE,'profile':{'role':'root'}}
    selected,detail=c.rank(root,'state_aware')
    paid=detail['candidates'][1]
    assert paid['delta']==.5
    assert paid['gain']==pytest.approx(-.5,abs=1e-6)
    assert selected['arm']=='none'


def test_response_and_fleet_receive_same_weighted_service_screens():
    c=world();_,a=c.rank(QUOTE,'response');_,b=c.rank(QUOTE,'state_aware')
    assert a['candidates']==b['candidates'] and a['baseline']==b['baseline']
    c.config['response_scale']=0
    _,hidden=c.rank(QUOTE,'state_aware')
    assert hidden==b


def test_weighted_tail_counts_probability_mass_and_empty_samples():
    slow={'requested':1,'completed':1,'unserved':0,'cancelled':0,'waits':[90]}
    fast={**slow,'waits':[10]}
    a=weighted_service([(.04,slow),(.96,fast)])
    b=weighted_service([(.06,slow),(.94,fast)])
    assert a['requests']==1 and a['pickups']==1 and a['wait_p95']==10
    assert b['wait_p95']==90
    assert weighted_service([])['unserved'] is None


def test_zero_budget_and_no_offer_execution_match_frozen_kernel():
    config={**CONFIG,'budget_vnd':0}
    bundle=ControlledResponse();bundle.data={**bundle.data,'profiles':[{'origin_anchor':0,'destination_anchor':1}]}
    for policy in ('no_offer','response','state_aware'):
        old=simulate_campaign(config,GRAPH,bundle,policy)
        new=simulate_conditional_campaign(config,GRAPH,bundle,policy)
        for field in ('quotes','legs','events','summary','cost_events','duration'):
            assert old[field]==new[field]


def test_probability_clipping_matches_execution_and_invalid_input_fails():
    assert probability(0)==1e-7 and probability(1)==1-1e-7
    for value in (-1,float('nan'),2):
        with pytest.raises(ValueError):probability(value)
