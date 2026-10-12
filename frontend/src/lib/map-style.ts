import type { StyleSpecification, ExpressionSpecification } from 'maplibre-gl'
import latin from '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url'
import vietnamese from '@fontsource-variable/geist/files/geist-vietnamese-wght-normal.woff2?url'
import type { ReplayAssets } from './replay-assets'

export const emptyStyle: StyleSpecification = { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#f1f2ed' } }] }
const major: ExpressionSpecification = ['in', ['get', 'highway'], ['literal', ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link']]]
export const localStyle: StyleSpecification = {
  version: 8,
  // MapLibre 6 renders local font files; no glyph or sprite server is involved.
  'font-faces': { Geist: [
    { url: vietnamese, 'unicode-range': ['U+0102-0103', 'U+0110-0111', 'U+0128-0129', 'U+0168-0169', 'U+01A0-01A1', 'U+01AF-01B0', 'U+0300-0301', 'U+0303-0304', 'U+0308-0309', 'U+0323', 'U+0329', 'U+1EA0-1EF9', 'U+20AB'] },
    { url: latin, 'unicode-range': ['U+0000-00FF', 'U+2000-206F'] },
  ] },
  sources: Object.fromEntries(['streets', 'water', 'green', 'buildings', 'places'].map(name => [name, { type: 'geojson' as const, data: `/api/map/${name}` }])),
  layers: [
    ...emptyStyle.layers,
    { id: 'water-area', type: 'fill', source: 'water', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#b3d9e5' } },
    { id: 'green-area', type: 'fill', source: 'green', paint: { 'fill-color': '#c7dfb8', 'fill-opacity': .85 } },
    { id: 'buildings', type: 'fill', source: 'buildings', minzoom: 14, paint: { 'fill-color': '#dddcd3', 'fill-outline-color': '#d1d0c6' } },
    { id: 'water-lines', type: 'line', source: 'water', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#9acdda', 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 2, 17, 7] } },
    { id: 'roads-casing', type: 'line', source: 'streets', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['case', major, '#cabb99', '#d8d7cd'], 'line-width': ['interpolate', ['linear'], ['zoom'], 12, ['case', major, 2, 1], 16, ['case', major, 8, 4], 19, ['case', major, 20, 10]] } },
    { id: 'roads', type: 'line', source: 'streets', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['case', major, '#f8e4b4', ['in', ['get', 'highway'], ['literal', ['footway', 'path', 'steps', 'pedestrian']]], '#e5dfd0', '#ffffff'], 'line-width': ['interpolate', ['linear'], ['zoom'], 12, ['case', major, 1, .5], 16, ['case', major, 6, 2.5], 19, ['case', major, 17, 7]] } },
    { id: 'road-names', type: 'symbol', source: 'streets', minzoom: 14.2, filter: ['has', 'name'], layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': ['Geist'], 'text-size': ['interpolate', ['linear'], ['zoom'], 14, 10, 18, 13], 'symbol-spacing': 250 }, paint: { 'text-color': '#687267', 'text-halo-color': '#fffef9', 'text-halo-width': 1.5 } },
    { id: 'place-names', type: 'symbol', source: 'places', minzoom: 13.5, layout: { 'text-field': ['get', 'name'], 'text-font': ['Geist'], 'text-size': 12, 'text-max-width': 12 }, paint: { 'text-color': '#486d53', 'text-halo-color': '#ffffff', 'text-halo-width': 2 } },
  ],
}

export function savedMapStyle(assets: ReplayAssets): StyleSpecification {
  const base=import.meta.env.BASE_URL
  const faces=localStyle['font-faces']!.Geist
  if(!Array.isArray(faces)) throw new Error('LOCAL_FONT_FACES_REQUIRED')
  return {...localStyle, sources:Object.fromEntries(Object.entries(assets.layers).map(([name,data])=>[name,{type:'geojson',data}])),
    'font-faces':{Geist:faces.map((face,i)=>({...face,url:base+`replay/fonts/geist-${i===0?'vietnamese':'latin'}.woff2`}))}}
}
