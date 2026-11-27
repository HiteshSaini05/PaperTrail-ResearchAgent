"""Page-aware document extraction and chunking.

Every chunk keeps the page it came from so answers can cite `paper.pdf, p. 4`.
Plain text files use page 0, which the UI renders as a document-level reference.
"""

from __future__ import annotations

import re
from pathlib import Path

from pypdf import PdfReader

from config import CHUNK_OVERLAP, CHUNK_SIZE, MIN_CHUNK_CHARS

_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")


def _clean(text: str) -> str:
    text = text.replace("\x00", "")
    text = re.sub(r"[ \t\f\v]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_pdf(path: Path) -> list[str]:
    """Return one text string per PDF page (1-based order)."""
    reader = PdfReader(str(path))
    if reader.is_encrypted:
        try:
            reader.decrypt("")
        except Exception:
            pass

    pages: list[str] = []
    for page in reader.pages:
        try:
            text = page.extract_text() or ""
        except Exception:
            text = ""
        text = _clean(text)
        if text:
            pages.append(text)
    return pages


def extract_plaintext(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8", errors="replace")
    text = _clean(text)
    return [text] if text else []


def _window_split(text: str, size: int, overlap: int) -> list[str]:
    """Word-boundary splitting with a small trailing overlap."""
    words = text.split()
    chunks: list[str] = []
    current: list[str] = []
    length = 0

    for word in words:
        addition = len(word) + (1 if current else 0)
        if current and length + addition > size:
            chunks.append(" ".join(current))
            tail: list[str] = []
            tail_len = 0
            for previous in reversed(current):
                addition_tail = len(previous) + (1 if tail else 0)
                if tail_len + addition_tail > overlap:
                    break
                tail.insert(0, previous)
                tail_len += addition_tail
            current = tail
            length = sum(len(w) for w in current) + max(0, len(current) - 1)
        current.append(word)
        length += len(word) + (1 if len(current) > 1 else 0)

    if current:
        chunks.append(" ".join(current))
    return chunks


def _split_page(text: str) -> list[str]:
    """Split one page into bounded chunks while keeping paragraph breaks."""
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    pieces: list[str] = []
    for paragraph in paragraphs:
        flat = re.sub(r"\s*\n\s*", " ", paragraph)
        if len(flat) <= CHUNK_SIZE:
            pieces.append(flat)
        else:
            # Prefer sentence boundaries; fall back to word windows.
            sentences = [s.strip() for s in _SENTENCE_END.split(flat) if s.strip()]
            buffer = ""
            for sentence in sentences:
                candidate = f"{buffer} {sentence}".strip() if buffer else sentence
                if len(candidate) <= CHUNK_SIZE:
                    buffer = candidate
                else:
                    if buffer:
                        pieces.append(buffer)
                    if len(sentence) <= CHUNK_SIZE:
                        buffer = sentence
                    else:
                        pieces.extend(_window_split(sentence, CHUNK_SIZE, CHUNK_OVERLAP))
                        buffer = ""
            if buffer:
                pieces.append(buffer)

    # Merge very short pieces into their predecessor for denser context.
    merged: list[str] = []
    for piece in pieces:
        if merged and len(piece) < MIN_CHUNK_CHARS:
            candidate = f"{merged[-1]}\n\n{piece}"
            if len(candidate) <= CHUNK_SIZE + CHUNK_OVERLAP:
                merged[-1] = candidate
                continue
        merged.append(piece)
    return [piece for piece in merged if piece.strip()]


def chunk_pages(pages: list[str], page_start: int = 1) -> list[dict]:
    """Convert extracted pages into metadata-carrying chunks."""
    chunks: list[dict] = []
    for offset, text in enumerate(pages):
        page_label = page_start + offset
        for index, piece in enumerate(_split_page(text)):
            chunks.append(
                {
                    "text": piece,
                    "page": page_label,
                    "chunk": index,
                }
            )
    return chunks


def process_document(path: Path, original_name: str) -> dict:
    """Extract, chunk, and describe a single uploaded file."""
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        pages = extract_pdf(path)
        kind = "pdf"
    else:
        pages = extract_plaintext(path)
        kind = "text"

    if not pages or not any(page.strip() for page in pages):
        raise ValueError(
            "No readable text found. Image-only/scanned PDFs need OCR before upload."
        )

    chunks = chunk_pages(pages, page_start=1 if kind == "pdf" else 0)
    if not chunks:
        raise ValueError("The document did not produce any usable text chunks.")

    return {
        "kind": kind,
        "pages": len(pages) if kind == "pdf" else 0,
        "chunks": chunks,
        "preview": pages[0][:280],
        "name": original_name,
    }
