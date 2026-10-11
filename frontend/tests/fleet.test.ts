import { describe, it, expect, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { fleetOverview, fleetPosition, prepareScenario, scenarioInputs, vehicleAt, validateFleetRoute, type CandidateCatalog, type Vehicle } from '../src/lib/fleet'
import { FleetClock } from '../src/lib/fleet-clock'
import { useFleet } from '../src/lib/use-fleet'
import type { Route } from '../src/lib/api'

// Synthetic equatorial unit fixtures only. Never used as runtime map/scenario data.
const catalog: CandidateCatalog = { candidates: Array.from({ length: 5 }, (_, i) => ({ id: `fixture-${i}`, osm_id: `fixture-${i}`, name: 'fixture', coordinate: [i, i] })), datasetFingerprint: 'fixture', routingSource: 'fixture', candidateSource: 'fixture', provenance: { display_bbox: [-1, -1, 10, 10] } }
const route: Route = { coordinates: [[0, 0], [1, 0], [1, 1]], duration: 100, distance: 1000, snap_points: [{ location: [0, 0], distance: 0, name: '' }, { location: [1, 1], distance: 0, name: '' }], duration_source: 'test fixture' }
const vehicle: Vehicle = { id: 'fixture-vehicle', label: 'fixture', route, start: [0, 0], end: [1, 1], distanceMeters: 1000, durationSeconds: 100, departureOffsetSeconds: 20, progress: 0, status: 'scheduled', currentPosition: [0, 0], headingDegrees: null }
describe('fleet pure projections', () => {
  it('generates unique deterministic directed input pairs and offsets for 5 and 10', () => {
    for (const count of [5, 10]) {
      const input = scenarioInputs(catalog, 'same-seed', count)
      expect(input).toEqual(scenarioInputs(catalog, 'same-seed', count))
      expect(new Set(input.map(v => v.id)).size).toBe(count)
      expect(new Set(input.map(v => `${v.start.id}/${v.end.id}`)).size).toBe(count)
      expect(input.every(v => v.start.id !== v.end.id)).toBe(true)
    }
    expect(scenarioInputs(catalog, 'changed', 5)).not.toEqual(scenarioInputs(catalog, 'same-seed', 5))
    expect(() => scenarioInputs(catalog, 'seed', 11)).toThrow()
  })
  it('scheduled -> moving -> completed at exact boundaries; arbitrary seeks are deterministic', () => {
    expect(vehicleAt(vehicle, 19).status).toBe('scheduled')
    expect(vehicleAt(vehicle, 20).status).toBe('moving')
    expect(vehicleAt(vehicle, 70).progress).toBe(.5)
    expect(vehicleAt(vehicle, 120).status).toBe('completed')
    expect(vehicleAt(vehicle, 200).progress).toBe(1)
    expect(vehicleAt(vehicle, 70)).toEqual(vehicleAt(vehicle, 70))
    expect(vehicleAt(vehicle, 0).progress).toBe(0)
  })
  it('follows each geometry segment and handles repeated vertices with finite heading', () => {
    const coordinates: Route['coordinates'] = [[0, 0], [0, 0], [1, 0], [1, 1]]
    // At the equator lengths are exactly one degree for both nonzero segments.
    expect(fleetPosition(coordinates, .5).currentPosition).toEqual([1, 0])
    const position = fleetPosition(coordinates, .75)
    expect(position.currentPosition[0]).toBe(1)
    expect(position.currentPosition[1]).toBeCloseTo(.5)
    expect(position.headingDegrees).toBe(0)
    expect(fleetPosition([[1, 1], [1, 1]], .5).headingDegrees).toBeNull()
  })
  it('computes actual fleet totals from per-vehicle projection', () => {
    const vehicles = [vehicleAt(vehicle, 70), vehicleAt({ ...vehicle, departureOffsetSeconds: 0 }, 70)]
    expect(fleetOverview(vehicles)).toMatchObject({ total: 2, moving: 2, plannedMeters: 2000, traveledMeters: 1200 })
  })
  it('rejects missing/degenerate/out-of-display/nonfinite route data', () => {
    for (const bad of [{ ...route, duration: 0 }, { ...route, coordinates: [[0, 0], [0, 0]] }, { ...route, coordinates: [[0, 0], [11, 0]] }, { ...route, distance: NaN }, { ...route, snap_points: [] }]) expect(() => validateFleetRoute(bad as Route, catalog)).toThrow()
  })
})
describe('bounded scenario preparation', () => {
  it('limits concurrent requests to two and reuses only same-fingerprint session cache', async () => {
    let active = 0, peak = 0
    const fetcher = vi.fn(async () => { active++; peak = Math.max(active, peak); await new Promise(resolve => setTimeout(resolve, 2)); active--; return route })
    const cache = new Map<string, Route>(), signal = new AbortController().signal
    const first = await prepareScenario(catalog, 'seed', 5, signal, fetcher, cache)
    expect(first.vehicles).toHaveLength(5); expect(peak).toBe(2)
    const again = await prepareScenario(catalog, 'seed', 5, signal, fetcher, cache)
    expect(again.routeRequests).toBe(0); expect(again.cacheHits).toBe(5)
    expect(again.vehicles).toEqual(first.vehicles)
    expect(first.simulationDurationSeconds).toBe(Math.max(...first.vehicles.map(v => v.durationSeconds+v.departureOffsetSeconds)))
    const changed = await prepareScenario({ ...catalog, datasetFingerprint: 'changed' }, 'seed', 5, signal, fetcher, cache)
    expect(changed.routeRequests).toBe(5)
  })
  it('reports a failed request without creating a vehicle or fabricated geometry', async () => {
    let index = 0
    const result = await prepareScenario(catalog, 'seed', 5, new AbortController().signal, async () => { if (index++ === 0) throw new Error('NOSEGMENT fixture'); return route }, new Map())
    expect(result.vehicles).toHaveLength(4); expect(result.failures).toHaveLength(1)
    expect(result.failures[0].reason).toContain('NOSEGMENT')
  })
  it('cancels queued work and refuses late responses', async () => {
    const controller = new AbortController()
    let resolve: (route: Route) => void = () => {}
    const pending = prepareScenario(catalog, 'seed', 1, controller.signal, () => new Promise(done => { resolve = done }), new Map())
    controller.abort(); resolve(route)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
function clockFixture() {
  let now = 0, callback: FrameRequestCallback = () => {}, next = 0
  const raf = vi.fn((fn: FrameRequestCallback) => { callback = fn; return ++next })
  vi.stubGlobal('requestAnimationFrame', raf); vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const clock = new FleetClock(); clock.configure(120)
  return { clock, raf, tick: (wall: number) => { now = wall; callback(wall) } }
}
describe('one absolute shared clock', () => {
  it('play/pause/resume, seek all vehicles, speed changes and reset', () => {
    const { clock, tick } = clockFixture()
    clock.play(); tick(1000)
    expect(clock.getSnapshot().simulationTimeSeconds).toBe(1)
    clock.pause(); tick(5000); expect(clock.getSnapshot().simulationTimeSeconds).toBe(1)
    clock.seek(70); const paused = clock.getSnapshot().simulationTimeSeconds
    expect(vehicleAt(vehicle, paused).progress).toBe(.5)
    clock.play(); tick(6000); expect(clock.getSnapshot().simulationTimeSeconds).toBe(71)
    clock.setSpeed(2); tick(7000); expect(clock.getSnapshot().simulationTimeSeconds).toBe(73)
    clock.setSpeed(4); tick(8000); expect(clock.getSnapshot().simulationTimeSeconds).toBe(77)
    clock.reset(); expect(clock.getSnapshot().simulationTimeSeconds).toBe(0)
    expect(vehicleAt(vehicle, 0).status).toBe('scheduled')
    clock.dispose()
  })
  it('stops at completion and cleans up RAF on scenario replacement/dispose', () => {
    const { clock, tick, raf } = clockFixture()
    clock.seek(119); clock.play(); tick(2000)
    expect(clock.getSnapshot().playbackStatus).toBe('completed')
    expect(raf).toHaveBeenCalledTimes(1)
    clock.play(); expect(clock.getSnapshot().simulationTimeSeconds).toBe(0)
    clock.configure(40); expect(cancelAnimationFrame).toHaveBeenCalled()
    clock.play(); clock.dispose(); expect(cancelAnimationFrame).toHaveBeenCalledTimes(2)
  })
  it('does not accumulate progress rounding across many frames', () => {
    const { clock, tick } = clockFixture(); clock.play()
    for (let i = 1; i <= 3000; i++) tick(i*20)
    expect(clock.getSnapshot().simulationTimeSeconds).toBe(60)
    clock.dispose()
  })
})
describe('fleet request lifecycle hook', () => {
  it('regenerate ignores old completion and mode switch aborts requests', async () => {
    const pending: { resolve: (response: unknown) => void; signal: AbortSignal }[] = []
    vi.stubGlobal('fetch', vi.fn((url, options) => url === '/api/fleet/candidates' ? Promise.resolve({ ok: true, json: async () => catalog }) : new Promise(resolve => pending.push({ resolve, signal: options.signal }))))
    const { result, rerender, unmount } = renderHook(({ active }) => useFleet(active, true), { initialProps: { active: true } })
    let first: Promise<void>, second: Promise<void>
    await act(async () => { first = result.current.generate('old', 1) })
    await act(async () => { second = result.current.generate('new', 1) })
    expect(pending[0].signal.aborted).toBe(true)
    await act(async () => { pending[1].resolve({ ok: true, json: async () => route }); await second! })
    expect(result.current.scenario?.seed).toBe('new')
    await act(async () => { pending[0].resolve({ ok: true, json: async () => route }); await first! })
    expect(result.current.scenario?.seed).toBe('new')
    rerender({ active: false }); expect(result.current.scenario).toBeNull(); expect(result.current.selectedVehicleId).toBeNull()
    unmount()
  })
  it('unmount cancels in-flight requests and a running animation', async () => {
    clockFixture()
    let signal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((url, options) => { signal = options.signal; return url === '/api/fleet/candidates' ? Promise.resolve({ ok: true, json: async () => catalog }) : Promise.resolve({ ok: true, json: async () => route }) }))
    const { result, unmount } = renderHook(() => useFleet(true, true))
    await act(async () => result.current.generate('seed', 1))
    act(() => result.current.clock.play()); unmount()
    expect(signal?.aborted).toBe(true); expect(cancelAnimationFrame).toHaveBeenCalled()
  })
})
