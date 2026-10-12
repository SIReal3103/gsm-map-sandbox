import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import captured from '../../docs/evidence/a4/default.json'
import zeroCaptured from '../../docs/evidence/a4/zero.json'
import capacityCaptured from '../../docs/evidence/a4/capacity.json'
import { csv, delta, experimentCsv, experimentMetrics, validateExperiment, type Experiment } from '../src/lib/voucher'
import { useVoucher } from '../src/lib/use-voucher'
import VoucherDashboard from '../src/components/voucher-dashboard'
import { VoucherPanel } from '../src/components/voucher-panel'
import { bookingProjection } from '../src/lib/booking'

// Captured local OSRM plans, replayed offline for unit tests. Browser/WebGL proof is separate.
const plan = () => structuredClone(captured) as unknown as Experiment
vi.mock('../src/components/voucher-charts', () => ({ DefaultCharts: () => <div data-testid="default-charts">Two default charts</div>, ComparisonBar: () => <div/>, ComparisonLine: () => <div/>, historyRows: () => [] }))
vi.mock('../src/components/voucher-analytics', () => ({ default: () => <div>Advanced charts only on demand</div> }))

describe('paired experiment validation and independent projection', () => {
  it('validates real captured histories/financial summaries', () => {
    expect(validateExperiment(plan()).id).toBe(captured.id)
    expect(validateExperiment(zeroCaptured as unknown as Experiment)).toBeTruthy()
    expect(validateExperiment(capacityCaptured as unknown as Experiment)).toBeTruthy()
  })
  it('independently matches every backend time-series snapshot in both arms', () => {
    const e = plan()
    for (const row of e.timeSeries) for (const arm of ['baseline','treatment'] as const) {
      const actual = experimentMetrics(e,arm,row.timeSeconds)
      for (const [key,value] of Object.entries(row[arm])) {
        if (typeof value === 'number') expect(actual[key as keyof typeof actual]).toBeCloseTo(value,7)
        else expect(actual[key as keyof typeof actual]).toEqual(value)
      }
    }
  })
  it('backward Seek/reset reconstruct budget without future spend or assignments', () => {
    const e = plan(), first = experimentMetrics(e,'treatment',0)
    experimentMetrics(e,'treatment',e.simulationDurationSeconds)
    expect(experimentMetrics(e,'treatment',0)).toEqual(first)
    expect(first.voucherSpendVnd).toBe(0); expect(first.utilization).toBeNull()
    const cap = capacityCaptured as unknown as Experiment
    expect(cap.final.treatment.voucherCounts.RELEASED).toBeGreaterThan(0)
    expect(experimentMetrics(cap,'treatment',cap.simulationDurationSeconds).budget.reserved).toBe(0)
  })
  it('zero discount preserves inputs/assignments/events and operating metrics', () => {
    const e = zeroCaptured as unknown as Experiment
    for (const key of ['vehicles','demand','assignments','events'] as const) expect(e.baseline.plan[key]).toEqual(e.treatment.plan[key])
    expect(e.comparison).toEqual({ bookingUplift:0, incrementalCompleted:0, costPerIncrementalCompletionVnd:null })
  })
  it('rejects mismatched ledger, decisions, final KPIs and vehicle origins', () => {
    const bad = plan(); bad.treatment.ledger[0].available = -1; expect(() => validateExperiment(bad)).toThrow()
    const p = plan(); p.treatment.decisions[0].probability = .12345; expect(() => validateExperiment(p)).toThrow()
    const m = plan(); m.final.treatment.grossFareVnd++; expect(() => validateExperiment(m)).toThrow()
    const v = plan(); v.baseline.plan.vehicles[0].initialPosition = [0,0]; expect(() => validateExperiment(v)).toThrow()
  })
  it('uses accepted denominator, completed fare only and null nonpositive increment', () => {
    const e = plan(), m = experimentMetrics(e,'treatment',e.simulationDurationSeconds)
    expect(m.grossFareVnd).toBe(m.riderPaymentsVnd+m.voucherSpendVnd)
    expect(m.completionRate).toBe(m.completed/m.accepted)
    expect(m.conversionRate).toBe(m.accepted/m.validPotential)
    expect(delta({ ...m, completed:m.completed+1 },m).costPerIncrementalCompletionVnd).toBeNull()
  })
  it('switching arms at one timestamp gives positions from each full route', () => {
    const e = plan(), before = JSON.stringify(e)
    for (const arm of ['baseline','treatment'] as const) {
      const view = bookingProjection(e[arm].plan,500)
      expect(view.vehicles).toHaveLength(5)
      for (const v of view.vehicles) expect(v.currentPosition.every(Number.isFinite)).toBe(true)
    }
    expect(JSON.stringify(e)).toBe(before)
  })
  it('exports complete CSV sets with units/IDs/BOM and escapes strings', () => {
    const e = plan(), original = JSON.stringify(e), files = experimentCsv(e)
    expect(Object.keys(files)).toEqual(['summary','decisions','bookings','ledger','series'])
    for (const file of Object.values(files)) expect(file.startsWith('\ufeff')).toBe(true)
    expect(files.decisions).toContain(e.potential[0].id); expect(files.summary).toContain('grossFareVnd')
    expect(files.ledger).toContain('reserved_vnd'); expect(files.series).toContain('time_seconds')
    expect(csv([['=danger','comma,quote"',null]])).toBe('\ufeff"\'=danger","comma,quote""",""\r\n')
    expect(JSON.stringify(e)).toBe(original)
  })
})
describe('Studio lifecycle, navigation and on-demand analytics', () => {
  it('one clock; arm switch/Play/Pause/Seek/Speed/Reset never prepare again', async () => {
    vi.stubGlobal('requestAnimationFrame',vi.fn(() => 99)); vi.stubGlobal('cancelAnimationFrame',vi.fn())
    const fetcher = vi.fn().mockResolvedValue({ ok:true,json:async () => plan() }); vi.stubGlobal('fetch',fetcher)
    const { result,unmount } = renderHook(() => useVoucher(true,true))
    await act(async () => result.current.generate(captured.config as never))
    act(() => { result.current.clock.seek(500); result.current.selectArm('baseline') })
    expect(result.current.clock.getSnapshot().simulationTimeSeconds).toBe(500)
    act(() => { result.current.clock.play(); result.current.clock.pause(); result.current.clock.setSpeed(4); result.current.clock.reset() })
    expect(fetcher).toHaveBeenCalledTimes(1)
    act(() => result.current.clock.play()); unmount(); expect(cancelAnimationFrame).toHaveBeenCalled()
  })
  it('regenerate and mode changes abort stale responses and selection', async () => {
    const resolve: ((v: unknown) => void)[] = [], signals: AbortSignal[] = []
    vi.stubGlobal('fetch',vi.fn().mockImplementation((_,options) => { signals.push(options.signal); return new Promise(r => resolve.push(r)) }))
    const { result,rerender } = renderHook(({ active }) => useVoucher(active,true),{ initialProps:{ active:true } })
    let old!: Promise<void>, latest!: Promise<void>
    act(() => { old = result.current.generate(captured.config as never); latest = result.current.generate({ ...captured.config,seed:'new' } as never) })
    expect(signals[0].aborted).toBe(true)
    await act(async () => { resolve[1]({ ok:true,json:async () => plan() }); await latest })
    await act(async () => { resolve[0]({ ok:true,json:async () => { throw Error('stale must not overwrite') } }); await old })
    expect(result.current.experiment?.id).toBe(captured.id); expect(result.current.error).toBe('')
    act(() => result.current.setSelectedVehicleId('GSM-01'))
    rerender({ active:false }); expect(result.current.experiment).toBeNull(); expect(result.current.selectedVehicleId).toBeNull()
  })
  it('structured error/missing readiness keeps playback closed', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok:false,json:async () => ({ error:{ code:'ROUTER_UNAVAILABLE',message:'test local outage' } }) }); vi.stubGlobal('fetch',fetcher)
    const { result,rerender } = renderHook(({ ready }) => useVoucher(true,ready),{ initialProps:{ ready:false } })
    await act(async () => result.current.generate(captured.config as never)); expect(fetcher).not.toHaveBeenCalled()
    rerender({ ready:true }); await act(async () => result.current.generate(captured.config as never)); expect(result.current.error).toContain('ROUTER_UNAVAILABLE'); expect(result.current.experiment).toBeNull()
  })
  it('advanced analytics mounts only when requested and does not reset clock', async () => {
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ ok:true,json:async () => plan() }))
    const { result } = renderHook(() => useVoucher(true,true)); await act(async () => result.current.generate(captured.config as never))
    act(() => result.current.clock.seek(500))
    render(<VoucherDashboard session={result.current}/>)
    expect(screen.getByTestId('default-charts')).toBeInTheDocument(); expect(screen.queryByText('Advanced charts only on demand')).toBeNull()
    fireEvent.click(screen.getByRole('button',{ name:'Phân tích kinh doanh nâng cao' }))
    expect(await screen.findByText('Advanced charts only on demand')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button',{ name:'Đóng phân tích kinh doanh' }))
    expect(screen.queryByText('Advanced charts only on demand')).toBeNull(); expect(result.current.clock.getSnapshot().simulationTimeSeconds).toBe(500)
  })
  it('sensible defaults and separated advanced config with disabled readiness', () => {
    const { result } = renderHook(() => useVoucher(true,false))
    render(<VoucherPanel session={result.current} ready={false} onFocus={vi.fn()}/>)
    expect(screen.getByRole('button',{ name:'Prepare Experiment' })).toBeDisabled()
    expect(screen.getByRole('combobox',{ name:'Potential trip count' })).toHaveValue('30')
    expect(screen.getByRole('spinbutton',{ name:'Campaign budget (VND)' })).toHaveValue(200000)
  })
  it('fractional completed timestamp includes the final lifecycle events in observed KPIs', async () => {
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ ok:true,json:async () => plan() }))
    const { result } = renderHook(() => useVoucher(true,true))
    await act(async () => result.current.generate(captured.config as never))
    act(() => result.current.clock.seek(captured.simulationDurationSeconds))
    const { container } = render(<VoucherDashboard session={result.current}/>)
    const dashboard = container.querySelector('.voucher-dashboard')!
    expect(Number(dashboard.getAttribute('data-kpi-time'))).toBe(captured.simulationDurationSeconds)
    const observed = JSON.parse(dashboard.getAttribute('data-experiment-metrics')!).treatment
    expect(observed.completed).toBe(captured.final.treatment.completed)
    expect(observed.budget).toEqual(captured.final.treatment.budget)
    expect(observed.voucherSpendVnd).toBe(captured.final.treatment.voucherSpendVnd)
    expect(observed.utilization).toBeCloseTo(captured.final.treatment.utilization,12)
  })
})
