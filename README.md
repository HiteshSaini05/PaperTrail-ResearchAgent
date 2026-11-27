# PaperTrail — Multi-Paper Research Agent

> A Flask-based research assistant. Upload multiple papers, ask questions across all of them, and get streamed answers with clickable page-level citations.

PaperTrail is a ground-up replacement for the earlier Streamlit study assistant. It uses a small Flask backend, Server-Sent Events for streaming, ChromaDB for local retrieval, and a dependency-free vanilla JS interface styled like a modern AI agent.

---

## Features

| Feature | Details |
|---|---|
| Multi-paper upload | Drag and drop any number of PDFs, TXT, MD, or MARKDOWN files at once (up to 40 MB each) |
| Page-level citations | PDF excerpts carry a 1-based page number; each `[S#]` marker opens the source at `#page=N` in the viewer |
| Cross-paper synthesis | Retrieval caps results per paper and per page so one document cannot dominate an answer |
| Sources drawer | Excerpts from every answer are saved in SQLite and grouped into collapsible per-answer sections — one open at a time, newest by default |
| Source scope toggle | Switch between **All answers** and **This answer** without losing the full history |
| Agent-style UI | Chat sidebar, streaming replies, stop/regenerate/copy, paper library, dark/light theme |
| Chat management | Hover a chat for the three-dot menu: Pin / Unpin, Rename, Delete. Pinned chats appear first |
| Resizable sidebar | Drag or click the handle to push/pull the sidebar; width and collapsed state persist in `localStorage` |
| Gemini-style formatting | Answers, user messages, and composer preview support `**bold**`, `_italic_`, `~~strike~~`, headings, lists, tables, code, links, and `$…$` / `$$…$$` LaTeX |
| Composer toolbar | Bold, italic, code, inline/display math, link, and list buttons with `Ctrl/Cmd+B/I/K/M` and `Ctrl+Shift+C` shortcuts |
| Context memory | Rolling summaries and anaphora-aware query rewriting keep long chats coherent with bounded prompts |
| Offline rendering | Marked and KaTeX are vendored locally — no CDN or frontend build step |

---

## Stack

- **Flask 3** — REST API plus SSE streaming
- **Google Gemini** via `google-genai` — Flash models with automatic fallback
- **ChromaDB** — local vector store with `doc_id`, `doc_name`, `page`, and `label` metadata
- **pypdf** — page-aware text extraction; no external OCR service
- **SQLite** — conversations, messages, source snapshots, and paper metadata (WAL mode)
- **Vanilla HTML/CSS/JS** — single-page interface, no npm toolchain
- **Local Marked + KaTeX** — Markdown and LaTeX rendering, including offline KaTeX fonts

---

## Quick start

```bash
python -m venv venv
# Windows PowerShell:
venv\Scripts\Activate.ps1
# Windows CMD:
venv\Scripts\activate.bat
# macOS/Linux:
source venv/bin/activate

pip install -r requirements.txt
```

If the venv already exists, just activate it and install requirements once.

Copy `.env.example` to `.env` in the project root and add your key:

```bash
copy .env.example .env   # Windows CMD/PowerShell
cp .env.example .env     # macOS/Linux
```

```env
GEMINI_API_KEY=your_google_ai_studio_api_key_here

# Optional: pin a specific model instead of trying the defaults in order
# GEMINI_MODEL=gemini-3.5-flash-lite
```

Default candidates (tried in order, with the last working model cached for the session):

1. `gemini-3.5-flash-lite`
2. `gemini-flash-lite-latest`
3. `gemini-flash-latest`
4. `gemini-3-flash-preview`

Run the server:

```bash
python app.py
```

Open **http://127.0.0.1:5000**.

> The status dot in the sidebar shows whether Gemini is connected. If it is red, check that `GEMINI_API_KEY` is set and restart the server.

---

## Using the app

1. Click **Upload papers** in the empty state, the paperclip in the composer, or **Add papers** in the library.
2. Wait for the indexing summary. Each paper shows its page count and chunk count in the **Paper library**.
3. Ask a question such as *“How do the methods in paper A and paper B differ?”*
4. Click a numbered citation in the answer. The **Sources** drawer opens the exact excerpt; click the card to open the PDF at that page.
5. In the Sources drawer:
   - Expand a group to see that answer’s citations.
   - Opening another group closes the previous one automatically.
   - Click the open group header to collapse it.
   - Use **This answer / All answers** to change scope.
6. Format your own messages with the composer toolbar or shortcuts:

   | Shortcut | Result |
   |---|---|
   | `Ctrl/Cmd+B` | `**bold**` |
   | `Ctrl/Cmd+I` | `_italic_` |
   | `Ctrl/Cmd+K` | `[link](url)` |
   | `Ctrl/Cmd+M` | `$inline formula$` |
   | `Ctrl/Cmd+Shift+C` | `` `code` `` |

   Click **Preview** to render Markdown/LaTeX before sending.

7. Use **New chat** to start fresh, or hover a chat in the sidebar for **Pin**, **Rename**, and **Delete**.
8. Drag the thin handle beside the sidebar to resize it, or click the handle to collapse/expand. On small screens, use the hamburger button.

Supported inputs: text-based PDF, `.txt`, `.md`, `.markdown`. Scanned/image-only PDFs need OCR before upload.

---

## How it works

```text
PDF(s) ──pypdf (per page)──▶ page-aware chunks ──local embeddings──▶ ChromaDB
                                                                       │
Question ──anaphora rewrite + document filter──▶ hybrid retrieval ─────┤
                                                                       ▼
                                         diverse excerpts [S1..Sn]
                                                                       │
                                                      Gemini (streamed) ─┤
                                                                       ▼
                                     SSE ──▶ chat UI ──▶ clickable citations
                                                                       │
                                          SQLite: messages + source snapshots
```

### Retrieval and answer pipeline

- **Chunking** — 950-character chunks with 130-character overlap; tiny chunks are dropped. PDF chunks keep a 1-based `page`; text files use `page = 0` for document-level citations.
- **Query rewriting** — questions containing *it / this / that / they* are expanded with the previous question before retrieval.
- **Document filter** — phrases like “in paper X” or “according to paper X” restrict the search to matching documents.
- **Hybrid reranking** — semantic similarity from Chroma is combined with IDF-weighted token overlap, an exact-phrase bonus, and a small diversity boost.
- **Diversity caps** — at most 3 chunks per paper and 2 per page, with 8 final excerpts and a 14k-character context budget.
- **Citation validation** — historical `[S#]` markers are stripped from conversation history and summaries; any marker returned by Gemini that is not in the current source set is removed before the answer is saved.
- **Prompting** — Gemini is instructed to cite only the current excerpts, compare papers explicitly, and say *“I couldn’t find that in the provided papers.”* when evidence is missing.

### Memory and efficiency

- Recent 8 messages are kept verbatim; older turns are compacted into a bounded summary after 10 messages.
- One Chroma client, one embedding function, one Gemini client, and the last working model are reused for the process lifetime.
- Embeddings run locally through Chroma’s default embedding function — no embedding API calls.
- Chunks are upserted in batches of 128.
- Answers stream token-by-token; stopping generation still saves the partial answer.

---

## API

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/` | Serve the single-page interface |
| `GET` | `/api/health` | Service and API-key status |
| `GET` | `/api/conversations` | List chats (pinned first) |
| `POST` | `/api/conversations` | Create a chat |
| `GET` | `/api/conversations/<id>` | Read a chat and its messages/sources |
| `PATCH` | `/api/conversations/<id>` | Rename or pin (`{"pinned": true}`) |
| `DELETE` | `/api/conversations/<id>` | Delete a chat |
| `POST` | `/api/chat` | SSE stream: `meta`, `delta`, `error`, `done` |
| `GET` | `/api/documents` | List indexed papers |
| `POST` | `/api/upload` | Index uploaded files |
| `DELETE` | `/api/documents/<id>` | Remove a paper and its vectors |
| `GET` | `/files/<stored_name>` | Serve an uploaded paper (`#page=N` works in most PDF viewers) |

---

## Project structure

```text
study-assistant/
├── app.py                    Flask app, routes, SSE streaming
├── config.py                 Paths, model candidates, retrieval/memory tuning
├── requirements.txt          Python dependencies
├── README.md                 This guide
├── .gitignore                Ignores secrets, venv, caches, and generated data
├── .env.example              Safe template for your Gemini API key
├── templates/
│   └── index.html            Single-page agent interface
├── static/
│   ├── app.css               Theme, layout, accordions, composer, animations
│   ├── app.js                Chat, streaming, Markdown/LaTeX, sources, uploads
│   └── vendor/               Local Marked + KaTeX assets and fonts
│       ├── marked.min.js
│       ├── katex.min.js
│       ├── katex.min.css
│       └── fonts/
├── core/
│   ├── __init__.py
│   ├── gemini.py             Gemini client, model fallback, streaming
│   ├── ingestor.py           Page-aware extraction and chunking
│   ├── retriever.py          Chroma search, reranking, source construction
│   ├── memory.py             Query rewriting, prompt building, summarization
│   └── store.py              SQLite schema and CRUD
├── data/                     Generated SQLite database
├── uploads/                  Generated original uploads
├── chroma_db/                Generated vector index
└── venv/                     Generated virtual environment
```

The `data/`, `uploads/`, `chroma_db/`, and `venv/` directories are created or populated at runtime and are excluded from version control.

---

## Data and privacy

- Uploaded files, SQLite data, and the vector index stay on the local machine.
- Paper text is sent to Gemini only for the excerpts selected for a given answer.
- Embeddings are computed locally.
- `.env` contains your API key and is ignored by Git — never commit it.
- Deleting a paper from the library removes both the uploaded file and its vectors.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Sidebar status dot is red | Add `GEMINI_API_KEY` to `.env` and restart `python app.py` |
| A model returns 404 | PaperTrail automatically falls back to the next candidate; set `GEMINI_MODEL` to pin a working one |
| Citations point to the wrong excerpt | Click a citation to open its own answer group; stale markers from older answers are filtered automatically |
| Formatting looks plain after a CSS change | Hard-refresh the browser to bypass cached CSS/JS |
| No results for a scanned PDF | Run OCR first, then upload the text-based PDF |
| Chats or papers disappeared after reinstall | Remove/regenerate `data/`, `uploads/`, and `chroma_db/` only if you intend to reset local state |
