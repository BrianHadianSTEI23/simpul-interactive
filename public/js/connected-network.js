/**
 * Browser & Node builder for the unified 3-region Jakarta corridor graph
 * (Pluit ↔ Tanah Abang ↔ Cilandak) and dynamic VMS junction signage.
 *
 * Mirrors backend/connected_network.py + data/connected_corridors.json so offline fallback
 * and MapLibre rendering share exact edge/node/movement IDs and topological connectivity.
 */

export const CONNECTED_CORRIDORS_SPEC = {
  id: 'all',
  name: 'All Connected (Pluit ↔ Tanah Abang ↔ Cilandak)',
  district: 'Jakarta Utara · Jakarta Pusat · Jakarta Selatan',
  subtitle: 'Coupled 3-region corridor network · Disruptions strictly scoped to Pluit, Tanah Abang & Cilandak',
  hubs: [
    { node_id: 'conn-n0001', name: 'Simpang Glodok / Kota', lat: -6.1425, lon: 106.8148, signalized: true },
    { node_id: 'conn-n0002', name: 'Simpang Gajah Mada / Harmoni', lat: -6.1618, lon: 106.8194, signalized: true },
    { node_id: 'conn-n0003', name: 'Simpang Jembatan Tiga / Latumeten', lat: -6.1445, lon: 106.7905, signalized: true },
    { node_id: 'conn-n0004', name: 'Simpang Grogol / Roxy Mas', lat: -6.1650, lon: 106.8015, signalized: true },
    { node_id: 'conn-n0005', name: 'Simpang Semanggi / Dukuh Atas', lat: -6.2205, lon: 106.8145, signalized: true },
    { node_id: 'conn-n0006', name: 'Simpang CSW / Blok M – Antasari', lat: -6.2565, lon: 106.8035, signalized: true },
    { node_id: 'conn-n0007', name: 'Simpang Slipi / Senayan Barat', lat: -6.2155, lon: 106.7955, signalized: true },
    { node_id: 'conn-n0008', name: 'Simpang Permata Hijau / Arteri PI', lat: -6.2525, lon: 106.7848, signalized: true },
  ],
  links: [
    { id: 'conn-hw-1', name: 'Koridor Hayam Wuruk – Kota (Pluit–Tanah Abang)', highway: 'primary', corridor_pair: 'pluit_tanah_abang', from_node: 'n-322399159', to_node: 'conn-n0001', lanes: 3, speed_limit_kmh: 60, capacity_vph: 3600, coordinates: [[106.80398, -6.12512], [106.8096, -6.1338], [106.8148, -6.1425]] },
    { id: 'conn-hw-2', name: 'Koridor Gajah Mada – Harmoni (Pluit–Tanah Abang)', highway: 'primary', corridor_pair: 'pluit_tanah_abang', from_node: 'conn-n0001', to_node: 'conn-n0002', lanes: 3, speed_limit_kmh: 60, capacity_vph: 3600, coordinates: [[106.8148, -6.1425], [106.8178, -6.1520], [106.8194, -6.1618]] },
    { id: 'conn-hw-3', name: 'Koridor Harmoni – Abdul Muis (Tanah Abang Utara)', highway: 'primary', corridor_pair: 'pluit_tanah_abang', from_node: 'conn-n0002', to_node: 'n-6131883042', lanes: 3, speed_limit_kmh: 55, capacity_vph: 3400, coordinates: [[106.8194, -6.1618], [106.8191, -6.1705], [106.818378, -6.179245]] },
    { id: 'conn-sp-1', name: 'Koridor Latumeten Utara (Pluit–Grogol Bypass)', highway: 'trunk', corridor_pair: 'pluit_tanah_abang', from_node: 'n-3667903028', to_node: 'conn-n0003', lanes: 3, speed_limit_kmh: 65, capacity_vph: 3900, coordinates: [[106.780572, -6.124879], [106.7852, -6.1348], [106.7905, -6.1445]] },
    { id: 'conn-sp-2', name: 'Koridor Latumeten – Roxy (Pluit–Tanah Abang Barat)', highway: 'trunk', corridor_pair: 'pluit_tanah_abang', from_node: 'conn-n0003', to_node: 'conn-n0004', lanes: 3, speed_limit_kmh: 65, capacity_vph: 3900, coordinates: [[106.7905, -6.1445], [106.7962, -6.1546], [106.8015, -6.1650]] },
    { id: 'conn-sp-3', name: 'Koridor Roxy – Cideng Timur (Tanah Abang Barat)', highway: 'primary', corridor_pair: 'pluit_tanah_abang', from_node: 'conn-n0004', to_node: 'n-310007476', lanes: 3, speed_limit_kmh: 58, capacity_vph: 3600, coordinates: [[106.8015, -6.1650], [106.8072, -6.1704], [106.812143, -6.17561]] },
    { id: 'conn-x-1', name: 'Koridor Penghubung Pluit Selatan – Glodok', highway: 'trunk', corridor_pair: 'pluit_tanah_abang', from_node: 'conn-n0003', to_node: 'conn-n0001', lanes: 3, speed_limit_kmh: 65, capacity_vph: 3600, coordinates: [[106.7905, -6.1445], [106.8025, -6.1435], [106.8148, -6.1425]] },
    { id: 'conn-ta-1', name: 'Koridor M.H. Thamrin (Tanah Abang Utara–Selatan)', highway: 'primary', corridor_pair: 'pluit_tanah_abang', from_node: 'n-6131883042', to_node: 'n-8487621941', lanes: 3, speed_limit_kmh: 55, capacity_vph: 3500, coordinates: [[106.818378, -6.179245], [106.8226, -6.1848], [106.823227, -6.197518]] },
    { id: 'conn-ta-2', name: 'Koridor Aipda K.S. Tubun – Mas Mansyur (Tanah Abang Selatan)', highway: 'primary', corridor_pair: 'tanah_abang_cilandak', from_node: 'n-5373872462', to_node: 'n-317417741', lanes: 3, speed_limit_kmh: 55, capacity_vph: 3400, coordinates: [[106.81465, -6.19312], [106.8101, -6.1945], [106.805055, -6.195684]] },
    { id: 'conn-ta-3', name: 'Koridor Kebon Kacang – Sudirman (Tanah Abang Pusat)', highway: 'primary', corridor_pair: 'tanah_abang_cilandak', from_node: 'n-317755461', to_node: 'n-8487621941', lanes: 3, speed_limit_kmh: 52, capacity_vph: 3400, coordinates: [[106.818629, -6.194026], [106.8211, -6.1958], [106.823227, -6.197518]] },
    { id: 'conn-sa-1', name: 'Koridor Sudirman – Semanggi (Tanah Abang–Cilandak)', highway: 'trunk', corridor_pair: 'tanah_abang_cilandak', from_node: 'n-8487621941', to_node: 'conn-n0005', lanes: 3, speed_limit_kmh: 65, capacity_vph: 3900, coordinates: [[106.823227, -6.197518], [106.8212, -6.2085], [106.8145, -6.2205]] },
    { id: 'conn-sa-2', name: 'Koridor Sudirman – CSW Blok M (Tanah Abang–Cilandak)', highway: 'primary', corridor_pair: 'tanah_abang_cilandak', from_node: 'conn-n0005', to_node: 'conn-n0006', lanes: 3, speed_limit_kmh: 60, capacity_vph: 3700, coordinates: [[106.8145, -6.2205], [106.8035, -6.2412], [106.8035, -6.2565]] },
    { id: 'conn-sa-3', name: 'Koridor Pangeran Antasari – Cilandak', highway: 'primary', corridor_pair: 'tanah_abang_cilandak', from_node: 'conn-n0006', to_node: 'n-361120950', lanes: 3, speed_limit_kmh: 60, capacity_vph: 3700, coordinates: [[106.8035, -6.2565], [106.8065, -6.2715], [106.8070, -6.287428]] },
    { id: 'conn-pi-1', name: 'Koridor Slipi – Senayan Barat (Tanah Abang–Cilandak Bypass)', highway: 'trunk', corridor_pair: 'tanah_abang_cilandak', from_node: 'n-317417741', to_node: 'conn-n0007', lanes: 3, speed_limit_kmh: 65, capacity_vph: 3900, coordinates: [[106.805055, -6.195684], [106.7998, -6.2055], [106.7955, -6.2155]] },
    { id: 'conn-pi-2', name: 'Koridor Permata Hijau – Arteri Pondok Indah', highway: 'trunk', corridor_pair: 'tanah_abang_cilandak', from_node: 'conn-n0007', to_node: 'conn-n0008', lanes: 3, speed_limit_kmh: 65, capacity_vph: 3900, coordinates: [[106.7955, -6.2155], [106.7878, -6.2345], [106.7848, -6.2525]] },
    { id: 'conn-pi-3', name: 'Koridor Arteri Pondok Indah – Fatmawati / BDN II (Cilandak)', highway: 'primary', corridor_pair: 'tanah_abang_cilandak', from_node: 'conn-n0008', to_node: 'n-361121928', lanes: 3, speed_limit_kmh: 60, capacity_vph: 3700, coordinates: [[106.7848, -6.2525], [106.7918, -6.2695], [106.79944, -6.28451]] },
    { id: 'conn-x-2', name: 'Koridor Gatot Subroto (Slipi – Semanggi Link)', highway: 'trunk', corridor_pair: 'tanah_abang_cilandak', from_node: 'conn-n0007', to_node: 'conn-n0005', lanes: 3, speed_limit_kmh: 65, capacity_vph: 3800, coordinates: [[106.7955, -6.2155], [106.8052, -6.2182], [106.8145, -6.2205]] },
    { id: 'conn-x-3', name: 'Koridor Simatupang – Blok M Bypass Link', highway: 'primary', corridor_pair: 'tanah_abang_cilandak', from_node: 'conn-n0008', to_node: 'conn-n0006', lanes: 3, speed_limit_kmh: 60, capacity_vph: 3600, coordinates: [[106.7848, -6.2525], [106.7942, -6.2545], [106.8035, -6.2565]] },
    { id: 'conn-x-4', name: 'Koridor Tomang – Hasyim Ashari (Roxy–Harmoni Link)', highway: 'primary', corridor_pair: 'pluit_tanah_abang', from_node: 'conn-n0004', to_node: 'conn-n0002', lanes: 3, speed_limit_kmh: 60, capacity_vph: 3600, coordinates: [[106.8015, -6.1650], [106.8105, -6.1634], [106.8194, -6.1618]] },
    { id: 'conn-x-5', name: 'Koridor K.H. Mas Mansyur – Karet (Tanah Abang Selatan)', highway: 'primary', corridor_pair: 'tanah_abang_cilandak', from_node: 'n-317417741', to_node: 'n-8487621941', lanes: 3, speed_limit_kmh: 58, capacity_vph: 3600, coordinates: [[106.805055, -6.195684], [106.8142, -6.1966], [106.823227, -6.197518]] },
  ],
};

const M_LAT = 110574;
const M_LON = 110680;

function polylineLengthM(coords) {
  let total = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const dx = (coords[i + 1][0] - coords[i][0]) * M_LON;
    const dy = (coords[i + 1][1] - coords[i][1]) * M_LAT;
    total += Math.hypot(dx, dy);
  }
  return Number(Math.max(10, total).toFixed(1));
}

function bearingDeg(coords) {
  if (coords.length < 2) return 0;
  const dlon = (coords[coords.length - 1][0] - coords[0][0]) * M_LON;
  const dlat = (coords[coords.length - 1][1] - coords[0][1]) * M_LAT;
  return Number((((Math.atan2(dlon, dlat) * 180) / Math.PI + 360) % 360).toFixed(1));
}

export function classifyTurnDirection(fromBearingDeg, toBearingDeg) {
  const ang = ((toBearingDeg - fromBearingDeg + 180) % 360 + 360) % 360 - 180;
  if (Math.abs(ang) <= 35) return { code: 'lurus', label: 'Lurus', en: 'Straight', arrow: '↑' };
  if (ang >= -145 && ang < -35) return { code: 'belok_kiri', label: 'Belok Kiri', en: 'Turn Left', arrow: '↰' };
  if (ang > 35 && ang <= 145) return { code: 'belok_kanan', label: 'Belok Kanan', en: 'Turn Right', arrow: '↱' };
  return { code: 'putar_balik', label: 'Putar Balik', en: 'U-Turn', arrow: '↺' };
}

export function buildSignageNodes(region) {
  const edgesById = Object.fromEntries((region.edges || []).map(e => [e.edge_id, e]));
  const movByInter = {};
  for (const m of region.movements || []) {
    (movByInter[m.intersection_id] ||= []).push(m);
  }
  const nodes = [];
  for (const inter of region.intersections || []) {
    const nid = inter.node_id;
    const movs = movByInter[nid] || [];
    if (!movs.length && !inter.signalized && !inter.is_connector_hub) continue;
    const byFrom = {};
    for (const m of movs) {
      const fe = edgesById[m.from_edge];
      const te = edgesById[m.to_edge];
      if (!fe || !te) continue;
      const tinfo = classifyTurnDirection(Number(fe.bearing_deg || 0), Number(te.bearing_deg || 0));
      (byFrom[m.from_edge] ||= []).push({
        movement_id: m.movement_id,
        from_edge: m.from_edge,
        from_name: fe.name,
        to_edge: m.to_edge,
        to_name: te.name,
        dir_code: tinfo.code,
        dir_label: tinfo.label,
        dir_en: tinfo.en,
        dir_arrow: tinfo.arrow,
      });
    }
    const keys = Object.keys(byFrom);
    if (!keys.length) continue;
    const hasBranch = keys.some(k => byFrom[k].length >= 2);
    if (!hasBranch && !inter.is_connector_hub && !inter.signalized) continue;
    const primaryIn = keys.reduce((a, b) => (byFrom[a].length >= byFrom[b].length ? a : b));
    nodes.push({
      signage_id: `sig-${nid}`,
      intersection_id: nid,
      name: inter.name || edgesById[primaryIn]?.name || nid,
      region_id: inter.home_region || region.id || 'pluit',
      lat: inter.lat,
      lon: inter.lon,
      signalized: Boolean(inter.signalized),
      is_connector_hub: Boolean(inter.is_connector_hub),
      is_gateway: Boolean(inter.is_gateway),
      approaches: byFrom,
    });
  }
  return nodes;
}

const CORRIDOR_ORDER = [
  'pluit',
  'tambora',
  'tomang_harmoni',
  'tanah_abang',
  'sudirman_senayan',
  'kebayoran_baru',
  'kemang_cipete',
  'cilandak',
];

export function buildConnectedRegion(regionsById) {
  const orderedIds = CORRIDOR_ORDER.filter(rid => Boolean(regionsById[rid]));
  for (const rid of Object.keys(regionsById || {})) {
    if (!orderedIds.includes(rid)) orderedIds.push(rid);
  }

  const allEdges = [];
  const edgeById = {};
  const edgeKeyToId = new Map();
  const edgeAlias = {};
  const edgeRegions = {};

  const interMap = {};
  const interRegions = {};

  const rawMovements = [];
  const allStops = [];
  const seenStops = new Set();
  const allLandmarks = [];
  const seenLandmarks = new Set();
  const allWaterbodies = [];
  const seenWaterbodies = new Set();
  const studyBoundaries = [];
  const coverageMasks = [];

  for (const rid of orderedIds) {
    const reg = regionsById[rid];
    if (!reg) continue;
    for (const e of reg.edges || []) {
      const key = `${e.osm_way_id}::${e.from_node}::${e.to_node}::${e.direction || 'fwd'}`;
      if (edgeKeyToId.has(key)) {
        const canonId = edgeKeyToId.get(key);
        edgeAlias[e.edge_id] = canonId;
        edgeRegions[canonId].add(rid);
        edgeById[canonId].is_inter_region_connector = true;
        edgeById[canonId].corridor_pair = `${edgeById[canonId].home_region}_${rid}`;
      } else {
        edgeKeyToId.set(key, e.edge_id);
        edgeAlias[e.edge_id] = e.edge_id;
        edgeRegions[e.edge_id] = new Set([rid]);
        const copyEdge = {
          ...e,
          home_region: rid,
          is_inter_region_connector: Boolean(e.is_inter_region_connector),
        };
        allEdges.push(copyEdge);
        edgeById[e.edge_id] = copyEdge;
      }
    }

    for (const i of reg.intersections || []) {
      const inc = (i.incoming_edges || []).map(eid => edgeAlias[eid] || eid);
      const out = (i.outgoing_edges || []).map(eid => edgeAlias[eid] || eid);
      if (interMap[i.node_id]) {
        const existing = interMap[i.node_id];
        interRegions[i.node_id].add(rid);
        existing.is_gateway = true;
        existing.signalized = true;
        existing.incoming_edges = [...new Set([...existing.incoming_edges, ...inc])];
        existing.outgoing_edges = [...new Set([...existing.outgoing_edges, ...out])];
      } else {
        interMap[i.node_id] = {
          ...i,
          incoming_edges: [...new Set(inc)],
          outgoing_edges: [...new Set(out)],
          home_region: rid,
        };
        interRegions[i.node_id] = new Set([rid]);
      }
    }

    for (const m of reg.movements || []) rawMovements.push(m);

    for (const s of reg.transit_stops || []) {
      const sid = s.stop_id || `${s.name}_${s.lat}_${s.lon}`;
      if (seenStops.has(sid)) continue;
      seenStops.add(sid);
      allStops.push({ ...s, home_region: rid });
    }

    for (const lm of reg.landmarks || []) {
      const lid = lm.id || lm.name;
      if (seenLandmarks.has(lid)) continue;
      seenLandmarks.add(lid);
      allLandmarks.push({ ...lm, home_region: rid });
    }

    for (const w of reg.waterbodies || []) {
      const wid = w.osm_way_id || w.name;
      if (seenWaterbodies.has(wid)) continue;
      seenWaterbodies.add(wid);
      allWaterbodies.push(w);
    }

    studyBoundaries.push({ region_id: rid, name: reg.name, ring: reg.study_boundary });
    coverageMasks.push({ region_id: rid, name: reg.name, ring: reg.coverage_mask });
  }

  const allInters = Object.values(interMap);
  const gatewayNodes = new Set(
    Object.entries(interRegions).filter(([, rset]) => rset.size >= 2).map(([nid]) => nid)
  );

  for (const e of allEdges) {
    if (gatewayNodes.has(e.from_node) || gatewayNodes.has(e.to_node) || edgeRegions[e.edge_id]?.size >= 2) {
      e.is_inter_region_connector = true;
      if (!e.corridor_pair) e.corridor_pair = 'inter_region';
    }
  }

  const allMovements = [];
  const existingPairs = new Set();
  for (const m of rawMovements) {
    const fe = edgeAlias[m.from_edge] || m.from_edge;
    const te = edgeAlias[m.to_edge] || m.to_edge;
    if (!edgeById[fe] || !edgeById[te] || !interMap[m.intersection_id]) continue;
    const key = `${m.intersection_id}::${fe}::${te}`;
    if (existingPairs.has(key)) continue;
    existingPairs.add(key);
    allMovements.push({ ...m, from_edge: fe, to_edge: te });
  }

  const revLookup = new Map();
  for (const e of allEdges) {
    revLookup.set(`${e.osm_way_id}::${e.from_node}::${e.to_node}`, e.edge_id);
  }
  const pairReverse = {};
  for (const e of allEdges) {
    const opp = revLookup.get(`${e.osm_way_id}::${e.to_node}::${e.from_node}`);
    if (opp && opp !== e.edge_id) pairReverse[e.edge_id] = opp;
  }

  let movCounter = 1;
  for (const nid of [...gatewayNodes].sort()) {
    const inter = interMap[nid];
    for (const feId of inter.incoming_edges) {
      const fe = edgeById[feId];
      if (!fe) continue;
      for (const teId of inter.outgoing_edges) {
        if (feId === teId || pairReverse[feId] === teId) continue;
        const te = edgeById[teId];
        if (!te) continue;
        const ang = Math.abs(((te.bearing_deg - fe.bearing_deg + 180) % 360 + 360) % 360 - 180);
        if (ang > 158) continue;
        const key = `${nid}::${feId}::${teId}`;
        if (existingPairs.has(key)) continue;
        existingPairs.add(key);
        allMovements.push({
          movement_id: `conn-m${String(movCounter++).padStart(4, '0')}`,
          intersection_id: nid,
          from_edge: feId,
          to_edge: teId,
        });
      }
    }
    inter.movement_count = allMovements.filter(m => m.intersection_id === nid).length;
    inter.degree = new Set([...inter.incoming_edges, ...inter.outgoing_edges]).size;
  }

  const south = Math.min(...orderedIds.map(id => regionsById[id].bbox.south));
  const north = Math.max(...orderedIds.map(id => regionsById[id].bbox.north));
  const west = Math.min(...orderedIds.map(id => regionsById[id].bbox.west));
  const east = Math.max(...orderedIds.map(id => regionsById[id].bbox.east));
  const pluitRef = regionsById.pluit;
  const taRef = regionsById.tanah_abang;
  const connectorCount = allEdges.filter(e => e.is_inter_region_connector).length;

  const connected = {
    id: 'all',
    name: 'All Areas Connected (Pluit ↔ Cilandak)',
    district: 'Jakarta Utara · Jakarta Barat · Jakarta Pusat · Jakarta Selatan',
    subtitle: `Unified ${orderedIds.length}-area Jakarta corridor network · Pluit to Cilandak via real OSM streets`,
    is_connected_network: true,
    component_regions: orderedIds,
    bbox: { south, west, north, east },
    center: { lat: Number(((south + north) * 0.5).toFixed(5)), lon: Number(((west + east) * 0.5).toFixed(5)) },
    default_zoom: 11.75,
    primary_disruption: 'flood',
    scenario_eligibility: {
      flood: { supported: true, role: 'scoped_to_all_corridor_areas' },
      demonstration: { supported: true, role: 'scoped_to_all_corridor_areas' },
    },
    disruption_anchors: {
      flood: { ...pluitRef.disruption_anchors.flood, region_id: 'pluit' },
      demonstration: { ...taRef.disruption_anchors.demonstration, region_id: 'tanah_abang' },
      by_region: Object.fromEntries(orderedIds.map(rid => [rid, regionsById[rid].disruption_anchors])),
    },
    study_boundary: pluitRef.study_boundary,
    coverage_mask: pluitRef.coverage_mask,
    study_boundaries: studyBoundaries,
    coverage_masks: coverageMasks,
    landmarks: allLandmarks,
    transit_stops: allStops,
    waterbodies: allWaterbodies,
    edges: allEdges,
    intersections: allInters,
    movements: allMovements,
    provenance: pluitRef.provenance,
    stats: {
      directed_edges: allEdges.length,
      connector_edges: connectorCount,
      intersections: allInters.length,
      signalized_intersections: allInters.filter(i => i.signalized).length,
      movements: allMovements.length,
      transit_stops: allStops.length,
      flood_eligible_edges: allEdges.filter(e => e.flood_eligible).length,
      demonstration_eligible_edges: allEdges.filter(e => e.demonstration_eligible).length,
    },
  };
  connected.signage_nodes = buildSignageNodes(connected);
  return connected;
}

export function buildClientFrameSignage(signageNodes, routing, turnActions, frameEdges, frameIntersections, controller, ctx) {
  const periodLabel = (ctx.timePeriod || 'pagi').replace(/^./, c => c.toUpperCase());
  const out = {};
  for (const snode of signageNodes || []) {
    const nid = snode.intersection_id;
    const approaches = snode.approaches || {};
    const feIds = Object.keys(approaches);
    if (!feIds.length) continue;

    const feId = feIds.reduce((best, cur) => {
      const score = id => [
        approaches[id].length >= 2 ? 1 : 0,
        approaches[id].some(o => turnActions?.[o.movement_id]) ? 1 : 0,
        Number(frameEdges?.[id]?.queue_veh || 0),
      ];
      const sb = score(best);
      const sc = score(cur);
      return (sc[0] - sb[0] || sc[1] - sb[1] || sc[2] - sb[2]) > 0 ? cur : best;
    });

    const opts = approaches[feId];
    const wMap = Object.fromEntries(routing?.[feId] || []);
    const sigState = frameIntersections?.[nid];
    let light = 'uncontrolled';
    let greenS = 0;
    if (sigState) {
      light = sigState.yellow_edges?.includes(feId) ? 'yellow' : sigState.green_edges?.includes(feId) ? 'green' : 'red';
      greenS = Math.round(Number(sigState.green_duration_s || 0));
    }

    let blockedAny = false;
    let redirectedAny = false;
    const turns = opts.map(o => {
      const teState = frameEdges?.[o.to_edge] || {};
      const w = Number(wMap[o.to_edge] ?? (1 / Math.max(1, opts.length)));
      const pct = Math.round(w * 100);
      const ta = turnActions?.[o.movement_id];
      const closed = Boolean(teState.closed);
      const blocked = closed || ta?.action === 'blocked' || (opts.length > 1 && w <= 0.01);
      if (blocked) blockedAny = true;
      if (ta?.action === 'redirected') redirectedAny = true;
      return {
        dir_code: o.dir_code,
        dir_label: o.dir_label,
        dir_en: o.dir_en,
        arrow: o.dir_arrow,
        to_edge: o.to_edge,
        to_name: o.to_name,
        pct,
        blocked,
        closed,
        speed_kmh: Number(teState.speed_kmh || 0),
        occ: Number(teState.occupancy || 0),
        flood_i: Number(teState.flood_intensity || 0),
        demo_i: Number(teState.demonstration_intensity || 0),
      };
    }).sort((a, b) => (Number(a.blocked) - Number(b.blocked)) || (b.pct - a.pct) || (b.speed_kmh - a.speed_kmh));

    const top = turns[0];
    let mode = 'passive';
    let headline = '';
    if (turns.every(t => t.blocked || t.pct === 0)) {
      mode = 'blocked';
      headline = '✕ Koridor Depan Ditutup';
    } else if (controller === 'gnn_mappo') {
      if (turns.length > 1 && (blockedAny || (top.dir_code !== 'lurus' && top.pct >= 50) || redirectedAny || top.pct >= 56)) {
        const isDivert = blockedAny || (top.dir_code !== 'lurus' && top.pct >= 50) || (redirectedAny && top.pct >= 58);
        mode = isDivert ? 'diverted' : 'optimal';
        headline = (blockedAny || isDivert) ? `${top.arrow} ${top.dir_label} (${top.pct}%) · Dialihkan` : `${top.arrow} ${top.dir_label} (${top.pct}%)`;
      } else {
        mode = 'optimal';
        headline = `${top.arrow} ${top.dir_label} (${top.pct}%)`;
      }
    } else {
      headline = turns.length > 1 ? `⇄ Bagi Arus Merata (${top.arrow} ${top.pct}%)` : `${top.arrow} ${top.dir_label} (100%)`;
    }

    const worstBlocked = turns.find(t => t.blocked);
    let reason = '';
    if (controller === 'gnn_mappo') {
      if (worstBlocked && worstBlocked.flood_i >= 0.35) {
        reason = `SIMPUL alihkan ke ${top.dir_label.toLowerCase()} · Hindari banjir di ${worstBlocked.to_name}`;
      } else if (worstBlocked && worstBlocked.demo_i >= 0.30) {
        reason = `SIMPUL alihkan ke ${top.dir_label.toLowerCase()} · Hindari aksi massa di ${worstBlocked.to_name}`;
      } else if (worstBlocked) {
        reason = `SIMPUL blokir cabang padat (${worstBlocked.to_name}) · Prioritaskan ${top.dir_label.toLowerCase()}`;
      } else if (snode.is_connector_hub || snode.is_gateway) {
        reason = `Koridor penghubung antarwilayah (${periodLabel}) · Arahkan ke jalur tercepat (${Math.round(top.speed_kmh)} km/j)`;
      } else if (ctx.floodEnabled || ctx.demoEnabled) {
        reason = `Rute adaptif SIMPUL (${periodLabel}) menjaga kelancaran ${top.dir_label.toLowerCase()}`;
      } else {
        reason = `Keseimbangan arus GNN-MAPPO (${periodLabel}) · Antrean ${Number(frameEdges?.[feId]?.queue_veh || 0).toFixed(1)} kend`;
      }
    } else if (controller === 'max_pressure') {
      reason = `B2 Max-Pressure hanya atur durasi lampu (${light.toUpperCase()}) · Tanpa pengalihan rambu`;
    } else {
      reason = `B1 Fixed-Time siklus tetap 100s (${light.toUpperCase()}) · Tidak merespons gangguan/antrean`;
    }

    out[nid] = {
      from_edge: feId,
      from_name: opts[0].from_name,
      primary_dir: top.dir_code,
      primary_label: top.dir_label,
      primary_arrow: top.arrow,
      primary_to: top.to_name,
      primary_pct: top.pct,
      mode,
      headline,
      reason,
      light,
      green_s: greenS,
      turns: turns.slice(0, 4),
    };
  }
  return out;
}
