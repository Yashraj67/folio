"""Password hashing and DB-backed session-cookie authentication."""
import hashlib
import secrets
from datetime import timedelta

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, VerifyMismatchError
from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from .. import config
from ..database import get_db
from ..models import AuthSession, User, ensure_utc, utcnow

_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, VerificationError):
        return False


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(db: Session, user: User) -> str:
    """Create a session row; only the hash is stored, the raw token goes in the cookie."""
    token = secrets.token_urlsafe(32)
    db.add(
        AuthSession(
            token_hash=_token_hash(token),
            user_id=user.id,
            expires_at=utcnow() + timedelta(days=config.SESSION_TTL_DAYS),
        )
    )
    db.commit()
    return token


def destroy_session(db: Session, token: str) -> None:
    db.query(AuthSession).filter(AuthSession.token_hash == _token_hash(token)).delete()
    db.commit()


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=config.COOKIE_NAME,
        value=token,
        max_age=config.SESSION_TTL_DAYS * 24 * 3600,
        httponly=True,
        samesite="lax",
        secure=config.COOKIE_SECURE,
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(config.COOKIE_NAME, path="/")


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    token = request.cookies.get(config.COOKIE_NAME)
    if not token:
        raise HTTPException(status_code=401, detail="Not signed in")
    session = (
        db.query(AuthSession).filter(AuthSession.token_hash == _token_hash(token)).one_or_none()
    )
    if session is None or ensure_utc(session.expires_at) < utcnow():
        if session is not None:
            db.delete(session)
            db.commit()
        raise HTTPException(status_code=401, detail="Session expired")
    # Rolling expiry: extend once the session is past half its lifetime.
    # Bulk UPDATE tolerates the row vanishing concurrently (e.g. logout in
    # another tab), where an ORM flush would raise StaleDataError → 500.
    half_life = timedelta(days=config.SESSION_TTL_DAYS / 2)
    if ensure_utc(session.expires_at) - utcnow() < half_life:
        try:
            db.query(AuthSession).filter(AuthSession.id == session.id).update(
                {"expires_at": utcnow() + timedelta(days=config.SESSION_TTL_DAYS)}
            )
            db.commit()
        except Exception:
            db.rollback()
    user = db.get(User, session.user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="Account no longer exists")
    return user
