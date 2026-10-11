import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api, type Route } from './api'
import { prepareScenario, type CandidateCatalog, type FleetScenario } from './fleet'
import { FleetClock } from './fleet-clock'

export const useFleetClock = (clock: FleetClock) => useSyncExternalStore(clock.subscribe, clock.getSnapshot)
export function useFleet(active: boolean, ready: boolean) {
  const [clock] = useState(() => new FleetClock())
  const [scenario, setScenario] = useState<FleetScenario | null>(null)
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false), [completedRequests, setCompletedRequests] = useState(0)
  const [error, setError] = useState('')
  const request = useRef<AbortController | null>(null), cache = useRef(new Map<string, Route>())
  const clear = useCallback(() => {
    request.current?.abort(); clock.configure(0); setScenario(null); setSelectedVehicleId(null); setLoading(false); setError(''); setCompletedRequests(0)
  }, [clock])
  useEffect(() => { if (!active || !ready) clear() }, [active, ready, clear])
  useEffect(() => () => { request.current?.abort(); clock.dispose() }, [clock])
  const generate = async (seed: string, count: number) => {
    if (!active || !ready) return
    clear(); const controller = new AbortController(); request.current = controller; setLoading(true)
    try {
      const catalog = await api<CandidateCatalog>('/api/fleet/candidates', { signal: controller.signal })
      controller.signal.throwIfAborted()
      const result = await prepareScenario(catalog, seed, count, controller.signal,
        (start, end, signal) => api<Route>('/api/route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ start, end }), signal }),
        cache.current, done => { if (!controller.signal.aborted) setCompletedRequests(done) })
      if (controller.signal.aborted) return
      setScenario(result); setSelectedVehicleId(result.vehicles[0]?.id ?? null); clock.configure(result.simulationDurationSeconds)
      if (!result.vehicles.length) setError('Không tạo được xe có tuyến hợp lệ. Xem lỗi từng request bên dưới.')
    } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error)) }
    finally { if (!controller.signal.aborted) setLoading(false) }
  }
  return { clock, scenario, selectedVehicleId, setSelectedVehicleId, loading, completedRequests, error, generate, clear }
}
export type FleetSession = ReturnType<typeof useFleet>
