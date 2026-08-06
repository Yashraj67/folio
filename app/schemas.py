from datetime import datetime, timezone
from typing import Annotated, Any, Optional

from pydantic import BaseModel, EmailStr, Field, PlainSerializer


def _utc_iso(v: datetime) -> str:
    """SQLite drops tzinfo; re-stamp UTC so JS Date parses the true instant."""
    if v.tzinfo is None:
        v = v.replace(tzinfo=timezone.utc)
    return v.isoformat().replace("+00:00", "Z")


UTCDateTime = Annotated[datetime, PlainSerializer(_utc_iso, return_type=str)]


class CredentialsIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class UserOut(BaseModel):
    id: int
    email: str
    settings: dict


class SettingsIn(BaseModel):
    settings: dict[str, Any] = Field(default_factory=dict)


class BookOut(BaseModel):
    id: int
    title: str
    author: str
    format: str
    original_name: str
    file_size: int
    page_count: Optional[int] = None
    cover_url: Optional[str] = None
    percentage: float = 0.0
    location: str = ""
    added_at: UTCDateTime
    last_opened_at: Optional[UTCDateTime] = None
    highlight_count: int = 0
    bookmark_count: int = 0


class ProgressIn(BaseModel):
    location: str = Field(default="", max_length=100_000)
    percentage: float = Field(default=0.0, ge=0.0, le=100.0)


class ProgressOut(BaseModel):
    location: str
    percentage: float
    updated_at: Optional[UTCDateTime] = None


class HighlightIn(BaseModel):
    location: str = Field(min_length=1, max_length=100_000)
    text: str = Field(default="", max_length=10_000)
    color: str = Field(default="yellow", pattern=r"^(yellow|green|blue|pink)$")
    note: str = Field(default="", max_length=10_000)


class HighlightPatch(BaseModel):
    color: Optional[str] = Field(default=None, pattern=r"^(yellow|green|blue|pink)$")
    note: Optional[str] = Field(default=None, max_length=10_000)


class HighlightOut(BaseModel):
    id: int
    book_id: int
    location: str
    text: str
    color: str
    note: str
    created_at: UTCDateTime

    model_config = {"from_attributes": True}


class BookmarkIn(BaseModel):
    location: str = Field(min_length=1, max_length=100_000)
    label: str = Field(default="", max_length=512)


class BookmarkOut(BaseModel):
    id: int
    book_id: int
    location: str
    label: str
    created_at: UTCDateTime

    model_config = {"from_attributes": True}


class LocationsIn(BaseModel):
    locations: str = Field(max_length=5_000_000)


class HeartbeatIn(BaseModel):
    book_id: int
    seconds: int = Field(ge=1, le=120)
    day: Optional[str] = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")


class DayStat(BaseModel):
    day: str
    seconds: int


class BookTimeStat(BaseModel):
    book_id: int
    title: str
    seconds: int


class StatsOut(BaseModel):
    total_books: int
    finished_books: int
    total_seconds: int
    today_seconds: int
    streak_days: int
    last_14_days: list[DayStat]
    top_books: list[BookTimeStat]
