import type { StyleSpecification, ExpressionSpecification } from 'maplibre-gl'
import latin from '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url'
import vietnamese from '@fontsource-variable/geist/files/geist-vietnamese-wght-normal.woff2?url'

export const emptyStyle: StyleSpecification = { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#f4f1e9' } }] }
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
    { id: 'water-area', type: 'fill', source: 'water', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#b8d9db' } },
    { id: 'green-area', type: 'fill', source: 'green', paint: { 'fill-color': '#c6dccc', 'fill-opacity': .85 } },
    { id: 'buildings', type: 'fill', source: 'buildings', minzoom: 14, paint: { 'fill-color': '#e3dfd3', 'fill-outline-color': '#d5d2c5' } },
    { id: 'water-lines', type: 'line', source: 'water', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#9bcbd0', 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 2, 17, 7] } },
    { id: 'roads-casing', type: 'line', source: 'streets', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['case', major, '#d6cfb9', '#e1dbcc'], 'line-width': ['interpolate', ['linear'], ['zoom'], 12, ['case', major, 2, 1], 16, ['case', major, 8, 4], 19, ['case', major, 20, 10]] } },
    { id: 'roads', type: 'line', source: 'streets', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['case', major, '#fff7dc', ['in', ['get', 'highway'], ['literal', ['footway', 'path', 'steps', 'pedestrian']]], '#e5decf', '#ffffff'], 'line-width': ['interpolate', ['linear'], ['zoom'], 12, ['case', major, 1, .5], 16, ['case', major, 6, 2.5], 19, ['case', major, 17, 7]] } },
    { id: 'water-names', type: 'symbol', source: 'water', minzoom: 13.5, filter: ['has', 'name'], layout: { 'text-field': ['get', 'name'], 'text-font': ['Geist'], 'text-size': 12, 'text-letter-spacing': .12 }, paint: { 'text-color': '#63989d', 'text-halo-color': '#c6e2e2', 'text-halo-width': 1 } },
    { id: 'place-dots', type: 'circle', source: 'places', minzoom: 16, paint: { 'circle-radius': 3, 'circle-color': '#548f80', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5 } },
    { id: 'major-road-names', type: 'symbol', source: 'streets', minzoom: 13, maxzoom: 15, filter: ['all', ['has', 'name'], major], layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': ['Geist'], 'text-size': 11, 'symbol-spacing': 350 }, paint: { 'text-color': '#66746c', 'text-halo-color': '#fffef9', 'text-halo-width': 1.5 } },
    { id: 'road-names', type: 'symbol', source: 'streets', minzoom: 15, filter: ['has', 'name'], layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': ['Geist'], 'text-size': ['interpolate', ['linear'], ['zoom'], 14, 10, 18, 13], 'symbol-spacing': 250 }, paint: { 'text-color': '#66746c', 'text-halo-color': '#fffef9', 'text-halo-width': 1.5 } },
    { id: 'place-names', type: 'symbol', source: 'places', minzoom: 16, layout: { 'text-field': ['get', 'name'], 'text-font': ['Geist'], 'text-size': 11, 'text-max-width': 10, 'text-optional': true }, paint: { 'text-color': '#488176', 'text-halo-color': '#ffffff', 'text-halo-width': 2 } },
  ],
}
