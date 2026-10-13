export type Coordinate = [number, number]
export interface DatasetStatus {
  state: string
  ready: boolean
  pbf: { state: string; path: string; size_bytes: number | null; format_verified: boolean; osmium_available: boolean }
  artifacts: { map_ready: boolean; graph_ready: boolean; extracted_ready: boolean }
  osrm: { state: string; url: string }
  region: { name: string; display_bbox: [number, number, number, number]; simulation_bbox?: [number, number, number, number] | null; routing_bbox: [number, number, number, number]; source: string; attribution: string; boundary_note: string }
}
export interface Route {
  coordinates: Coordinate[]
  distance: number
  duration: number
  snap_points: { location: Coordinate; distance: number; name: string }[]
  duration_source: string
  segment_durations?: number[] | null
  segment_distances?: number[] | null
  segment_time_source?: string
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const replay = import.meta.env.VITE_PUBLIC_REPLAY === '1'
  const savedPath = path === '/api/dataset/status' ? '/map-runtime/dataset.json' : path === '/api/wp3/campaign' ? '/map-runtime/campaign.json' : null
  if (replay && !savedPath) throw new Error('Bản public chỉ phát lại kịch bản đã kiểm. Chạy local để tạo kịch bản mới.')
  const response = await fetch(replay ? savedPath! : path, replay ? { signal: options.signal } : options)
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    throw new Error(data?.error ? `${data.error.code}: ${data.error.message}` : `API trả về HTTP ${response.status}`)
  }
  return response.json()
}
