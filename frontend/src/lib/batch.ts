import { canonicalJson, validateExperimentConfig } from './artifact'
import { seededRandom } from './fleet'
import { csv, validateExperiment, type Experiment, type ExperimentConfig, type ArmMetrics } from './voucher'

export type Factor = 'none'|'alpha'|'beta'|'discount'|'budget'|'fleet'|'preset'
export const factorValues: Record<Factor,(number|string)[]> = { none:['base'],alpha:[.5,1.5,2.5],beta:[1,2,3],discount:[0,10000,20000],budget:[0,100000,200000],fleet:[3,5,10],preset:['Low','Medium','High'] }
export interface BatchSpec { baseSeed:string; seedCount:10|30; factor:Factor; config:ExperimentConfig; datasetFingerprint:string; routingFingerprint:string }
export interface BatchJob { id:string; seed:string; variation:number|string; config:ExperimentConfig }
export interface RunResult { job:BatchJob; status:'success'|'error'|'cancelled'; error:string|null; experimentId:string|null; baseline:ArmMetrics|null; treatment:ArmMetrics|null; increment:number|null; cpic:number|null; milliseconds:number; cacheHit:boolean; provenance:Record<string,unknown>|null }
export const statisticalDefinitions = {
  sample:'Successful paired runs only; failures/cancellations remain in records and requested denominator.',
  difference:'Treatment completed − Baseline completed, same seed and config.',
  sd:'Sample SD with n−1; null for fewer than 2 successful pairs.',
  improvement:'Count of strictly positive increments / successful pairs; simulation statistic, not real-world probability.',
  pooledCpic:'Sum Treatment settled voucher spend / sum ALL paired increments; null if denominator ≤0.',
  nullable:'Wait/utilization/budget utilization use their own valid counts; nulls are never replaced with zero.',
  uncertainty:'Empirical seed variation under PoC assumptions; no causal or commercial claim.',
} as const
export function batchJobs(spec:BatchSpec):BatchJob[] {
  validateExperimentConfig(spec.config)
  if(!spec.baseSeed.trim() || spec.baseSeed.length>128 || ![10,30].includes(spec.seedCount) || !Object.hasOwn(factorValues,spec.factor) || !spec.datasetFingerprint || !spec.routingFingerprint) throw new Error('INVALID_BATCH_CONFIG')
  // The seed stream excludes the varied factor. All OFAT groups use the same
  // ordered seeds. Backend A4 retains paired demand and random draws per run.
  const {seed:inputSeed,...seedConfig}=spec.config
  const random=seededRandom(`${spec.baseSeed}:${spec.datasetFingerprint}:${canonicalJson(seedConfig)}:batch-seeds-v1`)
  void inputSeed // Base seed replaces the single-experiment seed explicitly.
  const seeds=Array.from({length:spec.seedCount},(_,i)=>`a5-${i+1}-${Math.floor(random()*0x100000000).toString(16).padStart(8,'0')}`)
  const jobs=factorValues[spec.factor].flatMap((variation,group)=>seeds.map((seed,index)=>{
    const config=structuredClone(spec.config); config.seed=seed
    if(spec.factor==='alpha' || spec.factor==='beta') config.behavior[spec.factor]=Number(variation)
    if(spec.factor==='discount') {config.voucher.type='fixed';config.voucher.fixedAmount=Number(variation)}
    if(spec.factor==='budget') config.campaignBudget=Number(variation)
    if(spec.factor==='fleet') config.fleetSize=Number(variation)
    if(spec.factor==='preset') config.preset=variation as ExperimentConfig['preset']
    validateExperimentConfig(config)
    return {id:`${group+1}-${index+1}`,seed,variation,config}
  }))
  if(jobs.length>90) throw new Error('BATCH_JOB_LIMIT')
  return jobs
}
export function summarizeRuns(results:RunResult[]) {
  const runs=results.filter(r=>r.status==='success'), increments=runs.map(r=>r.increment!).sort((a,b)=>a-b), n=increments.length
  const sum=(a:number[])=>a.reduce((s,v)=>s+v,0), mean=(a:number[])=>a.length?sum(a)/a.length:null
  const nullable=(values:(number|null)[])=>{const valid=values.filter((v):v is number=>v!==null);return {mean:mean(valid),validCount:valid.length}}
  const totalIncrement=sum(increments), totalSpend=sum(runs.map(r=>r.treatment!.voucherSpendVnd)), average=mean(increments)
  return {successful:n,errors:results.filter(r=>r.status==='error').length,cancelled:results.filter(r=>r.status==='cancelled').length,
    mean:average,median:n?(increments[Math.floor((n-1)/2)]+increments[Math.floor(n/2)])/2:null,
    sampleSd:n>1?Math.sqrt(sum(increments.map(v=>(v-average!)**2))/(n-1)):null,
    min:n?increments[0]:null,max:n?increments[n-1]:null,empiricalDistribution:increments,
    improvementRate:n?increments.filter(v=>v>0).length/n:null,totalIncrement,totalSpend,meanSpend:mean(runs.map(r=>r.treatment!.voucherSpendVnd)),
    pooledCpic:totalIncrement>0?totalSpend/totalIncrement:null,
    budgetUtilization:nullable(runs.map(r=>r.treatment!.budget.total>0?r.treatment!.voucherSpendVnd/r.treatment!.budget.total:null)),
    waitingDifference:nullable(runs.map(r=>r.treatment!.averageWaitSeconds!==null && r.baseline!.averageWaitSeconds!==null?r.treatment!.averageWaitSeconds-r.baseline!.averageWaitSeconds:null)),
    utilizationDifference:nullable(runs.map(r=>r.treatment!.utilization!==null && r.baseline!.utilization!==null?r.treatment!.utilization-r.baseline!.utilization:null)),
  }
}
export function batchCsv(results:RunResult[]) {
  return csv([['job','seed','variation','status','error','experiment_id','baseline_completed','treatment_completed','increment','spend_vnd','cpic_vnd','wait_difference_seconds','utilization_difference','milliseconds','cache_hit','config_json','provenance_json'],...results.map(r=>[r.job.id,r.job.seed,r.job.variation,r.status,r.error,r.experimentId,r.baseline?.completed??null,r.treatment?.completed??null,r.increment,r.treatment?.voucherSpendVnd??null,r.cpic,r.baseline?.averageWaitSeconds!=null&&r.treatment?.averageWaitSeconds!=null?r.treatment.averageWaitSeconds-r.baseline.averageWaitSeconds:null,r.baseline?.utilization!=null&&r.treatment?.utilization!=null?r.treatment.utilization-r.baseline.utilization:null,r.milliseconds,r.cacheHit,JSON.stringify(r.job.config),JSON.stringify(r.provenance)])])
}
export type PrepareExperiment=(config:ExperimentConfig,signal:AbortSignal)=>Promise<Experiment>
export function batchSummaryCsv(spec:BatchSpec,results:RunResult[],status:string) {
  return csv([['scope','field','value'],['metadata','status',status],['metadata','requested',batchJobs(spec).length],['metadata','config',JSON.stringify(spec)],['metadata','seed_list',JSON.stringify([...new Set(batchJobs(spec).map(j=>j.seed))])],...Object.entries(statisticalDefinitions).map(([key,value])=>['definition',key,value]),...Object.entries(summarizeRuns(results)).map(([key,value])=>['overall',key,JSON.stringify(value)]),...[...new Set(results.map(r=>r.job.variation))].flatMap(value=>Object.entries(summarizeRuns(results.filter(r=>r.job.variation===value))).map(([key,metric])=>[String(value),key,JSON.stringify(metric)]))])
}
/** Sequential requests, session-only bounded compact cache, no playback work. */
export async function runBatch(spec:BatchSpec,prepare:PrepareExperiment,signal:AbortSignal,onResult:(r:RunResult)=>void,cache=new Map<string,RunResult>(),timeoutMilliseconds=120000) {
  const jobs=batchJobs(spec), results:RunResult[]=[]
  for(const job of jobs) {
    const started=performance.now(), key=canonicalJson({config:job.config,dataset:spec.datasetFingerprint,routing:spec.routingFingerprint,core:'paired-v1'})
    let result:RunResult
    if(signal.aborted) result={job,status:'cancelled',error:'BATCH_CANCELLED',experimentId:null,baseline:null,treatment:null,increment:null,cpic:null,milliseconds:0,cacheHit:false,provenance:null}
    else if(cache.has(key)) result={...cache.get(key)!,job,cacheHit:true,milliseconds:0}
    else {
      const controller=new AbortController(), cancel=()=>controller.abort(signal.reason)
      signal.addEventListener('abort',cancel,{once:true}); let timedOut=false
      const timer=setTimeout(()=>{timedOut=true;controller.abort(new Error('PREPARATION_TIMEOUT'))},timeoutMilliseconds)
      try {
        const e=await prepare(job.config,controller.signal); controller.signal.throwIfAborted(); validateExperiment(e)
        if(e.datasetFingerprint!==spec.datasetFingerprint || canonicalJson(e.config)!==canonicalJson(job.config) || canonicalJson(e.provenance)!==spec.routingFingerprint) throw new Error('BATCH_PROVENANCE_MISMATCH')
        const increment=e.final.treatment.completed-e.final.baseline.completed
        result={job,status:'success',error:null,experimentId:e.id,baseline:e.final.baseline,treatment:e.final.treatment,increment,cpic:increment>0?e.final.treatment.voucherSpendVnd/increment:null,milliseconds:performance.now()-started,cacheHit:false,provenance:e.provenance}
        cache.set(key,result); if(cache.size>90) cache.delete(cache.keys().next().value!)
      }catch(error){result={job,status:signal.aborted?'cancelled':'error',error:timedOut?'PREPARATION_TIMEOUT':signal.aborted?'BATCH_CANCELLED':error instanceof Error?error.message:String(error),experimentId:null,baseline:null,treatment:null,increment:null,cpic:null,milliseconds:performance.now()-started,cacheHit:false,provenance:null}}
      finally {clearTimeout(timer);signal.removeEventListener('abort',cancel)}
    }
    results.push(result);onResult(result)
  }
  return results
}
