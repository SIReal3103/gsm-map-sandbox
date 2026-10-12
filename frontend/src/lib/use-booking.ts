import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { FleetClock } from './fleet-clock'
import { validateBookingPlan, type BookingPlan, type BookingConfig } from './booking'

export function useBooking(active: boolean, ready: boolean) {
  const [clock] = useState(() => new FleetClock())
  const [plan, setPlan] = useState<BookingPlan | null>(null)
  const [loading, setLoading] = useState(false), [error, setError] = useState('')
  const [selectedBookingId, setSelectedBookingId] = useState<string | null>(null)
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  const clear = useCallback(() => { request.current?.abort(); clock.configure(0); setPlan(null); setLoading(false); setError(''); setSelectedBookingId(null); setSelectedVehicleId(null) }, [clock])
  useEffect(() => { if (!active || !ready) clear() }, [active, ready, clear])
  useEffect(() => () => { request.current?.abort(); clock.dispose() }, [clock])
  const generate = async (config: BookingConfig) => {
    if (!active || !ready) return
    clear(); const controller = new AbortController(); request.current = controller; setLoading(true)
    try {
      const result = await api<BookingPlan>('/api/booking-simulation/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config), signal: controller.signal })
      controller.signal.throwIfAborted(); validateBookingPlan(result)
      setPlan(result); clock.configure(result.simulationDurationSeconds); setSelectedVehicleId(result.vehicles[0]?.id ?? null)
    } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error)) }
    finally { if (!controller.signal.aborted) setLoading(false) }
  }
  return { clock, plan, loading, error, generate, clear, selectedBookingId, setSelectedBookingId, selectedVehicleId, setSelectedVehicleId }
}
export type BookingSession = ReturnType<typeof useBooking>
