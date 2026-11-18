import { ADAPTIVE_REGIONS_DATA } from './adaptive-regions-data.js';
import { TIME_PERIODS, CONTROLLERS } from './adaptive-model.js';
import { safe, icon } from './util.js';

export function renderAdaptiveView() {
  const regions = Object.values(ADAPTIVE_REGIONS_DATA);
  return `
  <div class="atn-shell" id="atn-workspace">
    <header class="atn-topbar">
      <div class="atn-brand-block">
        <span class="atn-eyebrow">JAKARTA ADAPTIVE TRAFFIC NETWORK · RESEARCH SIMULATOR</span>
        <h1>Adaptive Network Flow &amp; Disruption Observatory</h1>
        <small id="atn-region-subtitle">Pluit (Jakarta Utara) · Jl. Muara Baru · Pluit Sea View · Waduk Pluit · Penjaringan</small>
      </div>
      <div class="atn-region-tabs" role="group" aria-label="Study area selection">
        ${regions.map(r => `
          <button type="button" class="atn-tab" data-atn-region="${safe(r.id)}" aria-pressed="${r.id === 'pluit'}">
            <strong>${safe(r.name)}</strong>
            <span>${safe(r.district)}</span>
          </button>
        `).join('')}
      </div>
      <div class="atn-top-badges">
        <span class="atn-pill synth">OSM Real Geometry · Synthetic Flow &amp; Gaussian</span>
        <span class="atn-pill" id="atn-backend-pill" data-mode="checking">Checking Backend...</span>
      </div>
    </header>

    <div class="atn-status-banner" id="atn-status-banner" role="status" aria-live="polite" hidden></div>

    <div class="atn-main-grid">
      <aside class="atn-panel atn-left" aria-label="Scenario controls">
        <section class="atn-section">
          <div class="atn-section-head"><span>A · STUDY AREA</span><small>OSM Filtered</small></div>
          <div class="atn-btn-grid three">
            ${regions.map(r => `<button type="button" class="atn-chip" data-atn-region="${safe(r.id)}" aria-pressed="${r.id === 'pluit'}">${safe(r.name)}</button>`).join('')}
          </div>
        </section>

        <section class="atn-section">
          <div class="atn-section-head"><span>B · TIME PERIOD</span><small>WIB Demand</small></div>
          <div class="atn-btn-grid three">
            ${TIME_PERIODS.map(p => `
              <button type="button" class="atn-chip" data-atn-period="${p.id}" aria-pressed="${p.id === 'pagi'}">
                <b>${p.label}</b>
                <small>${p.hours}</small>
              </button>
            `).join('')}
          </div>
        </section>

        <section class="atn-section">
          <div class="atn-section-head"><span>C · DISRUPTIONS</span><small>Gaussian Mask</small></div>
          <div class="atn-btn-grid two">
            <button type="button" class="atn-chip" data-atn-disruption="normal" aria-pressed="false">Normal</button>
            <button type="button" class="atn-chip" data-atn-disruption="flood" aria-pressed="true">Flooding</button>
            <button type="button" class="atn-chip" data-atn-disruption="demonstration" aria-pressed="false">Demonstration</button>
            <button type="button" class="atn-chip" data-atn-disruption="both" aria-pressed="false">Flood + Demo</button>
          </div>
          <div class="atn-place-row">
            <button type="button" class="atn-btn flood-outline" id="atn-place-flood" aria-pressed="false">${icon('map-pinned', 14)} Click map: Flood</button>
            <button type="button" class="atn-btn warn-outline" id="atn-place-demo" aria-pressed="false">${icon('map-pinned', 14)} Click map: Demo</button>
          </div>
          <div class="atn-param-box" id="atn-flood-params">
            <div class="atn-param-title"><span class="dot flood"></span>Flood Impact (Synthetic) <small id="atn-flood-road">Jl. Muara Baru</small></div>
            <label><span>Max Intensity I0 <b id="atn-flood-i-val">78%</b></span><input type="range" id="atn-flood-intensity" min="0.15" max="1" step="0.05" value="0.78" /></label>
            <label><span>Spread sigma <b id="atn-flood-s-val">460 m</b></span><input type="range" id="atn-flood-sigma" min="120" max="900" step="20" value="460" /></label>
          </div>
          <div class="atn-param-box" id="atn-demo-params" hidden>
            <div class="atn-param-title"><span class="dot demo"></span>Demonstration Impact (Synthetic) <small id="atn-demo-road">Corridor</small></div>
            <label><span>Max Intensity I0 <b id="atn-demo-i-val">72%</b></span><input type="range" id="atn-demo-intensity" min="0.15" max="1" step="0.05" value="0.72" /></label>
            <label><span>Spread sigma <b id="atn-demo-s-val">380 m</b></span><input type="range" id="atn-demo-sigma" min="120" max="900" step="20" value="380" /></label>
          </div>
        </section>

        <section class="atn-section">
          <div class="atn-section-head"><span>D · CONTROLLER</span><small>B1 / B2 / B3</small></div>
          <div class="atn-ctrl-list">
            ${CONTROLLERS.map(c => `
              <button type="button" class="atn-ctrl-btn" data-atn-controller="${c.id}" aria-pressed="${c.id === 'gnn_mappo'}">
                <div class="atn-ctrl-head">
                  <span class="atn-code">${c.code}</span>
                  <strong>${c.name}</strong>
                  ${c.isMock ? '<span class="atn-mock-tag">MOCK</span>' : ''}
                </div>
                <small>${c.description}</small>
              </button>
            `).join('')}
          </div>
        </section>

        <section class="atn-section">
          <div class="atn-section-head"><span>E · SIMULATION</span><small>Playback</small></div>
          <div class="atn-sim-actions">
            <button type="button" class="atn-btn primary" id="atn-sim-run">${icon('play', 14)} Run</button>
            <button type="button" class="atn-btn ghost" id="atn-sim-toggle">Pause</button>
            <button type="button" class="atn-btn ghost" id="atn-sim-replay">Replay</button>
            <button type="button" class="atn-btn ghost" id="atn-sim-reset">Reset</button>
          </div>
          <div class="atn-speed-row">
            <span>Speed</span>
            ${[0.5, 1, 2, 4].map(sp => `<button type="button" class="atn-speed-btn" data-atn-speed="${sp}" aria-pressed="${sp === 1}">${sp}x</button>`).join('')}
          </div>
        </section>
      </aside>

      <main class="atn-map-stage">
        <div class="atn-map-toolbar">
          <div class="atn-hover-readout" id="atn-hover-readout">Hover road edge for live speed, queue, and eligibility telemetry.</div>
          <div class="atn-map-tools">
            <button type="button" class="atn-icon-btn" id="atn-zoom-in" aria-label="Zoom in">+</button>
            <button type="button" class="atn-icon-btn" id="atn-zoom-out" aria-label="Zoom out">-</button>
            <button type="button" class="atn-btn ghost sm" id="atn-zoom-reset">Reset View</button>
          </div>
        </div>

        <div class="atn-canvas-wrap">
          <div id="atn-map-canvas-host" class="atn-canvas-host" role="region" aria-label="Interactive Jakarta adaptive traffic network map"></div>
          <div class="atn-confirm-popover" id="atn-confirm-popover" hidden></div>

          <div class="atn-layer-bar">
            <label><input type="checkbox" data-atn-layer="gaussian" checked /> Gaussian field</label>
            <label><input type="checkbox" data-atn-layer="signals" checked /> Signals</label>
            <label><input type="checkbox" data-atn-layer="transit" checked /> Transit</label>
            <label><input type="checkbox" data-atn-layer="coverage" checked /> Coverage mask</label>
            <label><input type="checkbox" data-atn-layer="labels" checked /> Landmarks</label>
          </div>

          <div class="atn-legend" aria-label="Traffic flow and disruption legend">
            <div class="atn-legend-title">FLOW &amp; DISRUPTION ENCODING</div>
            <div class="atn-legend-items">
              <span><i class="sw free"></i> Free-flow stream</span>
              <span><i class="sw mod"></i> Moderate load</span>
              <span><i class="sw cong"></i> Congested / queue</span>
              <span><i class="sw closed"></i> Closed segment</span>
              <span><i class="sw flood"></i> Flood Gaussian (I_e)</span>
              <span><i class="sw demo"></i> Demo Gaussian (I_e)</span>
              <span><i class="sw mrt"></i> MRT / Rail / Bus</span>
            </div>
          </div>
        </div>

        <div class="atn-timeline-bar">
          <span class="atn-time-readout" id="atn-time-readout">t = 0s / 600s</span>
          <input type="range" id="atn-timeline-slider" min="0" max="20" step="1" value="0" aria-label="Simulation replay timeline" />
          <span class="atn-frame-summary" id="atn-frame-summary">Preparing simulation...</span>
        </div>
      </main>

      <aside class="atn-panel atn-right" aria-label="Simulation statistics and comparison">
        <section class="atn-section">
          <div class="atn-section-head"><span>SIMULATION METRICS</span><small>Active Run</small></div>
          <div class="atn-kpi-grid" id="atn-metrics-grid"></div>
        </section>

        <section class="atn-section">
          <div class="atn-section-head"><span>CONTROLLER COMPARISON</span><small>Avg Delay (s)</small></div>
          <div class="atn-compare-list" id="atn-comparison-box"></div>
        </section>

        <section class="atn-section">
          <div class="atn-section-head"><span>MODEL ADAPTER &amp; SUPERVISOR</span><small>Contract</small></div>
          <div class="atn-kv-box" id="atn-adapter-box"></div>
        </section>

        <section class="atn-section">
          <div class="atn-section-head"><span>DATA PROVENANCE</span><small>Manifest</small></div>
          <div class="atn-kv-box" id="atn-provenance-summary"></div>
        </section>
      </aside>
    </div>
  </div>
  `;
}
