import { memo, useEffect, useRef, useState } from 'react'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis, ReferenceLine, ScatterChart, Scatter } from 'recharts'
import { Button } from './ui/button'
import { ChartContainer, ChartTooltip, ChartTooltipContent } from './ui/chart'
import { ChartViewport } from './chart-viewport'
import { api } from '@/lib/api'
import { canonicalJson } from '@/lib/artifact'
import { batchJobs, batchCsv, batchSummaryCsv, runBatch, summarizeRuns, statisticalDefinitions, factorValues, type BatchSpec, type Factor, type RunResult } from '@/lib/batch'
import { download, vnd, type Experiment } from '@/lib/voucher'

function BatchAnalysis({ experiment,live }: {experiment:Experiment;live:boolean}) {
  const [baseSeed,setBaseSeed]=useState(experiment.seed),[count,setCount]=useState<10|30>(10),[factor,setFactor]=useState<Factor>('none')
  const [results,setResults]=useState<RunResult[]>([]),[spec,setSpec]=useState<BatchSpec|null>(null),[running,setRunning]=useState(false),[status,setStatus]=useState('Chưa chạy'),[error,setError]=useState('')
  const controller=useRef<AbortController|null>(null),cache=useRef(new Map<string,RunResult>())
  useEffect(()=>()=>controller.current?.abort(),[])
  const start=async()=>{
    if(!live || running)return
    const next:BatchSpec={baseSeed,seedCount:count,factor,config:experiment.config,datasetFingerprint:experiment.datasetFingerprint,routingFingerprint:canonicalJson(experiment.provenance)}
    try {batchJobs(next)}catch(e){setError(String(e));return}
    controller.current?.abort();const request=new AbortController();controller.current=request
    setSpec(next);setResults([]);setError('');setRunning(true);setStatus('Đang chạy sequential · local OSRM')
    try {await runBatch(next,(config,signal)=>api<Experiment>('/api/voucher-experiment/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(config),signal}),request.signal,result=>{if(controller.current===request)setResults(previous=>[...previous,result])},cache.current)
      if(controller.current===request)setStatus(request.signal.aborted?'Cancelled — partial results':'Complete — tất cả jobs đã có kết quả')
    }catch(e){if(controller.current===request){setError(String(e));setStatus('Failed — partial results')}}
    finally {if(controller.current===request)setRunning(false)}
  }
  const summary=summarizeRuns(results),groups=[...new Set(results.map(r=>r.job.variation))].map(value=>({value,...summarizeRuns(results.filter(r=>r.job.variation===value))}))
  const total=spec?batchJobs(spec).length:count*factorValues[factor].length
  const exportData={schemaVersion:'gsm-paired-batch/v1',status,complete:!running&&results.length===total&&!results.some(r=>r.status==='cancelled'),requestedRuns:total,spec,definitions:statisticalDefinitions,results,summary,groups,modelVersions:experiment.assumptions.versions}
  return <section className="batch-analysis" aria-label="Batch Experiment Analysis" data-batch-status={status} data-batch-summary={JSON.stringify(summary)}>
    <h3>Batch Experiment Analysis</h3><p>Paired simulation · OFAT · tối đa 90 jobs · chỉ bắt đầu khi bấm Run. Cùng seed list cho mọi giá trị của factor.</p>
    <div className="booking-inputs">
      <label>Base seed<input aria-label="Batch base seed" value={baseSeed} maxLength={128} disabled={running} onChange={e=>setBaseSeed(e.target.value)}/></label>
      <label>Seeds<select aria-label="Batch seeds" value={count} disabled={running} onChange={e=>setCount(Number(e.target.value) as 10|30)}><option value={10}>10</option><option value={30}>30</option></select></label>
      <label>One factor<select aria-label="Sensitivity factor" value={factor} disabled={running} onChange={e=>setFactor(e.target.value as Factor)}>{Object.keys(factorValues).map(v=><option key={v} value={v}>{v}</option>)}</select></label>
    </div>
    <p>{factor}: {factorValues[factor].join(' / ')} · {count*factorValues[factor].length} jobs trong cấu hình kế tiếp. Discount preset = fixed VND policy; các factor khác giữ voucher policy đang cấu hình.</p>
    {!live&&<p>Saved Replay: xem/export replay; chạy batch mới cần Live Local backend + OSRM.</p>}
    <Button disabled={!live||running} onClick={()=>void start()}>Run Batch</Button> <Button variant="outline" disabled={!running} onClick={()=>controller.current?.abort()}>Cancel Batch</Button>
    <p role="status">{status} · {results.length}/{total} records · {summary.successful} successful · {summary.errors} errors · {summary.cancelled} cancelled</p>
    {error&&<p role="alert">{error}</p>}
    {results.length>0&&<>
      {spec?.factor!=='none'&&<p>Summary chung cộng các nhóm tham số. Dùng Parameter Sensitivity và JSON groups để so sánh theo nhóm; các seed lặp giữa nhóm không phải mẫu độc lập.</p>}
      <p>Mean Δ {summary.mean?.toFixed(2)??'N/A'} · median {summary.median??'N/A'} · sample SD {summary.sampleSd?.toFixed(2)??'N/A'} · min/max {summary.min??'N/A'}/{summary.max??'N/A'}<br/>Improvement {summary.improvementRate===null?'N/A':(summary.improvementRate*100).toFixed(1)+'%'} (n={summary.successful}) · mean spend {vnd(summary.meanSpend)} · pooled CPIC {vnd(summary.pooledCpic)}</p>
      <p>Budget utilization {summary.budgetUtilization.mean?.toFixed(3)??'N/A'} (n={summary.budgetUtilization.validCount}) · wait Δ {summary.waitingDifference.mean?.toFixed(2)??'N/A'} s (n={summary.waitingDifference.validCount}) · utilization Δ {summary.utilizationDifference.mean?.toFixed(3)??'N/A'} (n={summary.utilizationDifference.validCount})</p>
      <ChartViewport title="Paired Increment Distribution"><div className="experiment-chart"><h4>Paired Increment Distribution</h4><ChartContainer config={{increment:{label:'Completed Δ',color:'var(--chart-1)'}}} style={{height:240,aspectRatio:'auto'}}><BarChart data={results.filter(r=>r.status==='success').map(r=>({seed:r.job.seed+' / '+r.job.variation,increment:r.increment,spend:r.treatment!.voucherSpendVnd}))}><CartesianGrid vertical={false}/><XAxis dataKey="seed" hide/><YAxis domain={['auto','auto']} allowDecimals={false}/><ReferenceLine y={0}/><ChartTooltip content={<ChartTooltipContent/>}/><Bar dataKey="increment" fill="var(--chart-1)" isAnimationActive={false}/></BarChart></ChartContainer></div></ChartViewport>
      <ChartViewport title="Voucher Spend vs Incremental Completions"><div className="experiment-chart"><h4>Voucher Spend vs Incremental Completions</h4><ChartContainer config={{spend:{label:'Settled VND',color:'var(--chart-2)'}}} style={{height:240,aspectRatio:'auto'}}><ScatterChart><CartesianGrid/><XAxis type="number" dataKey="increment" name="Completed Δ" domain={['auto','auto']}/><YAxis type="number" dataKey="spend" name="Spend VND"/><ChartTooltip content={<ChartTooltipContent labelFormatter={(label,payload)=>payload?.[0]?.payload?.seed??label}/>}/><Scatter data={results.filter(r=>r.status==='success').map(r=>({seed:r.job.seed,increment:r.increment,spend:r.treatment!.voucherSpendVnd}))} fill="var(--chart-2)" isAnimationActive={false}/></ScatterChart></ChartContainer></div></ChartViewport>
      {factor!=='none'&&<ChartViewport title="Parameter Sensitivity"><div className="experiment-chart"><h4>Parameter Sensitivity · mean completed Δ</h4><ChartContainer config={{mean:{label:'Mean Δ',color:'var(--chart-1)'}}} style={{height:240,aspectRatio:'auto'}}><BarChart data={groups}><CartesianGrid vertical={false}/><XAxis dataKey="value"/><YAxis domain={['auto','auto']}/><ReferenceLine y={0}/><ChartTooltip content={<ChartTooltipContent/>}/><Bar dataKey="mean" fill="var(--chart-1)" isAnimationActive={false}/></BarChart></ChartContainer></div></ChartViewport>}
      <Button variant="outline" onClick={()=>download('gsm-batch-v1.json',JSON.stringify({...exportData,createdAt:new Date().toISOString()},null,2),'application/json')}>Export Batch JSON</Button> <Button variant="outline" onClick={()=>download('gsm-batch-runs.csv',batchCsv(results),'text/csv;charset=utf-8')}>Export Batch CSV</Button>
      <Button variant="outline" onClick={()=>download('gsm-batch-summary.csv',batchSummaryCsv(spec!,results,status),'text/csv;charset=utf-8')}>Export Batch Summary CSV</Button>
      <details><summary>Run records và statistical definitions</summary><p>{Object.values(statisticalDefinitions).join(' ')}</p><table><thead><tr><th>Seed / factor</th><th>Status</th><th>Δ</th><th>Reason</th></tr></thead><tbody>{results.map(r=><tr key={r.job.id}><td>{r.job.seed} / {r.job.variation}</td><td>{r.status}</td><td>{r.increment??'N/A'}</td><td>{r.error??'—'}</td></tr>)}</tbody></table></details>
    </>}
  </section>
}
export default memo(BatchAnalysis)
