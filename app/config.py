"""Central configuration. Everything is overridable via environment variables."""
import os
from pathlib import Path

DATA_DIR = Path(os.environ.get("FOLIO_DATA_DIR", "./data")).resolve()
BOOKS_DIR = DATA_DIR / "books"
COVERS_DIR = DATA_DIR / "covers"
DB_PATH = DATA_DIR / "folio.db"

# Postgres in production (docker-compose sets this); SQLite fallback for dev.
DATABASE_URL = os.environ.get("FOLIO_DATABASE_URL", f"sqlite:///{DB_PATH}")

STATIC_DIR = Path(
    os.environ.get("FOLIO_STATIC_DIR", Path(__file__).resolve().parent.parent / "static")
).resolve()

MAX_UPLOAD_BYTES = int(os.environ.get("FOLIO_MAX_UPLOAD_MB", "200")) * 1024 * 1024
COVER_WIDTH = 320

# Auth
SESSION_TTL_DAYS = int(os.environ.get("FOLIO_SESSION_TTL_DAYS", "30"))
COOKIE_NAME = "folio_session"
COOKIE_SECURE = os.environ.get("FOLIO_COOKIE_SECURE", "0") == "1"
REGISTRATION_OPEN = os.environ.get("FOLIO_REGISTRATION_OPEN", "1") == "1"

MEDIA_TYPES = {
    "epub": "application/epub+zip",
    "pdf": "application/pdf",
    "txt": "text/plain; charset=utf-8",
}


def ensure_dirs() -> None:
    for d in (DATA_DIR, BOOKS_DIR, COVERS_DIR):
        d.mkdir(parents=True, exist_ok=True)
