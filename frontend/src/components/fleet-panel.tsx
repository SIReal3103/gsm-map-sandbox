import { useState } from 'react'
import { Pause, Play, RotateCcw, Navigation, RefreshCw } from 'lucide-react'
import { Button } from './ui/button'
import { Slider } from './ui/slider'
import { fleetOverview, vehicleAt, type Vehicle } from '@/lib/fleet'
import { useFleetClock, type FleetSession } from '@/lib/use-fleet'

const distance = (m: number) => `${(m/1000).toFixed(2)} km`
const statusLabel = { scheduled: 'Chờ xuất phát', moving: 'Đang chạy', completed: 'Hoàn thành' }
export interface FleetFocus { id: string; kind: 'vehicle' | 'route'; sequence: number }
export function FleetPanel({ fleet, ready, onFocus }: { fleet: FleetSession; ready: boolean; onFocus: (id: string, kind: FleetFocus['kind']) => void }) {
  const [count, setCount] = useState(5), [seed, setSeed] = useState('hcm-fleet-2026')
  const clock = useFleetClock(fleet.clock), scenario = fleet.scenario
  const vehicles = scenario?.vehicles.map(v => vehicleAt(v, clock.simulationTimeSeconds)) ?? []
  const overview = fleetOverview(vehicles), selected = vehicles.find(v => v.id === fleet.selectedVehicleId)
  const duration = scenario?.simulationDurationSeconds ?? 0, usable = vehicles.length > 0 && ready && !fleet.loading
  const playing = clock.playbackStatus === 'playing'
  const metrics = fleet.clock.getMetrics()
  return <div className="fleet-panel" data-simulation-time={clock.simulationTimeSeconds} data-fleet-state={clock.playbackStatus}>
    <section className="sidebar-section">
      <div className="section-heading"><Navigation size={17} /><h2>Fleet Simulation</h2></div>
      <p className="simulation-disclaimer">Simulated fleet — not live GPS</p>
      <div className="fleet-inputs"><label>Số xe<select aria-label="Số xe" value={count} onChange={event => setCount(Number(event.target.value))}>{Array.from({ length: 10 }, (_, i) => <option key={i+1} value={i+1}>{i+1}</option>)}</select></label><label>Seed<input aria-label="Scenario seed" value={seed} maxLength={80} onChange={event => setSeed(event.target.value)} /></label></div>
      <div className="fleet-generate"><Button disabled={!ready || !seed.trim()} onClick={() => void fleet.generate(seed.trim(), count)}><RefreshCw size={15} />Generate Scenario</Button><Button variant="outline" onClick={() => setSeed(value => `${value.replace(/-new-\d+$/, '')}-new-${Date.now()}`)}>Seed mới</Button></div>
      {!ready && <p className="disabled-note">Cần bản đồ và OSRM local sẵn sàng.</p>}
      {fleet.loading && <p role="status">Đang chuẩn bị routes · {fleet.completedRequests}/{count} · tối đa 2 request đồng thời</p>}
      {fleet.error && <p role="alert" className="error-text">{fleet.error}</p>}
      {scenario && <div className="scenario-summary"><p>Đã tạo {vehicles.length}/{scenario.requestedVehicles} xe · {(scenario.preparationMilliseconds/1000).toFixed(2)} s</p><p>{scenario.routeRequests} route requests · {scenario.cacheHits} cache hits</p><p>Seed: {scenario.seed}</p><details><summary>Provenance scenario</summary><p>Fingerprint: {scenario.datasetFingerprint}</p><p>{scenario.routingSource} · {String(scenario.provenance.profile)} · snap ≤ {String(scenario.provenance.max_snap_meters)} m</p></details></div>}
      {!!scenario?.failures.length && <details open className="fleet-errors"><summary>{scenario.failures.length} xe không được tạo</summary>{scenario.failures.map(f => <p key={f.id}>{f.id}: {f.reason}</p>)}</details>}
      {!scenario && !fleet.loading && <p className="small-note">Tạo kịch bản từ các node đường OSM local. Chỉ nhận xe sau khi OSRM xác nhận tuyến và snapping.</p>}
    </section>
    <section className="sidebar-section">
      <div className="section-heading"><Play size={17} /><h2>Đồng hồ đội xe</h2></div>
      <div className="playback-buttons"><Button className="play-button" disabled={!usable || playing} onClick={fleet.clock.play}><Play size={16} />{clock.simulationTimeSeconds > 0 && clock.playbackStatus === 'paused' ? 'Resume' : 'Play'}</Button><Button variant="outline" disabled={!usable || !playing} onClick={fleet.clock.pause}><Pause size={16} />Pause</Button><Button variant="outline" disabled={!usable} aria-label="Reset fleet" onClick={fleet.clock.reset}><RotateCcw size={16} /></Button></div>
      <div className="progress-label"><label id="fleet-progress-label">Fleet Timeline</label><span>{duration ? Math.round(clock.simulationTimeSeconds/duration*100) : 0}%</span></div>
      <Slider aria-labelledby="fleet-progress-label" disabled={!usable} min={0} max={duration || 1} step={0.1} value={[clock.simulationTimeSeconds]} onValueChange={value => fleet.clock.seek(typeof value === 'number' ? value : value[0])} />
      <div className="speed-row"><span>Tốc độ toàn đội xe</span><div>{[1, 2, 4].map(speed => <Button size="sm" key={speed} disabled={!usable} variant={clock.speedMultiplier === speed ? 'secondary' : 'ghost'} aria-pressed={clock.speedMultiplier === speed} onClick={() => fleet.clock.setSpeed(speed)}>{speed}x</Button>)}</div></div>
      <p className="playback-time">{clock.simulationTimeSeconds.toFixed(1)} / {duration.toFixed(1)} s · {clock.playbackStatus}</p>
      <div className="fleet-overview" aria-label="Fleet overview">{[['Total', overview.total], ['Scheduled', overview.scheduled], ['Moving', overview.moving], ['Completed', overview.completed]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
      <p className="small-note">Kế hoạch: {distance(overview.plannedMeters)} · Đã đi mô phỏng: {distance(overview.traveledMeters)}</p>
      <details className="scenario-summary"><summary>Hiệu năng phiên playback</summary><p data-clock-metrics={JSON.stringify(metrics)}>{metrics.frameSamples} RAF samples · mean {metrics.meanFrameMilliseconds.toFixed(1)} ms · max gap {metrics.maxFrameMilliseconds.toFixed(1)} ms</p><p>Clock phát state tối đa 30 Hz; RAF gap gồm cả ảnh hưởng browser/GPU. Không phải chứng nhận FPS.</p></details>
    </section>
    {!!vehicles.length && <section className="sidebar-section"><div className="section-heading"><Navigation size={17} /><h2>Danh sách xe</h2></div>
      <div className="vehicle-list">{vehicles.map(v => <VehicleRow key={v.id} vehicle={v} selected={v.id === fleet.selectedVehicleId} onSelect={() => fleet.setSelectedVehicleId(v.id)} onFocus={() => onFocus(v.id, 'vehicle')} />)}</div>
    </section>}
    {selected && <section className="sidebar-section selected-detail"><h2>{selected.label} · {statusLabel[selected.status]}</h2><p>{selected.currentPosition.map(v => v.toFixed(6)).join(', ')}</p><p>Tiến độ {(selected.progress*100).toFixed(1)}% · còn {((1-selected.progress)*selected.durationSeconds).toFixed(1)} s</p><p>Snap A/B: {selected.route.snap_points.map(p => `${p.distance.toFixed(1)} m`).join(' / ')}</p><div className="fleet-generate"><Button size="sm" variant="outline" onClick={() => onFocus(selected.id, 'vehicle')}>Focus xe</Button><Button size="sm" variant="outline" onClick={() => onFocus(selected.id, 'route')}>Fit tuyến</Button></div></section>}
  </div>
}
function VehicleRow({ vehicle: v, selected, onSelect, onFocus }: { vehicle: Vehicle; selected: boolean; onSelect: () => void; onFocus: () => void }) {
  return <div className={`vehicle-row ${selected ? 'selected' : ''}`} data-vehicle-row={v.id} data-status={v.status} data-progress={v.progress}>
    <button className="vehicle-select" aria-label={`Chọn ${v.id}`} aria-pressed={selected} onClick={onSelect}><strong>{v.id}</strong><span className={`vehicle-status ${v.status}`}>{statusLabel[v.status]}</span><span>{distance(v.distanceMeters)} · {v.durationSeconds.toFixed(1)} s · xuất phát +{v.departureOffsetSeconds} s</span><span>{Math.round(v.progress*100)}%</span></button>
    <button className="vehicle-focus" aria-label={`Focus ${v.id}`} onClick={onFocus}><Navigation size={14} /></button>
  </div>
}
