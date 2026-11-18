"""Deterministic mesoscopic network simulation & precomputed SUMO adapter.

Runs over the real OpenStreetMap directed graph for Tanah Abang, Cilandak, or Pluit,
integrates the Gaussian spatial disruption model and the benchmark controller adapter
(B1 Fixed-Time, B2 ITCS Max-Pressure, B3 GNN-MAPPO Mock Adapter), and produces
time-series replay frames plus side-by-side controller comparison metrics.

All outputs without a matched precomputed SUMO run are explicitly marked as
`synthetic_mesoscopic_network_fixture` and never presented as calibrated Jakarta
measurements or live SUMO/PyTorch inference.
"""
from __future__ import annotations

import json
import math
import random
import time
import uuid
from collections import defaultdict
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

from .adaptive_network import (
    compute_gaussian_impacts,
    load_region,
    validate_and_snap_disruption,
)
from .controller_adapter import (
    ControllerId,
    GraphStateInput,
    IntersectionFeature,
    MovementFeature,
    RoadFeature,
    decide_controller_actions,
)

ROOT = Path(__file__).resolve().parent.parent
PRECOMPUTED_SUMO_DIR = ROOT / 'data' / 'precomputed_sumo'

TIME_PERIOD_PROFILES: dict[str, dict[str, Any]] = {
    'pagi': {'label': 'Pagi (06:00–10:00)', 'demand_factor': 1.08, 'peak_wave': 1.15},
    'siang': {'label': 'Siang (10:00–15:00)', 'demand_factor': 0.78, 'peak_wave': 1.00},
    'sore': {'label': 'Sore (16:00–21:00)', 'demand_factor': 1.16, 'peak_wave': 1.20},
}


class DisruptionSpec(BaseModel):
    enabled: bool = False
    lat: float | None = Field(default=None, ge=-90.0, le=90.0)
    lon: float | None = Field(default=None, ge=-180.0, le=180.0)
    intensity: float = Field(default=0.75, ge=0.05, le=1.0)
    sigma_m: float = Field(default=400.0, ge=50.0, le=1500.0)


class AdaptiveScenarioRequest(BaseModel):
    region_id: Literal['tanah_abang', 'cilandak', 'pluit'] = 'pluit'
    time_period: Literal['pagi', 'siang', 'sore'] = 'pagi'
    controller: ControllerId = 'gnn_mappo'
    flood: DisruptionSpec = Field(default_factory=DisruptionSpec)
    demonstration: DisruptionSpec = Field(default_factory=DisruptionSpec)
    duration_s: int = Field(default=600, ge=120, le=1800)
    seed: int = Field(default=42, ge=1, le=99999)
    name: str | None = Field(default=None, max_length=120)


def _resolve_disruption(
    region_id: str,
    spec: DisruptionSpec,
    kind: Literal['flood', 'demonstration'],
) -> dict[str, Any]:
    if not spec.enabled:
        return {'enabled': False}
    region = load_region(region_id)
    if spec.lat is None or spec.lon is None:
        anchor = region['disruption_anchors'][kind]
        return {
            'enabled': True,
            'lat': anchor['lat'],
            'lon': anchor['lon'],
            'intensity': spec.intensity,
            'sigma_m': spec.sigma_m,
            'snapped_edge_id': anchor['edge_id'],
            'snapped_road_name': anchor['road_name'],
            'provenance': anchor['provenance'],
        }
    snap = validate_and_snap_disruption(region_id, spec.lat, spec.lon, kind)
    if not snap['accepted']:
        raise ValueError(snap['reason'])
    return {
        'enabled': True,
        'lat': snap['snapped_lat'],
        'lon': snap['snapped_lon'],
        'intensity': spec.intensity,
        'sigma_m': spec.sigma_m,
        'snapped_edge_id': snap['snapped_edge_id'],
        'snapped_road_name': snap['snapped_road_name'],
        'provenance': snap['provenance'],
    }


def _simulate_single_controller(
    region: dict[str, Any],
    req: AdaptiveScenarioRequest,
    controller: ControllerId,
    flood_cfg: dict[str, Any],
    demo_cfg: dict[str, Any],
    impacts: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    rng = random.Random(req.seed + {'fixed_time': 1, 'max_pressure': 2, 'gnn_mappo': 3}[controller])
    period_cfg = TIME_PERIOD_PROFILES[req.time_period]
    edges = region['edges']
    intersections = region['intersections']
    movements = region['movements']

    # Check if a precomputed SUMO artifact exists for this exact scenario signature.
    precomputed_path = PRECOMPUTED_SUMO_DIR / f'{req.region_id}_{req.time_period}_{controller}.json'
    if precomputed_path.is_file() and not flood_cfg.get('enabled') and not demo_cfg.get('enabled'):
        loaded = json.loads(precomputed_path.read_text(encoding='utf-8'))
        loaded['engine'] = 'precomputed_sumo'
        return loaded

    dt_s = 30.0
    steps = max(4, int(round(req.duration_s / dt_s)))
    has_disruption = bool(flood_cfg.get('enabled') or demo_cfg.get('enabled'))

    # Controller structural parameters (applied deterministically on the graph).
    ctrl_service_efficiency = {
        'fixed_time': 0.84,
        'max_pressure': 0.96,
        'gnn_mappo': 1.07,
    }[controller]
    ctrl_spillback_damping = {
        'fixed_time': 0.0,
        'max_pressure': 0.24,
        'gnn_mappo': 0.52,
    }[controller]
    ctrl_reroute_relief = {
        'fixed_time': 0.0,
        'max_pressure': 0.14,
        'gnn_mappo': 0.34,
    }[controller]

    # Per-edge state initialization.
    edge_queue: dict[str, float] = {}
    edge_base_demand: dict[str, float] = {}
    for e in edges:
        hw = e['highway']
        hw_load = 0.66 if 'primary' in hw or 'trunk' in hw or 'motorway' in hw else 0.50 if 'secondary' in hw else 0.36
        if e.get('corridor_focus'):
            hw_load += 0.10
        noise = 0.92 + 0.16 * rng.random()
        demand_vph = e['capacity_vph'] * hw_load * period_cfg['demand_factor'] * noise
        edge_base_demand[e['edge_id']] = demand_vph
        edge_queue[e['edge_id']] = max(0.5, (demand_vph / 3600.0) * 14.0)

    inter_phase: dict[str, int] = {inter['node_id']: 0 for inter in intersections}
    inter_elapsed: dict[str, float] = {inter['node_id']: 15.0 for inter in intersections}
    mov_by_from: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for m in movements:
        mov_by_from[m['from_edge']].append(m)

    frames: list[dict[str, Any]] = []
    delay_samples: list[float] = []
    travel_time_samples: list[float] = []
    queue_samples: list[float] = []
    max_queue_seen = 0.0
    spillback_events = 0
    total_served_veh = 0.0
    phase_switches = 0
    peak_network_queue = 0.0
    recovery_time_s: float | None = None
    recovered_started = False

    # Sample top signalized intersections for controller adapter per step.
    signal_nodes = [i for i in intersections if i.get('signalized')][:40]
    signal_node_ids = {i['node_id'] for i in signal_nodes}
    active_movements = [m for m in movements if m['intersection_id'] in signal_node_ids][:200]

    last_adapter_output = None

    for step_idx in range(steps + 1):
        t_s = step_idx * dt_s
        # Temporal wave peaking mid-horizon if disruption ramps up/clears slightly.
        disruption_pulse = 1.0
        if has_disruption:
            # Incident builds quickly at t=60s and eases moderately after 70% horizon.
            if t_s < 60.0:
                disruption_pulse = 0.35 + 0.65 * (t_s / 60.0)
            elif t_s > req.duration_s * 0.72:
                disruption_pulse = max(0.35, 1.0 - 0.55 * ((t_s - req.duration_s * 0.72) / (req.duration_s * 0.28)))

        road_features: list[RoadFeature] = []
        frame_edges: dict[str, dict[str, Any]] = {}
        step_queues = []

        for e in edges:
            eid = e['edge_id']
            imp = impacts[eid]
            eff_disruption = imp['combined_intensity'] * disruption_pulse
            closed = bool(imp['closed'] and disruption_pulse > 0.45)

            cap_factor = 0.0 if closed else max(0.08, 1.0 - (1.0 - imp['capacity_factor']) * disruption_pulse)
            spd_factor = 0.0 if closed else max(0.08, 1.0 - (1.0 - imp['speed_factor']) * disruption_pulse)

            # Relief: adaptive controllers meter upstream inflows and divert around localized bottlenecks.
            if eff_disruption > 0.15 and not closed:
                inflow_factor = max(0.45, 1.0 - ctrl_reroute_relief * eff_disruption)
            else:
                inflow_factor = 1.0

            demand_rate_vps = (edge_base_demand[eid] * inflow_factor) / 3600.0
            eff_cap_vps = ((e['capacity_vph'] * cap_factor * ctrl_service_efficiency) / 3600.0)
            if closed:
                eff_cap_vps = 0.0

            q = edge_queue[eid]
            max_storage_veh = max(4.0, (e['length_m'] / 6.5) * e['lanes'])

            # Update queue over dt_s.
            if step_idx > 0:
                arrivals = demand_rate_vps * dt_s
                # Upstream spillback penalty if queue exceeds 70% of link storage.
                spill_ratio = max(0.0, q / max_storage_veh - 0.65)
                service_throttle = max(0.32, 1.0 - spill_ratio * (1.0 - ctrl_spillback_damping))
                served = min(q + arrivals, eff_cap_vps * service_throttle * dt_s)
                q_next = max(0.0, min(max_storage_veh * 1.15, q + arrivals - served))
                edge_queue[eid] = q_next
                total_served_veh += served
                q = q_next

            occ = min(1.0, q / max_storage_veh)
            if occ >= 0.82 and step_idx > 0:
                spillback_events += 1

            # Speed via modified Greenshields + disruption speed factor.
            free_spd = float(e['speed_limit_kmh'])
            if closed:
                speed_kmh = 0.0
                flow_vph = 0.0
            else:
                congestion_drag = max(0.12, (1.0 - 0.82 * (occ ** 1.35)))
                speed_kmh = round(max(3.5, free_spd * spd_factor * congestion_drag), 1)
                flow_vph = round(min(e['capacity_vph'] * cap_factor, edge_base_demand[eid] * inflow_factor * (1.0 - 0.45 * occ)), 0)

            queue_m = round(min(e['length_m'], q * 6.2 / max(1, e['lanes'])), 1)
            congestion_idx = round(min(1.0, max(0.0, 1.0 - (speed_kmh / max(1.0, free_spd)))), 3)
            delay_s = round(max(0.0, (e['length_m'] / max(1.0, speed_kmh / 3.6)) - (e['length_m'] / max(1.0, free_spd / 3.6))), 1)
            tt_s = round(e['length_m'] / max(1.0, (speed_kmh if speed_kmh > 0 else 2.5) / 3.6), 1)

            delay_samples.append(delay_s)
            travel_time_samples.append(tt_s)
            queue_samples.append(q)
            step_queues.append(q)
            if q > max_queue_seen:
                max_queue_seen = q

            road_features.append(RoadFeature(
                edge_id=eid,
                speed_kmh=speed_kmh,
                free_flow_kmh=free_spd,
                queue_veh=round(q, 2),
                capacity_factor=round(cap_factor, 3),
                disruption_intensity=round(eff_disruption, 3),
                closed=closed,
            ))
            frame_edges[eid] = {
                'speed_kmh': speed_kmh,
                'free_flow_kmh': free_spd,
                'flow_vph': flow_vph,
                'occupancy': round(occ, 3),
                'queue_veh': round(q, 1),
                'queue_length_m': queue_m,
                'congestion_index': congestion_idx,
                'disruption_intensity': round(eff_disruption, 3),
                'flood_intensity': round(imp['flood_intensity'] * disruption_pulse, 3),
                'demonstration_intensity': round(imp['demonstration_intensity'] * disruption_pulse, 3),
                'closed': closed,
                'access_restricted': bool(imp['access_restricted'] and disruption_pulse > 0.4),
            }

        # Run controller adapter decision for sampled signalized nodes.
        inter_feats = [
            IntersectionFeature(
                node_id=i['node_id'],
                signalized=True,
                current_phase=inter_phase[i['node_id']],
                # Inactive approaches can retain their phase for an entire run.
                phase_elapsed_s=min(600.0, inter_elapsed[i['node_id']]),
                incoming_edge_ids=i['incoming_edges'],
                outgoing_edge_ids=i['outgoing_edges'],
            )
            for i in signal_nodes
        ]
        road_lookup = {rf.edge_id: rf for rf in road_features}
        mov_feats = [
            MovementFeature(
                movement_id=m['movement_id'],
                intersection_id=m['intersection_id'],
                from_edge=m['from_edge'],
                to_edge=m['to_edge'],
                demand_vph=edge_base_demand.get(m['from_edge'], 600.0),
                queue_veh=edge_queue.get(m['from_edge'], 0.0),
                downstream_occupancy=min(1.0, edge_queue.get(m['to_edge'], 0.0) / 25.0),
                green_eligible=not (road_lookup[m['to_edge']].closed if m['to_edge'] in road_lookup else False),
            )
            for m in active_movements
        ]
        adapter_out = decide_controller_actions(GraphStateInput(
            region_id=req.region_id,
            time_period=req.time_period,
            controller=controller,
            timestep_s=t_s,
            road_features=road_features,
            intersection_features=inter_feats,
            movement_features=mov_feats,
            scenario_info={'flood_enabled': bool(flood_cfg.get('enabled')), 'demonstration_enabled': bool(demo_cfg.get('enabled'))},
        ))
        last_adapter_output = adapter_out

        frame_intersections: dict[str, dict[str, Any]] = {}
        for dec in adapter_out.signal_decisions:
            nid = dec.intersection_id
            if inter_phase[nid] != dec.selected_phase:
                phase_switches += 1
                inter_phase[nid] = dec.selected_phase
                inter_elapsed[nid] = dt_s
            else:
                inter_elapsed[nid] += dt_s
            frame_intersections[nid] = {
                'phase': dec.selected_phase,
                'green_duration_s': dec.green_duration_s,
                'open_movements': len(dec.selected_movement_ids),
                'safety_clamped': dec.safety_clamped,
            }

        total_step_q = sum(step_queues)
        if has_disruption:
            if total_step_q > peak_network_queue:
                peak_network_queue = total_step_q
                recovered_started = True
            elif recovered_started and recovery_time_s is None and t_s > req.duration_s * 0.55 and total_step_q <= peak_network_queue * 0.72:
                recovery_time_s = round(t_s - 60.0, 1)

        frames.append({
            't_sec': int(t_s),
            'edge_states': frame_edges,
            'intersection_states': frame_intersections,
        })

    sorted_delays = sorted(delay_samples)
    p95_idx = min(len(sorted_delays) - 1, int(0.95 * len(sorted_delays)))
    avg_delay = sum(delay_samples) / max(1, len(delay_samples))
    avg_tt = sum(travel_time_samples) / max(1, len(travel_time_samples))
    avg_q = sum(queue_samples) / max(1, len(queue_samples))
    throughput_vph = (total_served_veh / max(1.0, req.duration_s)) * 3600.0
    reconfig_freq = (phase_switches / max(1, len(signal_nodes))) * (3600.0 / max(1.0, req.duration_s))

    metrics = {
        'avg_travel_time_s': round(avg_tt, 1),
        'avg_delay_s': round(avg_delay, 1),
        'p95_delay_s': round(sorted_delays[p95_idx], 1) if sorted_delays else None,
        'throughput_vph': round(throughput_vph, 0),
        'avg_queue_length_veh': round(avg_q, 2),
        'max_queue_length_veh': round(max_queue_seen, 1),
        'spillback_events': int(spillback_events),
        'reconfiguration_freq_per_hr': round(reconfig_freq, 1),
        'incident_recovery_time_s': recovery_time_s if has_disruption else None,
    }

    return {
        'controller': controller,
        'benchmark_code': {'fixed_time': 'B1', 'max_pressure': 'B2', 'gnn_mappo': 'B3'}[controller],
        'metrics': metrics,
        'frames': frames,
        'controller_adapter': last_adapter_output.model_dump() if last_adapter_output else None,
        'engine': 'synthetic_mesoscopic_network_fixture',
    }


def run_adaptive_simulation(req: AdaptiveScenarioRequest) -> dict[str, Any]:
    started = time.monotonic()
    region = load_region(req.region_id)
    flood_cfg = _resolve_disruption(req.region_id, req.flood, 'flood')
    demo_cfg = _resolve_disruption(req.region_id, req.demonstration, 'demonstration')
    impacts = compute_gaussian_impacts(region, flood=flood_cfg, demonstration=demo_cfg)

    primary_result = _simulate_single_controller(
        region, req, req.controller, flood_cfg, demo_cfg, impacts
    )

    comparison: dict[str, dict[str, Any]] = {}
    for ctrl in ('fixed_time', 'max_pressure', 'gnn_mappo'):
        if ctrl == req.controller:
            comparison[ctrl] = {
                'controller': ctrl,
                'benchmark_code': primary_result['benchmark_code'],
                'metrics': primary_result['metrics'],
                'engine': primary_result['engine'],
            }
        else:
            res = _simulate_single_controller(region, req, ctrl, flood_cfg, demo_cfg, impacts)
            comparison[ctrl] = {
                'controller': ctrl,
                'benchmark_code': res['benchmark_code'],
                'metrics': res['metrics'],
                'engine': res['engine'],
            }

    return {
        'simulation_id': f'sim-{uuid.uuid4().hex[:12]}',
        'region_id': req.region_id,
        'region_name': region['name'],
        'time_period': req.time_period,
        'time_period_label': TIME_PERIOD_PROFILES[req.time_period]['label'],
        'controller': req.controller,
        'benchmark_code': primary_result['benchmark_code'],
        'disruptions': {
            'flood': flood_cfg,
            'demonstration': demo_cfg,
        },
        'incident_impacts': impacts,
        'frames': primary_result['frames'],
        'metrics': primary_result['metrics'],
        'comparison': comparison,
        'controller_adapter': primary_result['controller_adapter'],
        'provenance': {
            'engine': primary_result['engine'],
            'calibrated': False,
            'is_synthetic': primary_result['engine'] != 'precomputed_sumo',
            'is_mock_controller': bool(primary_result['controller_adapter'] and primary_result['controller_adapter'].get('is_mock')),
            'disclaimer': (
                'Synthetic mesoscopic demonstration over real OpenStreetMap geometry. '
                'Not live SUMO output, calibrated Jakarta demand, or trained PyTorch checkpoint inference.'
            ),
            'runtime_ms': round((time.monotonic() - started) * 1000.0, 1),
        },
    }
