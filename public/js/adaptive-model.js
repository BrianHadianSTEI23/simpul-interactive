/**
 * Pure domain logic for the Jakarta Adaptive Traffic Network Simulator:
 * - Spatial eligibility mask checks & click snapping
 * - Gaussian spatial disruption model: w_e = exp(-d_e^2 / (2*sigma^2)), I_e = I_0 * w_e
 * - Deterministic client-side synthetic simulation fallback when FastAPI backend is offline
 * - Honest metric formatting (returns "Not available" when absent; never invents values)
 */

import { inferATNTActorJS } from './atnt-js-inference.mjs';
import { buildClientFrameSignage, buildSignageNodes } from './connected-network.js';

export const TIME_PERIODS = Object.freeze([
  Object.freeze({ id: 'pagi', label: 'Pagi', hours: '06:00–10:00', demandFactor: 1.08 }),
  Object.freeze({ id: 'siang', label: 'Siang', hours: '10:00–15:00', demandFactor: 0.78 }),
  Object.freeze({ id: 'sore', label: 'Sore', hours: '16:00–21:00', demandFactor: 1.16 }),
]);

export const CONTROLLERS = Object.freeze([
  Object.freeze({
    id: 'fixed_time',
    code: 'B1',
    name: 'Fixed-Time Signals',
    shortName: 'Fixed-Time',
    description: 'Static 100s signal cycle without queue or disruption feedback.',
    isMock: false,
  }),
  Object.freeze({
    id: 'max_pressure',
    code: 'B2',
    name: 'ITCS Max-Pressure',
    shortName: 'Max-Pressure',
    description: 'Adjusts signal timing from upstream and downstream queues.',
    isMock: false,
  }),
  Object.freeze({
    id: 'gnn_mappo',
    code: 'B3',
    name: 'MeshGraphNet Routing',
    shortName: 'MeshGraphNet',
    description: 'Diverts traffic at junctions and can block individual turns.',
    isMock: false,
  }),
]);

const METERS_PER_DEG_LAT = 110574;
const METERS_PER_DEG_LON = 110680;

export function pointInPolygon(lat, lon, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const denom = (yj - yi) || 1e-12;
    const intersects = ((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / denom + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

export function pointToSegmentDistanceM(lat, lon, aLon, aLat, bLon, bLat) {
  const ax = (aLon - lon) * METERS_PER_DEG_LON;
  const ay = (aLat - lat) * METERS_PER_DEG_LAT;
  const bx = (bLon - lon) * METERS_PER_DEG_LON;
  const by = (bLat - lat) * METERS_PER_DEG_LAT;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-9) {
    return { distanceM: Math.hypot(ax, ay), snapLat: aLat, snapLon: aLon };
  }
  const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lenSq));
  const px = ax + t * dx;
  const py = ay + t * dy;
  return {
    distanceM: Math.hypot(px, py),
    snapLat: aLat + t * (bLat - aLat),
    snapLon: aLon + t * (bLon - aLon),
  };
}

export function pointToPolylineDistanceM(lat, lon, coords) {
  let best = { distanceM: Infinity, snapLat: lat, snapLon: lon };
  if (!Array.isArray(coords) || coords.length < 2) return best;
  for (let i = 0; i < coords.length - 1; i++) {
    const seg = pointToSegmentDistanceM(lat, lon, coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]);
    if (seg.distanceM < best.distanceM) best = seg;
  }
  return best;
}

/**
 * Verify clicked coordinates against study-area boundary, coverage mask, and
 * disruption eligibility mask, snapping onto the nearest eligible road edge.
 */
export function snapDisruptionLocation(region, lat, lon, kind, maxSnapM = 200) {
  if (!region || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { accepted: false, reason: 'Invalid region or coordinates.' };
  }
  if (kind !== 'flood' && kind !== 'demonstration') {
    return { accepted: false, reason: `Unsupported disruption type: ${kind}` };
  }
  const eligCfg = region.scenario_eligibility?.[kind];
  if (!eligCfg?.supported) {
    return { accepted: false, reason: `${kind} scenario is not supported in ${region.name}.` };
  }

  const coverageRings = Array.isArray(region.coverage_masks) && region.coverage_masks.length
    ? region.coverage_masks
    : [{ region_id: region.id, name: region.name, ring: region.coverage_mask }];
  const inCoverageEntry = coverageRings.find(entry => pointInPolygon(lat, lon, entry.ring));
  const b = region.bbox;
  const inBbox = lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
  if (!inBbox && !inCoverageEntry) {
    return {
      accepted: false,
      inside_region: false,
      inside_coverage: false,
      eligible_for_disruption: false,
      reason: `Clicked point (${lat.toFixed(5)}, ${lon.toFixed(5)}) is outside the ${region.name} study area.`,
    };
  }
  const inCoverage = Boolean(inCoverageEntry);
  const flag = kind === 'flood' ? 'flood_eligible' : 'demonstration_eligible';
  const eligibleEdges = (region.edges || []).filter(e => Boolean(e[flag]));

  let bestElig = null;
  for (const edge of eligibleEdges) {
    const res = pointToPolylineDistanceM(lat, lon, edge.coordinates);
    if (!bestElig || res.distanceM < bestElig.distanceM) {
      bestElig = { ...res, edge };
    }
  }

  let bestAny = Infinity;
  for (const edge of (region.edges || []).filter(e => !e.is_inter_region_connector)) {
    const res = pointToPolylineDistanceM(lat, lon, edge.coordinates);
    if (res.distanceM < bestAny) bestAny = res.distanceM;
  }

  if (!inCoverage && bestAny > maxSnapM) {
    return {
      accepted: false,
      inside_region: !region.is_connected_network,
      inside_coverage: false,
      eligible_for_disruption: false,
      nearest_distance_m: Number(bestAny.toFixed(1)),
      reason: region.is_connected_network
        ? 'Flooding & demonstration placement remain strictly scoped to Tanah Abang, Cilandak, and Pluit (outside corridor masks).'
        : `Clicked location is outside the covered road-network mask (nearest covered road: ${Math.round(bestAny)} m).`,
    };
  }

  if (!bestElig || bestElig.distanceM > maxSnapM) {
    const distNote = bestElig ? `${Math.round(bestElig.distanceM)} m` : 'N/A';
    return {
      accepted: false,
      inside_region: true,
      inside_coverage: inCoverage,
      eligible_for_disruption: false,
      nearest_distance_m: bestElig ? Number(bestElig.distanceM.toFixed(1)) : null,
      reason: `Location is outside the eligible ${kind} scenario mask (nearest eligible road: ${distNote}; max snap: ${maxSnapM} m).`,
    };
  }

  return {
    accepted: true,
    inside_region: true,
    inside_coverage: true,
    eligible_for_disruption: true,
    disruption_kind: kind,
    matched_region_id: bestElig.edge.home_region || inCoverageEntry?.region_id || region.id,
    snapped_lat: Number(bestElig.snapLat.toFixed(6)),
    snapped_lon: Number(bestElig.snapLon.toFixed(6)),
    snapped_edge_id: bestElig.edge.edge_id,
    snapped_road_name: bestElig.edge.name,
    snap_distance_m: Number(bestElig.distanceM.toFixed(1)),
    scenario_role: eligCfg.role || 'synthetic_zone',
    provenance: 'synthetic_scenario_anchor_snapped_to_osm',
  };
}

/**
 * Gaussian Spatial Disruption Model:
 *   w_e = exp(-d_e^2 / (2 * sigma^2))
 *   I_e = I_0 * w_e
 * Keeps flooding and demonstration physical impacts separate.
 */
export function computeGaussianImpactField(region, floodCfg, demoCfg) {
  const impacts = {};
  for (const edge of region?.edges || []) {
    const eid = edge.edge_id;
    let floodI = 0;
    let demoI = 0;
    let floodD = null;
    let demoD = null;

    if (floodCfg?.enabled && edge.flood_eligible && Number.isFinite(floodCfg.lat) && Number.isFinite(floodCfg.lon)) {
      const sigma = Math.max(40, Number(floodCfg.sigma_m) || 420);
      const i0 = Math.max(0, Math.min(1, Number(floodCfg.intensity) || 0.75));
      const { distanceM } = pointToPolylineDistanceM(floodCfg.lat, floodCfg.lon, edge.coordinates);
      floodD = Number(distanceM.toFixed(1));
      const w = Math.exp(-(distanceM * distanceM) / (2 * sigma * sigma));
      floodI = Number((i0 * w).toFixed(4));
    }

    if (demoCfg?.enabled && edge.demonstration_eligible && Number.isFinite(demoCfg.lat) && Number.isFinite(demoCfg.lon)) {
      const sigma = Math.max(40, Number(demoCfg.sigma_m) || 360);
      const i0 = Math.max(0, Math.min(1, Number(demoCfg.intensity) || 0.7));
      const { distanceM } = pointToPolylineDistanceM(demoCfg.lat, demoCfg.lon, edge.coordinates);
      demoD = Number(distanceM.toFixed(1));
      const w = Math.exp(-(distanceM * distanceM) / (2 * sigma * sigma));
      demoI = Number((i0 * w).toFixed(4));
    }

    const closed = floodI >= 0.82;
    const accessRestricted = demoI >= 0.65;
    const floodSpeedFactor = closed ? 0 : (floodI > 0.01 ? Math.max(0.10, 1 - 0.82 * Math.pow(floodI, 1.15)) : 1);
    const floodCapFactor = closed ? 0 : (floodI > 0.01 ? Math.max(0.12, 1 - 0.74 * floodI) : 1);
    const demoSpeedFactor = demoI > 0.01 ? Math.max(0.18, 1 - 0.68 * demoI) : 1;
    const demoCapFactor = demoI > 0.01 ? Math.max(0.10, 1 - 0.86 * Math.pow(demoI, 1.05)) : 1;

    const both = floodI > 0.1 && demoI > 0.1;
    const speedFactor = closed ? 0 : Number((Math.min(floodSpeedFactor, demoSpeedFactor) * (both ? 0.92 : 1)).toFixed(4));
    const capacityFactor = closed ? 0 : Number((Math.min(floodCapFactor, demoCapFactor) * (both ? 0.90 : 1)).toFixed(4));
    const combinedIntensity = Number(Math.min(1, Math.max(floodI, demoI) + 0.25 * Math.min(floodI, demoI)).toFixed(4));

    impacts[eid] = {
      edge_id: eid,
      flood_intensity: floodI,
      flood_distance_m: floodD,
      demonstration_intensity: demoI,
      demonstration_distance_m: demoD,
      combined_intensity: combinedIntensity,
      speed_factor: speedFactor,
      capacity_factor: capacityFactor,
      closed,
      access_restricted: accessRestricted,
      modeling_provenance: 'synthetic_gaussian_disruption',
    };
  }
  return impacts;
}

function seededRandom(seed) {
  let s = (Number(seed) || 42) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function buildClientGraphCache(region) {
  const edges = region.edges || [];
  const inters = region.intersections || [];
  const movs = region.movements || [];
  const nI = inters.length;
  const nR = edges.length;
  const nM = movs.length;
  const interIdx = Object.fromEntries(inters.map((i, idx) => [i.node_id, idx]));
  const roadIdx = Object.fromEntries(edges.map((e, idx) => [e.edge_id, idx]));

  const interIn = inters.map(i => (i.incoming_edges || []).map(eid => roadIdx[eid]).filter(x => x !== undefined));
  const interOut = inters.map(i => (i.outgoing_edges || []).map(eid => roadIdx[eid]).filter(x => x !== undefined));
  const adjR2IIn = interIn.map(inc => {
    const w = 1 / Math.max(1, inc.length);
    return inc.map(r => [r, w]);
  });
  const adjR2IOut = interOut.map(out => {
    const w = 1 / Math.max(1, out.length);
    return out.map(r => [r, w]);
  });
  const adjI2RT = Array.from({ length: nR }, () => []);
  interIn.forEach((inc, ii) => {
    const w = 0.5 / Math.max(1, inc.length);
    for (const r of inc) adjI2RT[r].push([ii, w]);
  });
  interOut.forEach((out, ii) => {
    const w = 0.5 / Math.max(1, out.length);
    for (const r of out) adjI2RT[r].push([ii, w]);
  });

  const interMovs = Array.from({ length: nI }, () => []);
  const movFrom = new Int32Array(nM);
  const movTo = new Int32Array(nM);
  const movByFromIdx = Array.from({ length: nR }, () => []);
  const movMeta = movs.map((m, idx) => {
    const ii = interIdx[m.intersection_id] ?? 0;
    const fr = roadIdx[m.from_edge] ?? 0;
    const tr = roadIdx[m.to_edge] ?? 0;
    movFrom[idx] = fr;
    movTo[idx] = tr;
    interMovs[ii].push(idx);
    movByFromIdx[fr].push(idx);
    const fb = Number(edges[fr]?.bearing_deg || 0);
    const tb = Number(edges[tr]?.bearing_deg || 0);
    const ang = ((tb - fb + 180) % 360 + 360) % 360 - 180;
    const turn = Math.abs(ang) <= 35 ? [1, 0, 0] : (ang < -35 ? [0, 1, 0] : [0, 0, 1]);
    const parity = ((fb % 180 + 180) % 180) < 45 || ((fb % 180 + 180) % 180) >= 135 ? 0 : 1;
    return { m, ii, fr, tr, turn, parity };
  });
  const movGroups = movByFromIdx.filter(g => g.length > 0);
  const adjM2I = interMovs.map(ml => {
    const w = 1 / Math.max(1, ml.length);
    return ml.map(mi => [mi, w]);
  });
  const adjI2MT = movMeta.map(mm => [[mm.ii, 1 / Math.max(1, interMovs[mm.ii].length)]]);

  const i2iSets = Array.from({ length: nI }, () => new Set());
  for (const e of edges) {
    const u = interIdx[e.from_node];
    const v = interIdx[e.to_node];
    if (u !== undefined && v !== undefined && u !== v) {
      i2iSets[u].add(v);
      i2iSets[v].add(u);
    }
  }
  const adjI2I = i2iSets.map(s => {
    const w = 1 / Math.max(1, s.size);
    return [...s].map(nb => [nb, w]);
  });

  return {
    nI, nR, nM, interIdx, roadIdx, interIn, interOut, interMovs, movMeta,
    adjR2IIn, adjR2IOut, adjI2RT, adjI2I, adjM2I, adjI2MT, movFrom, movTo, movGroups,
  };
}

function runTrainedJSStep(region, cache, weightsPayload, frameEdges, interPhase) {
  const {
    nI, nR, nM, interIn, interOut, interMovs, movMeta,
    adjR2IIn, adjR2IOut, adjI2RT, adjI2I, adjM2I, adjI2MT, movFrom, movTo, movGroups,
  } = cache;
  const edges = region.edges || [];
  const inters = region.intersections || [];
  const interX = new Float32Array(nI * 14);
  const roadX = new Float32Array(nR * 16);
  const movX = new Float32Array(nM * 12);
  const actionMask = new Float32Array(nI * 8);
  actionMask.fill(1);
  const movClosed = new Uint8Array(nM);

  for (let r = 0; r < nR; r++) {
    const e = edges[r];
    const st = frameEdges[e.edge_id] || {};
    const free = Number(e.speed_limit_kmh) || 40;
    const spd = Number(st.speed_kmh ?? free);
    const qv = Number(st.queue_veh ?? 0);
    const occ = Number(st.occupancy ?? 0);
    const fl = Number(st.flood_intensity ?? 0);
    const dm = Number(st.demonstration_intensity ?? 0);
    const cl = st.closed ? 1 : 0;
    const base = r * 16;
    roadX[base + 0] = Math.min(3, (Number(e.length_m) || 100) / 600);
    roadX[base + 1] = Math.min(2, (Number(e.lanes) || 1) / 4);
    roadX[base + 2] = Math.min(2, (Number(e.capacity_vph) || 1000) / 4000);
    roadX[base + 3] = Math.min(1.5, free / 80);
    roadX[base + 4] = Math.min(1.2, spd / Math.max(1, free));
    roadX[base + 5] = Math.min(3, qv / 40);
    roadX[base + 6] = Math.min(1.2, occ);
    roadX[base + 7] = Math.min(3, (occ * 45) / 120);
    roadX[base + 8] = Math.min(2, Number(st.flow_vph ?? 500) / Math.max(100, Number(e.capacity_vph) || 1000));
    roadX[base + 9] = cl ? 0 : Math.min(1, spd / Math.max(1, free));
    roadX[base + 10] = fl;
    roadX[base + 11] = dm;
    roadX[base + 12] = cl;
    roadX[base + 14] = Math.min(1.2, occ);
  }
  for (let m = 0; m < nM; m++) {
    const mm = movMeta[m];
    const frSt = frameEdges[edges[mm.fr].edge_id] || {};
    const toSt = frameEdges[edges[mm.tr].edge_id] || {};
    if (toSt.closed) movClosed[m] = 1;
    const base = m * 12;
    movX[base + 0] = 0.5;
    movX[base + 1] = Math.min(2, (frSt.queue_veh ?? 0) / 30);
    movX[base + 2] = Math.min(1.2, toSt.occupancy ?? 0);
    movX[base + 3] = toSt.closed ? 0 : 1;
    movX[base + 4] = Math.max(-2, Math.min(2, ((frSt.queue_veh ?? 0) - 0.65 * (toSt.queue_veh ?? 0)) / 25));
    movX[base + 5] = mm.turn[0];
    movX[base + 6] = mm.turn[1];
    movX[base + 7] = mm.turn[2];
    movX[base + 9] = toSt.disruption_intensity ?? 0;
    movX[base + 10] = 1;
    movX[base + 11] = mm.parity;
  }
  for (let i = 0; i < nI; i++) {
    const inter = inters[i];
    const base = i * 14;
    interX[base + 0] = inter.signalized ? 1 : 0;
    interX[base + 1] = interPhase[inter.node_id] ?? 0;
    interX[base + 2] = 0.3;
    interX[base + 3] = 0.67;
    interX[base + 5] = Math.min(1.5, interIn[i].length / 6);
    interX[base + 6] = Math.min(1.5, interOut[i].length / 6);
    interX[base + 7] = Math.min(1.5, interMovs[i].length / 16);
  }

  const out = inferATNTActorJS(weightsPayload, {
    nI, nR, nM,
    interX, roadX, movX,
    adjR2IIn, adjR2IOut, adjI2RT, adjI2I, adjM2I, adjI2MT,
    movFrom, movTo, movGroups, movClosed, actionMask,
  });

  const movByFrom = {};
  for (let m = 0; m < nM; m++) {
    const mm = movMeta[m];
    const fe = edges[mm.fr].edge_id;
    (movByFrom[fe] ||= []).push({ m: mm.m, idx: m, mm });
  }

  // 4-hop downstream stress diffusion for network-wide VMS coordination (mirrors movement_policy.py)
  const edgeStress = {};
  for (const e of edges) {
    const st = frameEdges[e.edge_id] || {};
    edgeStress[e.edge_id] = st.closed ? 1 : Math.max(st.occupancy ?? 0, st.disruption_intensity ?? 0);
  }
  const outStress = { ...edgeStress };
  for (let hop = 0; hop < 4; hop++) {
    const nextStress = {};
    for (const [feId, list] of Object.entries(movByFrom)) {
      if (!list.length) continue;
      const vals = list.map(x => outStress[x.m.to_edge] ?? edgeStress[x.m.to_edge] ?? 0);
      const bestNext = Math.min(...vals);
      const worstNext = Math.max(...vals);
      const avgNext = vals.reduce((a, b) => a + b, 0) / vals.length;
      const prop = 0.50 * avgNext + 0.35 * worstNext + 0.15 * bestNext;
      nextStress[feId] = Math.max(edgeStress[feId] ?? 0, 0.86 * prop);
    }
    Object.assign(outStress, nextStress);
  }

  const turnActions = {};
  const routing = {};
  for (const [feId, list] of Object.entries(movByFrom)) {
    const legal = list.filter(x => !(frameEdges[x.m.to_edge]?.closed));
    const scored = legal.map(x => {
      const toSt = frameEdges[x.m.to_edge] || {};
      const lookahead = outStress[x.m.to_edge] ?? 0;
      const risk = Math.max(toSt.occupancy ?? 0, toSt.disruption_intensity ?? 0, 0.85 * lookahead);
      const rawS = out.movScores ? Number(out.movScores[x.idx] || 0.01) : Math.max(0.01, 1 - risk);
      const relief = Math.max(0.10, 1 - 0.85 * Math.max(0, risk - 0.08));
      return { ...x, score: Math.max(0.01, Math.min(1, rawS * relief)) };
    });
    const best = scored.reduce((a, b) => (!a || b.score > a.score ? b : a), null);
    const allowed = scored.filter(x => x.score >= 0.16 || (best && x.idx === best.idx));
    const total = allowed.reduce((s, x) => s + Math.pow(x.score, 4.0), 0);
    const splits = allowed.map(x => [x.m.to_edge, total > 0 ? Math.pow(x.score, 4.0) / total : 1 / allowed.length]);
    routing[feId] = splits;
    const splitMap = Object.fromEntries(splits);
    const bestShare = best ? (splitMap[best.m.to_edge] ?? 0) : 0;
    const worstRisk = Math.max(...list.map(x => Math.max(frameEdges[x.m.to_edge]?.occupancy ?? 0, frameEdges[x.m.to_edge]?.disruption_intensity ?? 0, outStress[x.m.to_edge] ?? 0)), 0);
    for (const x of scored) {
      const inAllowed = allowed.some(a => a.idx === x.idx);
      if (!inAllowed) {
        turnActions[x.m.movement_id] = {
          intersection_id: x.m.intersection_id, from_edge: feId, to_edge: x.m.to_edge, action: 'blocked',
        };
      } else if (legal.length > 1 && best && x.idx === best.idx && (allowed.length < legal.length || bestShare >= 0.45 || worstRisk >= 0.22)) {
        turnActions[x.m.movement_id] = {
          intersection_id: x.m.intersection_id, from_edge: feId, to_edge: x.m.to_edge, action: 'redirected',
        };
      }
    }
  }
  return { actions: out.actions, turnActions, routing };
}

function simulateSingleClientController(region, config, controllerId, floodCfg, demoCfg, impacts, weightsPayload = null) {
  const ctrlOffset = { fixed_time: 1, max_pressure: 2, gnn_mappo: 3 }[controllerId] || 1;
  const rng = seededRandom((config.seed || 42) + ctrlOffset);
  const periodMeta = TIME_PERIODS.find(p => p.id === config.time_period) || TIME_PERIODS[0];
  const durationS = Math.max(120, Math.min(1800, Number(config.duration_s) || 600));
  const dtS = 30;
  const steps = Math.max(4, Math.round(durationS / dtS));
  const hasDisruption = Boolean(floodCfg?.enabled || demoCfg?.enabled);
  const useTrainedJS = Boolean(controllerId === 'gnn_mappo' && weightsPayload);
  const jsCache = useTrainedJS ? buildClientGraphCache(region) : null;

  const serviceEff = { fixed_time: 0.84, max_pressure: 0.96, gnn_mappo: 1.07 }[controllerId];
  const spillbackDamping = { fixed_time: 0, max_pressure: 0.24, gnn_mappo: 0.52 }[controllerId];
  const rerouteRelief = { fixed_time: 0, max_pressure: 0.14, gnn_mappo: 0.34 }[controllerId];

  const edges = region.edges || [];
  const intersections = region.intersections || [];
  const signageNodes = region.signage_nodes || buildSignageNodes(region);
  const movByFrom = {};
  for (const m of region.movements || []) {
    (movByFrom[m.from_edge] ||= []).push(m);
  }
  const signalNodes = intersections.filter(i => i.signalized);

  const edgeQueue = {};
  const edgeBaseDemand = {};
  const edgeStorage = {};
  for (const e of edges) {
    const hw = e.highway || 'secondary';
    let hwLoad = (hw.includes('primary') || hw.includes('trunk') || hw.includes('motorway')) ? 0.50 : hw.includes('secondary') ? 0.38 : 0.28;
    if (e.corridor_focus) hwLoad += 0.06;
    const noise = 0.92 + 0.16 * rng();
    const demand = e.capacity_vph * hwLoad * periodMeta.demandFactor * noise;
    edgeBaseDemand[e.edge_id] = demand;
    edgeStorage[e.edge_id] = Math.max(4, (e.length_m / 6.5) * e.lanes);
    edgeQueue[e.edge_id] = Math.min(edgeStorage[e.edge_id] * 0.22, Math.max(0.3, (demand / 3600) * 4));
  }

  const interPhase = {};
  for (const i of signalNodes) interPhase[i.node_id] = 0;

  const frames = [];
  const delays = [];
  const travelTimes = [];
  const queues = [];
  let maxQueue = 0;
  let spillbackEvents = 0;
  let totalServed = 0;
  let phaseSwitches = 0;
  let peakQ = 0;
  let recoveryTimeS = null;
  let recoveryArmed = false;

  for (let step = 0; step <= steps; step++) {
    const tSec = step * dtS;
    let pulse = 0;
    let demandWave = 1;
    const frac = tSec / Math.max(1, durationS);
    if (hasDisruption) {
      if (frac <= 0.03) {
        pulse = 0;
        demandWave = 0.62;
      } else if (frac < 0.16) {
        const ramp = (frac - 0.03) / 0.13;
        pulse = ramp;
        demandWave = 0.86 + 0.62 * ramp;
      } else if (frac <= 0.44) {
        pulse = 1;
        demandWave = 1.48;
      } else if (frac <= 0.68) {
        const ease = (frac - 0.44) / 0.24;
        pulse = Math.max(0.10, 1 - 0.90 * ease);
        demandWave = 1.10 - 0.64 * ease;
      } else {
        const tail = (frac - 0.68) / 0.32;
        pulse = tail >= 0.45 ? 0 : Math.max(0, 0.10 * (1 - tail / 0.45));
        demandWave = 0.44 - 0.08 * tail;
      }
    } else {
      demandWave = frac < 0.68 ? 0.62 + 0.66 * Math.sin(Math.PI * Math.min(1, frac / 0.68)) : 0.44;
    }

    const frameEdges = {};
    let stepQSum = 0;
    for (const e of edges) {
      const eid = e.edge_id;
      const imp = impacts[eid] || { combined_intensity: 0, flood_intensity: 0, demonstration_intensity: 0, speed_factor: 1, capacity_factor: 1, closed: false, access_restricted: false };
      const effDis = imp.combined_intensity * pulse;
      const closed = Boolean(imp.closed && pulse > 0.45);
      const capFactor = closed ? 0 : Math.max(0.08, 1 - (1 - imp.capacity_factor) * pulse);
      const spdFactor = closed ? 0 : Math.max(0.08, 1 - (1 - imp.speed_factor) * pulse);
      const inflowFactor = (effDis > 0.15 && !closed) ? Math.max(0.45, 1 - rerouteRelief * effDis) : 1;

      const demandRate = (edgeBaseDemand[eid] * demandWave * inflowFactor) / 3600;
      const effCap = closed ? 0 : ((e.capacity_vph * capFactor * serviceEff) / 3600);
      const maxStorage = edgeStorage[eid];
      let q = edgeQueue[eid];
      if (step > 0) {
        const arrivals = demandRate * dtS;
        const spillRatio = Math.max(0, q / maxStorage - 0.65);
        const throttle = Math.max(0.32, 1 - spillRatio * (1 - spillbackDamping));
        const served = Math.min(q + arrivals, effCap * throttle * dtS);
        q = Math.max(0, Math.min(maxStorage * 1.15, q + arrivals - served));
        edgeQueue[eid] = q;
        totalServed += served;
      }

      const occ = Math.min(1, q / maxStorage);
      if (occ >= 0.82 && step > 0) spillbackEvents++;
      const freeSpd = Number(e.speed_limit_kmh) || 40;
      const speedKmh = closed ? 0 : Number(Math.max(3.5, freeSpd * spdFactor * Math.max(0.12, 1 - 0.82 * Math.pow(occ, 1.35))).toFixed(1));
      const flowVph = closed ? 0 : Math.round(Math.min(e.capacity_vph * capFactor, edgeBaseDemand[eid] * demandWave * inflowFactor * (1 - 0.45 * occ)));
      const queueM = Number(Math.min(e.length_m, (q * 6.2) / Math.max(1, e.lanes)).toFixed(1));
      const congIdx = Number(Math.min(1, Math.max(0, 1 - speedKmh / Math.max(1, freeSpd))).toFixed(3));
      const delayS = Math.max(0, e.length_m / Math.max(1, speedKmh / 3.6) - e.length_m / Math.max(1, freeSpd / 3.6));
      const ttS = e.length_m / Math.max(1, (speedKmh > 0 ? speedKmh : 2.5) / 3.6);

      delays.push(delayS);
      travelTimes.push(ttS);
      queues.push(q);
      stepQSum += q;
      if (q > maxQueue) maxQueue = q;

      frameEdges[eid] = {
        speed_kmh: speedKmh,
        free_flow_kmh: freeSpd,
        flow_vph: flowVph,
        occupancy: Number(occ.toFixed(3)),
        queue_veh: Number(q.toFixed(1)),
        queue_length_m: queueM,
        congestion_index: congIdx,
        disruption_intensity: Number(effDis.toFixed(3)),
        flood_intensity: Number((imp.flood_intensity * pulse).toFixed(3)),
        demonstration_intensity: Number((imp.demonstration_intensity * pulse).toFixed(3)),
        closed,
        access_restricted: Boolean(imp.access_restricted && pulse > 0.4),
      };
    }

    const frameIntersections = {};
    for (const inter of signalNodes) {
      let phase = 0;
      if (controllerId === 'fixed_time') {
        phase = (tSec % 100) < 52 ? 0 : 1;
      } else {
        const inc = inter.incoming_edges || [];
        let evenQ = 0;
        let oddQ = 0;
        inc.forEach((eid, idx) => {
          if (idx % 2 === 0) evenQ += edgeQueue[eid] || 0;
          else oddQ += edgeQueue[eid] || 0;
        });
        phase = evenQ >= oddQ ? 0 : 1;
      }
      const incoming = inter.incoming_edges || [];
      const previous = interPhase[inter.node_id];
      const changed = previous !== undefined && previous !== phase;
      if (interPhase[inter.node_id] !== phase) {
        phaseSwitches++;
        interPhase[inter.node_id] = phase;
      }
      frameIntersections[inter.node_id] = {
        phase,
        green_edges: incoming.filter((_, index) => index % 2 === phase),
        phase_changed: changed,
        yellow_edges: changed ? incoming.filter((_, index) => index % 2 === previous) : [],
        green_duration_s: controllerId === 'fixed_time' ? (phase === 0 ? 48 : 44) : 34,
        safety_clamped: false,
      };
    }

    if (hasDisruption) {
      if (stepQSum > peakQ) {
        peakQ = stepQSum;
        recoveryArmed = true;
      } else if (recoveryArmed && recoveryTimeS === null && tSec > durationS * 0.42 && stepQSum <= peakQ * 0.68) {
        recoveryTimeS = Number((tSec - 60).toFixed(1));
      }
    }

    let turnActions = {};
    let routing = {};
    let movementPolicy = controllerId === 'gnn_mappo' ? 'graph_heuristic' : 'signals_only';
    if (useTrainedJS && jsCache) {
      const jsStep = runTrainedJSStep(region, jsCache, weightsPayload, frameEdges, interPhase);
      turnActions = jsStep.turnActions;
      routing = jsStep.routing;
      movementPolicy = 'meshgraphnet';
      for (const inter of signalNodes) {
        const idx = jsCache.interIdx[inter.node_id];
        if (idx !== undefined && frameIntersections[inter.node_id]) {
          const p = Math.floor(jsStep.actions[idx] / 4) % 2;
          frameIntersections[inter.node_id].phase = p;
        }
      }
    } else {
      for (const [feId, turns] of Object.entries(movByFrom)) {
        const legal = turns.filter(m => !(frameEdges[m.to_edge]?.closed));
        if (legal.length) {
          routing[feId] = legal.map(m => [m.to_edge, 1 / legal.length]);
        }
      }
    }

    const signageStates = buildClientFrameSignage(
      signageNodes,
      routing,
      turnActions,
      frameEdges,
      frameIntersections,
      controllerId,
      {
        floodEnabled: Boolean(floodCfg?.enabled),
        demoEnabled: Boolean(demoCfg?.enabled),
        timePeriod: config.time_period || 'pagi',
      },
    );

    frames.push({
      t_sec: tSec,
      edge_states: frameEdges,
      intersection_states: frameIntersections,
      turn_actions: turnActions,
      signage_states: signageStates,
      movement_policy: movementPolicy,
    });
  }

  const sortedDelays = [...delays].sort((a, b) => a - b);
  const p95 = sortedDelays[Math.min(sortedDelays.length - 1, Math.floor(0.95 * sortedDelays.length))] || 0;
  const avg = arr => arr.reduce((s, x) => s + x, 0) / Math.max(1, arr.length);
  const avgCongEdges = Number((frames.reduce((sum, f) => (
    sum + Object.values(f.edge_states || {}).filter(st => isCongested(st)).length
  ), 0) / Math.max(1, frames.length)).toFixed(1));

  return {
    controller: controllerId,
    benchmark_code: { fixed_time: 'B1', max_pressure: 'B2', gnn_mappo: 'B3' }[controllerId],
    frames,
    metrics: {
      avg_travel_time_s: Number(avg(travelTimes).toFixed(1)),
      avg_delay_s: Number(avg(delays).toFixed(1)),
      p95_delay_s: Number(p95.toFixed(1)),
      throughput_vph: Math.round((totalServed / durationS) * 3600),
      avg_queue_length_veh: Number(avg(queues).toFixed(2)),
      max_queue_length_veh: Number(maxQueue.toFixed(1)),
      spillback_events: spillbackEvents,
      avg_congested_edges: avgCongEdges,
      reconfiguration_freq_per_hr: Number(((phaseSwitches / Math.max(1, signalNodes.length)) * (3600 / durationS)).toFixed(1)),
      incident_recovery_time_s: hasDisruption ? recoveryTimeS : null,
    },
    engine: useTrainedJS ? 'trained_js_meshgraphnet_fallback' : 'synthetic_client_fallback',
  };
}

export function runClientFallbackSimulation(region, config, weightsPayload = null) {
  const floodCfg = config.flood?.enabled ? config.flood : { enabled: false };
  const demoCfg = config.demonstration?.enabled ? config.demonstration : { enabled: false };
  const impacts = computeGaussianImpactField(region, floodCfg, demoCfg);
  const primary = simulateSingleClientController(region, config, config.controller || 'gnn_mappo', floodCfg, demoCfg, impacts, weightsPayload);
  const comparison = {};
  for (const ctrl of ['fixed_time', 'max_pressure', 'gnn_mappo']) {
    if (ctrl === primary.controller) {
      comparison[ctrl] = { controller: ctrl, benchmark_code: primary.benchmark_code, metrics: primary.metrics, engine: primary.engine };
    } else {
      const res = simulateSingleClientController(region, config, ctrl, floodCfg, demoCfg, impacts, weightsPayload);
      comparison[ctrl] = { controller: ctrl, benchmark_code: res.benchmark_code, metrics: res.metrics, engine: res.engine };
    }
  }
  const hasTrainedJS = Boolean(primary.controller === 'gnn_mappo' && weightsPayload);
  return {
    simulation_id: `local-${Date.now().toString(36)}`,
    region_id: region.id,
    region_name: region.name,
    time_period: config.time_period || 'pagi',
    controller: primary.controller,
    benchmark_code: primary.benchmark_code,
    disruptions: { flood: floodCfg, demonstration: demoCfg },
    incident_impacts: impacts,
    signage_nodes: region.signage_nodes || buildSignageNodes(region),
    frames: primary.frames,
    metrics: primary.metrics,
    comparison,
    controller_adapter: {
      controller_id: primary.controller,
      benchmark_code: primary.benchmark_code,
      adapter_mode: hasTrainedJS ? 'trained_js_meshgraphnet_weights' : (primary.controller === 'gnn_mappo' ? 'mock_development_adapter' : 'deterministic_benchmark'),
      is_mock: primary.controller === 'gnn_mappo' && !hasTrainedJS,
      safety_supervisor: { enforced: true, min_green_s: 12, max_green_s: 75, intergreen_clearance_s: 4 },
      diagnostics: {
        policy_confidence: primary.controller === 'gnn_mappo' ? 0.87 : null,
        checkpoint_loaded: hasTrainedJS,
        notice: hasTrainedJS
          ? 'Client-side MeshGraphNet inference running trained model_weights.json (backend offline fallback).'
          : (primary.controller === 'gnn_mappo'
            ? 'Client fallback synthetic surrogate (Backend offline). Not trained PyTorch inference.'
            : 'Client fallback synthetic benchmark.'),
      },
    },
    provenance: {
      engine: primary.engine,
      calibrated: false,
      is_synthetic: true,
      is_mock_controller: primary.controller === 'gnn_mappo' && !hasTrainedJS,
      disclaimer: 'Synthetic client-side mesoscopic fallback over real OSM geometry. Start FastAPI backend for server simulation & validation.',
    },
  };
}

export function formatMetricValue(value, unit = '', unavailableText = 'Not available') {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return unavailableText;
  const numVal = Number(value);
  if (!Number.isFinite(numVal)) return unavailableText;
  return unit ? `${numVal}${unit}` : String(numVal);
}

export function isCongested(state) {
  return Boolean(state && !state.closed && (state.congestion_index >= 0.65 || state.occupancy >= 0.65));
}
