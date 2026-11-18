export const colors = {
  navy: '#042573', blue: '#0961AD', orange: '#F86809',
  copper: '#D07438', slate: '#1B2B4E', white: '#FFFFFF',
};

const { navy, blue, slate, white } = colors;

function baseLayer(id, type, sourceLayer, paint, options = {}) {
  return { id, type, source: 'openmaptiles', 'source-layer': sourceLayer, paint, ...options };
}

export const buildingLayers = ['building-footprints', 'buildings-3d'];

export function mapStyle() {
  return {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': white } },
      baseLayer('land', 'fill', 'landcover', { 'fill-color': navy, 'fill-opacity': 0.045 }),
      baseLayer('parks', 'fill', 'park', { 'fill-color': blue, 'fill-opacity': 0.07 }),
      baseLayer('water', 'fill', 'water', { 'fill-color': blue, 'fill-opacity': 0.15 }),
      baseLayer('waterways', 'line', 'waterway', { 'line-color': blue, 'line-opacity': 0.24 }),
      baseLayer('building-footprints', 'fill', 'building', {
        'fill-color': slate, 'fill-opacity': 0.09,
      }, { minzoom: 13 }),
      baseLayer('buildings-3d', 'fill-extrusion', 'building', {
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-color': 'rgba(4, 37, 115, 0.16)',
        'fill-extrusion-height': ['get', 'render_height'],
        'fill-extrusion-opacity': 0.75,
      }, { minzoom: 14, filter: ['all', ['has', 'render_height'], ['!', ['has', 'hide_3d']]] }),
      baseLayer('streets', 'line', 'transportation', {
        'line-color': slate, 'line-opacity': 0.23,
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.4, 18, 2.5],
      }, { minzoom: 10, filter: ['!', ['in', ['get', 'class'], ['literal', ['path', 'ferry']]]] }),
      baseLayer('street-names', 'symbol', 'transportation_name', {
        'text-color': slate, 'text-halo-color': white, 'text-halo-width': 1,
      }, {
        minzoom: 15,
        layout: {
          'symbol-placement': 'line', 'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Regular'], 'text-size': 10,
        },
      }),
    ],
  };
}
