"""REST API router for Jakarta Adaptive Traffic Network regions, scenarios, and simulation."""
from __future__ import annotations

import threading
import uuid
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .adaptive_network import (
    load_manifest,
    load_region,
    load_region_geojson,
    region_coverage_payload,
    region_summaries,
    validate_and_snap_disruption,
)
from .adaptive_sim_engine import AdaptiveScenarioRequest, run_adaptive_simulation
from .controller_adapter import GraphStateInput, decide_controller_actions

router = APIRouter(prefix='/api', tags=['Adaptive Traffic Network'])

_lock = threading.Lock()
_scenarios: dict[str, dict[str, Any]] = {}
_simulations: dict[str, dict[str, Any]] = {}
_MAX_STORED = 120


class DisruptionValidationRequest(BaseModel):
    lat: float = Field(ge=-90.0, le=90.0)
    lon: float = Field(ge=-180.0, le=180.0)
    disruption_kind: Literal['flood', 'demonstration']
    max_snap_distance_m: float = Field(default=200.0, ge=25.0, le=500.0)


@router.get('/regions')
def get_regions() -> dict[str, Any]:
    return {
        'regions': region_summaries(),
        'manifest': load_manifest(),
    }


@router.get('/regions/{region_id}/network')
def get_region_network(region_id: str) -> dict[str, Any]:
    try:
        region = load_region(region_id)
        geojson = load_region_geojson(region_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f'Study area not found: {region_id}') from exc
    return {
        'region': {
            'id': region['id'],
            'name': region['name'],
            'district': region['district'],
            'subtitle': region['subtitle'],
            'bbox': region['bbox'],
            'center': region['center'],
            'default_zoom': region['default_zoom'],
            'primary_disruption': region['primary_disruption'],
            'scenario_eligibility': region['scenario_eligibility'],
            'disruption_anchors': region['disruption_anchors'],
            'landmarks': region['landmarks'],
            'stats': region['stats'],
            'provenance': region['provenance'],
        },
        'edges': region['edges'],
        'intersections': region['intersections'],
        'movements': region['movements'],
        'transit_stops': region['transit_stops'],
        'waterbodies': region['waterbodies'],
        'geojson': geojson,
    }


@router.get('/regions/{region_id}/coverage')
def get_region_coverage(region_id: str) -> dict[str, Any]:
    try:
        return region_coverage_payload(region_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f'Study area not found: {region_id}') from exc


@router.post('/regions/{region_id}/disruption/validate')
def post_validate_disruption(region_id: str, body: DisruptionValidationRequest) -> dict[str, Any]:
    try:
        result = validate_and_snap_disruption(
            region_id,
            body.lat,
            body.lon,
            body.disruption_kind,
            max_snap_distance_m=body.max_snap_distance_m,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f'Study area not found: {region_id}') from exc
    if not result['accepted']:
        raise HTTPException(status_code=422, detail=result)
    return result


@router.get('/scenarios')
def list_scenarios() -> dict[str, Any]:
    with _lock:
        items = list(_scenarios.values())
    return {'scenarios': items, 'count': len(items)}


@router.post('/scenarios')
def create_scenario(req: AdaptiveScenarioRequest) -> dict[str, Any]:
    scenario_id = f'scn-{uuid.uuid4().hex[:10]}'
    record = {
        'scenario_id': scenario_id,
        'config': req.model_dump(),
    }
    with _lock:
        if len(_scenarios) >= _MAX_STORED:
            oldest = next(iter(_scenarios))
            _scenarios.pop(oldest, None)
        _scenarios[scenario_id] = record
    return record


@router.post('/simulation/run')
def post_run_simulation(req: AdaptiveScenarioRequest) -> dict[str, Any]:
    try:
        result = run_adaptive_simulation(req)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    sim_id = result['simulation_id']
    with _lock:
        if len(_simulations) >= _MAX_STORED:
            oldest = next(iter(_simulations))
            _simulations.pop(oldest, None)
        _simulations[sim_id] = {
            'status': 'complete',
            'request': req.model_dump(),
            'result': result,
        }
    return {
        'simulation_id': sim_id,
        'status': 'complete',
        'metrics': result['metrics'],
        'comparison': result['comparison'],
        'provenance': result['provenance'],
        'result': result,
    }


@router.get('/simulation/{simulation_id}/status')
def get_simulation_status(simulation_id: str) -> dict[str, Any]:
    with _lock:
        entry = _simulations.get(simulation_id)
    if not entry:
        raise HTTPException(status_code=404, detail='Simulation job not found.')
    return {
        'simulation_id': simulation_id,
        'status': entry['status'],
        'provenance': entry['result']['provenance'],
    }


@router.get('/simulation/{simulation_id}/results')
def get_simulation_results(simulation_id: str) -> dict[str, Any]:
    with _lock:
        entry = _simulations.get(simulation_id)
    if not entry:
        raise HTTPException(status_code=404, detail='Simulation job not found.')
    return entry['result']


@router.post('/controller/decide')
def post_controller_decide(state: GraphStateInput) -> dict[str, Any]:
    return decide_controller_actions(state).model_dump()
