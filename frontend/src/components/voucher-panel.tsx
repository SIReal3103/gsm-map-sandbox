import { InspectorSection } from './inspector-section'
import { useMemo, useState } from 'react'
import { FlaskConical, Play, Pause, RotateCcw } from 'lucide-react'
import { Button } from './ui/button'
import { Slider } from './ui/slider'
import { defaultExperimentConfig, experimentMetrics, vnd, type ExperimentConfig } from '@/lib/voucher'
import { bookingProjection } from '@/lib/booking'
import { useFleetClock } from '@/lib/use-fleet'
import type { VoucherSession } from '@/lib/use-voucher'
import type { BookingFocus } from './booking-panel'

export function VoucherPanel({ session, ready, onFocus, docked = false }: { session: VoucherSession; ready: boolean; docked?: boolean; onFocus: (focus: BookingFocus) => void }) {
  const [config, setConfig] = useState<ExperimentConfig>(structuredClone(defaultExperimentConfig)), [seek, setSeek] = useState('0')
  const clock = useFleetClock(session.clock), experiment = session.experiment
  const time = clock.simulationTimeSeconds, usable = !!experiment && ready && !session.loading, playing = clock.playbackStatus === 'playing'
  const metricTime = playing ? Math.floor(time) : time
  const projection = useMemo(() => experiment ? bookingProjection(experiment[session.arm].plan, time) : null, [experiment, session.arm, time])
  const metrics = useMemo(() => experiment ? experimentMetrics(experiment, session.arm, metricTime) : null, [experiment, session.arm, metricTime])
  const focus = (kind: BookingFocus['kind'], id: string) => onFocus({ kind, id, sequence: performance.now() })
  const input = (label: string, value: number, update: (value: number) => void, min: number, max: number, step=1) => <label>{label}<input aria-label={label} type="number" value={value} min={min} max={max} step={step} onChange={e => update(+e.target.value)} /></label>
  const selected = projection?.bookings.find(b => b.id === session.selectedBookingId)
  return <div className="voucher-panel" data-experiment-time={time} data-experiment-clock={clock.playbackStatus} data-experiment-arm={session.arm} data-clock-metrics={JSON.stringify(session.clock.getMetrics())}>
    <InspectorSection title="Experiment Configuration" defaultOpen prepared={docked && !!experiment}><div className="section-heading"><FlaskConical size={18}/><h2>Voucher Experiment</h2></div><p className="simulation-disclaimer">Giá và hành vi giả định · chưa hiệu chỉnh từ khách hàng GSM</p>
      <div className="booking-inputs"><label className="wide">Seed<input aria-label="Experiment seed" value={config.seed} maxLength={80} onChange={e => setConfig({ ...config, seed: e.target.value })}/></label>
        <label>Fleet<select aria-label="Experiment fleet size" value={config.fleetSize} onChange={e => setConfig({ ...config, fleetSize: +e.target.value })}>{Array.from({ length: 10 }, (_, i) => <option key={i+1}>{i+1}</option>)}</select></label>
        <label>Potential trips<select aria-label="Potential trip count" value={config.potentialCount} onChange={e => setConfig({ ...config, potentialCount: +e.target.value })}>{Array.from({ length: 21 }, (_, i) => <option key={i+10}>{i+10}</option>)}</select></label>
        <label>Demand<select aria-label="Experiment demand preset" value={config.preset} onChange={e => setConfig({ ...config, preset: e.target.value as ExperimentConfig['preset'] })}>{['Low','Medium','High'].map(p => <option key={p}>{p}</option>)}</select></label>
        {input('Booking horizon (s)', config.horizonSeconds, horizonSeconds => setConfig({ ...config, horizonSeconds }),60,3600)}
      </div>
      <InspectorSection title="Voucher Policy" defaultOpen={!docked}><div className="booking-inputs voucher-policy"><label>Voucher<select aria-label="Voucher type" value={config.voucher.type} onChange={e => setConfig({ ...config, voucher: { ...config.voucher, type: e.target.value as 'fixed' | 'percentage' } })}><option value="fixed">Fixed VND</option><option value="percentage">Percentage</option></select></label>
        {config.voucher.type === 'fixed' ? input('Fixed discount (VND)', config.voucher.fixedAmount, fixedAmount => setConfig({ ...config, voucher: { ...config.voucher, fixedAmount } }),0,1000000) : input('Discount rate (0–1)',config.voucher.rate,rate => setConfig({ ...config, voucher: { ...config.voucher, rate } }),0,1,.01)}
        {input('Campaign budget (VND)',config.campaignBudget,campaignBudget => setConfig({ ...config, campaignBudget }),0,10000000)}
      </div></InspectorSection>
      <details className="scenario-summary"><summary>Passenger Behavior & Fare Assumptions</summary><div className="booking-inputs">
        {input('Base fare (VND)',config.fare.baseFare,baseFare => setConfig({ ...config, fare: { ...config.fare, baseFare } }),0,100000)}
        {input('Distance rate (VND/km)',config.fare.perKm,perKm => setConfig({ ...config, fare: { ...config.fare, perKm } }),0,100000)}
        {input('Alpha (log-odds)',config.behavior.alpha,alpha => setConfig({ ...config, behavior: { ...config.behavior, alpha } }),-20,20,.1)}
        {input('Beta (price sensitivity)',config.behavior.beta,beta => setConfig({ ...config, behavior: { ...config.behavior, beta } }),0,20,.1)}
        {input('Reference fare (VND)',config.behavior.referenceFare,referenceFare => setConfig({ ...config, behavior: { ...config.behavior, referenceFare } }),1,1000000)}
        {input('Minimum fare (VND)',config.voucher.minimumFare,minimumFare => setConfig({ ...config, voucher: { ...config.voucher, minimumFare } }),0,1000000)}
        {input('Percentage cap (VND)',config.voucher.cap,cap => setConfig({ ...config, voucher: { ...config.voucher, cap } }),0,1000000)}
        {input('Maximum pickup wait (s)',config.maxWaitSeconds,maxWaitSeconds => setConfig({ ...config, maxWaitSeconds }),10,900)}
      </div><p className="small-note">Fare = base + rate × OSRM km. Sigmoid(alpha − beta × effective fare / reference fare). Cùng random draw cho hai arms. Không đủ budget: giá gốc, không partial voucher.</p></details>
      <Button disabled={!ready || !config.seed.trim()} onClick={() => { setSeek('0'); void session.generate({ ...config, seed: config.seed.trim() }) }}>Prepare Experiment</Button>
      {session.loading && <p role="status">Đang quote và chuẩn bị hai arms bằng OSRM local…</p>}{session.error && <p role="alert" className="error-text">{session.error}</p>}
      {experiment && <details className="scenario-summary"><summary>Experiment ready · {(experiment.preparationMilliseconds/1000).toFixed(2)} s</summary><p>Seed: {experiment.seed}<br/>Fingerprint: {experiment.id}<br/>{experiment.routingRequests.table} Table · {experiment.routingRequests.route} routes · {experiment.routingRequests.routeCacheHits} cache hits</p><p>{experiment.potential.filter(p => !p.valid).length} invalid quote(s), loại khỏi conversion denominator.</p></details>}
    </InspectorSection>
    <InspectorSection title="Arm & Budget" defaultOpen><h2>Experiment arm</h2><div className="arm-switch" role="group" aria-label="Experiment arm">{(['baseline','treatment'] as const).map(arm => <Button key={arm} variant={session.arm === arm ? 'secondary' : 'outline'} aria-pressed={session.arm === arm} onClick={() => session.selectArm(arm)}>{arm === 'baseline' ? 'Baseline' : 'Treatment'}</Button>)}</div>
      {!docked && <>
      <div className="playback-buttons"><Button disabled={!usable || playing} onClick={session.clock.play}><Play size={15}/>{clock.playbackStatus === 'paused' && time > 0 ? 'Resume' : 'Play'}</Button><Button variant="outline" disabled={!usable || !playing} onClick={session.clock.pause}><Pause size={15}/>Pause</Button><Button variant="outline" aria-label="Reset experiment" disabled={!usable} onClick={() => { session.clock.reset(); setSeek('0') }}><RotateCcw size={15}/></Button></div>
      <label id="experiment-timeline">Experiment Timeline</label><Slider aria-labelledby="experiment-timeline" disabled={!usable} min={0} max={experiment?.simulationDurationSeconds ?? 1} step={.1} value={[time]} onValueChange={value => session.clock.seek(typeof value === 'number' ? value : value[0])}/>
      <div className="booking-seek"><input aria-label="Experiment seek seconds" type="number" min={0} max={experiment?.simulationDurationSeconds ?? 0} disabled={!usable} value={seek} onChange={e => setSeek(e.target.value)}/><Button disabled={!usable || !seek.trim() || !Number.isFinite(+seek)} variant="outline" onClick={() => session.clock.seek(+seek)}>Seek experiment</Button></div>
      <p className="playback-time">{time.toFixed(1)} / {(experiment?.simulationDurationSeconds ?? 0).toFixed(1)} s · {clock.playbackStatus}</p><div className="speed-row">{[1,2,4].map(s => <Button key={s} disabled={!usable} size="sm" variant={clock.speedMultiplier === s ? 'secondary' : 'ghost'} aria-pressed={clock.speedMultiplier === s} onClick={() => session.clock.setSpeed(s)}>{s}x</Button>)}</div>
      </>}
      <Button variant="outline" size="sm" disabled={!usable} onClick={() => focus('overview','scenario')}>Fit vùng experiment</Button>
      {metrics && <div className="budget-summary"><strong>Budget · {session.arm} · tới t hiện tại</strong><p>Reserved {vnd(metrics.budget.reserved)}<br/>Settled {vnd(metrics.budget.spent)}<br/>Available {vnd(metrics.budget.available)}</p><small>Offered {metrics.voucherCounts.OFFERED} · reserved {metrics.voucherCounts.RESERVED} · redeemed {metrics.voucherCounts.SETTLED} · released {metrics.voucherCounts.RELEASED}</small></div>}
    </InspectorSection>
    {projection && <InspectorSection title="Vehicle / Booking Details" selection={(session.selectedBookingId ?? "") + (session.selectedVehicleId ?? "")}><h2>Xe / booking · {session.arm}</h2><p className="small-note">Vàng: đến đón · xanh: chở khách · xám: idle</p><div className="vehicle-list">{projection.vehicles.map(v => <button key={v.id} className={`booking-row ${session.selectedVehicleId === v.id ? 'selected' : ''}`} aria-label={`Focus experiment ${v.id}`} onClick={() => { session.setSelectedVehicleId(v.id); session.setSelectedBookingId(v.activeBookingId); focus('vehicle',v.id) }}><strong>{v.id}</strong><span>{v.status}</span><small>{v.activeBookingId ?? 'Idle'} · {v.completedBookingIds.length} trips</small></button>)}</div>
      <div className="vehicle-list">{projection.bookings.filter(b => b.status !== 'scheduled').map(b => <button className="booking-row" key={b.id} aria-label={`Select experiment booking ${b.id}`} onClick={() => { session.setSelectedBookingId(b.id); session.setSelectedVehicleId(b.assignment?.vehicleId ?? null); focus('booking',b.id) }}><strong>{b.id}</strong><span>{b.status}</span><small>{b.assignment?.vehicleId ?? b.failureReason ?? 'Waiting'}</small></button>)}</div>
      {selected && <div className="selected-detail"><h3>{selected.id} · {selected.status}</h3><p>Pickup {selected.pickup.map(p => p.toFixed(6)).join(', ')}<br/>Dropoff {selected.dropoff.map(p => p.toFixed(6)).join(', ')}<br/>Chờ {selected.waitingSeconds?.toFixed(1) ?? '—'} s · ETA {selected.assignment?.estimatedPickupEtaSeconds.toFixed(1) ?? '—'} s</p></div>}
    </InspectorSection>}
  </div>
}
