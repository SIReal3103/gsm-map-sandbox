import { memo, useEffect, useRef } from 'react'
import { Car } from 'lucide-react'
import { MapRoute, MapMarker, MarkerContent, RouteProgress, useMap } from './ui/map'
import { useFleetClock, type FleetSession } from '@/lib/use-fleet'
import { vehicleAt } from '@/lib/fleet'
import type { FleetFocus } from './fleet-panel'

export function FleetMap({ fleet, focus }: { fleet: FleetSession; focus: FleetFocus | null }) {
  const { map, isLoaded } = useMap()
  const handledFocus = useRef<FleetFocus | null>(null)
  const scenario = fleet.scenario
  useEffect(() => {
    if (!map || !isLoaded || !scenario?.vehicles.length) return
    const points = scenario.vehicles.flatMap(v => v.route.coordinates)
    const lon = points.map(p => p[0]), lat = points.map(p => p[1])
    map.fitBounds([[Math.min(...lon), Math.min(...lat)], [Math.max(...lon), Math.max(...lat)]], { padding: 70, maxZoom: 15.5, duration: 500 })
  }, [map, isLoaded, scenario])
  useEffect(() => {
    if (!map || !isLoaded || !focus || !scenario) return
    if (handledFocus.current === focus) return
    const vehicle = scenario.vehicles.find(v => v.id === focus.id)
    if (!vehicle) return
    handledFocus.current = focus
    if (focus.kind === 'vehicle') map.easeTo({ center: vehicleAt(vehicle, fleet.clock.getSnapshot().simulationTimeSeconds).currentPosition, zoom: Math.max(map.getZoom(), 16), duration: 400 })
    else {
      const lon = vehicle.route.coordinates.map(p => p[0]), lat = vehicle.route.coordinates.map(p => p[1])
      map.fitBounds([[Math.min(...lon), Math.min(...lat)], [Math.max(...lon), Math.max(...lat)]], { padding: 80, maxZoom: 16, duration: 400 })
    }
  }, [map, isLoaded, focus, scenario, fleet.clock])
  return <><BackgroundRoutes fleet={fleet} /><SelectedRoute fleet={fleet} /><FleetMarkers fleet={fleet} /></>
}
const BackgroundRoutes = memo(function BackgroundRoutes({ fleet }: { fleet: FleetSession }) {
  return <>{fleet.scenario?.vehicles.filter(v => v.id !== fleet.selectedVehicleId).map(v => <MapRoute key={v.id} coordinates={v.route.coordinates} color="#659881" width={2} opacity={.18} interactive={false} />)}</>
})
function SelectedRoute({ fleet }: { fleet: FleetSession }) {
  const clock = useFleetClock(fleet.clock), base = fleet.scenario?.vehicles.find(v => v.id === fleet.selectedVehicleId)
  if (!base) return null
  return <MapRoute coordinates={base.route.coordinates} progress={vehicleAt(base, clock.simulationTimeSeconds).progress} color="#659881" width={5} opacity={.75} interactive={false}><RouteProgress color="#078057" width={5} opacity={1} /></MapRoute>
}
function FleetMarkers({ fleet }: { fleet: FleetSession }) {
  const clock = useFleetClock(fleet.clock)
  return <>{fleet.scenario?.vehicles.map(base => {
    const v = vehicleAt(base, clock.simulationTimeSeconds), selected = v.id === fleet.selectedVehicleId
    return <MapMarker key={v.id} longitude={v.currentPosition[0]} latitude={v.currentPosition[1]}><MarkerContent><button aria-label={`Xe ${v.id}`} aria-pressed={selected} className={`fleet-marker ${selected ? 'selected' : ''} ${v.status}`} data-fleet-vehicle={v.id} data-progress={v.progress} data-status={v.status} data-coordinate={JSON.stringify(v.currentPosition)} onClick={event => { event.stopPropagation(); fleet.setSelectedVehicleId(v.id) }} title={`${v.id} · ${v.status} · ${Math.round(v.progress*100)}%`}><Car size={16} /><span>{v.id.slice(-2)}</span></button></MarkerContent></MapMarker>
  })}</>
}
