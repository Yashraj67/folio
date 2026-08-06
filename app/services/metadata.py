"""Book format detection, metadata and cover extraction (via PyMuPDF)."""
import logging
from pathlib import Path
from typing import Optional

import fitz  # PyMuPDF

from ..config import COVER_WIDTH, COVERS_DIR

logger = logging.getLogger(__name__)


def detect_format(filename: str, head: bytes) -> Optional[str]:
    """Sniff the real format from magic bytes; fall back to extension for txt."""
    ext = Path(filename).suffix.lower().lstrip(".")
    if head.startswith(b"%PDF-"):
        return "pdf"
    if head.startswith(b"PK\x03\x04") and ext == "epub":
        return "epub"
    if ext == "txt" and b"\x00" not in head:
        return "txt"
    return None


def extract_metadata(path: Path, fmt: str, fallback_title: str) -> dict:
    """Return {title, author, page_count, cover_name}. Never raises."""
    result = {
        "title": fallback_title,
        "author": "",
        "page_count": None,
        "cover_name": None,
    }
    if fmt == "txt":
        return result

    try:
        doc = fitz.open(str(path), filetype=fmt)
    except Exception:
        logger.warning("Could not open %s for metadata extraction", path.name)
        return result

    try:
        meta = doc.metadata or {}
        title = (meta.get("title") or "").strip()
        author = (meta.get("author") or "").strip()
        if title:
            result["title"] = title[:512]
        if author:
            result["author"] = author[:512]
        if fmt == "pdf":
            result["page_count"] = doc.page_count

        result["cover_name"] = _render_cover(doc, path.stem)
    except Exception:
        logger.warning("Metadata extraction failed for %s", path.name, exc_info=True)
    finally:
        doc.close()
    return result


def _render_cover(doc: "fitz.Document", stem: str) -> Optional[str]:
    try:
        page = doc.load_page(0)
        if page.rect.width <= 0:
            return None
        zoom = COVER_WIDTH / page.rect.width
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
        cover_name = f"{stem}.png"
        pix.save(str(COVERS_DIR / cover_name))
        return cover_name
    except Exception:
        logger.warning("Cover render failed for %s", stem, exc_info=True)
        return None
