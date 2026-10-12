import { lazy, Suspense, useMemo, useState } from 'react'
import { Button } from './ui/button'
import { DefaultCharts } from './voucher-charts'
import { useFleetClock } from '@/lib/use-fleet'
import { delta, download, experimentCsv, experimentMetrics, rateText, vnd } from '@/lib/voucher'
import type { VoucherSession } from '@/lib/use-voucher'
const Analytics = lazy(() => import('./voucher-analytics'))
export default function VoucherDashboard({ session }: { session: VoucherSession }) {
  const [advanced, setAdvanced] = useState(false), [scope, setScope] = useState<'observed' | 'final'>('observed')
  const clock = useFleetClock(session.clock), e = session.experiment
  const time = e ? scope === 'final' ? e.simulationDurationSeconds : clock.playbackStatus === 'playing' ? Math.floor(clock.simulationTimeSeconds) : clock.simulationTimeSeconds : 0
  const metrics = useMemo(() => e ? { baseline: experimentMetrics(e,'baseline',time), treatment: experimentMetrics(e,'treatment',time) } : null, [e,time])
  const exports = useMemo(() => e ? experimentCsv(e) : null, [e])
  if (!e || !metrics) return <section className="voucher-empty"><h2>Voucher Experiment Studio</h2><p>Chuẩn bị paired experiment để xem conversion, dispatch và budget. Mô hình sigmoid/giá là giả định nghiên cứu.</p></section>
  const change = delta(metrics.baseline,metrics.treatment)
  return <section className="voucher-dashboard" data-experiment-metrics={JSON.stringify(metrics)} data-experiment-delta={JSON.stringify(change)} data-kpi-time={time} data-kpi-scope={scope}>
    <div className="experiment-heading"><div><h2>Voucher Experiment Studio</h2><p>{scope === 'observed' ? `Observed tới ${time.toFixed(1)} s` : `Planned/final · common duration ${time.toFixed(1)} s`} · giả định PoC</p></div><div className="arm-switch"><Button size="sm" variant={scope === 'observed' ? 'secondary' : 'outline'} onClick={() => setScope('observed')}>Observed</Button><Button size="sm" variant={scope === 'final' ? 'secondary' : 'outline'} onClick={() => setScope('final')}>Planned / Final</Button></div></div>
    <div className="experiment-kpis">{(['baseline','treatment'] as const).map(arm => <article key={arm}><h3>{arm === 'baseline' ? 'Baseline' : 'Treatment'}</h3><strong>{metrics[arm].completed} completed / {metrics[arm].accepted} accepted</strong><p>Conversion {rateText(metrics[arm].conversionRate)} · completion {rateText(metrics[arm].completionRate)}<br/>GFV {vnd(metrics[arm].grossFareVnd)}<br/>Rider payments {vnd(metrics[arm].riderPaymentsVnd)}<br/>Settled voucher {vnd(metrics[arm].voucherSpendVnd)}</p></article>)}<article><h3>Treatment − Baseline</h3><strong>{change.bookingUplift >= 0 ? '+' : ''}{change.bookingUplift} accepted</strong><p>{change.incrementalCompleted >= 0 ? '+' : ''}{change.incrementalCompleted} completed<br/>Cost / incremental completed:<br/>{change.costPerIncrementalCompletionVnd === null ? 'N/A — không có số chuyến hoàn tất tăng thêm' : vnd(change.costPerIncrementalCompletionVnd)}</p></article></div>
    <p className="small-note">Conversion = accepted / valid potential; completion = completed / accepted. GFV = rider payments + settled voucher. Offered/reserved chưa phải spend. Các KPI hiện tại cập nhật mỗi giây; vị trí xe dùng clock chung.</p>
    <DefaultCharts experiment={e} time={time} baseline={metrics.baseline} treatment={metrics.treatment}/>
    <div className="experiment-actions"><Button variant="outline" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>{advanced ? 'Đóng phân tích kinh doanh' : 'Phân tích kinh doanh nâng cao'}</Button><Button variant="outline" onClick={() => download(`voucher-${e.id.slice(0,12)}.json`,JSON.stringify(e,null,2),'application/json')}>Export JSON · full plan</Button>
      <details><summary>Export CSV · final / full history</summary>{Object.entries(exports!).map(([name,text]) => <Button key={name} variant="ghost" onClick={() => download(`voucher-${name}-${e.id.slice(0,12)}.csv`,text,'text/csv;charset=utf-8')}>CSV {name}</Button>)}</details></div>
    {advanced && <Suspense fallback={<p role="status">Đang tải analytics local…</p>}><Analytics experiment={e} time={time} baseline={metrics.baseline} treatment={metrics.treatment}/></Suspense>}
  </section>
}
