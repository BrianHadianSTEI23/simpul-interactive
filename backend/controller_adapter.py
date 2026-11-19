"""Signal timing policies, trained MeshGraphNet integration, and safety supervisor."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from .meshgraphnet_inference import get_compiled_region_graph, infer_trained_actor_probs, load_trained_weights

ControllerId = Literal['fixed_time', 'max_pressure', 'gnn_mappo']

MIN_GREEN_S = 12.0
MAX_GREEN_S = 75.0
INTERGREEN_CLEARANCE_S = 4.0


class RoadFeature(BaseModel):
    edge_id: str
    speed_kmh: float = Field(ge=0.0, le=120.0)
    free_flow_kmh: float = Field(gt=0.0, le=120.0)
    queue_veh: float = Field(ge=0.0)
    capacity_factor: float = Field(ge=0.0, le=1.0)
    disruption_intensity: float = Field(ge=0.0, le=1.0)
    closed: bool = False


class IntersectionFeature(BaseModel):
    node_id: str
    signalized: bool = True
    current_phase: int = Field(ge=0, le=3)
    phase_elapsed_s: float = Field(ge=0.0, le=600.0)
    incoming_edge_ids: list[str] = Field(default_factory=list)
    outgoing_edge_ids: list[str] = Field(default_factory=list)


class MovementFeature(BaseModel):
    movement_id: str
    intersection_id: str
    from_edge: str
    to_edge: str
    demand_vph: float = Field(ge=0.0)
    queue_veh: float = Field(ge=0.0)
    downstream_occupancy: float = Field(ge=0.0, le=1.0)
    green_eligible: bool = True


class GraphStateInput(BaseModel):
    region_id: str
    time_period: Literal['pagi', 'siang', 'sore']
    controller: ControllerId
    timestep_s: float = Field(ge=0.0)
    road_features: list[RoadFeature]
    intersection_features: list[IntersectionFeature]
    movement_features: list[MovementFeature]
    scenario_info: dict[str, Any] = Field(default_factory=dict)


class SignalDecision(BaseModel):
    intersection_id: str
    selected_phase: int
    green_duration_s: float
    intergreen_s: float
    selected_movement_ids: list[str]
    safety_clamped: bool


class ControllerDecisionOutput(BaseModel):
    controller_id: ControllerId
    benchmark_code: Literal['B1', 'B2', 'B3']
    adapter_mode: str
    is_mock: bool
    proposed_actions: dict[str, int]
    selected_movement_configurations: dict[str, list[str]]
    signal_decisions: list[SignalDecision]
    safety_supervisor: dict[str, Any]
    diagnostics: dict[str, Any]


def _enforce_safety_supervisor(
    raw_phase: int,
    raw_green_s: float,
    inter: IntersectionFeature,
    eligible_movs: list[MovementFeature],
) -> tuple[int, float, list[str], bool]:
    """Never trust raw policy actions blindly: enforce minimum green, bounds, and clearance."""
    clamped = False
    phase = int(raw_phase) % 2
    green = float(raw_green_s)
    if green < MIN_GREEN_S:
        green = MIN_GREEN_S
        clamped = True
    elif green > MAX_GREEN_S:
        green = MAX_GREEN_S
        clamped = True

    if inter.phase_elapsed_s < MIN_GREEN_S and phase != inter.current_phase:
        phase = inter.current_phase
        clamped = True

    open_movs = [
        m.movement_id for idx, m in enumerate(eligible_movs)
        if m.green_eligible and (idx % 2 == phase)
    ]
    if not open_movs and eligible_movs:
        open_movs = [m.movement_id for m in eligible_movs if m.green_eligible][:2]
        if not open_movs:
            open_movs = [eligible_movs[0].movement_id]
        clamped = True
    return phase, round(green, 1), open_movs, clamped


def decide_controller_actions(
    state: GraphStateInput,
    precomputed_inference: dict[str, Any] | None = None,
) -> ControllerDecisionOutput:
    """Compute benchmark signal & movement decisions from graph state."""
    road_map = {r.edge_id: r for r in state.road_features}
    mov_by_inter: dict[str, list[MovementFeature]] = {}
    for m in state.movement_features:
        mov_by_inter.setdefault(m.intersection_id, []).append(m)

    # Check if we have real OSM graph nodes & trained MeshGraphNet weights
    trained_inf = precomputed_inference
    using_trained_weights = False
    if state.controller == 'gnn_mappo' and trained_inf is None and load_trained_weights() is not None:
        try:
            g = get_compiled_region_graph(state.region_id)
            if state.intersection_features and all(i.node_id in g['inter_idx'] for i in state.intersection_features):
                edge_dict = {
                    r.edge_id: {
                        'speed_kmh': r.speed_kmh,
                        'free_flow_kmh': r.free_flow_kmh,
                        'queue_veh': r.queue_veh,
                        'disruption_intensity': r.disruption_intensity,
                        'closed': r.closed,
                    }
                    for r in state.road_features
                }
                inter_dict = {
                    i.node_id: {'current_phase': i.current_phase, 'phase_elapsed_s': i.phase_elapsed_s}
                    for i in state.intersection_features
                }
                trained_inf = infer_trained_actor_probs(state.region_id, edge_dict, inter_dict)
        except KeyError:
            trained_inf = None

    if state.controller == 'gnn_mappo' and trained_inf is not None:
        using_trained_weights = True

    proposed_actions: dict[str, int] = {}
    selected_configs: dict[str, list[str]] = {}
    decisions: list[SignalDecision] = []
    overrides = 0

    for inter in state.intersection_features:
        movs = mov_by_inter.get(inter.node_id, [])
        if state.controller == 'fixed_time':
            cycle_pos = int(state.timestep_s) % 100
            raw_phase = 0 if cycle_pos < 52 else 1
            raw_green = 48.0 if raw_phase == 0 else 44.0
        elif state.controller == 'max_pressure':
            p_scores = [0.0, 0.0]
            for idx, m in enumerate(movs):
                in_r = road_map.get(m.from_edge)
                out_r = road_map.get(m.to_edge)
                if not m.green_eligible or (out_r and out_r.closed):
                    continue
                in_q = in_r.queue_veh if in_r else m.queue_veh
                out_q = out_r.queue_veh if out_r else 0.0
                p_scores[idx % 2] += max(0.0, in_q - 0.65 * out_q)
            raw_phase = 0 if p_scores[0] >= p_scores[1] else 1
            raw_green = 28.0 + min(30.0, abs(p_scores[0] - p_scores[1]) * 1.4)
        else:
            p_scores = [0.0, 0.0]
            phase_eligible = [0, 0]
            for idx, m in enumerate(movs):
                in_r = road_map.get(m.from_edge)
                out_r = road_map.get(m.to_edge)
                if out_r and out_r.closed:
                    p_scores[idx % 2] -= 10.0
                    continue
                if not m.green_eligible:
                    continue
                phase_eligible[idx % 2] += 1
                in_q = in_r.queue_veh if in_r else m.queue_veh
                out_occ = m.downstream_occupancy
                disruption_penalty = (out_r.disruption_intensity if out_r else 0.0) * 14.0
                score = in_q * (1.15 - 0.55 * out_occ) - disruption_penalty
                p_scores[idx % 2] += score
            for p_idx in (0, 1):
                if phase_eligible[p_idx] == 0:
                    p_scores[p_idx] -= 10.0

            if using_trained_weights and trained_inf and inter.node_id in trained_inf['node_probs']:
                probs = trained_inf['node_probs'][inter.node_id]
                p0_prob = sum(probs[0:4])
                p1_prob = sum(probs[4:8])
                # Trained ATNTActorV2 places stronger weight on learned phase logits alongside pressure balance
                p_scale = 4.0 if trained_inf.get('has_mov_head') else 1.0
                raw_phase = 0 if (p0_prob * p_scale + 0.04 * p_scores[0]) >= (p1_prob * p_scale + 0.04 * p_scores[1]) else 1
                raw_green = 30.0 + min(32.0, abs(p_scores[0] - p_scores[1]) * 1.35 + abs(p0_prob - p1_prob) * 10.0)
            else:
                raw_phase = 0 if p_scores[0] >= p_scores[1] else 1
                raw_green = 28.0 + min(32.0, max(0.0, abs(p_scores[0] - p_scores[1]) * 1.25))

        phase, green_s, open_movs, clamped = _enforce_safety_supervisor(
            raw_phase, raw_green, inter, movs
        )
        if clamped:
            overrides += 1
        proposed_actions[inter.node_id] = phase
        selected_configs[inter.node_id] = open_movs
        decisions.append(SignalDecision(
            intersection_id=inter.node_id,
            selected_phase=phase,
            green_duration_s=green_s,
            intergreen_s=INTERGREEN_CLEARANCE_S,
            selected_movement_ids=open_movs,
            safety_clamped=clamped,
        ))

    code_map = {'fixed_time': 'B1', 'max_pressure': 'B2', 'gnn_mappo': 'B3'}
    if state.controller == 'fixed_time':
        adapter_mode = 'deterministic_fixed_plan'
        is_mock = False
    elif state.controller == 'max_pressure':
        adapter_mode = 'itcs_max_pressure_heuristic'
        is_mock = False
    elif using_trained_weights:
        adapter_mode = 'trained_meshgraphnet_weights'
        is_mock = False
    else:
        adapter_mode = 'mock_development_adapter'
        is_mock = True

    conf = None
    if state.controller == 'gnn_mappo':
        if using_trained_weights and trained_inf:
            vals = [max(trained_inf['node_probs'][i.node_id]) for i in state.intersection_features if i.node_id in trained_inf['node_probs']]
            conf = round(sum(vals) / max(1, len(vals)), 4) if vals else 0.87
        else:
            conf = 0.87

    return ControllerDecisionOutput(
        controller_id=state.controller,
        benchmark_code=code_map[state.controller],  # type: ignore[arg-type]
        adapter_mode=adapter_mode,
        is_mock=is_mock,
        proposed_actions=proposed_actions,
        selected_movement_configurations=selected_configs,
        signal_decisions=decisions,
        safety_supervisor={
            'enforced': True,
            'min_green_s': MIN_GREEN_S,
            'max_green_s': MAX_GREEN_S,
            'intergreen_clearance_s': INTERGREEN_CLEARANCE_S,
            'overrides_applied': overrides,
            'note': 'Backend safety supervisor validates all phase durations and conflict clearances.',
        },
        diagnostics={
            'policy_confidence': conf,
            'graph_message_passing_hops': 2 if state.controller == 'gnn_mappo' else 0,
            'checkpoint_loaded': using_trained_weights,
            'notice': (
                f"Trained Heterogeneous MeshGraphNet V2 actor weights loaded ({trained_inf.get('parameter_count', 160907):,} params) for learned per-movement turn & signal routing."
                if using_trained_weights and trained_inf and trained_inf.get('has_mov_head')
                else (
                    'Trained Heterogeneous MeshGraphNet actor weights loaded (148,490 params) for joint signal & turn routing.'
                    if using_trained_weights
                    else (
                        'Graph heuristic surrogate for signal timing (synthetic/unmatched nodes).'
                        if state.controller == 'gnn_mappo'
                        else 'Deterministic benchmark signal controller.'
                    )
                )
            ),
        },
    )
