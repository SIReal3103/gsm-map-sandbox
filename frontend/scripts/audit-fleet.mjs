// Real integration audit. Run from frontend with Node 22.18+ (native TS stripping).
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { prepareScenario, vehicleAt, fleetOverview } from '../src/lib/fleet.ts'

const target = fileURLToPath(new URL('../../docs/evidence/a2/', import.meta.url))
await mkdir(target, { recursive: true })
const response = await fetch('http://127.0.0.1:8000/api/fleet/candidates')
if (!response.ok) throw new Error(`Candidates HTTP ${response.status}`)
const catalog = await response.json(), results = []
for (const count of [5, 10]) {
  const cache = new Map()
  const routeFetcher = async (start, end, signal) => {
    const response = await fetch('http://127.0.0.1:8000/api/route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ start, end }), signal })
    const data = await response.json()
    if (!response.ok) throw new Error(`${data.error?.code}: ${data.error?.message}`)
    return data
  }
  const scenario = await prepareScenario(catalog, 'hcm-fleet-2026', count, new AbortController().signal, routeFetcher, cache)
  const duplicateGeometryCount = scenario.vehicles.length-new Set(scenario.vehicles.map(v => JSON.stringify(v.route.coordinates))).size
  const repeat = await prepareScenario(catalog, 'hcm-fleet-2026', count, new AbortController().signal, routeFetcher, cache)
  const deterministic = JSON.stringify(scenario.vehicles) === JSON.stringify(repeat.vehicles)
  const projections = [0, 40, scenario.simulationDurationSeconds/2, scenario.simulationDurationSeconds].map(time => {
    const vehicles = scenario.vehicles.map(v => vehicleAt(v, time))
    return { time, overview: fleetOverview(vehicles), vehicles: vehicles.map(({ id, status, progress, currentPosition, headingDegrees }) => ({ id, status, progress, currentPosition, headingDegrees })) }
  })
  results.push({ scenario, duplicateGeometryCount, deterministic, repeatCacheHits: repeat.cacheHits, repeatRequests: repeat.routeRequests, projections })
  console.log(`${count} vehicles: ${scenario.vehicles.length}/${count}, ${scenario.routeRequests} HTTP requests, ${scenario.preparationMilliseconds.toFixed(1)} ms, distinct=${duplicateGeometryCount === 0}, deterministic=${deterministic}`)
  if (scenario.vehicles.length !== count || duplicateGeometryCount !== 0 || !deterministic || repeat.routeRequests !== 0) process.exitCode = 1
}
await writeFile(target+'real-fleet-integration.json', JSON.stringify(results, null, 2))
