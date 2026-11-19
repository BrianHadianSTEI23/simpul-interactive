"""Spatial network loader, eligibility mask validator, and Gaussian disruption model.

All geographic data is loaded from the extracted OSM artifacts under data/regions/.
Disruption impacts are explicitly classified as synthetic Gaussian scenario modeling
and never presented as observed flood depth or measured protest intensity.
"""
from __future__ import annotations

import json
import math
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

from .connected_network import build_connected_region, build_signage_nodes

ROOT = Path(__file__).resolve().parent.parent
REGIONS_DIR = ROOT / 'data' / 'regions'
MANIFEST_PATH = ROOT / 'data' / 'provenance_manifest.json'

METERS_PER_DEG_LAT = 110574.0
METERS_PER_DEG_LON_JAKARTA = 110680.0  # cos(-6.2 deg) * 111320


def _to_local_xy(lat: float, lon: float, ref_lat: float, ref_lon: float) -> tuple[float, float]:
    return (
        (lon - ref_lon) * METERS_PER_DEG_LON_JAKARTA,
        (lat - ref_lat) * METERS_PER_DEG_LAT,
    )


def point_in_polygon(lat: float, lon: float, ring: list[list[float]]) -> bool:
    """Ray-casting point-in-polygon test for [lon, lat] rings."""
    if len(ring) < 3:
        return False
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        intersects = ((yi > lat) != (yj > lat)) and (
            lon < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi
        )
        if intersects:
            inside = not inside
        j = i
    return inside


def point_to_segment_distance_m(
    lat: float,
    lon: float,
    a_lon: float,
    a_lat: float,
    b_lon: float,
    b_lat: float,
) -> tuple[float, float, float]:
    """Return (distance_m, nearest_lat, nearest_lon) from (lat, lon) to segment A-B."""
    ax, ay = _to_local_xy(a_lat, a_lon, lat, lon)
    bx, by = _to_local_xy(b_lat, b_lon, lat, lon)
    dx, dy = bx - ax, by - ay
    seg_len_sq = dx * dx + dy * dy
    if seg_len_sq <= 1e-9:
        return math.hypot(ax, ay), a_lat, a_lon
    t = max(0.0, min(1.0, -(ax * dx + ay * dy) / seg_len_sq))
    px = ax + t * dx
    py = ay + t * dy
    dist_m = math.hypot(px, py)
    snap_lat = a_lat + t * (b_lat - a_lat)
    snap_lon = a_lon + t * (b_lon - a_lon)
    return dist_m, snap_lat, snap_lon


def point_to_polyline_distance_m(
    lat: float,
    lon: float,
    coords: list[list[float]],
) -> tuple[float, float, float]:
    best_dist = float('inf')
    best_lat, best_lon = lat, lon
    for i in range(len(coords) - 1):
        d, s_lat, s_lon = point_to_segment_distance_m(
            lat, lon,
            coords[i][0], coords[i][1],
            coords[i + 1][0], coords[i + 1][1],
        )
        if d < best_dist:
            best_dist, best_lat, best_lon = d, s_lat, s_lon
    return best_dist, best_lat, best_lon


@lru_cache(maxsize=1)
def load_manifest() -> dict[str, Any]:
    if not MANIFEST_PATH.is_file():
        return {'schemaVersion': 1, 'status': 'missing_manifest', 'datasets': {}}
    return json.loads(MANIFEST_PATH.read_text(encoding='utf-8'))


def list_region_ids() -> list[str]:
    if not REGIONS_DIR.is_dir():
        return []
    return sorted(p.stem for p in REGIONS_DIR.glob('*.json'))


@lru_cache(maxsize=8)
def load_region(region_id: str) -> dict[str, Any]:
    if region_id == 'all':
        return build_connected_region({
            rid: load_region(rid) for rid in ('pluit', 'tanah_abang', 'cilandak')
        })
    path = REGIONS_DIR / f'{region_id}.json'
    if not path.is_file():
        raise KeyError(f'Unknown region_id: {region_id}')
    data = json.loads(path.read_text(encoding='utf-8'))
    if 'signage_nodes' not in data:
        data['signage_nodes'] = build_signage_nodes(data)
    return data


@lru_cache(maxsize=8)
def load_region_geojson(region_id: str) -> dict[str, Any]:
    if region_id == 'all':
        features = []
        for rid in ('pluit', 'tanah_abang', 'cilandak'):
            features.extend(load_region_geojson(rid).get('features', []))
        conn = load_region('all')
        for e in conn['edges']:
            if e.get('is_inter_region_connector'):
                features.append({
                    'type': 'Feature',
                    'properties': {
                        'layer': 'connector_road',
                        'edge_id': e['edge_id'],
                        'name': e['name'],
                        'corridor_pair': e.get('corridor_pair', 'inter_region'),
                    },
                    'geometry': {'type': 'LineString', 'coordinates': e['coordinates']},
                })
        return {'type': 'FeatureCollection', 'name': 'jakarta_connected', 'features': features}
    path = REGIONS_DIR / f'{region_id}.geojson'
    if not path.is_file():
        raise KeyError(f'Unknown region_id: {region_id}')
    return json.loads(path.read_text(encoding='utf-8'))


def region_summaries() -> list[dict[str, Any]]:
    summaries = []
    for rid in list_region_ids():
        r = load_region(rid)
        summaries.append({
            'id': r['id'],
            'name': r['name'],
            'district': r['district'],
            'subtitle': r['subtitle'],
            'bbox': r['bbox'],
            'center': r['center'],
            'default_zoom': r['default_zoom'],
            'primary_disruption': r['primary_disruption'],
            'scenario_eligibility': r['scenario_eligibility'],
            'disruption_anchors': r['disruption_anchors'],
            'stats': r['stats'],
            'provenance': r['provenance'],
        })
    return summaries


def region_coverage_payload(region_id: str) -> dict[str, Any]:
    r = load_region(region_id)
    if region_id == 'all':
        return {
            'region_id': 'all',
            'name': r['name'],
            'bbox': r['bbox'],
            'study_boundary': r['study_boundary'],
            'coverage_mask': r['coverage_mask'],
            'study_boundaries': r.get('study_boundaries', []),
            'coverage_masks': r.get('coverage_masks', []),
            'scenario_eligibility': r['scenario_eligibility'],
            'disruption_anchors': r['disruption_anchors'],
            'eligible_edge_ids': {
                'flood': [e['edge_id'] for e in r['edges'] if e.get('flood_eligible')],
                'demonstration': [e['edge_id'] for e in r['edges'] if e.get('demonstration_eligible')],
            },
            'provenance': r['provenance'],
        }
    return {
        'region_id': r['id'],
        'name': r['name'],
        'bbox': r['bbox'],
        'study_boundary': r['study_boundary'],
        'coverage_mask': r['coverage_mask'],
        'scenario_eligibility': r['scenario_eligibility'],
        'disruption_anchors': r['disruption_anchors'],
        'eligible_edge_ids': {
            'flood': [e['edge_id'] for e in r['edges'] if e.get('flood_eligible')],
            'demonstration': [e['edge_id'] for e in r['edges'] if e.get('demonstration_eligible')],
        },
        'provenance': r['provenance'],
    }


def validate_and_snap_disruption(
    region_id: str,
    lat: float,
    lon: float,
    disruption_kind: Literal['flood', 'demonstration'],
    max_snap_distance_m: float = 200.0,
) -> dict[str, Any]:
    """Verify clicked coordinate against study-area coverage & disruption mask, then snap."""
    if region_id == 'all':
        for sub_rid in ('pluit', 'tanah_abang', 'cilandak'):
            sub = load_region(sub_rid)
            b = sub['bbox']
            pad_deg = max_snap_distance_m / METERS_PER_DEG_LAT
            if (b['south'] - pad_deg) <= lat <= (b['north'] + pad_deg) and (b['west'] - pad_deg) <= lon <= (b['east'] + pad_deg):
                res = validate_and_snap_disruption(sub_rid, lat, lon, disruption_kind, max_snap_distance_m)
                if res.get('accepted') or res.get('inside_region'):
                    res['matched_region_id'] = sub_rid
                    return res
        return {
            'accepted': False,
            'inside_region': False,
            'inside_coverage': False,
            'eligible_for_disruption': False,
            'reason': (
                f'Selected coordinate ({lat:.5f}, {lon:.5f}) lies outside Tanah Abang, Cilandak, and Pluit. '
                'Flooding and demonstration disruptions remain strictly scoped to those three study areas.'
            ),
        }
    region = load_region(region_id)
    elig_cfg = region['scenario_eligibility'].get(disruption_kind, {})
    if not elig_cfg.get('supported'):
        return {
            'accepted': False,
            'inside_region': False,
            'inside_coverage': False,
            'eligible_for_disruption': False,
            'reason': f'{disruption_kind} scenario is not supported in {region["name"]}.',
        }

    bbox = region['bbox']
    in_bbox = bbox['south'] <= lat <= bbox['north'] and bbox['west'] <= lon <= bbox['east']
    in_coverage = in_bbox and point_in_polygon(lat, lon, region['coverage_mask'])

    if not in_bbox:
        return {
            'accepted': False,
            'inside_region': False,
            'inside_coverage': False,
            'eligible_for_disruption': False,
            'reason': f'Selected coordinate ({lat:.5f}, {lon:.5f}) lies outside the {region["name"]} study boundary.',
        }

    flag = 'flood_eligible' if disruption_kind == 'flood' else 'demonstration_eligible'
    eligible_edges = [e for e in region['edges'] if e.get(flag)]
    all_edges = region['edges']

    best_elig: tuple[float, dict[str, Any], float, float] | None = None
    for edge in eligible_edges:
        d, s_lat, s_lon = point_to_polyline_distance_m(lat, lon, edge['coordinates'])
        if best_elig is None or d < best_elig[0]:
            best_elig = (d, edge, s_lat, s_lon)

    best_any_d = float('inf')
    for edge in all_edges:
        d, _, _ = point_to_polyline_distance_m(lat, lon, edge['coordinates'])
        if d < best_any_d:
            best_any_d = d

    if not in_coverage and best_any_d > max_snap_distance_m:
        return {
            'accepted': False,
            'inside_region': True,
            'inside_coverage': False,
            'eligible_for_disruption': False,
            'nearest_distance_m': round(best_any_d, 1),
            'reason': f'Location is outside the covered arterial/collector road mask (nearest covered road is {best_any_d:.0f} m away).',
        }

    if best_elig is None or best_elig[0] > max_snap_distance_m:
        dist_str = f'{best_elig[0]:.0f} m' if best_elig else 'N/A'
        return {
            'accepted': False,
            'inside_region': True,
            'inside_coverage': in_coverage,
            'eligible_for_disruption': False,
            'nearest_distance_m': round(best_elig[0], 1) if best_elig else None,
            'reason': (
                f'Location is not eligible for synthetic {disruption_kind} placement '
                f'(nearest eligible {disruption_kind} corridor is {dist_str} away; max snap radius {max_snap_distance_m:.0f} m).'
            ),
        }

    dist_m, snapped_edge, snap_lat, snap_lon = best_elig
    return {
        'accepted': True,
        'inside_region': True,
        'inside_coverage': True,
        'eligible_for_disruption': True,
        'disruption_kind': disruption_kind,
        'snapped_lat': round(snap_lat, 6),
        'snapped_lon': round(snap_lon, 6),
        'snapped_edge_id': snapped_edge['edge_id'],
        'snapped_road_name': snapped_edge['name'],
        'snap_distance_m': round(dist_m, 1),
        'scenario_role': elig_cfg.get('role', 'synthetic_zone'),
        'provenance': 'synthetic_scenario_anchor_snapped_to_osm',
        'disclaimer': 'Selected centre defines a synthetic Gaussian scenario, not an observed field measurement.',
    }


def compute_gaussian_impacts(
    region: dict[str, Any],
    flood: dict[str, Any] | None = None,
    demonstration: dict[str, Any] | None = None,
) -> dict[str, dict[str, Any]]:
    """Evaluate Gaussian impact I_e = I_0 * exp(-d_e^2 / (2 * sigma^2)) per road edge.

    Flooding and demonstration keep separate physical parameter transformations and
    only affect edges marked eligible in the explicit scenario mask.
    """
    impacts: dict[str, dict[str, Any]] = {}
    for edge in region['edges']:
        eid = edge['edge_id']
        flood_i = 0.0
        demo_i = 0.0
        flood_d = None
        demo_d = None

        if flood and flood.get('enabled') and edge.get('flood_eligible'):
            sigma = max(40.0, float(flood.get('sigma_m', 420.0)))
            i0 = max(0.0, min(1.0, float(flood.get('intensity', 0.75))))
            d_m, _, _ = point_to_polyline_distance_m(
                float(flood['lat']), float(flood['lon']), edge['coordinates']
            )
            flood_d = round(d_m, 1)
            w_e = math.exp(-(d_m * d_m) / (2.0 * sigma * sigma))
            flood_i = round(i0 * w_e, 4)

        if demonstration and demonstration.get('enabled') and edge.get('demonstration_eligible'):
            sigma = max(40.0, float(demonstration.get('sigma_m', 360.0)))
            i0 = max(0.0, min(1.0, float(demonstration.get('intensity', 0.7))))
            d_m, _, _ = point_to_polyline_distance_m(
                float(demonstration['lat']), float(demonstration['lon']), edge['coordinates']
            )
            demo_d = round(d_m, 1)
            w_e = math.exp(-(d_m * d_m) / (2.0 * sigma * sigma))
            demo_i = round(i0 * w_e, 4)

        # Physical parameter mapping kept strictly separate by phenomenon:
        # - Flood: speed drag + capacity loss + closure at severe inundation (I_flood >= 0.82)
        # - Demonstration: kerb/lane capacity bottleneck + moderate speed drop + access restriction (I_demo >= 0.65)
        closed = flood_i >= 0.82
        access_restricted = demo_i >= 0.65

        if closed:
            flood_speed_factor = 0.0
            flood_cap_factor = 0.0
        else:
            flood_speed_factor = max(0.10, 1.0 - 0.82 * (flood_i ** 1.15)) if flood_i > 0.01 else 1.0
            flood_cap_factor = max(0.12, 1.0 - 0.74 * flood_i) if flood_i > 0.01 else 1.0

        demo_speed_factor = max(0.18, 1.0 - 0.68 * demo_i) if demo_i > 0.01 else 1.0
        demo_cap_factor = max(0.10, 1.0 - 0.86 * (demo_i ** 1.05)) if demo_i > 0.01 else 1.0

        combined_speed_factor = round(min(flood_speed_factor, demo_speed_factor) * (0.92 if flood_i > 0.1 and demo_i > 0.1 else 1.0), 4)
        combined_cap_factor = round(min(flood_cap_factor, demo_cap_factor) * (0.90 if flood_i > 0.1 and demo_i > 0.1 else 1.0), 4)
        combined_intensity = round(min(1.0, max(flood_i, demo_i) + 0.25 * min(flood_i, demo_i)), 4)

        impacts[eid] = {
            'edge_id': eid,
            'flood_intensity': flood_i,
            'flood_distance_m': flood_d,
            'demonstration_intensity': demo_i,
            'demonstration_distance_m': demo_d,
            'combined_intensity': combined_intensity,
            'speed_factor': 0.0 if closed else combined_speed_factor,
            'capacity_factor': 0.0 if closed else combined_cap_factor,
            'closed': closed,
            'access_restricted': access_restricted,
            'modeling_provenance': 'synthetic_gaussian_disruption',
        }
    return impacts
