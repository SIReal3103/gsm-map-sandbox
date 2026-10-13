export type DemoOffer = {
  id: string; kind: 'none' | 'fixed' | 'percent'; fixed_vnd: number; percent: number;
  cap_vnd: number; minimum_vnd: number; payable_vnd: number; discount_vnd: number;
  status: 'supported' | 'ineligible' | 'outside-support'; probability: number | null; delta: number | null
}
export type DemoExample = {
  id: string; label: string; origin: string; destination: string; distance_km: number;
  eta_minutes: number; factual_payable_vnd: number; history_quotes: number;
  history_requests: number; history_missing: boolean; context_probability: number;
  history_probability: number; offers: DemoOffer[]
}
export type DemoContent = {
  version: string; generated_at: string; model: { selected_wp2: string; sha256: string; examples_scope: string };
  examples: DemoExample[];
  wp1: { relative_improvement: number; target: number; passed: boolean; days: number };
  wp3: { response_completed: number; fleet_completed: number; relative_gain: number; target: number;
    worlds: number; oracle_ceiling: number; required_completed: number; ceiling_gain: number };
  later_studies: { id: string; name: string; relative_improvement: number; scope: string }[];
  truth: Record<string, string>; sources: Record<string, { name: string; sha256: string }>;
  artifacts: { report: string; guide: string; report_ready: boolean }
}

export async function loadDemoContent(signal: AbortSignal): Promise<DemoContent> {
  const response = await fetch('/demo/demo-content.json', { signal })
  if (!response.ok) throw new Error('Không tải được nội dung demo. Thử tải lại trang.')
  const data: DemoContent = await response.json()
  if (data.version !== 'p06-demo-content/v1' || !data.examples?.length || !data.wp1 || !data.wp3) {
    throw new Error('Nội dung demo sai phiên bản. Kiểm tra bản xuất dữ liệu trước khi trình bày.')
  }
  return data
}

export const percent = (value: number, digits = 1) => `${(100 * value).toLocaleString('vi-VN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`
export const dong = (value: number) => `${Math.round(value).toLocaleString('vi-VN')} ₫`
export const offerLabel = (offer: DemoOffer) => offer.kind === 'none' ? 'Không thêm ưu đãi' : offer.kind === 'fixed'
  ? `Giảm ${dong(offer.fixed_vnd)}` : `Giảm ${percent(offer.percent, 0)} · tối đa ${dong(offer.cap_vnd)}`
