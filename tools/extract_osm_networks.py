"""Reproducible OpenStreetMap road-network & transit extraction pipeline for SIMPUL.

Queries Overpass API (or OSMnx when --use-osmnx is requested and installed) for the
three Jakarta study areas:
  1. Tanah Abang (Stasiun Tanah Abang, Pasar Tanah Abang, Jl. Jatibaru, Jl. Fachrudin, Jl. KH Mas Mansyur)
  2. Cilandak (MRT Fatmawati, Jl. TB Simatupang, Jl. Fatmawati, Cilandak Town Square)
  3. Pluit (Jl. Muara Baru, Pluit Sea View, Waduk Pluit, Penjaringan)

Filters out alleys, residential access roads, footpaths, and building labels while
preserving original OSM geometry and topological intersections. Optionally ingests a
local TransJakarta GTFS zip/directory (`--gtfs-path`) when available.

Outputs:
  - data/regions/<region_id>.geojson  (RFC 7946 GeoJSON layers)
  - data/regions/<region_id>.json     (Graph edges, intersections, movements, masks)
  - data/provenance_manifest.json     (Layer provenance, licensing, missing-data status)
  - js/adaptive-regions-data.js       (Static ES module bundle for offline/standalone UI)
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / 'data' / 'regions'
MANIFEST_PATH = ROOT / 'data' / 'provenance_manifest.json'
JS_OUT_PATH = ROOT / 'public' / 'js' / 'adaptive-regions-data.js'

OVERPASS_ENDPOINTS = (
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
)

INCLUDED_HIGHWAY_CLASSES = (
    'motorway',
    'motorway_link',
    'trunk',
    'trunk_link',
    'primary',
    'primary_link',
    'secondary',
    'secondary_link',
    'tertiary',
    'tertiary_link',
)

EXCLUDED_HIGHWAY_CLASSES = (
    'residential',
    'living_street',
    'service',
    'alley',
    'footway',
    'pedestrian',
    'path',
    'steps',
    'cycleway',
    'track',
    'unclassified',
)

DEFAULT_SPEED_BY_CLASS = {
    'motorway': 80.0,
    'motorway_link': 50.0,
    'trunk': 60.0,
    'trunk_link': 45.0,
    'primary': 50.0,
    'primary_link': 38.0,
    'secondary': 42.0,
    'secondary_link': 32.0,
    'tertiary': 35.0,
    'tertiary_link': 28.0,
}

DEFAULT_LANES_BY_CLASS = {
    'motorway': 3,
    'motorway_link': 2,
    'trunk': 3,
    'trunk_link': 2,
    'primary': 2,
    'primary_link': 1,
    'secondary': 2,
    'secondary_link': 1,
    'tertiary': 1,
    'tertiary_link': 1,
}

REGION_ORDER = (
    'pluit',
    'tambora',
    'tomang_harmoni',
    'tanah_abang',
    'sudirman_senayan',
    'kebayoran_baru',
    'kemang_cipete',
    'cilandak',
)

ADJACENT_CORRIDOR_PAIRS = (
    ('pluit', 'tambora'),
    ('tambora', 'tomang_harmoni'),
    ('tomang_harmoni', 'tanah_abang'),
    ('tanah_abang', 'sudirman_senayan'),
    ('sudirman_senayan', 'kebayoran_baru'),
    ('kebayoran_baru', 'kemang_cipete'),
    ('kemang_cipete', 'cilandak'),
)

REGION_SPECS: dict[str, dict[str, Any]] = {
    'pluit': {
        'id': 'pluit',
        'name': 'Pluit',
        'district': 'Jakarta Utara',
        'subtitle': 'Jl. Muara Baru · Pluit Sea View · Waduk Pluit · Penjaringan',
        'bbox': (-6.1290, 106.7805, -6.1060, 106.8110),
        'center': {'lat': -6.1172, 'lon': 106.7968},
        'default_zoom': 14.7,
        'focus_streets': ['muara baru', 'pluit', 'penjaringan', 'gedong panjang', 'pakın', 'pakin', 'jembatan tiga', 'bandengan'],
        'primary_disruption': 'flood',
        'scenario_eligibility': {
            'flood': {
                'supported': True,
                'role': 'primary_scenario',
                'note': 'Primary coastal/tidal flood scenario covering Jl. Muara Baru, Pluit Sea View, Waduk Pluit, and Penjaringan.',
                'keywords': ['muara baru', 'pluit', 'penjaringan', 'waduk', 'gedong panjang'],
                'default_anchor_keywords': ['muara baru'],
                'default_radius_m': 460.0,
            },
            'demonstration': {
                'supported': True,
                'role': 'secondary_synthetic_zone',
                'note': 'Designated synthetic port-gate / arterial demonstration zone near Muara Baru & Penjaringan.',
                'keywords': ['muara baru', 'penjaringan', 'pluit', 'gedong panjang'],
                'default_anchor_keywords': ['penjaringan', 'muara baru'],
                'default_radius_m': 380.0,
            },
        },
        'landmarks': [
            {'id': 'lm-muara-baru', 'name': 'Koridor Jl. Muara Baru', 'kind': 'corridor', 'lat': -6.1128, 'lon': 106.8035, 'source': 'OSM reference'},
            {'id': 'lm-pluit-seaview', 'name': 'Pluit Sea View', 'kind': 'traffic_generator', 'lat': -6.1095, 'lon': 106.7988, 'source': 'OSM reference'},
            {'id': 'lm-waduk-pluit', 'name': 'Waduk Pluit', 'kind': 'water_feature', 'lat': -6.1178, 'lon': 106.7955, 'source': 'OSM reference'},
            {'id': 'lm-penjaringan', 'name': 'Simpul Penjaringan', 'kind': 'corridor', 'lat': -6.1243, 'lon': 106.8012, 'source': 'OSM reference'},
        ],
    },
    'tambora': {
        'id': 'tambora',
        'name': 'Tambora – Kota Tua',
        'district': 'Jakarta Barat',
        'subtitle': 'Jl. Jembatan Tiga · Jl. Latumeten · Jl. Bandengan · Kota Tua · Glodok',
        'bbox': (-6.1540, 106.7830, -6.1285, 106.8250),
        'center': {'lat': -6.1412, 'lon': 106.8040},
        'default_zoom': 14.5,
        'focus_streets': ['jembatan tiga', 'latumeten', 'bandengan', 'mansyur', 'tubagus angke', 'gajah mada', 'hayam wuruk', 'gedong panjang', 'pintu besar', 'mangga dua'],
        'primary_disruption': 'flood',
        'scenario_eligibility': {
            'flood': {
                'supported': True,
                'role': 'primary_scenario',
                'note': 'Designated synthetic flood corridor along Kali Krukut, Bandengan, Jembatan Tiga, and Kota Tua drainage.',
                'keywords': ['jembatan tiga', 'bandengan', 'latumeten', 'tubagus angke', 'gedong panjang', 'mansyur'],
                'default_anchor_keywords': ['bandengan', 'jembatan tiga'],
                'default_radius_m': 430.0,
            },
            'demonstration': {
                'supported': True,
                'role': 'secondary_synthetic_zone',
                'note': 'Designated synthetic market/arterial demonstration corridor around Glodok, Kota Tua, and Jembatan Lima.',
                'keywords': ['gajah mada', 'hayam wuruk', 'pintu besar', 'mansyur', 'mangga dua'],
                'default_anchor_keywords': ['gajah mada', 'hayam wuruk'],
                'default_radius_m': 390.0,
            },
        },
        'landmarks': [
            {'id': 'lm-jakarta-kota', 'name': 'Stasiun Jakarta Kota', 'kind': 'rail_station', 'lat': -6.1376, 'lon': 106.8147, 'source': 'OSM reference'},
            {'id': 'lm-jembatan-tiga', 'name': 'Koridor Jembatan Tiga – Latumeten', 'kind': 'corridor', 'lat': -6.1352, 'lon': 106.7918, 'source': 'OSM reference'},
            {'id': 'lm-bandengan', 'name': 'Koridor Jl. Bandengan Selatan', 'kind': 'corridor', 'lat': -6.1347, 'lon': 106.8025, 'source': 'OSM reference'},
            {'id': 'lm-glodok', 'name': 'Koridor Glodok / Jl. Gajah Mada', 'kind': 'traffic_generator', 'lat': -6.1445, 'lon': 106.8152, 'source': 'OSM reference'},
        ],
    },
    'tomang_harmoni': {
        'id': 'tomang_harmoni',
        'name': 'Tomang – Harmoni',
        'district': 'Jakarta Barat / Pusat',
        'subtitle': 'Simpang Tomang · Jl. Kyai Tapa · Jl. KH Hasyim Ashari · Harmoni · Cideng',
        'bbox': (-6.1785, 106.7880, -6.1535, 106.8260),
        'center': {'lat': -6.1660, 'lon': 106.8070},
        'default_zoom': 14.5,
        'focus_streets': ['tomang', 'kyai tapa', 'parman', 'hasyim ashari', 'suryopranoto', 'cideng', 'gajah mada', 'hayam wuruk', 'abdul muis', 'biak'],
        'primary_disruption': 'demonstration',
        'scenario_eligibility': {
            'flood': {
                'supported': True,
                'role': 'secondary_synthetic_zone',
                'note': 'Designated synthetic canal/underpass flood zone along Cideng, Grogol, and Banjir Kanal Barat.',
                'keywords': ['cideng', 'kyai tapa', 'hasyim ashari', 'tomang', 'parman'],
                'default_anchor_keywords': ['cideng', 'kyai tapa'],
                'default_radius_m': 400.0,
            },
            'demonstration': {
                'supported': True,
                'role': 'primary_scenario',
                'note': 'Designated synthetic arterial bottleneck around Harmoni, Roxy, Kyai Tapa, and Simpang Tomang.',
                'keywords': ['hasyim ashari', 'suryopranoto', 'tomang', 'kyai tapa', 'gajah mada', 'hayam wuruk', 'cideng'],
                'default_anchor_keywords': ['hasyim ashari', 'suryopranoto'],
                'default_radius_m': 420.0,
            },
        },
        'landmarks': [
            {'id': 'lm-simpang-tomang', 'name': 'Simpang Tomang / S. Parman', 'kind': 'corridor', 'lat': -6.1748, 'lon': 106.7927, 'source': 'OSM reference'},
            {'id': 'lm-kyai-tapa', 'name': 'Koridor Jl. Kyai Tapa', 'kind': 'corridor', 'lat': -6.1676, 'lon': 106.7925, 'source': 'OSM reference'},
            {'id': 'lm-roxy', 'name': 'Simpul Roxy / Hasyim Ashari', 'kind': 'traffic_generator', 'lat': -6.1656, 'lon': 106.8056, 'source': 'OSM reference'},
            {'id': 'lm-harmoni', 'name': 'Simpang Harmoni', 'kind': 'corridor', 'lat': -6.1656, 'lon': 106.8204, 'source': 'OSM reference'},
        ],
    },
    'tanah_abang': {
        'id': 'tanah_abang',
        'name': 'Tanah Abang',
        'district': 'Jakarta Pusat',
        'subtitle': 'Stasiun Tanah Abang · Pasar Tanah Abang · Jl. Jatibaru · Jl. Fachrudin · Jl. KH Mas Mansyur',
        'bbox': (-6.1975, 106.8050, -6.1780, 106.8240),  # (south, west, north, east)
        'center': {'lat': -6.1872, 'lon': 106.8145},
        'default_zoom': 15.1,
        'focus_streets': ['jatibaru', 'fachrudin', 'mas mansyur', 'kebon sirih', 'cideng', 'ks tubun', 'wahid hasyim', 'tanah abang'],
        'primary_disruption': 'demonstration',
        'scenario_eligibility': {
            'flood': {
                'supported': True,
                'role': 'secondary_synthetic_zone',
                'note': 'Designated synthetic flood scenario near Cideng / Tanah Abang underpass drainage (not live flood depth).',
                'keywords': ['jatibaru', 'cideng', 'ks tubun', 'underpass'],
                'default_anchor_keywords': ['jatibaru'],
                'default_radius_m': 380.0,
            },
            'demonstration': {
                'supported': True,
                'role': 'primary_scenario',
                'note': 'Designated synthetic demonstration scenario around Pasar Tanah Abang / Jl. Jatibaru / Jl. Fachrudin.',
                'keywords': ['jatibaru', 'fachrudin', 'mas mansyur', 'kebon sirih', 'tanah abang'],
                'default_anchor_keywords': ['jatibaru', 'fachrudin'],
                'default_radius_m': 420.0,
            },
        },
        'landmarks': [
            {'id': 'lm-sta-tanah-abang', 'name': 'Stasiun Tanah Abang', 'kind': 'rail_station', 'lat': -6.1856, 'lon': 106.8108, 'source': 'OSM reference'},
            {'id': 'lm-pasar-tanah-abang', 'name': 'Pasar Tanah Abang', 'kind': 'traffic_generator', 'lat': -6.1886, 'lon': 106.8142, 'source': 'OSM reference'},
            {'id': 'lm-jl-jatibaru', 'name': 'Koridor Jl. Jatibaru', 'kind': 'corridor', 'lat': -6.1858, 'lon': 106.8139, 'source': 'OSM reference'},
            {'id': 'lm-jl-fachrudin', 'name': 'Koridor Jl. Fachrudin', 'kind': 'corridor', 'lat': -6.1878, 'lon': 106.8156, 'source': 'OSM reference'},
            {'id': 'lm-kh-mas-mansyur', 'name': 'Koridor Jl. KH Mas Mansyur', 'kind': 'corridor', 'lat': -6.1925, 'lon': 106.8147, 'source': 'OSM reference'},
        ],
    },
    'sudirman_senayan': {
        'id': 'sudirman_senayan',
        'name': 'Sudirman – Senayan',
        'district': 'Jakarta Pusat / Selatan',
        'subtitle': 'Jl. Jend. Sudirman · Karet / Benhil · Semanggi · GBK Senayan · Jl. Gatot Subroto',
        'bbox': (-6.2265, 106.7900, -6.1970, 106.8260),
        'center': {'lat': -6.2118, 'lon': 106.8080},
        'default_zoom': 14.4,
        'focus_streets': ['sudirman', 'mas mansyur', 'satrio', 'gatot subroto', 'asia afrika', 'gerbang pemuda', 'penjernihan', 'tentara pelajar', 'palmerah'],
        'primary_disruption': 'demonstration',
        'scenario_eligibility': {
            'flood': {
                'supported': True,
                'role': 'secondary_synthetic_zone',
                'note': 'Designated synthetic stormwater/underpass runoff scenario near Karet, Benhil, and Dukuh Atas.',
                'keywords': ['sudirman', 'mas mansyur', 'penjernihan', 'gatot subroto'],
                'default_anchor_keywords': ['mas mansyur', 'sudirman'],
                'default_radius_m': 390.0,
            },
            'demonstration': {
                'supported': True,
                'role': 'primary_scenario',
                'note': 'Designated synthetic corridor demonstration along Jl. Jend. Sudirman, Semanggi, and Senayan.',
                'keywords': ['sudirman', 'gatot subroto', 'asia afrika', 'gerbang pemuda', 'mas mansyur'],
                'default_anchor_keywords': ['sudirman', 'gatot subroto'],
                'default_radius_m': 430.0,
            },
        },
        'landmarks': [
            {'id': 'lm-mrt-benhil', 'name': 'MRT Bendungan Hilir / Sudirman', 'kind': 'mrt_station', 'lat': -6.2149, 'lon': 106.8179, 'source': 'OSM reference'},
            {'id': 'lm-semanggi', 'name': 'Simpang Susun Semanggi', 'kind': 'corridor', 'lat': -6.2215, 'lon': 106.8147, 'source': 'OSM reference'},
            {'id': 'lm-asia-afrika', 'name': 'Koridor Jl. Asia Afrika / Senayan', 'kind': 'traffic_generator', 'lat': -6.2237, 'lon': 106.8007, 'source': 'OSM reference'},
            {'id': 'lm-gatot-subroto', 'name': 'Koridor Jl. Gatot Subroto', 'kind': 'corridor', 'lat': -6.2195, 'lon': 106.8110, 'source': 'OSM reference'},
        ],
    },
    'kebayoran_baru': {
        'id': 'kebayoran_baru',
        'name': 'Kebayoran Baru',
        'district': 'Jakarta Selatan',
        'subtitle': 'Bundaran Senayan · Blok M · Jl. Sisingamangaraja · Jl. Panglima Polim · Jl. Antasari',
        'bbox': (-6.2555, 106.7840, -6.2260, 106.8220),
        'center': {'lat': -6.2408, 'lon': 106.8030},
        'default_zoom': 14.5,
        'focus_streets': ['sisingamangaraja', 'panglima polim', 'antasari', 'melawai', 'wolter monginsidi', 'senopati', 'wijaya', 'radio dalam', 'pakubuwono', 'iskandarsyah'],
        'primary_disruption': 'demonstration',
        'scenario_eligibility': {
            'flood': {
                'supported': True,
                'role': 'secondary_synthetic_zone',
                'note': 'Designated synthetic Kali Krukut / Antasari stormwater runoff scenario in Kebayoran Baru.',
                'keywords': ['antasari', 'wijaya', 'wolter monginsidi', 'panglima polim'],
                'default_anchor_keywords': ['antasari', 'wijaya'],
                'default_radius_m': 380.0,
            },
            'demonstration': {
                'supported': True,
                'role': 'primary_scenario',
                'note': 'Designated synthetic curb/transit bottleneck around CSW ASEAN, Blok M, and Jl. Sisingamangaraja.',
                'keywords': ['sisingamangaraja', 'panglima polim', 'melawai', 'antasari', 'trunojoyo'],
                'default_anchor_keywords': ['panglima polim', 'sisingamangaraja'],
                'default_radius_m': 410.0,
            },
        },
        'landmarks': [
            {'id': 'lm-mrt-asean', 'name': 'MRT ASEAN / Simpul CSW', 'kind': 'mrt_station', 'lat': -6.2389, 'lon': 106.7985, 'source': 'OSM reference'},
            {'id': 'lm-blok-m', 'name': 'Kawasan & Terminal Blok M', 'kind': 'traffic_generator', 'lat': -6.2442, 'lon': 106.8006, 'source': 'OSM reference'},
            {'id': 'lm-antasari-utara', 'name': 'Koridor Jl. Pangeran Antasari', 'kind': 'corridor', 'lat': -6.2498, 'lon': 106.8063, 'source': 'OSM reference'},
            {'id': 'lm-monginsidi', 'name': 'Koridor Jl. Wolter Monginsidi', 'kind': 'corridor', 'lat': -6.2387, 'lon': 106.8089, 'source': 'OSM reference'},
        ],
    },
    'kemang_cipete': {
        'id': 'kemang_cipete',
        'name': 'Kemang – Cipete',
        'district': 'Jakarta Selatan',
        'subtitle': 'Jl. RS Fatmawati · Jl. Pangeran Antasari · Jl. Kemang Raya · Cipete · Dharmawangsa',
        'bbox': (-6.2840, 106.7840, -6.2550, 106.8180),
        'center': {'lat': -6.2695, 'lon': 106.8010},
        'default_zoom': 14.5,
        'focus_streets': ['fatmawati', 'antasari', 'kemang', 'cipete', 'dharmawangsa', 'ampera', 'haji nawi', 'bangka', 'prapanca'],
        'primary_disruption': 'demonstration',
        'scenario_eligibility': {
            'flood': {
                'supported': True,
                'role': 'secondary_synthetic_zone',
                'note': 'Designated synthetic Kali Krukut / Kemang Raya flood runoff zone.',
                'keywords': ['kemang', 'antasari', 'cipete', 'fatmawati'],
                'default_anchor_keywords': ['kemang', 'antasari'],
                'default_radius_m': 400.0,
            },
            'demonstration': {
                'supported': True,
                'role': 'primary_scenario',
                'note': 'Designated synthetic arterial bottleneck along Jl. RS Fatmawati, Jl. Pangeran Antasari, and Kemang.',
                'keywords': ['fatmawati', 'antasari', 'kemang', 'cipete', 'ampera'],
                'default_anchor_keywords': ['fatmawati', 'antasari'],
                'default_radius_m': 400.0,
            },
        },
        'landmarks': [
            {'id': 'lm-mrt-cipete', 'name': 'MRT Cipete Raya / Fatmawati', 'kind': 'mrt_station', 'lat': -6.2784, 'lon': 106.7972, 'source': 'OSM reference'},
            {'id': 'lm-antasari-selatan', 'name': 'Koridor Jl. Pangeran Antasari', 'kind': 'corridor', 'lat': -6.2685, 'lon': 106.8065, 'source': 'OSM reference'},
            {'id': 'lm-kemang-raya', 'name': 'Koridor Jl. Kemang Raya', 'kind': 'traffic_generator', 'lat': -6.2643, 'lon': 106.8135, 'source': 'OSM reference'},
            {'id': 'lm-dharmawangsa', 'name': 'Simpul Dharmawangsa / Prapanca', 'kind': 'corridor', 'lat': -6.2584, 'lon': 106.8035, 'source': 'OSM reference'},
        ],
    },
    'cilandak': {
        'id': 'cilandak',
        'name': 'Cilandak',
        'district': 'Jakarta Selatan',
        'subtitle': 'MRT Fatmawati · Jl. TB Simatupang · Jl. RS Fatmawati · Cilandak Town Square',
        'bbox': (-6.3005, 106.7845, -6.2835, 106.8085),
        'center': {'lat': -6.2921, 'lon': 106.7962},
        'default_zoom': 15.0,
        'focus_streets': ['simatupang', 'fatmawati', 'kartini', 'cilandak', 'antasari', 'pondok labu', 'lebak bulus', 'ampera'],
        'primary_disruption': 'demonstration',
        'scenario_eligibility': {
            'flood': {
                'supported': True,
                'role': 'secondary_synthetic_zone',
                'note': 'Designated synthetic stormwater runoff zone along Krukut / TB Simatupang frontage (not observed flood sensor).',
                'keywords': ['simatupang', 'kartini', 'fatmawati', 'antasari'],
                'default_anchor_keywords': ['simatupang', 'kartini'],
                'default_radius_m': 380.0,
            },
            'demonstration': {
                'supported': True,
                'role': 'primary_scenario',
                'note': 'Designated synthetic curb/demonstration bottleneck around MRT Fatmawati & Cilandak Town Square corridor.',
                'keywords': ['simatupang', 'fatmawati', 'kartini', 'cilandak', 'antasari'],
                'default_anchor_keywords': ['simatupang', 'fatmawati'],
                'default_radius_m': 400.0,
            },
        },
        'landmarks': [
            {'id': 'lm-mrt-fatmawati', 'name': 'Stasiun MRT Fatmawati', 'kind': 'mrt_station', 'lat': -6.29247, 'lon': 106.79245, 'source': 'OSM node 6577753462'},
            {'id': 'lm-citos', 'name': 'Cilandak Town Square', 'kind': 'traffic_generator', 'lat': -6.2923, 'lon': 106.7995, 'source': 'OSM reference'},
            {'id': 'lm-tb-simatupang', 'name': 'Koridor Jl. TB Simatupang', 'kind': 'corridor', 'lat': -6.2920, 'lon': 106.7960, 'source': 'OSM reference'},
            {'id': 'lm-fatmawati', 'name': 'Koridor Jl. RS Fatmawati', 'kind': 'corridor', 'lat': -6.2886, 'lon': 106.7963, 'source': 'OSM reference'},
        ],
    },
}


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2.0) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2.0) ** 2
    return 2.0 * r * math.asin(min(1.0, math.sqrt(a)))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    y = math.sin(math.radians(lon2 - lon1)) * math.cos(math.radians(lat2))
    x = (
        math.cos(math.radians(lat1)) * math.sin(math.radians(lat2))
        - math.sin(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.cos(math.radians(lon2 - lon1))
    )
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def polyline_length_m(coords: list[list[float]]) -> float:
    return sum(
        haversine_m(coords[i][1], coords[i][0], coords[i + 1][1], coords[i + 1][0])
        for i in range(len(coords) - 1)
    )


def parse_maxspeed(raw: str | None, highway: str) -> float:
    if raw:
        digits = ''.join(ch for ch in str(raw).split(';')[0] if ch.isdigit() or ch == '.')
        if digits:
            val = float(digits)
            if 10.0 <= val <= 120.0:
                return val
    return DEFAULT_SPEED_BY_CLASS.get(highway, 40.0)


def parse_lanes(raw: str | None, highway: str) -> int:
    if raw:
        digits = ''.join(ch for ch in str(raw).split(';')[0] if ch.isdigit())
        if digits:
            val = int(digits)
            if 1 <= val <= 6:
                return val
    return DEFAULT_LANES_BY_CLASS.get(highway, 2)


def fetch_overpass(bbox: tuple[float, float, float, float]) -> dict[str, Any]:
    s, w, n, e = bbox
    hw_regex = '|'.join(INCLUDED_HIGHWAY_CLASSES)
    query = f"""
[out:json][timeout:60];
(
  way["highway"~"^({hw_regex})$"]({s},{w},{n},{e});
  node["highway"="traffic_signals"]({s},{w},{n},{e});
  node["highway"="bus_stop"]({s},{w},{n},{e});
  node["public_transport"~"^(platform|stop_position|station)$"]({s},{w},{n},{e});
  node["railway"~"^(station|halt|subway_entrance)$"]({s},{w},{n},{e});
  way["natural"="water"]({s},{w},{n},{e});
  way["waterway"~"^(river|canal)$"]({s},{w},{n},{e});
);
out body;
>;
out skel qt;
""".strip()
    body = urllib.parse.urlencode({'data': query}).encode('utf-8')
    last_err: Exception | None = None
    for attempt in range(2):
        for endpoint in OVERPASS_ENDPOINTS:
            req = urllib.request.Request(
                endpoint,
                data=body,
                headers={
                    'User-Agent': 'SIMPUL-JakartaAdaptiveTraffic/2.0 (academic research prototype)',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json',
                },
                method='POST',
            )
            try:
                with urllib.request.urlopen(req, timeout=65) as resp:
                    raw = resp.read()
                data = json.loads(raw.decode('utf-8'))
                if 'elements' in data:
                    return data
            except (urllib.error.URLError, TimeoutError, ValueError) as exc:
                last_err = exc
                print(f'  retry ({endpoint}): {exc}', flush=True)
                time.sleep(2.0)
    raise RuntimeError(f'All Overpass endpoints failed: {last_err}')


def convex_hull(points: list[tuple[float, float]]) -> list[list[float]]:
    pts = sorted(set(points))
    if len(pts) < 3:
        return [[lon, lat] for lon, lat in pts]

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    hull = lower[:-1] + upper[:-1]
    return [[round(p[0], 6), round(p[1], 6)] for p in hull] + [[round(hull[0][0], 6), round(hull[0][1], 6)]]


def expand_polygon(ring: list[list[float]], pad_deg: float = 0.0012) -> list[list[float]]:
    if len(ring) < 4:
        return ring
    cx = sum(p[0] for p in ring[:-1]) / (len(ring) - 1)
    cy = sum(p[1] for p in ring[:-1]) / (len(ring) - 1)
    out = []
    for lon, lat in ring[:-1]:
        dx, dy = lon - cx, lat - cy
        d = math.hypot(dx, dy) or 1e-6
        out.append([round(lon + (dx / d) * pad_deg, 6), round(lat + (dy / d) * pad_deg, 6)])
    out.append(out[0])
    return out


def point_in_bbox(lat: float, lon: float, bbox: tuple[float, float, float, float]) -> bool:
    s, w, n, e = bbox
    return s <= lat <= n and w <= lon <= e


def ingest_gtfs_stops(gtfs_path: Path | None, bbox: tuple[float, float, float, float]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if gtfs_path is None or not gtfs_path.exists():
        return [], {
            'status': 'missing_local_gtfs_archive',
            'source': 'TransJakarta GTFS (not present locally; OSM transit stops used instead)',
            'records_loaded': 0,
        }
    rows: list[dict[str, Any]] = []
    try:
        if gtfs_path.is_dir():
            stops_file = gtfs_path / 'stops.txt'
            if not stops_file.is_file():
                raise FileNotFoundError('stops.txt missing in GTFS directory')
            text = stops_file.read_text(encoding='utf-8-sig')
        else:
            with zipfile.ZipFile(gtfs_path) as zf:
                text = zf.read('stops.txt').decode('utf-8-sig')
        reader = csv.DictReader(io.StringIO(text))
        for rec in reader:
            lat = float(rec.get('stop_lat', 0))
            lon = float(rec.get('stop_lon', 0))
            if point_in_bbox(lat, lon, bbox):
                rows.append({
                    'stop_id': f"gtfs-{rec.get('stop_id', '')}",
                    'name': (rec.get('stop_name') or 'TransJakarta Stop')[:80],
                    'mode': 'transjakarta_gtfs',
                    'lat': round(lat, 6),
                    'lon': round(lon, 6),
                    'source': 'official_transjakarta_gtfs',
                })
        return rows, {
            'status': 'integrated',
            'source': str(gtfs_path.name),
            'records_loaded': len(rows),
        }
    except Exception as exc:
        return [], {
            'status': 'gtfs_ingest_failed',
            'source': str(gtfs_path),
            'error': str(exc),
            'records_loaded': 0,
        }


def build_region_dataset(spec: dict[str, Any], osm_raw: dict[str, Any], gtfs_path: Path | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    elements = osm_raw.get('elements', [])
    nodes: dict[int, dict[str, Any]] = {}
    ways: list[dict[str, Any]] = []
    water_ways: list[dict[str, Any]] = []
    transit_nodes: list[dict[str, Any]] = []
    signal_node_ids: set[int] = set()

    for el in elements:
        etype = el.get('type')
        tags = el.get('tags') or {}
        if etype == 'node':
            nodes[el['id']] = el
            if tags.get('highway') == 'traffic_signals':
                signal_node_ids.add(el['id'])
            if (
                tags.get('railway') in ('station', 'halt', 'subway_entrance')
                or tags.get('highway') == 'bus_stop'
                or tags.get('public_transport') in ('station', 'platform', 'stop_position')
            ):
                mode = (
                    'mrt_station' if ('mrt' in str(tags.get('name', '')).lower() or tags.get('station') == 'subway' or tags.get('railway') == 'subway_entrance')
                    else 'rail_station' if tags.get('railway') in ('station', 'halt')
                    else 'bus_stop'
                )
                name = tags.get('name') or ('Transit Stop' if mode == 'bus_stop' else 'Station')
                transit_nodes.append({
                    'stop_id': f"osm-node-{el['id']}",
                    'osm_id': el['id'],
                    'name': str(name)[:90],
                    'mode': mode,
                    'lat': round(float(el['lat']), 6),
                    'lon': round(float(el['lon']), 6),
                    'source': 'OpenStreetMap',
                })
        elif etype == 'way':
            hw = tags.get('highway')
            if hw in INCLUDED_HIGHWAY_CLASSES:
                ways.append(el)
            elif tags.get('natural') == 'water' or tags.get('waterway') in ('river', 'canal'):
                water_ways.append(el)

    # Count node occurrences across filtered road ways to identify topological intersections.
    node_way_count: dict[int, int] = defaultdict(int)
    for w in ways:
        nds = w.get('nodes') or []
        for nid in set(nds):
            if nid in nodes:
                node_way_count[nid] += 1

    # Split ways at topological intersections (degree >= 2 across ways, or endpoints).
    edges: list[dict[str, Any]] = []
    node_edges_out: dict[str, list[str]] = defaultdict(list)
    node_edges_in: dict[str, list[str]] = defaultdict(list)
    used_nodes: dict[int, dict[str, Any]] = {}
    edge_counter = 0

    for w in ways:
        tags = w.get('tags') or {}
        hw = tags.get('highway', 'secondary')
        name = str(tags.get('name') or tags.get('ref') or f'{hw.replace("_", " ").title()} #{w["id"]}')[:80]
        oneway_tag = str(tags.get('oneway', 'no')).lower()
        if oneway_tag in ('yes', 'true', '1'):
            oneway_dir = 1
        elif oneway_tag == '-1':
            oneway_dir = -1
        elif hw in ('motorway', 'motorway_link', 'trunk_link', 'primary_link'):
            oneway_dir = 1
        else:
            oneway_dir = 0  # bidirectional

        speed_kmh = parse_maxspeed(tags.get('maxspeed'), hw)
        lanes = parse_lanes(tags.get('lanes'), hw)
        nds = [nid for nid in (w.get('nodes') or []) if nid in nodes]
        if len(nds) < 2:
            continue

        split_indices = [0]
        for idx in range(1, len(nds) - 1):
            nid = nds[idx]
            if node_way_count[nid] >= 2 or nid in signal_node_ids:
                split_indices.append(idx)
        split_indices.append(len(nds) - 1)

        for i in range(len(split_indices) - 1):
            a_idx, b_idx = split_indices[i], split_indices[i + 1]
            seg_nds = nds[a_idx : b_idx + 1]
            if len(seg_nds) < 2:
                continue
            if oneway_dir == -1:
                seg_nds = list(reversed(seg_nds))
            coords = [[round(float(nodes[nid]['lon']), 6), round(float(nodes[nid]['lat']), 6)] for nid in seg_nds]
            length_m = polyline_length_m(coords)
            if length_m < 10.0:
                continue

            from_nid = seg_nds[0]
            to_nid = seg_nds[-1]
            used_nodes[from_nid] = nodes[from_nid]
            used_nodes[to_nid] = nodes[to_nid]

            lower_name = name.lower()
            is_focus = any(k in lower_name for k in spec['focus_streets'])
            flood_cfg = spec['scenario_eligibility']['flood']
            demo_cfg = spec['scenario_eligibility']['demonstration']
            flood_eligible = bool(
                is_focus or hw in ('primary', 'secondary', 'tertiary', 'trunk')
                and (spec['id'] == 'pluit' or any(k in lower_name for k in flood_cfg['keywords']))
            )
            demo_eligible = bool(
                is_focus or hw in ('primary', 'secondary', 'trunk')
                and any(k in lower_name for k in demo_cfg['keywords'])
            )

            def add_edge(direction_coords: list[list[float]], f_id: int, t_id: int, suffix: str) -> None:
                nonlocal edge_counter
                edge_counter += 1
                eid = f"{spec['id']}-e{edge_counter:04d}"
                f_key = f"n-{f_id}"
                t_key = f"n-{t_id}"
                brg = round(bearing_deg(direction_coords[0][1], direction_coords[0][0], direction_coords[-1][1], direction_coords[-1][0]), 1)
                cap_vph = round(lanes * (1750 if 'primary' in hw or 'trunk' in hw or 'motorway' in hw else 1450 if 'secondary' in hw else 1150))
                edges.append({
                    'edge_id': eid,
                    'osm_way_id': w['id'],
                    'name': name,
                    'highway': hw,
                    'oneway': oneway_dir != 0,
                    'direction': suffix,
                    'from_node': f_key,
                    'to_node': t_key,
                    'lanes': lanes,
                    'speed_limit_kmh': speed_kmh,
                    'capacity_vph': cap_vph,
                    'length_m': round(length_m, 1),
                    'bearing_deg': brg,
                    'corridor_focus': is_focus,
                    'eligible': True,
                    'flood_eligible': flood_eligible,
                    'demonstration_eligible': demo_eligible,
                    'coordinates': direction_coords,
                })
                node_edges_out[f_key].append(eid)
                node_edges_in[t_key].append(eid)

            add_edge(coords, from_nid, to_nid, 'fwd')
            if oneway_dir == 0:
                add_edge(list(reversed(coords)), to_nid, from_nid, 'rev')

    # Build major intersections & signal control nodes.
    intersections: list[dict[str, Any]] = []
    movements: list[dict[str, Any]] = []
    mov_idx = 0
    for nid, nd in used_nodes.items():
        n_key = f"n-{nid}"
        inc = node_edges_in.get(n_key, [])
        out = node_edges_out.get(n_key, [])
        deg = len(set(inc) | set(out))
        is_sig = nid in signal_node_ids or (deg >= 4)
        if deg < 2 and nid not in signal_node_ids:
            continue
        if deg >= 3 or nid in signal_node_ids:
            ctrl_type = 'signalized' if is_sig else 'priority_junction'
            node_movs = []
            for ie in inc:
                for oe in out:
                    mov_idx += 1
                    m_id = f"{spec['id']}-m{mov_idx:04d}"
                    node_movs.append(m_id)
                    movements.append({
                        'movement_id': m_id,
                        'intersection_id': n_key,
                        'from_edge': ie,
                        'to_edge': oe,
                    })
            intersections.append({
                'node_id': n_key,
                'osm_node_id': nid,
                'lat': round(float(nd['lat']), 6),
                'lon': round(float(nd['lon']), 6),
                'degree': deg,
                'signalized': is_sig,
                'control_type': ctrl_type,
                'incoming_edges': inc,
                'outgoing_edges': out,
                'movement_count': len(node_movs),
            })

    # Water features (important for Pluit Sea View & Waduk Pluit).
    waterbodies: list[dict[str, Any]] = []
    for w in water_ways:
        nds = [nodes[nid] for nid in (w.get('nodes') or []) if nid in nodes]
        if len(nds) < 3:
            continue
        coords = [[round(float(n['lon']), 6), round(float(n['lat']), 6)] for n in nds]
        is_poly = coords[0] == coords[-1] and len(coords) >= 4
        tags = w.get('tags') or {}
        waterbodies.append({
            'osm_way_id': w['id'],
            'name': str(tags.get('name') or tags.get('water') or tags.get('waterway') or 'Water')[:60],
            'geometry_type': 'Polygon' if is_poly else 'LineString',
            'coordinates': [coords] if is_poly else coords,
        })

    # Deduplicate nearby OSM transit stops by (name, rounded lat/lon) + merge GTFS if supplied.
    gtfs_stops, gtfs_meta = ingest_gtfs_stops(gtfs_path, spec['bbox'])
    seen_stops: set[tuple[str, float, float]] = set()
    transit_stops: list[dict[str, Any]] = []
    for st in gtfs_stops + transit_nodes:
        key = (st['name'].lower()[:24], round(st['lat'], 4), round(st['lon'], 4))
        if key in seen_stops:
            continue
        seen_stops.add(key)
        transit_stops.append(st)

    # Compute study boundary & coverage mask from actual filtered road vertices.
    all_pts = [(c[0], c[1]) for e in edges for c in e['coordinates']]
    s, w_lon, n, e_lon = spec['bbox']
    study_ring = [[w_lon, s], [e_lon, s], [e_lon, n], [w_lon, n], [w_lon, s]]
    coverage_ring = expand_polygon(convex_hull(all_pts), pad_deg=0.0014) if len(all_pts) >= 3 else study_ring

    # Select representative default disruption anchors from real filtered edges (not invented coords).
    def pick_anchor(kind: str) -> dict[str, Any]:
        cfg = spec['scenario_eligibility'][kind]
        kws = cfg['default_anchor_keywords']
        candidates = [
            e for e in edges
            if e[f'{kind}_eligible'] and any(k in e['name'].lower() for k in kws)
        ] or [e for e in edges if e[f'{kind}_eligible']] or edges
        # Pick the longest or central candidate edge.
        chosen = max(candidates, key=lambda e: e['length_m'])
        mid = chosen['coordinates'][len(chosen['coordinates']) // 2]
        return {
            'edge_id': chosen['edge_id'],
            'road_name': chosen['name'],
            'lat': mid[1],
            'lon': mid[0],
            'default_sigma_m': cfg['default_radius_m'],
            'default_intensity': 0.78 if kind == 'flood' else 0.72,
            'provenance': 'synthetic_scenario_anchor_on_osm_edge',
            'note': cfg['note'],
        }

    disruption_anchors = {
        'flood': pick_anchor('flood'),
        'demonstration': pick_anchor('demonstration'),
    }

    region_payload = {
        'id': spec['id'],
        'name': spec['name'],
        'district': spec['district'],
        'subtitle': spec['subtitle'],
        'bbox': {'south': s, 'west': w_lon, 'north': n, 'east': e_lon},
        'center': spec['center'],
        'default_zoom': spec['default_zoom'],
        'primary_disruption': spec['primary_disruption'],
        'scenario_eligibility': spec['scenario_eligibility'],
        'disruption_anchors': disruption_anchors,
        'study_boundary': study_ring,
        'coverage_mask': coverage_ring,
        'landmarks': spec['landmarks'],
        'transit_stops': transit_stops[:80],
        'waterbodies': waterbodies[:40],
        'intersections': intersections,
        'movements': movements,
        'edges': edges,
        'stats': {
            'directed_edges': len(edges),
            'intersections': len(intersections),
            'signalized_intersections': sum(1 for i in intersections if i['signalized']),
            'movements': len(movements),
            'transit_stops': len(transit_stops[:80]),
            'flood_eligible_edges': sum(1 for e in edges if e['flood_eligible']),
            'demonstration_eligible_edges': sum(1 for e in edges if e['demonstration_eligible']),
        },
        'provenance': {
            'road_network': 'OpenStreetMap via Overpass API (filtered arterial/collector graph)',
            'transit_stops': 'OpenStreetMap' + (' + TransJakarta GTFS' if gtfs_meta['status'] == 'integrated' else ' (TransJakarta GTFS not present locally)'),
            'gtfs_status': gtfs_meta,
            'disruption_field': 'Synthetic Gaussian scenario modeling (not observed flood/demonstration sensor)',
            'crs': 'EPSG:4326 (WGS84)',
            'extracted_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        },
    }

    # Build RFC 7946 GeoJSON FeatureCollection.
    features: list[dict[str, Any]] = [
        {
            'type': 'Feature',
            'properties': {'layer': 'study_boundary', 'region_id': spec['id'], 'name': spec['name']},
            'geometry': {'type': 'Polygon', 'coordinates': [study_ring]},
        },
        {
            'type': 'Feature',
            'properties': {'layer': 'coverage_mask', 'region_id': spec['id'], 'eligible': True},
            'geometry': {'type': 'Polygon', 'coordinates': [coverage_ring]},
        },
    ]
    for wb in waterbodies[:40]:
        features.append({
            'type': 'Feature',
            'properties': {'layer': 'waterbody', 'name': wb['name'], 'osm_way_id': wb['osm_way_id']},
            'geometry': {'type': wb['geometry_type'], 'coordinates': wb['coordinates']},
        })
    for e in edges:
        features.append({
            'type': 'Feature',
            'properties': {
                'layer': 'road_edge',
                'edge_id': e['edge_id'],
                'osm_way_id': e['osm_way_id'],
                'name': e['name'],
                'highway': e['highway'],
                'oneway': e['oneway'],
                'lanes': e['lanes'],
                'speed_limit_kmh': e['speed_limit_kmh'],
                'capacity_vph': e['capacity_vph'],
                'length_m': e['length_m'],
                'from_node': e['from_node'],
                'to_node': e['to_node'],
                'flood_eligible': e['flood_eligible'],
                'demonstration_eligible': e['demonstration_eligible'],
            },
            'geometry': {'type': 'LineString', 'coordinates': e['coordinates']},
        })
    for inter in intersections:
        features.append({
            'type': 'Feature',
            'properties': {
                'layer': 'intersection',
                'node_id': inter['node_id'],
                'osm_node_id': inter['osm_node_id'],
                'degree': inter['degree'],
                'signalized': inter['signalized'],
                'control_type': inter['control_type'],
            },
            'geometry': {'type': 'Point', 'coordinates': [inter['lon'], inter['lat']]},
        })
    for st in transit_stops[:80]:
        features.append({
            'type': 'Feature',
            'properties': {
                'layer': 'transit_stop',
                'stop_id': st['stop_id'],
                'name': st['name'],
                'mode': st['mode'],
                'source': st['source'],
            },
            'geometry': {'type': 'Point', 'coordinates': [st['lon'], st['lat']]},
        })

    geojson_payload = {
        'type': 'FeatureCollection',
        'name': f"simpul_{spec['id']}_network",
        'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:OGC:1.3:CRS84'}},
        'features': features,
    }
    return region_payload, geojson_payload


CORRIDOR_CONNECTIONS_PATH = ROOT / 'data' / 'corridor_connections.json'


def _edge_node_coords(region: dict[str, Any]) -> dict[str, tuple[float, float]]:
    coords_map: dict[str, tuple[float, float]] = {}
    for e in region.get('edges', []):
        pts = e.get('coordinates') or []
        if len(pts) < 2:
            continue
        coords_map[e['from_node']] = (pts[0][1], pts[0][0])
        coords_map[e['to_node']] = (pts[-1][1], pts[-1][0])
    return coords_map


def compute_inter_area_connections(regions: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Verify and catalogue real-world OSM street connections between adjacent Pluit–Cilandak areas."""
    pairs_out: list[dict[str, Any]] = []
    by_region: dict[str, dict[str, Any]] = {
        rid: {'north': None, 'south': None}
        for rid in regions
    }

    for north_id, south_id in ADJACENT_CORRIDOR_PAIRS:
        if north_id not in regions or south_id not in regions:
            continue
        north_r = regions[north_id]
        south_r = regions[south_id]

        north_ways: dict[int, list[dict[str, Any]]] = defaultdict(list)
        south_ways: dict[int, list[dict[str, Any]]] = defaultdict(list)
        for e in north_r.get('edges', []):
            north_ways[int(e['osm_way_id'])].append(e)
        for e in south_r.get('edges', []):
            south_ways[int(e['osm_way_id'])].append(e)

        north_nodes = _edge_node_coords(north_r)
        south_nodes = _edge_node_coords(south_r)
        shared_node_ids = sorted(set(north_nodes.keys()) & set(south_nodes.keys()))
        shared_way_ids = sorted(set(north_ways.keys()) & set(south_ways.keys()))

        boundary_lat = (north_r['bbox']['south'] + south_r['bbox']['north']) / 2.0
        connectors: list[dict[str, Any]] = []
        seen_names: set[tuple[str, int]] = set()

        for wid in shared_way_ids:
            n_edges = north_ways[wid]
            s_edges = south_ways[wid]
            rep = n_edges[0]
            # Prefer a shared topological node on this way, else nearest vertex to boundary_lat.
            n_way_nodes = {e['from_node'] for e in n_edges} | {e['to_node'] for e in n_edges}
            s_way_nodes = {e['from_node'] for e in s_edges} | {e['to_node'] for e in s_edges}
            way_shared_nodes = sorted(n_way_nodes & s_way_nodes)
            if way_shared_nodes:
                nid = way_shared_nodes[0]
                lat, lon = north_nodes[nid]
            else:
                pts = [pt for e in n_edges for pt in e['coordinates']]
                best_pt = min(pts, key=lambda p: abs(p[1] - boundary_lat))
                lat, lon = best_pt[1], best_pt[0]

            key = (rep['name'], wid)
            if key in seen_names:
                continue
            seen_names.add(key)
            connectors.append({
                'osm_way_id': wid,
                'road_name': rep['name'],
                'highway': rep['highway'],
                'oneway': bool(rep['oneway']),
                'lat': round(lat, 6),
                'lon': round(lon, 6),
                'shared_node_ids': way_shared_nodes[:6],
                'north_edge_ids': [e['edge_id'] for e in n_edges[:4]],
                'south_edge_ids': [e['edge_id'] for e in s_edges[:4]],
            })

        # Sort connectors west-to-east with major highways first.
        hw_rank = {'motorway': 0, 'trunk': 1, 'primary': 2, 'secondary': 3, 'tertiary': 4}
        connectors.sort(key=lambda c: (hw_rank.get(c['highway'].replace('_link', ''), 5), c['lon']))

        pair_record = {
            'north_region_id': north_id,
            'north_region_name': north_r['name'],
            'south_region_id': south_id,
            'south_region_name': south_r['name'],
            'shared_osm_way_count': len(shared_way_ids),
            'shared_osm_node_count': len(shared_node_ids),
            'connected': len(shared_way_ids) > 0 and len(shared_node_ids) > 0,
            'connectors': connectors,
        }
        pairs_out.append(pair_record)

        unique_connectors: list[dict[str, Any]] = []
        seen_road_names: set[str] = set()
        for c in connectors:
            if c['road_name'] not in seen_road_names:
                seen_road_names.add(c['road_name'])
                unique_connectors.append(c)
        for c in connectors:
            if len(unique_connectors) >= 18:
                break
            if c not in unique_connectors:
                unique_connectors.append(c)

        unique_streets = [c['road_name'] for c in unique_connectors if '#' not in c['road_name']][:12]

        summary_for_north = {
            'neighbor_id': south_id,
            'neighbor_name': south_r['name'],
            'shared_osm_way_count': len(shared_way_ids),
            'shared_osm_node_count': len(shared_node_ids),
            'streets': unique_streets,
            'connectors': unique_connectors[:18],
        }
        summary_for_south = {
            'neighbor_id': north_id,
            'neighbor_name': north_r['name'],
            'shared_osm_way_count': len(shared_way_ids),
            'shared_osm_node_count': len(shared_node_ids),
            'streets': unique_streets,
            'connectors': unique_connectors[:18],
        }
        by_region[north_id]['south'] = summary_for_north
        by_region[south_id]['north'] = summary_for_south

    return {
        'corridor': 'Pluit to Cilandak (North-South Jakarta)',
        'region_order': [rid for rid in REGION_ORDER if rid in regions],
        'pairs': pairs_out,
        'by_region': by_region,
    }


def write_outputs(
    regions: dict[str, dict[str, Any]],
    geojsons: dict[str, dict[str, Any]],
    write_only_regions: set[str] | None = None,
) -> dict[str, Any]:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    now_iso = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

    ordered_regions = {
        rid: regions[rid]
        for rid in REGION_ORDER
        if rid in regions
    }
    for rid, r in regions.items():
        if rid not in ordered_regions:
            ordered_regions[rid] = r

    for rid, payload in ordered_regions.items():
        if write_only_regions is not None and rid not in write_only_regions:
            continue
        (DATA_DIR / f'{rid}.json').write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        (DATA_DIR / f'{rid}.geojson').write_text(json.dumps(geojsons[rid], ensure_ascii=False, indent=2), encoding='utf-8')

    corridor_connections = compute_inter_area_connections(ordered_regions)
    CORRIDOR_CONNECTIONS_PATH.write_text(
        json.dumps(corridor_connections, ensure_ascii=False, indent=2),
        encoding='utf-8',
    )

    manifest = {
        'schemaVersion': 1,
        'project': 'SIMPUL Jakarta Adaptive Traffic Network',
        'generatedAt': now_iso,
        'crs': 'EPSG:4326 (WGS84)',
        'datasets': {
            'osm_road_network': {
                'source': 'OpenStreetMap Overpass API',
                'license': 'ODbL 1.0 (© OpenStreetMap contributors)',
                'download_date': now_iso,
                'coverage': [r['name'] for r in ordered_regions.values()],
                'transformations': [
                    'Filtered to highway classes: ' + ', '.join(INCLUDED_HIGHWAY_CLASSES),
                    'Excluded alleys, residential access roads, footpaths, and building labels',
                    'Split ways at topological intersections preserving original node coordinates and oneway tags',
                    'Verified inter-area street continuity across adjacent bounding boxes using shared OSM way & node IDs',
                ],
                'classification': 'observed_geometry_derived_topology',
            },
            'transjakarta_gtfs': {
                'source': 'Official TransJakarta GTFS (optional local ingest via --gtfs-path)',
                'license': 'TransJakarta Open Data terms (when supplied locally)',
                'download_date': None,
                'status': next(iter(ordered_regions.values()))['provenance']['gtfs_status']['status'],
                'classification': 'missing_local_archive_fallback_to_osm_stops',
            },
            'grab_posisi_and_dkijakarta_sensors': {
                'source': 'Not integrated (files not present in workspace)',
                'status': 'not_integrated',
                'classification': 'unavailable',
            },
            'gaussian_disruption_and_traffic_flows': {
                'source': 'SIMPUL synthetic Gaussian spatial disruption model & mesoscopic/controller fixture',
                'license': 'Project internal research prototype',
                'classification': 'synthetic_scenario_modeling',
                'disclaimer': 'Gaussian impact and traffic-flow visualizations are synthetic research scenarios, not measured flood depth, observed protest intensity, or calibrated Jakarta demand.',
            },
        },
        'regions': {
            rid: {
                'name': r['name'],
                'bbox': r['bbox'],
                'stats': r['stats'],
                'geojson_file': f'data/regions/{rid}.geojson',
                'graph_file': f'data/regions/{rid}.json',
            }
            for rid, r in ordered_regions.items()
        },
        'corridor_connections_file': 'data/corridor_connections.json',
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')

    # Compact static ES module for zero-dependency browser & standalone bundle support.
    compact_js = (
        '// Generated by tools/extract_osm_networks.py from real OpenStreetMap geometry.\n'
        '// Provenance: OpenStreetMap (ODbL) geometry + derived topology; disruptions & flows are synthetic.\n'
        'export const ADAPTIVE_REGIONS_DATA = '
        + json.dumps(ordered_regions, ensure_ascii=False, separators=(',', ':'))
        + ';\n'
        'export const ADAPTIVE_PROVENANCE_MANIFEST = '
        + json.dumps(manifest, ensure_ascii=False, separators=(',', ':'))
        + ';\n'
        'export const ADAPTIVE_CORRIDOR_CONNECTIONS = '
        + json.dumps(corridor_connections, ensure_ascii=False, separators=(',', ':'))
        + ';\n'
    )
    JS_OUT_PATH.write_text(compact_js, encoding='utf-8')
    return corridor_connections


def main() -> int:
    parser = argparse.ArgumentParser(description='Extract filtered Jakarta OSM road networks for SIMPUL.')
    parser.add_argument('--regions', nargs='*', default=list(REGION_ORDER), choices=list(REGION_SPECS.keys()))
    parser.add_argument('--keep-existing', action='store_true', help='Load existing data/regions/*.json instead of re-fetching them')
    parser.add_argument('--gtfs-path', type=Path, default=None, help='Optional local TransJakarta GTFS zip or directory')
    args = parser.parse_args()

    regions: dict[str, dict[str, Any]] = {}
    geojsons: dict[str, dict[str, Any]] = {}
    fetched_ids: set[str] = set()

    for rid in REGION_ORDER:
        json_path = DATA_DIR / f'{rid}.json'
        geojson_path = DATA_DIR / f'{rid}.geojson'
        if rid not in args.regions:
            if json_path.is_file() and geojson_path.is_file():
                regions[rid] = json.loads(json_path.read_text(encoding='utf-8'))
                geojsons[rid] = json.loads(geojson_path.read_text(encoding='utf-8'))
            continue

        if args.keep_existing and json_path.is_file() and geojson_path.is_file():
            print(f'Keeping existing OSM dataset for {rid}')
            regions[rid] = json.loads(json_path.read_text(encoding='utf-8'))
            geojsons[rid] = json.loads(geojson_path.read_text(encoding='utf-8'))
            continue

        spec = REGION_SPECS[rid]
        print(f'Fetching OSM network for {spec["name"]} {spec["bbox"]} ...', flush=True)
        raw = fetch_overpass(spec['bbox'])
        region_data, geojson_data = build_region_dataset(spec, raw, gtfs_path=args.gtfs_path)
        regions[rid] = region_data
        geojsons[rid] = geojson_data
        fetched_ids.add(rid)
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        (DATA_DIR / f'{rid}.json').write_text(json.dumps(region_data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        (DATA_DIR / f'{rid}.geojson').write_text(json.dumps(geojson_data, ensure_ascii=False, indent=2), encoding='utf-8')
        print(
            f'  -> {rid}: {region_data["stats"]["directed_edges"]} directed edges, '
            f'{region_data["stats"]["intersections"]} intersections, '
            f'{region_data["stats"]["transit_stops"]} transit stops, '
            f'{len(region_data["waterbodies"])} water features',
            flush=True,
        )
        time.sleep(2.0)

    corridor_connections = write_outputs(regions, geojsons, write_only_regions=fetched_ids if args.keep_existing else None)
    for p in corridor_connections['pairs']:
        print(
            f'  Connection {p["north_region_id"]} <-> {p["south_region_id"]}: '
            f'{p["shared_osm_way_count"]} shared OSM ways, {p["shared_osm_node_count"]} shared OSM nodes'
        )
    print(f'Wrote {DATA_DIR}, {CORRIDOR_CONNECTIONS_PATH}, {MANIFEST_PATH}, and {JS_OUT_PATH}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
