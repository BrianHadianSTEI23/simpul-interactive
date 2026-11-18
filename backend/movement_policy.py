"""Movement policy for the synthetic road graph."""
import json
from urllib.request import Request, urlopen


def choose_turns(region, movements, states, use_model, endpoint=None):
    """Normalize legal turn weights per incoming road, retaining one route if possible."""
    scores = {}
    source = 'signals_only'
    if use_model:
        source = 'graph_heuristic'
        if endpoint:
            try:
                payload = json.dumps({
                    'region_id': region,
                    'edges': states,
                    'movements': [m for turns in movements.values() for m in turns],
                }).encode()
                request = Request(endpoint, data=payload, headers={'Content-Type': 'application/json'})
                with urlopen(request, timeout=1.5) as response:
                    values = json.load(response)['movement_scores']
                if not isinstance(values, dict) or not all(
                    isinstance(score, (int, float)) and 0 <= score <= 1 for score in values.values()
                ) or not all(m['movement_id'] in values for turns in movements.values() for m in turns):
                    raise ValueError('Expected one score in [0, 1] per movement')
                scores = values
                source = 'meshgraphnet'
            except (OSError, ValueError, TypeError, KeyError):
                source = 'graph_heuristic'

    weights = {}
    decisions = {}
    for incoming, turns in movements.items():
        legal = [m for m in turns if not states[m['to_edge']]['closed']]
        ranked = {}
        for m in legal:
            downstream = states[m['to_edge']]
            risk = max(downstream['occupancy'], downstream['disruption_intensity'])
            default_score = max(0.01, 1 - risk)
            ranked[m['movement_id']] = scores.get(m['movement_id'], default_score) if use_model else 1
        best = max(ranked, key=ranked.get, default=None)
        allowed = {mid: score for mid, score in ranked.items() if not use_model or score >= 0.35 or mid == best}
        total = sum(allowed.values())
        weights[incoming] = [
            (m['to_edge'], (allowed[m['movement_id']] / total if total else 1 / len(allowed)))
            for m in legal if m['movement_id'] in allowed
        ]
        if use_model:
            for m in turns:
                mid = m['movement_id']
                if mid not in ranked:
                    continue
                if mid not in allowed or (len(legal) > 1 and len(allowed) < len(legal) and mid == best):
                    decisions[mid] = {
                        'intersection_id': m['intersection_id'], 'from_edge': incoming, 'to_edge': m['to_edge'],
                        'action': 'redirected' if mid in allowed else 'blocked',
                    }
    return weights, decisions, source
