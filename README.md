# Jakarta Adaptive Traffic Network Visualization (`simpul-interactive`)

Interactive 3D traffic-flow and disruption simulator for three Jakarta study areas extracted from **OpenStreetMap**:

1. **Tanah Abang** — Stasiun Tanah Abang, Pasar Tanah Abang, Jl. Jatibaru, Jl. Fachrudin, Jl. KH Mas Mansyur
2. **Cilandak** — MRT Fatmawati, Jl. TB Simatupang, Jl. RS Fatmawati, Cilandak Town Square surroundings
3. **Pluit** — Jl. Muara Baru, Pluit Sea View, Waduk Pluit, Penjaringan (primary flood scenario)

Search covers the study areas, roads, stops, and landmarks in the bundled data. The
basemap streams OpenStreetMap-derived tiles from [OpenFreeMap](https://openfreemap.org/)
and uses a light street and water backdrop for the simulated network. The traffic and
disruption overlays use the simulator's synthetic data.

## Structure

- `public/` — Static ES-module frontend with MapLibre GL JS, an OpenFreeMap vector basemap, and a local 2D renderer fallback
- `backend/` — FastAPI domain logic, Gaussian spatial disruption model, mesoscopic network simulator, signal control, and MeshGraphNet turn routing
- `api/index.py` — Vercel serverless Python ASGI entrypoint
- `data/regions/` & `data/provenance_manifest.json` — Filtered OSM GeoJSON/graph files and provenance manifest
- `tools/extract_osm_networks.py` — Reproducible OSM Overpass + optional TransJakarta GTFS extraction script
- `vercel.json` — Vercel static + Python serverless routing configuration

## Run Locally

### Backend (FastAPI)

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn backend.app:app --reload --port 8000
```

Open `http://127.0.0.1:8000/` (serves both static frontend and `/api/*`).

### Frontend Dev Proxy (optional)

```bash
npm run dev
```

Serves `public/` at `http://127.0.0.1:5173/` and proxies `/api/*` to `http://127.0.0.1:8000`.

## Deploy to Vercel

This repository is pre-configured with [`vercel.json`](vercel.json), `public/`, `api/index.py`, and root `requirements.txt`:

```bash
npm i -g vercel
vercel
```

Or connect the Git repository in the Vercel dashboard and deploy directly with zero extra build settings.

## Tests

```bash
npm test
.venv/bin/python -m pytest -q tests/test_adaptive_api.py
```

## Provenance & Limitations

- Road geometry, intersections, waterbodies, and transit stops are extracted from **OpenStreetMap** (`ODbL 1.0`).
- Gaussian disruption fields, traffic volumes, and delay metrics are synthetic simulation outputs. A configured MeshGraphNet endpoint supplies scores for turn routing.

### MeshGraphNet turn control

B3 uses the same demand seed as the signal baselines. It redistributes simulated
traffic among legal outgoing links and records blocked or diverted turns per frame.
The graph heuristic runs by default and the replay labels it as a graph routing demo.

To connect trained MeshGraphNet inference, set `SIMPUL_MESHGRAPHNET_URL` on the
FastAPI server. The endpoint receives a JSON POST with `region_id`, `edges` (edge
telemetry keyed by edge ID), and `movements` (legal graph turns with their IDs and
from/to edges). Return `{"movement_scores":{"movement-id":0.8}}` with a score in
0–1 for every submitted turn. Closed downstream links stay excluded. If possible,
the routing policy retains at least one legal exit per incoming road. Invalid or
unavailable inference falls back to the graph heuristic.
