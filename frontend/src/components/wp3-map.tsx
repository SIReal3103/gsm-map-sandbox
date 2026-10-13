import { useEffect } from 'react'
import { Car, LocateFixed, MapPinned, X } from 'lucide-react'
import { MapMarker, MarkerContent, MapRoute, useMap } from './ui/map'
import { bookingStatus, timeText, vehicleState, type Wp3Result, type Wp3Run } from '@/lib/wp3'

const statusLabels = { idle: 'Xe rảnh', pickup: 'Đang đến đón', trip: 'Đang chở khách' }
const roadName = (anchor: Wp3Result['anchors'][number]) => [...new Set((anchor.routing_name || anchor.name).split('/').map(name => name.trim()).filter(Boolean))].join(' / ')

export function Wp3Map({ result, run, time, selected, onSelect }: { result: Wp3Result; run: Wp3Run; time: number; selected: string | null; onSelect: (id: string) => void }) {
  const { map, isLoaded } = useMap()
  useEffect(() => {
    if (!map || !isLoaded) return
    const box = result.provenance.sampling_bbox as number[]
    map.fitBounds([[box[0], box[1]], [box[2], box[3]]], { padding: 55, maxZoom: 16, duration: 400 })
  }, [map, isLoaded, result])
  const states = run.vehicles.map(v => ({ ...v, ...vehicleState(v, run, result, time) }))
  const vehicle = states.find(v => v.id === selected)
  const box = result.provenance.sampling_bbox as number[]
  return <>
    <MapRoute coordinates={[[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]], [box[0], box[1]]]} color="#537f72" width={1.5} dashArray={[4, 3]} opacity={.55} interactive={false} />
    {states.filter(v => v.leg && (v.id === selected || !selected)).map(v => <MapRoute key={`${v.id}-${v.leg!.path_id}`} coordinates={result.paths[v.leg!.path_id].coordinates} color={v.status === 'pickup' ? '#d18c40' : '#008c82'} width={v.id === selected ? 5 : 3} opacity={v.id === selected ? .85 : .45} interactive={false} />)}
    {run.quotes.filter(q => ['queued', 'pickup'].includes(bookingStatus(q, time))).map(q => {
      const coordinate = result.anchors[q.origin].coordinate
      return <MapMarker key={q.id} longitude={coordinate[0]} latitude={coordinate[1]}><MarkerContent><div className={`wp3-request ${bookingStatus(q, time)}`} title={`${q.id} · voucher ${q.offer_vnd} ₫`}>{q.offer_vnd ? '₫' : '●'}</div></MarkerContent></MapMarker>
    })}
    {states.map(v => <MapMarker key={v.id} longitude={v.coordinate[0]} latitude={v.coordinate[1]}><MarkerContent><button className={`wp3-car ${v.status} ${selected === v.id ? 'selected' : ''}`} aria-label={`WP3 xe ${v.id}`} aria-pressed={selected === v.id} data-wp3-vehicle={v.id} data-status={v.status} data-coordinate={JSON.stringify(v.coordinate)} onClick={() => onSelect(v.id === selected ? '' : v.id)} title={`${v.id} · ${v.status}`}><Car size={16} /><span>{v.id.slice(1)}</span></button></MarkerContent></MapMarker>)}
    <button className="wp3-fit-area" onClick={() => map?.fitBounds([[box[0], box[1]], [box[2], box[3]]], { padding: 55, maxZoom: 16, duration: 400 })}><MapPinned size={14} /> Về vùng thử nghiệm</button>
    {vehicle && <section className="wp3-vehicle-detail" aria-label={`Chi tiết xe ${vehicle.id}`}>
      <div><strong>{vehicle.id} · {statusLabels[vehicle.status]}</strong><button aria-label="Đóng chi tiết xe" onClick={() => onSelect('')}><X size={14} /></button></div>
      {vehicle.leg ? <><p>{vehicle.leg.request_id} · {roadName(result.anchors[vehicle.leg.origin])} → {roadName(result.anchors[vehicle.leg.destination])}</p><p>Còn {timeText(vehicle.remainingSeconds)} · tuyến {(result.paths[vehicle.leg.path_id].distance / 1000).toFixed(2)} km</p></> : <p>Đang chờ booking trên mạng đường OSM.</p>}
      <button className="wp3-focus-vehicle" onClick={() => map?.flyTo({ center: vehicle.coordinate, zoom: 16, duration: 400 })}><LocateFixed size={14} /> Tìm xe trên map</button>
      <small>Thời gian ước tính OSRM × {result.config.traffic_factor}; chưa hiệu chỉnh GPS.</small>
    </section>}
  </>
}
