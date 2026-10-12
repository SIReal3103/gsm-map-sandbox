import { act,renderHook } from '@testing-library/react'
import { describe,it,expect,vi,beforeEach } from 'vitest'
import recorded from '../../docs/evidence/a4/default.json'
import manifest from '../../contracts/replay-asset-manifest.json'
import { exportArtifact } from '../src/lib/artifact'
import type { Experiment } from '../src/lib/voucher'
import { useVoucher } from '../src/lib/use-voucher'
const mocks=vi.hoisted(()=>({assets:vi.fn()}))
vi.mock('../src/lib/replay-assets',()=>({loadReplayAssets:mocks.assets}))
const file=(text:string)=>({size:text.length,text:async()=>text} as File)
beforeEach(()=>{mocks.assets.mockResolvedValue({manifest,layers:{}});vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('LIVE_API_NOT_ALLOWED')}))})
describe('Saved hook boundary (unit mocks; actual static proof in browser)',()=>{
  it('rejects a different region even if an author reuses the claimed fingerprint',async()=>{
    const value=structuredClone(recorded) as unknown as Experiment
    value.provenance.display_bbox=[-180,-90,180,90]
    for(const arm of ['baseline','treatment'] as const)value[arm].plan.provenance.display_bbox=[-180,-90,180,90]
    const artifact=await exportArtifact(value,manifest.id),{result}=renderHook(()=>useVoucher(true,false,'saved'))
    await act(async()=>{await result.current.loadSaved(file(JSON.stringify(artifact)))})
    expect(result.current.experiment).toBeNull();expect(result.current.error).toContain('REPLAY_ASSET_MISMATCH')
  })
  it('ignores backend readiness and preserves valid session on malformed import',async()=>{
    const artifact=await exportArtifact(recorded as unknown as Experiment,manifest.id)
    const {result,unmount}=renderHook(()=>useVoucher(true,false,'saved'))
    await act(async()=>{await result.current.loadSaved(file(JSON.stringify(artifact)))})
    expect(result.current.experiment?.id).toBe(artifact.experimentId)
    expect(fetch).not.toHaveBeenCalled()
    await act(async()=>{result.current.clock.seek(500);await result.current.loadSaved(file('{bad'))})
    expect(result.current.experiment?.id).toBe(artifact.experimentId);expect(result.current.clock.getSnapshot().simulationTimeSeconds).toBe(500)
    expect(result.current.error).toContain('Malformed');unmount()
  })
  it('resets selection and time only after a new validated import',async()=>{
    const artifact=await exportArtifact(recorded as unknown as Experiment,manifest.id),{result}=renderHook(()=>useVoucher(true,false,'saved'))
    await act(async()=>{await result.current.loadSaved(file(JSON.stringify(artifact)))})
    act(()=>{result.current.clock.seek(500);result.current.setSelectedVehicleId('GSM-01')})
    await act(async()=>{await result.current.loadSaved(file(JSON.stringify(artifact)))})
    expect(result.current.clock.getSnapshot().simulationTimeSeconds).toBe(0);expect(result.current.selectedVehicleId).toBeNull()
  })
  it('discards an older import finishing after replacement',async()=>{
    const artifact=await exportArtifact(recorded as unknown as Experiment,manifest.id),{result}=renderHook(()=>useVoucher(true,false,'saved'))
    let finish!:(text:string)=>void
    const old={size:1,text:()=>new Promise<string>(resolve=>{finish=resolve})} as File
    let pending!:Promise<void>;act(()=>{pending=result.current.loadSaved(old)})
    await act(async()=>{await result.current.loadSaved(file(JSON.stringify(artifact)))})
    await act(async()=>{finish('{bad');await pending})
    expect(result.current.experiment?.id).toBe(artifact.experimentId);expect(result.current.error).toBe('')
  })
  it('never prepares new OSRM experiments in Saved runtime',async()=>{
    const {result}=renderHook(()=>useVoucher(true,true,'saved'))
    await act(async()=>{await result.current.generate(recorded.config as Experiment['config'])})
    expect(fetch).not.toHaveBeenCalled()
  })
  it('refuses wrong static fingerprint without publishing the artifact',async()=>{
    mocks.assets.mockResolvedValue({manifest:{...manifest,datasetFingerprint:'wrong'},layers:{}})
    const artifact=await exportArtifact(recorded as unknown as Experiment,manifest.id),{result}=renderHook(()=>useVoucher(true,false,'saved'))
    await act(async()=>{await result.current.loadSaved(file(JSON.stringify(artifact)))})
    expect(result.current.experiment).toBeNull();expect(result.current.error).toContain('REPLAY_ASSET_MISMATCH')
  })
})
