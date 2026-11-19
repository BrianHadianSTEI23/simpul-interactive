"""Unified 3-region Jakarta corridor graph builder and dynamic VMS signage builder.

Connects Pluit (North), Tanah Abang (Central), and Cilandak (South) through
real-world arterial and bypass corridors while keeping disruption eligibility
masks (Flooding & Demonstration) strictly scoped to the three study areas.
"""
from __future__ import annotations

import copy
import json
import math
from functools import lru_cache
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
CORRIDORS_PATH = ROOT / 'data' / 'connected_corridors.json'

METERS_PER_DEG_LAT = 110574.0
METERS_PER_DEG_LON_JAKARTA = 110680.0


def _polyline_length_m(coords: list[list[float]]) -> float:
    total = 0.0
    for i in range(len(coords) - 1):
        dx = (coords[i + 1][0] - coords[i][0]) * METERS_PER_DEG_LON_JAKARTA
        dy = (coords[i + 1][1] - coords[i][1]) * METERS_PER_DEG_LAT
        total += math.hypot(dx, dy)
    return round(max(10.0, total), 1)


def _bearing_deg(coords: list[list[float]]) -> float:
    if len(coords) < 2:
        return 0.0
    dlon = (coords[-1][0] - coords[0][0]) * METERS_PER_DEG_LON_JAKARTA
    dlat = (coords[-1][1] - coords[0][1]) * METERS_PER_DEG_LAT
    return round(math.degrees(math.atan2(dlon, dlat)) % 360.0, 1)


def classify_turn_direction(from_bearing_deg: float, to_bearing_deg: float) -> dict[str, str]:
    """Classify relative turn direction in clockwise compass bearing degrees."""
    ang = (to_bearing_deg - from_bearing_deg + 180.0) % 360.0 - 180.0
    if abs(ang) <= 35.0:
        return {'code': 'lurus', 'label': 'Lurus', 'en': 'Straight', 'arrow': '↑'}
    if -145.0 <= ang < -35.0:
        return {'code': 'belok_kiri', 'label': 'Belok Kiri', 'en': 'Turn Left', 'arrow': '↰'}
    if 35.0 < ang <= 145.0:
        return {'code': 'belok_kanan', 'label': 'Belok Kanan', 'en': 'Turn Right', 'arrow': '↱'}
    return {'code': 'putar_balik', 'label': 'Putar Balik', 'en': 'U-Turn', 'arrow': '↺'}


@lru_cache(maxsize=1)
def load_corridors_spec() -> dict[str, Any]:
    return json.loads(CORRIDORS_PATH.read_text(encoding='utf-8'))


def build_signage_nodes(region: dict[str, Any]) -> list[dict[str, Any]]:
    """Build static metadata for hoverable dynamic VMS/junction signage."""
    edges_by_id = {e['edge_id']: e for e in region.get('edges', [])}
    inters = region.get('intersections', [])
    mov_by_inter: dict[str, list[dict[str, Any]]] = {}
    for m in region.get('movements', []):
        mov_by_inter.setdefault(m['intersection_id'], []).append(m)

    signage_nodes: list[dict[str, Any]] = []
    for inter in inters:
        nid = inter['node_id']
        movs = mov_by_inter.get(nid, [])
        if not movs and not inter.get('signalized') and not inter.get('is_connector_hub'):
            continue

        by_from: dict[str, list[dict[str, Any]]] = {}
        for m in movs:
            fe = edges_by_id.get(m['from_edge'])
            te = edges_by_id.get(m['to_edge'])
            if not fe or not te:
                continue
            tinfo = classify_turn_direction(float(fe.get('bearing_deg', 0.0)), float(te.get('bearing_deg', 0.0)))
            by_from.setdefault(m['from_edge'], []).append({
                'movement_id': m['movement_id'],
                'from_edge': m['from_edge'],
                'from_name': fe['name'],
                'to_edge': m['to_edge'],
                'to_name': te['name'],
                'dir_code': tinfo['code'],
                'dir_label': tinfo['label'],
                'dir_en': tinfo['en'],
                'dir_arrow': tinfo['arrow'],
            })

        has_branch = any(len(v) >= 2 for v in by_from.values())
        if not has_branch and not inter.get('is_connector_hub') and not inter.get('signalized'):
            continue
        if not by_from:
            continue

        primary_in = max(by_from.keys(), key=lambda eid: len(by_from[eid]))
        signage_nodes.append({
            'signage_id': f'sig-{nid}',
            'intersection_id': nid,
            'name': inter.get('name') or edges_by_id.get(primary_in, {}).get('name', nid),
            'region_id': inter.get('home_region') or region.get('id', 'pluit'),
            'lat': inter['lat'],
            'lon': inter['lon'],
            'signalized': bool(inter.get('signalized')),
            'is_connector_hub': bool(inter.get('is_connector_hub')),
            'is_gateway': bool(inter.get('is_gateway')),
            'approaches': by_from,
        })
    return signage_nodes


def build_connected_region(regions_by_id: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Assemble Pluit + Tanah Abang + Cilandak + inter-regional connector corridors."""
    spec = load_corridors_spec()
    ordered_ids = ['pluit', 'tanah_abang', 'cilandak']

    all_edges: list[dict[str, Any]] = []
    all_inters: list[dict[str, Any]] = []
    all_movements: list[dict[str, Any]] = []
    all_stops: list[dict[str, Any]] = []
    all_landmarks: list[dict[str, Any]] = []
    all_waterbodies: list[dict[str, Any]] = []
    study_boundaries: list[dict[str, Any]] = []
    coverage_masks: list[dict[str, Any]] = []

    for rid in ordered_ids:
        reg = copy.deepcopy(regions_by_id[rid])
        for e in reg['edges']:
            e['home_region'] = rid
            all_edges.append(e)
        for inter in reg['intersections']:
            inter['home_region'] = rid
            all_inters.append(inter)
        all_movements.extend(reg['movements'])
        for s in reg.get('transit_stops', []):
            s['home_region'] = rid
            all_stops.append(s)
        for lm in reg.get('landmarks', []):
            lm['home_region'] = rid
            all_landmarks.append(lm)
        all_waterbodies.extend(reg.get('waterbodies', []))
        study_boundaries.append({'region_id': rid, 'name': reg['name'], 'ring': reg['study_boundary']})
        coverage_masks.append({'region_id': rid, 'name': reg['name'], 'ring': reg['coverage_mask']})

    inter_map = {i['node_id']: i for i in all_inters}
    existing_mov_pairs = {(m['intersection_id'], m['from_edge'], m['to_edge']) for m in all_movements}

    # Add intermediate hubs on inter-regional corridors
    for hub in spec['hubs']:
        nid = hub['node_id']
        hub_inter = {
            'node_id': nid,
            'osm_node_id': nid,
            'name': hub['name'],
            'lat': hub['lat'],
            'lon': hub['lon'],
            'degree': 0,
            'signalized': bool(hub.get('signalized', True)),
            'control_type': hub.get('control_type', 'signalized'),
            'incoming_edges': [],
            'outgoing_edges': [],
            'movement_count': 0,
            'is_connector_hub': True,
            'home_region': 'corridor',
        }
        all_inters.append(hub_inter)
        inter_map[nid] = hub_inter
        all_landmarks.append({
            'id': f'lm-{nid}',
            'name': hub['name'],
            'kind': 'interchange',
            'lat': hub['lat'],
            'lon': hub['lon'],
            'source': 'Jakarta Corridor Hub',
            'home_region': 'corridor',
        })

    # Add bidirectional connector edges (two directed edges per corridor segment)
    edge_counter = 1
    pair_reverse: dict[str, str] = {}
    gateway_nodes: set[str] = set()
    for link in spec['links']:
        coords_fwd = link['coordinates']
        coords_rev = list(reversed(coords_fwd))
        fwd_id = f'conn-e{edge_counter:04d}'
        edge_counter += 1
        rev_id = f'conn-e{edge_counter:04d}'
        edge_counter += 1
        pair_reverse[fwd_id] = rev_id
        pair_reverse[rev_id] = fwd_id

        length_m = _polyline_length_m(coords_fwd)
        base_meta = {
            'osm_way_id': link['id'],
            'name': link['name'],
            'highway': link.get('highway', 'primary'),
            'oneway': False,
            'lanes': int(link.get('lanes', 3)),
            'speed_limit_kmh': float(link.get('speed_limit_kmh', 60.0)),
            'capacity_vph': int(link.get('capacity_vph', 3600)),
            'length_m': length_m,
            'corridor_focus': True,
            'eligible': False,
            'flood_eligible': False,
            'demonstration_eligible': False,
            'is_inter_region_connector': True,
            'corridor_pair': link.get('corridor_pair', 'inter_region'),
            'home_region': 'corridor',
        }

        u, v = link['from_node'], link['to_node']
        fwd_edge = {
            **base_meta,
            'edge_id': fwd_id,
            'direction': 'fwd',
            'from_node': u,
            'to_node': v,
            'bearing_deg': _bearing_deg(coords_fwd),
            'coordinates': coords_fwd,
        }
        rev_edge = {
            **base_meta,
            'edge_id': rev_id,
            'direction': 'rev',
            'from_node': v,
            'to_node': u,
            'bearing_deg': _bearing_deg(coords_rev),
            'coordinates': coords_rev,
        }
        all_edges.extend([fwd_edge, rev_edge])

        for node_id in (u, v):
            if not inter_map[node_id].get('is_connector_hub'):
                inter_map[node_id]['is_gateway'] = True
                inter_map[node_id]['signalized'] = True
                gateway_nodes.add(node_id)

        inter_map[u]['outgoing_edges'].append(fwd_id)
        inter_map[v]['incoming_edges'].append(fwd_id)
        inter_map[v]['outgoing_edges'].append(rev_id)
        inter_map[u]['incoming_edges'].append(rev_id)

    # Wire movements at hubs and gateway intersections (avoiding direct 180-deg self-reversal)
    mov_counter = 1
    edges_by_id = {e['edge_id']: e for e in all_edges}
    touched_nodes = {h['node_id'] for h in spec['hubs']} | gateway_nodes
    for nid in sorted(touched_nodes):
        inter = inter_map[nid]
        for fe_id in inter['incoming_edges']:
            fe = edges_by_id.get(fe_id)
            if not fe:
                continue
            for te_id in inter['outgoing_edges']:
                if fe_id == te_id or pair_reverse.get(fe_id) == te_id:
                    continue
                te = edges_by_id.get(te_id)
                if not te:
                    continue
                # Prevent degenerate U-turn on same OSM street when non-connector alternatives exist
                if abs(((te['bearing_deg'] - fe['bearing_deg'] + 180.0) % 360.0) - 180.0) > 158.0:
                    continue
                key = (nid, fe_id, te_id)
                if key in existing_mov_pairs:
                    continue
                existing_mov_pairs.add(key)
                all_movements.append({
                    'movement_id': f'conn-m{mov_counter:04d}',
                    'intersection_id': nid,
                    'from_edge': fe_id,
                    'to_edge': te_id,
                })
                mov_counter += 1
        inter['movement_count'] = len([m for m in all_movements if m['intersection_id'] == nid])
        inter['degree'] = len(inter['incoming_edges']) + len(inter['outgoing_edges'])

    south = min(regions_by_id[rid]['bbox']['south'] for rid in ordered_ids)
    north = max(regions_by_id[rid]['bbox']['north'] for rid in ordered_ids)
    west = min(regions_by_id[rid]['bbox']['west'] for rid in ordered_ids)
    east = max(regions_by_id[rid]['bbox']['east'] for rid in ordered_ids)

    pluit_ref = regions_by_id['pluit']
    ta_ref = regions_by_id['tanah_abang']
    cil_ref = regions_by_id['cilandak']

    connected = {
        'id': 'all',
        'name': spec['name'],
        'district': spec['district'],
        'subtitle': spec['subtitle'],
        'is_connected_network': True,
        'component_regions': ordered_ids,
        'bbox': {'south': south, 'west': west, 'north': north, 'east': east},
        'center': {'lat': round((south + north) * 0.5, 5), 'lon': round((west + east) * 0.5, 5)},
        'default_zoom': 11.75,
        'primary_disruption': 'flood',
        'scenario_eligibility': {
            'flood': {
                'supported': True,
                'role': 'scoped_to_three_regions',
                'note': 'Flood scenarios remain strictly scoped to Pluit, Tanah Abang, or Cilandak.',
            },
            'demonstration': {
                'supported': True,
                'role': 'scoped_to_three_regions',
                'note': 'Demonstration scenarios remain strictly scoped to Tanah Abang, Cilandak, or Pluit.',
            },
        },
        'disruption_anchors': {
            'flood': {**pluit_ref['disruption_anchors']['flood'], 'region_id': 'pluit'},
            'demonstration': {**ta_ref['disruption_anchors']['demonstration'], 'region_id': 'tanah_abang'},
            'by_region': {
                'pluit': pluit_ref['disruption_anchors'],
                'tanah_abang': ta_ref['disruption_anchors'],
                'cilandak': cil_ref['disruption_anchors'],
            },
        },
        'study_boundary': pluit_ref['study_boundary'],
        'coverage_mask': pluit_ref['coverage_mask'],
        'study_boundaries': study_boundaries,
        'coverage_masks': coverage_masks,
        'landmarks': all_landmarks,
        'transit_stops': all_stops,
        'waterbodies': all_waterbodies,
        'edges': all_edges,
        'intersections': all_inters,
        'movements': all_movements,
        'provenance': pluit_ref['provenance'],
        'stats': {
            'directed_edges': len(all_edges),
            'connector_edges': len(spec['links']) * 2,
            'intersections': len(all_inters),
            'signalized_intersections': sum(1 for i in all_inters if i.get('signalized')),
            'movements': len(all_movements),
            'transit_stops': len(all_stops),
            'flood_eligible_edges': sum(1 for e in all_edges if e.get('flood_eligible')),
            'demonstration_eligible_edges': sum(1 for e in all_edges if e.get('demonstration_eligible')),
        },
    }
    connected['signage_nodes'] = build_signage_nodes(connected)
    return connected


def build_frame_signage(
    signage_nodes: list[dict[str, Any]],
    routing: dict[str, list[tuple[str, float]]],
    turn_actions: dict[str, dict[str, Any]],
    frame_edges: dict[str, dict[str, Any]],
    frame_intersections: dict[str, dict[str, Any]],
    controller: str,
    disruption_context: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    """Build per-frame dynamic VMS signage directives for every hoverable junction."""
    has_flood = bool(disruption_context.get('flood_enabled'))
    has_demo = bool(disruption_context.get('demo_enabled'))
    period_label = disruption_context.get('time_period', 'pagi').capitalize()
    out: dict[str, dict[str, Any]] = {}

    for snode in signage_nodes:
        nid = snode['intersection_id']
        approaches: dict[str, list[dict[str, Any]]] = snode.get('approaches', {})
        if not approaches:
            continue

        # Prefer the incoming road with active turn_actions, connector role, or largest queue
        def approach_priority(fe_id: str) -> tuple[int, int, float]:
            opts = approaches[fe_id]
            has_act = 1 if any(o['movement_id'] in turn_actions for o in opts) else 0
            multi = 1 if len(opts) >= 2 else 0
            q_val = float(frame_edges.get(fe_id, {}).get('queue_veh', 0.0))
            return (multi, has_act, q_val)

        fe_id = max(approaches.keys(), key=approach_priority)
        opts = approaches[fe_id]
        weights_map = dict(routing.get(fe_id, []))
        fe_state = frame_edges.get(fe_id, {})

        sig_state = frame_intersections.get(nid, {})
        if not sig_state:
            light = 'uncontrolled'
            green_s = 0
        else:
            green_edges = sig_state.get('green_edges') or []
            yellow_edges = sig_state.get('yellow_edges') or []
            light = 'yellow' if fe_id in yellow_edges else ('green' if fe_id in green_edges else 'red')
            green_s = int(round(sig_state.get('green_duration_s', 0)))

        turns_payload: list[dict[str, Any]] = []
        blocked_any = False
        redirected_any = False
        for opt in opts:
            te_id = opt['to_edge']
            te_state = frame_edges.get(te_id, {})
            w = float(weights_map.get(te_id, 0.0))
            pct = int(round(w * 100.0))
            ta = turn_actions.get(opt['movement_id'])
            closed = bool(te_state.get('closed'))
            blocked = closed or (ta is not None and ta.get('action') == 'blocked') or (len(opts) > 1 and w <= 0.01)
            if blocked:
                blocked_any = True
            if ta is not None and ta.get('action') == 'redirected':
                redirected_any = True
            turns_payload.append({
                'dir_code': opt['dir_code'],
                'dir_label': opt['dir_label'],
                'dir_en': opt['dir_en'],
                'arrow': opt['dir_arrow'],
                'to_edge': te_id,
                'to_name': opt['to_name'],
                'pct': pct,
                'blocked': blocked,
                'closed': closed,
                'speed_kmh': float(te_state.get('speed_kmh', 0.0)),
                'occ': float(te_state.get('occupancy', 0.0)),
                'flood_i': float(te_state.get('flood_intensity', 0.0)),
                'demo_i': float(te_state.get('demonstration_intensity', 0.0)),
            })

        # Sort open turns first by pct descending
        turns_payload.sort(key=lambda t: (not t['blocked'], t['pct'], t['speed_kmh']), reverse=True)
        top = turns_payload[0]

        if all(t['blocked'] or t['pct'] == 0 for t in turns_payload):
            mode = 'blocked'
            headline = '✕ Koridor Depan Ditutup'
        elif controller == 'gnn_mappo':
            if len(turns_payload) > 1 and (redirected_any or blocked_any or top['pct'] >= 58):
                is_divert = blocked_any or top['dir_code'] != 'lurus' or redirected_any
                mode = 'diverted' if (blocked_any or (top['dir_code'] != 'lurus' and top['pct'] >= 55)) else 'optimal'
                if blocked_any and len(turns_payload) > 1:
                    headline = f"{top['arrow']} {top['dir_label']} ({top['pct']}%) · Dialihkan"
                else:
                    headline = f"{top['arrow']} {top['dir_label']} ({top['pct']}%)"
            else:
                mode = 'optimal'
                headline = f"{top['arrow']} {top['dir_label']} ({top['pct']}%)"
        else:
            mode = 'passive'
            if len(turns_payload) > 1:
                headline = f"⇄ Bagi Arus Merata ({top['arrow']} {top['pct']}%)"
            else:
                headline = f"{top['arrow']} {top['dir_label']} (100%)"

        # Condition-aware human-readable rationale
        worst_blocked = next((t for t in turns_payload if t['blocked']), None)
        if controller == 'gnn_mappo':
            if worst_blocked and worst_blocked['flood_i'] >= 0.35:
                reason = f"SIMPUL alihkan ke {top['dir_label'].lower()} · Hindari banjir di {worst_blocked['to_name']}"
            elif worst_blocked and worst_blocked['demo_i'] >= 0.30:
                reason = f"SIMPUL alihkan ke {top['dir_label'].lower()} · Hindari aksi massa di {worst_blocked['to_name']}"
            elif worst_blocked:
                reason = f"SIMPUL blokir cabang padat ({worst_blocked['to_name']}) · Prioritaskan {top['dir_label'].lower()}"
            elif snode.get('is_connector_hub') or snode.get('is_gateway'):
                reason = f"Koridor penghubung 3 wilayah ({period_label}) · Arahkan ke jalur tercepat ({top['speed_kmh']:.0f} km/j)"
            elif has_flood or has_demo:
                reason = f"Rute adaptif SIMPUL ({period_label}) menjaga kelancaran {top['dir_label'].lower()}"
            else:
                reason = f"Keseimbangan arus GNN-MAPPO ({period_label}) · Antrean {fe_state.get('queue_veh', 0):.1f} kend"
        elif controller == 'max_pressure':
            reason = f"B2 Max-Pressure hanya atur durasi lampu ({light.upper()}) · Tanpa pengalihan rambu"
        else:
            reason = f"B1 Fixed-Time siklus tetap 100s ({light.upper()}) · Tidak merespons gangguan/antrean"

        out[nid] = {
            'from_edge': fe_id,
            'from_name': opts[0]['from_name'],
            'primary_dir': top['dir_code'],
            'primary_label': top['dir_label'],
            'primary_arrow': top['arrow'],
            'primary_to': top['to_name'],
            'primary_pct': top['pct'],
            'mode': mode,
            'headline': headline,
            'reason': reason,
            'light': light,
            'green_s': green_s,
            'turns': turns_payload[:4],
        }
    return out
