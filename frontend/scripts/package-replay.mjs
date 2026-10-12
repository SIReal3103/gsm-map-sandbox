// Uses the exact browser artifact implementation through a local Vite library
// build. No Python/Node duplicate canonicalizer, no routing/extraction by default.
import { build } from 'vite'
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises'
import { resolve, dirname, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const frontend=resolve(dirname(fileURLToPath(import.meta.url)),'..'), root=resolve(frontend,'..')
await build({configFile:false,logLevel:'warn',build:{lib:{entry:resolve(frontend,'src/lib/artifact.ts'),formats:['es'],fileName:()=> 'artifact.mjs'},outDir:resolve(frontend,'.replay-tools'),emptyOutDir:true}})
const api=await import(pathToFileURL(resolve(frontend,'.replay-tools/artifact.mjs')).href)
const sourceArg=process.argv.find(a=>a.startsWith('--source='))?.slice(9)
const source=sourceArg ? resolve(root,sourceArg) : resolve(root,'docs/evidence/a4/default.json')
if(!source.startsWith(root+'\\') && !source.startsWith(root+'/')) throw new Error('Source must stay inside project')
const experiment=api.validatePortableExperiment(JSON.parse(await readFile(source,'utf8')))
const files=[]
const add=async(from,to)=>{
  const bytes=await readFile(from), destination=resolve(frontend,'public',to)
  await mkdir(dirname(destination),{recursive:true}); await copyFile(from,destination)
  files.push({path:to,bytes:bytes.length,sha256:await api.sha256(bytes)})
}
for(const name of ['streets','water','green','buildings','places']) await add(resolve(root,`data/processed/render/${name}.geojson`),`replay/map/${name}.geojson`)
for(const name of ['latin','vietnamese']) await add(resolve(frontend,`node_modules/@fontsource-variable/geist/files/geist-${name}-wght-normal.woff2`),`replay/fonts/geist-${name}.woff2`)
for(const name of ['maplibre-gl-worker.mjs','maplibre-gl-shared.mjs']) await add(resolve(frontend,'node_modules/maplibre-gl/dist',name),name)
if(files.find(f=>f.path==='replay/map/streets.geojson').sha256!==experiment.provenance.streets_sha256) throw new Error('Experiment and source streets fingerprint mismatch')
const body={schemaVersion:'gsm-replay-assets/v1',datasetFingerprint:experiment.datasetFingerprint,displayBbox:experiment.provenance.display_bbox,sourceStreetsSha256:experiment.provenance.streets_sha256,source:'Geofabrik Vietnam / OpenStreetMap — derived local A1 renderer',attribution:'© OpenStreetMap contributors',license:'ODbL 1.0; https://www.openstreetmap.org/copyright',files}
const manifest={...body,id:await api.contentHash(body)}
const artifact=await api.exportArtifact(experiment,manifest.id)
await api.importArtifact(JSON.stringify(artifact))
await writeFile(resolve(frontend,'public/replay/manifest.json'),JSON.stringify(manifest,null,2)+'\n')
await writeFile(resolve(frontend,'public/replay/demo-experiment.json'),JSON.stringify(artifact)+'\n')
await mkdir(resolve(root,'contracts'),{recursive:true})
await writeFile(resolve(root,'contracts/replay-asset-manifest.json'),JSON.stringify(manifest,null,2)+'\n')
await writeFile(resolve(root,'contracts/demo-artifact-manifest.json'),JSON.stringify({schemaVersion:artifact.schemaVersion,experimentId:artifact.experimentId,datasetFingerprint:artifact.datasetFingerprint,artifactDigest:artifact.integrity.digest,assetManifestId:manifest.id,source:relative(root,source).replaceAll('\\','/')+' (actual local OSRM experiment)',generatedPackage:'frontend/public/replay/',bytes:new TextEncoder().encode(JSON.stringify(artifact)).length},null,2)+'\n')
console.log(JSON.stringify({status:'PASS',experimentId:experiment.id,digest:artifact.integrity.digest,assets:files.length,assetBytes:files.reduce((s,f)=>s+f.bytes,0),artifactBytes:new TextEncoder().encode(JSON.stringify(artifact)).length,manifestId:manifest.id},null,2))
