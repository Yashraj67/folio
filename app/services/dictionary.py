"""Dictionary lookup: dictionaryapi.dev with a Wiktionary fallback, cached in SQLite."""
import html
import json
import logging
import re

import httpx
from sqlalchemy.orm import Session

from ..models import DictionaryEntry

logger = logging.getLogger(__name__)

PRIMARY_URL = "https://api.dictionaryapi.dev/api/v2/entries/en/{word}"
FALLBACK_URL = "https://en.wiktionary.org/api/rest_v1/page/definition/{word}"
WORD_RE = re.compile(r"^[a-zA-Z][a-zA-Z'-]{0,48}$")
# Wikimedia's API policy 403s generic client UAs — identify ourselves.
USER_AGENT = "Folio/1.0 (self-hosted personal book reader)"
_STRIP_CHARS = ".,;:!?\"()[]{}<>«»…—–_*/\\|`~@#$%^&+=‘’“” "
_TAG_RE = re.compile(r"<[^>]+>")


def normalize(raw: str) -> str:
    return raw.strip(_STRIP_CHARS).replace("’", "'").lower()


def is_valid(word: str) -> bool:
    return bool(WORD_RE.match(word))


def lookup(db: Session, word: str) -> dict:
    cached = db.get(DictionaryEntry, word)
    if cached is not None:
        return json.loads(cached.payload)

    with httpx.Client(
        timeout=8.0, follow_redirects=True, headers={"User-Agent": USER_AGENT}
    ) as client:
        status, payload = _fetch_primary(client, word)
        if status != "ok":
            fb_status, fb_payload = _fetch_wiktionary(client, word)
            if fb_status == "ok":
                payload = fb_payload
            elif "notfound" in (status, fb_status):
                payload = {"word": word, "found": False}
            else:
                # Both sources unreachable — report but never cache the outage.
                return {"word": word, "found": False, "error": "offline"}

    db.merge(DictionaryEntry(word=word, payload=json.dumps(payload)))
    db.commit()
    return payload


def _fetch_primary(client: httpx.Client, word: str):
    try:
        resp = client.get(PRIMARY_URL.format(word=word))
    except httpx.HTTPError:
        return "error", None
    if resp.status_code == 404:
        return "notfound", None
    if resp.status_code != 200:
        return "error", None
    try:
        return "ok", _simplify_primary(word, resp.json())
    except (ValueError, KeyError, TypeError):
        return "error", None


def _fetch_wiktionary(client: httpx.Client, word: str):
    try:
        resp = client.get(FALLBACK_URL.format(word=word))
    except httpx.HTTPError:
        return "error", None
    if resp.status_code == 404:
        return "notfound", None
    if resp.status_code != 200:
        return "error", None
    try:
        return "ok", _simplify_wiktionary(word, resp.json())
    except (ValueError, KeyError, TypeError, AttributeError):
        return "error", None


def _simplify_primary(word: str, entries: list) -> dict:
    phonetic = ""
    audio = ""
    meanings = []
    for entry in entries:
        if not phonetic:
            phonetic = entry.get("phonetic") or next(
                (p.get("text", "") for p in entry.get("phonetics", []) if p.get("text")),
                "",
            )
        if not audio:
            audio = next(
                (p.get("audio", "") for p in entry.get("phonetics", []) if p.get("audio")),
                "",
            )
        for meaning in entry.get("meanings", []):
            definitions = [
                {"definition": d.get("definition", ""), "example": d.get("example", "")}
                for d in meaning.get("definitions", [])[:4]
            ]
            synonyms = [s for s in meaning.get("synonyms", [])[:6] if isinstance(s, str)]
            if definitions:
                meanings.append(
                    {
                        "partOfSpeech": meaning.get("partOfSpeech", ""),
                        "definitions": definitions,
                        "synonyms": synonyms,
                    }
                )
    return {
        "word": word,
        "found": bool(meanings),
        "phonetic": phonetic,
        "audio": audio,
        "meanings": meanings[:6],
    }


def _strip_html(s: str) -> str:
    return html.unescape(_TAG_RE.sub("", s or "")).strip()


def _simplify_wiktionary(word: str, data: dict) -> dict:
    meanings = []
    for entry in data.get("en", []):
        definitions = []
        for d in entry.get("definitions", [])[:4]:
            text = _strip_html(d.get("definition", ""))
            if not text:
                continue
            examples = d.get("parsedExamples") or []
            example = _strip_html(examples[0].get("example", "")) if examples else ""
            definitions.append({"definition": text, "example": example})
        if definitions:
            meanings.append(
                {
                    "partOfSpeech": (entry.get("partOfSpeech") or "").lower(),
                    "definitions": definitions,
                    "synonyms": [],
                }
            )
    return {
        "word": word,
        "found": bool(meanings),
        "phonetic": "",
        "audio": "",
        "meanings": meanings[:6],
    }
