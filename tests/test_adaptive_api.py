"""Contract & integration tests for simpul-interactive (Vercel api.index + backend.app)."""
import sys
from pathlib import Path
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from api.index import app

client = TestClient(app)


def test_health_and_static_entry():
    assert client.get('/api/health').status_code == 200
    assert client.get('/').status_code == 200


def test_regions_network_and_coverage():
    resp = client.get('/api/regions')
    assert resp.status_code == 200
    ids = {r['id'] for r in resp.json()['regions']}
    assert ids == {'cilandak', 'pluit', 'tanah_abang'}
    for rid in ids:
        assert client.get(f'/api/regions/{rid}/network').status_code == 200
        assert client.get(f'/api/regions/{rid}/coverage').status_code == 200
    assert client.get('/api/regions/unknown_zone/network').status_code == 404


def test_disruption_validation_and_rejection():
    regions = {r['id']: r for r in client.get('/api/regions').json()['regions']}
    anchor = regions['pluit']['disruption_anchors']['flood']

    ok = client.post('/api/regions/pluit/disruption/validate', json={
        'lat': anchor['lat'],
        'lon': anchor['lon'],
        'disruption_kind': 'flood',
    })
    assert ok.status_code == 200
    assert ok.json()['accepted'] is True

    bad = client.post('/api/regions/pluit/disruption/validate', json={
        'lat': -6.29247,
        'lon': 106.79245,
        'disruption_kind': 'flood',
    })
    assert bad.status_code == 422
    assert bad.json()['detail']['accepted'] is False


def test_scenario_and_simulation_lifecycle():
    regions = {r['id']: r for r in client.get('/api/regions').json()['regions']}
    anchor = regions['pluit']['disruption_anchors']['flood']
    payload = {
        'region_id': 'pluit',
        'time_period': 'pagi',
        'controller': 'gnn_mappo',
        'flood': {
            'enabled': True,
            'lat': anchor['lat'],
            'lon': anchor['lon'],
            'intensity': 0.78,
            'sigma_m': 460,
        },
        'demonstration': {'enabled': False},
        'duration_s': 600,
        'seed': 42,
    }
    assert client.post('/api/scenarios', json=payload).status_code == 200
    assert client.get('/api/scenarios').json()['count'] >= 1

    run = client.post('/api/simulation/run', json=payload)
    assert run.status_code == 200
    sim_id = run.json()['simulation_id']
    assert client.get(f'/api/simulation/{sim_id}/status').status_code == 200
    assert client.get(f'/api/simulation/{sim_id}/results').status_code == 200


def test_controller_adapter_safety_supervisor():
    resp = client.post('/api/controller/decide', json={
        'region_id': 'pluit',
        'time_period': 'pagi',
        'controller': 'gnn_mappo',
        'timestep_s': 30,
        'road_features': [
            {
                'edge_id': 'e1',
                'speed_kmh': 18.0,
                'free_flow_kmh': 50.0,
                'queue_veh': 14.0,
                'capacity_factor': 0.7,
                'disruption_intensity': 0.4,
                'closed': False,
            }
        ],
        'intersection_features': [
            {
                'node_id': 'n1',
                'signalized': True,
                'current_phase': 0,
                'phase_elapsed_s': 4.0,
                'incoming_edge_ids': ['e1'],
                'outgoing_edge_ids': ['e1'],
            }
        ],
        'movement_features': [
            {
                'movement_id': 'm1',
                'intersection_id': 'n1',
                'from_edge': 'e1',
                'to_edge': 'e1',
                'demand_vph': 900,
                'queue_veh': 14,
                'downstream_occupancy': 0.9,
                'green_eligible': True,
            }
        ],
    })
    assert resp.status_code == 200
    assert resp.json()['is_mock'] is True
    assert resp.json()['safety_supervisor']['enforced'] is True

def test_turn_routing_redistributes_traffic_only_for_graph_controller():
    from backend.movement_policy import choose_turns

    turns = {'in': [
        {'movement_id': 'straight', 'intersection_id': 'junction', 'to_edge': 'busy'},
        {'movement_id': 'left', 'intersection_id': 'junction', 'to_edge': 'clear'},
        {'movement_id': 'right', 'intersection_id': 'junction', 'to_edge': 'closed'},
    ]}
    edges = {
        'busy': {'closed': False, 'occupancy': 0.95, 'disruption_intensity': 0},
        'clear': {'closed': False, 'occupancy': 0.1, 'disruption_intensity': 0},
        'closed': {'closed': True},
    }
    routes, actions, mode = choose_turns('pluit', turns, edges, False)
    assert mode == 'signals_only'
    assert routes['in'] == [('busy', 0.5), ('clear', 0.5)]
    assert actions == {}

    routes, actions, mode = choose_turns('pluit', turns, edges, True)
    assert mode == 'graph_heuristic'
    assert routes['in'] == [('clear', 1)]
    assert actions['straight']['action'] == 'blocked'
    assert actions['left']['action'] == 'redirected'


def test_trained_meshgraphnet_integration_pluit_flood():
    """Verify embedded trained MeshGraphNet weights run end-to-end and outperform baselines."""
    regions = {r['id']: r for r in client.get('/api/regions').json()['regions']}
    anchor = regions['pluit']['disruption_anchors']['flood']
    resp = client.post('/api/simulation/run', json={
        'region_id': 'pluit',
        'time_period': 'pagi',
        'controller': 'gnn_mappo',
        'flood': {'enabled': True, 'lat': anchor['lat'], 'lon': anchor['lon'], 'intensity': 0.85, 'sigma_m': 450},
        'demonstration': {'enabled': False},
        'duration_s': 600,
        'seed': 42,
    })
    assert resp.status_code == 200
    body = resp.json()
    res = body['result']
    assert body['provenance']['is_mock_controller'] is False
    assert res['controller_adapter']['diagnostics']['checkpoint_loaded'] is True
    assert any(f['movement_policy'] == 'meshgraphnet' for f in res['frames'])
    assert any(len(f['turn_actions']) > 0 for f in res['frames'])

    b1 = body['comparison']['fixed_time']['metrics']
    b2 = body['comparison']['max_pressure']['metrics']
    b3 = body['comparison']['gnn_mappo']['metrics']
    assert b3['avg_delay_s'] <= b1['avg_delay_s']
    assert b3['corridor_avg_delay_s'] <= b1['corridor_avg_delay_s']
    assert b3['throughput_vph'] > b1['throughput_vph']
    assert b3['spillback_events'] < b1['spillback_events']
    assert b3['throughput_vph'] > b2['throughput_vph']
