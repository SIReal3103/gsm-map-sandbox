import { validateExperiment, experimentMetrics, delta, type Experiment, type ExperimentConfig } from './voucher'
import type { BookingPlan, BookingInput } from './booking'
import type { Coordinate, Route } from './api'

export const artifactSchema = 'gsm-voucher-experiment/v1' as const
export const importLimits = { bytes: 12 * 1024 * 1024, depth: 32, nodes: 1000000, routePoints: 200000 }
export interface ExperimentArtifact {
  schemaVersion: typeof artifactSchema
  experimentId: string
  modelVersions: Record<string, string>
  createdAt: string
  datasetFingerprint: string
  assetManifestReference: { schemaVersion: 'gsm-replay-assets/v1'; id: string }
  payload: Experiment
  integrity: { algorithm: 'SHA-256'; canonicalization: 'gsm-json-sorted/v1'; digest: string }
}
const error = (message: string): never => { throw new Error(`INVALID_SAVED_ARTIFACT: ${message}`) }
export function sameData(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Number.isFinite(a) && Math.abs(a-b) <= 1e-8*Math.max(1, Math.abs(a), Math.abs(b))
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a), bk = Object.keys(b)
    return ak.length === bk.length && ak.every(k => Object.hasOwn(b, k) && sameData((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  }
  return a === b
}
/** One implementation, used by browser, Node packaging and contract tests.
 * Sorted object keys (UTF-16 code units), original array order, ECMAScript JSON
 * number/string serialization, UTF-8. No Python canonicalization implementation.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return '['+value.map(canonicalJson).join(',')+']'
  if (value && typeof value === 'object') return '{'+Object.keys(value).sort().map(k => JSON.stringify(k)+':'+canonicalJson((value as Record<string, unknown>)[k])).join(',')+'}'
  return error('Giá trị JSON không hợp lệ.')
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))), b => b.toString(16).padStart(2, '0')).join('')
}
export const contentHash = (value: unknown) => sha256(new TextEncoder().encode(canonicalJson(value)))
function freezeJson<T>(value:T):T {
  if(value && typeof value==='object') {for(const item of Object.values(value)) freezeJson(item);Object.freeze(value)}
  return value
}

function boundedJson(value: unknown) {
  let nodes = 0
  const visit = (v: unknown, depth: number) => {
    if (++nodes > importLimits.nodes || depth > importLimits.depth) error('Vượt giới hạn nesting/records.')
    if (typeof v === 'number' && !Number.isFinite(v)) error('Numeric values phải finite.')
    if (typeof v === 'string' && v.length > 10000) error('Chuỗi quá dài.')
    if (Array.isArray(v)) { if (v.length > importLimits.routePoints) error('Array quá lớn.'); v.forEach(x => visit(x, depth+1)) }
    else if (v && typeof v === 'object') {
      if (Object.keys(v).length > 1000) error('Quá nhiều object keys.')
      for (const [key, x] of Object.entries(v)) { if (['__proto__', 'prototype', 'constructor'].includes(key)) error('Object key không được hỗ trợ.'); visit(x, depth+1) }
    } else if (v !== null && !['number', 'string', 'boolean'].includes(typeof v)) error('Giá trị JSON không được hỗ trợ.')
  }
  visit(value, 0)
}
const required = (v: unknown, keys: string[]) => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || keys.some(k => !Object.hasOwn(v, k))) error('Thiếu required fields: '+keys.join(', '))
}
const text = (v: unknown, max=200) => { if (typeof v !== 'string' || !v.trim() || v.length > max) error('String/ID không hợp lệ.') }
const nullableText = (v:unknown) => {if(v!==null) text(v,10000)}
const array = (v: unknown, max: number) => { if (!Array.isArray(v) || v.length > max) error('Danh sách không hợp lệ hoặc quá lớn.') }
const range = (v: unknown, min: number, max: number, integer=false) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || integer && !Number.isInteger(v)) error('Numeric value ngoài bounds.') }
const coordinate = (p: Coordinate) => { array(p, 2); if (p.length !== 2) error('WGS84 phải là [lon,lat].'); range(p[0], -180, 180); range(p[1], -90, 90) }
const metadata = (value:{createdAt:string;preparationMilliseconds:number;routingRequests:Record<string,number>}) => {
  text(value.createdAt);if(!Number.isFinite(Date.parse(value.createdAt))) error('Invalid metadata date.')
  range(value.preparationMilliseconds,0,86400000);required(value.routingRequests,[])
  for(const count of Object.values(value.routingRequests)) range(count,0,1000000,true)
}
const meters = (a: Coordinate, b: Coordinate) => Math.hypot((a[0]-b[0])*Math.cos((a[1]+b[1])/2*Math.PI/180), a[1]-b[1])*Math.PI/180*6371008.8
const eventOrder: Record<string, number> = { TRIP_COMPLETED: 0, BOOKING_REQUESTED: 1, BOOKING_ASSIGNED: 2, VEHICLE_ARRIVED_PICKUP: 3, TRIP_STARTED: 4, BOOKING_UNSERVED: 5 }
export function validateExperimentConfig(c: ExperimentConfig) {
  required(c, ['seed','fleetSize','potentialCount','horizonSeconds','maxWaitSeconds','preset','fare','behavior','voucher','campaignBudget'])
  text(c.seed, 80); range(c.fleetSize, 1, 10, true); range(c.potentialCount, 10, 30, true); range(c.horizonSeconds, 60, 3600, true); range(c.maxWaitSeconds, 10, 900, true)
  if (!['Low','Medium','High'].includes(c.preset)) error('Demand preset không hỗ trợ.')
  required(c.fare, ['baseFare','perKm']); required(c.behavior, ['alpha','beta','referenceFare']); required(c.voucher, ['type','fixedAmount','rate','cap','minimumFare'])
  range(c.fare.baseFare, 0, 100000, true); range(c.fare.perKm, 0, 100000, true); range(c.behavior.alpha,-20,20); range(c.behavior.beta,0,20); range(c.behavior.referenceFare,1,1000000,true)
  if (!['fixed','percentage'].includes(c.voucher.type)) error('Voucher type không hỗ trợ.')
  range(c.voucher.fixedAmount,0,1000000,true); range(c.voucher.rate,0,1); range(c.voucher.cap,0,1000000,true); range(c.voucher.minimumFare,0,1000000,true); range(c.campaignBudget,0,10000000,true)
}
/** Stronger portable-input checks surround the existing A4 live validator. */
export function validatePortableExperiment(e: Experiment) {
  boundedJson(e)
  required(e, ['id','seed','config','potential','baseline','treatment','final','comparison','timeSeries','simulationDurationSeconds','datasetFingerprint','provenance','assumptions','createdAt','preparationMilliseconds','routingRequests'])
  text(e.id); text(e.datasetFingerprint); text(e.createdAt); if (!Number.isFinite(Date.parse(e.createdAt))) error('createdAt không hợp lệ.')
  validateExperimentConfig(e.config); if (e.seed !== e.config.seed) error('Seed không nhất quán.')
  metadata(e)
  range(e.simulationDurationSeconds, 0.000001, 86400); array(e.potential,30); array(e.timeSeries,512)
  required(e.provenance, ['display_bbox','max_snap_meters','algorithm','profile']); required(e.assumptions, ['versions'])
  range(e.provenance.max_snap_meters as number,.000001,1000)
  if(!sameData(e.assumptions.versions,{fare:'fare-v1',behavior:'price-response-v1',voucher:'ledger-v1',orchestrator:'paired-v1',dispatch:'dispatch-v1'})) error('Unsupported model versions.')
  if(e.provenance.algorithm!=='mld' || e.provenance.profile!=='car') error('Unsupported routing profile.')
  const bbox = e.provenance.display_bbox as number[]
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite) || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) error('Bbox không hợp lệ.')
  coordinate([bbox[0],bbox[1]]); coordinate([bbox[2],bbox[3]])
  const covered=(p:Coordinate)=>{coordinate(p);if(p[0]<bbox[0] || p[0]>bbox[2] || p[1]<bbox[1] || p[1]>bbox[3]) error('Point outside display coverage.')}
  let points = 0
  const route = (r: Route) => {
    required(r,['coordinates','distance','duration','snap_points','duration_source']); array(r.coordinates,20000); text(r.duration_source)
    points += r.coordinates.length; if (points > importLimits.routePoints) error('Vượt tổng số route points.')
    r.coordinates.forEach(covered); array(r.snap_points,2)
    for (const snap of r.snap_points) { required(snap,['location','distance','name']); coordinate(snap.location); range(snap.distance,0,Number(e.provenance.max_snap_meters)); if (typeof snap.name !== 'string') error('Snap name không hợp lệ.') }
    if (r.snap_points.length !== 2 || !r.coordinates.length || meters(r.coordinates[0],r.snap_points[0].location)>5 || meters(r.coordinates.at(-1)!,r.snap_points[1].location)>5) error('Geometry không khớp snap points.')
  }
  const demand = (b: BookingInput) => {
    required(b,['id','passengerId','requestTimeSeconds','pickup','dropoff','pickupCandidateId','dropoffCandidateId'])
    for (const s of [b.id,b.passengerId,b.pickupCandidateId,b.dropoffCandidateId]) text(s)
    range(b.requestTimeSeconds,0,e.config.horizonSeconds); covered(b.pickup); covered(b.dropoff)
    if (sameData(b.pickup,b.dropoff)) error('Pickup và dropoff trùng nhau.')
  }
  let previousRequest = -1
  for (const p of e.potential) {
    demand(p); required(p,['valid','invalidReason','quotedFareVnd','quotedRoute','alpha','beta','referenceFareVnd','randomDraw','datasetFingerprint'])
    nullableText(p.invalidReason)
    if(p.valid && p.invalidReason!==null || !p.valid && p.invalidReason===null) error('Invalid potential reason.')
    if (typeof p.valid !== 'boolean' || p.datasetFingerprint !== e.datasetFingerprint || p.requestTimeSeconds < previousRequest || p.alpha !== e.config.behavior.alpha || p.beta !== e.config.behavior.beta || p.referenceFareVnd !== e.config.behavior.referenceFare) error('Potential/provenance không nhất quán.')
    previousRequest = p.requestTimeSeconds; range(p.randomDraw,0,1); if (p.quotedRoute) route(p.quotedRoute)
  }
  for (const armName of ['baseline','treatment'] as const) {
    const arm=e[armName]; required(arm,['plan','decisions','ledger']); array(arm.decisions,30); array(arm.ledger,120)
    const plan:BookingPlan=arm.plan
    required(plan,['id','seed','config','demand','vehicles','assignments','events','simulationDurationSeconds','datasetFingerprint','routingSource','provenance','assumptions','createdAt','preparationMilliseconds','routingRequests'])
    metadata(plan)
    if (plan.datasetFingerprint !== e.datasetFingerprint || plan.seed !== e.seed || !sameData(plan.provenance,e.provenance) || plan.config.fleetSize !== e.config.fleetSize || plan.config.bookingCount !== e.config.potentialCount || plan.config.maxWaitSeconds !== e.config.maxWaitSeconds || plan.config.horizonSeconds !== e.config.horizonSeconds || plan.config.preset !== e.config.preset) error('Arm inputs/provenance khác nhau.')
    text(plan.routingSource); array(plan.demand,30); array(plan.vehicles,10); array(plan.assignments,30); array(plan.events,180); plan.demand.forEach(b=>{demand(b); const p=e.potential.find(p=>p.id===b.id); if (!p || !['id','passengerId','requestTimeSeconds','pickup','dropoff','pickupCandidateId','dropoffCandidateId'].every(k=>sameData(b[k as keyof BookingInput],p[k as keyof BookingInput]))) error('Arm demand khác potential inputs.')})
    const positions=new Map<string,Coordinate>()
    for (const v of plan.vehicles) { required(v,['id','candidateId','initialPosition']); text(v.id); text(v.candidateId); covered(v.initialPosition); positions.set(v.id,v.initialPosition) }
    for (const a of plan.assignments) {
      required(a,['bookingId','vehicleId','assignedAtSeconds','pickupAtSeconds','dropoffAtSeconds','estimatedPickupEtaSeconds','tableEtaSeconds','pickupRoute','tripRoute','dispatchCandidates'])
      route(a.tripRoute); if(a.pickupRoute) route(a.pickupRoute)
      const position=positions.get(a.vehicleId), pickup=a.pickupRoute
      if (!position || (pickup ? meters(position,pickup.coordinates[0])>1 || meters(pickup.coordinates.at(-1)!,a.tripRoute.coordinates[0])>1 : meters(position,a.tripRoute.coordinates[0])>=.1) || Math.abs(a.estimatedPickupEtaSeconds-(pickup?.duration??0))>1e-6) error('Discontinuous pickup/trip hoặc ETA sai.')
      positions.set(a.vehicleId,a.tripRoute.coordinates.at(-1)!)
      array(a.dispatchCandidates,10); for (const d of a.dispatchCandidates) { required(d,['vehicleId','etaSeconds']); if (!positions.has(d.vehicleId)) error('ETA candidate reference sai.'); if (d.etaSeconds!==null) range(d.etaSeconds,0,86400) }
    }
    let previousEvent: typeof plan.events[number] | null=null
    for (const event of plan.events) {
      required(event,['id','timestampSeconds','type','bookingId','vehicleId','payload']); text(event.id); required(event.payload,[])
      const booking=plan.demand.find(b=>b.id===event.bookingId), a=plan.assignments.find(a=>a.bookingId===event.bookingId)
      if (!booking || !Object.hasOwn(eventOrder,event.type)) error('Event reference/type sai.')
      if(event.type==='BOOKING_ASSIGNED') {
        if(!a || !sameData(event.payload,{estimatedPickupEtaSeconds:a.estimatedPickupEtaSeconds,tableEtaSeconds:a.tableEtaSeconds,dispatchCandidates:a.dispatchCandidates})) error('Invalid assignment event payload.')
      } else if(event.type==='BOOKING_UNSERVED') {
        text(event.payload.failureReason,10000)
        if(Object.keys(event.payload).length!==1) error('Invalid failure event payload.')
      } else if(Object.keys(event.payload).length) error('Unexpected lifecycle event payload.')
      const expected = event.type==='BOOKING_REQUESTED' ? booking!.requestTimeSeconds : event.type==='BOOKING_UNSERVED' ? booking!.requestTimeSeconds+plan.config.maxWaitSeconds : event.type==='BOOKING_ASSIGNED' ? a?.assignedAtSeconds : event.type==='TRIP_COMPLETED' ? a?.dropoffAtSeconds : a?.pickupAtSeconds
      if (expected===undefined || Math.abs(event.timestampSeconds-expected)>1e-6 || (!['BOOKING_REQUESTED','BOOKING_UNSERVED'].includes(event.type) && event.vehicleId!==a?.vehicleId)) error('Lifecycle timestamp/reference sai.')
      if (previousEvent && event.timestampSeconds===previousEvent.timestampSeconds && eventOrder[event.type]<eventOrder[previousEvent.type]) error('Event priority sai.')
      previousEvent=event
    }
    if (plan.simulationDurationSeconds!==Math.max(0,...plan.events.map(v=>v.timestampSeconds))) error('Plan duration sai.')
    let decisionTime=-1
    for (const d of arm.decisions) { required(d,['potentialId','timestampSeconds','valid','discountVnd','effectiveFareVnd','probability','accepted','reason','availableBeforeVnd','availableAfterVnd']); nullableText(d.reason);range(d.availableBeforeVnd,0,e.config.campaignBudget,true);range(d.availableAfterVnd,0,e.config.campaignBudget,true);if (d.timestampSeconds<decisionTime || typeof d.accepted!=='boolean' || typeof d.valid!=='boolean') error('Decision order/type sai.'); decisionTime=d.timestampSeconds }
    const offers=new Set<string>()
    for (const l of arm.ledger) {required(l,['id','type','timestampSeconds','bookingId','amountVnd','total','reserved','spent','available']);if(l.type==='OFFERED'){if(offers.has(l.bookingId)) error('Duplicate voucher offer.');offers.add(l.bookingId)}else if(!offers.has(l.bookingId))error('Ledger reservation thiếu offer.')}
    required(e.final,['baseline','treatment'])
    if (!sameData(experimentMetrics(e,armName,e.simulationDurationSeconds),e.final[armName])) error('Final KPI không khớp plan/ledger.')
  }
  if (e.simulationDurationSeconds !== Math.max(e.config.horizonSeconds,e.baseline.plan.simulationDurationSeconds,e.treatment.plan.simulationDurationSeconds)) error('Common duration sai.')
  validateExperiment(e)
  let lastTime=-1
  for (const row of e.timeSeries) {
    required(row,['timeSeconds','baseline','treatment']); range(row.timeSeconds,0,e.simulationDurationSeconds)
    if (row.timeSeconds<=lastTime) error('Time series order sai.'); lastTime=row.timeSeconds
    for (const arm of ['baseline','treatment'] as const) if(!sameData(row[arm],experimentMetrics(e,arm,row.timeSeconds))) error('Time series metrics không khớp plan.')
  }
  if(e.timeSeries[0]?.timeSeconds!==0 || e.timeSeries.at(-1)?.timeSeconds!==e.simulationDurationSeconds) error('Time series thiếu điểm đầu/cuối.')
  if(!sameData(delta(e.final.baseline,e.final.treatment),e.comparison)) error('Comparison không nhất quán.')
  return e
}

export async function exportArtifact(e: Experiment, manifestId: string): Promise<ExperimentArtifact> {
  validatePortableExperiment(e)
  const content = { schemaVersion: artifactSchema, experimentId:e.id, modelVersions:e.assumptions.versions as Record<string,string>, createdAt:e.createdAt, datasetFingerprint:e.datasetFingerprint, assetManifestReference:{schemaVersion:'gsm-replay-assets/v1' as const,id:manifestId}, payload:e }
  return {...content,integrity:{algorithm:'SHA-256',canonicalization:'gsm-json-sorted/v1',digest:await contentHash(content)}}
}
export async function importArtifact(source: string): Promise<ExperimentArtifact> {
  if(new TextEncoder().encode(source).byteLength>importLimits.bytes) error('File lớn hơn 12 MiB.')
  let artifact:ExperimentArtifact
  try { artifact=JSON.parse(source) } catch { return error('Malformed JSON.') }
  boundedJson(artifact); required(artifact,['schemaVersion','experimentId','modelVersions','createdAt','datasetFingerprint','assetManifestReference','payload','integrity'])
  if(artifact.schemaVersion!==artifactSchema) error('Unsupported schema version. JSON A4 legacy cần export portable v1 rõ ràng.')
  required(artifact.integrity,['algorithm','canonicalization','digest']); required(artifact.assetManifestReference,['schemaVersion','id'])
  if(artifact.integrity.algorithm!=='SHA-256' || artifact.integrity.canonicalization!=='gsm-json-sorted/v1') error('Unsupported integrity convention.')
  const {integrity,...content}=artifact
  if(await contentHash(content)!==integrity.digest) error('Checksum không khớp; artifact đã thay đổi.')
  validatePortableExperiment(artifact.payload)
  if(artifact.experimentId!==artifact.payload.id || artifact.createdAt!==artifact.payload.createdAt || artifact.datasetFingerprint!==artifact.payload.datasetFingerprint || !sameData(artifact.modelVersions,artifact.payload.assumptions.versions) || artifact.assetManifestReference.schemaVersion!=='gsm-replay-assets/v1' || !/^[a-f0-9]{64}$/.test(artifact.assetManifestReference.id)) error('Envelope/provenance không khớp payload.')
  return freezeJson(artifact)
}
