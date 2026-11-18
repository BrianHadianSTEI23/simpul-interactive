export const colors = {
  navy: '#042573', blue: '#0961AD', orange: '#F86809',
  copper: '#D07438', slate: '#1B2B4E', white: '#FFFFFF',
};

const { navy, blue, slate, white } = colors;

function baseLayer(id, type, sourceLayer, paint, options = {}) {
  return { id, type, source: 'openmaptiles', 'source-layer': sourceLayer, paint, ...options };
}

export function mapStyle() {
  return {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': white } },
      baseLayer('water', 'fill', 'water', { 'fill-color': blue, 'fill-opacity': 0.07 }),
      baseLayer('streets', 'line', 'transportation', {
        'line-color': slate, 'line-opacity': 0.11,
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.4, 18, 2.5],
      }, { minzoom: 10, filter: ['!', ['in', ['get', 'class'], ['literal', ['path', 'ferry']]]] }),
      baseLayer('main-streets', 'line', 'transportation', {
        'line-color': navy, 'line-opacity': 0.19,
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.7, 15, 1.8, 18, 3.8],
      }, {
        minzoom: 9,
        filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary', 'secondary']]],
      }),
      baseLayer('street-names', 'symbol', 'transportation_name', {
        'text-color': slate, 'text-halo-color': white, 'text-halo-width': 1,
      }, {
        minzoom: 15,
        layout: {
          'symbol-placement': 'line', 'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Regular'], 'text-size': 10,
        },
      }),
      baseLayer('jakarta-areas', 'symbol', 'place', {
        'text-color': navy, 'text-halo-color': white, 'text-halo-width': 1.4,
      }, {
        minzoom: 9,
        filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'suburb', 'quarter', 'neighbourhood']]],
        layout: {
          'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'],
          'text-size': ['match', ['get', 'class'], 'city', 16, 11],
          'symbol-sort-key': ['coalesce', ['get', 'rank'], 99],
        },
      }),
    ],
  };
}
