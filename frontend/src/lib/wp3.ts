import type { Coordinate, Route } from './api'
import { positionAtTime } from './playback'

export const policyLabels: Record<string, string> = { no_offer: 'Không voucher', fixed: 'Cố định 10k', response: 'Response-only', state_aware: 'State-aware' }
export interface Wp3Config { seed: string; fleet: number; quotes: number; minutes: number; budget_vnd: number; patience_seconds: number; traffic_factor: number; voucher_effect: number; response_scale?: number }
export interface Leg { vehicle_id: string; request_id: string; kind: 'pickup' | 'trip'; start: number; end: number; origin: number; destination: number; path_id: string }
export interface Booking { id: string; origin: number; destination: number; arrival: number; accepted: boolean; offer_vnd: number; status: string; expires: number; offer_expires?: number; requested?: number; assigned?: number; pickup?: number; completed?: number }
export interface Wp3Run { policy: string; duration: number; vehicles: { id: string; initial: number }[]; quotes: Booking[]; legs: Leg[]; events: { time: number; kind: string; request_id: string; spent_vnd: number; reserved_vnd: number }[]; summary: { quoted: number; accepted: number; completed: number; expired: number; actual_spend_vnd: number; deadhead_km: number; passenger_km: number; mean_pickup_seconds: number | null } }
export interface Wp3Result { version: string; config: Wp3Config; anchors: { coordinate: Coordinate; name: string; routing_name?: string; snap_meters: number }[]; paths: Record<string, Route>; runs: Wp3Run[]; assumptions: Record<string, string>; datasetFingerprint: string; provenance: Record<string, unknown>; model?: { selected_wp2: string; sha256: string; wp1: { history_contrast: { relativeImprovement: number; targetPassed: boolean } } } }
export const money = (v: number) => new Intl.NumberFormat('vi-VN').format(v) + ' ₫'
export const timeText = (t: number) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`
export function bookingStatus(q: Booking, t: number) {
  if (t < q.arrival) return 'future'
  if (q.offer_expires !== undefined && (q.requested === undefined ? t < q.offer_expires : t < q.requested)) return 'pending'
  if (!q.accepted) return 'rejected'
  if (q.completed !== undefined && t >= q.completed) return 'completed'
  if (q.pickup !== undefined && t >= q.pickup) return 'onboard'
  if (q.assigned !== undefined && t >= q.assigned) return 'pickup'
  if (t >= q.expires) return 'expired'
  return 'queued'
}
export function vehicleState(vehicle: Wp3Run['vehicles'][number], run: Wp3Run, result: Wp3Result, t: number) {
  let coordinate = result.anchors[vehicle.initial].coordinate
  for (const leg of run.legs.filter(l => l.vehicle_id === vehicle.id)) {
    if (t < leg.start) break
    if (t >= leg.end) { coordinate = result.anchors[leg.destination].coordinate; continue }
    const progress = (t - leg.start) / (leg.end - leg.start)
    const path = result.paths[leg.path_id]
    return { coordinate: positionAtTime(path.coordinates, progress, path.segment_durations) ?? coordinate, status: leg.kind, leg, progress, remainingSeconds: leg.end - t }
  }
  return { coordinate, status: 'idle' as const, leg: null, progress: 0, remainingSeconds: 0 }
}
export function ledgerAt(run: Wp3Run, t: number) {
  const last = run.events.filter(e => e.time <= t).at(-1)
  return { spent: last?.spent_vnd ?? 0, reserved: last?.reserved_vnd ?? 0 }
}
