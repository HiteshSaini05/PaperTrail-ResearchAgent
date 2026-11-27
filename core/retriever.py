"""Chroma-backed retrieval with page/document metadata and source diversity."""

from __future__ import annotations

import math
import re
from collections import Counter
from urllib.parse import quote

import chromadb
from chromadb.utils import embedding_functions

from config import (
    CHROMA_DIR,
    COLLECTION_NAME,
    MAX_CONTEXT_CHARS,
    MAX_PER_DOCUMENT,
    MAX_PER_PAGE,
    MAX_SNIPPET_CHARS,
    RETRIEVAL_K,
    RETRIEVAL_POOL,
)

_client: chromadb.PersistentClient | None = None
_collection = None
_embedding_function = None

_STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "do", "for", "from",
    "how", "i", "in", "is", "it", "of", "on", "or", "that", "the", "their",
    "this", "to", "was", "we", "were", "what", "when", "where", "which",
    "who", "why", "with", "you", "your",
}


def get_collection():
    global _client, _collection, _embedding_function
    if _collection is None:
        _client = chromadb.PersistentClient(path=str(CHROMA_DIR))
        _embedding_function = embedding_functions.DefaultEmbeddingFunction()
        _collection = _client.get_or_create_collection(
            name=COLLECTION_NAME,
            embedding_function=_embedding_function,
            metadata={"hnsw:space": "cosine"},
        )
    return _collection


def add_document_chunks(doc_id: str, doc_name: str, chunks: list[dict], filename: str) -> int:
    """Upsert chunks in small batches with citation-ready metadata."""
    collection = get_collection()
    file_url = "/files/" + quote(filename)
    batch_size = 128

    for start in range(0, len(chunks), batch_size):
        batch = chunks[start : start + batch_size]
        ids: list[str] = []
        documents: list[str] = []
        metadatas: list[dict] = []
        for chunk in batch:
            page = int(chunk.get("page") or 0)
            ids.append(f"{doc_id}:{page}:{chunk['chunk']}")
            documents.append(chunk["text"])
            metadatas.append(
                {
                    "doc_id": doc_id,
                    "doc_name": doc_name,
                    "page": page,
                    "chunk": int(chunk["chunk"]),
                    "label": (
                        f"{doc_name} · p. {page}" if page else f"{doc_name} · document"
                    ),
                    "file_url": file_url,
                }
            )
        collection.upsert(ids=ids, documents=documents, metadatas=metadatas)
    return len(chunks)


def delete_document(doc_id: str) -> None:
    get_collection().delete(where={"doc_id": doc_id})


def _tokens(text: str) -> set[str]:
    return {
        token
        for token in re.findall(r"[a-z0-9]+", text.lower())
        if len(token) > 2 and token not in _STOPWORDS
    }


def search(
    query: str,
    k: int = RETRIEVAL_K,
    doc_ids: list[str] | None = None,
) -> list[dict]:
    """Retrieve diverse, reranked excerpts formatted as numbered sources."""
    collection = get_collection()
    if collection.count() == 0:
        return []

    where = None
    if doc_ids:
        unique_ids = list(dict.fromkeys(doc_ids))
        where = (
            {"doc_id": unique_ids[0]}
            if len(unique_ids) == 1
            else {"$or": [{"doc_id": doc_id} for doc_id in unique_ids]}
        )

    try:
        results = collection.query(
            query_texts=[query],
            n_results=min(RETRIEVAL_POOL, max(k * 3, k)),
            where=where,
            include=["documents", "metadatas", "distances"],
        )
    except Exception:
        # A metadata filter can fail for unusual names; retry without it.
        if where is None:
            raise
        results = collection.query(
            query_texts=[query],
            n_results=min(RETRIEVAL_POOL, max(k * 3, k)),
            include=["documents", "metadatas", "distances"],
        )

    documents = (results.get("documents") or [[]])[0]
    metadatas = (results.get("metadatas") or [[]])[0]
    distances = (results.get("distances") or [[]])[0]

    query_tokens = _tokens(query)
    phrases = [phrase.lower().strip() for phrase in re.findall(r'"([^"]+)"', query) if phrase.strip()]

    raw: list[tuple[str, dict, float, set[str]]] = []
    for text, meta, distance in zip(documents, metadatas, distances):
        if not text or not meta:
            continue
        haystack = f"{meta.get('doc_name', '')} {text[:4000]}"
        raw.append((text, meta, float(distance), _tokens(haystack)))

    document_frequency: Counter[str] = Counter()
    for _, _, _, tokens in raw:
        document_frequency.update(tokens)
    idf = {
        token: math.log(1 + len(raw) / (1 + document_frequency[token]))
        for token in query_tokens
    }
    idf_total = sum(idf.values()) or 1.0

    candidates: list[dict] = []
    for text, meta, distance, tokens in raw:
        overlap = tokens & query_tokens
        lexical = sum(idf[token] for token in overlap) / idf_total if query_tokens else 0.0
        lowered = text.lower()
        phrase_hits = sum(1 for phrase in phrases if phrase in lowered)
        semantic = 1.0 - distance
        score = semantic + 0.42 * lexical + 0.06 * min(len(overlap), 6) + 0.35 * phrase_hits
        candidates.append(
            {
                "text": text,
                "doc_id": str(meta.get("doc_id", "")),
                "doc_name": str(meta.get("doc_name", "Unknown")),
                "page": int(meta.get("page") or 0),
                "label": str(meta.get("label") or meta.get("doc_name", "Unknown")),
                "file_url": str(meta.get("file_url") or ""),
                "score": score,
            }
        )

    candidates.sort(key=lambda item: item["score"], reverse=True)

    selected: list[dict] = []
    per_doc: dict[str, int] = {}
    per_page: dict[tuple[str, int], int] = {}
    for candidate in candidates:
        doc_id = candidate["doc_id"]
        page_key = (doc_id, candidate["page"])
        if per_doc.get(doc_id, 0) >= MAX_PER_DOCUMENT:
            continue
        if per_page.get(page_key, 0) >= MAX_PER_PAGE:
            continue
        selected.append(candidate)
        per_doc[doc_id] = per_doc.get(doc_id, 0) + 1
        per_page[page_key] = per_page.get(page_key, 0) + 1
        if len(selected) >= k:
            break

    sources: list[dict] = []
    total_chars = 0
    for index, item in enumerate(selected, start=1):
        snippet = item["text"][:MAX_SNIPPET_CHARS].strip()
        if len(item["text"]) > MAX_SNIPPET_CHARS:
            snippet += "…"
        sources.append(
            {
                "id": f"S{index}",
                "doc_id": item["doc_id"],
                "doc_name": item["doc_name"],
                "page": item["page"],
                "label": item["label"],
                "file_url": item["file_url"],
                "snippet": snippet,
                "text": item["text"],
            }
        )
        total_chars += len(item["text"])
        if total_chars >= MAX_CONTEXT_CHARS:
            break
    return sources


def count_chunks() -> int:
    return get_collection().count()
