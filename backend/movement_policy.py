"""Movement policy for the Jakarta road graph (MeshGraphNet trained weights + heuristic fallback)."""
from __future__ import annotations

import json
from urllib.request import Request, urlopen

from .meshgraphnet_inference import get_compiled_region_graph, infer_trained_actor_probs, load_trained_weights


def choose_turns(region, movements, states, use_model, endpoint=None, precomputed_scores=None):
    """Compute legal turn flow splits per incoming road, manipulating traffic current for MeshGraphNet."""
    scores: dict[str, float] = {}
    source = 'signals_only'
    all_movs = [m for turns in movements.values() for m in turns]

    if use_model:
        source = 'graph_heuristic'
        if isinstance(precomputed_scores, dict) and all(m['movement_id'] in precomputed_scores for m in all_movs):
            scores = precomputed_scores
            source = 'meshgraphnet'
        elif endpoint:
            try:
                payload = json.dumps({
                    'region_id': region,
                    'edges': states,
                    'movements': all_movs,
                }).encode()
                request = Request(endpoint, data=payload, headers={'Content-Type': 'application/json'})
                with urlopen(request, timeout=1.5) as response:
                    values = json.load(response)['movement_scores']
                if not isinstance(values, dict) or not all(
                    isinstance(score, (int, float)) and 0 <= score <= 1 for score in values.values()
                ) or not all(m['movement_id'] in values for m in all_movs):
                    raise ValueError('Expected one score in [0, 1] per movement')
                scores = values
                source = 'meshgraphnet'
            except (OSError, ValueError, TypeError, KeyError):
                source = 'graph_heuristic'

        # Fall back to embedded trained MeshGraphNet weights when movements belong to the OSM region graph
        if source != 'meshgraphnet' and load_trained_weights() is not None and all_movs:
            try:
                g = get_compiled_region_graph(region)
                if all(m['movement_id'] in g['mov_idx'] for m in all_movs):
                    inf = infer_trained_actor_probs(region, states)
                    if inf is not None:
                        scores = inf['movement_scores']
                        source = 'meshgraphnet'
            except KeyError:
                pass

    # Propagate 4-hop downstream corridor stress so all connected corridor hubs coordinate across regions
    edge_stress: dict[str, float] = {
        eid: (1.0 if st.get('closed') else max(float(st.get('occupancy', 0.0)), float(st.get('disruption_intensity', 0.0))))
        for eid, st in states.items()
    }
    out_stress: dict[str, float] = dict(edge_stress)
    for _ in range(4):
        next_stress: dict[str, float] = {}
        for fe_id, turns in movements.items():
            if not turns:
                continue
            vals = [out_stress.get(m['to_edge'], edge_stress.get(m['to_edge'], 0.0)) for m in turns]
            best_next = min(vals)
            worst_next = max(vals)
            avg_next = sum(vals) / len(vals)
            prop = 0.50 * avg_next + 0.35 * worst_next + 0.15 * best_next
            next_stress[fe_id] = max(edge_stress.get(fe_id, 0.0), 0.86 * prop)
        out_stress.update(next_stress)

    weights = {}
    decisions = {}
    for incoming, turns in movements.items():
        legal = [m for m in turns if not states[m['to_edge']]['closed']]
        ranked = {}
        for m in legal:
            te_id = m['to_edge']
            downstream = states[te_id]
            occ = float(downstream.get('occupancy', 0.0))
            dis = float(downstream.get('disruption_intensity', 0.0))
            lookahead = out_stress.get(te_id, 0.0)
            risk = max(occ, dis, 0.85 * lookahead)
            default_score = max(0.01, 1.0 - risk)
            if use_model and m['movement_id'] in scores:
                raw_s = float(scores[m['movement_id']])
                # Couple learned GNN movement score with live downstream + corridor-lookahead relief
                relief = max(0.10, 1.0 - 0.85 * max(0.0, risk - 0.08))
                ranked[m['movement_id']] = max(0.01, min(1.0, raw_s * relief))
            else:
                ranked[m['movement_id']] = default_score if use_model else 1.0
        best = max(ranked, key=ranked.get, default=None)
        allowed = {mid: score for mid, score in ranked.items() if not use_model or score >= 0.16 or mid == best}
        if use_model:
            # Sharpen traffic-current redistribution across all branching & connector hubs
            weighted = {mid: (score ** 4.0) for mid, score in allowed.items()}
        else:
            weighted = allowed
        total = sum(weighted.values())
        split_list = [
            (m['to_edge'], (weighted[m['movement_id']] / total if total else 1.0 / len(allowed)))
            for m in legal if m['movement_id'] in allowed
        ]
        weights[incoming] = split_list
        if use_model:
            split_by_edge = dict(split_list)
            best_to = next((m['to_edge'] for m in legal if m['movement_id'] == best), '')
            best_share = split_by_edge.get(best_to, 0.0)
            worst_risk = max((max(float(states[m['to_edge']].get('occupancy', 0.0)), float(states[m['to_edge']].get('disruption_intensity', 0.0)), out_stress.get(m['to_edge'], 0.0)) for m in turns), default=0.0)
            for m in turns:
                mid = m['movement_id']
                if mid not in ranked:
                    continue
                if mid not in allowed:
                    decisions[mid] = {
                        'intersection_id': m['intersection_id'], 'from_edge': incoming, 'to_edge': m['to_edge'],
                        'action': 'blocked',
                    }
                elif len(legal) > 1 and mid == best and (len(allowed) < len(legal) or best_share >= 0.45 or worst_risk >= 0.22):
                    decisions[mid] = {
                        'intersection_id': m['intersection_id'], 'from_edge': incoming, 'to_edge': m['to_edge'],
                        'action': 'redirected',
                    }
    return weights, decisions, source
