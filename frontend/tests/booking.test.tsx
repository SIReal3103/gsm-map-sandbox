import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { bookingProjection, validateBookingPlan, type BookingPlan } from '../src/lib/booking'
import { useBooking } from '../src/lib/use-booking'
import { BookingPanel } from '../src/components/booking-panel'
import type { Route, Coordinate } from '../src/lib/api'

// Explicit synthetic unit geometry only; never runtime HCMC map or demand.
const route = (coordinates: Coordinate[], duration: number, distance: number): Route => ({ coordinates, duration, distance, snap_points: [{ location: coordinates[0], distance: 0, name: 'fixture' }, { location: coordinates.at(-1)!, distance: 0, name: 'fixture' }], duration_source: 'test fixture' })
export function fixturePlan(): BookingPlan {
  const demand = Array.from({ length: 10 }, (_, i) => ({ id: `B${i+1}`, passengerId: `test-${i}`, pickup: [1, 1] as Coordinate, dropoff: [2, 2] as Coordinate, pickupCandidateId: 'fixture-a', dropoffCandidateId: 'fixture-b', requestTimeSeconds: i === 0 ? 10 : i === 1 ? 75 : 100 }))
  const assignments = [
    { bookingId: 'B1', vehicleId: 'V1', assignedAtSeconds: 10, pickupAtSeconds: 30, dropoffAtSeconds: 70, estimatedPickupEtaSeconds: 20, tableEtaSeconds: 20, pickupRoute: route([[0, 0], [1, 0], [1, 1]], 20, 1000), tripRoute: route([[1, 1], [2, 1], [2, 2]], 40, 2000), dispatchCandidates: [{ vehicleId: 'V1', etaSeconds: 20 }] },
    { bookingId: 'B2', vehicleId: 'V1', assignedAtSeconds: 75, pickupAtSeconds: 85, dropoffAtSeconds: 105, estimatedPickupEtaSeconds: 10, tableEtaSeconds: 10, pickupRoute: route([[2, 2], [3, 2], [3, 3]], 10, 500), tripRoute: route([[3, 3], [4, 3], [4, 4]], 20, 1000), dispatchCandidates: [{ vehicleId: 'V1', etaSeconds: 10 }] },
  ]
  let id = 0
  const events: BookingPlan['events'] = demand.flatMap(b => {
    const a = assignments.find(a => a.bookingId === b.id)
    const event = (type: BookingPlan['events'][number]['type'], timestampSeconds: number, vehicleId: string | null = null) => ({ id: `E${++id}`, type, timestampSeconds, bookingId: b.id, vehicleId, payload: type === 'BOOKING_UNSERVED' ? { failureReason: 'PICKUP_WAIT_LIMIT' } : {} })
    return a ? [event('BOOKING_REQUESTED', b.requestTimeSeconds), event('BOOKING_ASSIGNED', a.assignedAtSeconds, a.vehicleId), event('VEHICLE_ARRIVED_PICKUP', a.pickupAtSeconds, a.vehicleId), event('TRIP_STARTED', a.pickupAtSeconds, a.vehicleId), event('TRIP_COMPLETED', a.dropoffAtSeconds, a.vehicleId)] : [event('BOOKING_REQUESTED', 100), event('BOOKING_UNSERVED', 400)]
  }).sort((a, b) => a.timestampSeconds-b.timestampSeconds)
  return { id: 'explicit-fixture', seed: 'fixture', config: { seed: 'fixture', fleetSize: 2, bookingCount: 10, horizonSeconds: 100, maxWaitSeconds: 300, preset: 'Medium' }, demand, assignments, events, vehicles: [{ id: 'V1', candidateId: 'fixture', initialPosition: [0, 0] }, { id: 'V2', candidateId: 'fixture', initialPosition: [5, 5] }], simulationDurationSeconds: 400, datasetFingerprint: 'fixture', routingSource: 'fixture', provenance: { display_bbox: [-1, -1, 10, 10] }, assumptions: {}, createdAt: 'fixture', preparationMilliseconds: 1, routingRequests: { table: 2, route: 4, routeCacheHits: 0 } }
}

describe('immutable event replay and observed metrics', () => {
  it('validates full plan; unique booking, vehicle, event identities and transitions', () => {
    expect(validateBookingPlan(fixturePlan())).toBeTruthy()
    const bad = fixturePlan(); bad.events[1].type = 'TRIP_COMPLETED'
    expect(() => validateBookingPlan(bad)).toThrow('INVALID_SCENARIO_PLAN')
    const overlap = fixturePlan(); overlap.assignments[1].assignedAtSeconds = 60
    expect(() => validateBookingPlan(overlap)).toThrow()
  })
  it('seek before request contains no future assignment, events or metrics', () => {
    const v = bookingProjection(fixturePlan(), 0)
    expect(v.bookings.every(b => b.status === 'scheduled' && !b.assignment)).toBe(true)
    expect(v.events).toHaveLength(0); expect(v.vehicles.every(v => v.status === 'idle')).toBe(true)
    expect(v.metrics.completionRate).toBeNull(); expect(v.metrics.utilization).toBeNull()
  })
  it('pickup/trip use bent route geometry, with exact lifecycle boundaries', () => {
    const plan = fixturePlan()
    const pickup = bookingProjection(plan, 20)
    expect(pickup.bookings[0].status).toBe('assigned')
    expect(pickup.vehicles[0].currentPosition).toEqual([1, 0])
    expect(pickup.vehicles[0].progress).toBe(.5)
    const trip = bookingProjection(plan, 30)
    expect(trip.bookings[0].status).toBe('picked_up'); expect(trip.vehicles[0].status).toBe('on_trip')
    expect(bookingProjection(plan, 50).vehicles[0].currentPosition[0]).toBeGreaterThan(1.99)
    const complete = bookingProjection(plan, 70)
    expect(complete.bookings[0].status).toBe('completed')
    expect(complete.vehicles[0]).toMatchObject({ status: 'idle', currentPosition: [2, 2], activeBookingId: null, completedBookingIds: ['B1'] })
  })
  it('seek backward and Reset reconstruct state independently of prior projection', () => {
    const plan = fixturePlan(), original = JSON.stringify(plan)
    const first = bookingProjection(plan, 20)
    bookingProjection(plan, 400)
    expect(bookingProjection(plan, 20)).toEqual(first)
    expect(bookingProjection(plan, 0).vehicles[0].currentPosition).toEqual([0, 0])
    expect(JSON.stringify(plan)).toBe(original)
  })
  it('metrics use only events observed by time, with correct denominators/distances', () => {
    const v = bookingProjection(fixturePlan(), 50)
    expect(v.metrics).toMatchObject({ requested: 1, assigned: 1, completed: 0, unserved: 0, serviceRate: 1, completionRate: 0, averageWaitingSeconds: 20, averageTripSeconds: null, averageEstimatedPickupEtaSeconds: 20, emptyMeters: 1000, occupiedMeters: 1000, utilization: .4 })
    const final = bookingProjection(fixturePlan(), 400)
    expect(final.metrics).toMatchObject({ requested: 10, completed: 2, unserved: 8, completionRate: .2, emptyMeters: 1500, occupiedMeters: 3000, averageWaitingSeconds: 15, averageTripSeconds: 30 })
  })
  it('null pickup route denotes a stationary car, without NaN or fabricated segment', () => {
    const plan = fixturePlan(), a = plan.assignments[0]
    a.pickupRoute = null; a.pickupAtSeconds = 10; a.dropoffAtSeconds = 50
    for (const e of plan.events.filter(e => e.bookingId === 'B1')) { if (['VEHICLE_ARRIVED_PICKUP', 'TRIP_STARTED'].includes(e.type)) e.timestampSeconds = 10; if (e.type === 'TRIP_COMPLETED') e.timestampSeconds = 50 }
    plan.events.sort((a, b) => a.timestampSeconds-b.timestampSeconds)
    expect(bookingProjection(plan, 10).vehicles[0]).toMatchObject({ status: 'on_trip', emptyMeters: 0, progress: 0 })
  })
})

describe('booking request/clock lifecycle', () => {
  it('play/pause/seek/speed/reset and selection issue no new routing requests', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => fixturePlan() }); vi.stubGlobal('fetch', fetcher)
    const { result, unmount } = renderHook(() => useBooking(true, true))
    await act(async () => result.current.generate(fixturePlan().config))
    act(() => { result.current.clock.play(); result.current.clock.pause(); result.current.clock.seek(50); result.current.clock.setSpeed(4); result.current.setSelectedVehicleId('V2'); result.current.clock.reset() })
    expect(fetcher).toHaveBeenCalledTimes(1); expect(result.current.clock.getSnapshot().simulationTimeSeconds).toBe(0)
    act(() => result.current.clock.play()); unmount(); expect(cancelAnimationFrame).toHaveBeenCalled()
  })
  it('regenerate ignores stale completion and clears old IDs on mode switch', async () => {
    const pending: { resolve: (response: unknown) => void; signal: AbortSignal }[] = []
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise(resolve => pending.push({ resolve, signal: options.signal }))))
    const { result, rerender, unmount } = renderHook(({ active }) => useBooking(active, true), { initialProps: { active: true } })
    let first: Promise<void>, second: Promise<void>
    await act(async () => { first = result.current.generate(fixturePlan().config) })
    await act(async () => { second = result.current.generate({ ...fixturePlan().config, seed: 'new' }) })
    expect(pending[0].signal.aborted).toBe(true)
    await act(async () => { pending[1].resolve({ ok: true, json: async () => ({ ...fixturePlan(), seed: 'new' }) }); await second! })
    await act(async () => { pending[0].resolve({ ok: true, json: async () => fixturePlan() }); await first! })
    expect(result.current.plan?.seed).toBe('new')
    rerender({ active: false }); expect(result.current.plan).toBeNull(); expect(result.current.selectedVehicleId).toBeNull()
    unmount()
  })
  it('structured preparation errors leave scenario empty and clock idle', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: { code: 'ROUTER_TIMEOUT', message: 'fixture' } }) }))
    const { result, unmount } = renderHook(() => useBooking(true, true))
    await act(async () => result.current.generate(fixturePlan().config))
    expect(result.current.plan).toBeNull(); expect(result.current.error).toContain('ROUTER_TIMEOUT'); expect(result.current.clock.getSnapshot().playbackStatus).toBe('idle'); unmount()
  })
  it('panel controls show observed/planned separation, filters, selection, seek and reset', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => fixturePlan() }))
    function Harness() { const session = useBooking(true, true); return <BookingPanel session={session} ready onFocus={() => {}} /> }
    render(<Harness />)
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Generate Booking Scenario' }))
    expect(await screen.findByText('Observed · tới thời điểm hiện tại')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: 'Booking status filter' }), { target: { value: 'all' } })
    expect(document.querySelectorAll('[data-booking-id]')).toHaveLength(10)
    fireEvent.click(screen.getByRole('button', { name: 'Chọn booking B1' }))
    expect(screen.getByRole('button', { name: 'Chọn booking B1' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Reset booking simulation' }))
    expect(document.querySelector('.booking-panel')).toHaveAttribute('data-booking-time', '0')
    expect(document.querySelectorAll('[data-dispatch-row]')).toHaveLength(2)
  })
})
