export type Coordinate = [number, number]
export interface DatasetStatus {
  state: string
  ready: boolean
  pbf: { state: string; path: string; size_bytes: number | null; format_verified: boolean; osmium_available: boolean }
  artifacts: { map_ready: boolean; graph_ready: boolean; extracted_ready: boolean }
  osrm: { state: string; url: string }
  region: { name: string; display_bbox: [number, number, number, number]; routing_bbox: [number, number, number, number]; source: string; attribution: string; boundary_note: string }
}
export interface Route {
  coordinates: Coordinate[]
  distance: number
  duration: number
  snap_points: { location: Coordinate; distance: number; name: string }[]
  duration_source: string
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, options)
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    throw new Error(data?.error ? `${data.error.code}: ${data.error.message}` : `API trả về HTTP ${response.status}`)
  }
  return response.json()
}
