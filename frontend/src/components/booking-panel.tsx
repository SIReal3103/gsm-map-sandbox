import { InspectorSection } from './inspector-section'
import { useMemo, useState } from 'react'
import { Play, Pause, RotateCcw, Users, RefreshCw } from 'lucide-react'
import { Button } from './ui/button'
import { Slider } from './ui/slider'
import { bookingProjection, type BookingConfig } from '@/lib/booking'
import { useFleetClock } from '@/lib/use-fleet'
import type { BookingSession } from '@/lib/use-booking'

export interface BookingFocus { kind: 'vehicle' | 'booking' | 'overview'; id: string; sequence: number }
const labels = { scheduled: 'Chưa yêu cầu', waiting: 'Chờ xe', assigned: 'Xe đến đón', picked_up: 'Đang đi', completed: 'Hoàn tất', unserved: 'Không phục vụ', idle: 'Rảnh', en_route_to_pickup: 'Đến đón', on_trip: 'Chở khách' }
const number = (value: number | null, suffix = ' s') => value === null ? '—' : value.toFixed(1)+suffix
const percent = (value: number | null) => value === null ? '—' : (value*100).toFixed(1)+'%'
export function BookingPanel({ session, ready, onFocus, docked = false }: { session: BookingSession; ready: boolean; docked?: boolean; onFocus: (focus: BookingFocus) => void }) {
  const [config, setConfig] = useState<BookingConfig>({ seed: 'hcm-booking-2026', fleetSize: 5, bookingCount: 20, horizonSeconds: 1800, maxWaitSeconds: 300, preset: 'Medium' })
  const [filter, setFilter] = useState('active')
  const [seekSeconds, setSeekSeconds] = useState('0')
  const clock = useFleetClock(session.clock), plan = session.plan
  const view = useMemo(() => plan ? bookingProjection(plan, clock.simulationTimeSeconds) : null, [plan, clock.simulationTimeSeconds])
  const planned = useMemo(() => plan ? bookingProjection(plan, plan.simulationDurationSeconds) : null, [plan])
  const usable = !!plan && ready && !session.loading, playing = clock.playbackStatus === 'playing'
  const selected = view?.bookings.find(b => b.id === session.selectedBookingId)
  const focus = (kind: BookingFocus['kind'], id: string) => onFocus({ kind, id, sequence: performance.now() })
  const metrics = view?.metrics
  const shown = view?.bookings.filter(b => filter === 'all' || (filter === 'active' ? ['waiting', 'assigned', 'picked_up'].includes(b.status) : b.status === filter)) ?? []
  return <div className="fleet-panel booking-panel" data-booking-time={clock.simulationTimeSeconds} data-booking-clock={clock.playbackStatus}>
    <InspectorSection title="Booking Configuration" defaultOpen prepared={docked && !!plan}><div className="section-heading"><Users size={17} /><h2>Booking & Dispatch</h2></div><p className="simulation-disclaimer">Mô phỏng nhu cầu · không phải hành khách/GPS GSM thực tế</p>
      <div className="booking-inputs">
        <label>Số xe<select aria-label="Booking fleet size" value={config.fleetSize} onChange={e => setConfig({ ...config, fleetSize: +e.target.value })}>{Array.from({ length: 10 }, (_, i) => <option key={i+1}>{i+1}</option>)}</select></label>
        <label>Bookings<select aria-label="Booking count" value={config.bookingCount} onChange={e => setConfig({ ...config, bookingCount: +e.target.value })}>{Array.from({ length: 21 }, (_, i) => <option key={i+10}>{i+10}</option>)}</select></label>
        <label className="wide">Seed<input aria-label="Booking seed" value={config.seed} maxLength={80} onChange={e => setConfig({ ...config, seed: e.target.value })} /></label>
        <label>Demand<select aria-label="Demand preset" value={config.preset} onChange={e => setConfig({ ...config, preset: e.target.value as BookingConfig['preset'] })}>{['Low', 'Medium', 'High'].map(p => <option key={p}>{p}</option>)}</select></label>
        <label>Horizon (s)<input aria-label="Demand horizon seconds" type="number" min={60} max={3600} value={config.horizonSeconds} onChange={e => setConfig({ ...config, horizonSeconds: +e.target.value })} /></label>
        <label className="wide">Giới hạn chờ đến lúc đón (s)<input aria-label="Maximum pickup wait seconds" type="number" min={10} max={900} value={config.maxWaitSeconds} onChange={e => setConfig({ ...config, maxWaitSeconds: +e.target.value })} /></label>
      </div>
      <p className="small-note">Low: trải đều có jitter. Medium: thời điểm đều ngẫu nhiên theo seed. High: dồn vào ¼ đầu horizon. Preset giữ nguyên số booking.</p>
      <Button disabled={!ready || !config.seed.trim() || config.horizonSeconds < 60 || config.horizonSeconds > 3600 || config.maxWaitSeconds < 10 || config.maxWaitSeconds > 900} onClick={() => { setSeekSeconds('0'); void session.generate({ ...config, seed: config.seed.trim() }) }}><RefreshCw size={15} />Generate Booking Scenario</Button>
      {session.loading && <p role="status">Đang chuẩn bị dispatch plan bằng OSRM local… Có thể mất vài chục giây; playback chưa mở.</p>}
      {session.error && <p role="alert" className="error-text">{session.error}</p>}
      {plan && <details className="scenario-summary"><summary>Plan đã xác minh · {(plan.preparationMilliseconds/1000).toFixed(2)} s</summary><p>Seed: {plan.seed}<br />Fingerprint: {plan.datasetFingerprint}</p><p>{plan.routingRequests.table} Table · {plan.routingRequests.route} routes · {plan.routingRequests.routeCacheHits} cache hits · {plan.routingSource}</p><p>Demand v1 · FIFO / ETA v1 · không routing trong playback</p></details>}
    </InspectorSection>
    <InspectorSection title="Scenario View" defaultOpen><div className="section-heading"><Play size={17} /><h2>Scenario view</h2></div>
      {!docked && <>
      <div className="playback-buttons"><Button disabled={!usable || playing} onClick={session.clock.play}><Play size={16} />{clock.simulationTimeSeconds > 0 && clock.playbackStatus === 'paused' ? 'Resume' : 'Play'}</Button><Button variant="outline" disabled={!usable || !playing} onClick={session.clock.pause}><Pause size={16} />Pause</Button><Button variant="outline" disabled={!usable} aria-label="Reset booking simulation" onClick={() => { setSeekSeconds('0'); session.clock.reset() }}><RotateCcw size={16} /></Button></div>
      <div className="progress-label"><label id="booking-timeline">Booking Timeline</label><span>{plan ? Math.round(clock.simulationTimeSeconds/plan.simulationDurationSeconds*100) : 0}%</span></div>
      <Slider aria-labelledby="booking-timeline" disabled={!usable} min={0} max={plan?.simulationDurationSeconds ?? 1} step={.1} value={[clock.simulationTimeSeconds]} onValueChange={v => session.clock.seek(typeof v === 'number' ? v : v[0])} />
      <div className="booking-seek"><input aria-label="Seek simulation seconds" type="number" min={0} max={plan?.simulationDurationSeconds ?? 0} step="any" value={seekSeconds} disabled={!usable} onChange={e => setSeekSeconds(e.target.value)} /><Button size="sm" variant="outline" disabled={!usable || !seekSeconds.trim() || !Number.isFinite(Number(seekSeconds))} onClick={() => session.clock.seek(Number(seekSeconds))}>Seek (s)</Button></div>
      <p className="playback-time">{number(clock.simulationTimeSeconds)} / {number(plan?.simulationDurationSeconds ?? 0)} · {clock.playbackStatus}</p>
      <details className="scenario-summary"><summary>Hiệu năng clock</summary><p data-booking-clock-metrics={JSON.stringify(session.clock.getMetrics())}>{session.clock.getMetrics().frameSamples} RAF samples · mean {session.clock.getMetrics().meanFrameMilliseconds.toFixed(1)} ms · max gap {session.clock.getMetrics().maxFrameMilliseconds.toFixed(1)} ms. Không phải chứng nhận FPS.</p></details>
      <div className="speed-row"><span>Tốc độ mô phỏng</span><div>{[1, 2, 4].map(s => <Button key={s} size="sm" variant={clock.speedMultiplier === s ? 'secondary' : 'ghost'} disabled={!usable} aria-pressed={clock.speedMultiplier === s} onClick={() => session.clock.setSpeed(s)}>{s}x</Button>)}</div></div>
      </>}
      <Button size="sm" variant="outline" disabled={!usable} onClick={() => focus('overview', 'scenario')}>Fit vùng scenario</Button>
    </InspectorSection>
    {metrics && <InspectorSection title="Observed Metrics" defaultOpen><h2>Observed · tới thời điểm hiện tại</h2><div className="fleet-overview">{[['Requested', metrics.requested], ['Assigned', metrics.assigned], ['Completed', metrics.completed], ['Unserved', metrics.unserved]].map(([l, n]) => <div key={l}><span>{l}</span><strong>{n}</strong></div>)}</div>
      <dl className="booking-metrics" data-booking-metrics={JSON.stringify(metrics)}><dt>Đã đón / đã yêu cầu</dt><dd>{percent(metrics.serviceRate)}</dd><dt>Hoàn tất / đã yêu cầu</dt><dd>{percent(metrics.completionRate)}</dd><dt>Chờ TB · đã đón</dt><dd>{number(metrics.averageWaitingSeconds)}</dd><dt>Chuyến TB · hoàn tất</dt><dd>{number(metrics.averageTripSeconds)}</dd><dt>ETA đón TB · đã gán</dt><dd>{number(metrics.averageEstimatedPickupEtaSeconds)}</dd><dt>Quãng đường rỗng</dt><dd>{number(metrics.emptyMeters/1000, ' km')}</dd><dt>Quãng đường chở khách</dt><dd>{number(metrics.occupiedMeters/1000, ' km')}</dd><dt>Utilization · busy / fleet-time</dt><dd>{percent(metrics.utilization)}</dd></dl>
      <p className="small-note">Waiting/utilization là mô phỏng; duration/distance theo profile OSRM, không live traffic. Assigned là số booking đã từng được gán.</p>
      <details className="scenario-summary"><summary>Planned · toàn bộ scenario</summary><p>{planned!.metrics.completed}/{plan!.demand.length} hoàn tất · {planned!.metrics.unserved} unserved</p><p>Rỗng {number(planned!.metrics.emptyMeters/1000, ' km')} · chở khách {number(planned!.metrics.occupiedMeters/1000, ' km')}</p></details>
    </InspectorSection>}
    {view && <InspectorSection title="Bookings" defaultOpen><h2>Bookings</h2><label className="booking-filter">Lọc trạng thái<select aria-label="Booking status filter" value={filter} onChange={e => setFilter(e.target.value)}>{[['active', 'Đang hoạt động'], ['all', 'Tất cả (gồm tương lai)'], ['unserved', 'Không phục vụ'], ['completed', 'Hoàn tất']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      {!shown.length && <p className="small-note">Không có booking trong bộ lọc ở thời điểm này.</p>}
      <div className="vehicle-list">{shown.map(b => <button key={b.id} className={`booking-row ${session.selectedBookingId === b.id ? 'selected' : ''}`} aria-label={`Chọn booking ${b.id}`} aria-pressed={session.selectedBookingId === b.id} data-booking-id={b.id} data-status={b.status} onClick={() => { session.setSelectedBookingId(b.id); session.setSelectedVehicleId(b.assignment?.vehicleId ?? null); focus('booking', b.id) }}><strong>{b.id}</strong><span>{labels[b.status]}</span><small>Yêu cầu +{number(b.requestTimeSeconds)} · {b.assignment?.vehicleId ?? 'Chưa gán'} · chờ {number(b.waitingSeconds)}</small>{b.failureReason && <small className="error-text">{b.failureReason}</small>}</button>)}</div>
    </InspectorSection>}
    {selected && <InspectorSection title="Booking Details" selection={(session.selectedBookingId ?? "") + (session.selectedVehicleId ?? "")}><h2>{selected.id} · {labels[selected.status]}</h2><p>Pickup: {selected.pickup.map(v => v.toFixed(6)).join(', ')}<br />Dropoff: {selected.dropoff.map(v => v.toFixed(6)).join(', ')}</p><p>Xe: {selected.assignment?.vehicleId ?? '—'} · ETA đón {number(selected.assignment?.estimatedPickupEtaSeconds ?? null)}<br />Chờ mô phỏng: {number(selected.waitingSeconds)} · chuyến OSRM: {number(selected.assignment?.tripRoute.duration ?? null)}</p>{selected.failureReason && <p>{selected.failureReason}</p>}<Button variant="outline" size="sm" onClick={() => focus('booking', selected.id)}>Fit booking</Button></InspectorSection>}
    {view && <InspectorSection title="Dispatch Fleet" defaultOpen><h2>Dispatch fleet</h2><div className="vehicle-list">{view.vehicles.map(v => <button className={`booking-row ${session.selectedVehicleId === v.id ? 'selected' : ''}`} key={v.id} aria-label={`Focus dispatch ${v.id}`} data-dispatch-row={v.id} data-status={v.status} onClick={() => { session.setSelectedVehicleId(v.id); session.setSelectedBookingId(v.activeBookingId); focus('vehicle', v.id) }}><strong>{v.id}</strong><span>{labels[v.status]}</span><small>{v.activeBookingId ?? 'Không có booking'} · {v.completedBookingIds.length} chuyến hoàn tất<br />Rỗng {number(v.emptyMeters/1000, ' km')} · chở khách {number(v.occupiedMeters/1000, ' km')}</small></button>)}</div></InspectorSection>}
    {view && <InspectorSection title="Event Timeline"><h2>Timeline sự kiện · {view.events.length}</h2><ol className="booking-events">{view.events.slice(-16).reverse().map(e => <li key={e.id}><time>{number(e.timestampSeconds)}</time><span>{e.type}<small>{e.bookingId}{e.vehicleId ? ' · '+e.vehicleId : ''}{e.payload.failureReason ? ' · '+e.payload.failureReason : ''}</small></span></li>)}</ol><p className="small-note">16 sự kiện gần nhất tới simulation time; Seek ngược loại bỏ sự kiện tương lai.</p></InspectorSection>}
  </div>
}
