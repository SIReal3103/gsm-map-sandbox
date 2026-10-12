import type { BookingConfig, BookingInput, BookingPlan } from './booking'
import { bookingProjection, validateBookingPlan } from './booking'
import type { Route } from './api'
import { validateFleetRoute, type CandidateCatalog } from './fleet'

export type ArmName = 'baseline' | 'treatment'
export interface ExperimentConfig extends Omit<BookingConfig, 'bookingCount'> {
  potentialCount: number
  fare: { baseFare: number; perKm: number }
  behavior: { alpha: number; beta: number; referenceFare: number }
  voucher: { type: 'fixed' | 'percentage'; fixedAmount: number; rate: number; cap: number; minimumFare: number }
  campaignBudget: number
}
export const defaultExperimentConfig: ExperimentConfig = { seed: 'hcm-voucher-2026', fleetSize: 5, potentialCount: 30, horizonSeconds: 1800, maxWaitSeconds: 300, preset: 'Medium', fare: { baseFare: 10000, perKm: 12000 }, behavior: { alpha: 1.5, beta: 2, referenceFare: 50000 }, voucher: { type: 'fixed', fixedAmount: 20000, rate: .3, cap: 25000, minimumFare: 0 }, campaignBudget: 200000 }
export interface PotentialTrip extends BookingInput { valid: boolean; invalidReason: string | null; quotedFareVnd: number | null; quotedRoute: Route | null; alpha: number; beta: number; referenceFareVnd: number; randomDraw: number; datasetFingerprint: string }
export interface Decision { potentialId: string; timestampSeconds: number; valid: boolean; discountVnd: number; effectiveFareVnd: number | null; probability: number | null; accepted: boolean; reason: string | null; availableBeforeVnd: number; availableAfterVnd: number }
export interface Budget { total: number; reserved: number; spent: number; available: number }
export interface LedgerEvent extends Budget { id: string; type: 'OFFERED' | 'RESERVED' | 'SETTLED' | 'RELEASED'; timestampSeconds: number; bookingId: string; amountVnd: number }
export interface ExperimentArm { plan: BookingPlan; decisions: Decision[]; ledger: LedgerEvent[] }
export interface ArmMetrics {
  validPotential: number; invalidPotential: number; accepted: number; assigned: number; pickedUp: number; completed: number; unserved: number
  conversionRate: number | null; completionRate: number | null; averageWaitSeconds: number | null; averagePickupEtaSeconds: number | null; averageTripSeconds: number | null
  emptyMeters: number; occupiedMeters: number; utilization: number | null
  grossFareVnd: number; riderPaymentsVnd: number; voucherSpendVnd: number; budget: Budget; voucherCounts: Record<LedgerEvent['type'], number>
}
export interface Delta { bookingUplift: number; incrementalCompleted: number; costPerIncrementalCompletionVnd: number | null }
export interface Experiment {
  id: string; seed: string; config: ExperimentConfig; potential: PotentialTrip[]; baseline: ExperimentArm; treatment: ExperimentArm
  final: Record<ArmName, ArmMetrics>; comparison: Delta; timeSeries: { timeSeconds: number; baseline: ArmMetrics; treatment: ArmMetrics }[]
  simulationDurationSeconds: number; datasetFingerprint: string; provenance: Record<string, unknown>; assumptions: Record<string, unknown>; createdAt: string; preparationMilliseconds: number; routingRequests: Record<string, number>
}
const average = (items: number[]) => items.length ? items.reduce((s, v) => s+v, 0)/items.length : null
export const vnd = (value: number | null) => value === null ? 'N/A' : new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 }).format(value)
export const rateText = (value: number | null) => value === null ? 'N/A' : (value*100).toFixed(1)+'%'
export function delta(b: ArmMetrics, t: ArmMetrics): Delta {
  const incrementalCompleted = t.completed-b.completed
  return { bookingUplift: t.accepted-b.accepted, incrementalCompleted, costPerIncrementalCompletionVnd: incrementalCompleted > 0 ? t.voucherSpendVnd/incrementalCompleted : null }
}
/** Independent event-derived financial replay. Never routes or carries frame history. */
export function experimentMetrics(experiment: Experiment, armName: ArmName, timestamp: number): ArmMetrics {
  const time = Math.max(0, Math.min(experiment.simulationDurationSeconds, timestamp)), arm = experiment[armName]
  const view = bookingProjection(arm.plan, time)
  const decisions = arm.decisions.filter(d => d.timestampSeconds <= time)
  const validPotential = experiment.potential.filter(p => p.valid && p.requestTimeSeconds <= time).length
  const assignments = arm.plan.assignments.filter(a => a.assignedAtSeconds <= time)
  const picked = assignments.filter(a => a.pickupAtSeconds <= time), completed = assignments.filter(a => a.dropoffAtSeconds <= time)
  let budget: Budget = { total: armName === 'treatment' ? experiment.config.campaignBudget : 0, reserved: 0, spent: 0, available: armName === 'treatment' ? experiment.config.campaignBudget : 0 }
  const counts = { OFFERED: 0, RESERVED: 0, SETTLED: 0, RELEASED: 0 }, settled = new Map<string, number>()
  for (const e of arm.ledger) if (e.timestampSeconds <= time) { budget = { total: e.total, reserved: e.reserved, spent: e.spent, available: e.available }; counts[e.type]++; if (e.type === 'SETTLED') settled.set(e.bookingId, e.amountVnd) }
  const byId = new Map(experiment.potential.map(p => [p.id, p]))
  const grossFareVnd = completed.reduce((s, a) => s+byId.get(a.bookingId)!.quotedFareVnd!, 0)
  const voucherSpendVnd = completed.reduce((s, a) => s+(settled.get(a.bookingId) ?? 0), 0)
  const accepted = decisions.filter(d => d.accepted).length
  return { validPotential, invalidPotential: decisions.length-validPotential, accepted, assigned: assignments.length, pickedUp: picked.length, completed: completed.length, unserved: view.metrics.unserved,
    conversionRate: validPotential ? accepted/validPotential : null, completionRate: accepted ? completed.length/accepted : null,
    averageWaitSeconds: average(picked.map(a => a.pickupAtSeconds-byId.get(a.bookingId)!.requestTimeSeconds)),
    averagePickupEtaSeconds: average(assignments.map(a => a.estimatedPickupEtaSeconds)), averageTripSeconds: average(completed.map(a => a.tripRoute.duration)),
    emptyMeters: view.metrics.emptyMeters, occupiedMeters: view.metrics.occupiedMeters,
    utilization: time ? view.vehicles.reduce((s, v) => s+v.busySeconds, 0)/(view.vehicles.length*time) : null,
    grossFareVnd, voucherSpendVnd, riderPaymentsVnd: grossFareVnd-voucherSpendVnd, budget, voucherCounts: counts }
}
const sameNumbers = (a: unknown, b: unknown): boolean => {
  if (typeof a === 'number' && typeof b === 'number') return Number.isFinite(a) && Math.abs(a-b) <= 1e-6*Math.max(1, Math.abs(a))
  if (a && b && typeof a === 'object' && typeof b === 'object') return Object.keys(a).every(k => sameNumbers((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  return a === b
}
export function validateExperiment(e: Experiment) {
  const fail = () => { throw new Error('INVALID_EXPERIMENT_PLAN: potential, paired history, ledger hoặc KPI không hợp lệ.') }
  if (!e || !Array.isArray(e.potential) || !Number.isFinite(e.simulationDurationSeconds) || e.simulationDurationSeconds <= 0 || e.potential.length !== e.config.potentialCount || new Set(e.potential.map(p => p.id)).size !== e.potential.length) fail()
  const byId = new Map(e.potential.map(p => [p.id, p]))
  for (const p of e.potential) {
    if (!Number.isFinite(p.randomDraw) || p.randomDraw < 0 || p.randomDraw >= 1 || p.beta < 0 || p.referenceFareVnd <= 0) fail()
    if (p.valid) { if (!p.quotedRoute || !Number.isInteger(p.quotedFareVnd) || p.quotedFareVnd! < 0) fail(); validateFleetRoute(p.quotedRoute!, { provenance: e.provenance } as CandidateCatalog) }
    else if (p.quotedFareVnd !== null || p.quotedRoute !== null) fail()
  }
  if (JSON.stringify(e.baseline.plan.vehicles) !== JSON.stringify(e.treatment.plan.vehicles)) fail()
  for (const armName of ['baseline', 'treatment'] as const) {
    const arm = e[armName]; validateBookingPlan(arm.plan, true)
    if (arm.decisions.length !== e.potential.length || new Set(arm.decisions.map(d => d.potentialId)).size !== e.potential.length || arm.plan.simulationDurationSeconds > e.simulationDurationSeconds) fail()
    for (const d of arm.decisions) {
      const p = byId.get(d.potentialId); if (!p || d.timestampSeconds !== p.requestTimeSeconds || d.valid !== p.valid) fail()
      if (p!.valid) {
        const z = p!.alpha-p!.beta*(p!.quotedFareVnd!-d.discountVnd)/p!.referenceFareVnd
        const expected = z >= 0 ? 1/(1+Math.exp(-z)) : Math.exp(z)/(1+Math.exp(z))
        if (!Number.isInteger(d.discountVnd) || d.discountVnd < 0 || d.discountVnd > p!.quotedFareVnd! || d.effectiveFareVnd !== p!.quotedFareVnd!-d.discountVnd || d.probability === null || Math.abs(d.probability-expected) > 1e-12 || d.accepted !== (p!.randomDraw < expected) || (armName === 'baseline' && d.discountVnd !== 0)) fail()
      } else if (d.accepted || d.probability !== null) fail()
    }
    const ids = arm.decisions.filter(d => d.accepted).map(d => d.potentialId).sort()
    if (JSON.stringify(ids) !== JSON.stringify(arm.plan.demand.map(b => b.id).sort())) fail()
    const reservations = new Map<string, number>(), terminal = new Set<string>(), eventIds = new Set<string>(); let spent = 0, last = -1
    for (const l of arm.ledger) {
      if (eventIds.has(l.id) || l.timestampSeconds < last || !byId.has(l.bookingId) || !Number.isInteger(l.amountVnd) || l.amountVnd <= 0) fail()
      eventIds.add(l.id); last = l.timestampSeconds
      const decision = arm.decisions.find(d => d.potentialId === l.bookingId)!
      if (l.amountVnd !== decision.discountVnd || l.timestampSeconds < decision.timestampSeconds) fail()
      if (l.type === 'RESERVED') { if (reservations.has(l.bookingId) || terminal.has(l.bookingId) || !decision.accepted) fail(); reservations.set(l.bookingId, l.amountVnd) }
      else if (l.type === 'SETTLED' || l.type === 'RELEASED') {
        if (reservations.get(l.bookingId) !== l.amountVnd || terminal.has(l.bookingId)) fail()
        const outcome = arm.plan.events.find(v => v.bookingId === l.bookingId && v.type === (l.type === 'SETTLED' ? 'TRIP_COMPLETED' : 'BOOKING_UNSERVED'))
        if (!outcome || outcome.timestampSeconds !== l.timestampSeconds) fail()
        reservations.delete(l.bookingId); terminal.add(l.bookingId); if (l.type === 'SETTLED') spent += l.amountVnd
      } else if (l.type !== 'OFFERED') fail()
      const reserved = [...reservations.values()].reduce((s, n) => s+n, 0), total = armName === 'treatment' ? e.config.campaignBudget : 0
      if (l.total !== total || l.reserved !== reserved || l.spent !== spent || l.available !== total-reserved-spent || l.available < 0) fail()
    }
    if (reservations.size || !sameNumbers(experimentMetrics(e, armName, e.simulationDurationSeconds), e.final[armName])) fail()
  }
  if (!sameNumbers(delta(e.final.baseline, e.final.treatment), e.comparison)) fail()
  return e
}
export function csv(rows: (string | number | boolean | null)[][]) {
  // UTF-8 BOM, RFC4180 quotes, CRLF and spreadsheet formula injection protection.
  return '\ufeff'+rows.map(row => row.map(value => {
    let text = value === null ? '' : String(value)
    if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = "'"+text
    return '"'+text.replaceAll('"', '""')+'"'
  }).join(',')).join('\r\n')+'\r\n'
}
export function experimentCsv(e: Experiment) {
  const summary = csv([['scope', 'arm', 'metric', 'value'], ...(['baseline', 'treatment'] as const).flatMap(arm => Object.entries(e.final[arm]).filter(([, v]) => typeof v !== 'object' || v === null).map(([k, v]) => ['final_common_duration', arm, k, v as number | null])), ...Object.entries(e.comparison).map(([k, v]) => ['final_common_duration', 'delta', k, v])])
  const decisions = csv([['arm', 'potential_id', 'passenger_id', 'request_seconds', 'valid', 'base_fare_vnd', 'alpha', 'beta', 'reference_fare_vnd', 'draw', 'discount_vnd', 'effective_fare_vnd', 'probability', 'accepted', 'reason'], ...(['baseline', 'treatment'] as const).flatMap(arm => e[arm].decisions.map(d => { const p = e.potential.find(p => p.id === d.potentialId)!; return [arm, p.id, p.passengerId, p.requestTimeSeconds, p.valid, p.quotedFareVnd, p.alpha, p.beta, p.referenceFareVnd, p.randomDraw, d.discountVnd, d.effectiveFareVnd, d.probability, d.accepted, d.reason] }))])
  const bookings = csv([['arm', 'booking_id', 'status_final', 'vehicle_id', 'assigned_seconds', 'pickup_seconds', 'dropoff_seconds', 'empty_meters', 'trip_meters', 'failure_reason'], ...(['baseline', 'treatment'] as const).flatMap(arm => bookingProjection(e[arm].plan, e.simulationDurationSeconds).bookings.map(b => [arm, b.id, b.status, b.assignment?.vehicleId ?? null, b.assignment?.assignedAtSeconds ?? null, b.assignment?.pickupAtSeconds ?? null, b.assignment?.dropoffAtSeconds ?? null, b.assignment?.pickupRoute?.distance ?? 0, b.assignment?.tripRoute.distance ?? null, b.failureReason]))])
  const ledger = csv([['arm', 'event_id', 'time_seconds', 'booking_id', 'type', 'amount_vnd', 'budget_vnd', 'reserved_vnd', 'spent_vnd', 'available_vnd'], ...(['baseline', 'treatment'] as const).flatMap(arm => e[arm].ledger.map(l => [arm, l.id, l.timestampSeconds, l.bookingId, l.type, l.amountVnd, l.total, l.reserved, l.spent, l.available]))])
  const series = csv([['time_seconds', 'arm', 'accepted', 'completed', 'utilization_ratio', 'gross_fare_vnd', 'rider_payments_vnd', 'spent_vnd', 'reserved_vnd', 'available_vnd'], ...e.timeSeries.flatMap(row => (['baseline', 'treatment'] as const).map(arm => [row.timeSeconds, arm, row[arm].accepted, row[arm].completed, row[arm].utilization, row[arm].grossFareVnd, row[arm].riderPaymentsVnd, row[arm].voucherSpendVnd, row[arm].budget.reserved, row[arm].budget.available]))])
  return { summary, decisions, bookings, ledger, series }
}
export function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type })), link = document.createElement('a')
  link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0)
}
