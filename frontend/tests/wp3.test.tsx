import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { bookingStatus, ledgerAt, vehicleState, type Wp3Run, type Wp3Result } from '../src/lib/wp3'
import { Wp3Workspace } from '../src/components/wp3-workspace'
import { positionAtTime } from '../src/lib/playback'

vi.mock('../src/components/sandbox-map', () => ({ SandboxMap: () => <div>Unit test map host</div> }))
// Explicit synthetic geometry tests temporal projection, not a road dataset.
const coordinateA: [number, number] = [106.69, 10.77], coordinateB: [number, number] = [106.70, 10.77]
const run = { policy: 'state_aware', vehicles: [{ id: 'V01', initial: 0 }], legs: [
  { vehicle_id: 'V01', request_id: 'Q001', kind: 'pickup', start: 10, end: 30, origin: 0, destination: 1, path_id: '0-1' },
  { vehicle_id: 'V01', request_id: 'Q001', kind: 'trip', start: 30, end: 60, origin: 1, destination: 0, path_id: '1-0' },
], events: [{ time: 10, spent_vnd: 0, reserved_vnd: 5000 }, { time: 60, spent_vnd: 5000, reserved_vnd: 0 }] } as Wp3Run
const result = { anchors: [{ coordinate: coordinateA }, { coordinate: coordinateB }], paths: { '0-1': { coordinates: [coordinateA, coordinateB] }, '1-0': { coordinates: [coordinateB, coordinateA] } } } as unknown as Wp3Result

describe('WP3 temporal projection and controls', () => {
  it('uses segment time instead of equal-distance speed and preserves endpoints', () => {
    const middle: [number, number] = [106.695, 10.77]
    const coordinates = [coordinateA, middle, coordinateB]
    expect(positionAtTime(coordinates, .1, [10, 90])).toEqual(middle)
    expect(positionAtTime(coordinates, .5, [10, 90])![0]).toBeCloseTo(106.69722222, 7)
    expect(positionAtTime(coordinates, 0, [10, 90])).toEqual(coordinateA)
    expect(positionAtTime(coordinates, 1, [10, 90])).toEqual(coordinateB)
    expect(positionAtTime(coordinates, .5, [0, 90])![0]).toBeCloseTo(106.6975, 7)
    expect(positionAtTime(coordinates, .5, [10])).toBeNull()
    expect(positionAtTime(coordinates, .5, [10, -1])).toBeNull()
  })
  it('projects WP3 cars using the routing time weights', () => {
    const timed = structuredClone(result)
    timed.paths['0-1'].coordinates = [coordinateA, [106.695, 10.77], coordinateB]
    timed.paths['0-1'].segment_durations = [1, 9]
    const state = vehicleState(run.vehicles[0], run, timed, 20)
    expect(state.coordinate[0]).toBeCloseTo(106.69722222, 7)
    expect(state.remainingSeconds).toBe(10)
  })
  it('keeps idle/deadhead/passenger phases continuous with no future destination jump', () => {
    expect(vehicleState(run.vehicles[0], run, result, 0).coordinate).toEqual(coordinateA)
    expect(vehicleState(run.vehicles[0], run, result, 20).coordinate[0]).toBeCloseTo(106.695, 6)
    expect(vehicleState(run.vehicles[0], run, result, 30)).toMatchObject({ coordinate: coordinateB, status: 'trip' })
    expect(vehicleState(run.vehicles[0], run, result, 60)).toMatchObject({ coordinate: coordinateA, status: 'idle' })
  })
  it('settles the ledger at completion, including seeking backward', () => {
    expect(ledgerAt(run, 59)).toEqual({ spent: 0, reserved: 5000 })
    expect(ledgerAt(run, 60)).toEqual({ spent: 5000, reserved: 0 })
    expect(ledgerAt(run, 0)).toEqual({ spent: 0, reserved: 0 })
  })
  it('an assigned trip is not expired while already travelling', () => {
    const booking = { id: 'Q', arrival: 0, accepted: true, assigned: 10, pickup: 30, completed: 60, expires: 30, origin: 0, destination: 1, offer_vnd: 5000, status: 'completed' }
    expect(bookingStatus(booking, 20)).toBe('pickup')
    expect(bookingStatus(booking, 45)).toBe('onboard')
    expect(bookingStatus(booking, 60)).toBe('completed')
  })
  it('does not reveal future customer booking before the observed request', () => {
    const booking = { id: 'Q', arrival: 0, requested: 360, offer_expires: 720, accepted: true, assigned: 370, pickup: 390, completed: 800, expires: 660, origin: 0, destination: 1, offer_vnd: 5000, status: 'completed' }
    expect(bookingStatus(booking, 359)).toBe('pending')
    expect(bookingStatus(booking, 360)).toBe('queued')
    expect(bookingStatus(booking, 720)).toBe('onboard')
    const noRequest = { ...booking, requested: undefined, accepted: false }
    expect(bookingStatus(noRequest, 719)).toBe('pending')
    expect(bookingStatus(noRequest, 720)).toBe('rejected')
  })
  it('blocks simulation when local data is unavailable and switches policies without network', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    render(<Wp3Workspace dataset={null} ready={false} onExplore={() => {}} onMapError={() => {}} />)
    for (const button of screen.getAllByRole('button', { name: 'Chạy mô phỏng' })) expect(button).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Không voucher' }))
    expect(screen.getByRole('button', { name: 'Không voucher' })).toHaveAttribute('aria-pressed', 'true')
    expect(fetch).not.toHaveBeenCalled()
  })
})
