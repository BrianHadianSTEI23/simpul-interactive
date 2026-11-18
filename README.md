# Jakarta Adaptive Traffic Network Visualization (`simpul-interactive`)

Interactive 3D traffic-flow and disruption simulator for three Jakarta study areas extracted from **OpenStreetMap**:

1. **Tanah Abang** — Stasiun Tanah Abang, Pasar Tanah Abang, Jl. Jatibaru, Jl. Fachrudin, Jl. KH Mas Mansyur
2. **Cilandak** — MRT Fatmawati, Jl. TB Simatupang, Jl. RS Fatmawati, Cilandak Town Square surroundings
3. **Pluit** — Jl. Muara Baru, Pluit Sea View, Waduk Pluit, Penjaringan (primary flood scenario)

Search covers the study areas, roads, stops, and landmarks in the bundled data. The
basemap streams OpenStreetMap-derived tiles from [OpenFreeMap](https://openfreemap.org/)
and shows building heights where the vector data provides them. The traffic and
disruption overlays use the simulator's synthetic data.

## Structure

- `public/` — Static ES-module frontend with MapLibre GL JS, an OpenFreeMap vector basemap, and a local 2D renderer fallback
- `backend/` — FastAPI domain logic, Gaussian spatial disruption model, mesoscopic network simulator, and GNN-MAPPO model adapter
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
- Gaussian disruption fields (`w_e = exp(-d_e^2 / (2 * sigma^2))`), traffic flows, and `B3 GNN-MAPPO` outputs (`mock_development_adapter`) are **synthetic research fixtures** unless connected to calibrated SUMO runs (`data/precomputed_sumo/`) or an external trained policy service (`SIMPUL_GNN_MAPPO_URL`).
