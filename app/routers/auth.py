import json
import logging
import secrets

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import config
from ..database import get_db
from ..models import User
from ..schemas import CredentialsIn, SettingsIn, UserOut
from ..services import auth

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/auth", tags=["auth"])

# One Argon2 verify against this pad when the email is unknown keeps the
# known/unknown login paths at exactly one hash computation each.
_DUMMY_HASH = auth.hash_password(secrets.token_hex(16))


def _user_out(user: User) -> UserOut:
    try:
        settings = json.loads(user.settings or "{}")
    except ValueError:
        settings = {}
    return UserOut(id=user.id, email=user.email, settings=settings)


@router.post("/register", response_model=UserOut, status_code=201)
def register(body: CredentialsIn, response: Response, db: Session = Depends(get_db)):
    if not config.REGISTRATION_OPEN:
        raise HTTPException(status_code=403, detail="Registration is disabled")
    email = body.email.lower().strip()
    user = User(email=email, password_hash=auth.hash_password(body.password))
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="An account with this email already exists")
    db.refresh(user)
    auth.set_session_cookie(response, auth.create_session(db, user))
    return _user_out(user)


@router.post("/login", response_model=UserOut)
def login(body: CredentialsIn, response: Response, db: Session = Depends(get_db)):
    email = body.email.lower().strip()
    user = db.query(User).filter(User.email == email).one_or_none()
    # Verify against a precomputed dummy hash when the user is unknown so the
    # response time doesn't reveal which emails are registered.
    if user is None:
        auth.verify_password(_DUMMY_HASH, body.password)
        raise HTTPException(status_code=401, detail="Incorrect email or password")
    if not auth.verify_password(user.password_hash, body.password):
        raise HTTPException(status_code=401, detail="Incorrect email or password")
    auth.set_session_cookie(response, auth.create_session(db, user))
    return _user_out(user)


@router.post("/logout", status_code=204)
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    # Mutate the injected response and return None — returning a fresh
    # Response object would discard the Set-Cookie deletion header.
    auth.clear_session_cookie(response)
    token = request.cookies.get(config.COOKIE_NAME)
    if token:
        try:
            auth.destroy_session(db, token)
        except Exception:
            # The cookie deletion above still goes out; the orphaned session
            # row expires on its own.
            db.rollback()
            logger.exception("Failed to delete session row during logout")
    return None


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(auth.get_current_user)):
    return _user_out(user)


@router.put("/settings", status_code=204)
def save_settings(
    body: SettingsIn,
    user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    user.settings = json.dumps(body.settings)
    db.add(user)
    db.commit()
    return Response(status_code=204)
