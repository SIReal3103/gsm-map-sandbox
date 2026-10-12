import { FinancialComparison } from './financial-comparison'
import { lazy, Suspense, useMemo, useState } from 'react'
import { Button } from './ui/button'
import { DefaultCharts } from './voucher-charts'
import { useFleetClock } from '@/lib/use-fleet'
import { delta, download, experimentCsv, experimentMetrics, rateText, vnd } from '@/lib/voucher'
import type { VoucherSession } from '@/lib/use-voucher'
import { exportArtifact } from '@/lib/artifact'
import { loadReplayAssets } from '@/lib/replay-assets'
const Analytics = lazy(() => import('./voucher-analytics'))
const Batch = lazy(() => import('./batch-analysis'))
export default function VoucherDashboard({ session }: { session: VoucherSession }) {
  const [advanced, setAdvanced] = useState(false), [scope, setScope] = useState<'observed' | 'final'>('observed')
  const [exportError,setExportError]=useState(''), [exporting,setExporting]=useState(false)
  const [batchOpen,setBatchOpen]=useState(false)
  const clock = useFleetClock(session.clock), e = session.experiment
  const time = e ? scope === 'final' ? e.simulationDurationSeconds : clock.playbackStatus === 'playing' ? Math.floor(clock.simulationTimeSeconds) : clock.simulationTimeSeconds : 0
  const metrics = useMemo(() => e ? { baseline: experimentMetrics(e,'baseline',time), treatment: experimentMetrics(e,'treatment',time) } : null, [e,time])
  // At 64x a simulation second passes every 16ms. Keep heavy Recharts work
  // bounded per wall second while exact paused/final projections remain.
  const chartUpdatesPerSecond = advanced ? 1 : 4
  const chartStep = Math.max(1, clock.speedMultiplier / chartUpdatesPerSecond)
  const chartTime = clock.playbackStatus === 'playing' && scope === 'observed' ? Math.floor(time / chartStep) * chartStep : time
  const chartMetrics = useMemo(() => e ? { baseline: experimentMetrics(e,'baseline',chartTime), treatment: experimentMetrics(e,'treatment',chartTime) } : null, [e,chartTime])
  const exports = useMemo(() => e ? experimentCsv(e) : null, [e])
  if (!e || !metrics) return <section className="voucher-empty"><h2>Voucher Experiment Studio</h2><p>Chuẩn bị paired experiment để xem conversion, dispatch và budget. Mô hình sigmoid/giá là giả định nghiên cứu.</p></section>
  const change = delta(metrics.baseline,metrics.treatment)
  const portableExport=async()=>{setExporting(true);setExportError('');try{const assets=session.replayAssets??await loadReplayAssets(); if(assets.manifest.datasetFingerprint!==e.datasetFingerprint) throw new Error('REPLAY_ASSET_MISMATCH'); const artifact=await exportArtifact(e,assets.manifest.id); download(`gsm-experiment-v1-${e.id.slice(0,12)}.json`,JSON.stringify(artifact),'application/json')}catch(error){setExportError(error instanceof Error?error.message:String(error))}finally{setExporting(false)}}
  return <section className="voucher-dashboard" data-experiment-id={e.id} data-experiment-metrics={JSON.stringify(metrics)} data-experiment-delta={JSON.stringify(change)} data-kpi-time={time} data-kpi-scope={scope}>
    <div className="experiment-heading"><div><h2>Voucher Experiment Studio</h2><p>{scope === 'observed' ? `Observed tới ${time.toFixed(1)} s` : `Planned/final · common duration ${time.toFixed(1)} s`} · giả định PoC</p></div><div className="arm-switch"><Button size="sm" variant={scope === 'observed' ? 'secondary' : 'outline'} onClick={() => setScope('observed')}>Observed</Button><Button size="sm" variant={scope === 'final' ? 'secondary' : 'outline'} onClick={() => setScope('final')}>Planned / Final</Button></div></div>
    <div className="analytics-toolbar"><Button variant="outline" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>{advanced ? 'Đóng phân tích kinh doanh' : 'Phân tích kinh doanh nâng cao'}</Button></div>
    <div className="experiment-kpis">{(['baseline','treatment'] as const).map(arm => <article key={arm}><h3>{arm === 'baseline' ? 'Baseline' : 'Treatment'}</h3><strong>{metrics[arm].completed} completed / {metrics[arm].accepted} accepted</strong><p>Conversion {rateText(metrics[arm].conversionRate)} · completion {rateText(metrics[arm].completionRate)}<br/>GFV {vnd(metrics[arm].grossFareVnd)}<br/>Rider payments {vnd(metrics[arm].riderPaymentsVnd)}<br/>Settled voucher {vnd(metrics[arm].voucherSpendVnd)}</p></article>)}<article><h3>Treatment − Baseline</h3><strong>{change.bookingUplift >= 0 ? '+' : ''}{change.bookingUplift} accepted</strong><p>{change.incrementalCompleted >= 0 ? '+' : ''}{change.incrementalCompleted} completed<br/>Cost / incremental completed:<br/>{change.costPerIncrementalCompletionVnd === null ? 'N/A — không có số chuyến hoàn tất tăng thêm' : vnd(change.costPerIncrementalCompletionVnd)}</p></article></div>
    <FinancialComparison baseline={metrics.baseline} treatment={metrics.treatment}/>
    <p className="small-note">Conversion = accepted / valid potential; completion = completed / accepted. GFV = rider payments + settled voucher. Offered/reserved chưa phải spend. Các KPI hiện tại cập nhật mỗi giây; vị trí xe dùng clock chung.</p>
    {!advanced && <DefaultCharts experiment={e} time={chartTime} baseline={chartMetrics!.baseline} treatment={chartMetrics!.treatment}/>}
    {clock.playbackStatus === 'playing' && <p className="small-note">Biểu đồ tới {chartTime.toFixed(1)} s · tối đa {chartUpdatesPerSecond} lần cập nhật/giây khi tăng tốc. KPI và bảng theo thời điểm Observed ở trên.</p>}
    <div className="experiment-actions"><Button variant="outline" disabled={exporting} onClick={()=>void portableExport()}>Export Portable v1</Button><Button variant="outline" onClick={() => download(`voucher-${e.id.slice(0,12)}.json`,JSON.stringify(e,null,2),'application/json')}>Export JSON · full plan</Button>
      <details><summary>Export CSV · final / full history</summary>{Object.entries(exports!).map(([name,text]) => <Button key={name} variant="ghost" onClick={() => download(`voucher-${name}-${e.id.slice(0,12)}.csv`,text,'text/csv;charset=utf-8')}>CSV {name}</Button>)}</details></div>
    {advanced && <Suspense fallback={<p role="status">Đang tải analytics local…</p>}><Analytics experiment={e} time={chartTime} baseline={chartMetrics!.baseline} treatment={chartMetrics!.treatment}/></Suspense>}
    {advanced && <><Button variant="outline" aria-expanded={batchOpen} onClick={()=>setBatchOpen(!batchOpen)}>Batch Experiment Analysis</Button>{batchOpen&&<Suspense fallback={<p role="status">Đang tải batch analysis…</p>}><Batch key={e.id} experiment={e} live={session.runtime==='live'}/></Suspense>}</>}
    {exportError && <p role="alert">{exportError}</p>}
  </section>
}
