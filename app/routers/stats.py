from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..database import IS_SQLITE, get_db
from ..models import Book, Progress, ReadingStat, User
from ..schemas import BookTimeStat, DayStat, HeartbeatIn, StatsOut
from ..services.auth import get_current_user

if IS_SQLITE:
    from sqlalchemy.dialects.sqlite import insert as upsert_insert
else:
    from sqlalchemy.dialects.postgresql import insert as upsert_insert

router = APIRouter(prefix="/stats", tags=["stats"])

FINISHED_THRESHOLD = 98.0


def _resolve_day(day: Optional[str]) -> date:
    """Prefer the client's local calendar day; fall back to the server's."""
    if day:
        try:
            return date.fromisoformat(day)
        except ValueError:
            pass
    return date.today()


@router.post("/heartbeat", status_code=204)
def heartbeat(
    body: HeartbeatIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    book = db.get(Book, body.book_id)
    if book is None or book.user_id != user.id:
        raise HTTPException(status_code=404, detail="Book not found")
    # Atomic upsert: concurrent heartbeats (two tabs/devices) must neither
    # violate the (book_id, day) unique constraint nor lose an increment.
    stmt = upsert_insert(ReadingStat).values(
        book_id=body.book_id, day=_resolve_day(body.day).isoformat(), seconds=body.seconds
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=["book_id", "day"],
        set_={"seconds": ReadingStat.seconds + stmt.excluded.seconds},
    )
    db.execute(stmt)
    db.commit()
    return Response(status_code=204)


@router.get("", response_model=StatsOut)
def get_stats(
    today_param: Optional[str] = Query(default=None, alias="today", max_length=10),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    total_books = (
        db.query(func.count(Book.id)).filter(Book.user_id == user.id).scalar() or 0
    )
    finished_books = (
        db.query(func.count(Progress.book_id))
        .join(Book, Book.id == Progress.book_id)
        .filter(Book.user_id == user.id, Progress.percentage >= FINISHED_THRESHOLD)
        .scalar()
        or 0
    )

    user_stats = (
        db.query(ReadingStat.day, func.sum(ReadingStat.seconds))
        .join(Book, Book.id == ReadingStat.book_id)
        .filter(Book.user_id == user.id)
        .group_by(ReadingStat.day)
    )
    day_rows = dict(user_stats.all())
    total_seconds = sum(int(v or 0) for v in day_rows.values())

    today = _resolve_day(today_param)
    today_seconds = int(day_rows.get(today.isoformat(), 0))

    # Streak: consecutive active days ending today (or yesterday, so an
    # unstarted morning doesn't zero it out).
    streak = 0
    cursor = today
    if not day_rows.get(cursor.isoformat()):
        cursor = today - timedelta(days=1)
    while day_rows.get(cursor.isoformat()):
        streak += 1
        cursor -= timedelta(days=1)

    last_14 = [
        DayStat(
            day=(today - timedelta(days=offset)).isoformat(),
            seconds=int(day_rows.get((today - timedelta(days=offset)).isoformat(), 0)),
        )
        for offset in range(13, -1, -1)
    ]

    top_rows = (
        db.query(Book.id, Book.title, func.sum(ReadingStat.seconds).label("secs"))
        .join(ReadingStat, ReadingStat.book_id == Book.id)
        .filter(Book.user_id == user.id)
        .group_by(Book.id, Book.title)
        .order_by(func.sum(ReadingStat.seconds).desc())
        .limit(5)
        .all()
    )
    top_books = [
        BookTimeStat(book_id=r[0], title=r[1], seconds=int(r[2] or 0)) for r in top_rows
    ]

    return StatsOut(
        total_books=total_books,
        finished_books=finished_books,
        total_seconds=total_seconds,
        today_seconds=today_seconds,
        streak_days=streak,
        last_14_days=last_14,
        top_books=top_books,
    )
