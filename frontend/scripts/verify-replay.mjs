import {build} from 'vite'
import {readFile,writeFile} from 'node:fs/promises'
import {resolve,dirname} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
const frontend=resolve(dirname(fileURLToPath(import.meta.url)),'..'),root=resolve(frontend,'..')
await build({configFile:false,logLevel:'warn',build:{lib:{entry:resolve(frontend,'src/lib/voucher.ts'),formats:['es'],fileName:()=> 'voucher.mjs'},outDir:resolve(frontend,'.replay-tools'),emptyOutDir:false}})
const artifacts=await import(pathToFileURL(resolve(frontend,'.replay-tools/artifact.mjs')).href)
const voucher=await import(pathToFileURL(resolve(frontend,'.replay-tools/voucher.mjs')).href)
const artifact=await artifacts.importArtifact(await readFile(resolve(frontend,'public/replay/demo-experiment.json'),'utf8'))
const manifest=JSON.parse(await readFile(resolve(frontend,'public/replay/manifest.json'),'utf8'))
const {id,...body}=manifest
if(await artifacts.contentHash(body)!==id || artifact.assetManifestReference.id!==id)throw new Error('MANIFEST_MISMATCH')
for(const file of manifest.files){const bytes=await readFile(resolve(frontend,'public',file.path));if(bytes.length!==file.bytes||await artifacts.sha256(bytes)!==file.sha256)throw new Error('ASSET_MISMATCH: '+file.path)}
const audit={package:'PASS',artifactDigest:artifact.integrity.digest,assets:manifest.files.length,browserExports:'NOT_RUN'}
if(process.argv.includes('--browser')) {
  const exported=await artifacts.importArtifact(await readFile(resolve(root,'docs/evidence/a5/browser-portable-export.json'),'utf8'))
  if(artifacts.canonicalJson(exported)!==artifacts.canonicalJson(artifact))throw new Error('PORTABLE_ROUNDTRIP_MISMATCH')
  const legacy=JSON.parse(await readFile(resolve(root,'docs/evidence/a5/browser-legacy.json'),'utf8'))
  if(artifacts.canonicalJson(legacy)!==artifacts.canonicalJson(artifact.payload))throw new Error('LEGACY_EXPORT_MISMATCH')
  for(const [name,text] of Object.entries(voucher.experimentCsv(artifact.payload)))if(await readFile(resolve(root,`docs/evidence/a5/browser-${name}.csv`),'utf8')!==text)throw new Error('CSV_MISMATCH: '+name)
  audit.browserExports='PASS: portable + legacy JSON + 5 exact CSVs'
  await writeFile(resolve(root,'docs/evidence/a5/replay-verification.json'),JSON.stringify(audit,null,2)+'\n')
}
console.log(JSON.stringify(audit,null,2))
