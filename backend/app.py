"""FastAPI application for the Jakarta Adaptive Traffic Network Visualization website."""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from backend.adaptive_api import router as adaptive_router

ROOT = Path(__file__).resolve().parent.parent
PUBLIC_DIR = ROOT / 'public'

app = FastAPI(
    title='Jakarta Adaptive Traffic Network API',
    version='2.0.0',
    description=(
        'Research prototype over OpenStreetMap road graphs (Tanah Abang, Cilandak, Pluit). '
        'Disruption fields and traffic flows are synthetic scenario models.'
    ),
)

app.include_router(adaptive_router)


@app.get('/api/health')
def health() -> dict[str, str]:
    return {'status': 'ok', 'service': 'Jakarta Adaptive Traffic Network API'}


@app.middleware('http')
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault('X-Content-Type-Options', 'nosniff')
    response.headers.setdefault('X-Frame-Options', 'DENY')
    response.headers.setdefault('Referrer-Policy', 'strict-origin-when-cross-origin')
    if request.url.path.startswith('/api/'):
        response.headers['Cache-Control'] = 'no-store'
    return response


if (PUBLIC_DIR / 'js').is_dir():
    app.mount('/js', StaticFiles(directory=PUBLIC_DIR / 'js'), name='js')
if (PUBLIC_DIR / 'data').is_dir():
    app.mount('/data', StaticFiles(directory=PUBLIC_DIR / 'data'), name='data')


@app.get('/')
def serve_index():
    index_path = PUBLIC_DIR / 'index.html'
    if index_path.is_file():
        return FileResponse(index_path)
    return JSONResponse({'service': 'Jakarta Adaptive Traffic Network API', 'docs': '/docs'})


@app.get('/styles.css')
def serve_css():
    css_path = PUBLIC_DIR / 'styles.css'
    if css_path.is_file():
        return FileResponse(css_path, media_type='text/css')
    return JSONResponse({'detail': 'styles.css not found'}, status_code=404)


if __name__ == '__main__':
    import uvicorn

    port = int(os.environ.get('PORT', '8000'))
    uvicorn.run(app, host=os.environ.get('HOST', '127.0.0.1'), port=port)
