from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Book, Bookmark, Highlight, User
from ..schemas import BookmarkIn, BookmarkOut, HighlightIn, HighlightOut, HighlightPatch
from ..services.auth import get_current_user

router = APIRouter(tags=["annotations"])


def _get_book(db: Session, user: User, book_id: int) -> Book:
    book = db.get(Book, book_id)
    if book is None or book.user_id != user.id:
        raise HTTPException(status_code=404, detail="Book not found")
    return book


def _get_owned_highlight(db: Session, user: User, highlight_id: int) -> Highlight:
    highlight = (
        db.query(Highlight)
        .join(Book, Book.id == Highlight.book_id)
        .filter(Highlight.id == highlight_id, Book.user_id == user.id)
        .one_or_none()
    )
    if highlight is None:
        raise HTTPException(status_code=404, detail="Highlight not found")
    return highlight


def _get_owned_bookmark(db: Session, user: User, bookmark_id: int) -> Bookmark:
    bookmark = (
        db.query(Bookmark)
        .join(Book, Book.id == Bookmark.book_id)
        .filter(Bookmark.id == bookmark_id, Book.user_id == user.id)
        .one_or_none()
    )
    if bookmark is None:
        raise HTTPException(status_code=404, detail="Bookmark not found")
    return bookmark


# ---------------------------------------------------------------- highlights

@router.get("/books/{book_id}/highlights", response_model=list[HighlightOut])
def list_highlights(
    book_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return _get_book(db, user, book_id).highlights


@router.post("/books/{book_id}/highlights", response_model=HighlightOut, status_code=201)
def create_highlight(
    book_id: int,
    body: HighlightIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    book = _get_book(db, user, book_id)
    highlight = Highlight(
        book_id=book.id,
        location=body.location,
        text=body.text,
        color=body.color,
        note=body.note,
    )
    db.add(highlight)
    db.commit()
    db.refresh(highlight)
    return highlight


@router.patch("/highlights/{highlight_id}", response_model=HighlightOut)
def update_highlight(
    highlight_id: int,
    body: HighlightPatch,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    highlight = _get_owned_highlight(db, user, highlight_id)
    if body.color is not None:
        highlight.color = body.color
    if body.note is not None:
        highlight.note = body.note
    db.commit()
    db.refresh(highlight)
    return highlight


@router.delete("/highlights/{highlight_id}", status_code=204)
def delete_highlight(
    highlight_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    highlight = _get_owned_highlight(db, user, highlight_id)
    db.delete(highlight)
    db.commit()
    return Response(status_code=204)


# ----------------------------------------------------------------- bookmarks

@router.get("/books/{book_id}/bookmarks", response_model=list[BookmarkOut])
def list_bookmarks(
    book_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return _get_book(db, user, book_id).bookmarks


@router.post("/books/{book_id}/bookmarks", response_model=BookmarkOut, status_code=201)
def create_bookmark(
    book_id: int,
    body: BookmarkIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    book = _get_book(db, user, book_id)
    bookmark = Bookmark(book_id=book.id, location=body.location, label=body.label)
    db.add(bookmark)
    db.commit()
    db.refresh(bookmark)
    return bookmark


@router.delete("/bookmarks/{bookmark_id}", status_code=204)
def delete_bookmark(
    bookmark_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    bookmark = _get_owned_bookmark(db, user, bookmark_id)
    db.delete(bookmark)
    db.commit()
    return Response(status_code=204)
