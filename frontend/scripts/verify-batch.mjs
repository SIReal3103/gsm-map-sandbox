// Real integration harness; calls the existing loopback FastAPI core only.
import { build } from 'vite'
import { readFile,writeFile,mkdir } from 'node:fs/promises'
import { resolve,dirname } from 'node:path'
import { fileURLToPath,pathToFileURL } from 'node:url'
const frontend=resolve(dirname(fileURLToPath(import.meta.url)),'..'),root=resolve(frontend,'..'),evidence=resolve(root,'docs/evidence/a5')
await mkdir(evidence,{recursive:true})
await build({configFile:false,logLevel:'warn',build:{lib:{entry:resolve(frontend,'src/lib/batch.ts'),formats:['es'],fileName:()=> 'batch.mjs'},outDir:resolve(frontend,'.replay-tools'),emptyOutDir:false}})
const batch=await import(pathToFileURL(resolve(frontend,'.replay-tools/batch.mjs')).href)
const artifact=await import(pathToFileURL(resolve(frontend,'.replay-tools/artifact.mjs')).href)
const sample=JSON.parse(await readFile(resolve(root,'docs/evidence/a4/default.json'),'utf8'))
const controller=new AbortController();process.on('SIGINT',()=>controller.abort())
const factor=process.argv.find(a=>a.startsWith('--factor='))?.slice(9)??'none'
const spec={baseSeed:'a5-real-2026',seedCount:10,factor,config:sample.config,datasetFingerprint:sample.datasetFingerprint,routingFingerprint:artifact.canonicalJson(sample.provenance)}
let requests=0
const began=performance.now()
const results=await batch.runBatch(spec,async(config,signal)=>{
  requests++;const response=await fetch('http://127.0.0.1:8000/api/voucher-experiment/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(config),signal})
  const e=await response.json();if(!response.ok)throw new Error(JSON.stringify(e))
  if(requests===1)await writeFile(resolve(evidence,`real-first-${factor}.json`),JSON.stringify(e))
  return e
},controller.signal,r=>console.log(`${r.job.id} ${r.job.variation}: ${r.status} Δ=${r.increment} ${r.error??''}`))
const groups=[...new Set(results.map(r=>r.job.variation))].map(value=>({value,...batch.summarizeRuns(results.filter(r=>r.job.variation===value))}))
const report={schemaVersion:'gsm-paired-batch/v1',spec,definitions:batch.statisticalDefinitions,results,summary:batch.summarizeRuns(results),groups,requestedRuns:batch.batchJobs(spec).length,complete:!controller.signal.aborted,requests,milliseconds:performance.now()-began,source:'Actual local FastAPI / OSRM MLD; no mocks',createdAt:new Date().toISOString()}
await writeFile(resolve(evidence,`real-batch-${factor}.json`),JSON.stringify(report,null,2)+'\n')
await writeFile(resolve(evidence,`real-batch-${factor}.csv`),batch.batchCsv(results))
await writeFile(resolve(evidence,`real-batch-${factor}-summary.csv`),batch.batchSummaryCsv(spec,results,report.complete?'Complete':'Cancelled'))
console.log(JSON.stringify({summary:report.summary,groups,milliseconds:report.milliseconds,requests},null,2))
if(results.some(r=>r.status!=='success'))process.exitCode=1
