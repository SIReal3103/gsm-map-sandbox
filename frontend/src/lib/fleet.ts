import type { Coordinate, Route } from './api'

export type VehicleStatus = 'scheduled' | 'moving' | 'completed'
export interface Vehicle {
  id: string; label: string; status: VehicleStatus; start: Coordinate; end: Coordinate; route: Route
  distanceMeters: number; durationSeconds: number; departureOffsetSeconds: number
  progress: number; currentPosition: Coordinate; headingDegrees: number | null
}
export interface Candidate { id: string; osm_id: string; name: string; coordinate: Coordinate }
export interface CandidateCatalog {
  candidates: Candidate[]; datasetFingerprint: string; routingSource: string
  provenance: Record<string, unknown>; candidateSource: string
}
export interface FleetScenario {
  id: string; seed: string; vehicles: Vehicle[]; simulationDurationSeconds: number; createdAt: string
  routingSource: string; datasetFingerprint: string; provenance: Record<string, unknown>
  requestedVehicles: number; failures: { id: string; reason: string }[]
  preparationMilliseconds: number; routeRequests: number; cacheHits: number
}
export interface ClockSnapshot {
  simulationTimeSeconds: number; speedMultiplier: number; playbackStatus: 'idle' | 'paused' | 'playing' | 'completed'
}
export interface FleetPlayback extends ClockSnapshot { selectedVehicleId: string | null }

const clamp = (value: number, max = 1) => Math.max(0, Math.min(max, Number.isFinite(value) ? value : 0))
// Same equirectangular segment measure as the installed mapcn RouteMarker.
const measures = new WeakMap<Coordinate[], { lengths: number[]; total: number }>()
export function fleetPosition(coordinates: Coordinate[], progress: number) {
  let measure = measures.get(coordinates)
  if (!measure) {
    const lengths = coordinates.slice(1).map((b, i) => {
      const a = coordinates[i]
      return Math.hypot((b[0]-a[0])*Math.cos((a[1]+b[1])/2*Math.PI/180), b[1]-a[1])
    })
    measure = { lengths, total: lengths.reduce((a, b) => a+b, 0) }; measures.set(coordinates, measure)
  }
  let target = measure.total * clamp(progress)
  for (let i = 0; i < measure.lengths.length; i++) {
    const length = measure.lengths[i]
    if (length > 0 && target <= length) {
      const a = coordinates[i], b = coordinates[i+1], t = target/length
      const heading = Math.atan2((b[0]-a[0])*Math.cos((a[1]+b[1])/2*Math.PI/180), b[1]-a[1])*180/Math.PI
      return { currentPosition: [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t] as Coordinate, headingDegrees: (heading+360)%360 }
    }
    target -= length
  }
  if (!coordinates.length) throw new Error('INVALID_FLEET_GEOMETRY: tuyến rỗng.')
  return { currentPosition: coordinates[coordinates.length-1], headingDegrees: null }
}
export function vehicleAt(vehicle: Vehicle, simulationTime: number): Vehicle {
  const elapsed = simulationTime - vehicle.departureOffsetSeconds
  const progress = clamp(elapsed / vehicle.durationSeconds)
  return { ...vehicle, progress, status: elapsed < 0 ? 'scheduled' : progress >= 1 ? 'completed' : 'moving',
    ...fleetPosition(vehicle.route.coordinates, progress) }
}
export function fleetOverview(vehicles: Vehicle[]) {
  return { total: vehicles.length, scheduled: vehicles.filter(v => v.status === 'scheduled').length,
    moving: vehicles.filter(v => v.status === 'moving').length, completed: vehicles.filter(v => v.status === 'completed').length,
    plannedMeters: vehicles.reduce((sum, v) => sum+v.distanceMeters, 0),
    traveledMeters: vehicles.reduce((sum, v) => sum+v.distanceMeters*v.progress, 0) }
}
export function seededRandom(seed: string) {
  let state = 2166136261
  for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619)
  return () => { state += 0x6D2B79F5; let x = Math.imul(state ^ state >>> 15, 1 | state); x ^= x + Math.imul(x ^ x >>> 7, 61 | x); return ((x ^ x >>> 14) >>> 0)/4294967296 }
}
export function scenarioInputs(catalog: CandidateCatalog, seed: string, count: number) {
  if (!Number.isInteger(count) || count < 1 || count > 10 || catalog.candidates.length < 2) throw new Error('Cần 1–10 xe và ít nhất 2 candidate OSM.')
  const random = seededRandom(`${seed}:${catalog.datasetFingerprint}:fleet-v1`)
  const pairs = catalog.candidates.flatMap((start, i) => catalog.candidates.filter((_, j) => j !== i).map(end => ({ start, end })))
  for (let i = pairs.length-1; i > 0; i--) { const j = Math.floor(random()*(i+1)); [pairs[i], pairs[j]] = [pairs[j], pairs[i]] }
  return pairs.slice(0, count).map((pair, i) => ({ ...pair, id: `GSM-${String(i+1).padStart(2, '0')}`, departureOffsetSeconds: i === 0 ? 0 : Math.floor(random()*45) }))
}
export function validateFleetRoute(route: Route, catalog: CandidateCatalog) {
  const bbox = catalog.provenance.display_bbox as number[]
  if (!Array.isArray(bbox) || bbox.length !== 4 || !route || !Number.isFinite(route.duration) || route.duration <= 0 || !Number.isFinite(route.distance) || route.distance <= 0 || !Array.isArray(route.coordinates) || route.coordinates.length < 2 || route.snap_points?.length !== 2) throw new Error('INVALID_FLEET_ROUTE: thiếu geometry/metrics/snaps.')
  if (route.coordinates.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite) || p[0] < bbox[0] || p[0] > bbox[2] || p[1] < bbox[1] || p[1] > bbox[3]) || new Set(route.coordinates.map(p => p.join(','))).size < 2) throw new Error('ROUTE_OUTSIDE_DISPLAY: tuyến không đủ coverage hiển thị hoặc geometry sai.')
  if (route.snap_points.some(point => !Number.isFinite(point.distance) || point.distance < 0 || point.distance > Number(catalog.provenance.max_snap_meters ?? 100) || !Array.isArray(point.location) || point.location.length !== 2 || !point.location.every(Number.isFinite))) throw new Error('INVALID_FLEET_SNAP: điểm snap không hợp lệ.')
}
export type RouteFetcher = (start: Coordinate, end: Coordinate, signal: AbortSignal) => Promise<Route>
export async function prepareScenario(catalog: CandidateCatalog, seed: string, count: number, signal: AbortSignal,
  fetchRoute: RouteFetcher, cache: Map<string, Route>, onProgress: (done: number) => void = () => {}) {
  const begun = performance.now(), inputs = scenarioInputs(catalog, seed, count)
  const vehicles: (Vehicle | null)[] = inputs.map(() => null), failures: FleetScenario['failures'] = []
  let next = 0, done = 0, routeRequests = 0, cacheHits = 0
  const worker = async () => {
    while (next < inputs.length) {
      signal.throwIfAborted()
      const index = next++, input = inputs[index]
      const key = `${catalog.datasetFingerprint}:${input.start.id}:${input.end.id}`
      try {
        let route = cache.get(key)
        if (route) cacheHits++
        else { routeRequests++; route = await fetchRoute(input.start.coordinate, input.end.coordinate, signal) }
        signal.throwIfAborted(); validateFleetRoute(route, catalog)
        // Keep a bounded, session-only cache; no requests during playback.
        if (cache.size >= 100) cache.delete(cache.keys().next().value!)
        cache.set(key, route)
        vehicles[index] = vehicleAt({ id: input.id, label: input.id, route, start: input.start.coordinate, end: input.end.coordinate,
          distanceMeters: route.distance, durationSeconds: route.duration, departureOffsetSeconds: input.departureOffsetSeconds,
          status: 'scheduled', progress: 0, currentPosition: route.coordinates[0], headingDegrees: null }, 0)
      } catch (error) {
        signal.throwIfAborted(); failures.push({ id: input.id, reason: error instanceof Error ? error.message : String(error) })
      }
      onProgress(++done)
    }
  }
  await Promise.all([worker(), worker()]); signal.throwIfAborted()
  const valid = vehicles.filter((v): v is Vehicle => v !== null)
  failures.sort((a, b) => a.id.localeCompare(b.id))
  return { id: `fleet-v1:${catalog.datasetFingerprint}:${seed}:${count}`, seed, vehicles: valid,
    simulationDurationSeconds: valid.reduce((max, v) => Math.max(max, v.departureOffsetSeconds+v.durationSeconds), 0),
    createdAt: new Date().toISOString(), routingSource: catalog.routingSource, datasetFingerprint: catalog.datasetFingerprint,
    provenance: catalog.provenance, requestedVehicles: count, failures, preparationMilliseconds: performance.now()-begun, routeRequests, cacheHits } satisfies FleetScenario
}
