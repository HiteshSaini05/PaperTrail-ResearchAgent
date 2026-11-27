/* PaperTrail — multi-paper research agent UI */
const $ = (id) => document.getElementById(id);

const state = {
  conversations: [],
  currentId: null,
  messages: [],
  documents: [],
  sources: [],
  conversationSources: [],
  sourcesAll: true,
  openSourceAnswer: null,
  streaming: false,
  abort: null,
  selectedFiles: [],
};

/* ── Utilities ───────────────────────────────────────────────────────── */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(message, isError = false) {
  const node = document.createElement('div');
  node.className = 'toast' + (isError ? ' error' : '');
  node.textContent = message;
  $('toastStack').appendChild(node);
  setTimeout(() => node.remove(), 4200);
}

function scrollToBottom() {
  const box = $('messages');
  box.scrollTop = box.scrollHeight;
}

/* Markdown + LaTeX rendering — supports Gemini's formatting shortcuts. */
const MASK = '\uE000';
const mask = (kind, index) => `${MASK}${kind}${index}${MASK}`;

function mathHtml(expression, display) {
  const source = expression.trim();
  if (window.katex) {
    try {
      const rendered = window.katex.renderToString(source, {
        displayMode: display,
        throwOnError: false,
        strict: false,
        output: 'html',
      });
      return display ? `<div class="math-block">${rendered}</div>` : rendered;
    } catch (error) {
      // Fall through to a readable monospace fallback.
    }
  }
  return `<code class="math-fallback">${display ? '$$' : '$'}${escapeHtml(source)}${display ? '$$' : '$'}</code>`;
}

function renderMarkdown(text) {
  const fragments = [];
  const saveBlock = (html) => { fragments.push(html); return mask('B', fragments.length - 1); };
  const saveInline = (html) => { fragments.push(html); return mask('I', fragments.length - 1); };
  let source = String(text ?? '');

  // Code is protected before anything else: no Markdown or LaTeX inside code.
  source = source.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_, language, code) => {
    const lang = language.trim();
    const attributes = lang ? ` class="language-${escapeHtml(lang)}"` : '';
    return saveBlock(`<pre><code${attributes}>${escapeHtml(code.replace(/^\n+|\n+$/g, ''))}</code></pre>`);
  });
  source = source.replace(/`([^`\n]+)`/g, (_, code) => saveInline(`<code>${escapeHtml(code)}</code>`));

  // LaTeX: $$…$$ and \[…\] are display math; $…$ and \(…\) are inline.
  source = source.replace(/\$\$([\s\S]+?)\$\$/g, (_, expression) => saveBlock(mathHtml(expression, true)));
  source = source.replace(/\\\[([\s\S]+?)\\\]/g, (_, expression) => saveBlock(mathHtml(expression, true)));
  source = source.replace(/\\\(([\s\S]+?)\\\)/g, (_, expression) => saveInline(mathHtml(expression, false)));
  source = source.replace(/\$([^\n$]+?)\$/g, (_, expression) => saveInline(mathHtml(expression, false)));

  // Citations become buttons instead of being parsed as links or emphasis.
  source = source.replace(/\[S(\d+)\]/gi, (_, number) =>
    saveInline(`<button type="button" class="cite" data-sid="S${number}" title="Show source">${number}</button>`));

  // Model output must never inject raw HTML.
  // Only `<` needs escaping to block injected tags; `>` is Markdown blockquote syntax.
  source = source.replace(/</g, '&lt;');

  let html;
  if (window.marked) {
    html = window.marked.parse(source, { gfm: true, breaks: false });
  } else {
    html = source.replace(/\n/g, '<br>');
  }

  html = html.replace(new RegExp(`<p>\\s*${MASK}B(\\d+)${MASK}\\s*</p>`, 'g'),
    (_, index) => fragments[Number(index)] ?? '');
  html = html.replace(new RegExp(`${MASK}(?:B|I)(\\d+)${MASK}`, 'g'),
    (_, index) => fragments[Number(index)] ?? '');
  html = html.replace(/<a href="/g, '<a target="_blank" rel="noopener" href="');
  return html;
}

function bindCitations(root, sources = state.sources) {
  root.querySelectorAll('.cite').forEach((button) => {
    const owner = sources.find((source) => source.id === button.dataset.sid);
    const key = owner?.key || `live:${button.dataset.sid}`;
    button.dataset.key = key;
    button.addEventListener('click', () => {
      const card = [...document.querySelectorAll('.source-card')]
        .find((item) => item.dataset.key === key);
      if (!card && sources.length) {
        state.sources = sources;
        state.sourcesAll = false;
      }
      if ((!card || card.closest('.source-group-body.collapsed')) && sources.length) {
        state.openSourceAnswer = owner?.answer_index ?? sources[0]?.answer_index ?? null;
        renderSources();
      }
      focusSource(button.dataset.sid, key);
    });
  });
}

function groupLabel(iso) {
  if (!iso) return 'Earlier';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Earlier';
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (date >= start) return 'Today';
  if (date >= new Date(start.getTime() - 86400000)) return 'Yesterday';
  if (date >= new Date(start.getTime() - 7 * 86400000)) return 'Previous 7 days';
  return 'Older';
}

/* ── Conversations ───────────────────────────────────────────────────── */
async function loadConversations() {
  const response = await fetch('/api/conversations');
  const data = await response.json();
  state.conversations = data.conversations || [];
  renderConversations();
}

function closeConvMenus(except = null) {
  document.querySelectorAll('.conv-menu.open').forEach((menu) => {
    if (menu !== except) menu.classList.remove('open');
  });
  document.querySelectorAll('.conv-more.open').forEach((button) => {
    if (!button.parentElement.querySelector('.conv-menu.open')) button.classList.remove('open');
  });
}

function menuButton(icon, label, className = '') {
  const button = document.createElement('button');
  button.type = 'button';
  if (className) button.className = className;
  button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icon}</svg><span>${label}</span>`;
  return button;
}

async function togglePinConversation(conv) {
  const pinned = !Number(conv.pinned);
  const response = await fetch(`/api/conversations/${encodeURIComponent(conv.id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned }),
  });
  if (!response.ok) { toast('Could not update this chat.', true); return; }
  await loadConversations();
  toast(pinned ? 'Chat pinned.' : 'Chat unpinned.');
}

function renderConversations() {
  const container = $('conversationList');
  const query = $('searchChats').value.trim().toLowerCase();
  const visible = state.conversations
    .filter((c) => c.title.toLowerCase().includes(query))
    .slice()
    .sort((a, b) => {
      const pinned = Number(!!b.pinned) - Number(!!a.pinned);
      return pinned || String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
    });
  container.innerHTML = '';

  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'no-convs';
    empty.textContent = query ? 'No matching chats.' : 'No chats yet — start one above.';
    container.appendChild(empty);
    return;
  }

  let currentGroup = '';
  for (const conv of visible) {
    const group = conv.pinned ? 'Pinned' : groupLabel(conv.updated_at);
    if (group !== currentGroup) {
      const label = document.createElement('div');
      label.className = 'conv-group-label';
      label.textContent = group;
      container.appendChild(label);
      currentGroup = group;
    }
    const item = document.createElement('div');
    item.className = 'conv-item' + (conv.id === state.currentId ? ' active' : '');
    item.setAttribute('role', 'button');
    item.tabIndex = 0;

    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.innerHTML = '<path d="M5 4.5h14v15H5zM8.5 9h7M8.5 13h5"/>';
    const title = document.createElement('span');
    title.className = 'conv-title';
    title.textContent = conv.title;

    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'conv-more';
    more.title = 'Chat options';
    more.setAttribute('aria-label', 'Chat options');
    more.setAttribute('aria-haspopup', 'menu');
    more.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>';

    const menu = document.createElement('div');
    menu.className = 'conv-menu';
    menu.setAttribute('role', 'menu');

    const pin = menuButton(
      '<path d="M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6zM12 15v5"/>',
      conv.pinned ? 'Unpin chat' : 'Pin chat');
    pin.addEventListener('click', (event) => {
      event.stopPropagation();
      togglePinConversation(conv);
    });

    const rename = menuButton('<path d="M4 20h4l10-10-4-4L4 16v4zM13 7l4 4"/>', 'Rename');
    rename.addEventListener('click', async (event) => {
      event.stopPropagation();
      const title = prompt('Rename this chat:', conv.title);
      if (!title || !title.trim()) return;
      await fetch(`/api/conversations/${encodeURIComponent(conv.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim() }),
      });
      await loadConversations();
    });

    const del = menuButton(
      '<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v6M14 11v6"/>',
      'Delete chat', 'danger');
    del.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (!confirm('Delete this chat?')) return;
      await fetch(`/api/conversations/${encodeURIComponent(conv.id)}`, { method: 'DELETE' });
      if (state.currentId === conv.id) startNewChat(false);
      await loadConversations();
    });

    menu.append(pin, rename, del);
    more.addEventListener('click', (event) => {
      event.stopPropagation();
      const wasOpen = menu.classList.contains('open');
      closeConvMenus();
      if (!wasOpen) {
        menu.classList.add('open');
        more.classList.add('open');
      }
    });

    if (conv.pinned) {
      const pinMark = document.createElement('span');
      pinMark.className = 'conv-pin';
      pinMark.title = 'Pinned';
      pinMark.textContent = '📌';
      item.append(icon, pinMark, title);
    } else {
      item.append(icon, title);
    }
    item.append(more, menu);

    item.addEventListener('click', (event) => {
      if (event.target.closest('.conv-menu') || event.target.closest('.conv-more')) return;
      closeConvMenus();
      openConversation(conv.id);
    });
    item.addEventListener('keydown', (event) => {
      if (event.target !== item || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      openConversation(conv.id);
    });
    container.appendChild(item);
  }
}

async function createConversation() {
  const response = await fetch('/api/conversations', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'New chat' }),
  });
  const data = await response.json();
  await loadConversations();
  return data.id;
}

function startNewChat(closeSidebar = true) {
  state.currentId = null;
  state.messages = [];
  state.sources = [];
  state.conversationSources = [];
  state.sourcesAll = true;
  state.openSourceAnswer = null;
  localStorage.removeItem('papertrail-current');
  $('chatTitle').textContent = 'New chat';
  $('chatSubtitle').textContent = 'Ask across all your papers';
  $('messages').querySelectorAll('.message-row').forEach((row) => row.remove());
  $('emptyState').classList.remove('hidden');
  renderSources();
  renderConversations();
  $('promptInput').focus();
  if (closeSidebar) closePanels();
}

async function openConversation(id) {
  if (state.streaming) return;
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`);
  if (!response.ok) return;
  const data = await response.json();
  state.currentId = id;
  state.messages = data.messages || [];
  syncConversationSources();
  state.sources = state.conversationSources;
  state.sourcesAll = true;
  state.openSourceAnswer = null;
  localStorage.setItem('papertrail-current', id);
  $('chatTitle').textContent = data.conversation.title;
  renderMessages();
  renderSources();
  renderConversations();
  closePanels();
}

/* ── Messages ────────────────────────────────────────────────────────── */
function createMessageRow(message) {
  const row = document.createElement('div');
  row.className = `message-row ${message.role}`;
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = message.role === 'user' ? 'You' : '✦';
  const body = document.createElement('div');
  body.className = 'message-body';

  if (message.role === 'user') {
    const bubble = document.createElement('div');
    bubble.className = 'user-bubble';
    bubble.innerHTML = `<div class="assistant-content">${renderMarkdown(message.content)}</div>`;
    bindCitations(bubble, message.sources || state.sources);
    body.appendChild(bubble);
  } else {
    const content = document.createElement('div');
    content.className = 'assistant-content';
    content.innerHTML = renderMarkdown(message.content);
    bindCitations(content, message.sources || state.sources);
    body.appendChild(content);

    const actions = document.createElement('div');
    actions.className = 'message-actions';
    const copy = document.createElement('button');
    copy.className = 'mini-btn';
    copy.type = 'button';
    copy.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5H5v11h3"/></svg>Copy';
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(message.content);
      toast('Copied to clipboard.');
    });
    actions.appendChild(copy);
    if (state.messages.indexOf(message) === state.messages.length - 1 && !state.streaming) {
      const regenerate = document.createElement('button');
      regenerate.className = 'mini-btn';
      regenerate.type = 'button';
      regenerate.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 11a8 8 0 10-2.3 5.7M20 5v6h-6"/></svg>Regenerate';
      regenerate.addEventListener('click', () => {
        const lastUser = [...state.messages].reverse().find((item) => item.role === 'user');
        if (lastUser) sendMessage(lastUser.content, true);
      });
      actions.appendChild(regenerate);
    }
    body.appendChild(actions);
  }
  row.append(avatar, body);
  return row;
}

function renderMessages() {
  const container = $('messages');
  container.querySelectorAll('.message-row').forEach((row) => row.remove());
  for (const message of state.messages) container.appendChild(createMessageRow(message));
  $('emptyState').classList.toggle('hidden', state.messages.length > 0);
  scrollToBottom();
}

async function sendMessage(text, regenerate = false) {
  if (state.streaming || !text.trim()) return;
  if (!state.documents.length) {
    toast('Upload at least one paper first.', true);
    openUploadModal();
    return;
  }

  const question = text.trim();
  if (!state.currentId) state.currentId = await createConversation();
  const convId = state.currentId;
  localStorage.setItem('papertrail-current', convId);
  $('emptyState').classList.add('hidden');

  if (regenerate) {
    while (state.messages.length && state.messages[state.messages.length - 1].role === 'assistant') {
      state.messages.pop();
    }
    syncConversationSources();
  } else {
    state.messages.push({ role: 'user', content: question });
  }
  const assistantMessage = {
    role: 'assistant', content: '', sources: [], keyPrefix: `draft-${Date.now()}`,
  };
  state.messages.push(assistantMessage);
  renderMessages();

  const streamingRow = [...document.querySelectorAll('.message-row.assistant')].pop();
  streamingRow.querySelector('.message-actions').remove();
  const streamingContent = streamingRow.querySelector('.assistant-content');
  streamingContent.classList.add('cursor');
  streamingContent.innerHTML = '<span class="typing">Searching your papers…</span>';
  scrollToBottom();

  $('promptInput').value = '';
  setPreview(false);
  autoResize();
  setStreaming(true);
  const controller = new AbortController();
  state.abort = controller;

  let buffer = '';
  let started = false;
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: convId, message: question, regenerate }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `Request failed (${response.status})`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
      let split;
      while ((split = raw.indexOf('\n\n')) !== -1) {
        const block = raw.slice(0, split);
        raw = raw.slice(split + 2);
        let event = 'message';
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        let payload;
        try { payload = JSON.parse(data); } catch { continue; }
        handleStreamEvent(event, payload, assistantMessage, streamingContent,
          (text) => { buffer = text; started = true; });
      }
    }

    if (!started) {
      assistantMessage.content = buffer || "I couldn't find that in the provided papers.";
    }
  } catch (error) {
    if (error.name !== 'AbortError') {
      assistantMessage.content = buffer || `Error: ${error.message}`;
      toast(error.message, true);
    } else if (!buffer) {
      assistantMessage.content = 'Generation stopped.';
    }
  } finally {
    streamingContent.classList.remove('cursor');
    state.abort = null;
    setStreaming(false);
    assistantMessage.content = assistantMessage.content || buffer;
    renderMessages();
    renderSources();
    await loadConversations();
  }
}

function handleStreamEvent(event, payload, assistantMessage, contentEl, setBuffer) {
  if (event === 'meta') {
    const prefix = assistantMessage.keyPrefix || 'draft';
    const answerIndex = nextAnswerIndex();
    assistantMessage.sources = (payload.sources || []).map((source) => ({
      ...source,
      answer_index: answerIndex,
      key: `${prefix}:${source.id}`,
    }));
    state.openSourceAnswer = answerIndex;
    state.sources = state.sourcesAll
      ? [...state.conversationSources, ...assistantMessage.sources]
      : assistantMessage.sources;
    renderSources();
    if (payload.title) $('chatTitle').textContent = payload.title;
  } else if (event === 'delta') {
    const text = payload.text || '';
    setBuffer((assistantMessage.content || '') + text);
    assistantMessage.content = (assistantMessage.content || '') + text;
    contentEl.classList.remove('typing');
    contentEl.innerHTML = renderMarkdown(assistantMessage.content);
    bindCitations(contentEl, assistantMessage.sources);
    scrollToBottom();
  } else if (event === 'error') {
    toast(payload.message || 'The model was interrupted.', true);
  } else if (event === 'done') {
    assistantMessage.content = payload.answer || assistantMessage.content;
    assistantMessage.message_id = payload.message_id || assistantMessage.keyPrefix;
    assistantMessage.sources = (payload.sources || []).map((source) => ({
      ...source,
      message_id: assistantMessage.message_id,
      key: `${assistantMessage.message_id}:${source.id}`,
    }));
    syncConversationSources();
    state.openSourceAnswer = assistantMessage.sources[0]?.answer_index ?? null;
    state.sources = state.sourcesAll ? state.conversationSources : assistantMessage.sources;
    renderSources();
  }
}

function setStreaming(active) {
  state.streaming = active;
  $('sendBtn').classList.toggle('hidden', active);
  $('stopBtn').classList.toggle('hidden', !active);
  $('promptInput').disabled = active;
  if (!active) $('promptInput').focus();
}

function autoResize() {
  const input = $('promptInput');
  input.style.height = 'auto';
  input.style.height = Math.min(Math.max(input.scrollHeight, 34), 180) + 'px';
}

/* ── Composer formatting ─────────────────────────────────────────────── */
const FORMATS = {
  bold: ['**', '**', 'bold text'],
  italic: ['_', '_', 'italic text'],
  code: ['`', '`', 'code'],
  latex: ['$', '$', 'E = mc^2'],
  blockLatex: ['$$\n', '\n$$', 'E = mc^2'],
  link: ['[', '](https://)', 'link text'],
};

function applyFormat(kind) {
  const input = $('promptInput');
  if (input.disabled) return;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const selected = input.value.slice(start, end);

  if (kind === 'list') {
    const text = selected || 'list item';
    const replacement = text.split('\n').map((line) => `- ${line}`).join('\n');
    input.setRangeText(replacement, start, end, 'select');
  } else {
    const [before, after, placeholder] = FORMATS[kind] || ['', '', ''];
    input.setRangeText(before + (selected || placeholder) + after, start, end, 'select');
  }
  input.focus();
  autoResize();
  updatePreview();
}

function updatePreview() {
  const preview = $('inputPreview');
  if (preview.classList.contains('hidden')) return;
  const value = $('promptInput').value;
  preview.innerHTML = value.trim()
    ? `<div class="assistant-content">${renderMarkdown(value)}</div>`
    : '<p class="preview-empty">Nothing to preview yet — start typing with **bold**, _italic_, or $formula$.</p>';
}

function setPreview(active) {
  const input = $('promptInput');
  const preview = $('inputPreview');
  const button = $('previewToggle');
  if (active && input.disabled) return;
  input.classList.toggle('hidden', active);
  preview.classList.toggle('hidden', !active);
  button.classList.toggle('active', active);
  button.textContent = active ? 'Edit' : 'Preview';
  button.title = active ? 'Back to editing' : 'Preview formatting';
  button.setAttribute('aria-pressed', String(active));
  if (active) updatePreview();
  else { autoResize(); input.focus(); }
}

/* ── Sources & library ───────────────────────────────────────────────── */
function syncConversationSources() {
  let answerIndex = 0;
  for (const message of state.messages) {
    if (message.role !== 'assistant') continue;
    answerIndex += 1;
    const owner = message.message_id || message.id || `answer-${answerIndex}`;
    message.sources = (message.sources || []).map((source) => ({
      ...source,
      message_id: owner,
      answer_index: answerIndex,
      key: `${owner}:${source.id}`,
    }));
  }
  state.conversationSources = state.messages.flatMap((message) => message.sources || []);
}

function nextAnswerIndex() {
  return state.conversationSources.reduce(
    (max, source) => Math.max(max, source.answer_index || 0), 0,
  ) + 1;
}

function latestAnswerSources() {
  return [...state.messages].reverse()
    .find((message) => message.role === 'assistant' && (message.sources || []).length)?.sources || [];
}

function setSourceScope(all) {
  state.sourcesAll = all;
  state.sources = all ? state.conversationSources : latestAnswerSources();
  renderSources();
}

function renderSources() {
  const list = $('sourcesList');
  list.innerHTML = '';
  const scopeButton = $('sourceScope');
  if (scopeButton) {
    scopeButton.textContent = state.sourcesAll ? 'This answer' : 'All answers';
    scopeButton.title = state.sourcesAll ? 'Show only the latest answer' : 'Show citations from every answer';
    scopeButton.setAttribute('aria-label', scopeButton.title);
  }
  if (!state.sources.length) {
    $('sourcesSubtitle').textContent = 'Citations from the latest answer';
    list.innerHTML = '<div class="panel-empty">Ask a question to see the exact excerpts used to build the answer.</div>';
    return;
  }

  const groups = [];
  for (const source of state.sources) {
    const index = source.answer_index || groups.length + 1;
    let group = groups.find((item) => item.index === index);
    if (!group) {
      group = { index, sources: [] };
      groups.push(group);
    }
    group.sources.push(source);
  }

  $('sourcesSubtitle').textContent = state.sourcesAll && groups.length > 1
    ? `${state.sources.length} excerpts across ${groups.length} answers`
    : `${state.sources.length} excerpt${state.sources.length > 1 ? 's' : ''} used in this answer`;

  const indices = groups.map((group) => group.index);
  const requested = state.openSourceAnswer;
  const active = requested === 0 || indices.includes(requested)
    ? requested
    : indices[indices.length - 1];
  state.openSourceAnswer = active;

  for (const group of groups) {
    const expanded = group.index === active;
    const section = document.createElement('section');
    section.className = 'source-group';
    section.dataset.answer = String(group.index);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'source-group-toggle';
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
      <span>Answer ${group.index}</span>
      <span class="source-count">${group.sources.length}</span>`;
    toggle.addEventListener('click', () => {
      state.openSourceAnswer = state.openSourceAnswer === group.index ? 0 : group.index;
      renderSources();
    });
    section.appendChild(toggle);

    const body = document.createElement('div');
    body.className = 'source-group-body' + (expanded ? '' : ' collapsed');
    for (const source of group.sources) {
      const card = document.createElement('a');
      card.className = 'source-card';
      card.dataset.sid = source.id;
      card.dataset.key = source.key || `${source.message_id || 'source'}:${source.id}`;
      const page = source.page ? `p. ${source.page}` : 'whole document';
      const href = source.page ? `${source.file_url}#page=${source.page}` : source.file_url;
      card.href = href || '#';
      card.target = '_blank';
      card.rel = 'noopener';
      card.innerHTML = `
        <div class="source-head">
          <span class="source-num">${escapeHtml(source.id.replace('S', ''))}</span>
          <span class="source-label">${escapeHtml(source.doc_name)}</span>
          <span class="source-page">${escapeHtml(page)}</span>
        </div>
        <div class="source-snippet">${escapeHtml(source.snippet)}</div>
        <div class="source-open">Open ${escapeHtml(source.file_url ? 'source PDF' : 'document')} ↗</div>`;
      body.appendChild(card);
    }
    section.appendChild(body);
    list.appendChild(section);
  }
}

function focusSource(sourceId, key) {
  document.body.classList.remove('library-open');
  $('libraryPanel').classList.remove('open');
  document.body.classList.add('sources-open');
  $('sourcesPanel').classList.add('open');
  renderSources();
  let cards = [...document.querySelectorAll('.source-card')];
  let card = (key && cards.find((el) => el.dataset.key === key))
    || cards.find((el) => el.dataset.sid === sourceId);
  const collapsedGroup = card?.closest('.source-group-body.collapsed');
  if (collapsedGroup) {
    const answer = card.closest('.source-group')?.dataset.answer;
    if (answer) state.openSourceAnswer = Number(answer);
    renderSources();
    cards = [...document.querySelectorAll('.source-card')];
    card = (key && cards.find((el) => el.dataset.key === key))
      || cards.find((el) => el.dataset.sid === sourceId);
  }
  if (card) {
    card.classList.add('flash');
    card.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    document.querySelectorAll('.cite').forEach((el) => el.classList.toggle('used', el.dataset.sid === sourceId));
  }
}

async function loadDocuments() {
  const response = await fetch('/api/documents');
  const data = await response.json();
  state.documents = data.documents || [];
  $('paperCount').textContent = String(state.documents.length);
  $('librarySubtitle').textContent = `${state.documents.length} paper${state.documents.length === 1 ? '' : 's'} indexed`;
  $('chatSubtitle').textContent = state.documents.length
    ? `Grounded in ${state.documents.length} paper${state.documents.length === 1 ? '' : 's'}`
    : 'Upload papers to get started';
  renderLibrary();
}

function renderLibrary() {
  const list = $('libraryList');
  list.innerHTML = '';
  if (!state.documents.length) {
    list.innerHTML = '<div class="panel-empty">No papers yet. Upload PDFs to build your knowledge base.</div>';
    return;
  }
  for (const doc of state.documents) {
    const item = document.createElement('div');
    item.className = 'library-item';
    const detail = doc.pages ? `${doc.pages} pages · ${doc.chunks} chunks` : `document · ${doc.chunks} chunks`;
    item.innerHTML = `
      <div class="library-icon">${doc.kind === 'pdf' ? 'PDF' : 'TXT'}</div>
      <div class="library-meta">
        <div class="library-name">${escapeHtml(doc.original_name)}</div>
        <div class="library-detail">${escapeHtml(detail)}</div>
      </div>`;
    const del = document.createElement('button');
    del.className = 'library-delete';
    del.title = 'Remove paper';
    del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>';
    del.addEventListener('click', async () => {
      if (!confirm(`Remove ${doc.original_name} from the library?`)) return;
      await fetch(`/api/documents/${encodeURIComponent(doc.id)}`, { method: 'DELETE' });
      await loadDocuments();
      toast('Paper removed.');
    });
    item.appendChild(del);
    list.appendChild(item);
  }
}

/* ── Panels & theme ──────────────────────────────────────────────────── */
function closePanels() {
  document.body.classList.remove('sources-open', 'library-open', 'sidebar-open');
  $('sourcesPanel').classList.remove('open');
  $('libraryPanel').classList.remove('open');
  $('sidebar').classList.remove('open');
  $('sidebarScrim').classList.remove('open');
}

function togglePanel(name) {
  const isOpen = document.body.classList.contains(`${name}-open`);
  closePanels();
  if (!isOpen) {
    document.body.classList.add(`${name}-open`);
    $(name === 'sources' ? 'sourcesPanel' : 'libraryPanel').classList.add('open');
  }
}

/* ── Collapsible / resizable sidebar ─────────────────────────────────── */
function sidebarIsMobile() {
  return window.matchMedia('(max-width: 900px)').matches;
}

function sidebarWidth() {
  return Number(localStorage.getItem('papertrail-sidebar-width')) || 272;
}

function setSidebarWidth(width, save = true) {
  const clamped = Math.min(440, Math.max(200, width));
  document.documentElement.style.setProperty('--sidebar-width', `${clamped}px`);
  if (save) localStorage.setItem('papertrail-sidebar-width', String(clamped));
}

function collapseSidebar() {
  if (sidebarIsMobile()) { closePanels(); return; }
  document.body.classList.add('sidebar-collapsed');
  localStorage.setItem('papertrail-sidebar-collapsed', '1');
}

function expandSidebar() {
  if (sidebarIsMobile()) {
    $('sidebar').classList.add('open');
    $('sidebarScrim').classList.add('open');
    return;
  }
  document.body.classList.remove('sidebar-collapsed');
  localStorage.removeItem('papertrail-sidebar-collapsed');
}

function toggleSidebar() {
  if (sidebarIsMobile()) {
    if ($('sidebar').classList.contains('open')) closePanels();
    else expandSidebar();
  } else if (document.body.classList.contains('sidebar-collapsed')) {
    expandSidebar();
  } else {
    collapseSidebar();
  }
}

function initSidebarResize() {
  const handle = $('sidebarResize');
  let dragging = false;
  let moved = false;
  let suppressClick = false;
  let startX = 0;
  let startWidth = 0;
  let currentWidth = 0;

  setSidebarWidth(sidebarWidth(), false);
  if (!sidebarIsMobile() && localStorage.getItem('papertrail-sidebar-collapsed') === '1') {
    document.body.classList.add('sidebar-collapsed');
  }

  handle.addEventListener('pointerdown', (event) => {
    if (sidebarIsMobile() || event.button !== 0) return;
    dragging = true;
    moved = false;
    startX = event.clientX;
    startWidth = document.body.classList.contains('sidebar-collapsed')
      ? sidebarWidth()
      : $('sidebar').getBoundingClientRect().width;
    currentWidth = startWidth;
    document.body.classList.add('resizing-sidebar');
    handle.setPointerCapture(event.pointerId);
  });

  handle.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const delta = event.clientX - startX;
    if (Math.abs(delta) > 3) moved = true;
    const width = startWidth + delta;
    if (width < 150) {
      document.body.classList.add('sidebar-collapsed');
      return;
    }
    document.body.classList.remove('sidebar-collapsed');
    currentWidth = Math.min(440, Math.max(200, width));
    setSidebarWidth(currentWidth, false);
  });

  const finishDrag = (event) => {
    if (!dragging) return;
    dragging = false;
    suppressClick = moved;
    document.body.classList.remove('resizing-sidebar');
    try { handle.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    if (!document.body.classList.contains('sidebar-collapsed') && currentWidth) {
      setSidebarWidth(currentWidth);
    }
  };
  handle.addEventListener('pointerup', finishDrag);
  handle.addEventListener('pointercancel', finishDrag);

  handle.addEventListener('click', () => {
    if (suppressClick) { suppressClick = false; return; }
    toggleSidebar();
  });

  handle.addEventListener('keydown', (event) => {
    if (['Enter', ' '].includes(event.key)) {
      event.preventDefault();
      toggleSidebar();
    } else if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      const current = document.body.classList.contains('sidebar-collapsed')
        ? sidebarWidth()
        : $('sidebar').getBoundingClientRect().width;
      const next = current + (event.key === 'ArrowRight' ? 18 : -18);
      if (next < 150) collapseSidebar();
      else { expandSidebar(); setSidebarWidth(next); }
    }
  });
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('themeLabel').textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
  localStorage.setItem('papertrail-theme', theme);
}

/* ── Upload ──────────────────────────────────────────────────────────── */
function openUploadModal() {
  closePanels();
  $('uploadModal').classList.remove('hidden');
  $('uploadResults').innerHTML = '';
  $('progressTrack').classList.add('hidden');
}

function closeUploadModal() {
  $('uploadModal').classList.add('hidden');
  state.selectedFiles = [];
  $('fileInput').value = '';
  renderSelectedFiles();
}

function renderSelectedFiles() {
  const container = $('selectedFiles');
  container.innerHTML = '';
  state.selectedFiles.forEach((file, index) => {
    const chip = document.createElement('div');
    chip.className = 'file-chip';
    const size = file.size > 1048576
      ? `${(file.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(file.size / 1024))} KB`;
    chip.innerHTML = `<span class="file-name">${escapeHtml(file.name)}</span><span class="file-size">${size}</span>`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.title = 'Remove';
    remove.textContent = '✕';
    remove.addEventListener('click', () => {
      state.selectedFiles.splice(index, 1);
      renderSelectedFiles();
    });
    chip.appendChild(remove);
    container.appendChild(chip);
  });
  $('confirmUpload').disabled = state.selectedFiles.length === 0;
}

function addFiles(fileList) {
  for (const file of fileList) {
    if (!/\.(pdf|txt|md|markdown)$/i.test(file.name)) {
      toast(`${file.name}: unsupported file type.`, true);
      continue;
    }
    if (!state.selectedFiles.some((existing) => existing.name === file.name && existing.size === file.size)) {
      state.selectedFiles.push(file);
    }
  }
  renderSelectedFiles();
}

function uploadFiles() {
  if (!state.selectedFiles.length) return;
  const button = $('confirmUpload');
  button.disabled = true;
  $('uploadResults').innerHTML = '';
  $('progressTrack').classList.remove('hidden');
  $('progressFill').style.width = '0%';

  const form = new FormData();
  state.selectedFiles.forEach((file) => form.append('files', file));

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload');
  xhr.upload.onprogress = (event) => {
    if (event.lengthComputable) {
      $('progressFill').style.width = `${Math.round((event.loaded / event.total) * 100)}%`;
    }
  };
  xhr.onload = async () => {
    button.disabled = false;
    let data = {};
    try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
    if (xhr.status !== 200) {
      toast(data.error || 'Upload failed.', true);
      return;
    }
    const results = data.documents || [];
    const resultsBox = $('uploadResults');
    let ok = 0;
    for (const result of results) {
      const line = document.createElement('div');
      if (result.error) {
        line.className = 'result-line err';
        line.textContent = `${result.name}: ${result.error}`;
      } else {
        ok += 1;
        line.className = 'result-line ok';
        const pages = result.pages ? `${result.pages} pages` : 'document-level';
        line.textContent = `${result.name} — ${pages}, ${result.chunks} chunks indexed`;
      }
      resultsBox.appendChild(line);
    }
    await loadDocuments();
    state.selectedFiles = [];
    $('fileInput').value = '';
    renderSelectedFiles();
    if (ok) toast(`${ok} paper${ok > 1 ? 's' : ''} added to your library.`);
  };
  xhr.onerror = () => { button.disabled = false; toast('Upload failed — check your connection.', true); };
  xhr.send(form);
}

/* ── Wiring ──────────────────────────────────────────────────────────── */
function bindEvents() {
  $('newChatBtn').addEventListener('click', () => startNewChat());
  $('searchChats').addEventListener('input', renderConversations);
  $('chatForm').addEventListener('submit', (event) => {
    event.preventDefault();
    sendMessage($('promptInput').value);
  });
  $('promptInput').addEventListener('input', () => { autoResize(); updatePreview(); });
  $('promptInput').addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && !event.altKey) {
      const key = event.key.toLowerCase();
      const shortcut = event.shiftKey && key === 'c'
        ? 'code' : { b: 'bold', i: 'italic', k: 'link', m: 'latex' }[key];
      if (shortcut) {
        event.preventDefault();
        applyFormat(shortcut);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendMessage($('promptInput').value);
    }
  });
  $('formatBar').addEventListener('click', (event) => {
    const button = event.target.closest('[data-format]');
    if (button) applyFormat(button.dataset.format);
  });
  $('previewToggle').addEventListener('click', () => setPreview($('inputPreview').classList.contains('hidden')));
  $('stopBtn').addEventListener('click', () => { if (state.abort) state.abort.abort(); });
  $('attachBtn').addEventListener('click', openUploadModal);
  $('emptyUploadBtn').addEventListener('click', openUploadModal);
  $('suggestions').addEventListener('click', (event) => {
    const button = event.target.closest('.suggestion');
    if (button) sendMessage(button.dataset.prompt);
  });

  $('sourcesToggle').addEventListener('click', () => togglePanel('sources'));
  $('sourceScope').addEventListener('click', () => setSourceScope(!state.sourcesAll));
  $('sourcesClose').addEventListener('click', closePanels);
  $('libraryBtn').addEventListener('click', () => togglePanel('library'));
  $('libraryClose').addEventListener('click', closePanels);
  $('libraryUploadBtn').addEventListener('click', openUploadModal);
  $('menuBtn').addEventListener('click', expandSidebar);
  $('sidebarClose').addEventListener('click', collapseSidebar);
  $('sidebarScrim').addEventListener('click', closePanels);
  $('themeBtn').addEventListener('click', () =>
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

  $('uploadClose').addEventListener('click', closeUploadModal);
  $('cancelUpload').addEventListener('click', closeUploadModal);
  $('browseBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (event) => addFiles(event.target.files));
  $('confirmUpload').addEventListener('click', uploadFiles);

  const dropzone = $('dropzone');
  ['dragenter', 'dragover'].forEach((type) =>
    dropzone.addEventListener(type, (event) => { event.preventDefault(); dropzone.classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach((type) =>
    dropzone.addEventListener(type, (event) => { event.preventDefault(); dropzone.classList.remove('dragging'); }));
  dropzone.addEventListener('drop', (event) => addFiles(event.dataTransfer.files));
  document.addEventListener('click', closeConvMenus);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeConvMenus();
      if (!$('uploadModal').classList.contains('hidden')) closeUploadModal();
    }
  });
}

async function checkHealth() {
  try {
    const data = await (await fetch('/api/health')).json();
    $('statusDot').className = 'status-dot ' + (data.ok && data.model_ready ? 'online' : 'offline');
    $('statusText').textContent = data.model_ready ? 'Gemini connected' : 'API key missing';
    if (!data.model_ready) toast('GEMINI_API_KEY is missing — add it to .env.', true);
  } catch {
    $('statusDot').className = 'status-dot offline';
    $('statusText').textContent = 'Service unavailable';
  }
}

async function init() {
  bindEvents();
  initSidebarResize();
  applyTheme(localStorage.getItem('papertrail-theme') || 'dark');
  await Promise.all([loadDocuments(), loadConversations()]);
  const last = localStorage.getItem('papertrail-current');
  if (last && state.conversations.some((conv) => conv.id === last)) await openConversation(last);
  else startNewChat(false);
  checkHealth();
}

document.addEventListener('DOMContentLoaded', init);
