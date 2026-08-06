from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Book, Progress, User
from ..schemas import ProgressIn, ProgressOut
from ..services.auth import get_current_user

router = APIRouter(prefix="/books/{book_id}/progress", tags=["progress"])


def _get_book(db: Session, user: User, book_id: int) -> Book:
    book = db.get(Book, book_id)
    if book is None or book.user_id != user.id:
        raise HTTPException(status_code=404, detail="Book not found")
    return book


@router.get("", response_model=ProgressOut)
def get_progress(
    book_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    book = _get_book(db, user, book_id)
    if book.progress is None:
        return ProgressOut(location="", percentage=0.0)
    return ProgressOut(
        location=book.progress.location,
        percentage=book.progress.percentage,
        updated_at=book.progress.updated_at,
    )


@router.put("", status_code=204)
def put_progress(
    book_id: int,
    body: ProgressIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    book = _get_book(db, user, book_id)
    if book.progress is None:
        book.progress = Progress(book_id=book.id)
    book.progress.location = body.location
    book.progress.percentage = body.percentage
    db.commit()
    return Response(status_code=204)
