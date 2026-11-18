/**
 * Interactive orchestration for the Jakarta Adaptive Traffic Network Simulator (#mapview).
 *
 * Connects the geospatial map renderer, scenario controls, spatial click-to-disrupt
 * snapping, backend FastAPI simulation API (with explicit client fallback when offline),
 * replay timeline, and 3-controller benchmark comparison.
 */
import { ADAPTIVE_REGIONS_DATA, ADAPTIVE_PROVENANCE_MANIFEST } from './adaptive-regions-data.js';
import {
  TIME_PERIODS,
  CONTROLLERS,
  snapDisruptionLocation,
  runClientFallbackSimulation,
  formatMetricValue,
} from './adaptive-model.js';
import { createGeospatialRenderer } from './geospatial-renderer.js';
import { bindMapSearch } from './map-search.js';
import { apiRequest } from './api.js';
import { safe } from './util.js';

let activeInstance = null;

const defaultState = () => ({
  regionId: 'pluit',
  timePeriod: 'pagi',
  controller: 'gnn_mappo',
  disruptionMode: 'flood', // 'normal' | 'flood' | 'demonstration' | 'both'
  flood: {
    enabled: true,
    lat: ADAPTIVE_REGIONS_DATA.pluit?.disruption_anchors?.flood?.lat ?? -6.121957,
    lon: ADAPTIVE_REGIONS_DATA.pluit?.disruption_anchors?.flood?.lon ?? 106.803961,
    roadName: ADAPTIVE_REGIONS_DATA.pluit?.disruption_anchors?.flood?.road_name ?? 'Jalan Muara Baru Raya',
    intensity: 0.78,
    sigma_m: 460,
  },
  demonstration: {
    enabled: false,
    lat: ADAPTIVE_REGIONS_DATA.pluit?.disruption_anchors?.demonstration?.lat ?? -6.121957,
    lon: ADAPTIVE_REGIONS_DATA.pluit?.disruption_anchors?.demonstration?.lon ?? 106.803961,
    roadName: ADAPTIVE_REGIONS_DATA.pluit?.disruption_anchors?.demonstration?.road_name ?? 'Jalan Muara Baru Raya',
    intensity: 0.72,
    sigma_m: 380,
  },
  durationS: 600,
  seed: 42,
  frameIndex: 0,
  playing: true,
  playbackSpeed: 1,
  placementTarget: null, // null | 'flood' | 'demonstration'
  pendingSnap: null,
  statusNotice: null, // { kind: 'ok'|'error'|'info', text: string }
  backendMode: 'checking', // 'checking' | 'connected' | 'offline_fallback'
  immersive: false,
  layers: { transit: true, signals: true, gaussian: true, coverage: true, labels: true },
  simResult: null,
});

let simState = defaultState();

function getRegion(regionId) {
  return ADAPTIVE_REGIONS_DATA[regionId] || ADAPTIVE_REGIONS_DATA.pluit;
}

function syncDisruptionAnchorsForRegion(region) {
  const fAnchor = region.disruption_anchors?.flood;
  const dAnchor = region.disruption_anchors?.demonstration;
  if (fAnchor) {
    simState.flood = {
      ...simState.flood,
      lat: fAnchor.lat,
      lon: fAnchor.lon,
      roadName: fAnchor.road_name,
      sigma_m: fAnchor.default_sigma_m || 420,
    };
  }
  if (dAnchor) {
    simState.demonstration = {
      ...simState.demonstration,
      lat: dAnchor.lat,
      lon: dAnchor.lon,
      roadName: dAnchor.road_name,
      sigma_m: dAnchor.default_sigma_m || 380,
    };
  }
}

export function getAdaptiveSimState() {
  return simState;
}

export function deactivateAdaptiveMapView() {
  if (activeInstance) {
    activeInstance.destroy();
    activeInstance = null;
  }
  document.body.classList.remove('atn-immersive');
}

export function activateAdaptiveMapView() {
  const root = document.getElementById('atn-workspace');
  if (!root) return;
  if (activeInstance) {
    activeInstance.destroy();
    activeInstance = null;
  }

  const mapHost = document.getElementById('atn-map-canvas-host');
  if (!mapHost) return;

  let replayTimer = null;
  let runningRequest = false;
  let queuedRequest = false;
  let disposed = false;

  const selection = document.getElementById('atn-selection');
  const selectionContent = document.getElementById('atn-selection-content');
  const mapStatus = document.getElementById('atn-map-status');

  function showSelection(content) {
    const opening = selection.hidden;
    selection.hidden = !content;
    if (selectionContent.innerHTML !== content) selectionContent.innerHTML = content;
    if (content && opening && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      window.gsap?.fromTo(selectionContent, { y: 6 }, { y: 0, duration: 0.18, ease: 'power2.out' });
    }
  }

  const renderer = createGeospatialRenderer(mapHost, {
    onMapStatus(message) {
      mapStatus.textContent = message;
      mapStatus.hidden = !message;
    },
    onMapReady() {
      if (mapStatus.textContent === 'Loading map…') mapStatus.hidden = true;
    },
    onEdgeClick(edge, state) {
      if (!edge) return;
      const status = state?.closed ? 'Closed' : state?.access_restricted ? 'Restricted' : 'Open';
      showSelection(`<small>Road segment · ${safe(edge.highway)}</small>
        <h2>${safe(edge.name)}</h2>
        <dl>
          <dt>Direction</dt><dd>${edge.oneway ? 'One-way' : 'Bidirectional'}</dd>
          <dt>Speed</dt><dd>${safe(state?.speed_kmh ?? edge.speed_limit_kmh)} km/h${state ? '' : ' limit'}</dd>
          <dt>Queue</dt><dd>${state ? safe(state.queue_veh) + ' vehicles' : '—'}</dd>
          <dt>Access</dt><dd>${status}</dd>
          <dt>Eligible for</dt><dd>${[edge.flood_eligible && 'Flood', edge.demonstration_eligible && 'Demo'].filter(Boolean).join(', ') || '—'}</dd>
        </dl>`);
    },
    onFeatureClick(properties) {
      showSelection(properties ? `<small>${safe(properties.kind)}</small><h2>${safe(properties.name)}</h2>` : '');
    },
    onHover(info) {
      const box = document.getElementById('atn-hover-readout');
      if (!box) return;
      if (!info.edge) {
        box.innerHTML = `<span class="atn-muted">Lat ${info.lat.toFixed(5)}, Lon ${info.lon.toFixed(5)} · Hover road edge for live telemetry</span>`;
        return;
      }
      const st = info.edgeState;
      const spd = st ? `${st.speed_kmh} / ${st.free_flow_kmh} km/h` : `${info.edge.speed_limit_kmh} km/h limit`;
      const qStr = st ? `${st.queue_veh} veh (${st.queue_length_m} m)` : 'Not simulated';
      const statusPill = st?.closed
        ? '<span class="atn-badge danger">CLOSED</span>'
        : st?.access_restricted
          ? '<span class="atn-badge warn">RESTRICTED</span>'
          : '<span class="atn-badge ok">OPEN</span>';
      box.innerHTML = `<strong>${safe(info.edge.name)}</strong> ${statusPill} · ${safe(info.edge.highway)} (${info.edge.oneway ? 'One-way' : 'Bidirectional'}) · Speed: <b>${safe(spd)}</b> · Queue: <b>${safe(qStr)}</b>`;
    },
    onSnapAccepted(snap) {
      simState.pendingSnap = snap;
      simState.statusNotice = {
        kind: 'info',
        text: `Snapped ${snap.disruption_kind} centre to ${snap.snapped_road_name} (${snap.snap_distance_m} m). Confirm or cancel below.`,
      };
      renderPendingConfirm();
      renderStatusBanner();
    },
    onSnapRejected(rej) {
      simState.pendingSnap = null;
      simState.statusNotice = {
        kind: 'error',
        text: rej.reason || 'Clicked location is outside eligible study-area road coverage.',
      };
      renderPendingConfirm();
      renderStatusBanner();
    },
  });

  function renderStatusBanner() {
    const el = document.getElementById('atn-status-banner');
    if (!el) return;
    if (!simState.statusNotice) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.dataset.kind = simState.statusNotice.kind;
    el.textContent = simState.statusNotice.text;
  }

  function renderPendingConfirm() {
    const pop = document.getElementById('atn-confirm-popover');
    if (!pop) return;
    const snap = simState.pendingSnap;
    if (!snap) {
      pop.hidden = true;
      return;
    }
    const kind = snap.disruption_kind;
    const cfg = kind === 'flood' ? simState.flood : simState.demonstration;
    pop.hidden = false;
    pop.innerHTML = `
      <div class="atn-popover-head">
        <span class="atn-badge ${kind === 'flood' ? 'flood' : 'warn'}">${kind === 'flood' ? 'SYNTHETIC FLOOD' : 'SYNTHETIC DEMO'}</span>
        <strong>Confirm Disruption Centre</strong>
      </div>
      <div class="atn-popover-body">
        <div><span>Road segment</span><b>${safe(snap.snapped_road_name)}</b></div>
        <div><span>Snapped coord</span><b>${snap.snapped_lat.toFixed(5)}, ${snap.snapped_lon.toFixed(5)}</b></div>
        <div><span>Snap offset</span><b>${snap.snap_distance_m} m</b></div>
        <label class="atn-inline-range">
          <span>Max intensity I0 (${Math.round(cfg.intensity * 100)}%)</span>
          <input type="range" id="atn-pop-intensity" min="0.15" max="1" step="0.05" value="${cfg.intensity}" />
        </label>
        <label class="atn-inline-range">
          <span>Gaussian spread sigma (${cfg.sigma_m} m)</span>
          <input type="range" id="atn-pop-sigma" min="120" max="900" step="20" value="${cfg.sigma_m}" />
        </label>
        <small class="atn-muted">Synthetic Gaussian scenario only; not an observed measurement.</small>
      </div>
      <div class="atn-popover-actions">
        <button type="button" class="atn-btn ghost" id="atn-pop-cancel">Cancel</button>
        <button type="button" class="atn-btn primary" id="atn-pop-confirm">Confirm &amp; Simulate</button>
      </div>
    `;
    document.getElementById('atn-pop-intensity')?.addEventListener('input', e => {
      cfg.intensity = Number(e.target.value);
      renderControls();
    });
    document.getElementById('atn-pop-sigma')?.addEventListener('input', e => {
      cfg.sigma_m = Number(e.target.value);
      renderControls();
    });
    document.getElementById('atn-pop-cancel')?.addEventListener('click', () => {
      simState.pendingSnap = null;
      simState.placementTarget = null;
      renderer.setDisruptionPlacementMode(null);
      renderPendingConfirm();
      renderControls();
    });
    document.getElementById('atn-pop-confirm')?.addEventListener('click', async () => {
      // Optionally validate with backend when available before applying.
      if (simState.backendMode === 'connected') {
        try {
          await apiRequest(`/api/regions/${simState.regionId}/disruption/validate`, {
            method: 'POST',
            body: { lat: snap.snapped_lat, lon: snap.snapped_lon, disruption_kind: kind },
          });
        } catch (err) {
          simState.statusNotice = { kind: 'error', text: err.message };
          renderStatusBanner();
          return;
        }
      }
      cfg.enabled = true;
      cfg.lat = snap.snapped_lat;
      cfg.lon = snap.snapped_lon;
      cfg.roadName = snap.snapped_road_name;
      if (simState.flood.enabled && simState.demonstration.enabled) simState.disruptionMode = 'both';
      else simState.disruptionMode = kind;
      simState.pendingSnap = null;
      simState.placementTarget = null;
      renderer.setDisruptionPlacementMode(null);
      renderPendingConfirm();
      renderControls();
      await runSimulation();
    });
  }

  function renderControls() {
    document.querySelectorAll('[data-atn-region]').forEach(btn => {
      btn.setAttribute('aria-pressed', String(btn.dataset.atnRegion === simState.regionId));
    });
    document.querySelectorAll('[data-atn-period]').forEach(btn => {
      btn.setAttribute('aria-pressed', String(btn.dataset.atnPeriod === simState.timePeriod));
    });
    document.querySelectorAll('[data-atn-disruption]').forEach(btn => {
      btn.setAttribute('aria-pressed', String(btn.dataset.atnDisruption === simState.disruptionMode));
    });
    document.querySelectorAll('[data-atn-controller]').forEach(btn => {
      btn.setAttribute('aria-pressed', String(btn.dataset.atnController === simState.controller));
    });

    const floodBox = document.getElementById('atn-flood-params');
    const demoBox = document.getElementById('atn-demo-params');
    if (floodBox) floodBox.hidden = !simState.flood.enabled;
    if (demoBox) demoBox.hidden = !simState.demonstration.enabled;

    const fVal = document.getElementById('atn-flood-i-val');
    const fSig = document.getElementById('atn-flood-s-val');
    const fRoad = document.getElementById('atn-flood-road');
    if (fVal) fVal.textContent = `${Math.round(simState.flood.intensity * 100)}%`;
    if (fSig) fSig.textContent = `${simState.flood.sigma_m} m`;
    if (fRoad) fRoad.textContent = simState.flood.roadName || 'Eligible anchor';

    const dVal = document.getElementById('atn-demo-i-val');
    const dSig = document.getElementById('atn-demo-s-val');
    const dRoad = document.getElementById('atn-demo-road');
    if (dVal) dVal.textContent = `${Math.round(simState.demonstration.intensity * 100)}%`;
    if (dSig) dSig.textContent = `${simState.demonstration.sigma_m} m`;
    if (dRoad) dRoad.textContent = simState.demonstration.roadName || 'Eligible anchor';

    const placeFloodBtn = document.getElementById('atn-place-flood');
    const placeDemoBtn = document.getElementById('atn-place-demo');
    if (placeFloodBtn) placeFloodBtn.setAttribute('aria-pressed', String(simState.placementTarget === 'flood'));
    if (placeDemoBtn) placeDemoBtn.setAttribute('aria-pressed', String(simState.placementTarget === 'demonstration'));

    const playBtn = document.getElementById('atn-sim-toggle');
    if (playBtn) playBtn.textContent = simState.playing ? 'Pause' : 'Resume';
    document.querySelectorAll('[data-atn-speed]').forEach(btn => {
      btn.setAttribute('aria-pressed', String(Number(btn.dataset.atnSpeed) === simState.playbackSpeed));
    });

    const backendBadge = document.getElementById('atn-backend-pill');
    if (backendBadge) {
      backendBadge.textContent = simState.backendMode === 'connected'
        ? 'FastAPI Backend Connected'
        : simState.backendMode === 'checking'
          ? 'Checking Backend...'
          : 'Offline Client Fallback (Synthetic)';
      backendBadge.dataset.mode = simState.backendMode;
    }

    const region = getRegion(simState.regionId);
    const subtitle = document.getElementById('atn-region-subtitle');
    if (subtitle) subtitle.textContent = `${region.name} (${region.district}) · ${region.subtitle}`;
  }

  function renderMetricsAndComparison() {
    const res = simState.simResult;
    const metricsGrid = document.getElementById('atn-metrics-grid');
    const compareBox = document.getElementById('atn-comparison-box');
    const adapterBox = document.getElementById('atn-adapter-box');
    const timeline = document.getElementById('atn-timeline-slider');
    const timeReadout = document.getElementById('atn-time-readout');
    const frameSummary = document.getElementById('atn-frame-summary');

    if (!res) {
      if (metricsGrid) metricsGrid.innerHTML = '<div class="atn-muted">Run a simulation to inspect metrics.</div>';
      return;
    }

    const m = res.metrics || {};
    const metricRows = [
      ['Avg travel time', formatMetricValue(m.avg_travel_time_s, ' s')],
      ['Avg delay', formatMetricValue(m.avg_delay_s, ' s')],
      ['95th-pct delay', formatMetricValue(m.p95_delay_s, ' s')],
      ['Throughput', formatMetricValue(m.throughput_vph, ' veh/h')],
      ['Avg queue', formatMetricValue(m.avg_queue_length_veh, ' veh')],
      ['Max queue', formatMetricValue(m.max_queue_length_veh, ' veh')],
      ['Spillback events', formatMetricValue(m.spillback_events, '')],
      ['Reconfig freq', formatMetricValue(m.reconfiguration_freq_per_hr, ' /h')],
      ['Recovery time', formatMetricValue(m.incident_recovery_time_s, ' s')],
    ];
    if (metricsGrid) {
      metricsGrid.innerHTML = metricRows.map(([label, val]) => `
        <div class="atn-kpi">
          <span>${safe(label)}</span>
          <strong class="${val === 'Not available' ? 'na' : ''}">${safe(val)}</strong>
        </div>
      `).join('');
    }

    if (compareBox && res.comparison) {
      const order = ['fixed_time', 'max_pressure', 'gnn_mappo'];
      const delays = order.map(k => Number(res.comparison[k]?.metrics?.avg_delay_s) || 1);
      const maxDelay = Math.max(...delays, 1);
      compareBox.innerHTML = order.map(ctrlId => {
        const item = res.comparison[ctrlId];
        const meta = CONTROLLERS.find(c => c.id === ctrlId);
        const cm = item?.metrics || {};
        const active = ctrlId === simState.controller;
        const pct = Math.min(100, Math.round(((Number(cm.avg_delay_s) || 0) / maxDelay) * 100));
        return `
          <div class="atn-compare-row ${active ? 'active' : ''}">
            <div class="atn-compare-top">
              <span><b>${safe(meta.code)}</b> ${safe(meta.shortName)}${meta.isMock ? ' <em class="atn-mock-tag">MOCK</em>' : ''}</span>
              <strong>${safe(formatMetricValue(cm.avg_delay_s, ' s'))}</strong>
            </div>
            <div class="atn-compare-track"><div class="atn-compare-fill ${ctrlId}" style="width:${pct}%"></div></div>
            <div class="atn-compare-sub">
              <span>Throughput: ${safe(formatMetricValue(cm.throughput_vph, ' vph'))}</span>
              <span>Spillbacks: ${safe(formatMetricValue(cm.spillback_events, ''))}</span>
            </div>
          </div>
        `;
      }).join('');
    }

    if (adapterBox) {
      const ad = res.controller_adapter || {};
      const sup = ad.safety_supervisor || {};
      adapterBox.innerHTML = `
        <div><span>Adapter mode</span><b>${safe(ad.adapter_mode || 'Not available')}</b></div>
        <div><span>Mock inference</span><b>${ad.is_mock ? 'YES (Synthetic surrogate)' : 'Deterministic baseline'}</b></div>
        <div><span>Safety supervisor</span><b>${sup.enforced ? `Enforced (${sup.min_green_s}–${sup.max_green_s}s green)` : 'Not available'}</b></div>
        <div><span>Simulation engine</span><b>${safe(res.provenance?.engine || 'Not available')}</b></div>
        <p class="atn-muted">${safe(ad.diagnostics?.notice || res.provenance?.disclaimer || '')}</p>
      `;
    }

    const totalFrames = (res.frames || []).length;
    if (timeline && totalFrames > 0) {
      timeline.max = String(totalFrames - 1);
      timeline.value = String(Math.min(simState.frameIndex, totalFrames - 1));
    }
    const frame = res.frames?.[Math.min(simState.frameIndex, Math.max(0, totalFrames - 1))];
    if (timeReadout && frame) {
      timeReadout.textContent = `t = ${frame.t_sec}s / ${simState.durationS}s`;
    }
    if (frameSummary && frame) {
      const states = Object.values(frame.edge_states || {});
      const closedCount = states.filter(s => s.closed).length;
      const restrictedCount = states.filter(s => s.access_restricted).length;
      const avgSpd = states.length ? (states.reduce((acc, s) => acc + s.speed_kmh, 0) / states.length).toFixed(1) : '0';
      frameSummary.textContent = `Mean speed ${avgSpd} km/h · Closed segments: ${closedCount} · Restricted: ${restrictedCount}`;
    }
  }

  function startReplayTimer() {
    clearInterval(replayTimer);
    replayTimer = setInterval(() => {
      if (!simState.playing || !simState.simResult?.frames?.length) return;
      const len = simState.simResult.frames.length;
      simState.frameIndex = (simState.frameIndex + 1) % len;
      renderer.setFrameIndex(simState.frameIndex);
      renderMetricsAndComparison();
    }, Math.max(220, Math.round(900 / simState.playbackSpeed)));
  }

  async function runSimulation() {
    if (disposed) return;
    if (runningRequest) {
      queuedRequest = true;
      return;
    }
    runningRequest = true;
    const region = getRegion(simState.regionId);
    const payload = {
      region_id: simState.regionId,
      time_period: simState.timePeriod,
      controller: simState.controller,
      flood: {
        enabled: simState.flood.enabled,
        lat: simState.flood.lat,
        lon: simState.flood.lon,
        intensity: simState.flood.intensity,
        sigma_m: simState.flood.sigma_m,
      },
      demonstration: {
        enabled: simState.demonstration.enabled,
        lat: simState.demonstration.lat,
        lon: simState.demonstration.lon,
        intensity: simState.demonstration.intensity,
        sigma_m: simState.demonstration.sigma_m,
      },
      duration_s: simState.durationS,
      seed: simState.seed,
    };

    try {
      let result = null;
      if (location.protocol !== 'file:') {
        try {
          const resp = await apiRequest('/api/simulation/run', { method: 'POST', body: payload, timeout: 12000 });
          result = resp.result || resp;
          simState.backendMode = 'connected';
        } catch {
          simState.backendMode = 'offline_fallback';
          result = runClientFallbackSimulation(region, payload);
        }
      } else {
        simState.backendMode = 'offline_fallback';
        result = runClientFallbackSimulation(region, payload);
      }

      if (disposed || queuedRequest) return;
      simState.simResult = result;
      simState.frameIndex = 0;
      renderer.setSimulation(result, 0);
      renderer.setPlayback(simState.playing, simState.playbackSpeed);
      renderControls();
      renderMetricsAndComparison();
    } finally {
      runningRequest = false;
      if (queuedRequest && !disposed) {
        queuedRequest = false;
        void runSimulation();
      }
    }
  }

  function switchRegion(regionId) {
    if (!ADAPTIVE_REGIONS_DATA[regionId]) return;
    simState.regionId = regionId;
    simState.simResult = null;
    simState.frameIndex = 0;
    const region = getRegion(regionId);
    syncDisruptionAnchorsForRegion(region);
    // Default disruption preset per region: Pluit highlights flooding; Tanah Abang & Cilandak highlight demonstration.
    if (regionId === 'pluit') {
      simState.disruptionMode = 'flood';
      simState.flood.enabled = true;
      simState.demonstration.enabled = false;
    } else {
      simState.disruptionMode = 'demonstration';
      simState.flood.enabled = false;
      simState.demonstration.enabled = true;
    }
    simState.pendingSnap = null;
    simState.placementTarget = null;
    simState.statusNotice = { kind: 'info', text: `Loaded ${region.name} (${region.stats.directed_edges} directed OSM road edges).` };
    renderer.setDisruptionPlacementMode(null);
    renderer.setRegion(region);
    updateCameraButtons(renderer.getCamera?.());
    showSelection('');
    renderPendingConfirm();
    renderStatusBanner();
    renderControls();
    runSimulation();
  }

  // Bind UI events
  root.querySelectorAll('[data-atn-region]').forEach(btn => {
    btn.addEventListener('click', () => switchRegion(btn.dataset.atnRegion));
  });
  root.querySelectorAll('[data-atn-period]').forEach(btn => {
    btn.addEventListener('click', () => {
      simState.timePeriod = btn.dataset.atnPeriod;
      renderControls();
      runSimulation();
    });
  });
  root.querySelectorAll('[data-atn-controller]').forEach(btn => {
    btn.addEventListener('click', () => {
      simState.controller = btn.dataset.atnController;
      renderControls();
      runSimulation();
    });
  });
  root.querySelectorAll('[data-atn-disruption]').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.atnDisruption;
      simState.disruptionMode = mode;
      simState.flood.enabled = mode === 'flood' || mode === 'both';
      simState.demonstration.enabled = mode === 'demonstration' || mode === 'both';
      simState.placementTarget = null;
      renderer.setDisruptionPlacementMode(null);
      renderControls();
      runSimulation();
    });
  });

  document.getElementById('atn-place-flood')?.addEventListener('click', () => {
    simState.placementTarget = simState.placementTarget === 'flood' ? null : 'flood';
    renderer.setDisruptionPlacementMode(simState.placementTarget);
    simState.statusNotice = simState.placementTarget
      ? { kind: 'info', text: 'Click an eligible flood corridor on the map (highlighted in cyan).' }
      : null;
    renderStatusBanner();
    renderControls();
  });

  document.getElementById('atn-place-demo')?.addEventListener('click', () => {
    simState.placementTarget = simState.placementTarget === 'demonstration' ? null : 'demonstration';
    renderer.setDisruptionPlacementMode(simState.placementTarget);
    simState.statusNotice = simState.placementTarget
      ? { kind: 'info', text: 'Click an eligible demonstration corridor on the map (highlighted in amber).' }
      : null;
    renderStatusBanner();
    renderControls();
  });

  document.getElementById('atn-flood-intensity')?.addEventListener('input', e => {
    simState.flood.intensity = Number(e.target.value);
    renderControls();
  });
  document.getElementById('atn-flood-intensity')?.addEventListener('change', runSimulation);
  document.getElementById('atn-flood-sigma')?.addEventListener('input', e => {
    simState.flood.sigma_m = Number(e.target.value);
    renderControls();
  });
  document.getElementById('atn-flood-sigma')?.addEventListener('change', runSimulation);

  document.getElementById('atn-demo-intensity')?.addEventListener('input', e => {
    simState.demonstration.intensity = Number(e.target.value);
    renderControls();
  });
  document.getElementById('atn-demo-intensity')?.addEventListener('change', runSimulation);
  document.getElementById('atn-demo-sigma')?.addEventListener('input', e => {
    simState.demonstration.sigma_m = Number(e.target.value);
    renderControls();
  });
  document.getElementById('atn-demo-sigma')?.addEventListener('change', runSimulation);

  document.getElementById('atn-sim-run')?.addEventListener('click', () => {
    simState.playing = true;
    runSimulation();
  });
  document.getElementById('atn-sim-toggle')?.addEventListener('click', () => {
    simState.playing = !simState.playing;
    renderer.setPlayback(simState.playing, simState.playbackSpeed);
    renderControls();
  });
  document.getElementById('atn-sim-replay')?.addEventListener('click', () => {
    simState.frameIndex = 0;
    simState.playing = true;
    renderer.setFrameIndex(0);
    renderer.setPlayback(true, simState.playbackSpeed);
    renderControls();
    renderMetricsAndComparison();
  });
  document.getElementById('atn-sim-reset')?.addEventListener('click', () => {
    const region = getRegion(simState.regionId);
    syncDisruptionAnchorsForRegion(region);
    simState.disruptionMode = 'normal';
    simState.flood.enabled = false;
    simState.demonstration.enabled = false;
    simState.pendingSnap = null;
    simState.placementTarget = null;
    simState.statusNotice = { kind: 'info', text: 'Reset scenario to Normal baseline conditions.' };
    renderer.setDisruptionPlacementMode(null);
    renderPendingConfirm();
    renderStatusBanner();
    renderControls();
    runSimulation();
  });

  root.querySelectorAll('[data-atn-speed]').forEach(btn => {
    btn.addEventListener('click', () => {
      simState.playbackSpeed = Number(btn.dataset.atnSpeed) || 1;
      renderer.setPlayback(simState.playing, simState.playbackSpeed);
      startReplayTimer();
      renderControls();
    });
  });

  document.getElementById('atn-timeline-slider')?.addEventListener('input', e => {
    simState.frameIndex = Number(e.target.value) || 0;
    renderer.setFrameIndex(simState.frameIndex);
    renderMetricsAndComparison();
  });

  document.getElementById('atn-zoom-in')?.addEventListener('click', () => renderer.zoomIn());
  document.getElementById('atn-zoom-out')?.addEventListener('click', () => renderer.zoomOut());
  const cameras = [...root.querySelectorAll('[data-atn-camera]')];
  function updateCameraButtons(mode) {
    cameras.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.atnCamera === mode)));
  }
  cameras.forEach(button => {
    button.disabled = !renderer.setCamera;
    button.addEventListener('click', () => {
      renderer.setCamera(button.dataset.atnCamera);
      updateCameraButtons(button.dataset.atnCamera);
    });
  });
  document.getElementById('atn-zoom-reset')?.addEventListener('click', () => {
    renderer.resetView();
    updateCameraButtons(renderer.getCamera?.());
  });
  document.getElementById('atn-clear-selection').addEventListener('click', () => {
    renderer.clearSelection?.();
    showSelection('');
    mapHost.querySelector('canvas[tabindex]')?.focus();
  });
  bindMapSearch(root, ADAPTIVE_REGIONS_DATA, id => {
    if (id !== simState.regionId) switchRegion(id);
  }, location => renderer.focusLocation(location));
  if (window.matchMedia('(max-width: 850px)').matches) {
    root.querySelector('.atn-left').open = false;
    root.querySelector('.atn-right').open = false;
  }
  document.getElementById('atn-immersive-toggle')?.addEventListener('click', () => {
    simState.immersive = !simState.immersive;
    document.body.classList.toggle('atn-immersive', simState.immersive);
    const btn = document.getElementById('atn-immersive-toggle');
    if (btn) btn.textContent = simState.immersive ? 'Exit Fullscreen' : 'Fullscreen Map';
    setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
  });

  root.querySelectorAll('[data-atn-layer]').forEach(chk => {
    if (chk.dataset.atnLayer === 'buildings' && !renderer.setCamera) chk.disabled = true;
    chk.addEventListener('change', () => {
      simState.layers[chk.dataset.atnLayer] = chk.checked;
      renderer.setLayers(simState.layers);
    });
  });

  const provEl = document.getElementById('atn-provenance-summary');
  if (provEl) {
    const ds = ADAPTIVE_PROVENANCE_MANIFEST.datasets || {};
    provEl.innerHTML = `
      <div><span>Road geometry</span><b>${safe(ds.osm_road_network?.source || 'OpenStreetMap')} (${safe(ds.osm_road_network?.license || 'ODbL 1.0')})</b></div>
      <div><span>GTFS transit</span><b>${safe(ds.transjakarta_gtfs?.classification || 'Missing local archive; OSM stops used')}</b></div>
      <div><span>Grab-Posisi / DKI</span><b>${safe(ds.grab_posisi_and_dkijakarta_sensors?.status || 'not_integrated')}</b></div>
      <div><span>Render engine</span><b>${safe(renderer.getRenderEngine())}</b></div>
    `;
  }

  // Initial load
  renderer.setRegion(getRegion(simState.regionId));
  updateCameraButtons(renderer.getCamera?.());
  renderControls();
  renderStatusBanner();
  runSimulation();
  startReplayTimer();

  activeInstance = {
    destroy() {
      disposed = true;
      clearInterval(replayTimer);
      renderer.destroy();
    },
  };
}
