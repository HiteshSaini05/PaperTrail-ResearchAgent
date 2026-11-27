"""Flask API + UI for the multi-paper research agent."""

from __future__ import annotations

import json
import re
import uuid
from pathlib import Path

from flask import (
    Flask,
    Response,
    jsonify,
    render_template,
    request,
    send_from_directory,
    stream_with_context,
)
from werkzeug.exceptions import RequestEntityTooLarge

from config import (
    ALLOWED_EXTENSIONS,
    MAX_UPLOAD_BYTES,
    RECENT_MESSAGES,
    UPLOAD_DIR,
)
from core import gemini, memory, retriever, store
from core.ingestor import process_document

app = Flask(__name__, static_folder="static", template_folder="templates")
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES * 5


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/health")
def health():
    return jsonify(
        {
            "ok": True,
            "model_ready": gemini.available(),
            "papers": len(store.list_documents()),
        }
    )


# ── Conversations ─────────────────────────────────────────────────────────

@app.get("/api/conversations")
def conversations_list():
    return jsonify({"conversations": store.list_conversations()})


@app.post("/api/conversations")
def conversations_create():
    payload = request.get_json(silent=True) or {}
    title = (payload.get("title") or "New chat").strip()[:120]
    conv_id = store.create_conversation(title or "New chat")
    return jsonify({"id": conv_id, "title": title or "New chat"}), 201


@app.route("/api/conversations/<conv_id>", methods=["GET", "PATCH", "DELETE"])
def conversation_detail(conv_id: str):
    conversation = store.get_conversation(conv_id)
    if not conversation:
        return jsonify({"error": "Conversation not found."}), 404

    if request.method == "GET":
        return jsonify(
            {
                "conversation": conversation,
                "messages": store.get_messages(conv_id),
            }
        )

    if request.method == "PATCH":
        payload = request.get_json(silent=True) or {}
        if "pinned" in payload:
            pinned = bool(payload["pinned"])
            store.set_pinned(conv_id, pinned)
            return jsonify({"ok": True, "pinned": pinned})
        title = (payload.get("title") or "").strip()
        if not title:
            return jsonify({"error": "Title or pinned is required."}), 400
        store.rename_conversation(conv_id, title)
        return jsonify({"ok": True, "title": title[:120]})

    store.delete_conversation(conv_id)
    return jsonify({"ok": True})


# ── Chat (SSE streaming) ──────────────────────────────────────────────────

@app.post("/api/chat")
def chat():
    payload = request.get_json(silent=True) or {}
    question = (payload.get("message") or "").strip()
    if not question:
        return jsonify({"error": "A question is required."}), 400

    conv_id = payload.get("conversation_id")
    if not conv_id or not store.get_conversation(str(conv_id)):
        conv_id = store.create_conversation()
    conv_id = str(conv_id)

    if payload.get("regenerate"):
        store.delete_last_assistant_message(conv_id)
        previous_users = [
            message for message in store.get_messages(conv_id) if message["role"] == "user"
        ]
        if not previous_users:
            return jsonify({"error": "Nothing to regenerate yet."}), 400
        question = previous_users[-1]["content"]
    else:
        store.add_message(conv_id, "user", question)

    if retriever.count_chunks() == 0:
        return jsonify({"error": "Upload at least one paper before asking questions."}), 400

    if not gemini.available():
        return jsonify({"error": "GEMINI_API_KEY is missing. Add it to .env and restart."}), 500

    memory.maybe_compact(conv_id)
    conversation = store.get_conversation(conv_id) or {}
    history = store.get_messages(conv_id, limit=RECENT_MESSAGES)
    retrieval_query = memory.build_retrieval_query(question, history[:-1])
    sources = retriever.search(
        retrieval_query,
        doc_ids=memory.mentioned_document_ids(question),
    )
    prompt = memory.build_prompt(
        question,
        sources,
        history,
        conversation.get("summary", ""),
    )

    title = conversation.get("title", "New chat")
    if title == "New chat":
        title = question.replace("\n", " ").strip()[:52].rstrip()
        if len(question) > 52:
            title += "…"
        store.rename_conversation(conv_id, title)

    def generate():
        yield sse(
            "meta",
            {
                "conversation_id": conv_id,
                "title": title,
                "sources": [
                    {key: value for key, value in source.items() if key != "text"}
                    for source in sources
                ],
            },
        )

        answer_parts: list[str] = []
        interrupted: str | None = None
        try:
            for delta in gemini.stream_text(
                prompt, system=memory.SYSTEM_PROMPT, temperature=0.2
            ):
                if delta:
                    answer_parts.append(delta)
                    yield sse("delta", {"text": delta})
        except Exception as exc:  # noqa: BLE001 - report to UI and keep partial answer
            interrupted = str(exc)

        answer = "".join(answer_parts).strip()
        if not answer:
            answer = "I couldn't find that in the provided papers."
            yield sse("delta", {"text": answer})

        # Drop marker the model inherited from history or invented for this turn.
        valid_ids = {source["id"] for source in sources}
        answer = re.sub(
            r"\[S(\d+)\]",
            lambda match: match.group(0) if f"S{int(match.group(1))}" in valid_ids else "",
            answer,
        )

        used_sources = [
            source for source in sources if source["id"] in memory.extract_citations(answer)
        ]
        message_id = store.add_message(conv_id, "assistant", answer, used_sources)
        store.touch_conversation(conv_id)

        if interrupted:
            yield sse("error", {"message": interrupted})
        yield sse(
            "done",
            {
                "conversation_id": conv_id,
                "message_id": message_id,
                "answer": answer,
                "sources": [
                    {key: value for key, value in source.items() if key != "text"}
                    for source in used_sources
                ],
            },
        )

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Documents ─────────────────────────────────────────────────────────────

@app.get("/api/documents")
def documents_list():
    return jsonify({"documents": store.list_documents()})


@app.post("/api/upload")
def upload_documents():
    uploads = request.files.getlist("files")
    if not uploads:
        return jsonify({"error": "No files were uploaded."}), 400

    results: list[dict] = []
    for upload in uploads:
        original_name = upload.filename or "untitled"
        suffix = Path(original_name).suffix.lower()
        if suffix not in ALLOWED_EXTENSIONS:
            results.append(
                {"name": original_name, "error": "Unsupported file type (use PDF, TXT, or MD)."}
            )
            continue

        doc_id = uuid.uuid4().hex
        filename = f"{doc_id}{suffix}"
        path = UPLOAD_DIR / filename
        try:
            upload.save(path)
            info = process_document(path, original_name)
            retriever.add_document_chunks(doc_id, original_name, info["chunks"], filename)
            store.insert_document(
                doc_id,
                filename,
                original_name,
                info["kind"],
                info["pages"],
                len(info["chunks"]),
                path.stat().st_size,
            )
            results.append(
                {
                    "id": doc_id,
                    "name": original_name,
                    "kind": info["kind"],
                    "pages": info["pages"],
                    "chunks": len(info["chunks"]),
                    "filename": filename,
                }
            )
        except Exception as exc:  # noqa: BLE001 - keep processing other files
            path.unlink(missing_ok=True)
            results.append({"name": original_name, "error": str(exc)})

    return jsonify({"documents": results})


@app.delete("/api/documents/<doc_id>")
def document_delete(doc_id: str):
    document = store.delete_document(doc_id)
    if not document:
        return jsonify({"error": "Document not found."}), 404
    try:
        retriever.delete_document(doc_id)
    except Exception as exc:  # noqa: BLE001 - metadata may already be gone
        app.logger.warning("Vector cleanup failed for %s: %s", doc_id, exc)
    (UPLOAD_DIR / document["filename"]).unlink(missing_ok=True)
    return jsonify({"ok": True})


@app.get("/files/<path:filename>")
def uploaded_file(filename: str):
    return send_from_directory(UPLOAD_DIR, filename, as_attachment=False)


@app.errorhandler(RequestEntityTooLarge)
def too_large(_error):
    return jsonify({"error": "Uploaded files are too large (200 MB total limit)."}), 413


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True, threaded=True)
