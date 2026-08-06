FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    POETRY_VIRTUALENVS_CREATE=false \
    FOLIO_DATA_DIR=/data

WORKDIR /app

RUN pip install "poetry>=1.8,<3"

COPY pyproject.toml poetry.lock* ./
RUN poetry install --only main --no-interaction --no-ansi --no-root

COPY app ./app
COPY static ./static

VOLUME /data
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
