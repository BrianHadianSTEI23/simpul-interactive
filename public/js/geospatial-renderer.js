import { isCongested, snapDisruptionLocation } from './adaptive-model.js';
import { buildEdgeGeometryCache, createAdaptiveMapRenderer, samplePolylineAt } from './adaptive-map-renderer.js';
import { colors, mapStyle } from './map-style.js';

const { navy, blue, orange, copper, slate, white } = colors;
const collection = (features = []) => ({ type: 'FeatureCollection', features });
const feature = (type, coordinates, properties = {}) => ({
  type: 'Feature', geometry: { type, coordinates }, properties,
});
const point = (location, properties) => feature('Point', [location.lon, location.lat], properties);
const paintState = (key, fallback) => ['coalesce', ['feature-state', key], fallback];
const trafficColor = ['interpolate', ['linear'], paintState('load', 0), 0, blue, 0.4, copper, 0.65, orange, 0.85, '#B92732'];
const visibleLayers = {
  vehicles: ['vehicles', 'queued-vehicles'],
  signage: ['signage', 'turn-events', 'turn-routes'],
  gaussian: ['gaussian'], signals: ['signals'], transit: ['transit', 'station-labels'],
  coverage: ['coverage', 'boundary'], labels: ['landmarks', 'landmark-labels', 'connector-labels'],
};

function escHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function addSignageIcon(map, id, arrowText, bgColor, borderColor, textColor = '#FFFFFF') {
  const canvas = document.createElement('canvas');
  canvas.width = 40;
  canvas.height = 40;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.roundRect(4, 4, 32, 32, 8);
  ctx.fillStyle = bgColor;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = borderColor;
  ctx.stroke();
  ctx.fillStyle = textColor;
  ctx.font = 'bold 20px "Noto Sans", "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(arrowText, 20, 21);
  map.addImage(id, ctx.getImageData(0, 0, 40, 40), { pixelRatio: 2 });
}

function addVehicleIcon(map, id, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 48;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.roundRect(5, 3, 22, 42, 7);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = white;
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.fillStyle = white;
  ctx.fillRect(10, 12, 12, 5);
  ctx.fillRect(11, 31, 10, 3);
  map.addImage(id, ctx.getImageData(0, 0, 32, 48), { pixelRatio: 2 });
}

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
  add('connectors-halo', 'line', 'connectors', {
    'line-color': blue, 'line-opacity': 0.24, 'line-width': ['interpolate', ['linear'], ['zoom'], 10.5, 6, 15, 11],
  }, rounded);
  add('connectors-guide', 'line', 'connectors', {
    'line-color': blue, 'line-opacity': 0.52, 'line-width': ['interpolate', ['linear'], ['zoom'], 10.5, 2, 15, 3],
    'line-dasharray': [2, 2],
  });
  add('road-focus', 'line', 'roads', {
    'line-color': ['case', paintState('selected', false), orange, navy],
    'line-opacity': ['case', paintState('selected', false), 0.75, paintState('hover', false), 0.65, 0],
    'line-offset': offset, 'line-width': 8,
  }, rounded);
  add('congestion-casing', 'line', 'roads', {
    'line-color': navy,
    'line-opacity': ['case', paintState('congested', false), 0.85, 0],
    'line-width': ['interpolate', ['linear'], ['zoom'], 11, 5, 17, 10],
    'line-offset': offset,
  }, rounded);
  add('road-surface', 'line', 'roads', {
    'line-color': ['case', ['>=', paintState('load', 0), 0.8], '#B92732', paintState('congested', false), orange, trafficColor], 'line-opacity': ['case', paintState('blocked', false), 0.22, 0.86],
    'line-offset': offset, 'line-width': ['interpolate', ['linear'], ['zoom'],
      11, ['case', paintState('congested', false), 3, 1.3],
      17, ['case', paintState('congested', false), 6, 3.4]],
  }, rounded);
  add('road-blocked', 'line', 'roads', {
    'line-color': ['case', paintState('closed', false), navy, orange],
    'line-opacity': ['case', paintState('blocked', false), 1, 0],
    'line-offset': offset, 'line-width': 2.5, 'line-dasharray': [2, 2],
  });
  add('eligible', 'line', 'eligible', { 'line-color': orange, 'line-width': 6, 'line-opacity': 0.35 }, rounded);
  add('queues', 'line', 'queues', { 'line-color': orange, 'line-width': 4, 'line-offset': offset }, rounded);
  add('transit', 'circle', 'transit', {
    'circle-color': blue, 'circle-radius': ['case', ['==', ['get', 'mode'], 'bus_stop'], 3, 7],
    'circle-stroke-color': white, 'circle-stroke-width': 1.5,
  });
  add('station-labels', 'symbol', 'transit', {
    'text-color': navy, 'text-halo-color': white, 'text-halo-width': 1.8,
  }, {
    'text-field': ['case', ['==', ['get', 'mode'], 'bus_stop'], '', ['get', 'name']],
    'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-anchor': 'top', 'text-offset': [0, 0.8],
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
  addVehicleIcon(map, 'vehicle-moving', navy);
  addVehicleIcon(map, 'vehicle-queued', orange);
  add('vehicles', 'symbol', 'vehicles', {}, {
    'icon-image': 'vehicle-moving',
    'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.36, 15, 0.74, 17, 0.95],
    'icon-padding': 0,
    'icon-allow-overlap': ['step', ['zoom'], false, 15.5, true],
    'icon-ignore-placement': true,
    'icon-rotate': ['get', 'bearing'],
    'icon-rotation-alignment': 'map',
    'icon-pitch-alignment': 'viewport',
  });
  add('queued-vehicles', 'symbol', 'queued-vehicles', {}, {
    'icon-image': 'vehicle-queued',
    'icon-size': ['interpolate', ['linear'], ['zoom'], 13, 0.5, 16, 0.64, 19, 0.84],
    'icon-allow-overlap': true,
    'icon-ignore-placement': true,
    'icon-rotate': ['get', 'bearing'],
    'icon-rotation-alignment': 'map',
    'icon-pitch-alignment': 'viewport',
  });
  map.setLayerZoomRange('queued-vehicles', 13, 24);
  add('turn-routes', 'line', 'turn-routes', {
    'line-color': ['case', ['==', ['get', 'action'], 'blocked'], '#B92732', blue],
    'line-width': 4, 'line-dasharray': [2, 1],
  }, rounded);
  add('turn-events', 'symbol', 'turn-events', {
    'text-color': ['case', ['==', ['get', 'action'], 'blocked'], '#B92732', blue],
    'text-halo-color': white, 'text-halo-width': 2,
  }, {
    'text-field': ['case', ['==', ['get', 'action'], 'blocked'], '×', '↱'],
    'text-font': ['Noto Sans Regular'], 'text-size': 20, 'text-allow-overlap': true,
  });
  add('signals', 'circle', 'signals', {
    'circle-color': ['match', ['get', 'light'], 'green', '#06733E', 'yellow', '#F2BA00', 'red', '#B92732', slate],
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 3, 16, 6],
    'circle-stroke-width': 2, 'circle-stroke-color': white,
  });
  for (const [dirCode, glyph] of [['lurus', '↑'], ['belok_kiri', '↰'], ['belok_kanan', '↱'], ['putar_balik', '↺']]) {
    addSignageIcon(map, `sign-${dirCode}-optimal`, glyph, blue, white);
    addSignageIcon(map, `sign-${dirCode}-diverted`, glyph, orange, white);
  }
  addSignageIcon(map, 'sign-blocked', '✕', '#B92732', white);
  addSignageIcon(map, 'sign-passive', '⇄', slate, '#CBD5E1');
  add('signage', 'symbol', 'signage', {}, {
    'icon-image': ['get', 'icon'],
    'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.72, 13.5, 0.88, 16, 1.12],
    'icon-allow-overlap': ['step', ['zoom'], false, 14.2, true],
    'icon-ignore-placement': false,
    'symbol-sort-key': ['get', 'priority'],
  });
  add('connector-labels', 'symbol', 'connector-labels', {
    'text-color': navy, 'text-halo-color': white, 'text-halo-width': 2,
  }, {
    'text-field': ['get', 'name'],
    'text-font': ['Noto Sans Regular'],
    'text-size': ['interpolate', ['linear'], ['zoom'], 11, 10, 14, 12],
    'text-max-width': 12,
    'text-allow-overlap': false,
  });
  add('hotspots', 'symbol', 'hotspots', {
    'text-color': navy, 'text-halo-color': white, 'text-halo-width': 2,
  }, {
    'text-field': ['get', 'kind'], 'text-font': ['Noto Sans Regular'],
    'text-size': 12, 'text-offset': [0, -0.75], 'text-anchor': 'bottom',
    'symbol-sort-key': ['get', 'priority'],
  });
  add('disruptions', 'circle', 'disruptions', {
    'circle-color': ['get', 'color'], 'circle-radius': ['case', ['get', 'pending'], 10, 8],
    'circle-stroke-color': white, 'circle-stroke-width': 2,
  });
  add('disruption-labels', 'symbol', 'disruptions', {
    'text-color': navy, 'text-halo-color': white, 'text-halo-width': 2.5,
  }, {
    'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'],
    'text-size': 13, 'text-offset': [0, -0.85], 'text-anchor': 'bottom',
    'text-allow-overlap': true,
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
    callbacks.onMapStatus?.('2D fallback: 3D map unavailable');
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
  let camera = '2d';
  let layerState = {};
  let edges = new Map();
  let geometries = [];
  let geometryById = new Map();
  let signageByInterId = new Map();
  let focusBbox = null;
  let hoveredSignage = null;
  const signagePopup = new window.maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    className: 'atn-signage-popup-wrap',
    offset: 14,
    maxWidth: '280px',
  });
  let clearanceTimer;
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
      ['flood', 'Flood event', blue], ['demonstration', 'Demonstration event', orange],
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
    const hotspots = [];
    const counts = { congestion: 0, closed: 0, restricted: 0 };
    const labelledWays = new Set();
    for (const geom of geometries) {
      const { edge, coords, cumDist, totalDeg } = geom;
      const state = frame?.edge_states?.[edge.edge_id];
      const closed = Boolean(state?.closed);
      const restricted = Boolean(state?.access_restricted);
      const congested = isCongested(state);
      if (closed) counts.closed++;
      if (restricted && !closed) counts.restricted++;
      if (congested) counts.congestion++;
      if ((closed || restricted || (congested && state.congestion_index >= 0.8)) && !labelledWays.has(edge.osm_way_id)) {
        labelledWays.add(edge.osm_way_id);
        hotspots.push(point(samplePolylineAt(geom, 0.55), {
          kind: closed ? 'Closed' : congested ? 'Congestion' : 'Restricted',
          priority: closed ? 0 : congested ? 1 : 2, featureId: edge.edge_id,
        }));
      }
      roadState(edge.edge_id, {
        congested,
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
    data('hotspots', hotspots);
    callbacks.onTrafficEvents?.(frame ? counts : null);
    drawQueues();
    if (!playing || reducedMotion.matches) drawVehicles(0);
    clearTimeout(clearanceTimer);
    drawSignals(playing);
    if (playing && Object.values(frame?.intersection_states ?? {}).some(signal => signal.phase_changed)) {
      clearanceTimer = setTimeout(() => drawSignals(false), Math.max(80, 160 / speed));
    }
    const paths = [];
    const markers = [];
    for (const turn of Object.values(frame?.turn_actions ?? {})) {
      const from = geometryById.get(turn.from_edge);
      const to = geometryById.get(turn.to_edge);
      if (!from || !to) continue;
      const start = samplePolylineAt(from, Math.max(0.25, 1 - 25 / from.edge.length_m));
      const end = samplePolylineAt(to, Math.min(0.75, 25 / to.edge.length_m));
      const center = from.coords.at(-1);
      const name = turn.action === 'blocked' ? 'Blocked turn' : 'Diverted turn';
      const properties = {
        action: turn.action, name, kind: 'Junction control',
        detail: from.edge.name + ' → ' + to.edge.name,
      };
      paths.push(feature('LineString', [[start.lon, start.lat], center, [end.lon, end.lat]], properties));
      markers.push(point(end, properties));
    }
    data('turn-routes', paths);
    data('turn-events', markers);

    const signageFeatures = [];
    const sNodes = simulation?.signage_nodes || region.signage_nodes || [];
    const sigMap = frame?.signage_states || {};
    for (const snode of sNodes) {
      const nid = snode.intersection_id;
      const st = sigMap[nid];
      if (!st) continue;
      let icon = 'sign-passive';
      let priority = 3;
      if (st.mode === 'blocked') {
        icon = 'sign-blocked';
        priority = 0;
      } else if (st.mode === 'diverted') {
        icon = `sign-${st.primary_dir || 'lurus'}-diverted`;
        priority = snode.is_connector_hub || snode.is_gateway ? 0 : 1;
      } else if (st.mode === 'optimal') {
        icon = `sign-${st.primary_dir || 'lurus'}-optimal`;
        priority = snode.is_connector_hub || snode.is_gateway ? 1 : 2;
      } else if (snode.is_connector_hub || snode.is_gateway) {
        priority = 1;
      }
      signageFeatures.push(point(snode, {
        intersection_id: nid,
        name: snode.name,
        icon,
        mode: st.mode,
        priority,
        headline: st.headline,
        kind: 'Dynamic VMS Signage',
      }));
    }
    data('signage', signageFeatures);
    refreshHoveredSignagePopup();
    if (selected) callbacks.onEdgeClick?.(edges.get(selected), frame?.edge_states?.[selected]);
  }

  function renderSignagePopupHTML(hoverTarget, frame) {
    const nid = hoverTarget.intersection_id;
    const snode = signageByInterId.get(nid);
    const sig = frame?.signage_states?.[nid];
    const ctrlMap = { fixed_time: 'B1 Fixed-Time', max_pressure: 'B2 Max-Pressure', gnn_mappo: 'B3 SIMPUL MGN' };
    const ctrlLabel = ctrlMap[simulation?.controller] || 'Controller';
    const tSec = frame?.t_sec ?? 0;

    if (!sig) {
      const light = hoverTarget.light || 'unknown';
      const lightLabel = light === 'green' ? 'HIJAU' : light === 'yellow' ? 'KUNING' : light === 'red' ? 'MERAH' : 'PASIF';
      return `<div class="atn-vms-card">
        <div class="atn-vms-top">
          <div class="atn-vms-title">${escHtml(hoverTarget.name || 'Sinyal Simpang')}</div>
          <span class="atn-vms-light ${escHtml(light)}">${escHtml(lightLabel)}</span>
        </div>
        <div class="atn-vms-sub">${escHtml(ctrlLabel)} · t = ${tSec}s</div>
        <div class="atn-vms-reason">${escHtml(hoverTarget.detail || 'Kondisi sinyal persimpangan aktif')}</div>
      </div>`;
    }

    const light = sig.light || 'uncontrolled';
    const lightText = light === 'green'
      ? `HIJAU${sig.green_s ? ` ${sig.green_s}s` : ''}`
      : light === 'yellow'
        ? 'KUNING'
        : light === 'red'
          ? 'MERAH'
          : 'RAMBU ARAH';

    const turnsHtml = (sig.turns || []).map(t => `
      <div class="atn-vms-turn ${t.blocked ? 'blocked' : ''}">
        <span class="atn-vms-turn-lbl"><b>${escHtml(t.arrow)} ${escHtml(t.dir_label)}</b> → ${escHtml(t.to_name)}</span>
        <span class="atn-vms-turn-pct">${t.blocked ? 'TUTUP' : `${t.pct}% · ${Math.round(t.speed_kmh)} km/j`}</span>
      </div>
    `).join('');

    return `<div class="atn-vms-card">
      <div class="atn-vms-top">
        <div class="atn-vms-title">${escHtml(snode?.name || sig.from_name || 'Simpang VMS')}</div>
        <span class="atn-vms-light ${escHtml(light)}">${escHtml(lightText)}</span>
      </div>
      <div class="atn-vms-sub">Dari: ${escHtml(sig.from_name)} · ${escHtml(ctrlLabel)} · t = ${tSec}s</div>
      <div class="atn-vms-directive" data-mode="${escHtml(sig.mode || 'optimal')}">${escHtml(sig.headline)}</div>
      <div class="atn-vms-reason">${escHtml(sig.reason)}</div>
      ${turnsHtml ? `<div class="atn-vms-turns">${turnsHtml}</div>` : ''}
    </div>`;
  }

  function refreshHoveredSignagePopup() {
    if (!ready || !hoveredSignage) {
      signagePopup.remove();
      return;
    }
    const html = renderSignagePopupHTML(hoveredSignage, activeFrame());
    signagePopup.setLngLat(hoveredSignage.lngLat).setHTML(html);
    if (!signagePopup.isOpen()) signagePopup.addTo(map);
  }

  function drawSignals(clearance) {
    if (!ready || !region) return;
    const signals = activeFrame()?.intersection_states ?? {};
    data('signals', region.intersections.filter(inter => inter.signalized).flatMap(inter => {
      const decision = signals[inter.node_id];
      return inter.incoming_edges.flatMap(id => {
        const geom = geometryById.get(id);
        if (!geom) return [];
        const location = samplePolylineAt(geom, Math.max(0.15, 1 - 16 / geom.edge.length_m));
        const green = decision?.green_edges?.includes(id);
        const light = !decision?.green_edges ? 'unknown'
          : clearance && decision.phase_changed && decision.yellow_edges?.includes(id) ? 'yellow'
          : clearance && decision.phase_changed ? 'red'
          : green ? 'green' : 'red';
        return [point(location, {
          light, intersection_id: inter.node_id, name: geom.edge.name, kind: 'Traffic signal',
          detail: light === 'unknown' ? 'Signal phase unavailable' : `Sinyal ${light.toUpperCase()} di ${geom.edge.name}`,
        })];
      });
    }));
  }

  function updateRegion() {
    if (!ready || !region) return;
    map.removeFeatureState({ source: 'roads' });
    data('roads', geometries.map(({ edge, coords }) =>
      feature('LineString', coords, { oneway: edge.oneway, featureId: edge.edge_id })));
    const connectorGeoms = geometries.filter(({ edge }) => edge.is_inter_region_connector);
    data('connectors', connectorGeoms.map(({ edge, coords }) =>
      feature('LineString', coords, { name: edge.name, corridor_pair: edge.corridor_pair || 'inter_region' })));
    const labelSeen = new Set();
    const connectorLabels = [];
    for (const geom of connectorGeoms) {
      const key = `${geom.edge.osm_way_id || geom.edge.name}`;
      if (labelSeen.has(key) || !geom.edge.name) continue;
      labelSeen.add(key);
      if (geom.edge.osm_way_id?.endsWith('-2') || geom.edge.osm_way_id?.startsWith('conn-x')) {
        const shortLabel = geom.edge.name.replace(/\s*\([^)]*\)/g, '');
        connectorLabels.push(point(samplePolylineAt(geom, 0.5), { name: shortLabel }));
      }
    }
    data('connector-labels', connectorLabels);
    const boundsList = Array.isArray(region.study_boundaries) && region.study_boundaries.length
      ? region.study_boundaries.map(b => feature('LineString', b.ring, { name: b.name, kind: 'Study area' }))
      : [feature('LineString', region.study_boundary, { name: region.name, kind: 'Study area' })];
    const maskList = Array.isArray(region.coverage_masks) && region.coverage_masks.length
      ? region.coverage_masks.map(m => feature('Polygon', [m.ring], { name: m.name, kind: 'Study coverage' }))
      : [feature('Polygon', [region.coverage_mask], { name: region.name, kind: 'Study coverage' })];
    data('boundary', boundsList);
    data('coverage', maskList);
    data('transit', region.transit_stops.map(stop => point(stop, { name: stop.name, kind: stop.mode === 'bus_stop' ? 'Transit stop' : 'Activity hotspot · station', mode: stop.mode })));
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
    const pitch = mode === '3d' ? 32 : 0;
    const bearing = mode === '3d' ? -18 : 0;
    const motion = reducedMotion.matches ? 0 : duration;
    if (mode === 'overview') {
      const b = region.bbox;
      map.fitBounds([[b.west, b.south], [b.east, b.north]], { padding: 36, duration: motion, pitch, bearing });
      return;
    }
    const { west, south, east, north } = focusBbox || region.bbox;
    const padding = Math.min(46, container.clientWidth / 8);
    if (mode === '3d') {
      const flat = map.cameraForBounds([[west, south], [east, north]], { padding });
      if (!flat) return;
      map.easeTo({ center: flat.center, zoom: Math.max(13.6, flat.zoom + 0.65), pitch, bearing, duration: motion });
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
    const signageHit = rendered(event.point, ['signage', 'turn-events', 'signals'], 10);
    if (!placement && signageHit?.properties?.intersection_id) {
      const coords = signageHit.geometry?.coordinates;
      hoveredSignage = {
        intersection_id: signageHit.properties.intersection_id,
        name: signageHit.properties.name,
        light: signageHit.properties.light,
        detail: signageHit.properties.detail,
        lngLat: Array.isArray(coords) && coords.length >= 2 ? coords : [event.lngLat.lng, event.lngLat.lat],
      };
      refreshHoveredSignagePopup();
    } else if (hoveredSignage) {
      hoveredSignage = null;
      refreshHoveredSignagePopup();
    }

    const hit = rendered(event.point, ['road-surface']);
    const id = hit?.properties.featureId;
    if (id !== hover) {
      roadState(hover, { hover: false });
      hover = id;
      roadState(hover, { hover: true });
    }
    const { lat, lng: lon } = event.lngLat;
    const nearby = signageHit || hit || rendered(event.point, ['transit', 'landmarks', 'disruptions', 'disruption-labels', 'hotspots', 'turn-routes']);
    map.getCanvas().style.cursor = placement ? 'crosshair' : nearby ? 'pointer' : 'grab';
    const frame = activeFrame();
    const hovSig = hoveredSignage ? frame?.signage_states?.[hoveredSignage.intersection_id] : null;
    callbacks.onHover?.({
      edge: edges.get(id),
      edgeState: frame?.edge_states?.[id],
      signage: hovSig,
      signageName: hoveredSignage?.name,
      lat,
      lon,
    });
  });
  map.getCanvas().addEventListener('mouseleave', () => {
    roadState(hover, { hover: false });
    hover = null;
    hoveredSignage = null;
    refreshHoveredSignagePopup();
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
    const signHit = rendered(event.point, ['signage'], 8);
    if (signHit?.properties?.intersection_id) {
      const sig = activeFrame()?.signage_states?.[signHit.properties.intersection_id];
      const snode = signageByInterId.get(signHit.properties.intersection_id);
      selectEdge(null);
      callbacks.onFeatureClick?.({
        kind: 'Dynamic VMS Signage',
        name: snode?.name || signHit.properties.name,
        detail: sig ? `${sig.headline} — ${sig.reason}` : signHit.properties.headline,
      });
      return;
    }
    const incident = rendered(event.point, ['disruptions', 'disruption-labels', 'hotspots', 'turn-events', 'turn-routes'], 4);
    if (incident?.properties.featureId) {
      selectEdge(incident.properties.featureId);
      return;
    }
    const marker = incident || rendered(event.point, ['landmarks', 'transit', 'signals'], 4);
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
    drawVehicles(0);
    callbacks.onMapReady?.();
  });

  function vehicleAt(geom, fraction, laneOffset = 0) {
    const location = samplePolylineAt(geom, fraction);
    const bearing = Math.atan2(location.tx, location.ty) * 180 / Math.PI;
    if (!geom.edge.oneway) {
      location.lon -= location.nx * laneOffset;
      location.lat -= location.ny * laneOffset;
    }
    return point(location, { bearing });
  }

  function queueExtent(edge, state) {
    const length = Math.max(1, edge.length_m);
    const measured = (state?.queue_length_m ?? 0) / length;
    if (!isCongested(state)) return 0;
    return Math.min(0.94, Math.max(measured, 0.55));
  }

  function drawQueues() {
    if (!ready || layerState.vehicles === false) return;
    const states = activeFrame()?.edge_states;
    const zoom = map.getZoom();
    const bounds = map.getBounds();
    const cars = [];
    if (zoom >= 13) for (const geom of geometries) {
      const extent = queueExtent(geom.edge, states?.[geom.edge.edge_id]);
      if (!extent) continue;
      const head = samplePolylineAt(geom, 0.97);
      const tail = samplePolylineAt(geom, 1 - extent);
      if (!bounds.contains([head.lon, head.lat]) && !bounds.contains([tail.lon, tail.lat])) continue;
      const a = map.project([head.lon, head.lat]);
      const b = map.project([tail.lon, tail.lat]);
      const size = zoom < 16 ? 14 : 17;
      const count = Math.max(1, Math.min(28, Math.floor(Math.hypot(a.x - b.x, a.y - b.y) / size)));
      for (let index = 0; index < count; index++) {
        const fraction = 0.97 - (extent - 0.03) * (index + 0.5) / count;
        cars.push(vehicleAt(geom, fraction, 0.000025));
      }
    }
    data('queued-vehicles', cars);
  }

  function drawVehicles(delta) {
    if (!ready || layerState.vehicles === false || document.hidden) return;
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
      const approach = 1 - queueExtent(edge, state);
      if (approach < 0.2) continue;
      const vehicle = vehicleAt(geom, fraction * approach, 0.000025);
      if (bounds.contains(vehicle.geometry.coordinates)) vehicles.push(vehicle);
    }
    data('vehicles', vehicles);
  }

  const ticker = setInterval(() => {
    const now = performance.now();
    const delta = Math.min(0.15, (now - lastTick) / 1000);
    lastTick = now;
    if (playing && !reducedMotion.matches) drawVehicles(delta);
  }, 50);

  function syncMotion() { drawVehicles(0); drawQueues(); }
  map.on('moveend', syncMotion);
  reducedMotion.addEventListener('change', syncMotion);

  return {
    setRegion(nextRegion, nextFocusBbox = null) {
      region = nextRegion;
      focusBbox = nextFocusBbox;
      simulation = null;
      pending = null;
      hover = null;
      hoveredSignage = null;
      signagePopup.remove();
      selected = null;
      flowProgress.clear();
      geometries = buildEdgeGeometryCache(region).filter(geom => geom.coords.length > 1);
      geometryById = new Map(geometries.map(geom => [geom.edge.edge_id, geom]));
      edges = new Map(geometries.map(({ edge }) => [edge.edge_id, edge]));
      signageByInterId = new Map((region.signage_nodes || []).map(s => [s.intersection_id, s]));
      updateRegion();
      setCamera(nextFocusBbox ? (camera === 'overview' ? '2d' : camera) : (region.id === 'all' ? 'overview' : (camera === 'overview' ? '2d' : camera)));
    },
    setSimulation(result, index) {
      simulation = result;
      if (Array.isArray(result?.signage_nodes) && result.signage_nodes.length) {
        signageByInterId = new Map(result.signage_nodes.map(s => [s.intersection_id, s]));
      }
      flowProgress.clear();
      this.setFrameIndex(index);
      updateDisruptions();
    },
    focusRegionBbox(nextBbox, mode = null) {
      focusBbox = nextBbox || null;
      if (!ready) return;
      const targetMode = mode || (nextBbox ? (camera === 'overview' ? '2d' : camera) : 'overview');
      setCamera(targetMode);
    },
    setFrameIndex(index = 0) { frameIndex = index; updateFrame(); },
    setPlayback(isPlaying, playbackSpeed) { playing = isPlaying; speed = playbackSpeed; },
    setLayers(next) {
      layerState = { ...layerState, ...next };
      updateLayers();
      syncMotion();
    },
    setDisruptionPlacementMode(mode) {
      placement = mode;
      if (!mode) pending = null;
      map.getCanvas().style.cursor = mode ? 'crosshair' : 'grab';
      updateDisruptions();
    },
    clearPendingSnap() { pending = null; updateDisruptions(); },
    zoomIn() { map.zoomIn({ duration: reducedMotion.matches ? 0 : 250 }); },
    zoomOut() { map.zoomOut({ duration: reducedMotion.matches ? 0 : 250 }); },
    resetView() { setCamera('2d'); },
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
      clearTimeout(clearanceTimer);
      reducedMotion.removeEventListener('change', syncMotion);
      resizeObserver.disconnect();
      map.remove();
    },
  };
}
