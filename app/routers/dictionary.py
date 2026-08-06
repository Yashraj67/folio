from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import User
from ..services import dictionary
from ..services.auth import get_current_user

router = APIRouter(prefix="/dictionary", tags=["dictionary"])


@router.get("/{word}")
def define(
    word: str,
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    normalized = dictionary.normalize(word)
    if not dictionary.is_valid(normalized):
        raise HTTPException(status_code=400, detail="Not a look-up-able word")
    return dictionary.lookup(db, normalized)
