import { describe,it,expect } from 'vitest'
import recorded from '../../docs/evidence/a4/default.json'
import { batchJobs,runBatch,summarizeRuns,batchCsv, type BatchSpec, type RunResult } from '../src/lib/batch'
import { canonicalJson } from '../src/lib/artifact'
import { type Experiment,defaultExperimentConfig } from '../src/lib/voucher'
const e=recorded as unknown as Experiment
const spec=(factor:BatchSpec['factor']='none'):BatchSpec=>({baseSeed:'test',seedCount:10,factor,config:defaultExperimentConfig,datasetFingerprint:e.datasetFingerprint,routingFingerprint:canonicalJson(e.provenance)})
const result=(increment:number,spend:number):RunResult=>({job:batchJobs(spec())[0],status:'success',error:null,experimentId:'fixture',baseline:{...structuredClone(e.final.baseline),completed:10},treatment:{...structuredClone(e.final.treatment),completed:10+increment,voucherSpendVnd:spend},increment,cpic:increment>0?spend/increment:null,milliseconds:1,cacheHit:false,provenance:e.provenance})
describe('A5 paired batch (statistical fixtures, not research outcomes)',()=>{
  it('produces repeatable unique seeds, same seed stream across OFAT groups',()=>{
    expect(batchJobs(spec())).toEqual(batchJobs(spec()))
    const jobs=batchJobs(spec('beta'));expect(jobs.slice(0,10).map(j=>j.seed)).toEqual(jobs.slice(10,20).map(j=>j.seed))
    expect(new Set(jobs.map(j=>j.id)).size).toBe(30)
    expect(jobs[0].config.behavior.beta).toBe(1);expect(jobs[20].config.behavior.beta).toBe(3)
    expect(batchJobs({...spec(),config:{...defaultExperimentConfig,potentialCount:20}})[0].seed).not.toBe(batchJobs(spec())[0].seed)
  })
  it('bounds jobs at 90 and varies exactly the selected factor',()=>{
    expect(batchJobs({...spec('fleet'),seedCount:30})).toHaveLength(90)
    for(const job of batchJobs(spec('budget')))expect({...job.config,seed:'x',campaignBudget:0}).toEqual({...defaultExperimentConfig,seed:'x',campaignBudget:0})
    expect(()=>batchJobs({...spec(),seedCount:100 as 10})).toThrow()
  })
  it('keeps zero and negative increments in SD, distribution and pooled denominator',()=>{
    const s=summarizeRuns([result(-1,100),result(0,100),result(4,100)])
    expect(s.mean).toBe(1);expect(s.median).toBe(0);expect(s.sampleSd).toBeCloseTo(Math.sqrt(7))
    expect(s.pooledCpic).toBe(100);expect(s.improvementRate).toBe(1/3)
    expect(s.empiricalDistribution).toEqual([-1,0,4])
  })
  it('uses nulls for empty, single, nonpositive and unavailable samples',()=>{
    expect(summarizeRuns([]).mean).toBeNull();expect(summarizeRuns([result(0,100)]).sampleSd).toBeNull()
    expect(summarizeRuns([result(-1,100),result(1,100)]).pooledCpic).toBeNull()
    const r=result(2,100);r.baseline!.averageWaitSeconds=null;r.treatment!.budget.total=0
    expect(summarizeRuns([r]).waitingDifference).toEqual({mean:null,validCount:0})
    expect(summarizeRuns([r]).budgetUtilization.validCount).toBe(0)
  })
  it('sequentially retains failures and progress without silently changing seeds',async()=>{
    let active=0,max=0;const called:string[]=[],progress:RunResult[]=[]
    const results=await runBatch(spec(),async config=>{active++;max=Math.max(max,active);called.push(config.seed);await Promise.resolve();active--;throw new Error('ROUTER_UNAVAILABLE')},new AbortController().signal,r=>progress.push(r))
    expect(max).toBe(1);expect(results).toHaveLength(10);expect(progress).toHaveLength(10);expect(called).toEqual(batchJobs(spec()).map(j=>j.seed))
    expect(summarizeRuns(results).errors).toBe(10);expect(summarizeRuns(results).successful).toBe(0)
  })
  it('aborts the active request and records unscheduled jobs as cancelled',async()=>{
    const controller=new AbortController();let calls=0
    const results=await runBatch(spec(),async(_config,signal)=>{calls++;controller.abort();signal.throwIfAborted();return e},controller.signal,()=>{})
    expect(calls).toBe(1);expect(results.every(r=>r.status==='cancelled')).toBe(true)
  })
  it('timeouts terminate cooperative requests and remain errors, not fake runs',async()=>{
    const results=await runBatch(spec(),async(_config,signal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})),new AbortController().signal,()=>{},new Map(),1)
    expect(results.every(r=>r.error==='PREPARATION_TIMEOUT')).toBe(true)
  })
  it('rejects wrong dataset/config from a stale or mismatched response',async()=>{
    const results=await runBatch(spec(),async()=>e,new AbortController().signal,()=>{})
    expect(results.every(r=>r.status==='error' && r.error==='BATCH_PROVENANCE_MISMATCH')).toBe(true)
  })
  it('CSV retains errors, nulls and negative increments with exact run config',()=>{
    const text=batchCsv([result(-1,100)]);expect(text).toContain('"-1"');expect(text).toContain('config_json');expect(text).toContain('provenance_json')
  })
  it('caches compact validated successes only for identical config/dataset/router',async()=>{
    const cache=new Map<string,RunResult>();let calls=0
    const prepare=async(config:Experiment['config'])=>{calls++;const value=structuredClone(e);value.seed=config.seed;value.config=config;for(const arm of ['baseline','treatment'] as const){value[arm].plan.seed=config.seed;value[arm].plan.config.seed=config.seed}return value}
    const first=await runBatch(spec(),prepare,new AbortController().signal,()=>{},cache)
    expect(first.every(r=>r.status==='success')).toBe(true)
    const second=await runBatch(spec(),prepare,new AbortController().signal,()=>{},cache)
    expect(calls).toBe(10);expect(second.every(r=>r.cacheHit)).toBe(true)
    await runBatch({...spec(),routingFingerprint:'changed'},prepare,new AbortController().signal,()=>{},cache)
    expect(calls).toBe(20)
  })
})
