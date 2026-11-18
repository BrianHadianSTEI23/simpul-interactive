import { ADAPTIVE_REGIONS_DATA } from './adaptive-regions-data.js';
import { TIME_PERIODS, CONTROLLERS } from './adaptive-model.js';
import { safe, icon } from './util.js';

export function renderAdaptiveView() {
  const regions = Object.values(ADAPTIVE_REGIONS_DATA);
  return `
  <div class="atn-shell" id="atn-workspace">
    <header class="atn-topbar">
      <div class="atn-brand-block">
        <span class="atn-brand-mark" aria-hidden="true">S</span>
        <div><h1>SIMPUL</h1><small>Jakarta Traffic Simulator</small></div>
      </div>
      <form id="atn-search" class="atn-search" role="search">
        <input type="search" aria-label="Search study areas, roads, and stops" placeholder="Search roads, stops, landmarks…" autocomplete="off" />
        <button type="submit">Search</button>
        <div class="atn-search-results" hidden></div>
      </form>
      <div class="atn-top-badges">
        <span class="atn-pill synth">Synthetic traffic simulation</span>
        <span class="atn-pill" id="atn-backend-pill" data-mode="checking">Checking Backend...</span>
      </div>
    </header>

    <div class="atn-status-banner" id="atn-status-banner" role="status" aria-live="polite" hidden></div>

    <div class="atn-main-grid">
      <details class="atn-panel atn-left" open><summary>Scenario &amp; layers</summary>
        <section class="atn-section">
          <div class="atn-section-head"><span>Study area</span></div>
          <div class="atn-btn-grid three">
            ${regions.map(r => `<button type="button" class="atn-chip" data-atn-region="${safe(r.id)}" aria-pressed="${r.id === 'pluit'}">${safe(r.name)}</button>`).join('')}
          </div>
          <small id="atn-region-subtitle"></small>
        </section>

        <section class="atn-section">
          <div class="atn-section-head"><span>Time period</span><small>WIB Demand</small></div>
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
          <div class="atn-section-head"><span>Disruptions</span><small>Gaussian Mask</small></div>
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
          <div class="atn-section-head"><span>Controller</span><small>B1 / B2 / B3</small></div>
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
          <div class="atn-section-head"><span>Playback</span><small>Playback</small></div>
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
        <section class="atn-section">
          <div class="atn-section-head">Map layers</div>
          <div class="atn-layer-bar">
            <label><input type="checkbox" data-atn-layer="vehicles" checked /> Vehicles</label>
            <label><input type="checkbox" data-atn-layer="gaussian" checked /> Gaussian field</label>
            <label><input type="checkbox" data-atn-layer="signals" checked /> Traffic lights</label>
            <label><input type="checkbox" data-atn-layer="transit" checked /> Transit</label>
            <label><input type="checkbox" data-atn-layer="coverage" checked /> Coverage mask</label>
            <label><input type="checkbox" data-atn-layer="labels" checked /> Landmarks</label>
          </div>
        </section>
      </details>

      <main class="atn-map-stage">
        <div class="atn-map-toolbar">
          <div class="atn-hover-readout" id="atn-hover-readout">Select a road or marker for details.</div>
          <div class="atn-map-tools" role="group" aria-label="Map camera">
            <button type="button" class="atn-btn sm" data-atn-camera="2d" aria-pressed="true">2D</button>
            <button type="button" class="atn-btn sm" data-atn-camera="3d" aria-pressed="false">Tilt</button>
            <button type="button" class="atn-btn sm" data-atn-camera="overview" aria-pressed="false">Overview</button>
            <button type="button" class="atn-icon-btn" id="atn-zoom-in" aria-label="Zoom in">+</button>
            <button type="button" class="atn-icon-btn" id="atn-zoom-out" aria-label="Zoom out">-</button>
            <button type="button" class="atn-btn ghost sm" id="atn-zoom-reset">Reset view</button>
          </div>
        </div>

        <div class="atn-canvas-wrap">
          <div id="atn-map-canvas-host" class="atn-canvas-host" role="region" aria-label="Interactive Jakarta adaptive traffic network map"></div>
          <div id="atn-traffic-events" class="atn-traffic-events" hidden></div>
          <span id="atn-map-status" role="status">Loading map…</span>
          <aside class="atn-selection" id="atn-selection" aria-label="Map selection" hidden>
            <div class="atn-selection-head">
              <span class="atn-selection-heading" id="atn-selection-heading">Details</span>
              <div class="atn-selection-actions">
                <button type="button" class="atn-selection-toggle" id="atn-toggle-selection" aria-expanded="true" aria-controls="atn-selection-content">Hide</button>
                <button type="button" class="atn-selection-close" id="atn-clear-selection" aria-label="Close selection">×</button>
              </div>
            </div>
            <div class="atn-selection-content" id="atn-selection-content" aria-live="off"></div>
          </aside>
          <div class="atn-confirm-popover" id="atn-confirm-popover" hidden></div>



          <details class="atn-legend" id="atn-legend" aria-label="Traffic flow and disruption legend" open>
            <summary class="atn-legend-title">Traffic &amp; disruptions</summary>
            <div class="atn-legend-items">
              <span><i class="sw vehicle"></i> Simulated vehicle</span>
              <span><i class="sw free"></i> Free flow</span>
              <span><i class="sw mod"></i> Moderate load</span>
              <span><i class="sw cong"></i> Congested</span>
              <span><i class="sw severe"></i> Severe</span>
              <span><i class="sw closed"></i> Closed segment</span>
              <span><i class="sw flood"></i> Flood Gaussian (I_e)</span>
              <span><i class="sw demo"></i> Demo Gaussian (I_e)</span>
              <span><i class="sw mrt"></i> Stations / activity hotspots</span>
              <span><i class="sw signal"></i> Green / yellow / red signal</span>
              <span><i class="sw turn"></i> Diverted turn</span>
              <span><i class="sw block"></i> Blocked turn</span>
            </div>
          </details>
          <a class="atn-osm-credit" href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>
        </div>

        <div class="atn-timeline-bar">
          <span class="atn-time-readout" id="atn-time-readout">t = 0s / 600s</span>
          <input type="range" id="atn-timeline-slider" min="0" max="20" step="1" value="0" aria-label="Simulation replay timeline" />
          <span class="atn-frame-summary" id="atn-frame-summary">Preparing simulation...</span>
        </div>
      </main>

      <details class="atn-panel atn-right" open><summary>Simulation report</summary>
        <section class="atn-section">
          <div class="atn-section-head"><span>Simulation metrics</span><small>Active Run</small></div>
          <div class="atn-kpi-grid" id="atn-metrics-grid"></div>
        </section>

        <section class="atn-section">
          <div class="atn-section-head"><span>Controller comparison</span><small>Avg Delay (s)</small></div>
          <div class="atn-compare-list" id="atn-comparison-box"></div>
        </section>

      </details>
    </div>
  </div>
  `;
}
