import { contentHash, sha256 } from './artifact'
import type { FeatureCollection } from 'geojson'
export const mapLayerNames = ['streets','water','green','buildings','places'] as const
export interface ReplayAssetManifest {
  schemaVersion: 'gsm-replay-assets/v1'; id: string; datasetFingerprint: string
  displayBbox: [number,number,number,number]; sourceStreetsSha256: string
  attribution: string; license: string; source: string
  files: { path: string; bytes: number; sha256: string }[]
}
export interface ReplayAssets { manifest: ReplayAssetManifest; layers: Record<typeof mapLayerNames[number],FeatureCollection> }
const paths = [...mapLayerNames.map(name=>`replay/map/${name}.geojson`),'replay/fonts/geist-latin.woff2','replay/fonts/geist-vietnamese.woff2','maplibre-gl-worker.mjs','maplibre-gl-shared.mjs']
export async function validateAssetManifest(manifest: ReplayAssetManifest) {
  if (!manifest || manifest.schemaVersion!=='gsm-replay-assets/v1' || !Array.isArray(manifest.files) || manifest.files.length!==paths.length || new Set(manifest.files.map(f=>f.path)).size!==paths.length || !manifest.datasetFingerprint || !manifest.attribution?.includes('OpenStreetMap') || !Array.isArray(manifest.displayBbox) || manifest.displayBbox.length!==4 || !manifest.displayBbox.every(Number.isFinite)) throw new Error('INVALID_ASSET_MANIFEST')
  // MapLibre 6.13 ships an intentionally empty shared module.
  const [w,s,e,n]=manifest.displayBbox
  for(const file of manifest.files) if(!paths.includes(file.path) || !Number.isInteger(file.bytes) || file.bytes<(file.path==='maplibre-gl-shared.mjs'?0:1) || file.bytes>16*1024*1024 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('INVALID_ASSET_MANIFEST: untrusted path/size/hash')
  if(w>=e || s>=n || w< -180 || e>180 || s< -90 || n>90 || manifest.files.find(f=>f.path==='replay/map/streets.geojson')?.sha256!==manifest.sourceStreetsSha256) throw new Error('INVALID_ASSET_MANIFEST: bbox/source mismatch')
  const {id,...body}=manifest
  if(await contentHash(body)!==id) throw new Error('INVALID_ASSET_MANIFEST: checksum mismatch')
  return manifest
}
/** Fixed same-origin paths only; imported references never choose a URL. */
export async function loadReplayAssets(signal?: AbortSignal): Promise<ReplayAssets> {
  const base=import.meta.env.BASE_URL
  const response=await fetch(base+'replay/manifest.json',{signal})
  if(!response.ok) throw new Error('REPLAY_ASSETS_MISSING: tạo static replay package theo README.')
  const manifest=await validateAssetManifest(await response.json())
  const layers={} as ReplayAssets['layers']
  for(const file of manifest.files) {
    const response=await fetch(base+file.path,{signal})
    if(!response.ok) throw new Error(`REPLAY_ASSET_MISSING: ${file.path}`)
    const length=Number(response.headers.get('content-length'))
    if(length && length>16*1024*1024) throw new Error('REPLAY_ASSET_TOO_LARGE')
    const bytes=new Uint8Array(await response.arrayBuffer())
    if(bytes.length!==file.bytes || await sha256(bytes)!==file.sha256) throw new Error(`REPLAY_ASSET_CHECKSUM: ${file.path}`)
    const name=mapLayerNames.find(name=>file.path===`replay/map/${name}.geojson`)
    if(name) {
      const layer=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as FeatureCollection
      if(layer.type!=='FeatureCollection' || !Array.isArray(layer.features) || layer.features.length===0) throw new Error('INVALID_STATIC_GEOJSON')
      layers[name]=layer
    }
  }
  return {manifest,layers}
}
