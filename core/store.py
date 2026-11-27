"""SQLite persistence: conversations, messages, and document metadata."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

from config import DB_PATH


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def connection():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    with connection() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS conversations (
                id          TEXT PRIMARY KEY,
                title       TEXT NOT NULL DEFAULT 'New chat',
                summary     TEXT NOT NULL DEFAULT '',
                pinned      INTEGER NOT NULL DEFAULT 0,
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS messages (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                role             TEXT NOT NULL,
                content          TEXT NOT NULL,
                sources          TEXT NOT NULL DEFAULT '[]',
                compacted        INTEGER NOT NULL DEFAULT 0,
                created_at       TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);

            CREATE TABLE IF NOT EXISTS documents (
                id             TEXT PRIMARY KEY,
                filename       TEXT NOT NULL,
                original_name  TEXT NOT NULL,
                kind           TEXT NOT NULL,
                pages          INTEGER NOT NULL DEFAULT 0,
                chunks         INTEGER NOT NULL DEFAULT 0,
                size_bytes     INTEGER NOT NULL DEFAULT 0,
                created_at     TEXT NOT NULL
            );
            """
        )
        # Lightweight migration for databases created before pinning existed.
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(conversations)")}
        if "pinned" not in columns:
            conn.execute(
                "ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0"
            )


# ── Conversations ─────────────────────────────────────────────────────────

def create_conversation(title: str = "New chat", conv_id: str | None = None) -> str:
    import uuid

    conv_id = conv_id or uuid.uuid4().hex
    stamp = now()
    with connection() as conn:
        conn.execute(
            "INSERT INTO conversations (id, title, summary, created_at, updated_at) VALUES (?,?,?,?,?)",
            (conv_id, title, "", stamp, stamp),
        )
    return conv_id


def list_conversations() -> list[dict]:
    with connection() as conn:
        rows = conn.execute(
            """
            SELECT c.id, c.title, c.pinned, c.created_at, c.updated_at,
                   COUNT(m.id) AS message_count
            FROM conversations c
            LEFT JOIN messages m ON m.conversation_id = c.id
            GROUP BY c.id
            ORDER BY c.pinned DESC, c.updated_at DESC
            """
        ).fetchall()
    return [dict(r) for r in rows]


def get_conversation(conv_id: str) -> dict | None:
    with connection() as conn:
        row = conn.execute("SELECT * FROM conversations WHERE id = ?", (conv_id,)).fetchone()
    return dict(row) if row else None


def rename_conversation(conv_id: str, title: str) -> None:
    with connection() as conn:
        conn.execute(
            "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?",
            (title.strip()[:120] or "New chat", now(), conv_id),
        )


def set_pinned(conv_id: str, pinned: bool) -> None:
    with connection() as conn:
        conn.execute(
            "UPDATE conversations SET pinned = ? WHERE id = ?",
            (1 if pinned else 0, conv_id),
        )


def touch_conversation(conv_id: str) -> None:
    with connection() as conn:
        conn.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now(), conv_id))


def delete_conversation(conv_id: str) -> None:
    with connection() as conn:
        conn.execute("DELETE FROM conversations WHERE id = ?", (conv_id,))


def set_summary(conv_id: str, summary: str) -> None:
    with connection() as conn:
        conn.execute("UPDATE conversations SET summary = ? WHERE id = ?", (summary, conv_id))


# ── Messages ──────────────────────────────────────────────────────────────

def add_message(
    conv_id: str,
    role: str,
    content: str,
    sources: list[dict] | None = None,
) -> int:
    with connection() as conn:
        cur = conn.execute(
            """
            INSERT INTO messages (conversation_id, role, content, sources, compacted, created_at)
            VALUES (?,?,?,?,0,?)
            """,
            (conv_id, role, content, json.dumps(sources or [], ensure_ascii=False), now()),
        )
        message_id = int(cur.lastrowid)
        conn.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now(), conv_id))
    return message_id


def get_messages(conv_id: str, limit: int | None = None) -> list[dict]:
    query = "SELECT * FROM messages WHERE conversation_id = ? ORDER BY id"
    params: list = [conv_id]
    if limit:
        query = "SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?"
        params.append(limit)
    with connection() as conn:
        rows = conn.execute(query, params).fetchall()
    messages = [_decode_message(r) for r in rows]
    if limit:
        messages.reverse()
    return messages


def get_uncompacted_messages(conv_id: str) -> list[dict]:
    with connection() as conn:
        rows = conn.execute(
            "SELECT * FROM messages WHERE conversation_id = ? AND compacted = 0 ORDER BY id",
            (conv_id,),
        ).fetchall()
    return [_decode_message(r) for r in rows]


def mark_compacted(message_ids: list[int]) -> None:
    if not message_ids:
        return
    placeholders = ",".join("?" for _ in message_ids)
    with connection() as conn:
        conn.execute(
            f"UPDATE messages SET compacted = 1 WHERE id IN ({placeholders})",
            message_ids,
        )


def delete_last_assistant_message(conv_id: str) -> None:
    with connection() as conn:
        row = conn.execute(
            "SELECT id FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1",
            (conv_id,),
        ).fetchone()
        if row:
            conn.execute("DELETE FROM messages WHERE id = ?", (row["id"],))


def _decode_message(row: sqlite3.Row) -> dict:
    data = dict(row)
    try:
        data["sources"] = json.loads(data.get("sources") or "[]")
    except (TypeError, ValueError):
        data["sources"] = []
    data["compacted"] = bool(data.get("compacted"))
    return data


# ── Documents ─────────────────────────────────────────────────────────────

def insert_document(
    doc_id: str,
    filename: str,
    original_name: str,
    kind: str,
    pages: int,
    chunks: int,
    size_bytes: int,
) -> None:
    with connection() as conn:
        conn.execute(
            """
            INSERT INTO documents (id, filename, original_name, kind, pages, chunks, size_bytes, created_at)
            VALUES (?,?,?,?,?,?,?,?)
            """,
            (doc_id, filename, original_name, kind, pages, chunks, size_bytes, now()),
        )


def list_documents() -> list[dict]:
    with connection() as conn:
        rows = conn.execute("SELECT * FROM documents ORDER BY created_at DESC").fetchall()
    return [dict(r) for r in rows]


def get_document(doc_id: str) -> dict | None:
    with connection() as conn:
        row = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
    return dict(row) if row else None


def delete_document(doc_id: str) -> dict | None:
    doc = get_document(doc_id)
    with connection() as conn:
        conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
    return doc


init_db()
