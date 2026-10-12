import { useEffect } from 'react'
import { Car } from 'lucide-react'
import { Map, MapControls, MapMarker, MarkerContent, MapRoute, RouteProgress, RouteMarker, useMap } from '@/components/ui/map'
import { emptyStyle, localStyle } from '@/lib/map-style'
import type { StyleSpecification } from 'maplibre-gl'
import { positionAt } from '@/lib/playback'
import type { Coordinate, DatasetStatus, Route } from '@/lib/api'
import type { FleetSession } from '@/lib/use-fleet'
import type { FleetFocus } from './fleet-panel'
import { FleetMap } from './fleet-map'
import { BookingMap, type BookingMapSession } from './booking-map'
import type { BookingFocus } from './booking-panel'

const blankStyles = { light: emptyStyle, dark: emptyStyle }
const readyStyles = { light: localStyle, dark: localStyle }
function ResizeMap() {
  const { map } = useMap()
  useEffect(() => {
    if (!map) return
    const container = map.getContainer()
    // Lifetime token allows DOM-only QA to detect a recreated map or canvas.
    if (!map.getCanvas().dataset.mapLifetime) map.getCanvas().dataset.mapLifetime = crypto.randomUUID()
    const observer = new ResizeObserver(() => { if (container.clientWidth && container.clientHeight) map.resize() })
    observer.observe(container)
    return () => observer.disconnect()
  }, [map])
  return null
}
function FitRoute({ route }: { route: Route | null }) {
  const { map, isLoaded } = useMap()
  useEffect(() => {
    if (!map || !isLoaded || !route) return
    const lons = route.coordinates.map(p => p[0]), lats = route.coordinates.map(p => p[1])
    map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 85, maxZoom: 16, duration: 500 })
  }, [map, isLoaded, route])
  return null
}
function MapEvents({ enabled, onSelect, onError }: { enabled: boolean; onSelect: (point: Coordinate) => void; onError: (message: string) => void }) {
  const { map, isLoaded } = useMap()
  useEffect(() => {
    if (!map || !isLoaded) return
    const click = (event: { lngLat: { lng: number; lat: number } }) => { if (enabled) onSelect([event.lngLat.lng, event.lngLat.lat]) }
    const error = () => onError('Không tải được lớp bản đồ local. Kiểm tra artifact và backend.')
    map.on('click', click); map.on('error', error)
    return () => { map.off('click', click); map.off('error', error) }
  }, [map, isLoaded, enabled, onSelect, onError])
  return null
}
export function SandboxMap({ dataset, start, end, route, progress, enabled, onSelect, onError, fleet, fleetFocus, booking, bookingFocus, replayStyle }: {
  dataset: DatasetStatus | null; start: Coordinate | null; end: Coordinate | null; route: Route | null;
  progress: number; enabled: boolean; onSelect: (point: Coordinate) => void; onError: (message: string) => void
  fleet?: FleetSession; fleetFocus?: FleetFocus | null
  booking?: BookingMapSession; bookingFocus?: BookingFocus | null
  replayStyle?: { light: StyleSpecification; dark: StyleSpecification }
}) {
  const box = dataset?.region.display_bbox ?? [106.675, 10.750, 106.725, 10.795]
  return <Map theme="light" styles={replayStyle ?? (dataset?.artifacts.map_ready ? readyStyles : blankStyles)} center={[(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]} zoom={14.2} attributionControl={{ customAttribution: '© OpenStreetMap contributors', compact: false }}>
    <MapControls position="top-right" showCompass />
    <ResizeMap />
    <MapEvents enabled={enabled} onSelect={onSelect} onError={onError} />
    {fleet && <FleetMap fleet={fleet} focus={fleetFocus ?? null} />}
    {booking && <BookingMap session={booking} focus={bookingFocus ?? null} />}
    <FitRoute route={route} />
    {[start, end].map((point, i) => point && <MapMarker key={i} longitude={point[0]} latitude={point[1]}><MarkerContent><div className={`point-marker ${i ? 'destination' : ''}`}>{i ? 'B' : 'A'}</div></MarkerContent></MapMarker>)}
    {route && <MapRoute coordinates={route.coordinates} progress={progress} color="#397f9b" width={6} opacity={1}>
      <RouteProgress color="#078057" width={6} opacity={1} />
      <RouteMarker at="progress"><MarkerContent><div className="vehicle-marker" data-progress={progress} data-coordinate={JSON.stringify(positionAt(route.coordinates, progress))} title="Một xe GSM mô phỏng trên tuyến OSRM"><Car size={21} /></div></MarkerContent></RouteMarker>
    </MapRoute>}
  </Map>
}
