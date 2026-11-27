"""Central configuration for the research-paper agent."""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

DATA_DIR = BASE_DIR / "data"
UPLOAD_DIR = BASE_DIR / "uploads"
CHROMA_DIR = BASE_DIR / "chroma_db"

DB_PATH = DATA_DIR / "app.db"
COLLECTION_NAME = "research_papers_v1"

for _directory in (DATA_DIR, UPLOAD_DIR, CHROMA_DIR):
    _directory.mkdir(parents=True, exist_ok=True)

# ── Model ─────────────────────────────────────────────────────────────────
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()

def _model_candidates() -> list[str]:
    configured = os.getenv("GEMINI_MODEL", "").strip()
    defaults = [
        "gemini-3.5-flash-lite",
        "gemini-flash-lite-latest",
        "gemini-flash-latest",
        "gemini-3-flash-preview",
    ]
    return [configured] + [m for m in defaults if m != configured] if configured else defaults

MODEL_CANDIDATES = _model_candidates()

# ── Retrieval / chunking ──────────────────────────────────────────────────
CHUNK_SIZE = 950
CHUNK_OVERLAP = 130
MIN_CHUNK_CHARS = 120
RETRIEVAL_K = 8
RETRIEVAL_POOL = 30
MAX_PER_DOCUMENT = 3
MAX_PER_PAGE = 2
MAX_CONTEXT_CHARS = 14_000
MAX_SNIPPET_CHARS = 420

# ── Conversation memory ───────────────────────────────────────────────────
RECENT_MESSAGES = 8
COMPACT_AFTER = 10
KEEP_RECENT_AFTER_COMPACT = 5
MAX_HISTORY_CHARS = 6_000

ALLOWED_EXTENSIONS = {".pdf", ".txt", ".md", ".markdown"}
MAX_UPLOAD_BYTES = 40 * 1024 * 1024
