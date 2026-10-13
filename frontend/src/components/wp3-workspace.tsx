import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Download, FlaskConical, MapPin, Pause, Play, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { api, type DatasetStatus } from '@/lib/api'
import { FleetClock } from '@/lib/fleet-clock'
import { useFleetClock } from '@/lib/use-fleet'
import { bookingStatus, ledgerAt, money, policyLabels, timeText, vehicleState, type Wp3Config, type Wp3Result } from '@/lib/wp3'
import { SandboxMap } from './sandbox-map'
import { Wp3Map } from './wp3-map'
import './wp3-workspace.css'

const publicReplay = import.meta.env.VITE_PUBLIC_REPLAY === '1'
const defaults: Wp3Config = { seed: 'hcm-demo-20261013', fleet: 3, quotes: 18, minutes: 8, budget_vnd: 50000, patience_seconds: 300, traffic_factor: 1, voucher_effect: .25, response_scale: 1 }
const emptySelect = () => {}
const labels: Record<string, string> = { pending: 'Chờ khách đặt', offered: 'Phát báo giá / voucher', queued: 'Chờ xe', pickup: 'Đang đến đón', onboard: 'Đang chở khách', completed: 'Hoàn tất', expired: 'Hết hạn', rejected: 'Khách không đặt', accepted: 'Khách đặt xe', assigned: 'Xe nhận chuyến' }
const vehicleLabels = { idle: 'Xe rảnh', pickup: 'Đến đón', trip: 'Chở khách' }

export function Wp3Workspace({ onHome, dataset, ready, onExplore, onMapError, onRefresh, mapRevision = 0, readinessError = '' }: { onHome?: () => void; dataset: DatasetStatus | null; ready: boolean; onExplore: () => void; onMapError: (message: string) => void; onRefresh?: () => void; mapRevision?: number; readinessError?: string }) {
  const [config, setConfig] = useState(defaults)
  const [mode, setMode] = useState<'integrated' | 'legacy'>('integrated')
  const activeLabels = mode === 'integrated' ? { no_offer: policyLabels.no_offer, response: 'Chỉ xét khách', state_aware: 'Xét khả năng đội xe' } : policyLabels
  const [result, setResult] = useState<Wp3Result | null>(null)
  const [policy, setPolicy] = useState('state_aware')
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [clock] = useState(() => new FleetClock())
  const snapshot = useFleetClock(clock)
  const controller = useRef<AbortController | null>(null)
  const configForm = useRef<HTMLFormElement | null>(null)
  useEffect(() => () => { controller.current?.abort(); clock.dispose() }, [clock])
  useEffect(() => { if (!ready) { controller.current?.abort(); clock.configure(0); setResult(null); setLoading(false) } }, [ready, clock])
  const run = result?.runs.find(r => r.policy === policy)
  const time = snapshot.simulationTimeSeconds
  const ledger = run ? ledgerAt(run, time) : { spent: 0, reserved: 0 }
  const observed = run?.quotes.filter(q => q.arrival <= time) ?? []
  const completed = observed.filter(q => bookingStatus(q, time) === 'completed').length
  const queued = observed.filter(q => bookingStatus(q, time) === 'queued').length
  const idle = result && run ? run.vehicles.filter(v => vehicleState(v, run, result, time).status === 'idle').length : config.fleet
  const duration = result ? Math.max(...result.runs.map(r => r.duration)) : config.minutes * 60
  const update = (key: keyof Wp3Config, value: string) => setConfig(c => ({ ...c, [key]: key === 'seed' ? value : Number(value) }))
  async function generate() {
    controller.current?.abort(); clock.configure(0); setResult(null); setError(''); setSelected(null)
    const next = new AbortController(); controller.current = next; setLoading(true)
    try {
      const { voucher_effect, response_scale, ...common } = config
      const payload = mode === 'integrated' ? { ...common, response_scale: response_scale ?? 1 } : { ...common, voucher_effect }
      const data = await api<Wp3Result>(mode === 'integrated' ? '/api/wp3/campaign' : '/api/wp3/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: next.signal })
      if (next.signal.aborted) return
      setResult(data); clock.configure(Math.max(...data.runs.map(r => r.duration))); clock.setSpeed(20); clock.play()
    } catch (e) { if (!next.signal.aborted) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (!next.signal.aborted) setLoading(false) }
  }
  function exportResult() {
    if (!result) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = `wp3-${result.config.seed.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`; link.click(); URL.revokeObjectURL(url)
  }
  return <div className="wp3-shell">
    <header className="wp3-header"><div className="wp3-brand"><span><FlaskConical size={23} /></span><div><strong>Voucher & đội xe</strong><small>WP3 · MÔ PHỎNG QUẬN 1</small></div></div><div className="wp3-location"><MapPin size={15} /> TP. Hồ Chí Minh <span>/</span> Quận 1 cũ</div>{onHome && <button className="wp3-explore" onClick={onHome}>← Luồng demo</button>}<button className="wp3-explore" onClick={onExplore}>Khám phá tuyến <ArrowRight size={15} /></button></header>
    <div className="wp3-layout">
      <main className="wp3-main">
        <div className="wp3-main-heading"><div><span className="wp3-kicker">ĐƯỜNG OSM · CHUYỂN ĐỘNG THEO OSRM</span><h2>Từ đặt xe đến hoàn tất</h2></div><span className={`wp3-ready ${ready ? 'ready' : ''}`}><i />{ready ? 'Bản đồ sẵn sàng' : 'Đang chuẩn bị bản đồ'}</span><div className="wp3-mobile-actions"><button disabled={!ready || loading} onClick={() => void generate()}>{loading ? 'Đang tính tuyến…' : result ? 'Chạy lại' : publicReplay ? 'Phát kịch bản đã kiểm' : 'Chạy mô phỏng'}<Play size={14} /></button><button onClick={() => configForm.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Kịch bản<SlidersHorizontal size={14} /></button></div></div>
        <div className="wp3-mobile-feedback">{error ? <p role="alert">{error}</p> : loading ? <p role="status">Đang chuẩn bị tuyến OSM và đội xe.</p> : !ready ? <p role="status">{readinessError || 'Đang chờ OSM và OSRM local.'}</p> : null}</div>
        {publicReplay && <p className="wp3-flow-note"><strong>Bản phát lại đã kiểm:</strong> 3 xe · 18 báo giá · seed hcm-demo-20261013. Tuyến OSRM và kết quả đã lưu; không tính kịch bản mới trên Vercel. Play, seek, đổi policy và xuất JSON vẫn hoạt động.</p>}<p className="wp3-flow-note"><strong>Quy tắc:</strong> xe rảnh phù hợp có thời gian đến đón ngắn nhất luôn nhận; khách có thể không đặt. Số bên dưới tính đến thời điểm đang phát.</p>
        <div className="wp3-live-stats"><div><span>Báo giá đã xuất hiện</span><strong>{observed.length}<small> / {result?.config.quotes ?? config.quotes} báo giá</small></strong></div><div><span>Xe đang rảnh</span><strong>{idle}<small> / {result?.config.fleet ?? config.fleet} xe</small></strong></div><div><span>Đang chờ xe</span><strong>{queued}</strong></div><div><span>Hoàn tất</span><strong>{completed}<small> chuyến</small></strong></div></div>
        <div className="wp3-map-canvas">
          <SandboxMap key={mapRevision} dataset={dataset} studyBounds={dataset?.region.simulation_bbox} start={null} end={null} route={null} progress={0} enabled={false} onSelect={emptySelect} onError={onMapError}>{result && run && <Wp3Map result={result} run={run} time={time} selected={selected} onSelect={id => setSelected(id || null)} />}</SandboxMap>
          <div className="wp3-map-title"><MapPin size={17} /><div><strong>Quận 1, TP.HCM</strong><span>MẠNG ĐƯỜNG OPENSTREETMAP</span></div></div>
          {!result && <div className="wp3-map-intro"><span>KỊCH BẢN TRÌNH DIỄN</span><h3>Đường phố thật.<br />Kịch bản có thể phát lại.</h3><p>Bấm Chạy mô phỏng. Xe đến đón, chở khách và giải phóng khi hoàn tất.</p></div>}
          <div className="wp3-legend"><span><i className="idle" />Xe rảnh</span><span><i className="pickup" />Đến đón</span><span><i className="trip" />Chở khách</span><span><i className="request" />Booking</span></div>
        </div>
        <div className="wp3-reality"><strong>Đường OSM thật</strong><span>Tốc độ từng đoạn OSRM · hệ số {result?.config.traffic_factor ?? config.traffic_factor}</span><span>Khách và báo giá mô phỏng · chưa có giao thông thực đo</span></div>
        <section className="wp3-timeline" aria-label="Phát lại mô phỏng"><button aria-label={snapshot.playbackStatus === 'playing' ? 'Tạm dừng mô phỏng' : 'Phát mô phỏng'} disabled={!result} onClick={() => snapshot.playbackStatus === 'playing' ? clock.pause() : clock.play()}>{snapshot.playbackStatus === 'playing' ? <Pause size={18} /> : <Play size={18} />}</button><button aria-label="Về đầu mô phỏng" disabled={!result} onClick={clock.reset}><RotateCcw size={16} /></button><strong>{timeText(time)}</strong><input aria-label="Thời điểm mô phỏng" type="range" min="0" max={duration} step=".1" value={time} disabled={!result} onChange={e => clock.seek(Number(e.target.value))} /><small>{timeText(duration)}</small><select aria-label="Tốc độ WP3" value={snapshot.speedMultiplier} onChange={e => clock.setSpeed(Number(e.target.value))}>{[1, 4, 20, 60].map(v => <option key={v} value={v}>{v}×</option>)}</select></section>
        {result && run && <div className="wp3-fleet-strip" aria-label="Danh sách xe">{run.vehicles.map(v => { const state = vehicleState(v, run, result, time); return <button key={v.id} className={state.status} aria-label={`Chọn xe ${v.id}`} aria-pressed={selected === v.id} onClick={() => setSelected(v.id === selected ? null : v.id)}><strong>{v.id}</strong><span>{vehicleLabels[state.status]}</span></button> })}</div>}
        {result && run && <div className="wp3-results"><section><div className="wp3-results-heading"><h3>Tổng cuối toàn bộ lượt chạy</h3><button onClick={exportResult}><Download size={14} /> JSON</button></div><div className="wp3-comparison-scroll" tabIndex={0} role="region" aria-label="So sánh cuối lượt chạy, có thể cuộn ngang"><table><thead><tr><th>Cách chọn ưu đãi</th><th>Hoàn tất</th><th>Hết hạn</th><th>Chi thực tế</th></tr></thead><tbody>{result.runs.map(r => <tr key={r.policy} className={r.policy === policy ? 'selected' : ''}><td>{activeLabels[r.policy]}</td><td>{r.summary.completed}</td><td>{r.summary.expired}</td><td>{money(r.summary.actual_spend_vnd)}</td></tr>)}</tbody></table></div><p>Cùng báo giá, cùng kịch bản ngẫu nhiên và trần ngân sách. Tổng cuối lượt chạy, không phải số tại thời điểm trên map. Lượt demo này không thay bộ kiểm 36 kịch bản.</p></section><section><h3>Nhật ký tại {timeText(time)}</h3><div className="wp3-event-list">{run.events.filter(e => e.time <= time).slice(-5).reverse().map((e, i) => <div key={`${e.time}-${e.kind}-${i}`}><time>{timeText(e.time)}</time><b>{e.request_id}</b><span>{labels[e.kind] ?? e.kind}</span></div>)}{time === 0 && <p>Bấm Phát hoặc kéo thanh thời gian để quan sát.</p>}</div><p>Kịch bản đã chạy: {result.config.seed} · {result.config.minutes} phút nhận báo giá, sau đó xử lý hết chuyến/hết hạn. Đi rỗng {run.summary.deadhead_km.toFixed(1)} km.</p></section></div>}
        {result && <details className="wp3-provenance"><summary>Nguồn dữ liệu & giới hạn mô hình · {result.datasetFingerprint.slice(0, 12)}</summary>{Object.entries(result.provenance).map(([key, value]) => <p key={key}><b>{key}:</b> {typeof value === 'string' ? value : JSON.stringify(value)}</p>)}{Object.entries(result.assumptions).map(([key, value]) => <p key={key}><b>{key}:</b> {value}</p>)}</details>}
        <footer className="wp3-footer"><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors · ODbL</a><span>Geofabrik{result?.provenance.source_timestamp ? ` · ${String(result.provenance.source_timestamp).slice(0, 10)}` : ''} · WP3 pilot</span></footer>
      </main>
      <aside className="wp3-sidebar">
        <div className="wp3-intro"><span className="wp3-kicker">MAP NHỎ · ĐƯỜNG THẬT</span><h1>Quận 1.<br />{' '}Quan sát đội xe.</h1><p>3 xe, 18 báo giá, ngân sách 50.000 ₫. Kịch bản nhỏ để giải thích luồng; có thể đổi cấu hình.</p></div>
        <form ref={configForm} className="wp3-config" onSubmit={e => { e.preventDefault(); void generate() }}>
          <div className="wp3-section-title"><SlidersHorizontal size={16} /><h2>Kịch bản thử nghiệm</h2><span>01</span></div>
          <div className="wp3-input-grid"><label>Số xe<input disabled={publicReplay} aria-label="Số xe WP3" type="number" min="1" max="20" required value={config.fleet} onChange={e => update('fleet', e.target.value)} /></label><label>Số báo giá<input disabled={publicReplay} type="number" min="1" max="200" required value={config.quotes} onChange={e => update('quotes', e.target.value)} /></label><label>Nhận báo giá (phút)<input disabled={publicReplay} type="number" min="5" max="60" required value={config.minutes} onChange={e => update('minutes', e.target.value)} /></label><label>Trần ngân sách (₫)<input disabled={publicReplay} type="number" min="0" max="10000000" step="5000" required value={config.budget_vnd} onChange={e => update('budget_vnd', e.target.value)} /></label></div>
          <details className="wp3-assumptions"><summary>Thiết lập nâng cao và giả định</summary><label className="wp3-seed">Mô hình<select disabled={publicReplay} aria-label="Mô hình WP3" value={mode} onChange={e => { controller.current?.abort(); clock.configure(0); setResult(null); setLoading(false); setPolicy('state_aware'); setMode(e.target.value as 'integrated' | 'legacy') }}><option value="integrated">Mô hình WP1/WP2 đang dùng trên map</option><option value="legacy">Sandbox cũ · xác suất giả định riêng</option></select></label>
          <label className="wp3-seed">Mã kịch bản ngẫu nhiên<input disabled={publicReplay} required maxLength={80} value={config.seed} onChange={e => update('seed', e.target.value)} /></label>
          <div className="wp3-input-grid"><label>Hạn đón (giây)<input disabled={publicReplay} type="number" min="30" max="900" required value={config.patience_seconds} onChange={e => update('patience_seconds', e.target.value)} /></label><label>Hệ số thời gian<input disabled={publicReplay} type="number" min="1" max="3" step=".1" required value={config.traffic_factor} onChange={e => update('traffic_factor', e.target.value)} /></label><label>{mode === 'integrated' ? 'Hệ số phản ứng với voucher' : 'Hiệu ứng voucher'}<input disabled={publicReplay} type="number" min="0" max={mode === 'integrated' ? 1.5 : .5} step=".05" required value={mode === 'integrated' ? config.response_scale : config.voucher_effect} onChange={e => update(mode === 'integrated' ? 'response_scale' : 'voucher_effect', e.target.value)} /></label></div><p>{mode === 'integrated' ? 'WP2 fit trên cohort synthetic theo OSM Quận 1. Hệ số 1 giữ response đã fit; 0 bỏ hiệu ứng voucher. Planner luôn dùng model đã fit.' : `Quote tổng hợp; voucher 10k tăng tối đa ${Math.round(config.voucher_effect * 100)} điểm %.`} Thời gian OSRM × hệ số; chưa có traffic thực đo.</p></details>
          <button className="wp3-primary" type="submit" disabled={!ready || loading}>{loading ? 'Đang tạo tuyến và lượt chạy…' : result ? publicReplay ? 'Phát lại kịch bản' : 'Chạy lại kịch bản' : publicReplay ? 'Phát kịch bản đã kiểm' : 'Chạy mô phỏng'}<ArrowRight size={16} /></button>
          {!ready && <p role="status" className="wp3-hint">{readinessError || 'Đang chờ dữ liệu OSM và OSRM local sẵn sàng.'} {onRefresh && <button type="button" onClick={onRefresh}>Kiểm tra lại bản đồ</button>}</p>}
          {loading && <p role="status" className="wp3-hint">{mode === 'integrated' ? 'Đang so ba cách chọn ưu đãi và chuẩn bị tuyến. Có thể mất vài chục giây.' : 'Đang chuẩn bị tuyến và bốn cách chọn ưu đãi sandbox.'}</p>}
          {error && <p role="alert" className="wp3-error">{error}</p>}
        </form>
        {result?.model && <p className="wp3-hint">WP2 {result.model.selected_wp2} · H1 giảm log-loss {(100*result.model.wp1.history_contrast.relativeImprovement).toFixed(2)}% / mục tiêu 2%: {result.model.wp1.history_contrast.targetPassed ? 'đạt trên synthetic' : 'chưa đạt'}. Chưa nghiệm thu GMS.</p>}
        <section className="wp3-policy"><div className="wp3-section-title"><h2>Cách chọn ưu đãi đang xem</h2><span>02</span></div><div className="wp3-policy-list">{Object.entries(activeLabels).map(([key, label]) => <button key={key} aria-pressed={policy === key} onClick={() => { clock.pause(); setPolicy(key); setSelected(null) }}><span className={`wp3-radio ${policy === key ? 'active' : ''}`} /><span>{label}</span>{result && <small>{result.runs.find(r => r.policy === key)?.summary.completed} chuyến cuối lượt</small>}</button>)}</div><p className="wp3-hint">{mode === 'integrated' ? 'Xét đội xe: chọn ưu đãi theo số chuyến hoàn tất dự kiến. Chỉ xét khách: chọn theo tăng xác suất đặt. Cùng mô hình, phạm vi đã học, ngân sách và ngưỡng phục vụ.' : 'State-aware xét ETA, cam kết xe và hàng chờ trước khi ưu đãi.'} Đổi cách chọn giữ cùng thời điểm trên map.</p></section>
        <section className="wp3-budget"><div><span>Đã chi / đang giữ ngân sách</span><strong>{money(ledger.spent)} <small>/ {money(ledger.reserved)}</small></strong></div><div className="wp3-budget-bar"><i style={{ width: `${Math.min(100, 100 * ledger.spent / (result?.config.budget_vnd || 1))}%` }} /><i style={{ width: `${Math.min(100, 100 * ledger.reserved / (result?.config.budget_vnd || 1))}%` }} /></div><p>{mode === 'integrated' ? 'Giữ ngân sách khi phát ưu đãi; giải phóng nếu khách không đặt hoặc hết hạn. Ghi chi phí khi hoàn tất; hoàn tiền muộn có trong JSON.' : 'Giữ khi nhận booking · hoàn trả khi hết hạn · chi khi hoàn tất.'}</p></section>
        <div className="wp3-sidebar-note"><span className="status-dot green" /> Đường OSM · thời gian ô tô từ OSRM<p>Mô phỏng nghiên cứu với nhu cầu tổng hợp.<br />Vùng kỹ thuật, không phải ranh giới hành chính.</p></div>
      </aside>
    </div>
  </div>
}
