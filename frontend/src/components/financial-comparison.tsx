import type { ArmMetrics } from '@/lib/voucher'
import { vnd } from '@/lib/voucher'

export function FinancialComparison({ baseline, treatment }: { baseline: ArmMetrics; treatment: ArmMetrics }) {
  const rows = [
    ['Gross Fare Value', baseline.grossFareVnd, treatment.grossFareVnd, true],
    ['Rider Payments', baseline.riderPaymentsVnd, treatment.riderPaymentsVnd, true],
    ['Voucher Spend', baseline.voucherSpendVnd, treatment.voucherSpendVnd, true],
    ['Completed Trips', baseline.completed, treatment.completed, false],
  ] as const
  return <details className="financial-comparison" open><summary>Financial &amp; Operational Comparison</summary><div className="comparison-scroll"><table><thead><tr>{['Simulated Metric','Baseline','Treatment','Difference'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{rows.map(([label,b,t,money]) => <tr key={label}><th scope="row">{label}</th><td>{money ? vnd(b) : b}</td><td>{money ? vnd(t) : t}</td><td>{t > b ? '+' : t < b ? '−' : ''}{money ? vnd(Math.abs(t-b)) : Math.abs(t-b)}</td></tr>)}</tbody></table></div><p className="small-note">Difference = Treatment − Baseline · GFV = rider payments + settled voucher · simulated metrics</p></details>
}
