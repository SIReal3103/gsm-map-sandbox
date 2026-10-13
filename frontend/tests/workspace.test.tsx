import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { normalizeSimulationSpeed } from '../src/lib/simulation-speed'
import { FleetClock } from '../src/lib/fleet-clock'
import { usePlayback } from '../src/lib/use-playback'
import { InspectorSection } from '../src/components/inspector-section'
import { PrimaryNavigation } from '../src/components/primary-navigation'
import { PlaybackDock } from '../src/components/playback-dock'
import { FinancialComparison } from '../src/components/financial-comparison'
import { ChartViewport } from '../src/components/chart-viewport'
import { experimentMetrics, type Experiment } from '../src/lib/voucher'
import captured from '../../docs/evidence/a4/default.json'
import zero from '../../docs/evidence/a4/zero.json'
import capacity from '../../docs/evidence/a4/capacity.json'

describe('shared speed normalization', () => {
  it.each([[1,1],[2,2],[3,4],[4,4],[7,8],[8,8],[16,16],[17,32],[31,32],[32,32],[33,64],[64,64],[100,64],[0,1],[-3,1],[.5,1]])('%s rounds upwards to %s', (input, expected) => expect(normalizeSimulationSpeed(input)).toBe(expected))
  it.each(['', ' ', 'invalid', NaN, Infinity, -Infinity])('rejects invalid %s', input => expect(normalizeSimulationSpeed(input)).toBeNull())
  it('FleetClock reanchors at 16/32/64 without adding RAF; paused speed does not move or resume', () => {
    let now = 0, callback: FrameRequestCallback = () => {}
    const raf = vi.fn((fn: FrameRequestCallback) => { callback = fn; return 1 })
    vi.stubGlobal('requestAnimationFrame',raf); vi.stubGlobal('cancelAnimationFrame',vi.fn()); vi.spyOn(performance,'now').mockImplementation(() => now)
    const clock = new FleetClock(); clock.configure(500); clock.play(); now=1000; callback(now)
    for (const speed of [16,32,64]) { const requests=raf.mock.calls.length, before=clock.getSnapshot().simulationTimeSeconds; clock.setSpeed(speed); expect(raf).toHaveBeenCalledTimes(requests); expect(clock.getSnapshot().simulationTimeSeconds).toBe(before); now+=1000; callback(now); expect(clock.getSnapshot().simulationTimeSeconds).toBe(before+speed) }
    clock.pause(); const time=clock.getSnapshot().simulationTimeSeconds; clock.setSpeed(17); expect(clock.getSnapshot()).toMatchObject({simulationTimeSeconds:time,speedMultiplier:32,playbackStatus:'paused'}); clock.setSpeed(NaN); expect(clock.getSnapshot().speedMultiplier).toBe(32); clock.dispose()
  })
  it('Một hành trình applies the same speeds and consumes elapsed old-speed time without a second RAF', () => {
    let now = 0, callback: FrameRequestCallback = () => {}
    const raf = vi.fn((fn: FrameRequestCallback) => { callback=fn; return 1 })
    vi.stubGlobal('requestAnimationFrame',raf); vi.stubGlobal('cancelAnimationFrame',vi.fn()); vi.spyOn(performance,'now').mockImplementation(() => now)
    const route={coordinates:[[0,0],[1,0]] as [number,number][],duration:1000,distance:1,snap_points:[],duration_source:'explicit test fixture'}
    const {result,unmount}=renderHook(() => usePlayback(route)); act(() => result.current.play()); act(() => callback(0)); now=1000; act(() => callback(now))
    for(const speed of [16,32,64]) { const count=raf.mock.calls.length, before=result.current.progress; now+=500; act(() => result.current.setSpeed(speed)); expect(raf).toHaveBeenCalledTimes(count); const anchor=result.current.progress; expect(anchor).toBeGreaterThan(before); now+=1000; act(() => callback(now)); expect(result.current.progress).toBeCloseTo(anchor+speed/1000,10) }
    act(() => result.current.pause()); const progress=result.current.progress; act(() => result.current.setSpeed(17)); expect(result.current.speed).toBe(32); expect(result.current.progress).toBe(progress); expect(result.current.playing).toBe(false); unmount(); expect(cancelAnimationFrame).toHaveBeenCalled()
  })
})
describe('workspace presentation preserves mounted state', () => {
  it('offscreen charts do not mount; panel intersection changes visibility and observer is cleaned up', () => {
    let notify: IntersectionObserverCallback = () => {}; const disconnect=vi.fn(), observe=vi.fn()
    vi.stubGlobal('IntersectionObserver',class { constructor(callback:IntersectionObserverCallback){notify=callback} observe=observe; disconnect=disconnect })
    const {unmount}=render(<aside className="analytics-panel"><ChartViewport title="Visible chart"><p>Heavy chart content</p></ChartViewport></aside>)
    expect(screen.queryByText('Heavy chart content')).toBeNull(); expect(observe).toHaveBeenCalledTimes(1)
    act(()=>notify([{isIntersecting:true} as IntersectionObserverEntry],{} as IntersectionObserver)); expect(screen.getByText('Heavy chart content')).toBeInTheDocument()
    act(()=>notify([{isIntersecting:false} as IntersectionObserverEntry],{} as IntersectionObserver)); expect(screen.queryByText('Heavy chart content')).toBeNull(); unmount(); expect(disconnect).toHaveBeenCalledTimes(1)
  })
  it('collapsing configuration keeps inputs; prepare closes once and selection opens details', () => {
    const {rerender}=render(<InspectorSection title="Configuration" defaultOpen><input aria-label="Retained seed" defaultValue="seed"/></InspectorSection>)
    fireEvent.change(screen.getByLabelText('Retained seed'),{target:{value:'edited'}}); fireEvent.click(screen.getByRole('button',{name:'Configuration'})); expect(screen.getByLabelText('Retained seed')).toHaveValue('edited'); fireEvent.click(screen.getByRole('button',{name:'Configuration'}))
    rerender(<InspectorSection title="Configuration" prepared selection=""><input aria-label="Retained seed" defaultValue="seed"/></InspectorSection>); expect(screen.getByRole('button',{name:'Configuration'})).toHaveAttribute('aria-expanded','false')
    rerender(<InspectorSection title="Configuration" prepared selection="GSM-01"><input aria-label="Retained seed" defaultValue="seed"/></InspectorSection>); expect(screen.getByRole('button',{name:'Configuration'})).toHaveAttribute('aria-expanded','true'); expect(screen.getByLabelText('Retained seed')).toHaveValue('edited')
  })
  it('upstream modes and the learned campaign share navigation; layout callbacks preserve mode', () => {
    const mode=vi.fn(),size=vi.fn(); const {rerender}=render(<PrimaryNavigation mode="voucher" size="expanded" onMode={mode} onSize={size} mobileOpen={false} onMobileOpen={vi.fn()}/>)
    expect(screen.getByRole('navigation',{name:'Main menu'}).querySelectorAll('button')).toHaveLength(6); expect(screen.getByRole('button',{name:'Thí nghiệm voucher'})).toHaveAttribute('aria-current','page')
    for (const label of ['Luồng demo', 'Một hành trình', 'Đội xe', 'Đặt và điều xe', 'Thí nghiệm voucher', 'WP3 · Mô phỏng Quận 1']) expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'WP3 · Mô phỏng Quận 1' })); expect(mode).toHaveBeenCalledWith('wp3')
    fireEvent.click(screen.getByRole('button',{name:'Collapse navigation'})); expect(size).toHaveBeenCalledWith('collapsed'); fireEvent.click(screen.getByRole('button',{name:'Hide navigation'})); expect(size).toHaveBeenCalledWith('hidden'); fireEvent.click(screen.getByRole('button',{name:'Đặt và điều xe'})); expect(mode).toHaveBeenCalledWith('booking')
    rerender(<PrimaryNavigation mode="voucher" size="hidden" onMode={mode} onSize={size} mobileOpen={false} onMobileOpen={vi.fn()}/>); expect(screen.queryByRole('navigation',{name:'Main menu'})).toBeNull()
  })
  it('custom input 17 applies 32 and negative/empty/Infinity input preserves clock', () => {
    const setSpeed=vi.fn(); render(<PlaybackDock time={500} duration={2000} speed={4} status="paused" enabled label="Test" play={vi.fn()} pause={vi.fn()} reset={vi.fn()} seek={vi.fn()} setSpeed={setSpeed}/>)
    fireEvent.change(screen.getByLabelText('Custom Speed'),{target:{value:'17'}}); fireEvent.blur(screen.getByLabelText('Custom Speed')); expect(setSpeed).toHaveBeenLastCalledWith(32)
    for(const value of ['-2','','Infinity','abc']) {setSpeed.mockClear(); fireEvent.change(screen.getByLabelText('Custom Speed'),{target:{value}}); fireEvent.blur(screen.getByLabelText('Custom Speed')); expect(setSpeed).not.toHaveBeenCalled(); expect(screen.getByLabelText('Custom Speed')).toHaveValue('4'); expect(screen.getByRole('alert')).toBeInTheDocument()}
  })
  it('financial table uses observed selectors and refreshes for final/zero-budget results', () => {
    const experiment=captured as unknown as Experiment
    const table=(time:number,e=experiment) => <FinancialComparison baseline={experimentMetrics(e,'baseline',time)} treatment={experimentMetrics(e,'treatment',time)}/>
    const {rerender}=render(table(0)); expect(screen.getByRole('row',{name:/Completed Trips/})).toHaveTextContent('Completed Trips000')
    rerender(table(experiment.simulationDurationSeconds)); expect(screen.getByRole('row',{name:/Completed Trips/})).toHaveTextContent('Completed Trips1316+3'); expect(screen.getByRole('row',{name:/Voucher Spend/})).toHaveTextContent('+200.000'); expect(screen.getByRole('row',{name:/Rider Payments/})).toHaveTextContent('−31.870'); expect(screen.getAllByRole('row')).toHaveLength(5)
  })
  it('64x frame jumps and reverse seek reproduce ledger/lifecycle metrics without processing each frame', () => {
    const experiment=captured as unknown as Experiment
    let now=0, callback:FrameRequestCallback=()=>{}; vi.stubGlobal('requestAnimationFrame',vi.fn(fn=>{callback=fn;return 1})); vi.stubGlobal('cancelAnimationFrame',vi.fn()); vi.spyOn(performance,'now').mockImplementation(()=>now)
    const clock=new FleetClock(); clock.configure(experiment.simulationDurationSeconds); clock.setSpeed(64); clock.play(); now=40000; callback(now)
    expect(clock.getSnapshot().playbackStatus).toBe('completed'); const actual=experimentMetrics(experiment,'treatment',clock.getSnapshot().simulationTimeSeconds); expect({...actual,utilization:null}).toEqual({...experiment.final.treatment,utilization:null}); expect(actual.utilization).toBeCloseTo(experiment.final.treatment.utilization!,12)
    clock.seek(0); expect(experimentMetrics(experiment,'treatment',0).voucherSpendVnd).toBe(0); expect(experimentMetrics(experiment,'treatment',0).completed).toBe(0); clock.dispose()
  })
  it.each([zero,capacity])('comparison refreshes with a recorded zero-spend or no-increment scenario', recorded => {
    const experiment=recorded as unknown as Experiment, time=experiment.simulationDurationSeconds
    render(<FinancialComparison baseline={experimentMetrics(experiment,'baseline',time)} treatment={experimentMetrics(experiment,'treatment',time)}/>)
    expect(screen.getByRole('row',{name:/Completed Trips/}).lastElementChild).toHaveTextContent('0')
    const difference=experiment.final.treatment.voucherSpendVnd-experiment.final.baseline.voucherSpendVnd
    expect(screen.getByRole('row',{name:/Voucher Spend/}).lastElementChild).toHaveTextContent(difference ? '+20.000' : '0')
  })
})
