/**
 * Dark Urban Abstract Traffic-Flow Map & WebGL Water-Like Directional Streamline Renderer.
 *
 * Renders filtered OpenStreetMap arterial/collector corridors, topological intersections,
 * signal phase rings, transit stops, study boundaries, coverage masks, Gaussian
 * disruption fields, and directional traffic-flow particles along legal travel directions.
 *
 * Uses a synchronized WebGL particle shader layer over a HiDPI Canvas2D vector map,
 * with automatic Canvas2D particle fallback when WebGL is unavailable.
 */
import { colors } from './map-style.js';
import { isCongested, snapDisruptionLocation } from './adaptive-model.js';

const DEG_TO_RAD = Math.PI / 180;

const VERT_SRC = `
attribute vec2 a_pos;
attribute vec4 a_color;
attribute float a_size;
uniform vec2 u_resolution;
varying vec4 v_color;
void main() {
  vec2 clip = (a_pos / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = a_size;
  v_color = a_color;
}
`;

const FRAG_SRC = `
precision mediump float;
varying vec4 v_color;
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = dot(d, d);
  if (r > 0.25) discard;
  float alpha = smoothstep(0.25, 0.02, r) * v_color.a;
  gl_FragColor = vec4(v_color.rgb, alpha);
}
`;

function compileShader(gl, type, source) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function initWebGLParticles(canvas) {
  try {
    const gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: false });
    if (!gl) return null;
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    if (!vs || !fs) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    return {
      gl,
      prog,
      aPos: gl.getAttribLocation(prog, 'a_pos'),
      aColor: gl.getAttribLocation(prog, 'a_color'),
      aSize: gl.getAttribLocation(prog, 'a_size'),
      uRes: gl.getUniformLocation(prog, 'u_resolution'),
      posBuf: gl.createBuffer(),
      colBuf: gl.createBuffer(),
      sizeBuf: gl.createBuffer(),
    };
  } catch {
    return null;
  }
}

export function buildEdgeGeometryCache(region) {
  const edges = region?.edges || [];
  const cosLat = Math.cos((region?.center?.lat || -6.2) * DEG_TO_RAD);
  return edges.map(edge => {
    const coords = edge.coordinates || [];
    const cumDist = [0];
    let total = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      const dx = (coords[i + 1][0] - coords[i][0]) * cosLat;
      const dy = coords[i + 1][1] - coords[i][1];
      total += Math.hypot(dx, dy);
      cumDist.push(total);
    }
    return { edge, coords, cumDist, totalDeg: Math.max(1e-7, total) };
  });
}

export function samplePolylineAt(geom, frac) {
  const { coords, cumDist, totalDeg } = geom;
  if (!coords.length) return { lon: 0, lat: 0, nx: 0, ny: 0, tx: 1, ty: 0 };
  if (coords.length === 1) return { lon: coords[0][0], lat: coords[0][1], nx: 0, ny: 0, tx: 1, ty: 0 };
  const target = Math.max(0, Math.min(1, frac)) * totalDeg;
  let seg = 0;
  while (seg < cumDist.length - 2 && cumDist[seg + 1] < target) seg++;
  const d0 = cumDist[seg];
  const d1 = cumDist[seg + 1];
  const t = d1 > d0 ? (target - d0) / (d1 - d0) : 0;
  const a = coords[seg];
  const b = coords[seg + 1];
  const lon = a[0] + (b[0] - a[0]) * t;
  const lat = a[1] + (b[1] - a[1]) * t;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1e-7;
  // Right-hand perpendicular normal for clean lane separation on bidirectional roads.
  return { lon, lat, tx: dx / len, ty: dy / len, nx: dy / len, ny: -dx / len };
}

const paintRGB = Object.fromEntries(Object.entries(colors).map(([name, hex]) => [
  name, hex.slice(1).match(/../g).map(channel => parseInt(channel, 16) / 255),
]));

function trafficColorRGB(congestion, closed, restricted) {
  if (closed) return paintRGB.navy;
  if (restricted || congestion >= 0.68) return paintRGB.orange;
  if (congestion >= 0.32) return paintRGB.copper;
  return paintRGB.blue;
}

export function createAdaptiveMapRenderer(container, callbacks = {}) {
  const baseCanvas = document.createElement('canvas');
  const flowCanvas = document.createElement('canvas');
  baseCanvas.className = 'atn-canvas-base';
  flowCanvas.className = 'atn-canvas-flow';
  container.innerHTML = '';
  container.append(baseCanvas, flowCanvas);

  const ctx = baseCanvas.getContext('2d');
  const webgl = initWebGLParticles(flowCanvas);
  const flowFallbackCtx = webgl ? null : flowCanvas.getContext('2d');

  let width = 800;
  let height = 560;
  let dpr = Math.min(window.devicePixelRatio || 1, 2);

  let region = null;
  let regionConnections = null;
  let geomCache = [];
  let simResult = null;
  let frameIndex = 0;
  let layers = {
    vehicles: true,
    transit: true,
    signals: true,
    gaussian: true,
    coverage: true,
    labels: true,
    connections: true,
  };
  let disruptionMode = null; // null | 'flood' | 'demonstration'
  let pendingSnap = null;
  let rejectedPing = null;
  let hoverEdge = null;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let isPlaying = true;
  let playbackSpeed = 1;

  // View camera state in geographic Mercator-local scale.
  let viewCenter = { lat: -6.1172, lon: 106.7968 };
  let pixelsPerDegLat = 26000;
  let dragState = null;
  let rafId = null;
  let lastTs = performance.now();

  // Persistent particle pool across edges.
  let particles = [];

  function cosLat() {
    return Math.cos((region?.center?.lat || viewCenter.lat) * DEG_TO_RAD);
  }

  function latLonToScreen(lat, lon) {
    const pxPerLon = pixelsPerDegLat * cosLat();
    return {
      x: width * 0.5 + (lon - viewCenter.lon) * pxPerLon,
      y: height * 0.5 - (lat - viewCenter.lat) * pixelsPerDegLat,
    };
  }

  function screenToLatLon(x, y) {
    const pxPerLon = pixelsPerDegLat * cosLat();
    return {
      lon: viewCenter.lon + (x - width * 0.5) / pxPerLon,
      lat: viewCenter.lat - (y - height * 0.5) / pixelsPerDegLat,
    };
  }

  function fitRegion() {
    if (!region) return;
    const b = region.bbox;
    const latSpan = Math.max(0.005, b.north - b.south);
    const lonSpan = Math.max(0.005, b.east - b.west);
    const c = Math.cos(((b.north + b.south) * 0.5) * DEG_TO_RAD);
    const scaleLat = (height * 0.84) / latSpan;
    const scaleLon = (width * 0.84) / (lonSpan * c);
    pixelsPerDegLat = Math.max(8000, Math.min(120000, Math.min(scaleLat, scaleLon)));
    viewCenter = { lat: (b.north + b.south) * 0.5, lon: (b.east + b.west) * 0.5 };
  }

  function rebuildParticles() {
    particles = [];
    for (let i = 0; i < geomCache.length; i++) {
      const e = geomCache[i].edge;
      const baseCount = Math.max(3, Math.min(18, Math.round((e.length_m || 120) / 36) + (e.lanes || 1) * 2));
      for (let k = 0; k < baseCount; k++) {
        particles.push({
          edgeIdx: i,
          offset: (k / baseCount + ((i * 0.17) % 1)) % 1,
          laneJitter: ((k % 3) - 1) * 1.15,
        });
      }
    }
  }

  function resize() {
    const rect = container.getBoundingClientRect();
    width = Math.max(320, Math.round(rect.width || container.clientWidth || 800));
    height = Math.max(280, Math.round(rect.height || container.clientHeight || 540));
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const c of [baseCanvas, flowCanvas]) {
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
      c.style.width = `${width}px`;
      c.style.height = `${height}px`;
    }
    if (webgl) {
      webgl.gl.viewport(0, 0, flowCanvas.width, flowCanvas.height);
    }
    drawBaseLayer();
  }

  function activeFrame() {
    const frames = simResult?.frames;
    if (!frames || !frames.length) return null;
    const idx = Math.max(0, Math.min(frames.length - 1, frameIndex));
    return frames[idx];
  }

  function drawGaussianFieldOverlay() {
    if (!layers.gaussian || !simResult?.disruptions) return;
    const { flood, demonstration } = simResult.disruptions;
    const fields = [
      { cfg: flood, rgb: '9, 97, 173', label: 'FLOOD FIELD' },
      { cfg: demonstration, rgb: '248, 104, 9', label: 'DEMO FIELD' },
    ];
    for (const { cfg, rgb } of fields) {
      if (!cfg?.enabled || !Number.isFinite(cfg.lat) || !Number.isFinite(cfg.lon)) continue;
      const center = latLonToScreen(cfg.lat, cfg.lon);
      const sigma = Number(cfg.sigma_m) || 400;
      const intensity = Number(cfg.intensity) || 0.75;
      const radiusPx = ((sigma * 2.35) / 110574) * pixelsPerDegLat;
      const grad = ctx.createRadialGradient(center.x, center.y, 4, center.x, center.y, Math.max(24, radiusPx));
      grad.addColorStop(0, `rgba(${rgb}, ${(0.36 * intensity).toFixed(3)})`);
      grad.addColorStop(0.45, `rgba(${rgb}, ${(0.18 * intensity).toFixed(3)})`);
      grad.addColorStop(1, `rgba(${rgb}, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(center.x, center.y, Math.max(24, radiusPx), 0, Math.PI * 2);
      ctx.fill();

      // 1-sigma & 2-sigma contour rings
      ctx.save();
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = `rgba(${rgb}, 0.58)`;
      const sigmaPx = (sigma / 110574) * pixelsPerDegLat;
      ctx.beginPath();
      ctx.arc(center.x, center.y, Math.max(10, sigmaPx), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawBaseLayer() {
    if (!ctx) return;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 1. Deep urban dark slate canvas
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);

    // Subtle spatial reference grid
    ctx.strokeStyle = 'rgba(27, 43, 78, 0.055)';
    ctx.lineWidth = 1;
    const gridStep = 48;
    for (let gx = (width * 0.5) % gridStep; gx < width; gx += gridStep) {
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, height); ctx.stroke();
    }
    for (let gy = (height * 0.5) % gridStep; gy < height; gy += gridStep) {
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(width, gy); ctx.stroke();
    }

    if (!region) {
      ctx.restore();
      return;
    }

    // 2. Waterbodies (Waduk Pluit, rivers, canals)
    for (const wb of region.waterbodies || []) {
      const rings = wb.geometry_type === 'Polygon' ? wb.coordinates : [wb.coordinates];
      for (const ring of rings) {
        if (!ring || ring.length < 2) continue;
        ctx.beginPath();
        ring.forEach((pt, idx) => {
          const p = latLonToScreen(pt[1], pt[0]);
          if (idx === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        if (wb.geometry_type === 'Polygon') {
          ctx.closePath();
          ctx.fillStyle = 'rgba(9, 97, 173, 0.15)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(9, 97, 173, 0.25)';
          ctx.lineWidth = 1.2;
          ctx.stroke();
        } else {
          ctx.strokeStyle = 'rgba(9, 97, 173, 0.55)';
          ctx.lineWidth = 3;
          ctx.stroke();
        }
      }
    }

    // 3. Study area boundary & coverage mask
    if (layers.coverage && region.study_boundary?.length >= 4) {
      ctx.save();
      ctx.beginPath();
      region.study_boundary.forEach((pt, i) => {
        const p = latLonToScreen(pt[1], pt[0]);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.strokeStyle = 'rgba(9, 97, 173, 0.34)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([8, 6]);
      ctx.stroke();
      ctx.restore();
    }

    if (layers.coverage && region.coverage_mask?.length >= 4) {
      ctx.save();
      ctx.beginPath();
      region.coverage_mask.forEach((pt, i) => {
        const p = latLonToScreen(pt[1], pt[0]);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.fillStyle = 'rgba(4, 37, 115, 0.06)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(9, 97, 173, 0.28)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.restore();
    }

    // 4. Translucent Gaussian Disruption Field
    drawGaussianFieldOverlay();

    // 5. Filtered OSM Road Network (casing, traffic state core, closed/restricted overlays, queues)
    const frame = activeFrame();
    const edgeStates = frame?.edge_states || {};
    const scaleZoom = Math.max(0.7, Math.min(2.2, pixelsPerDegLat / 26000));

    for (const geom of geomCache) {
      const e = geom.edge;
      const st = edgeStates[e.edge_id];
      const hw = e.highway || 'secondary';
      const baseW = (hw.includes('motorway') || hw.includes('trunk') ? 5.2 : hw.includes('primary') ? 4.2 : hw.includes('secondary') ? 3.2 : 2.3) * scaleZoom;
      const laneOffsetPx = e.oneway ? 0 : Math.max(2.2, baseW * 0.62);

      // Compute shifted polyline points for crisp directional lane separation
      const pts = geom.coords.map(c => latLonToScreen(c[1], c[0]));
      const shifted = pts.map((p, idx) => {
        if (laneOffsetPx === 0) return p;
        const a = pts[Math.max(0, idx - 1)];
        const b = pts[Math.min(pts.length - 1, idx + 1)];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        // Left-hand traffic in Indonesia: keep direction visually separated along left side
        const nx = dy / len;
        const ny = -dx / len;
        return { x: p.x + nx * laneOffsetPx, y: p.y + ny * laneOffsetPx };
      });

      const tracePath = () => {
        ctx.beginPath();
        shifted.forEach((p, idx) => (idx === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      };

      // Highlight eligible corridor when placing disruption
      const eligActive = disruptionMode && e[`${disruptionMode}_eligible`];
      if (eligActive) {
        ctx.save();
        tracePath();
        ctx.strokeStyle = disruptionMode === 'flood' ? 'rgba(9, 97, 173, 0.25)' : 'rgba(248, 104, 9, 0.25)';
        ctx.lineWidth = baseW + 5;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
        ctx.restore();
      }

      // Road casing
      tracePath();
      ctx.strokeStyle = hoverEdge?.edge_id === e.edge_id ? 'rgba(255, 255, 255, 0.65)' : 'rgba(27, 43, 78, 0.14)';
      ctx.lineWidth = baseW + 2.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();

      // Road core colored by simulation state / disruption
      const closed = Boolean(st?.closed);
      const congested = isCongested(st);
      if (congested) {
        tracePath();
        ctx.strokeStyle = colors.navy;
        ctx.lineWidth = baseW + 4;
        ctx.stroke();
      }
      const restricted = Boolean(st?.access_restricted);
      const cong = st ? st.congestion_index : 0.18;
      const disI = st ? st.disruption_intensity : 0;
      const [r, g, b] = trafficColorRGB(cong, closed, restricted);

      ctx.save();
      tracePath();
      if (closed) {
        ctx.strokeStyle = 'rgba(4, 37, 115, 0.88)';
        ctx.lineWidth = baseW + 0.6;
        ctx.setLineDash([6, 5]);
      } else if (congested) {
        ctx.strokeStyle = colors.orange;
        ctx.lineWidth = baseW + 1;
      } else if (restricted) {
        ctx.strokeStyle = 'rgba(248, 104, 9, 0.85)';
        ctx.lineWidth = baseW;
        ctx.setLineDash([9, 4]);
      } else {
        const alpha = st ? (0.45 + 0.4 * Math.max(cong, disI)) : 0.42;
        ctx.strokeStyle = `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha.toFixed(2)})`;
        ctx.lineWidth = baseW;
      }
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.restore();

      // Queue spillback bar near downstream stop line when occupancy is high
      if (st && st.occupancy >= 0.45 && shifted.length >= 2 && !closed) {
        const qFrac = Math.min(0.85, st.occupancy * 0.78);
        const tailIdx = Math.max(0, Math.floor((shifted.length - 1) * (1 - qFrac)));
        ctx.save();
        ctx.beginPath();
        for (let i = tailIdx; i < shifted.length; i++) {
          if (i === tailIdx) ctx.moveTo(shifted[i].x, shifted[i].y);
          else ctx.lineTo(shifted[i].x, shifted[i].y);
        }
        ctx.strokeStyle = st.occupancy >= 0.8 ? 'rgba(248, 104, 9, 0.92)' : 'rgba(208, 116, 56, 0.78)';
        ctx.lineWidth = Math.max(2.5, baseW * 0.82);
        ctx.lineCap = 'round';
        ctx.stroke();
        ctx.restore();
      }
    }

    // 6. Signalized intersections & phase rings
    const interStates = frame?.intersection_states || {};
    if (layers.signals) {
      for (const inter of region.intersections || []) {
        if (!inter.signalized && inter.degree < 4) continue;
        const p = latLonToScreen(inter.lat, inter.lon);
        if (p.x < -20 || p.y < -20 || p.x > width + 20 || p.y > height + 20) continue;
        const ist = interStates[inter.node_id];
        ctx.save();
        ctx.beginPath();
        ctx.arc(p.x, p.y, inter.signalized ? 4.4 : 2.8, 0, Math.PI * 2);
        ctx.fillStyle = ist
          ? (ist.phase === 0 ? '#D07438' : '#0961AD')
          : (inter.signalized ? '#042573' : '#1B2B4E');
        ctx.fill();
        if (inter.signalized) {
          ctx.strokeStyle = 'rgba(27, 43, 78, 0.95)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    // 7. Transit stops (MRT, KRL, TransJakarta/bus)
    if (layers.transit) {
      for (const st of region.transit_stops || []) {
        const p = latLonToScreen(st.lat, st.lon);
        if (p.x < -20 || p.y < -20 || p.x > width + 20 || p.y > height + 20) continue;
        const isRail = st.mode === 'mrt_station' || st.mode === 'rail_station';
        ctx.save();
        if (isRail) {
          ctx.fillStyle = '#0961AD';
          ctx.strokeStyle = '#1B2B4E';
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          ctx.rect(p.x - 4.5, p.y - 4.5, 9, 9);
          ctx.fill();
          ctx.stroke();
        } else {
          ctx.fillStyle = '#0961AD';
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2.7, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }

    // 8. Key Study Landmarks
    if (layers.labels) {
      ctx.save();
      ctx.font = '600 11px "Plus Jakarta Sans", "DM Sans", sans-serif';
      for (const lm of region.landmarks || []) {
        const p = latLonToScreen(lm.lat, lm.lon);
        if (p.x < 10 || p.y < 10 || p.x > width - 10 || p.y > height - 10) continue;
        ctx.fillStyle = lm.kind.includes('station') ? '#0961AD' : '#1B2B4E';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3.6, 0, Math.PI * 2);
        ctx.fill();
        const tw = ctx.measureText(lm.name).width;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
        ctx.fillRect(p.x + 7, p.y - 10, tw + 10, 17);
        ctx.strokeStyle = 'rgba(27, 43, 78, 0.28)';
        ctx.lineWidth = 0.8;
        ctx.strokeRect(p.x + 7, p.y - 10, tw + 10, 17);
        ctx.fillStyle = '#1B2B4E';
        ctx.fillText(lm.name, p.x + 12, p.y + 2);
      }
      ctx.restore();
    }

    // 8b. Real-world OSM Street Connections to Adjacent Corridor Areas
    if (layers.connections && regionConnections) {
      ctx.save();
      ctx.font = '600 10px "Plus Jakarta Sans", "DM Sans", sans-serif';
      const drawConnectors = (entry, arrow) => {
        if (!entry?.connectors?.length) return;
        let labeled = 0;
        const labeledNames = new Set();
        for (const conn of entry.connectors) {
          const p = latLonToScreen(conn.lat, conn.lon);
          if (p.x < 8 || p.y < 8 || p.x > width - 8 || p.y > height - 8) continue;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 4.2, 0, Math.PI * 2);
          ctx.fillStyle = '#10b981';
          ctx.fill();
          ctx.strokeStyle = '#070d18';
          ctx.lineWidth = 1.4;
          ctx.stroke();

          if (labeled < 3 && !conn.road_name.includes('#') && !labeledNames.has(conn.road_name)) {
            labeledNames.add(conn.road_name);
            const label = `${arrow} ${conn.road_name}`;
            const tw = ctx.measureText(label).width;
            const lx = Math.min(width - tw - 16, Math.max(8, p.x - tw * 0.5));
            const ly = arrow === '↑' ? Math.max(18, p.y - 12) : Math.min(height - 10, p.y + 18);
            ctx.fillStyle = 'rgba(6, 78, 59, 0.88)';
            ctx.fillRect(lx - 4, ly - 10, tw + 8, 14);
            ctx.strokeStyle = 'rgba(16, 185, 129, 0.55)';
            ctx.lineWidth = 0.8;
            ctx.strokeRect(lx - 4, ly - 10, tw + 8, 14);
            ctx.fillStyle = '#a7f3d0';
            ctx.fillText(label, lx, ly);
            labeled++;
          }
        }
      };
      drawConnectors(regionConnections.north, '↑');
      drawConnectors(regionConnections.south, '↓');
      ctx.restore();
    }

    // 9. Active Disruption Markers + Pending Snap Marker
    const activeMarkers = [];
    if (simResult?.disruptions?.flood?.enabled) {
      activeMarkers.push({ ...simResult.disruptions.flood, kind: 'flood', label: 'Flood event' });
    }
    if (simResult?.disruptions?.demonstration?.enabled) {
      activeMarkers.push({ ...simResult.disruptions.demonstration, kind: 'demonstration', label: 'Demonstration event' });
    }
    for (const m of activeMarkers) {
      if (!Number.isFinite(m.lat) || !Number.isFinite(m.lon)) continue;
      const p = latLonToScreen(m.lat, m.lon);
      const col = m.kind === 'flood' ? '#0961AD' : '#F86809';
      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, 13, 0, Math.PI * 2);
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.font = '700 13px sans-serif';
      ctx.lineWidth = 4;
      ctx.strokeStyle = colors.white;
      ctx.strokeText(m.label, p.x + 16, p.y + 4);
      ctx.fillStyle = colors.navy;
      ctx.fillText(m.label, p.x + 16, p.y + 4);
      ctx.restore();
    }

    if (pendingSnap?.accepted) {
      const p = latLonToScreen(pendingSnap.snapped_lat, pendingSnap.snapped_lon);
      const col = pendingSnap.disruption_kind === 'flood' ? '#0961AD' : '#F86809';
      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, 16, 0, Math.PI * 2);
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.8;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6.5, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.restore();
    }

    if (rejectedPing && performance.now() - rejectedPing.at < 1800) {
      const p = latLonToScreen(rejectedPing.lat, rejectedPing.lon);
      ctx.save();
      ctx.strokeStyle = '#042573';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(p.x - 8, p.y - 8); ctx.lineTo(p.x + 8, p.y + 8);
      ctx.moveTo(p.x + 8, p.y - 8); ctx.lineTo(p.x - 8, p.y + 8);
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }

  function renderFlowFrame(now) {
    const dt = Math.min(0.06, (now - lastTs) / 1000);
    lastTs = now;
    const frame = activeFrame();
    const edgeStates = frame?.edge_states || {};
    const pxPerLon = pixelsPerDegLat * cosLat();
    const scaleZoom = Math.max(0.7, Math.min(2.2, pixelsPerDegLat / 26000));

    const posArr = [];
    const colArr = [];
    const sizeArr = [];
    const arrowHeads = [];

    for (const p of layers.vehicles ? particles : []) {
      const geom = geomCache[p.edgeIdx];
      if (!geom) continue;
      const e = geom.edge;
      const st = edgeStates[e.edge_id];
      if (st?.closed) continue;

      const speedKmh = st ? st.speed_kmh : Number(e.speed_limit_kmh) * 0.78;
      const cong = st ? st.congestion_index : 0.18;
      // Flow velocity strictly driven by simulated edge speed & edge length.
      const speedMps = Math.max(1.2, speedKmh / 3.6);
      const fracPerSec = (speedMps * (isPlaying && !reducedMotion.matches ? playbackSpeed : 0) * 1.6) / Math.max(25, e.length_m || 120);
      p.offset = (p.offset + fracPerSec * dt) % 1;

      const pt = samplePolylineAt(geom, p.offset);
      const baseX = width * 0.5 + (pt.lon - viewCenter.lon) * pxPerLon;
      const baseY = height * 0.5 - (pt.lat - viewCenter.lat) * pixelsPerDegLat;
      if (baseX < -24 || baseY < -24 || baseX > width + 24 || baseY > height + 24) continue;

      const laneOffsetPx = e.oneway ? 0 : Math.max(2.2, (e.highway.includes('primary') ? 4.2 : 3.2) * scaleZoom * 0.62);
      const txScreen = pt.tx * pxPerLon;
      const tyScreen = -pt.ty * pixelsPerDegLat;
      const tLen = Math.hypot(txScreen, tyScreen) || 1;
      const nxScreen = -tyScreen / tLen;
      const nyScreen = txScreen / tLen;

      const sx = baseX - nxScreen * (laneOffsetPx + p.laneJitter * 0.45);
      const sy = baseY - nyScreen * (laneOffsetPx + p.laneJitter * 0.45);
      const [r, g, b] = trafficColorRGB(cong, false, Boolean(st?.access_restricted));
      const size = (5 + (1 - cong * 0.3) * 1.4) * Math.min(1.5, scaleZoom) * dpr;

      posArr.push(sx * dpr, sy * dpr);
      colArr.push(r, g, b, st ? 0.92 : 0.72);
      sizeArr.push(size);

      if (flowFallbackCtx) {
        arrowHeads.push({ sx, sy, r, g, b, size: size / dpr, ux: txScreen / tLen, uy: tyScreen / tLen });
      }
    }

    if (webgl) {
      const { gl, aPos, aColor, aSize, uRes, posBuf, colBuf, sizeBuf } = webgl;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (posArr.length) {
        gl.uniform2f(uRes, flowCanvas.width, flowCanvas.height);
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(posArr), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(colArr), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(aColor);
        gl.vertexAttribPointer(aColor, 4, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, sizeBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(sizeArr), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(aSize);
        gl.vertexAttribPointer(aSize, 1, gl.FLOAT, false, 0, 0);

        gl.drawArrays(gl.POINTS, 0, posArr.length / 2);
      }
    } else if (flowFallbackCtx) {
      flowFallbackCtx.save();
      flowFallbackCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      flowFallbackCtx.clearRect(0, 0, width, height);
      for (const a of arrowHeads) {
        flowFallbackCtx.fillStyle = `rgba(${Math.round(a.r * 255)}, ${Math.round(a.g * 255)}, ${Math.round(a.b * 255)}, 0.88)`;
        flowFallbackCtx.beginPath();
        flowFallbackCtx.moveTo(a.sx + a.ux * a.size * 1.4, a.sy + a.uy * a.size * 1.4);
        flowFallbackCtx.lineTo(a.sx - a.ux * a.size - a.uy * a.size * 0.7, a.sy - a.uy * a.size + a.ux * a.size * 0.7);
        flowFallbackCtx.lineTo(a.sx - a.ux * a.size + a.uy * a.size * 0.7, a.sy - a.uy * a.size - a.ux * a.size * 0.7);
        flowFallbackCtx.closePath();
        flowFallbackCtx.fill();
      }
      flowFallbackCtx.restore();
    }

    if (rejectedPing && performance.now() - rejectedPing.at >= 1800) {
      rejectedPing = null;
      drawBaseLayer();
    }

    rafId = requestAnimationFrame(renderFlowFrame);
  }

  function findHoveredEdge(lat, lon) {
    if (!region) return null;
    const snap = snapDisruptionLocation(region, lat, lon, 'flood', 90);
    if (snap.accepted) {
      return region.edges.find(e => e.edge_id === snap.snapped_edge_id) || null;
    }
    const snapDemo = snapDisruptionLocation(region, lat, lon, 'demonstration', 90);
    if (snapDemo.accepted) {
      return region.edges.find(e => e.edge_id === snapDemo.snapped_edge_id) || null;
    }
    return null;
  }

  function onPointerDown(ev) {
    dragState = {
      x: ev.clientX,
      y: ev.clientY,
      moved: false,
      startCenter: { ...viewCenter },
    };
  }

  function onPointerMove(ev) {
    const rect = flowCanvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;

    if (dragState) {
      const dx = ev.clientX - dragState.x;
      const dy = ev.clientY - dragState.y;
      if (Math.hypot(dx, dy) > 4) dragState.moved = true;
      if (dragState.moved) {
        const pxPerLon = pixelsPerDegLat * cosLat();
        viewCenter = {
          lon: dragState.startCenter.lon - dx / pxPerLon,
          lat: dragState.startCenter.lat + dy / pixelsPerDegLat,
        };
        drawBaseLayer();
        return;
      }
    }

    const { lat, lon } = screenToLatLon(x, y);
    const nextHover = findHoveredEdge(lat, lon);
    if (nextHover?.edge_id !== hoverEdge?.edge_id) {
      hoverEdge = nextHover;
      drawBaseLayer();
    }
    if (disruptionMode && region) {
      const test = snapDisruptionLocation(region, lat, lon, disruptionMode, 200);
      flowCanvas.style.cursor = test.accepted ? 'crosshair' : 'not-allowed';
    } else {
      flowCanvas.style.cursor = hoverEdge ? 'pointer' : 'grab';
    }

    if (callbacks.onHover) {
      const frame = activeFrame();
      const state = hoverEdge ? frame?.edge_states?.[hoverEdge.edge_id] : null;
      callbacks.onHover({ edge: hoverEdge, edgeState: state, lat, lon, x, y });
    }
  }

  function onPointerUp(ev) {
    if (!dragState) return;
    const moved = dragState.moved;
    dragState = null;
    if (moved || !region) return;
    const rect = flowCanvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const { lat, lon } = screenToLatLon(x, y);

    if (disruptionMode) {
      const res = snapDisruptionLocation(region, lat, lon, disruptionMode, 200);
      if (res.accepted) {
        pendingSnap = res;
        rejectedPing = null;
        drawBaseLayer();
        callbacks.onSnapAccepted?.(res);
      } else {
        pendingSnap = null;
        rejectedPing = { lat, lon, at: performance.now() };
        drawBaseLayer();
        callbacks.onSnapRejected?.(res);
      }
    } else if ((hoverEdge = findHoveredEdge(lat, lon))) {
      const frame = activeFrame();
      callbacks.onEdgeClick?.(hoverEdge, frame?.edge_states?.[hoverEdge.edge_id] || null);
    } else {
      const res = snapDisruptionLocation(region, lat, lon, region.primary_disruption || 'flood', 200);
      if (!res.accepted) {
        rejectedPing = { lat, lon, at: performance.now() };
        drawBaseLayer();
        callbacks.onSnapRejected?.(res);
      }
    }
  }

  function onWheel(ev) {
    ev.preventDefault();
    const factor = ev.deltaY < 0 ? 1.16 : 0.86;
    pixelsPerDegLat = Math.max(8000, Math.min(180000, pixelsPerDegLat * factor));
    drawBaseLayer();
  }

  flowCanvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  flowCanvas.addEventListener('wheel', onWheel, { passive: false });

  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  resizeObserver?.observe(container);
  resize();
  rafId = requestAnimationFrame(renderFlowFrame);

  return {
    setRegion(nextRegion, nextConnections = null) {
      region = nextRegion;
      regionConnections = nextConnections;
      geomCache = buildEdgeGeometryCache(region);
      pendingSnap = null;
      rejectedPing = null;
      hoverEdge = null;
      fitRegion();
      rebuildParticles();
      drawBaseLayer();
    },
    setSimulation(nextSim, nextFrameIndex = 0) {
      simResult = nextSim;
      frameIndex = nextFrameIndex;
      drawBaseLayer();
    },
    setFrameIndex(idx) {
      frameIndex = idx;
      drawBaseLayer();
    },
    setPlayback(playing, speed = playbackSpeed) {
      isPlaying = playing;
      playbackSpeed = speed;
    },
    setLayers(nextLayers) {
      layers = { ...layers, ...nextLayers };
      drawBaseLayer();
    },
    setDisruptionPlacementMode(mode) {
      disruptionMode = mode;
      if (!mode) pendingSnap = null;
      flowCanvas.style.cursor = mode ? 'crosshair' : 'grab';
      drawBaseLayer();
    },
    clearPendingSnap() {
      pendingSnap = null;
      drawBaseLayer();
    },
    zoomIn() {
      pixelsPerDegLat = Math.min(180000, pixelsPerDegLat * 1.28);
      drawBaseLayer();
    },
    zoomOut() {
      pixelsPerDegLat = Math.max(8000, pixelsPerDegLat * 0.78);
      drawBaseLayer();
    },
    resetView() {
      fitRegion();
      drawBaseLayer();
    },
    focusLocation(location) {
      viewCenter = { lon: location.lon, lat: location.lat };
      if (location.edge) {
        hoverEdge = location.edge;
        callbacks.onEdgeClick?.(hoverEdge, activeFrame()?.edge_states?.[hoverEdge.edge_id]);
      } else {
        callbacks.onFeatureClick?.(location);
      }
      drawBaseLayer();
    },
    getRenderEngine() {
      return webgl ? 'WebGL particle streamlines + HiDPI Canvas2D' : 'Canvas2D directional streamlines';
    },
    destroy() {
      if (rafId) cancelAnimationFrame(rafId);
      resizeObserver?.disconnect();
      flowCanvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      flowCanvas.removeEventListener('wheel', onWheel);
    },
  };
}
