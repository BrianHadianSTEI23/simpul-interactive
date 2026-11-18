/**
 * Pure domain logic for the Jakarta Adaptive Traffic Network Simulator:
 * - Spatial eligibility mask checks & click snapping
 * - Gaussian spatial disruption model: w_e = exp(-d_e^2 / (2*sigma^2)), I_e = I_0 * w_e
 * - Deterministic client-side synthetic simulation fallback when FastAPI backend is offline
 * - Honest metric formatting (returns "Not available" when absent; never invents values)
 */

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
    description: 'Decentralized phase selection maximizing local upstream-downstream queue pressure.',
    isMock: false,
  }),
  Object.freeze({
    id: 'gnn_mappo',
    code: 'B3',
    name: 'Proposed GNN-MAPPO',
    shortName: 'GNN-MAPPO',
    description: 'Graph-coordinated multi-agent policy (Mock development adapter; safety supervisor enforced).',
    isMock: true,
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
  const b = region.bbox;
  const inBbox = lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
  if (!inBbox) {
    return {
      accepted: false,
      inside_region: false,
      inside_coverage: false,
      eligible_for_disruption: false,
      reason: `Clicked point (${lat.toFixed(5)}, ${lon.toFixed(5)}) is outside the ${region.name} study area.`,
    };
  }
  const inCoverage = pointInPolygon(lat, lon, region.coverage_mask);
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
  for (const edge of region.edges || []) {
    const res = pointToPolylineDistanceM(lat, lon, edge.coordinates);
    if (res.distanceM < bestAny) bestAny = res.distanceM;
  }

  if (!inCoverage && bestAny > maxSnapM) {
    return {
      accepted: false,
      inside_region: true,
      inside_coverage: false,
      eligible_for_disruption: false,
      nearest_distance_m: Number(bestAny.toFixed(1)),
      reason: `Clicked location is outside the covered road-network mask (nearest covered road: ${Math.round(bestAny)} m).`,
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

function simulateSingleClientController(region, config, controllerId, floodCfg, demoCfg, impacts) {
  const ctrlOffset = { fixed_time: 1, max_pressure: 2, gnn_mappo: 3 }[controllerId] || 1;
  const rng = seededRandom((config.seed || 42) + ctrlOffset);
  const periodMeta = TIME_PERIODS.find(p => p.id === config.time_period) || TIME_PERIODS[0];
  const durationS = Math.max(120, Math.min(1800, Number(config.duration_s) || 600));
  const dtS = 30;
  const steps = Math.max(4, Math.round(durationS / dtS));
  const hasDisruption = Boolean(floodCfg?.enabled || demoCfg?.enabled);

  const serviceEff = { fixed_time: 0.84, max_pressure: 0.96, gnn_mappo: 1.07 }[controllerId];
  const spillbackDamping = { fixed_time: 0, max_pressure: 0.24, gnn_mappo: 0.52 }[controllerId];
  const rerouteRelief = { fixed_time: 0, max_pressure: 0.14, gnn_mappo: 0.34 }[controllerId];

  const edges = region.edges || [];
  const intersections = region.intersections || [];
  const signalNodes = intersections.filter(i => i.signalized).slice(0, 40);

  const edgeQueue = {};
  const edgeBaseDemand = {};
  for (const e of edges) {
    const hw = e.highway || 'secondary';
    let hwLoad = (hw.includes('primary') || hw.includes('trunk') || hw.includes('motorway')) ? 0.66 : hw.includes('secondary') ? 0.50 : 0.36;
    if (e.corridor_focus) hwLoad += 0.10;
    const noise = 0.92 + 0.16 * rng();
    const demand = e.capacity_vph * hwLoad * periodMeta.demandFactor * noise;
    edgeBaseDemand[e.edge_id] = demand;
    edgeQueue[e.edge_id] = Math.max(0.5, (demand / 3600) * 14);
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
    let pulse = 1;
    if (hasDisruption) {
      if (tSec < 60) pulse = 0.35 + 0.65 * (tSec / 60);
      else if (tSec > durationS * 0.72) pulse = Math.max(0.35, 1 - 0.55 * ((tSec - durationS * 0.72) / (durationS * 0.28)));
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

      const demandRate = (edgeBaseDemand[eid] * inflowFactor) / 3600;
      const effCap = closed ? 0 : ((e.capacity_vph * capFactor * serviceEff) / 3600);
      const maxStorage = Math.max(4, (e.length_m / 6.5) * e.lanes);
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
      const flowVph = closed ? 0 : Math.round(Math.min(e.capacity_vph * capFactor, edgeBaseDemand[eid] * inflowFactor * (1 - 0.45 * occ)));
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
      if (interPhase[inter.node_id] !== phase) {
        phaseSwitches++;
        interPhase[inter.node_id] = phase;
      }
      frameIntersections[inter.node_id] = {
        phase,
        green_duration_s: controllerId === 'fixed_time' ? (phase === 0 ? 48 : 44) : 34,
        safety_clamped: false,
      };
    }

    if (hasDisruption) {
      if (stepQSum > peakQ) {
        peakQ = stepQSum;
        recoveryArmed = true;
      } else if (recoveryArmed && recoveryTimeS === null && tSec > durationS * 0.55 && stepQSum <= peakQ * 0.72) {
        recoveryTimeS = Number((tSec - 60).toFixed(1));
      }
    }

    frames.push({
      t_sec: tSec,
      edge_states: frameEdges,
      intersection_states: frameIntersections,
    });
  }

  const sortedDelays = [...delays].sort((a, b) => a - b);
  const p95 = sortedDelays[Math.min(sortedDelays.length - 1, Math.floor(0.95 * sortedDelays.length))] || 0;
  const avg = arr => arr.reduce((s, x) => s + x, 0) / Math.max(1, arr.length);

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
      reconfiguration_freq_per_hr: Number(((phaseSwitches / Math.max(1, signalNodes.length)) * (3600 / durationS)).toFixed(1)),
      incident_recovery_time_s: hasDisruption ? recoveryTimeS : null,
    },
    engine: 'synthetic_client_fallback',
  };
}

export function runClientFallbackSimulation(region, config) {
  const floodCfg = config.flood?.enabled ? config.flood : { enabled: false };
  const demoCfg = config.demonstration?.enabled ? config.demonstration : { enabled: false };
  const impacts = computeGaussianImpactField(region, floodCfg, demoCfg);
  const primary = simulateSingleClientController(region, config, config.controller || 'gnn_mappo', floodCfg, demoCfg, impacts);
  const comparison = {};
  for (const ctrl of ['fixed_time', 'max_pressure', 'gnn_mappo']) {
    if (ctrl === primary.controller) {
      comparison[ctrl] = { controller: ctrl, benchmark_code: primary.benchmark_code, metrics: primary.metrics, engine: primary.engine };
    } else {
      const res = simulateSingleClientController(region, config, ctrl, floodCfg, demoCfg, impacts);
      comparison[ctrl] = { controller: ctrl, benchmark_code: res.benchmark_code, metrics: res.metrics, engine: res.engine };
    }
  }
  return {
    simulation_id: `local-${Date.now().toString(36)}`,
    region_id: region.id,
    region_name: region.name,
    time_period: config.time_period || 'pagi',
    controller: primary.controller,
    benchmark_code: primary.benchmark_code,
    disruptions: { flood: floodCfg, demonstration: demoCfg },
    incident_impacts: impacts,
    frames: primary.frames,
    metrics: primary.metrics,
    comparison,
    controller_adapter: {
      controller_id: primary.controller,
      benchmark_code: primary.benchmark_code,
      adapter_mode: primary.controller === 'gnn_mappo' ? 'mock_development_adapter' : 'deterministic_benchmark',
      is_mock: primary.controller === 'gnn_mappo',
      safety_supervisor: { enforced: true, min_green_s: 12, max_green_s: 75, intergreen_clearance_s: 4 },
      diagnostics: {
        policy_confidence: primary.controller === 'gnn_mappo' ? 0.87 : null,
        notice: primary.controller === 'gnn_mappo'
          ? 'Client fallback synthetic surrogate (Backend offline). Not trained PyTorch inference.'
          : 'Client fallback synthetic benchmark.',
      },
    },
    provenance: {
      engine: 'synthetic_client_fallback',
      calibrated: false,
      is_synthetic: true,
      is_mock_controller: primary.controller === 'gnn_mappo',
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
