import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Check, ChevronRight, Database, FileBox, FolderOpen, Layers, MapPin, Navigation, RefreshCw, Route as RouteIcon, Server, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { PrimaryNavigation } from '@/components/primary-navigation'
import { InspectorSection } from '@/components/inspector-section'
import { PlaybackDock, ClockDock } from '@/components/playback-dock'
import { SandboxMap } from '@/components/sandbox-map'
import { api, type Coordinate, type DatasetStatus, type Route } from '@/lib/api'
import { usePlayback } from '@/lib/use-playback'
import './App.css'
import { useFleet } from '@/lib/use-fleet'
import { FleetPanel, type FleetFocus } from '@/components/fleet-panel'
import { RuntimeAudit } from '@/components/runtime-audit'
import { useBooking } from '@/lib/use-booking'
import { BookingPanel, type BookingFocus } from '@/components/booking-panel'

import { useVoucher } from '@/lib/use-voucher'
import { VoucherPanel } from '@/components/voucher-panel'
const VoucherDashboard = lazy(() => import('@/components/voucher-dashboard'))

const coordinateText = (point: Coordinate | null) => point ? point.map(v => v.toFixed(6)).join(', ') : 'Chưa chọn trên bản đồ'
const pbfLabels: Record<string, string> = { missing_pbf: 'Chưa có file PBF', present_unverified: 'Đã có file · chưa xác minh', invalid_extension: 'Sai phần mở rộng', unreadable_pbf: 'Không đọc được file', empty_pbf: 'File PBF rỗng' }

export default function App() {
  const [dataset, setDataset] = useState<DatasetStatus | null>(null)
  const [connectionError, setConnectionError] = useState('')
  const [mapError, setMapError] = useState('')
  const [routeError, setRouteError] = useState('')
  const [start, setStart] = useState<Coordinate | null>(null)
  const [end, setEnd] = useState<Coordinate | null>(null)
  const [route, setRoute] = useState<Route | null>(null)
  const [routing, setRouting] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [mode, setMode] = useState<'single' | 'fleet' | 'booking' | 'voucher'>('single')
  const [navigationSize, setNavigationSize] = useState<'expanded' | 'collapsed' | 'hidden'>('expanded')
  const [mobileMenu, setMobileMenu] = useState(false)
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [mobileView, setMobileView] = useState<'map' | 'analytics'>('map')
  const [bookingFocus, setBookingFocus] = useState<BookingFocus | null>(null)
  const [fleetFocus, setFleetFocus] = useState<FleetFocus | null>(null)
  const request = useRef<AbortController | null>(null)
  const playback = usePlayback(route)
  const ready = !!dataset?.ready && !connectionError && !mapError
  const fleet = useFleet(mode === 'fleet', ready)
  const booking = useBooking(mode === 'booking', ready)
  const voucher = useVoucher(mode === 'voucher', ready)
  const focusVehicle = (id: string, kind: FleetFocus['kind']) => { fleet.setSelectedVehicleId(id); setFleetFocus({ id, kind, sequence: performance.now() }) }
  const changeMode = (next: 'single' | 'fleet' | 'booking' | 'voucher') => { if (next === mode) return; playback.pause(); clear(); fleet.clear(); booking.clear(); voucher.clear(); setFleetFocus(null); setBookingFocus(null); setMode(next) }
  const mapReady = !!dataset?.artifacts.map_ready
  const pbfPresent = ['present_unverified', 'present_verified'].includes(dataset?.pbf.state ?? '')

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const data = await api<DatasetStatus>('/api/dataset/status', { signal: controller.signal })
        if (!controller.signal.aborted) { setDataset(data); setConnectionError('') }
      } catch {
        if (!controller.signal.aborted) setConnectionError('Backend chưa kết nối. Khởi động FastAPI trên 127.0.0.1:8000.')
      } finally { if (!controller.signal.aborted) timer = setTimeout(poll, 10000) }
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [refreshKey])

  const clear = useCallback(() => {
    request.current?.abort(); setRouting(false); setStart(null); setEnd(null); setRoute(null); setRouteError('')
  }, [])
  useEffect(() => { if (!ready) clear() }, [ready, clear])
  useEffect(() => () => request.current?.abort(), [])

  const select = useCallback((point: Coordinate) => {
    if (!ready || !dataset) return
    request.current?.abort(); setRoute(null); setRouteError(''); setRouting(false)
    const [w, s, e, n] = dataset.region.routing_bbox
    if (point[0] < w || point[0] > e || point[1] < s || point[1] > n) { setStart(null); setEnd(null); setRouteError('Chọn điểm trong vùng routing đã cấu hình.'); return }
    if (!start || end) { setStart(point); setEnd(null) } else { setEnd(point) }
  }, [ready, dataset, start, end])

  useEffect(() => {
    if (!start || !end || !ready) return
    const controller = new AbortController(); request.current = controller; setRouting(true)
    api<Route>('/api/route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ start, end }), signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setRoute(data) })
      .catch(error => { if (!controller.signal.aborted) setRouteError(error.message) })
      .finally(() => { if (!controller.signal.aborted) setRouting(false) })
    return () => controller.abort()
  }, [start, end, ready])

  const refresh = () => { setMapError(''); setRefreshKey(value => value + 1) }
  const waitTitle = connectionError ? 'Kết nối backend để bắt đầu' : !dataset ? 'Đang kiểm tra dữ liệu local' : !pbfPresent ? 'Thêm dữ liệu để mở bản đồ' : 'PBF đã có. Chờ chuẩn bị bản đồ.'
  const waitDescription = connectionError || (!dataset ? 'Đang đọc cấu hình và tình trạng artifact.' : !pbfPresent ? 'Sao chép file Geofabrik đã tải vào đường dẫn bên dưới. Ứng dụng sẽ tự kiểm tra lại.' : 'Chưa có artifact GeoJSON hợp lệ. Chạy pipeline local theo README rồi kiểm tra lại.')

  return <div className={`app-shell nav-${navigationSize} ${inspectorOpen ? "inspector-open" : "inspector-closed"} mode-${mode} view-${mobileView}`}>
    {import.meta.env.DEV && <RuntimeAudit />}
    <header className="app-header">
      <Button variant="outline" aria-label="Open main menu" onClick={() => { if (window.matchMedia('(max-width: 900px)').matches) setMobileMenu(true); else setNavigationSize(navigationSize === 'hidden' ? 'expanded' : 'hidden') }}><Navigation size={18}/></Button>
      <div className="brand"><span className="brand-icon"><Navigation size={24} /></span><div><h1>GSM Map Sandbox</h1><span className="brand-subtitle">{mode === 'voucher' ? 'Voucher Experiment Studio' : mode === 'booking' ? 'Booking & Dispatch' : mode === 'fleet' ? 'Fleet Simulation' : 'Single Trip'}</span></div></div>
      <Button variant="outline" aria-label="Toggle inspector" aria-expanded={inspectorOpen} onClick={() => setInspectorOpen(!inspectorOpen)}>Inspector</Button>
      {mode === 'voucher' && <div className="workspace-view" role="group" aria-label="Workspace view"><Button size="sm" variant={mobileView === 'map' ? 'secondary' : 'outline'} onClick={() => setMobileView('map')}>Map</Button><Button size="sm" variant={mobileView === 'analytics' ? 'secondary' : 'outline'} onClick={() => setMobileView('analytics')}>Analytics</Button></div>}
      <Badge variant="outline" className="local-badge"><span className="status-dot green" />Local Simulation</Badge>
      <div className="header-status"><span><span className={mapReady && !connectionError ? 'status-dot green' : 'status-dot amber'} />{mapReady ? 'Bản đồ local' : 'Chờ dữ liệu bản đồ'}</span><span><span className={dataset?.osrm.state === 'connected' && !connectionError ? 'status-dot green' : 'status-dot'} />OSRM {dataset?.osrm.state === 'connected' && !connectionError ? 'kết nối' : 'chưa kết nối'}</span></div>
    </header>
    <main className="workspace">
      <PrimaryNavigation mode={mode} size={navigationSize} onMode={changeMode} onSize={setNavigationSize} mobileOpen={mobileMenu} onMobileOpen={setMobileMenu}/>
      <aside className="sidebar inspector" hidden={!inspectorOpen} aria-label="Cấu hình mô phỏng"><div className="inspector-toolbar"><strong>Contextual Inspector</strong><Button variant="ghost" size="sm" aria-label="Close inspector" onClick={() => setInspectorOpen(false)}>×</Button></div>
        <InspectorSection title="Map Data"><div className="section-heading"><Database size={17} /><h2>Dữ liệu bản đồ</h2></div>
          <div className="source-card"><div className="source-icon"><FileBox size={22} /></div><div><strong>Geofabrik Vietnam</strong><p>OpenStreetMap · nguồn PBF local</p></div><a href="https://download.geofabrik.de/asia/vietnam.html" target="_blank" rel="noreferrer" aria-label="Thông tin nguồn Geofabrik"><ArrowUpRight size={17} /></a></div>
          <div className="data-state"><span className={pbfPresent ? 'status-dot green' : 'status-dot amber'} /><span>{dataset?.pbf.format_verified ? 'PBF đã xác minh bằng Osmium' : dataset ? pbfLabels[dataset.pbf.state] ?? dataset.pbf.state : 'Đang kiểm tra file PBF…'}</span></div>
          <div className="data-detail">{dataset?.pbf.size_bytes ? (dataset.pbf.size_bytes / 1024 / 1024).toFixed(1) + (dataset.pbf.format_verified ? ' MiB · nguồn Geofabrik local đã kiểm tra' : ' MiB · định dạng chưa xác minh bằng Osmium') : 'Đọc từ ổ đĩa · không upload qua trình duyệt'}</div>
          <div className="region-row"><MapPin size={17} /><div><strong>{dataset?.region.name ?? 'Trung tâm TP.HCM · Quận 1 cũ'}</strong><p>Bến Thành · Bưu điện Trung tâm và lân cận</p></div></div>
          <div className="bbox-row">{(dataset?.region.display_bbox ?? [106.675, 10.750, 106.725, 10.795]).map(v => v.toFixed(3)).join(' / ')}</div>
          <p className="small-note">Vùng kỹ thuật thử nghiệm, không phải ranh giới hành chính.</p>
        </InspectorSection>
        {mode === 'voucher' ? <VoucherPanel docked session={voucher} ready={ready} onFocus={setBookingFocus} /> : mode === 'booking' ? <BookingPanel docked session={booking} ready={ready} onFocus={setBookingFocus} /> : mode === 'fleet' ? <FleetPanel docked fleet={fleet} ready={ready} onFocus={focusVehicle} /> : <><InspectorSection title="Trip Configuration" defaultOpen><div className="section-heading"><RouteIcon size={17} /><h2>Thiết lập hành trình</h2><span className="section-number">01</span></div>
          <p className="section-description">Nhấp trên bản đồ để chọn A, sau đó chọn B.</p>
          <div className="endpoint"><span className="endpoint-label">A</span><div><label>Điểm xuất phát</label><p>{coordinateText(start)}</p></div></div>
          <div className="endpoint"><span className="endpoint-label end">B</span><div><label>Điểm đến</label><p>{coordinateText(end)}</p></div></div>
          <div className="route-metrics"><div><label>Khoảng cách</label><strong>{route ? (route.distance / 1000).toFixed(2) + ' km' : '—'}</strong></div><div><label>Thời gian OSRM</label><strong>{route ? (route.duration / 60).toFixed(1) + ' phút' : '—'}</strong></div></div>
          <p className="small-note">Ước tính từ profile ô tô, không phải giao thông thời gian thực.</p>
          {routing && <p role="status" className="small-note">Đang yêu cầu tuyến từ OSRM local…</p>}
          {routeError && <p role="alert" className="error-text">{routeError}</p>}
          {route && <p className="small-note">Snap A/B: {route.snap_points.map(point => point.distance.toFixed(1) + ' m').join(' / ')}</p>}
          {route && <details className="snap-details"><summary>Điểm trên đường đã snap</summary>{route.snap_points.map((point, i) => <p key={i}>{i ? 'B' : 'A'} · {point.name || 'Đường không tên'}<br />{coordinateText(point.location ?? null)}</p>)}</details>}
          <Button variant="outline" className="clear-button" disabled={!start && !end} onClick={clear}><Trash2 />Xóa điểm A/B và chọn lại</Button>
        </InspectorSection>
        </>}
        <div className="sidebar-footer"><Server size={14} />Local only<span>WGS84 · [lon, lat]</span></div>
      </aside>
      <div className="workspace-content">
      <section className="map-workspace" aria-label="Bản đồ TP.HCM">
        <div className="map-topbar"><div><span className="eyebrow">KHU VỰC NGHIÊN CỨU</span><h2>Trung tâm TP. Hồ Chí Minh</h2></div><Button variant="outline" onClick={refresh}><RefreshCw size={15} />Kiểm tra lại</Button></div>
        <div className="map-canvas">
          <SandboxMap dataset={dataset} start={mode === 'single' ? start : null} end={mode === 'single' ? end : null} route={mode === 'single' ? route : null} progress={playback.progress} enabled={ready && mode === 'single'} onSelect={select} onError={setMapError} fleet={mode === 'fleet' ? fleet : undefined} fleetFocus={fleetFocus} booking={mode === 'voucher' ? voucher.mapSession : mode === 'booking' ? booking : undefined} bookingFocus={bookingFocus} />
          <div className="map-chip"><Layers size={15} />{mapReady ? 'GeoJSON local · OSM' : 'Local empty style'}<span className="chip-divider" />{mapReady ? 'Dữ liệu đường phố' : 'Chưa có lớp đường phố'}</div>
          {(!mapReady || mapError || connectionError) && <div className="waiting-overlay"><div className="waiting-card"><div className="waiting-icon"><FolderOpen size={32} /><span>{pbfPresent ? <Check size={13} /> : <Database size={13} />}</span></div><Badge variant="outline">{pbfPresent ? 'CHỜ ARTIFACT A1' : 'CHỜ DỮ LIỆU LOCAL'}</Badge><h2>{waitTitle}</h2><p>{mapError || waitDescription}</p><div className="file-path"><FolderOpen size={16} /><code>{dataset?.pbf.path ?? 'data/raw/vietnam-latest.osm.pbf'}</code></div><div className="readiness-list"><div className={pbfPresent ? 'done' : ''}><span>{pbfPresent ? <Check size={12} /> : '1'}</span>File PBF local</div><ChevronRight size={13} /><div><span>2</span>GeoJSON bản đồ</div><ChevronRight size={13} /><div><span>3</span>OSRM MLD</div></div><Button variant="outline" onClick={refresh}><RefreshCw size={15} />Kiểm tra dữ liệu</Button><p className="waiting-footnote">Chỉ hiển thị đường phố sau khi xử lý dữ liệu OSM thật.</p></div></div>}
          <div className="map-bottom-note"><span className={ready ? 'status-dot green' : 'status-dot amber'} />{mode === 'voucher' ? `Voucher experiment · ${voucher.arm} · giả định PoC` : mode === 'booking' ? 'Booking mô phỏng · màu vàng: đến đón · xanh: chở khách · xám: rảnh' : mode === 'fleet' ? 'Simulated fleet — not live GPS · chọn marker để quan sát' : ready ? start ? end ? 'Nhấp để bắt đầu hành trình mới' : 'Chọn điểm B trên bản đồ' : 'Chọn điểm A trên bản đồ' : 'Chọn A/B đang khóa · dữ liệu hoặc router chưa sẵn sàng'}</div>
        </div>
        <footer className="map-footer"><span>© OpenStreetMap contributors · Geofabrik</span><span>Sandbox nghiên cứu · {mode === 'single' ? 'một xe mô phỏng' : 'đội xe mô phỏng'}</span></footer>
      </section>
      {mode === 'voucher' && <aside className="analytics-panel" aria-label="Business Analytics"><Suspense fallback={<p>Đang tải Studio local…</p>}><VoucherDashboard session={voucher}/></Suspense></aside>}
      </div>
    </main>
    {mode === 'single' ? <PlaybackDock label="Single Trip" enabled={!!route && ready} time={playback.progress * (route?.duration ?? 0)} duration={route?.duration ?? 0} status={playback.progress >= 1 ? 'completed' : playback.playing ? 'playing' : 'paused'} speed={playback.speed} play={playback.play} pause={playback.pause} reset={playback.reset} seek={time => playback.seek(route ? time/route.duration : 0)} setSpeed={playback.setSpeed}/> : <ClockDock key={mode} label={mode === 'fleet' ? 'Fleet Simulation' : mode === 'booking' ? 'Booking & Dispatch' : 'Voucher Experiment'} clock={mode === 'fleet' ? fleet.clock : mode === 'booking' ? booking.clock : voucher.clock} duration={mode === 'fleet' ? fleet.scenario?.simulationDurationSeconds ?? 0 : mode === 'booking' ? booking.plan?.simulationDurationSeconds ?? 0 : voucher.experiment?.simulationDurationSeconds ?? 0} enabled={ready && (mode === 'fleet' ? !!fleet.scenario && !fleet.loading : mode === 'booking' ? !!booking.plan && !booking.loading : !!voucher.experiment && !voucher.loading)}/>}
  </div>
}

