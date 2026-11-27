"""Conversation memory: anaphora-aware retrieval queries and rolling summaries."""

from __future__ import annotations

import re

from config import COMPACT_AFTER, KEEP_RECENT_AFTER_COMPACT, MAX_HISTORY_CHARS
from core import gemini, store

_ANAPHORA = re.compile(
    r"\b(it|this|that|these|those|they|them|its|their|above|previous|earlier|same|there)\b",
    re.IGNORECASE,
)
_CITATION = re.compile(r"\[S(\d+)\]", re.IGNORECASE)

SYSTEM_PROMPT = """You are a precise research assistant answering questions about the user's uploaded papers.

Rules:
1. Use ONLY the numbered source excerpts supplied in the current <sources> block. Never use outside knowledge.
2. The [S#] markers in <sources> are valid only for this answer. Any markers seen in <recent_conversation> or <earlier_conversation_summary> are historical — ignore them and choose markers again from the current <sources>.
3. Before writing a citation, check that the exact fact appears in that excerpt. Never default to [S1] and never carry a marker over from a previous answer just because it was cited before.
4. Cite every factual claim by placing its [S#] marker immediately after the sentence or clause it supports. Use several markers when several excerpts support the claim, e.g. [S2][S5]. Do not dump all citations at the end of the answer.
5. When a question spans several papers, compare them explicitly and cite the specific paper that supports each comparison. Do not favour a paper just because it appears first.
6. If the sources do not contain the answer, say exactly: "I couldn't find that in the provided papers." Do not guess, extrapolate, or invent citations.
7. Be clear and concise. Use Markdown formatting where it helps (**bold**, _italic_, headings, lists, tables) and write formulas in LaTeX with $...$ inline or $$...$$ on its own line. Skip phrases like "Based on the provided context".
8. Never repeat a source's full text; refer to it through its [S#] marker."""


def extract_citations(text: str) -> list[str]:
    """Return source IDs actually referenced in a model answer."""
    return sorted({f"S{int(number)}" for number in _CITATION.findall(text)})


def build_retrieval_query(question: str, previous_messages: list[dict]) -> str:
    """Resolve short follow-up questions so retrieval still finds the right pages."""
    query = question.strip()
    words = len(query.split())
    previous_question = next(
        (
            message["content"]
            for message in reversed(previous_messages)
            if message["role"] == "user"
        ),
        None,
    )
    if previous_question and (words <= 14 or _ANAPHORA.search(query)):
        return f"{query}\nPrevious question: {previous_question[:400]}"
    return query


def mentioned_document_ids(question: str) -> list[str]:
    """Detect explicit 'in paper X' references and narrow the search."""
    lowered = question.lower()
    matches: list[str] = []
    for document in store.list_documents():
        name = document["original_name"]
        stem = name.rsplit(".", 1)[0]
        if name.lower() in lowered or stem.lower() in lowered:
            matches.append(document["id"])
    return matches


def _format_history(messages: list[dict]) -> str:
    lines: list[str] = []
    total = 0
    for message in reversed(messages):
        if message["role"] not in {"user", "assistant"}:
            continue
        content = message["content"].strip().replace("\n", " ")
        content = _CITATION.sub("", content)
        if len(content) > 1500:
            content = content[:1500] + "…"
        total += len(content) + 24
        if total > MAX_HISTORY_CHARS:
            break
        label = "User" if message["role"] == "user" else "Assistant"
        lines.append(f"{label}: {content}")
    return "\n".join(reversed(lines))


def build_prompt(question: str, sources: list[dict], history: list[dict], summary: str) -> str:
    """Assemble a bounded prompt with sources, memory, and the new question."""
    source_blocks: list[str] = []
    for source in sources:
        source_blocks.append(
            f"[{source['id']}] {source['label']}\n{source['text']}"
        )
    context = "\n\n".join(source_blocks) if source_blocks else "(no sources available)"
    context += "\n\nThese markers are specific to this answer; re-evaluate them for the question below."

    pieces: list[str] = []
    if summary:
        pieces.append(f"<earlier_conversation_summary>\n{summary}\n</earlier_conversation_summary>")
    history_text = _format_history(history)
    if history_text:
        pieces.append(f"<recent_conversation>\n{history_text}\n</recent_conversation>")
    pieces.append(f"<sources>\n{context}\n</sources>")
    pieces.append(f"<question>\n{question.strip()}\n</question>")
    return "\n\n".join(pieces)


def maybe_compact(conversation_id: str) -> bool:
    """Summarize older turns once the un-compacted window grows too large.

    Called at the start of a turn: compaction never adds latency to the answer
    the user is currently waiting for.
    """
    uncompacted = store.get_uncompacted_messages(conversation_id)
    if len(uncompacted) <= COMPACT_AFTER:
        return False

    older = uncompacted[: -KEEP_RECENT_AFTER_COMPACT]
    transcript = "\n".join(
        f"{'User' if message['role'] == 'user' else 'Assistant'}: "
        f"{message['content'][:1200]}"
        for message in older
    )
    summary_prompt = f"""Compress the following conversation into a dense summary of at most 300 words.
Preserve the user's goals, key findings, conclusions, and numerical results, but remove all [S#] markers — they refer to old retrieval results and must not be reused.
Write short factual bullet points only. Do not answer any question in the transcript.

Conversation:
{transcript}"""

    try:
        addition = gemini.generate_text(
            summary_prompt,
            system="You compress conversations while preserving factual detail and source markers.",
            temperature=0.0,
            max_tokens=700,
        )
    except Exception:  # noqa: BLE001 - memory compression must never break chat
        addition = "\n".join(
            f"- {message['content'][:180]}"
            for message in older
            if message["role"] == "user"
        )

    conversation = store.get_conversation(conversation_id) or {}
    existing = (conversation.get("summary") or "").strip()
    merged = f"{existing}\n\n{addition}".strip() if existing else addition.strip()
    store.set_summary(conversation_id, merged[-6000:])
    store.mark_compacted([message["id"] for message in older])
    return True
