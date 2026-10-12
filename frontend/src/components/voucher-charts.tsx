import { ChartViewport } from './chart-viewport'
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis, ReferenceLine } from 'recharts'
import { memo } from 'react'
import { ChartContainer, ChartTooltip, ChartTooltipContent, ChartLegend, ChartLegendContent } from './ui/chart'
import { experimentMetrics, type Experiment, type ArmMetrics } from '@/lib/voucher'

const config = { baseline: { label: 'Baseline', color: 'var(--chart-2)' }, treatment: { label: 'Treatment', color: 'var(--chart-1)' } }
const axis = { tickLine: false, axisLine: false, fontSize: 10 }
export function ComparisonBar({ title, data, format }: { title: string; data: { label: string; baseline: number | null; treatment: number | null }[]; format?: (n: number) => string }) {
  return <section className="experiment-chart" data-chart-kind={title}><h3>{title}</h3><ChartContainer config={config} className="h-[240px] w-full" style={{ height: 240, aspectRatio: 'auto' }}><BarChart layout="vertical" data={data} accessibilityLayer margin={{ left: 5, right: 18 }}>
    <CartesianGrid horizontal={false}/><XAxis type="number" {...axis} tickFormatter={format}/><YAxis type="category" dataKey="label" width={100} {...axis}/><ChartTooltip content={<ChartTooltipContent formatter={(value, name) => <span>{name === 'baseline' ? 'Baseline' : 'Treatment'}: {format ? format(Number(value)) : String(value)}</span>}/>}/><ChartLegend content={<ChartLegendContent/>}/><Bar dataKey="baseline" fill="var(--color-baseline)" radius={3} isAnimationActive={false}/><Bar dataKey="treatment" fill="var(--color-treatment)" radius={3} isAnimationActive={false}/>
  </BarChart></ChartContainer></section>
}
export function ComparisonLine({ title, data, time, format, proportion = false }: { title: string; data: { timeSeconds: number; baseline: number | null; treatment: number | null }[]; time: number; format?: (n: number) => string; proportion?: boolean }) {
  return <section className="experiment-chart" data-chart-kind={title}><h3>{title}</h3><ChartContainer config={config} className="h-[240px] w-full" style={{ height: 240, aspectRatio: 'auto' }}><LineChart data={data} accessibilityLayer margin={{ left: 3, right: 15 }}>
    <CartesianGrid vertical={false}/><XAxis dataKey="timeSeconds" type="number" domain={[0,'dataMax']} {...axis} tickFormatter={n => (+n/60).toFixed(0)+'m'}/><YAxis allowDecimals={proportion} domain={proportion ? [0,1] : [0,'auto']} ticks={proportion ? [0,.25,.5,.75,1] : undefined} {...axis} tickFormatter={format}/><ChartTooltip labelFormatter={v => Number(v).toFixed(1)+' s'} content={<ChartTooltipContent formatter={(value, name) => <span>{name === 'baseline' ? 'Baseline' : 'Treatment'}: {format ? format(Number(value)) : String(value)}</span>}/>}/><ChartLegend content={<ChartLegendContent/>}/><ReferenceLine x={time} stroke="#6c7972" strokeDasharray="4 4"/><Line type={proportion ? 'linear' : 'stepAfter'} dataKey="baseline" stroke="var(--color-baseline)" strokeWidth={2} dot={false} isAnimationActive={false}/><Line type={proportion ? 'linear' : 'stepAfter'} dataKey="treatment" stroke="var(--color-treatment)" strokeWidth={2} dot={false} isAnimationActive={false}/>
  </LineChart></ChartContainer></section>
}
export function historyRows(e: Experiment, time: number) {
  const rows = e.timeSeries.filter(r => r.timeSeconds <= time)
  if (!rows.length || rows.at(-1)!.timeSeconds !== time) rows.push({ timeSeconds: time, baseline: experimentMetrics(e,'baseline',time), treatment: experimentMetrics(e,'treatment',time) })
  return rows
}
export const DefaultCharts = memo(function DefaultCharts({ experiment, time, baseline, treatment }: { experiment: Experiment; time: number; baseline: ArmMetrics; treatment: ArmMetrics }) {
  const funnel = [['Valid potential','validPotential'],['Accepted','accepted'],['Assigned','assigned'],['Picked up','pickedUp'],['Completed','completed']] as const
  return <div className="experiment-chart-grid"><ChartViewport title="Booking Conversion Funnel"><ComparisonBar title="Booking Conversion Funnel" data={funnel.map(([label,key]) => ({ label, baseline: baseline[key], treatment: treatment[key] }))}/></ChartViewport><ChartViewport title="Cumulative Completed Trips"><ComparisonLine title="Cumulative Completed Trips" time={time} data={historyRows(experiment,time).map(r => ({ timeSeconds: r.timeSeconds, baseline: r.baseline.completed, treatment: r.treatment.completed }))}/></ChartViewport></div>
})
