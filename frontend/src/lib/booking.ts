import type { Coordinate, Route } from './api'
import { fleetPosition, validateFleetRoute, type CandidateCatalog } from './fleet'

export type BookingStatus = 'scheduled' | 'waiting' | 'assigned' | 'picked_up' | 'completed' | 'unserved'
export type DispatchStatus = 'idle' | 'en_route_to_pickup' | 'on_trip'
export interface BookingConfig { seed: string; fleetSize: number; bookingCount: number; horizonSeconds: number; maxWaitSeconds: number; preset: 'Low' | 'Medium' | 'High' }
export interface BookingInput { id: string; passengerId: string; requestTimeSeconds: number; pickup: Coordinate; dropoff: Coordinate; pickupCandidateId: string; dropoffCandidateId: string }
export interface InitialVehicle { id: string; candidateId: string; initialPosition: Coordinate }
export interface Assignment {
  bookingId: string; vehicleId: string; assignedAtSeconds: number; pickupAtSeconds: number; dropoffAtSeconds: number
  estimatedPickupEtaSeconds: number; tableEtaSeconds: number; pickupRoute: Route | null; tripRoute: Route
  dispatchCandidates: { vehicleId: string; etaSeconds: number | null }[]
}
export interface BookingEvent { id: string; timestampSeconds: number; type: 'BOOKING_REQUESTED' | 'BOOKING_ASSIGNED' | 'VEHICLE_ARRIVED_PICKUP' | 'TRIP_STARTED' | 'TRIP_COMPLETED' | 'BOOKING_UNSERVED'; bookingId: string; vehicleId: string | null; payload: { failureReason?: string; [key: string]: unknown } }
export interface BookingPlan {
  id: string; seed: string; config: BookingConfig; demand: BookingInput[]; vehicles: InitialVehicle[]; assignments: Assignment[]; events: BookingEvent[]
  simulationDurationSeconds: number; datasetFingerprint: string; routingSource: string; provenance: Record<string, unknown>; assumptions: Record<string, unknown>
  createdAt: string; preparationMilliseconds: number; routingRequests: Record<string, number>
}
export interface ProjectedBooking extends BookingInput { status: BookingStatus; assignment: Assignment | null; failureReason: string | null; waitingSeconds: number | null }
export interface DispatchVehicle extends InitialVehicle {
  currentPosition: Coordinate; headingDegrees: number | null; status: DispatchStatus; activeBookingId: string | null; progress: number
  activeRoute: Route | null; completedBookingIds: string[]; emptyMeters: number; occupiedMeters: number; busySeconds: number
}
const fraction = (time: number, start: number, end: number) => Math.max(0, Math.min(1, (time-start)/(end-start)))
const average = (numbers: number[]) => numbers.length ? numbers.reduce((a, b) => a+b, 0)/numbers.length : null

/** Pure replay: no state carried from earlier frames, no requests, one absolute time. */
export function bookingProjection(plan: BookingPlan, simulationTime: number) {
  const time = Math.max(0, Math.min(plan.simulationDurationSeconds, Number.isFinite(simulationTime) ? simulationTime : 0))
  const bookings: ProjectedBooking[] = plan.demand.map(b => ({ ...b, status: 'scheduled', assignment: null, failureReason: null, waitingSeconds: null }))
  const byId = new Map(bookings.map(b => [b.id, b]))
  const assignmentById = new Map(plan.assignments.map(a => [a.bookingId, a]))
  const visibleEvents = plan.events.filter(e => e.timestampSeconds <= time)
  for (const event of visibleEvents) {
    const b = byId.get(event.bookingId)!
    if (event.type === 'BOOKING_REQUESTED') b.status = 'waiting'
    if (event.type === 'BOOKING_ASSIGNED') { b.status = 'assigned'; b.assignment = assignmentById.get(b.id)! }
    if (event.type === 'TRIP_STARTED') b.status = 'picked_up'
    if (event.type === 'TRIP_COMPLETED') b.status = 'completed'
    if (event.type === 'BOOKING_UNSERVED') { b.status = 'unserved'; b.failureReason = event.payload.failureReason ?? 'UNSERVED' }
  }
  for (const b of bookings) {
    if (b.status !== 'scheduled') b.waitingSeconds = Math.max(0, Math.min(time, b.assignment?.pickupAtSeconds ?? b.requestTimeSeconds+plan.config.maxWaitSeconds)-b.requestTimeSeconds)
  }
  const vehicles: DispatchVehicle[] = plan.vehicles.map(v => {
    const result: DispatchVehicle = { ...v, currentPosition: v.initialPosition, headingDegrees: null, status: 'idle', activeBookingId: null, progress: 0, activeRoute: null, completedBookingIds: [], emptyMeters: 0, occupiedMeters: 0, busySeconds: 0 }
    for (const a of plan.assignments.filter(a => a.vehicleId === v.id && a.assignedAtSeconds <= time)) {
      const pickupProgress = a.pickupRoute ? fraction(time, a.assignedAtSeconds, a.pickupAtSeconds) : 1
      const tripProgress = fraction(time, a.pickupAtSeconds, a.dropoffAtSeconds)
      result.emptyMeters += (a.pickupRoute?.distance ?? 0)*pickupProgress
      result.occupiedMeters += a.tripRoute.distance*tripProgress
      result.busySeconds += Math.max(0, Math.min(time, a.dropoffAtSeconds)-a.assignedAtSeconds)
      if (time >= a.dropoffAtSeconds) {
        result.currentPosition = a.tripRoute.coordinates.at(-1)!
        result.completedBookingIds.push(a.bookingId)
      } else {
        const route = time < a.pickupAtSeconds ? a.pickupRoute! : a.tripRoute
        result.progress = time < a.pickupAtSeconds ? pickupProgress : tripProgress
        Object.assign(result, fleetPosition(route.coordinates, result.progress))
        result.activeRoute = route; result.activeBookingId = a.bookingId
        result.status = time < a.pickupAtSeconds ? 'en_route_to_pickup' : 'on_trip'
      }
    }
    return result
  })
  const requested = bookings.filter(b => b.status !== 'scheduled'), assigned = bookings.filter(b => b.assignment)
  const picked = bookings.filter(b => b.status === 'picked_up' || b.status === 'completed'), completed = bookings.filter(b => b.status === 'completed')
  const metrics = {
    requested: requested.length, assigned: assigned.length, completed: completed.length, unserved: bookings.filter(b => b.status === 'unserved').length,
    serviceRate: requested.length ? picked.length/requested.length : null,
    completionRate: requested.length ? completed.length/requested.length : null,
    averageWaitingSeconds: average(picked.map(b => b.assignment!.pickupAtSeconds-b.requestTimeSeconds)),
    averageTripSeconds: average(completed.map(b => b.assignment!.tripRoute.duration)),
    averageEstimatedPickupEtaSeconds: average(assigned.map(b => b.assignment!.estimatedPickupEtaSeconds)),
    emptyMeters: vehicles.reduce((s, v) => s+v.emptyMeters, 0), occupiedMeters: vehicles.reduce((s, v) => s+v.occupiedMeters, 0),
    utilization: time > 0 ? vehicles.reduce((s, v) => s+v.busySeconds, 0)/(vehicles.length*time) : null,
  }
  return { time, bookings, vehicles, events: visibleEvents, metrics }
}

export function validateBookingPlan(plan: BookingPlan) {
  const fail = () => { throw new Error('INVALID_SCENARIO_PLAN: plan, lifecycle hoặc route không hợp lệ.') }
  if (!plan || !Array.isArray(plan.vehicles) || !Array.isArray(plan.demand) || !Array.isArray(plan.assignments) || !Array.isArray(plan.events) || !Number.isFinite(plan.simulationDurationSeconds) || plan.simulationDurationSeconds <= 0) fail()
  const vehicleIds = new Set(plan.vehicles.map(v => v.id)), bookingIds = new Set(plan.demand.map(b => b.id))
  if (vehicleIds.size !== plan.vehicles.length || bookingIds.size !== plan.demand.length || plan.vehicles.length !== plan.config.fleetSize || plan.demand.length !== plan.config.bookingCount || plan.vehicles.length > 10 || plan.demand.length > 30) fail()
  const catalog = { provenance: plan.provenance } as CandidateCatalog
  const assigned = new Set<string>(), ends = new Map<string, number>()
  for (const a of plan.assignments) {
    if (!bookingIds.has(a.bookingId) || !vehicleIds.has(a.vehicleId) || assigned.has(a.bookingId) || ![a.assignedAtSeconds, a.pickupAtSeconds, a.dropoffAtSeconds, a.estimatedPickupEtaSeconds, a.tableEtaSeconds].every(Number.isFinite)) fail()
    const input = plan.demand.find(b => b.id === a.bookingId)!
    if (a.assignedAtSeconds < input.requestTimeSeconds || a.pickupAtSeconds < a.assignedAtSeconds || a.dropoffAtSeconds <= a.pickupAtSeconds || a.pickupAtSeconds-input.requestTimeSeconds > plan.config.maxWaitSeconds+1e-6 || a.assignedAtSeconds < (ends.get(a.vehicleId) ?? 0)) fail()
    validateFleetRoute(a.tripRoute, catalog); if (a.pickupRoute) validateFleetRoute(a.pickupRoute, catalog)
    if (Math.abs(a.dropoffAtSeconds-a.pickupAtSeconds-a.tripRoute.duration) > 1e-6 || Math.abs(a.pickupAtSeconds-a.assignedAtSeconds-(a.pickupRoute?.duration ?? 0)) > 1e-6) fail()
    assigned.add(a.bookingId); ends.set(a.vehicleId, a.dropoffAtSeconds)
  }
  const eventIds = new Set<string>(), states = new Map<string, string>()
  let lastTime = -1
  for (const e of plan.events) {
    if (eventIds.has(e.id) || !bookingIds.has(e.bookingId) || (e.vehicleId !== null && !vehicleIds.has(e.vehicleId)) || !Number.isFinite(e.timestampSeconds) || e.timestampSeconds < lastTime || e.timestampSeconds > plan.simulationDurationSeconds) fail()
    eventIds.add(e.id); lastTime = e.timestampSeconds
    const previous = states.get(e.bookingId)
    const allowed: Record<BookingEvent['type'], string | undefined> = { BOOKING_REQUESTED: undefined, BOOKING_ASSIGNED: 'BOOKING_REQUESTED', VEHICLE_ARRIVED_PICKUP: 'BOOKING_ASSIGNED', TRIP_STARTED: 'VEHICLE_ARRIVED_PICKUP', TRIP_COMPLETED: 'TRIP_STARTED', BOOKING_UNSERVED: 'BOOKING_REQUESTED' }
    if (!(e.type in allowed) || previous !== allowed[e.type]) fail()
    states.set(e.bookingId, e.type)
  }
  if (plan.demand.some(b => !['TRIP_COMPLETED', 'BOOKING_UNSERVED'].includes(states.get(b.id) ?? ''))) fail()
  return plan
}
