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


CORRIDOR_ORDER = (
    'pluit',
    'tambora',
    'tomang_harmoni',
    'tanah_abang',
    'sudirman_senayan',
    'kebayoran_baru',
    'kemang_cipete',
    'cilandak',
)


def build_connected_region(regions_by_id: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Assemble all areas from Pluit to Cilandak via their real-world shared OSM streets."""
    spec = load_corridors_spec()
    ordered_ids = [rid for rid in CORRIDOR_ORDER if rid in regions_by_id]
    for rid in regions_by_id:
        if rid not in ordered_ids:
            ordered_ids.append(rid)

    all_edges: list[dict[str, Any]] = []
    edge_by_id: dict[str, dict[str, Any]] = {}
    edge_key_to_id: dict[tuple[Any, str, str, str], str] = {}
    edge_alias: dict[str, str] = {}
    edge_regions: dict[str, set[str]] = {}

    inter_map: dict[str, dict[str, Any]] = {}
    inter_regions: dict[str, set[str]] = {}

    raw_movements: list[dict[str, Any]] = []
    all_stops: list[dict[str, Any]] = []
    seen_stops: set[str] = set()
    all_landmarks: list[dict[str, Any]] = []
    seen_landmarks: set[str] = set()
    all_waterbodies: list[dict[str, Any]] = []
    seen_waterbodies: set[Any] = set()
    study_boundaries: list[dict[str, Any]] = []
    coverage_masks: list[dict[str, Any]] = []

    for rid in ordered_ids:
        reg = copy.deepcopy(regions_by_id[rid])
        for e in reg['edges']:
            orig_eid = e['edge_id']
            key = (e.get('osm_way_id'), e['from_node'], e['to_node'], e.get('direction', 'fwd'))
            if key in edge_key_to_id:
                canon_id = edge_key_to_id[key]
                edge_alias[orig_eid] = canon_id
                edge_regions[canon_id].add(rid)
                edge_by_id[canon_id]['is_inter_region_connector'] = True
                edge_by_id[canon_id]['corridor_pair'] = f"{edge_by_id[canon_id]['home_region']}_{rid}"
            else:
                edge_key_to_id[key] = orig_eid
                edge_alias[orig_eid] = orig_eid
                edge_regions[orig_eid] = {rid}
                e['home_region'] = rid
                e.setdefault('is_inter_region_connector', False)
                all_edges.append(e)
                edge_by_id[orig_eid] = e

        for inter in reg['intersections']:
            nid = inter['node_id']
            inc = [edge_alias.get(eid, eid) for eid in inter.get('incoming_edges', [])]
            out = [edge_alias.get(eid, eid) for eid in inter.get('outgoing_edges', [])]
            if nid in inter_map:
                existing = inter_map[nid]
                inter_regions[nid].add(rid)
                existing['is_gateway'] = True
                existing['signalized'] = True
                existing['incoming_edges'] = list(dict.fromkeys(existing['incoming_edges'] + inc))
                existing['outgoing_edges'] = list(dict.fromkeys(existing['outgoing_edges'] + out))
            else:
                inter['home_region'] = rid
                inter['incoming_edges'] = list(dict.fromkeys(inc))
                inter['outgoing_edges'] = list(dict.fromkeys(out))
                inter_map[nid] = inter
                inter_regions[nid] = {rid}

        raw_movements.extend(reg.get('movements', []))

        for s in reg.get('transit_stops', []):
            sid = s.get('stop_id') or f"{s.get('name')}_{s.get('lat')}_{s.get('lon')}"
            if sid in seen_stops:
                continue
            seen_stops.add(sid)
            s['home_region'] = rid
            all_stops.append(s)

        for lm in reg.get('landmarks', []):
            lid = lm.get('id') or lm.get('name')
            if lid in seen_landmarks:
                continue
            seen_landmarks.add(lid)
            lm['home_region'] = rid
            all_landmarks.append(lm)

        for wb in reg.get('waterbodies', []):
            wid = wb.get('osm_way_id') or wb.get('name')
            if wid in seen_waterbodies:
                continue
            seen_waterbodies.add(wid)
            all_waterbodies.append(wb)

        study_boundaries.append({'region_id': rid, 'name': reg['name'], 'ring': reg['study_boundary']})
        coverage_masks.append({'region_id': rid, 'name': reg['name'], 'ring': reg['coverage_mask']})

    all_inters = list(inter_map.values())
    gateway_nodes = {nid for nid, rset in inter_regions.items() if len(rset) >= 2}

    # Mark real OSM edges touching shared boundary gateways as inter-region connectors.
    for e in all_edges:
        if e['from_node'] in gateway_nodes or e['to_node'] in gateway_nodes or len(edge_regions.get(e['edge_id'], ())) >= 2:
            e['is_inter_region_connector'] = True
            e.setdefault('corridor_pair', 'inter_region')

    # Remap and deduplicate movements using canonical edge IDs.
    all_movements: list[dict[str, Any]] = []
    existing_mov_pairs: set[tuple[str, str, str]] = set()
    for m in raw_movements:
        nid = m['intersection_id']
        fe = edge_alias.get(m['from_edge'], m['from_edge'])
        te = edge_alias.get(m['to_edge'], m['to_edge'])
        if fe not in edge_by_id or te not in edge_by_id or nid not in inter_map:
            continue
        key = (nid, fe, te)
        if key in existing_mov_pairs:
            continue
        existing_mov_pairs.add(key)
        all_movements.append({
            **m,
            'from_edge': fe,
            'to_edge': te,
        })

    # Wire cross-boundary turns at shared OSM gateway intersections.
    pair_reverse: dict[str, str] = {}
    rev_lookup: dict[tuple[Any, str, str], str] = {}
    for e in all_edges:
        rev_lookup[(e.get('osm_way_id'), e['from_node'], e['to_node'])] = e['edge_id']
    for e in all_edges:
        opp = rev_lookup.get((e.get('osm_way_id'), e['to_node'], e['from_node']))
        if opp and opp != e['edge_id']:
            pair_reverse[e['edge_id']] = opp

    mov_counter = 1
    for nid in sorted(gateway_nodes):
        inter = inter_map[nid]
        for fe_id in inter['incoming_edges']:
            fe = edge_by_id.get(fe_id)
            if not fe:
                continue
            for te_id in inter['outgoing_edges']:
                if fe_id == te_id or pair_reverse.get(fe_id) == te_id:
                    continue
                te = edge_by_id.get(te_id)
                if not te:
                    continue
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
        inter['degree'] = len(set(inter['incoming_edges']) | set(inter['outgoing_edges']))

    south = min(regions_by_id[rid]['bbox']['south'] for rid in ordered_ids)
    north = max(regions_by_id[rid]['bbox']['north'] for rid in ordered_ids)
    west = min(regions_by_id[rid]['bbox']['west'] for rid in ordered_ids)
    east = max(regions_by_id[rid]['bbox']['east'] for rid in ordered_ids)

    pluit_ref = regions_by_id['pluit']
    ta_ref = regions_by_id['tanah_abang']
    connector_count = sum(1 for e in all_edges if e.get('is_inter_region_connector'))

    connected = {
        'id': 'all',
        'name': 'All Areas Connected (Pluit ↔ Cilandak)',
        'district': 'Jakarta Utara · Jakarta Barat · Jakarta Pusat · Jakarta Selatan',
        'subtitle': f'Unified {len(ordered_ids)}-area Jakarta corridor network · Pluit to Cilandak via real OSM streets',
        'is_connected_network': True,
        'component_regions': ordered_ids,
        'bbox': {'south': south, 'west': west, 'north': north, 'east': east},
        'center': {'lat': round((south + north) * 0.5, 5), 'lon': round((west + east) * 0.5, 5)},
        'default_zoom': 11.75,
        'primary_disruption': 'flood',
        'scenario_eligibility': {
            'flood': {
                'supported': True,
                'role': 'scoped_to_all_corridor_areas',
                'note': f'Flood scenarios cover all {len(ordered_ids)} connected study areas between Pluit and Cilandak.',
            },
            'demonstration': {
                'supported': True,
                'role': 'scoped_to_all_corridor_areas',
                'note': f'Demonstration scenarios cover all {len(ordered_ids)} connected study areas between Pluit and Cilandak.',
            },
        },
        'disruption_anchors': {
            'flood': {**pluit_ref['disruption_anchors']['flood'], 'region_id': 'pluit'},
            'demonstration': {**ta_ref['disruption_anchors']['demonstration'], 'region_id': 'tanah_abang'},
            'by_region': {rid: regions_by_id[rid]['disruption_anchors'] for rid in ordered_ids},
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
            'connector_edges': connector_count,
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
            if len(turns_payload) > 1 and (redirected_any or blocked_any or top['pct'] >= 56):
                is_divert = blocked_any or (top['dir_code'] != 'lurus' and top['pct'] >= 50) or (redirected_any and top['pct'] >= 58)
                mode = 'diverted' if is_divert else 'optimal'
                if blocked_any or is_divert:
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
                reason = f"Koridor penghubung antarwilayah ({period_label}) · Arahkan ke jalur tercepat ({top['speed_kmh']:.0f} km/j)"
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
