"""Zero-dependency trained MeshGraphNet / ATNTActor inference for simpul-interactive.

Loads the exported trained weights (`data/model_weights.json`) and executes the exact
HeteroSpatioTemporalGNNEncoder + ATNTActor forward pass using sparse incidence lists.
Uses NumPy when installed (~3-5 ms/step) with pure-Python fallback (zero extra Vercel deps).
"""
from __future__ import annotations

import json
import math
import operator
from functools import lru_cache
from pathlib import Path
from typing import Any

from .adaptive_network import load_region

try:
    import numpy as _np  # type: ignore
except ImportError:  # pragma: no cover - pure-Python serverless fallback
    _np = None

ROOT = Path(__file__).resolve().parent.parent
WEIGHTS_PATH = ROOT / 'data' / 'model_weights.json'


def _signed_angle_diff_deg(a_deg: float, b_deg: float) -> float:
    return (b_deg - a_deg + 180.0) % 360.0 - 180.0


def _clip(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else (hi if v > hi else v)


def _linear_py(
    x: list[list[float]],
    w_rows: list[list[float]],
    b: list[float],
    activation: str = 'none',
) -> list[list[float]]:
    mul = operator.mul
    out: list[list[float]] = []
    for row in x:
        o_row = [sum(map(mul, row, w_r)) + b_o for w_r, b_o in zip(w_rows, b)]
        if activation == 'relu':
            o_row = [v if v > 0.0 else 0.0 for v in o_row]
        elif activation == 'sigmoid':
            o_row = [1.0 / (1.0 + math.exp(-_clip(v, -60.0, 60.0))) for v in o_row]
        out.append(o_row)
    return out


def _sparse_agg_py(
    src_h: list[list[float]],
    adj_rows: list[list[tuple[int, float]]],
    dim: int,
) -> list[list[float]]:
    out: list[list[float]] = []
    for neighbors in adj_rows:
        acc = [0.0] * dim
        for src_idx, weight in neighbors:
            s_vec = src_h[src_idx]
            for d in range(dim):
                acc[d] += weight * s_vec[d]
        out.append(acc)
    return out


@lru_cache(maxsize=1)
def load_trained_weights() -> dict[str, Any] | None:
    if not WEIGHTS_PATH.is_file():
        return None
    raw = json.loads(WEIGHTS_PATH.read_text(encoding='utf-8'))
    sd = raw['state_dict']
    if _np is not None:
        raw['_np_sd'] = {
            k: _np.array(v['data'], dtype=_np.float32).reshape(v['shape'])
            for k, v in sd.items()
        }
    else:
        raw['_py_sd'] = {
            k: (
                [v['data'][r * v['shape'][1] : (r + 1) * v['shape'][1]] for r in range(v['shape'][0])]
                if len(v['shape']) == 2
                else v['data']
            )
            for k, v in sd.items()
        }
    return raw


@lru_cache(maxsize=4)
def get_compiled_region_graph(region_id: str) -> dict[str, Any]:
    """Precompile static heterogeneous topology & normalized sparse incidence lists."""
    region = load_region(region_id)
    edges = region['edges']
    inters = region['intersections']
    movs = region['movements']
    stops = region.get('transit_stops', [])

    n_i = len(inters)
    n_r = len(edges)
    n_m = len(movs)

    inter_ids = [i['node_id'] for i in inters]
    road_ids = [e['edge_id'] for e in edges]
    mov_ids = [m['movement_id'] for m in movs]
    inter_idx = {nid: idx for idx, nid in enumerate(inter_ids)}
    road_idx = {eid: idx for idx, eid in enumerate(road_ids)}
    mov_idx = {mid: idx for idx, mid in enumerate(mov_ids)}

    road_len = [max(5.0, float(e['length_m'])) for e in edges]
    road_lanes = [max(1.0, float(e['lanes'])) for e in edges]
    road_cap = [max(200.0, float(e['capacity_vph'])) for e in edges]
    road_spd = [max(10.0, float(e['speed_limit_kmh'])) for e in edges]
    road_max_q = [max(4.0, (road_len[r] / 6.5) * road_lanes[r]) for r in range(n_r)]
    road_bearing = [float(e.get('bearing_deg', 0.0)) for e in edges]

    road_transit = [0.0] * n_r
    for r, e in enumerate(edges):
        coords = e['coordinates']
        mlon, mlat = coords[len(coords) // 2]
        cnt = 0
        for s in stops:
            if math.hypot((s['lat'] - mlat) * 110574.0, (s['lon'] - mlon) * 110680.0) <= 180.0:
                cnt += 1
        road_transit[r] = float(cnt)

    inter_transit = [0.0] * n_i
    for i, inter in enumerate(inters):
        ilat, ilon = float(inter['lat']), float(inter['lon'])
        cnt = 0
        for s in stops:
            if math.hypot((s['lat'] - ilat) * 110574.0, (s['lon'] - ilon) * 110680.0) <= 200.0:
                cnt += 1
        inter_transit[i] = float(cnt)

    inter_in = [[road_idx[eid] for eid in inter.get('incoming_edges', []) if eid in road_idx] for inter in inters]
    inter_out = [[road_idx[eid] for eid in inter.get('outgoing_edges', []) if eid in road_idx] for inter in inters]

    adj_r2i_in = [[(r, 1.0 / max(1, len(inc))) for r in inc] for inc in inter_in]
    adj_r2i_out = [[(r, 1.0 / max(1, len(out))) for r in out] for out in inter_out]

    adj_i2r_t: list[list[tuple[int, float]]] = [[] for _ in range(n_r)]
    for ii, inc in enumerate(inter_in):
        w = 0.5 / max(1, len(inc))
        for r in inc:
            adj_i2r_t[r].append((ii, w))
    for ii, out in enumerate(inter_out):
        w = 0.5 / max(1, len(out))
        for r in out:
            adj_i2r_t[r].append((ii, w))

    i2i_sets: list[set[int]] = [set() for _ in range(n_i)]
    for e in edges:
        u = inter_idx.get(e['from_node'])
        v = inter_idx.get(e['to_node'])
        if u is not None and v is not None and u != v:
            i2i_sets[u].add(v)
            i2i_sets[v].add(u)
    adj_i2i = [[(nbr, 1.0 / max(1, len(nbrs))) for nbr in sorted(nbrs)] for nbrs in i2i_sets]

    inter_movs: list[list[int]] = [[] for _ in range(n_i)]
    mov_from = [0] * n_m
    mov_to = [0] * n_m
    mov_inter = [0] * n_m
    mov_turn_type: list[tuple[float, float, float]] = []
    mov_parity = [0.0] * n_m

    for m_i, m in enumerate(movs):
        ii = inter_idx[m['intersection_id']]
        fr = road_idx[m['from_edge']]
        tr = road_idx[m['to_edge']]
        mov_inter[m_i] = ii
        mov_from[m_i] = fr
        mov_to[m_i] = tr
        inter_movs[ii].append(m_i)
        ang = _signed_angle_diff_deg(road_bearing[fr], road_bearing[tr])
        if abs(ang) <= 35.0:
            mov_turn_type.append((1.0, 0.0, 0.0))
        elif ang < -35.0:
            mov_turn_type.append((0.0, 1.0, 0.0))
        else:
            mov_turn_type.append((0.0, 0.0, 1.0))
        b_in = road_bearing[fr] % 180.0
        mov_parity[m_i] = 0.0 if (b_in < 45.0 or b_in >= 135.0) else 1.0

    mov_conflict = [0.0] * n_m
    for m_list in inter_movs:
        for a in m_list:
            c = 0
            for b in m_list:
                if a != b and (mov_parity[a] != mov_parity[b] or (mov_from[a] != mov_from[b] and mov_to[a] == mov_to[b])):
                    c += 1
            mov_conflict[a] = float(c)

    adj_m2i = [[(m_i, 1.0 / max(1, len(m_list))) for m_i in m_list] for m_list in inter_movs]
    adj_i2m_t = [[(mov_inter[m_i], 1.0 / max(1, len(inter_movs[mov_inter[m_i]])))] for m_i in range(n_m)]

    out: dict[str, Any] = {
        'n_i': n_i, 'n_r': n_r, 'n_m': n_m,
        'inter_ids': inter_ids, 'road_ids': road_ids, 'mov_ids': mov_ids,
        'inter_idx': inter_idx, 'road_idx': road_idx, 'mov_idx': mov_idx,
        'signalized': [1.0 if i.get('signalized') else 0.0 for i in inters],
        'road_len': road_len, 'road_lanes': road_lanes, 'road_cap': road_cap,
        'road_spd': road_spd, 'road_max_q': road_max_q, 'road_transit': road_transit,
        'inter_transit': inter_transit, 'inter_in': inter_in, 'inter_out': inter_out,
        'inter_movs': inter_movs, 'mov_from': mov_from, 'mov_to': mov_to,
        'mov_inter': mov_inter, 'mov_turn_type': mov_turn_type,
        'mov_conflict': mov_conflict, 'mov_parity': mov_parity,
        'adj_r2i_in': adj_r2i_in, 'adj_r2i_out': adj_r2i_out,
        'adj_i2r_t': adj_i2r_t, 'adj_m2i': adj_m2i,
        'adj_i2m_t': adj_i2m_t, 'adj_i2i': adj_i2i,
    }
    if _np is not None:
        def _to_dense(rows: list[list[tuple[int, float]]], cols: int) -> Any:
            mat = _np.zeros((len(rows), cols), dtype=_np.float32)
            for ri, row in enumerate(rows):
                for ci, w in row:
                    mat[ri, ci] += w
            return mat

        np_r2i_in = _to_dense(adj_r2i_in, n_r)
        np_r2i_out = _to_dense(adj_r2i_out, n_r)
        np_m2i = _to_dense(adj_m2i, n_m)
        np_i2i = _to_dense(adj_i2i, n_i)
        out['_np_adj'] = {
            'r2i_in': np_r2i_in,
            'r2i_out': np_r2i_out,
            'i2r_t': 0.5 * (np_r2i_in.T + np_r2i_out.T),
            'm2i': np_m2i,
            'i2m_t': np_m2i.T,
            'i2i': np_i2i,
        }
    return out


def _forward_numpy(
    weights: dict[str, Any],
    g: dict[str, Any],
    inter_x: list[list[float]],
    road_x: list[list[float]],
    mov_x: list[list[float]],
) -> list[list[float]]:
    sd = weights['_np_sd']
    adj = g['_np_adj']
    arch = weights['architecture']

    def lin(x: Any, key: str, act: str = 'none') -> Any:
        y = x @ sd[f'{key}.weight'].T + sd[f'{key}.bias']
        if act == 'relu':
            return _np.maximum(0.0, y)
        if act == 'sigmoid':
            return 1.0 / (1.0 + _np.exp(-_np.clip(y, -60.0, 60.0)))
        return y

    h_i = lin(lin(_np.array(inter_x, dtype=_np.float32), 'encoder.inter_enc_1', 'relu'), 'encoder.inter_enc_2', 'relu')
    h_r = lin(lin(_np.array(road_x, dtype=_np.float32), 'encoder.road_enc_1', 'relu'), 'encoder.road_enc_2', 'relu')
    h_m = lin(lin(_np.array(mov_x, dtype=_np.float32), 'encoder.mov_enc_1', 'relu'), 'encoder.mov_enc_2', 'relu')

    for l in range(int(arch['num_layers'])):
        p = f'encoder.mp_layers.{l}'
        gate_r = lin(h_r, f'{p}.road_gate', 'sigmoid')
        m_r_in = lin(h_r, f'{p}.road_in_msg', 'relu') * gate_r
        m_r_out = lin(h_r, f'{p}.road_out_msg', 'relu') * gate_r
        m_mov = lin(h_m, f'{p}.mov_msg', 'relu')
        m_nbr = lin(h_i, f'{p}.nbr_msg', 'relu')

        cat_i = _np.concatenate([
            h_i,
            adj['r2i_in'] @ m_r_in,
            adj['r2i_out'] @ m_r_out,
            adj['m2i'] @ m_mov,
            adj['i2i'] @ m_nbr,
        ], axis=-1)
        h_i_next = h_i + lin(lin(cat_i, f'{p}.inter_up_1', 'relu'), f'{p}.inter_up_2', 'none')

        i_to_r = adj['i2r_t'] @ h_i_next
        i_to_m = adj['i2m_t'] @ h_i_next
        h_r = h_r + lin(_np.concatenate([h_r, i_to_r], axis=-1), f'{p}.road_up', 'relu')
        h_m = h_m + lin(_np.concatenate([h_m, i_to_m], axis=-1), f'{p}.mov_up', 'relu')
        h_i = h_i_next

    if arch.get('use_temporal_forecast'):
        road_fc = lin(h_r, 'encoder.forecast_head', 'none')
        agg_fc = adj['r2i_in'] @ road_fc
        h_i = lin(_np.concatenate([h_i, agg_fc], axis=-1), 'encoder.forecast_fuse', 'relu')

    logits = lin(lin(h_i, 'head_1', 'relu'), 'head_2', 'none')
    logits = logits - _np.max(logits, axis=-1, keepdims=True)
    exps = _np.exp(logits)
    probs = exps / _np.maximum(1e-12, _np.sum(exps, axis=-1, keepdims=True))

    mov_logits: list[float] | None = None
    if arch.get('has_mov_head') and 'mov_head_1.weight' in sd:
        m_from = _np.array(g['mov_from'], dtype=_np.int64)
        m_to = _np.array(g['mov_to'], dtype=_np.int64)
        m_cat = _np.concatenate([h_m, h_r[m_from], h_r[m_to]], axis=-1)
        m_raw = lin(lin(m_cat, 'mov_head_1', 'relu'), 'mov_head_2', 'none').reshape(-1)
        mov_logits = m_raw.tolist()
    return probs.tolist(), mov_logits


def _forward_pure_python(
    weights: dict[str, Any],
    g: dict[str, Any],
    inter_x: list[list[float]],
    road_x: list[list[float]],
    mov_x: list[list[float]],
) -> list[list[float]]:
    sd = weights['_py_sd']
    arch = weights['architecture']
    H = int(arch['hidden_dim'])
    n_i, n_r, n_m = g['n_i'], g['n_r'], g['n_m']

    h_i = _linear_py(
        _linear_py(inter_x, sd['encoder.inter_enc_1.weight'], sd['encoder.inter_enc_1.bias'], 'relu'),
        sd['encoder.inter_enc_2.weight'], sd['encoder.inter_enc_2.bias'], 'relu',
    )
    h_r = _linear_py(
        _linear_py(road_x, sd['encoder.road_enc_1.weight'], sd['encoder.road_enc_1.bias'], 'relu'),
        sd['encoder.road_enc_2.weight'], sd['encoder.road_enc_2.bias'], 'relu',
    )
    h_m = _linear_py(
        _linear_py(mov_x, sd['encoder.mov_enc_1.weight'], sd['encoder.mov_enc_1.bias'], 'relu'),
        sd['encoder.mov_enc_2.weight'], sd['encoder.mov_enc_2.bias'], 'relu',
    )

    for l in range(int(arch['num_layers'])):
        p = f'encoder.mp_layers.{l}'
        gate_r = _linear_py(h_r, sd[f'{p}.road_gate.weight'], sd[f'{p}.road_gate.bias'], 'sigmoid')
        m_r_in = _linear_py(h_r, sd[f'{p}.road_in_msg.weight'], sd[f'{p}.road_in_msg.bias'], 'relu')
        m_r_out = _linear_py(h_r, sd[f'{p}.road_out_msg.weight'], sd[f'{p}.road_out_msg.bias'], 'relu')
        for r in range(n_r):
            gr = gate_r[r]
            mri = m_r_in[r]
            mro = m_r_out[r]
            for d in range(H):
                mri[d] *= gr[d]
                mro[d] *= gr[d]

        m_mov = _linear_py(h_m, sd[f'{p}.mov_msg.weight'], sd[f'{p}.mov_msg.bias'], 'relu')
        m_nbr = _linear_py(h_i, sd[f'{p}.nbr_msg.weight'], sd[f'{p}.nbr_msg.bias'], 'relu')

        agg_in = _sparse_agg_py(m_r_in, g['adj_r2i_in'], H)
        agg_out = _sparse_agg_py(m_r_out, g['adj_r2i_out'], H)
        agg_mov = _sparse_agg_py(m_mov, g['adj_m2i'], H)
        agg_nbr = _sparse_agg_py(m_nbr, g['adj_i2i'], H)

        cat_i = [h_i[i] + agg_in[i] + agg_out[i] + agg_mov[i] + agg_nbr[i] for i in range(n_i)]
        dh_i = _linear_py(
            _linear_py(cat_i, sd[f'{p}.inter_up_1.weight'], sd[f'{p}.inter_up_1.bias'], 'relu'),
            sd[f'{p}.inter_up_2.weight'], sd[f'{p}.inter_up_2.bias'], 'none',
        )
        h_i_next = [[h_i[i][d] + dh_i[i][d] for d in range(H)] for i in range(n_i)]

        i_to_r = _sparse_agg_py(h_i_next, g['adj_i2r_t'], H)
        i_to_m = _sparse_agg_py(h_i_next, g['adj_i2m_t'], H)
        d_r = _linear_py([h_r[r] + i_to_r[r] for r in range(n_r)], sd[f'{p}.road_up.weight'], sd[f'{p}.road_up.bias'], 'relu')
        d_m = _linear_py([h_m[m] + i_to_m[m] for m in range(n_m)], sd[f'{p}.mov_up.weight'], sd[f'{p}.mov_up.bias'], 'relu')
        h_r = [[h_r[r][d] + d_r[r][d] for d in range(H)] for r in range(n_r)]
        h_m = [[h_m[m][d] + d_m[m][d] for d in range(H)] for m in range(n_m)]
        h_i = h_i_next

    if arch.get('use_temporal_forecast'):
        road_fc = _linear_py(h_r, sd['encoder.forecast_head.weight'], sd['encoder.forecast_head.bias'], 'none')
        agg_fc = _sparse_agg_py(road_fc, g['adj_r2i_in'], 2)
        h_i = _linear_py(
            [h_i[i] + agg_fc[i] for i in range(n_i)],
            sd['encoder.forecast_fuse.weight'], sd['encoder.forecast_fuse.bias'], 'relu',
        )

    raw_logits = _linear_py(
        _linear_py(h_i, sd['head_1.weight'], sd['head_1.bias'], 'relu'),
        sd['head_2.weight'], sd['head_2.bias'], 'none',
    )
    out_probs: list[list[float]] = []
    for row in raw_logits:
        mx = max(row)
        exps = [math.exp(v - mx) for v in row]
        denom = sum(exps) or 1.0
        out_probs.append([e / denom for e in exps])

    mov_logits: list[float] | None = None
    if arch.get('has_mov_head') and 'mov_head_1.weight' in sd:
        m_cat = [
            h_m[m_i] + h_r[g['mov_from'][m_i]] + h_r[g['mov_to'][m_i]]
            for m_i in range(n_m)
        ]
        m_h = _linear_py(m_cat, sd['mov_head_1.weight'], sd['mov_head_1.bias'], 'relu')
        m_raw = _linear_py(m_h, sd['mov_head_2.weight'], sd['mov_head_2.bias'], 'none')
        mov_logits = [row[0] for row in m_raw]
    return out_probs, mov_logits


def infer_trained_actor_probs(
    region_id: str,
    edge_states: dict[str, dict[str, Any]],
    inter_states: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    """Run trained ATNTActor over live region state; returns per-node probs & movement scores."""
    weights = load_trained_weights()
    if weights is None:
        return None
    g = get_compiled_region_graph(region_id)
    n_i, n_r, n_m = g['n_i'], g['n_r'], g['n_m']

    road_x: list[list[float]] = []
    r_q = [0.0] * n_r
    r_occ = [0.0] * n_r
    r_dis = [0.0] * n_r
    r_closed = [False] * n_r
    for r in range(n_r):
        eid = g['road_ids'][r]
        st = edge_states.get(eid, {})
        free_spd = float(st.get('free_flow_kmh', g['road_spd'][r]))
        spd = float(st.get('speed_kmh', free_spd))
        qv = float(st.get('queue_veh', 0.0))
        occ = float(st.get('occupancy', min(1.0, qv / g['road_max_q'][r])))
        flood_i = float(st.get('flood_intensity', st.get('disruption_intensity', 0.0)))
        demo_i = float(st.get('demonstration_intensity', 0.0))
        closed = bool(st.get('closed', False))
        cap_fac = 0.0 if closed else _clip(spd / max(1.0, free_spd), 0.0, 1.0)
        flow_vph = float(st.get('flow_vph', g['road_cap'][r] * 0.5))
        d_q_dt = float(st.get('d_queue_dt', 0.0))

        r_q[r] = qv
        r_occ[r] = occ
        r_dis[r] = max(flood_i, demo_i)
        r_closed[r] = closed

        road_x.append([
            _clip(g['road_len'][r] / 600.0, 0.0, 3.0),
            _clip(g['road_lanes'][r] / 4.0, 0.0, 2.0),
            _clip(g['road_cap'][r] / 4000.0, 0.0, 2.0),
            _clip(g['road_spd'][r] / 80.0, 0.0, 1.5),
            _clip(spd / max(1.0, free_spd), 0.0, 1.2),
            _clip(qv / 40.0, 0.0, 3.0),
            _clip(occ, 0.0, 1.2),
            _clip((occ * 45.0) / 120.0, 0.0, 3.0),
            _clip(flow_vph / max(100.0, g['road_cap'][r]), 0.0, 2.0),
            _clip(cap_fac, 0.0, 1.0),
            _clip(flood_i, 0.0, 1.0),
            _clip(demo_i, 0.0, 1.0),
            1.0 if closed else 0.0,
            _clip(d_q_dt / 10.0, -1.0, 1.0),
            _clip(occ, 0.0, 1.2),
            _clip(g['road_transit'][r] / 3.0, 0.0, 1.0),
        ])

    mov_x: list[list[float]] = []
    for m_i in range(n_m):
        fr = g['mov_from'][m_i]
        tr = g['mov_to'][m_i]
        tt = g['mov_turn_type'][m_i]
        mov_x.append([
            _clip((g['road_cap'][fr] * 0.5) / 2000.0, 0.0, 2.0),
            _clip(r_q[fr] / 30.0, 0.0, 2.0),
            _clip(r_occ[tr], 0.0, 1.2),
            0.0 if r_closed[tr] else 1.0,
            _clip((r_q[fr] - 0.65 * r_q[tr]) / 25.0, -2.0, 2.0),
            tt[0], tt[1], tt[2],
            _clip(g['mov_conflict'][m_i] / 8.0, 0.0, 1.5),
            _clip(r_dis[tr], 0.0, 1.0),
            1.0,
            g['mov_parity'][m_i],
        ])

    inter_x: list[list[float]] = []
    i_states = inter_states or {}
    for ii in range(n_i):
        nid = g['inter_ids'][ii]
        ist = i_states.get(nid, {})
        cur_p = float(ist.get('current_phase', 0) % 2)
        p_el = float(ist.get('phase_elapsed_s', 20.0))
        hold_el = float(ist.get('hold_elapsed_s', 60.0))
        topo_m = float(ist.get('topology_mode', 0.0))
        inc = g['inter_in'][ii]
        out = g['inter_out'][ii]
        in_qs = [_clip(r_q[r] / g['road_max_q'][r], 0.0, 2.0) for r in inc]
        mean_q = sum(in_qs) / len(in_qs) if in_qs else 0.0
        max_q = max(in_qs) if in_qs else 0.0
        mean_out_occ = sum(r_occ[r] for r in out) / len(out) if out else 0.0
        max_out_dis = max((r_dis[r] for r in out), default=0.0)
        inter_x.append([
            g['signalized'][ii],
            cur_p,
            _clip(p_el / 75.0, 0.0, 2.0),
            _clip(hold_el / 90.0, 0.0, 2.0),
            _clip(topo_m / 3.0, 0.0, 1.0),
            min(1.5, len(inc) / 6.0),
            min(1.5, len(out) / 6.0),
            min(1.5, len(g['inter_movs'][ii]) / 16.0),
            mean_q,
            max_q,
            mean_out_occ,
            max_out_dis,
            _clip(g['inter_transit'][ii] / 4.0, 0.0, 1.0),
            1.0 if mean_q > 0.65 else 0.0,
        ])

    if _np is not None:
        all_probs, mov_logits = _forward_numpy(weights, g, inter_x, road_x, mov_x)
    else:
        all_probs, mov_logits = _forward_pure_python(weights, g, inter_x, road_x, mov_x)

    node_probs: dict[str, list[float]] = {}
    node_actions: dict[str, int] = {}
    for ii, probs in enumerate(all_probs):
        nid = g['inter_ids'][ii]
        node_probs[nid] = probs
        node_actions[nid] = max(range(8), key=probs.__getitem__)

    movement_scores: dict[str, float] = {}
    if mov_logits is not None:
        by_fr: dict[int, list[int]] = {}
        for m_i in range(n_m):
            by_fr.setdefault(g['mov_from'][m_i], []).append(m_i)
        for m_list in by_fr.values():
            legal_idx = [m_i for m_i in m_list if not r_closed[g['mov_to'][m_i]]]
            if legal_idx:
                max_l = max(_clip(float(mov_logits[m_i]), -20.0, 20.0) for m_i in legal_idx)
                for m_i in m_list:
                    mid = g['mov_ids'][m_i]
                    if r_closed[g['mov_to'][m_i]]:
                        movement_scores[mid] = 0.0
                    else:
                        ml = _clip(float(mov_logits[m_i]), -20.0, 20.0)
                        movement_scores[mid] = round(_clip(math.exp(ml - max_l), 0.01, 1.0), 4)
            else:
                for m_i in m_list:
                    movement_scores[g['mov_ids'][m_i]] = 0.0
    else:
        for m_i in range(n_m):
            mid = g['mov_ids'][m_i]
            to_r = g['mov_to'][m_i]
            fr_r = g['mov_from'][m_i]
            if r_closed[to_r]:
                movement_scores[mid] = 0.0
                continue
            ii = g['mov_inter'][m_i]
            p_vec = all_probs[ii]
            mode_probs = [p_vec[m] + p_vec[4 + m] for m in range(4)]
            out_occ = r_occ[to_r]
            out_dis = r_dis[to_r]
            is_through = g['mov_turn_type'][m_i][0] > 0.5
            is_left = g['mov_turn_type'][m_i][1] > 0.5
            has_transit = g['road_transit'][to_r] > 0.0 or g['road_transit'][fr_r] > 0.0

            g0 = 1.0
            g1 = 0.28 if (is_left and out_occ > 0.55) else 1.0
            g2 = 0.24 if (out_dis > 0.35 and not is_through) else (1.0 if out_dis < 0.35 else 0.78)
            g3 = 0.26 if (out_occ > 0.72 and not has_transit) else 1.0

            policy_gate = mode_probs[0] * g0 + mode_probs[1] * g1 + mode_probs[2] * g2 + mode_probs[3] * g3
            downstream_health = 1.0 - 0.25 * max(out_occ, out_dis)
            score = _clip(policy_gate * downstream_health, 0.01, 1.0)
            movement_scores[mid] = round(score, 4)

    return {
        'node_probs': node_probs,
        'node_actions': node_actions,
        'movement_scores': movement_scores,
        'has_mov_head': mov_logits is not None,
        'parameter_count': sum(len(v['data']) for v in weights['state_dict'].values()),
    }
