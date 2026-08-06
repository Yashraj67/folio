import hashlib
import json
import logging
import uuid
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import config
from ..database import get_db
from ..models import Book, BookFile, Progress, User, utcnow
from ..schemas import BookOut, LocationsIn
from ..services.auth import get_current_user
from ..services.metadata import detect_format, extract_metadata

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/books", tags=["books"])

CHUNK_SIZE = 1024 * 1024


def _to_out(book: Book) -> BookOut:
    bf = book.file
    return BookOut(
        id=book.id,
        title=book.title,
        author=book.author,
        format=bf.format,
        original_name=book.original_name,
        file_size=bf.file_size,
        page_count=bf.page_count,
        cover_url=f"/api/books/{book.id}/cover" if bf.cover_name else None,
        percentage=book.progress.percentage if book.progress else 0.0,
        location=book.progress.location if book.progress else "",
        added_at=book.added_at,
        last_opened_at=book.last_opened_at,
        highlight_count=len(book.highlights),
        bookmark_count=len(book.bookmarks),
    )


def _get_book(db: Session, user: User, book_id: int) -> Book:
    book = db.get(Book, book_id)
    if book is None or book.user_id != user.id:
        raise HTTPException(status_code=404, detail="Book not found")
    return book


@router.get("", response_model=list[BookOut])
def list_books(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    books = db.query(Book).filter(Book.user_id == user.id).all()
    books.sort(key=lambda b: (b.last_opened_at or b.added_at), reverse=True)
    return [_to_out(b) for b in books]


def _store_new_file(db: Session, temp: Path, digest: str, fmt: str, size: int, stem: str) -> BookFile:
    """Move the blob into place and stage (flush, not commit) its BookFile row."""
    stored_name = f"{digest}.{fmt}"
    dest = config.BOOKS_DIR / stored_name
    temp.replace(dest)
    meta = extract_metadata(dest, fmt, fallback_title=stem)
    book_file = BookFile(
        hash=digest,
        stored_name=stored_name,
        format=fmt,
        file_size=size,
        page_count=meta["page_count"],
        title=meta["title"],
        author=meta["author"],
        cover_name=meta["cover_name"],
        refcount=0,
    )
    db.add(book_file)
    db.flush()
    return book_file


@router.post("", response_model=BookOut, status_code=201)
def upload_book(
    file: UploadFile,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    original_name = Path(file.filename or "book").name
    head = file.file.read(8)
    file.file.seek(0)

    fmt = detect_format(original_name, head)
    if fmt is None:
        raise HTTPException(
            status_code=415,
            detail="Unsupported file. Only EPUB, PDF and TXT files are accepted.",
        )

    temp = config.BOOKS_DIR / f"upload-{uuid.uuid4().hex}.part"
    hasher = hashlib.sha256()
    size = 0
    try:
        with open(temp, "wb") as out:
            while chunk := file.file.read(CHUNK_SIZE):
                size += len(chunk)
                if size > config.MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"File exceeds {config.MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit.",
                    )
                hasher.update(chunk)
                out.write(chunk)
    except HTTPException:
        temp.unlink(missing_ok=True)
        raise
    except OSError:
        temp.unlink(missing_ok=True)
        logger.exception("Failed to store upload %s", original_name)
        raise HTTPException(status_code=500, detail="Failed to store the file.")

    digest = hasher.hexdigest()
    try:
        # Row-lock the shared BookFile for the whole transaction so concurrent
        # uploads/deletes of the same content serialize (Postgres; SQLite's
        # single-writer model plus the IntegrityError fallback covers it).
        book_file = (
            db.query(BookFile).filter(BookFile.hash == digest).with_for_update().one_or_none()
        )
        if book_file is None:
            book_file = _store_new_file(db, temp, digest, fmt, size, Path(original_name).stem)

        existing = (
            db.query(Book)
            .filter(Book.user_id == user.id, Book.file_hash == digest)
            .one_or_none()
        )
        if existing is not None:
            db.rollback()
            return _to_out(existing)

        book = Book(
            user_id=user.id,
            file_hash=digest,
            title=book_file.title or Path(original_name).stem,
            author=book_file.author,
            original_name=original_name,
        )
        book.progress = Progress(location="", percentage=0.0)
        book_file.refcount = BookFile.refcount + 1  # atomic SQL increment
        db.add(book)
        db.commit()
    except IntegrityError:
        # Lost a race on either the BookFile hash PK or the user's
        # (user_id, file_hash) unique constraint — the winner's rows stand.
        db.rollback()
        existing = (
            db.query(Book)
            .filter(Book.user_id == user.id, Book.file_hash == digest)
            .one_or_none()
        )
        if existing is not None:
            return _to_out(existing)
        raise HTTPException(
            status_code=409, detail="Upload conflicted with another request — please retry."
        )
    finally:
        temp.unlink(missing_ok=True)

    db.refresh(book)
    return _to_out(book)


@router.get("/{book_id}", response_model=BookOut)
def get_book(
    book_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return _to_out(_get_book(db, user, book_id))


@router.delete("/{book_id}", status_code=204)
def delete_book(
    book_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    book = _get_book(db, user, book_id)
    book_file = (
        db.query(BookFile).filter(BookFile.hash == book.file_hash).with_for_update().one()
    )
    db.delete(book)
    book_file.refcount = BookFile.refcount - 1  # atomic SQL decrement
    db.flush()
    db.refresh(book_file)
    if book_file.refcount <= 0:
        (config.BOOKS_DIR / book_file.stored_name).unlink(missing_ok=True)
        if book_file.cover_name:
            (config.COVERS_DIR / book_file.cover_name).unlink(missing_ok=True)
        db.delete(book_file)
    db.commit()
    return Response(status_code=204)


@router.get("/{book_id}/file")
def get_book_file(
    book_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    book = _get_book(db, user, book_id)
    path = config.BOOKS_DIR / book.file.stored_name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Book file missing on disk")
    book.last_opened_at = utcnow()
    db.commit()
    return FileResponse(
        path,
        media_type=config.MEDIA_TYPES.get(book.file.format, "application/octet-stream"),
        content_disposition_type="inline",
        filename=book.file.stored_name,
    )


@router.get("/{book_id}/cover")
def get_book_cover(
    book_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    book = _get_book(db, user, book_id)
    if not book.file.cover_name:
        raise HTTPException(status_code=404, detail="No cover")
    path = config.COVERS_DIR / book.file.cover_name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="No cover")
    return FileResponse(path, media_type="image/png")


@router.get("/{book_id}/locations")
def get_locations(
    book_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    book = _get_book(db, user, book_id)
    return {"locations": book.file.locations_cache}


@router.put("/{book_id}/locations", status_code=204)
def put_locations(
    book_id: int,
    body: LocationsIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # epub.js locations are deterministic per file, so the cache lives on the
    # shared BookFile — one user's generation benefits everyone. First writer
    # wins and the payload is validated, so no co-owner can poison the cache.
    book = _get_book(db, user, book_id)
    if book.file.locations_cache:
        return Response(status_code=204)
    try:
        parsed = json.loads(body.locations)
    except ValueError:
        raise HTTPException(status_code=422, detail="Locations must be valid JSON")
    if (
        not isinstance(parsed, list)
        or not parsed
        or not all(isinstance(item, str) for item in parsed)
    ):
        raise HTTPException(status_code=422, detail="Locations must be a list of CFI strings")
    book.file.locations_cache = body.locations
    db.commit()
    return Response(status_code=204)


@router.get("/{book_id}/export")
def export_annotations(
    book_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    book = _get_book(db, user, book_id)
    lines = [f"# {book.title}"]
    if book.author:
        lines.append(f"*by {book.author}*")
    lines.append("")

    if book.highlights:
        lines.append("## Highlights")
        lines.append("")
        for h in book.highlights:
            lines.append(f"> {h.text.strip()}" if h.text.strip() else "> *(no excerpt)*")
            meta = [h.color, h.created_at.strftime("%Y-%m-%d")]
            if h.note.strip():
                lines.append(f"\n**Note:** {h.note.strip()}")
            lines.append(f"\n<sub>{' · '.join(meta)}</sub>")
            lines.append("")

    if book.bookmarks:
        lines.append("## Bookmarks")
        lines.append("")
        for b in book.bookmarks:
            label = b.label.strip() or "(bookmark)"
            lines.append(f"- {label} <sub>{b.created_at.strftime('%Y-%m-%d')}</sub>")
        lines.append("")

    if not book.highlights and not book.bookmarks:
        lines.append("*No annotations yet.*")

    stem = "".join(c for c in book.title if c.isalnum() or c in " -_")[:60].strip() or "annotations"
    # Header values must be latin-1: send an ASCII filename plus RFC 5987
    # filename* so non-Latin titles neither crash nor get mangled.
    ascii_stem = stem.encode("ascii", "ignore").decode().strip() or "annotations"
    utf8_name = quote(f"{stem} - annotations.md")
    return Response(
        content="\n".join(lines),
        media_type="text/markdown; charset=utf-8",
        headers={
            "Content-Disposition": (
                f'attachment; filename="{ascii_stem} - annotations.md"; '
                f"filename*=UTF-8''{utf8_name}"
            )
        },
    )
