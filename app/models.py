from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def ensure_utc(dt: datetime) -> datetime:
    """SQLite returns naive datetimes; re-stamp UTC so comparisons work."""
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(256))
    settings: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    books = relationship("Book", cascade="all, delete-orphan", back_populates="user")
    sessions = relationship("AuthSession", cascade="all, delete-orphan", back_populates="user")


class AuthSession(Base):
    __tablename__ = "auth_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    user = relationship("User", back_populates="sessions")


class BookFile(Base):
    """Content-addressed storage: one row/blob per distinct file, shared by users."""

    __tablename__ = "book_files"

    hash: Mapped[str] = mapped_column(String(64), primary_key=True)  # sha256 hex
    stored_name: Mapped[str] = mapped_column(String(80), unique=True)
    format: Mapped[str] = mapped_column(String(8))
    file_size: Mapped[int] = mapped_column(Integer, default=0)
    page_count: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    title: Mapped[str] = mapped_column(String(512), default="")  # extracted defaults
    author: Mapped[str] = mapped_column(String(512), default="")
    cover_name: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    locations_cache: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    refcount: Mapped[int] = mapped_column(Integer, default=0)

    books = relationship("Book", back_populates="file")


class Book(Base):
    """A user's library entry pointing at a (possibly shared) BookFile."""

    __tablename__ = "books"
    __table_args__ = (UniqueConstraint("user_id", "file_hash"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    file_hash: Mapped[str] = mapped_column(ForeignKey("book_files.hash"), index=True)
    title: Mapped[str] = mapped_column(String(512))
    author: Mapped[str] = mapped_column(String(512), default="")
    original_name: Mapped[str] = mapped_column(String(512), default="")
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_opened_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    user = relationship("User", back_populates="books")
    file = relationship("BookFile", back_populates="books")
    progress = relationship(
        "Progress", uselist=False, cascade="all, delete-orphan", back_populates="book"
    )
    highlights = relationship(
        "Highlight", cascade="all, delete-orphan", back_populates="book",
        order_by="Highlight.created_at",
    )
    bookmarks = relationship(
        "Bookmark", cascade="all, delete-orphan", back_populates="book",
        order_by="Bookmark.created_at",
    )


class Progress(Base):
    __tablename__ = "progress"

    book_id: Mapped[int] = mapped_column(
        ForeignKey("books.id", ondelete="CASCADE"), primary_key=True
    )
    location: Mapped[str] = mapped_column(Text, default="")
    percentage: Mapped[float] = mapped_column(Float, default=0.0)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

    book = relationship("Book", back_populates="progress")


class Highlight(Base):
    __tablename__ = "highlights"

    id: Mapped[int] = mapped_column(primary_key=True)
    book_id: Mapped[int] = mapped_column(
        ForeignKey("books.id", ondelete="CASCADE"), index=True
    )
    location: Mapped[str] = mapped_column(Text)
    text: Mapped[str] = mapped_column(Text, default="")
    color: Mapped[str] = mapped_column(String(16), default="yellow")
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    book = relationship("Book", back_populates="highlights")


class Bookmark(Base):
    __tablename__ = "bookmarks"

    id: Mapped[int] = mapped_column(primary_key=True)
    book_id: Mapped[int] = mapped_column(
        ForeignKey("books.id", ondelete="CASCADE"), index=True
    )
    location: Mapped[str] = mapped_column(Text)
    label: Mapped[str] = mapped_column(String(512), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    book = relationship("Book", back_populates="bookmarks")


class DictionaryEntry(Base):
    """Global lookup cache — shared across users by design."""

    __tablename__ = "dictionary_cache"

    word: Mapped[str] = mapped_column(String(64), primary_key=True)
    payload: Mapped[str] = mapped_column(Text)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ReadingStat(Base):
    __tablename__ = "reading_stats"
    __table_args__ = (UniqueConstraint("book_id", "day"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    book_id: Mapped[int] = mapped_column(
        ForeignKey("books.id", ondelete="CASCADE"), index=True
    )
    day: Mapped[str] = mapped_column(String(10))  # YYYY-MM-DD (client-local)
    seconds: Mapped[int] = mapped_column(Integer, default=0)
