import { snapDisruptionLocation } from './adaptive-model.js';
import { buildEdgeGeometryCache, createAdaptiveMapRenderer, samplePolylineAt } from './adaptive-map-renderer.js';
import { buildingLayers, colors, mapStyle } from './map-style.js';

const { navy, blue, orange, copper, slate, white } = colors;
const collection = (features = []) => ({ type: 'FeatureCollection', features });
const feature = (type, coordinates, properties = {}) => ({
  type: 'Feature', geometry: { type, coordinates }, properties,
});
const point = (location, properties) => feature('Point', [location.lon, location.lat], properties);
const paintState = (key, fallback) => ['coalesce', ['feature-state', key], fallback];
const trafficColor = ['interpolate', ['linear'], paintState('load', 0), 0, blue, 0.5, copper, 0.85, orange];
const visibleLayers = {
  gaussian: ['gaussian'], signals: ['signals'], transit: ['transit'],
  coverage: ['coverage'], labels: ['landmarks', 'landmark-labels'], buildings: buildingLayers,
};

function overlayLayers(map) {
  function add(id, type, source, paint, layout = {}) {
    if (!map.getSource(source)) {
      const options = source === 'roads' || source === 'signals' ? { promoteId: 'featureId' } : {};
      map.addSource(source, { type: 'geojson', data: collection(), ...options });
    }
    map.addLayer({ id, type, source, paint, layout });
  }
  const offset = ['case', ['get', 'oneway'], 0, -2];
  const rounded = { 'line-cap': 'round', 'line-join': 'round' };
  add('coverage', 'fill', 'coverage', { 'fill-color': blue, 'fill-opacity': 0.06, 'fill-outline-color': blue });
  add('boundary', 'line', 'boundary', { 'line-color': navy, 'line-opacity': 0.42, 'line-dasharray': [4, 3] });
  add('gaussian', 'fill', 'gaussian', {
    'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'opacity'],
  });
  add('selected-route', 'line', 'selected-route', {
    'line-color': orange, 'line-opacity': 0.55, 'line-width': 6,
  }, rounded);
  add('road-focus', 'line', 'roads', {
    'line-color': ['case', paintState('selected', false), orange, navy],
    'line-opacity': ['case', paintState('selected', false), 0.75, paintState('hover', false), 0.65, 0],
    'line-offset': offset, 'line-width': 8,
  }, rounded);
  add('road-surface', 'line', 'roads', {
    'line-color': trafficColor, 'line-opacity': ['case', paintState('blocked', false), 0.22, 0.86],
    'line-offset': offset, 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.3, 17, 3.4],
  }, rounded);
  add('road-blocked', 'line', 'roads', {
    'line-color': ['case', paintState('closed', false), navy, orange],
    'line-opacity': ['case', paintState('blocked', false), 1, 0],
    'line-offset': offset, 'line-width': 2.5, 'line-dasharray': [2, 2],
  });
  add('eligible', 'line', 'eligible', { 'line-color': orange, 'line-width': 6, 'line-opacity': 0.35 }, rounded);
  add('queues', 'line', 'queues', { 'line-color': orange, 'line-width': 4, 'line-offset': offset }, rounded);
  add('vehicles', 'circle', 'vehicles', {
    'circle-color': white, 'circle-radius': 1.7, 'circle-stroke-color': blue, 'circle-stroke-width': 0.65,
  });
  add('signals', 'circle', 'signals', {
    'circle-color': ['case', paintState('phase', false), copper, navy],
    'circle-radius': ['case', ['get', 'signalized'], 3.3, 2],
    'circle-stroke-width': 1, 'circle-stroke-color': white,
  });
  add('transit', 'circle', 'transit', {
    'circle-color': blue, 'circle-radius': ['case', ['==', ['get', 'mode'], 'bus_stop'], 3, 5],
    'circle-stroke-color': white, 'circle-stroke-width': 1.5,
  });
  add('landmarks', 'circle', 'landmarks', {
    'circle-color': navy, 'circle-radius': 4, 'circle-stroke-color': white, 'circle-stroke-width': 1.5,
  });
  add('landmark-labels', 'symbol', 'landmarks', {
    'text-color': navy, 'text-halo-color': white, 'text-halo-width': 1.5,
  }, {
    'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11,
    'text-offset': [0, 0.7], 'text-anchor': 'top',
  });
  add('disruptions', 'circle', 'disruptions', {
    'circle-color': ['get', 'color'], 'circle-radius': ['case', ['get', 'pending'], 8, 6],
    'circle-stroke-color': white, 'circle-stroke-width': 2,
  });
}

function gaussianRings(zone, color) {
  // Disjoint annuli sample the same radial intensity model as the scenario.
  const steps = 8;
  const circle = radius => Array.from({ length: 41 }, (_, index) => {
    const angle = (index % 40) / 40 * Math.PI * 2;
    return [
      zone.lon + Math.cos(angle) * radius / (111320 * Math.cos(zone.lat * Math.PI / 180)),
      zone.lat + Math.sin(angle) * radius / 110574,
    ];
  });
  const sigma = zone.sigma_m || 400;
  return Array.from({ length: steps }, (_, index) => {
    const outer = circle(sigma * (index + 1) * 0.3);
    const inner = index ? [circle(sigma * index * 0.3).reverse()] : [];
    return feature('Polygon', [outer, ...inner], {
      color, opacity: 0.33 * zone.intensity * Math.exp(-0.5 * ((index + 0.5) * 0.3) ** 2),
    });
  });
}

export function createGeospatialRenderer(container, callbacks) {
  // Preserve the local visualization when the CDN or WebGL is unavailable.
  let map;
  try {
    map = new window.maplibregl.Map({
      container, style: mapStyle(), center: [106.7968, -6.1172], zoom: 13,
      maxPitch: 65, attributionControl: { compact: true },
    });
  } catch {
    container.replaceChildren();
    container.classList.remove('maplibregl-map');
    callbacks.onMapStatus?.('2D fallback Ãƒâ€šÃ‚Â· 3D map unavailable');
    return createAdaptiveMapRenderer(container, callbacks);
  }

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const resizeObserver = new ResizeObserver(() => map.resize());
  resizeObserver.observe(container);
  let ready = false;
  let region;
  let simulation;
  let frameIndex = 0;
  let playing = true;
  let speed = 1;
  let placement;
  let pending;
  let hover;
  let selected;
  let camera = '3d';
  let layerState = {};
  let edges = new Map();
  let geometries = [];
  const flowProgress = new Map();
  let lastTick = performance.now();

  function data(source, features) {
    map.getSource(source)?.setData(collection(features));
  }

  function activeFrame() {
    return simulation?.frames?.[frameIndex];
  }

  function roadState(id, values) {
    if (ready && id != null) map.setFeatureState({ source: 'roads', id }, values);
  }

  function updateLayers() {
    if (!ready) return;
    for (const [name, ids] of Object.entries(visibleLayers)) {
      for (const id of ids) map.setLayoutProperty(id, 'visibility', layerState[name] === false ? 'none' : 'visible');
    }
  }

  function updateDisruptions() {
    if (!ready) return;
    const rings = [];
    const markers = [];
    for (const [key, name, color] of [
      ['flood', 'Flood centre', blue], ['demonstration', 'Demonstration centre', orange],
    ]) {
      const zone = simulation?.disruptions?.[key];
      if (!zone?.enabled || !Number.isFinite(zone.lat) || !Number.isFinite(zone.lon)) continue;
      markers.push(point(zone, { name, kind: 'Synthetic disruption', color, pending: false }));
      rings.push(...gaussianRings(zone, color));
    }
    if (pending) markers.push(point({ lat: pending.snapped_lat, lon: pending.snapped_lon }, {
      name: pending.snapped_road_name, kind: 'Pending disruption', color: orange, pending: true,
    }));
    data('disruptions', markers);
    data('gaussian', rings);
    data('eligible', placement && region ? region.edges.filter(edge => edge[placement + '_eligible'])
      .map(edge => feature('LineString', edge.coordinates)) : []);
  }

  function updateFrame() {
    if (!ready || !region) return;
    const frame = activeFrame();
    const queues = [];
    for (const geom of geometries) {
      const { edge, coords, cumDist, totalDeg } = geom;
      const state = frame?.edge_states?.[edge.edge_id];
      roadState(edge.edge_id, {
        load: state?.congestion_index ?? 0,
        closed: Boolean(state?.closed),
        blocked: Boolean(state?.closed || state?.access_restricted),
      });
      if (state?.occupancy >= 0.45 && !state.closed) {
        const start = 1 - Math.min(0.85, state.occupancy * 0.78);
        const p = samplePolylineAt(geom, start);
        queues.push(feature('LineString', [[p.lon, p.lat],
          ...coords.filter((_, index) => cumDist[index] > start * totalDeg)], { oneway: edge.oneway }));
      }
    }
    data('queues', queues);
    for (const signal of region.intersections) {
      map.setFeatureState({ source: 'signals', id: signal.node_id }, {
        phase: Boolean(frame?.intersection_states?.[signal.node_id]?.phase),
      });
    }
    if (selected) callbacks.onEdgeClick?.(edges.get(selected), frame?.edge_states?.[selected]);
  }

  function updateRegion() {
    if (!ready || !region) return;
    map.removeFeatureState({ source: 'roads' });
    data('roads', geometries.map(({ edge, coords }) =>
      feature('LineString', coords, { oneway: edge.oneway, featureId: edge.edge_id })));
    data('boundary', [feature('LineString', region.study_boundary, { name: region.name, kind: 'Study area' })]);
    data('coverage', [feature('Polygon', [region.coverage_mask], { name: region.name, kind: 'Study coverage' })]);
    data('signals', region.intersections.filter(inter => inter.signalized || inter.degree >= 4)
      .map(inter => point(inter, {
        name: inter.name || inter.node_id, kind: inter.signalized ? 'Traffic signal' : 'Intersection',
        signalized: inter.signalized, featureId: inter.node_id,
      })));
    data('transit', region.transit_stops.map(stop => point(stop, { name: stop.name, kind: 'Transit stop', mode: stop.mode })));
    data('landmarks', region.landmarks.map(landmark => point(landmark, { name: landmark.name, kind: 'Landmark' })));
    data('vehicles', []);
    if (selected) selectEdge(selected);
    else data('selected-route', []);
    updateFrame();
    updateDisruptions();
  }

  function setCamera(mode, duration = 500) {
    camera = mode;
    if (!region) return;
    const pitch = mode === '3d' ? 48 : 0;
    const bearing = mode === '3d' ? -18 : 0;
    const motion = reducedMotion.matches ? 0 : duration;
    if (mode === 'overview') {
      map.fitBounds([[106.77, -6.31], [106.84, -6.095]], { padding: 32, duration: motion, pitch, bearing });
      return;
    }
    const { west, south, east, north } = region.bbox;
    const padding = Math.min(46, container.clientWidth / 8);
    if (mode === '3d') {
      const flat = map.cameraForBounds([[west, south], [east, north]], { padding });
      if (!flat) return;
      map.easeTo({ center: flat.center, zoom: Math.max(14.15, flat.zoom + 0.6), pitch, bearing, duration: motion });
    } else {
      map.fitBounds([[west, south], [east, north]], { padding, duration: motion, pitch, bearing });
    }
  }

  function rendered(point, layers, radius = 5) {
    return map.queryRenderedFeatures(
      [[point.x - radius, point.y - radius], [point.x + radius, point.y + radius]], { layers },
    )[0];
  }

  function selectEdge(id) {
    roadState(selected, { selected: false });
    selected = edges.has(id) ? id : null;
    roadState(selected, { selected: true });
    const edge = edges.get(selected);
    data('selected-route', edge ? geometries.filter(item => item.edge.osm_way_id === edge.osm_way_id)
      .map(item => feature('LineString', item.coords)) : []);
    if (edge) callbacks.onEdgeClick?.(edge, activeFrame()?.edge_states?.[selected]);
  }

  map.on('mousemove', event => {
    if (!ready || !region || map.isMoving()) return;
    const hit = rendered(event.point, ['road-surface']);
    const id = hit?.properties.featureId;
    if (id !== hover) {
      roadState(hover, { hover: false });
      hover = id;
      roadState(hover, { hover: true });
    }
    const { lat, lng: lon } = event.lngLat;
    const nearby = hit || rendered(event.point, ['transit', 'landmarks', 'signals', 'disruptions']);
    map.getCanvas().style.cursor = placement ? 'crosshair' : nearby ? 'pointer' : 'grab';
    callbacks.onHover?.({ edge: edges.get(id), edgeState: activeFrame()?.edge_states?.[id], lat, lon });
  });
  map.getCanvas().addEventListener('mouseleave', () => {
    roadState(hover, { hover: false });
    hover = null;
  });

  map.on('click', event => {
    if (!ready || !region) return;
    const { lat, lng } = event.lngLat;
    if (placement) {
      const snap = snapDisruptionLocation(region, lat, lng, placement, 200);
      pending = snap.accepted ? snap : null;
      updateDisruptions();
      if (pending) callbacks.onSnapAccepted?.(snap);
      else callbacks.onSnapRejected?.(snap);
      return;
    }
    const marker = rendered(event.point, ['disruptions', 'landmarks', 'transit', 'signals'], 4);
    const road = rendered(event.point, ['road-surface']);
    if (!marker && road) {
      selectEdge(road.properties.featureId);
      return;
    }
    selectEdge(null);
    const area = marker || rendered(event.point, ['boundary', 'coverage'], 0);
    callbacks.onFeatureClick?.(area?.properties);
  });

  map.on('error', () => callbacks.onMapStatus?.('Some map tiles or resources are unavailable'));
  map.once('style.load', () => {
    overlayLayers(map);
    ready = true;
    updateRegion();
    updateLayers();
    callbacks.onMapReady?.();
  });

  const ticker = setInterval(() => {
    const now = performance.now();
    const delta = Math.min(0.15, (now - lastTick) / 1000);
    lastTick = now;
    if (!ready || !playing || reducedMotion.matches || document.hidden) return;
    const states = activeFrame()?.edge_states;
    const bounds = map.getBounds();
    const vehicles = [];
    for (const geom of geometries) {
      const { edge } = geom;
      const state = states?.[edge.edge_id];
      if (state?.closed) continue;
      const metersPerSecond = (state?.speed_kmh ?? edge.speed_limit_kmh * 0.78) / 3.6;
      const index = Number(edge.edge_id.slice(-4));
      const progress = flowProgress.get(edge.edge_id) ?? (index * 0.17) % 1;
      const fraction = (progress + delta * speed * metersPerSecond / Math.max(25, edge.length_m)) % 1;
      flowProgress.set(edge.edge_id, fraction);
      const location = samplePolylineAt(geom, fraction);
      if (bounds.contains([location.lon, location.lat])) vehicles.push(point(location, {}));
    }
    data('vehicles', vehicles);
  }, 50);

  function syncMotion() {
    if (reducedMotion.matches) data('vehicles', []);
  }
  reducedMotion.addEventListener('change', syncMotion);

  return {
    setRegion(nextRegion) {
      region = nextRegion;
      simulation = null;
      pending = null;
      hover = null;
      selected = null;
      flowProgress.clear();
      geometries = buildEdgeGeometryCache(region).filter(geom => geom.coords.length > 1);
      edges = new Map(geometries.map(({ edge }) => [edge.edge_id, edge]));
      updateRegion();
      setCamera(camera === 'overview' ? '3d' : camera);
    },
    setSimulation(result, index) {
      simulation = result;
      flowProgress.clear();
      this.setFrameIndex(index);
      updateDisruptions();
    },
    setFrameIndex(index = 0) { frameIndex = index; updateFrame(); },
    setPlayback(isPlaying, playbackSpeed) { playing = isPlaying; speed = playbackSpeed; },
    setLayers(next) { layerState = { ...layerState, ...next }; updateLayers(); },
    setDisruptionPlacementMode(mode) {
      placement = mode;
      if (!mode) pending = null;
      map.getCanvas().style.cursor = mode ? 'crosshair' : 'grab';
      updateDisruptions();
    },
    clearPendingSnap() { pending = null; updateDisruptions(); },
    zoomIn() { map.zoomIn({ duration: reducedMotion.matches ? 0 : 250 }); },
    zoomOut() { map.zoomOut({ duration: reducedMotion.matches ? 0 : 250 }); },
    resetView() { setCamera('3d'); },
    setCamera,
    getCamera() { return camera; },
    focusLocation(location) {
      map.flyTo({
        center: [location.lon, location.lat], zoom: Math.max(15.5, map.getZoom()),
        duration: reducedMotion.matches ? 0 : 650,
      });
      selectEdge(location.edge?.edge_id);
      if (!location.edge) callbacks.onFeatureClick?.(location);
    },
    clearSelection() { selectEdge(null); },
    getRenderEngine() { return 'MapLibre GL JS'; },
    destroy() {
      clearInterval(ticker);
      reducedMotion.removeEventListener('change', syncMotion);
      resizeObserver.disconnect();
      map.remove();
    },
  };
}
