import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ADAPTIVE_REGIONS_DATA,
  ADAPTIVE_PROVENANCE_MANIFEST,
  ADAPTIVE_CORRIDOR_CONNECTIONS,
} from '../public/js/adaptive-regions-data.js';
import { buildConnectedRegion } from '../public/js/connected-network.js';
import {
  TIME_PERIODS,
  CONTROLLERS,
  snapDisruptionLocation,
  computeGaussianImpactField,
  runClientFallbackSimulation,
  formatMetricValue,
} from '../public/js/adaptive-model.js';
import { renderAdaptiveView } from '../public/js/adaptive-view.js';

const ALL_REGION_IDS = [
  'pluit',
  'tambora',
  'tomang_harmoni',
  'tanah_abang',
  'sudirman_senayan',
  'kebayoran_baru',
  'kemang_cipete',
  'cilandak',
];

for (const rid of ALL_REGION_IDS) {
  const region = ADAPTIVE_REGIONS_DATA[rid];
  assert.ok(region, `Missing region ${rid}`);
  assert.ok(region.edges.length >= 100);
  assert.ok(region.intersections.length >= 20);
  assert.ok(region.coverage_mask.length >= 4);
  assert.ok(region.study_boundary.length >= 4);
  assert.ok(region.transit_stops.length >= 5);

  const primaryKind = region.primary_disruption || 'demonstration';
  const anchor = region.disruption_anchors[primaryKind];
  const snap = snapDisruptionLocation(region, anchor.lat, anchor.lon, primaryKind, 200);
  assert.equal(snap.accepted, true, `Snap failed for ${rid}`);

  const simRegion = runClientFallbackSimulation(region, {
    region_id: rid,
    time_period: 'pagi',
    controller: 'gnn_mappo',
    flood: primaryKind === 'flood'
      ? { enabled: true, lat: snap.snapped_lat, lon: snap.snapped_lon, intensity: 0.8, sigma_m: 420 }
      : { enabled: false },
    demonstration: primaryKind === 'demonstration'
      ? { enabled: true, lat: snap.snapped_lat, lon: snap.snapped_lon, intensity: 0.8, sigma_m: 400 }
      : { enabled: false },
    duration_s: 360,
    seed: 42,
  });
  assert.ok(simRegion.frames.length >= 10, `Missing frames for ${rid}`);
  assert.ok(
    simRegion.comparison.gnn_mappo.metrics.avg_delay_s < simRegion.comparison.fixed_time.metrics.avg_delay_s,
    `Expected GNN-MAPPO to beat Fixed-Time in ${rid}`
  );
}

// Verify real-world OSM street connections between every adjacent pair from Pluit to Cilandak
assert.equal(ADAPTIVE_CORRIDOR_CONNECTIONS.pairs.length, ALL_REGION_IDS.length - 1);
for (const pair of ADAPTIVE_CORRIDOR_CONNECTIONS.pairs) {
  assert.equal(pair.connected, true, `Disconnected pair: ${pair.north_region_id} <-> ${pair.south_region_id}`);
  assert.ok(pair.shared_osm_way_count >= 3, `Too few shared OSM ways for ${pair.north_region_id} <-> ${pair.south_region_id}`);
  assert.ok(pair.shared_osm_node_count >= 3, `Too few shared OSM nodes for ${pair.north_region_id} <-> ${pair.south_region_id}`);
  const northWays = new Set(ADAPTIVE_REGIONS_DATA[pair.north_region_id].edges.map(e => e.osm_way_id));
  const southWays = new Set(ADAPTIVE_REGIONS_DATA[pair.south_region_id].edges.map(e => e.osm_way_id));
  for (const conn of pair.connectors) {
    assert.ok(northWays.has(conn.osm_way_id) && southWays.has(conn.osm_way_id), `Connector ${conn.road_name} missing in adjacent region`);
  }
}

assert.ok(ADAPTIVE_REGIONS_DATA.tanah_abang.edges.some(e => e.name.toLowerCase().includes('jatibaru')));
assert.ok(ADAPTIVE_REGIONS_DATA.tanah_abang.edges.some(e => e.name.toLowerCase().includes('fachrudin')));
assert.ok(ADAPTIVE_REGIONS_DATA.tanah_abang.edges.some(e => e.name.toLowerCase().includes('mas mansyur')));
assert.ok(ADAPTIVE_REGIONS_DATA.cilandak.edges.some(e => e.name.toLowerCase().includes('simatupang')));
assert.ok(ADAPTIVE_REGIONS_DATA.cilandak.edges.some(e => e.name.toLowerCase().includes('fatmawati')));
assert.ok(ADAPTIVE_REGIONS_DATA.pluit.edges.some(e => e.name.toLowerCase().includes('muara baru')));
assert.equal(ADAPTIVE_PROVENANCE_MANIFEST.datasets.osm_road_network.license, 'ODbL 1.0 (© OpenStreetMap contributors)');

const pluit = ADAPTIVE_REGIONS_DATA.pluit;
const muaraBaruAnchor = pluit.disruption_anchors.flood;
const validSnap = snapDisruptionLocation(pluit, muaraBaruAnchor.lat + 0.0002, muaraBaruAnchor.lon - 0.0002, 'flood', 200);
assert.equal(validSnap.accepted, true);
assert.equal(snapDisruptionLocation(pluit, -6.29247, 106.79245, 'flood', 200).accepted, false);
assert.equal(snapDisruptionLocation(pluit, -6.1178, 106.7955, 'flood', 90).accepted, false);

const impactsFlood = computeGaussianImpactField(
  pluit,
  { enabled: true, lat: muaraBaruAnchor.lat, lon: muaraBaruAnchor.lon, intensity: 0.90, sigma_m: 350 },
  { enabled: false },
);
assert.equal(impactsFlood[muaraBaruAnchor.edge_id].closed, true);

const impactsDemo = computeGaussianImpactField(
  pluit,
  { enabled: false },
  { enabled: true, lat: muaraBaruAnchor.lat, lon: muaraBaruAnchor.lon, intensity: 0.85, sigma_m: 350 },
);
assert.equal(impactsDemo[muaraBaruAnchor.edge_id].closed, false);
assert.equal(impactsDemo[muaraBaruAnchor.edge_id].access_restricted, true);

assert.equal(formatMetricValue(null, ' s'), 'Not available');
assert.equal(formatMetricValue(undefined, ' s'), 'Not available');

const sim = runClientFallbackSimulation(pluit, {
  region_id: 'pluit',
  time_period: 'pagi',
  controller: 'gnn_mappo',
  flood: { enabled: true, lat: validSnap.snapped_lat, lon: validSnap.snapped_lon, intensity: 0.85, sigma_m: 440 },
  demonstration: { enabled: false },
  duration_s: 600,
  seed: 42,
});
assert.equal(sim.provenance.is_synthetic, true);
assert.equal(sim.provenance.is_mock_controller, true);
assert.ok(sim.frames.length >= 10);
assert.ok(sim.comparison.gnn_mappo.metrics.avg_delay_s < sim.comparison.fixed_time.metrics.avg_delay_s);
assert.ok(TIME_PERIODS.length === 3 && CONTROLLERS.length === 3);

const html = renderAdaptiveView();
assert.ok(html.includes('Tanah Abang') && html.includes('Cilandak') && html.includes('Pluit'));
assert.ok(html.includes('Tambora') && html.includes('Tomang') && html.includes('Sudirman') && html.includes('Kebayoran Baru') && html.includes('Kemang'));
assert.ok(html.includes('<details class="atn-legend" id="atn-legend"'));
assert.ok(html.includes('<summary class="atn-legend-title">Traffic &amp; disruptions</summary>'));
assert.ok(html.includes('id="atn-toggle-selection"') && html.includes('id="atn-clear-selection"'));
assert.ok(html.includes('./assets/simpul-logo.png'));
assert.ok(
  html.includes('./assets/partner-us-mission.png')
  && html.includes('./assets/partner-itb.png')
  && html.includes('./assets/partner-aiera.png')
);

const trainedWeights = JSON.parse(fs.readFileSync(new URL('../public/data/model_weights.json', import.meta.url), 'utf8'));
const trainedSim = runClientFallbackSimulation(pluit, {
  region_id: 'pluit',
  time_period: 'pagi',
  controller: 'gnn_mappo',
  flood: { enabled: true, lat: validSnap.snapped_lat, lon: validSnap.snapped_lon, intensity: 0.85, sigma_m: 440 },
  demonstration: { enabled: false },
  duration_s: 360,
  seed: 42,
}, trainedWeights);
assert.equal(trainedSim.provenance.is_mock_controller, false);
assert.equal(trainedSim.frames[0].movement_policy, 'meshgraphnet');
assert.ok(Object.keys(trainedSim.frames[0].turn_actions).length > 0);
assert.ok(Object.keys(trainedSim.frames[0].signage_states).length > 0);

const connected = buildConnectedRegion(ADAPTIVE_REGIONS_DATA);
assert.equal(connected.id, 'all');
assert.equal(connected.component_regions.length, 8);
assert.ok(connected.edges.some(e => e.is_inter_region_connector));
assert.ok(connected.intersections.some(i => i.is_gateway));
assert.ok(connected.signage_nodes.length >= 100);
assert.equal(snapDisruptionLocation(connected, -6.1520, 106.8550, 'flood', 200).accepted, false);
assert.equal(snapDisruptionLocation(connected, muaraBaruAnchor.lat, muaraBaruAnchor.lon, 'flood', 200).accepted, true);
assert.equal(
  snapDisruptionLocation(connected, ADAPTIVE_REGIONS_DATA.sudirman_senayan.disruption_anchors.demonstration.lat, ADAPTIVE_REGIONS_DATA.sudirman_senayan.disruption_anchors.demonstration.lon, 'demonstration', 200).accepted,
  true,
);

const connectedSim = runClientFallbackSimulation(connected, {
  region_id: 'all',
  time_period: 'pagi',
  controller: 'gnn_mappo',
  flood: { enabled: true, lat: muaraBaruAnchor.lat, lon: muaraBaruAnchor.lon, intensity: 0.80, sigma_m: 450 },
  demonstration: { enabled: false },
  duration_s: 240,
  seed: 42,
}, trainedWeights);
assert.equal(connectedSim.frames[0].movement_policy, 'meshgraphnet');
assert.ok(Object.keys(connectedSim.frames[2].signage_states).length >= 100);
assert.ok(connectedSim.comparison.gnn_mappo.metrics.avg_delay_s < connectedSim.comparison.fixed_time.metrics.avg_delay_s);
assert.ok(html.includes('All Areas Connected'));

console.log('PASS simpul-interactive JS suite');
