import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { FleetClock } from './fleet-clock'
import { validateExperiment, type Experiment, type ExperimentConfig, type ArmName } from './voucher'

export function useVoucher(active: boolean, ready: boolean) {
  const [clock] = useState(() => new FleetClock()), [experiment, setExperiment] = useState<Experiment | null>(null)
  const [arm, setArm] = useState<ArmName>('treatment'), [loading, setLoading] = useState(false), [error, setError] = useState('')
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null), [selectedBookingId, setSelectedBookingId] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  const clear = useCallback(() => { request.current?.abort(); clock.configure(0); setExperiment(null); setError(''); setLoading(false); setSelectedVehicleId(null); setSelectedBookingId(null) }, [clock])
  useEffect(() => { if (!active || !ready) clear() }, [active, ready, clear])
  useEffect(() => () => { request.current?.abort(); clock.dispose() }, [clock])
  const selectArm = (next: ArmName) => { setArm(next); setSelectedBookingId(null); setSelectedVehicleId(null) }
  const generate = async (config: ExperimentConfig) => {
    if (!active || !ready) return
    clear(); const controller = new AbortController(); request.current = controller; setLoading(true)
    try {
      const data = await api<Experiment>('/api/voucher-experiment/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config), signal: controller.signal })
      controller.signal.throwIfAborted(); validateExperiment(data); setExperiment(data); clock.configure(data.simulationDurationSeconds)
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (!controller.signal.aborted) setLoading(false) }
  }
  return { experiment, clock, arm, selectArm, clear, generate, loading, error, selectedBookingId, selectedVehicleId, setSelectedBookingId, setSelectedVehicleId,
    mapSession: { clock, plan: experiment?.[arm].plan ?? null, selectedBookingId, selectedVehicleId, setSelectedBookingId, setSelectedVehicleId } }
}
export type VoucherSession = ReturnType<typeof useVoucher>
