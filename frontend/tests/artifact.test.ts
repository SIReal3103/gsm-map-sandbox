import { describe,it,expect } from 'vitest'
import recorded from '../../docs/evidence/a4/default.json'
import { canonicalJson,contentHash,exportArtifact,importArtifact,validatePortableExperiment,importLimits } from '../src/lib/artifact'
import type { Experiment } from '../src/lib/voucher'
import { validateAssetManifest } from '../src/lib/replay-assets'
import manifest from '../../contracts/replay-asset-manifest.json'

const source=()=>structuredClone(recorded) as unknown as Experiment
const packageId=manifest.id
async function mutate(change:(artifact:Awaited<ReturnType<typeof exportArtifact>>)=>void) {
  const artifact=await exportArtifact(source(),packageId); change(artifact)
  const {integrity,...body}=artifact; integrity.digest=await contentHash(body)
  return JSON.stringify(artifact)
}
describe('portable experiment v1 (recorded real OSRM A4 fixture)',()=>{
  it.each(['metadata','snap'])('rejects invalid %s numeric fields even with a new digest',async(kind)=>{
    const json=await mutate(a=>{if(kind==='metadata')a.payload.preparationMilliseconds={} as never;else a.payload.provenance.max_snap_meters=1e9})
    await expect(importArtifact(json)).rejects.toThrow('INVALID_SAVED_ARTIFACT')
  })
  it.each(['reason','event'])('rejects invalid typed %s payload after checksum recomputation',async(kind)=>{
    const json=await mutate(a=>{if(kind==='reason')a.payload.treatment.decisions[0].reason={} as never;else a.payload.treatment.plan.events[0].payload={unexpected:1}})
    await expect(importArtifact(json)).rejects.toThrow('INVALID_SAVED_ARTIFACT')
  })
  it('rejects unsupported model versions and duplicate offers, even rehashed',async()=>{
    await expect(importArtifact(await mutate(a=>{(a.payload.assumptions.versions as Record<string,string>).behavior='future-v999'}))).rejects.toThrow('Unsupported model')
    await expect(importArtifact(await mutate(a=>{const l=a.payload.treatment.ledger.find(l=>l.type==='OFFERED')!;a.payload.treatment.ledger.splice(1,0,{...l,id:'duplicate-offer'})}))).rejects.toThrow('Duplicate')
  })
  it('keeps HTML-looking strings as JSON text without executing them',async()=>{
    const e=source();e.assumptions.safeString='<img src=x onerror=alert(1)>'
    const roundtrip=await importArtifact(JSON.stringify(await exportArtifact(e,packageId)))
    expect(roundtrip.payload.assumptions.safeString).toBe(e.assumptions.safeString)
  })
  it('round-trips the complete plan, ledgers and exports without losing fields',async()=>{
    const e=source(), artifact=await exportArtifact(e,packageId)
    expect((await importArtifact(JSON.stringify(artifact))).payload).toEqual(e)
    expect(Object.isFrozen((await importArtifact(JSON.stringify(artifact))).payload.treatment.plan.events)).toBe(true)
    expect(artifact.schemaVersion).toBe('gsm-voucher-experiment/v1')
  })
  it('canonicalization sorts keys, preserves arrays and is used by packaging too',async()=>{
    expect(canonicalJson({z:[2,1],a:'Tiếng Việt'})).toBe('{"a":"Tiếng Việt","z":[2,1]}')
    expect(await contentHash({a:1,b:2})).toBe(await contentHash({b:2,a:1}))
  })
  it('rejects tampered content before accepting a saved session',async()=>{
    const a=await exportArtifact(source(),packageId); a.payload.seed='changed'
    await expect(importArtifact(JSON.stringify(a))).rejects.toThrow('Checksum')
  })
  it.each(['schema','required','geometry','reference','timestamp','budget','accounting','series','continuity','duration'])('rejects %s semantic inconsistency even with a recomputed hash',async(kind)=>{
    const json=await mutate(a=>{
      const e=a.payload
      if(kind==='schema') (a as {schemaVersion:string}).schemaVersion='gsm-voucher-experiment/v2'
      if(kind==='required') delete (e as Partial<Experiment>).config
      if(kind==='geometry') e.baseline.plan.assignments[0].tripRoute.coordinates[0][0]=181
      if(kind==='reference') e.baseline.plan.events[0].bookingId='missing'
      if(kind==='timestamp') e.baseline.plan.events[0].timestampSeconds+=1
      if(kind==='budget') e.treatment.ledger[0].available=-1
      if(kind==='accounting') e.final.treatment.riderPaymentsVnd+=1
      if(kind==='series') e.timeSeries[0].treatment.completed+=1
      if(kind==='continuity') e.baseline.plan.vehicles[0].initialPosition=[106.72,10.79]
      if(kind==='duration') e.simulationDurationSeconds+=1
    })
    await expect(importArtifact(json)).rejects.toThrow()
  })
  it('rejects malformed, oversized, unsafe object keys and legacy JSON explicitly',async()=>{
    await expect(importArtifact('{')).rejects.toThrow('Malformed')
    await expect(importArtifact(' '.repeat(importLimits.bytes+1))).rejects.toThrow('12 MiB')
    await expect(importArtifact('{"__proto__":{}}')).rejects.toThrow('Object key')
    await expect(importArtifact(JSON.stringify(source()))).rejects.toThrow()
  })
  it('keeps volatile preparation metadata outside experiment identity but inside integrity',async()=>{
    const first=await exportArtifact(source(),packageId), second=source(); second.preparationMilliseconds+=100
    const altered=await exportArtifact(second,packageId)
    expect(first.experimentId).toBe(altered.experimentId); expect(first.integrity.digest).not.toBe(altered.integrity.digest)
  })
  it('validates the trusted manifest and rejects external/path traversal resources',async()=>{
    await expect(validateAssetManifest(structuredClone(manifest) as never)).resolves.toMatchObject({id:packageId})
    const bad=structuredClone(manifest); bad.files[0].path='https://example.com/map.json'
    await expect(validateAssetManifest(bad as never)).rejects.toThrow('untrusted path')
  })
  it('rejects nonfinite and excessively nested programmatic input',()=>{
    const e=source(); e.config.behavior.beta=Infinity
    expect(()=>validatePortableExperiment(e)).toThrow('finite')
    let nested:unknown={}; for(let i=0;i<34;i++) nested={nested}
    const e2=source(); e2.assumptions.nested=nested; expect(()=>validatePortableExperiment(e2)).toThrow('nesting')
  })
})
