import { useEffect, useMemo } from 'react'
import { Car, UserRound } from 'lucide-react'
import { MapMarker, MarkerContent, MapRoute, RouteProgress, useMap } from './ui/map'
import { useFleetClock } from '@/lib/use-fleet'
import { bookingProjection } from '@/lib/booking'
import type { BookingSession } from '@/lib/use-booking'
import type { BookingFocus } from './booking-panel'

export type BookingMapSession = Pick<BookingSession, 'clock' | 'plan' | 'selectedBookingId' | 'selectedVehicleId' | 'setSelectedBookingId' | 'setSelectedVehicleId'>
export function BookingMap({ session, focus }: { session: BookingMapSession; focus: BookingFocus | null }) {
  const { map, isLoaded } = useMap(), clock = useFleetClock(session.clock), plan = session.plan
  const view = useMemo(() => plan ? bookingProjection(plan, clock.simulationTimeSeconds) : null, [plan, clock.simulationTimeSeconds])
  const selectedBooking = view?.bookings.find(b => b.id === session.selectedBookingId)
  const selectedVehicle = view?.vehicles.find(v => v.id === session.selectedVehicleId)
  const assignment = selectedBooking ? selectedBooking.assignment : plan?.assignments.find(a => a.bookingId === selectedVehicle?.activeBookingId)
  const showActiveRoute = selectedVehicle && (!selectedBooking || selectedVehicle.activeBookingId === selectedBooking.id) ? selectedVehicle.activeRoute : null
  useEffect(() => {
    if (!map || !isLoaded || !plan || !focus) return
    const projection = bookingProjection(plan, session.clock.getSnapshot().simulationTimeSeconds)
    if (focus.kind === 'overview') {
      const [w, s, e, n] = plan.provenance.display_bbox as number[]
      map.fitBounds([[w, s], [e, n]], { padding: 50, duration: 400 })
    } else if (focus.kind === 'vehicle') {
      const v = projection.vehicles.find(v => v.id === focus.id)
      if (v) map.easeTo({ center: v.currentPosition, zoom: 16, duration: 400 })
    } else {
      const b = projection.bookings.find(b => b.id === focus.id)
      if (!b) return
      const points = b.assignment ? [...(b.assignment.pickupRoute?.coordinates ?? []), ...b.assignment.tripRoute.coordinates] : [b.pickup, b.dropoff]
      const lon = points.map(p => p[0]), lat = points.map(p => p[1])
      map.fitBounds([[Math.min(...lon), Math.min(...lat)], [Math.max(...lon), Math.max(...lat)]], { padding: 75, maxZoom: 16, duration: 400 })
    }
  }, [map, isLoaded, plan, focus, session.clock])
  if (!view) return null
  // At most 8 active pickup DOM markers + the selected one. No future demand on map.
  const active = view.bookings.filter(b => ['waiting', 'assigned'].includes(b.status)).slice(0, 8)
  if (selectedBooking && selectedBooking.status !== 'scheduled' && !active.some(b => b.id === selectedBooking.id)) active.push(selectedBooking)
  return <>
    {assignment?.pickupRoute && <MapRoute coordinates={assignment.pickupRoute.coordinates} color="#c08a32" width={4} opacity={.7} interactive={false} />}
    {assignment && <MapRoute coordinates={assignment.tripRoute.coordinates} color="#327da2" width={4} opacity={.65} interactive={false} />}
    {showActiveRoute && selectedVehicle && <MapRoute coordinates={showActiveRoute.coordinates} progress={selectedVehicle.progress} color="#548368" width={5} interactive={false}><RouteProgress color={selectedVehicle.status === 'on_trip' ? '#087d55' : '#c08a32'} width={5} /></MapRoute>}
    {view.vehicles.map(v => <MapMarker key={v.id} longitude={v.currentPosition[0]} latitude={v.currentPosition[1]}><MarkerContent><button aria-label={`Xe dispatch ${v.id}`} className={`fleet-marker dispatch-marker ${v.status} ${session.selectedVehicleId === v.id ? 'selected' : ''}`} data-dispatch-vehicle={v.id} data-status={v.status} data-progress={v.progress} data-coordinate={JSON.stringify(v.currentPosition)} onClick={e => { e.stopPropagation(); session.setSelectedVehicleId(v.id); session.setSelectedBookingId(v.activeBookingId) }}><Car size={17} />{v.id.slice(-2)}</button></MarkerContent></MapMarker>)}
    {active.map(b => {
      const point = b.assignment?.tripRoute.coordinates[0] ?? b.pickup
      return <MapMarker key={b.id} longitude={point[0]} latitude={point[1]}><MarkerContent><button className={`booking-marker ${b.status}`} aria-label={`Pickup ${b.id}`} data-booking-marker={b.id} onClick={e => { e.stopPropagation(); session.setSelectedBookingId(b.id); session.setSelectedVehicleId(b.assignment?.vehicleId ?? null) }}><UserRound size={14} />{b.id.slice(-3)}</button></MarkerContent></MapMarker>
    })}
    {selectedBooking && selectedBooking.status !== 'scheduled' && <MapMarker longitude={selectedBooking.assignment?.tripRoute.coordinates.at(-1)?.[0] ?? selectedBooking.dropoff[0]} latitude={selectedBooking.assignment?.tripRoute.coordinates.at(-1)?.[1] ?? selectedBooking.dropoff[1]}><MarkerContent><div className="point-marker destination" title={`Dropoff ${selectedBooking.id}`}>B</div></MarkerContent></MapMarker>}
  </>
}
