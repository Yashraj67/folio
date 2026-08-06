import logging
import mimetypes
from contextlib import asynccontextmanager
from urllib.parse import urlparse

from fastapi import FastAPI, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import config, models  # noqa: F401  (models must import so tables register)
from .database import Base, engine
from .routers import annotations, auth, books, dictionary, progress, stats

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

# Ensure ES modules are served with a JS content type on every platform.
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/javascript", ".js")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    config.ensure_dirs()
    Base.metadata.create_all(bind=engine)
    yield


app = FastAPI(title="Folio", version="2.0.0", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1024)


@app.middleware("http")
async def csrf_origin_guard(request: Request, call_next):
    # Session cookies are SameSite=Lax; additionally reject any state-changing
    # request whose Origin header disagrees with the Host we are serving.
    if request.method in ("POST", "PUT", "PATCH", "DELETE"):
        origin = request.headers.get("origin")
        if origin:
            host = request.headers.get("host", "")
            if urlparse(origin).netloc != host:
                return JSONResponse(
                    status_code=403, content={"detail": "Cross-origin request rejected"}
                )
    return await call_next(request)


@app.middleware("http")
async def reject_oversized_uploads(request: Request, call_next):
    # Starlette spools the whole multipart body to disk before the route's
    # own size check runs — reject obviously oversized requests up front.
    if request.method == "POST" and request.url.path == "/api/books":
        length = request.headers.get("content-length", "")
        if length.isdigit() and int(length) > config.MAX_UPLOAD_BYTES + 1_048_576:
            limit_mb = config.MAX_UPLOAD_BYTES // (1024 * 1024)
            return JSONResponse(
                status_code=413,
                content={"detail": f"File exceeds {limit_mb} MB limit."},
            )
    return await call_next(request)


for router in (
    auth.router,
    books.router,
    progress.router,
    annotations.router,
    dictionary.router,
    stats.router,
):
    app.include_router(router, prefix="/api")

app.mount("/static", StaticFiles(directory=config.STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(config.STATIC_DIR / "index.html")


@app.get("/healthz", include_in_schema=False)
def healthz():
    return {"status": "ok"}
