import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { FleetClock } from './fleet-clock'
import { validateExperiment, type Experiment, type ExperimentConfig, type ArmName } from './voucher'
import { importArtifact, importLimits, sameData, type ExperimentArtifact } from './artifact'
import { loadReplayAssets, type ReplayAssets } from './replay-assets'

export function useVoucher(active: boolean, ready: boolean, runtime: 'live'|'saved'='live') {
  const [clock] = useState(() => new FleetClock()), [experiment, setExperiment] = useState<Experiment | null>(null)
  const [arm, setArm] = useState<ArmName>('treatment'), [loading, setLoading] = useState(false), [error, setError] = useState('')
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null), [selectedBookingId, setSelectedBookingId] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  const [replayAssets,setReplayAssets]=useState<ReplayAssets|null>(null), [artifact,setArtifact]=useState<ExperimentArtifact|null>(null)
  const clear = useCallback(() => { request.current?.abort(); clock.configure(0); setExperiment(null); setReplayAssets(null); setArtifact(null); setError(''); setLoading(false); setSelectedVehicleId(null); setSelectedBookingId(null) }, [clock])
  useEffect(() => { if (!active || (runtime==='live' && !ready)) clear() }, [active, ready, runtime, clear])
  useEffect(() => { clear() }, [runtime,clear])
  useEffect(() => () => { request.current?.abort(); clock.dispose() }, [clock])
  const selectArm = (next: ArmName) => { setArm(next); setSelectedBookingId(null); setSelectedVehicleId(null) }
  const generate = async (config: ExperimentConfig) => {
    if (!active || !ready || runtime!=='live') return
    clear(); const controller = new AbortController(); request.current = controller; setLoading(true)
    try {
      const data = await api<Experiment>('/api/voucher-experiment/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config), signal: controller.signal })
      controller.signal.throwIfAborted(); validateExperiment(data); setExperiment(data); clock.configure(data.simulationDurationSeconds)
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (!controller.signal.aborted) setLoading(false) }
  }
  const loadSaved=async(source:File|'demo')=>{
    if(!active || runtime!=='saved') return
    request.current?.abort(); const controller=new AbortController(); request.current=controller; setLoading(true); setError('')
    try {
      if(source!=='demo' && source.size>importLimits.bytes) throw new Error('INVALID_SAVED_ARTIFACT: File lớn hơn 12 MiB.')
      const text=source==='demo' ? await (async()=>{const response=await fetch(import.meta.env.BASE_URL+'replay/demo-experiment.json',{signal:controller.signal}); if(!response.ok) throw new Error('DEMO_ARTIFACT_MISSING'); const bytes=new Uint8Array(await response.arrayBuffer()); if(bytes.length>importLimits.bytes) throw new Error('ARTIFACT_TOO_LARGE'); return new TextDecoder('utf-8',{fatal:true}).decode(bytes)})() : await source.text()
      const validated=await importArtifact(text), assets=replayAssets ?? await loadReplayAssets(controller.signal)
      controller.signal.throwIfAborted()
      if(validated.assetManifestReference.id!==assets.manifest.id || validated.datasetFingerprint!==assets.manifest.datasetFingerprint || validated.payload.provenance.streets_sha256!==assets.manifest.sourceStreetsSha256 || !sameData(validated.payload.provenance.display_bbox,assets.manifest.displayBbox)) throw new Error('REPLAY_ASSET_MISMATCH: Dataset/manifest/bbox không tương ứng.')
      // Commit a replacement only after both artifact and map package validation.
      setExperiment(validated.payload); setArtifact(validated); setReplayAssets(assets); setSelectedVehicleId(null); setSelectedBookingId(null); clock.configure(validated.payload.simulationDurationSeconds)
    } catch(e) { if(!controller.signal.aborted) setError(e instanceof Error?e.message:String(e)) }
    finally {if(!controller.signal.aborted) setLoading(false)}
  }
  return { experiment, clock, arm, selectArm, clear, generate, loadSaved, runtime, replayAssets, artifact, loading, error, selectedBookingId, selectedVehicleId, setSelectedBookingId, setSelectedVehicleId,
    mapSession: { clock, plan: experiment?.[arm].plan ?? null, selectedBookingId, selectedVehicleId, setSelectedBookingId, setSelectedVehicleId } }
}
export type VoucherSession = ReturnType<typeof useVoucher>
