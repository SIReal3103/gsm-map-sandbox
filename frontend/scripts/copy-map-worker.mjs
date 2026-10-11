import { copyFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const root = new URL('../', import.meta.url)
mkdirSync(new URL('public/', root), { recursive: true })
for (const file of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) {
  copyFileSync(fileURLToPath(new URL(`node_modules/maplibre-gl/dist/${file}`, root)), fileURLToPath(new URL(`public/${file}`, root)))
}
