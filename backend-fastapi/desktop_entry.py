import os
from pathlib import Path

import uvicorn

from main import app


def _resolve_frontend_dist() -> str | None:
    explicit = os.environ.get('FRONTEND_DIST', '').strip()
    if explicit:
        return explicit
    current_dir = Path(__file__).resolve().parent
    candidate = current_dir.parent / 'frontend-client' / 'dist'
    if candidate.exists():
        return str(candidate)
    return None


if __name__ == '__main__':
    frontend_dist = _resolve_frontend_dist()
    if frontend_dist:
        os.environ['FRONTEND_DIST'] = frontend_dist

    host = os.environ.get('FASTAPI_HOST', '127.0.0.1')
    port = int(os.environ.get('PORT', os.environ.get('FASTAPI_PORT', 5001)))

    uvicorn.run(app, host=host, port=port, reload=False)
