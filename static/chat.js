/* Conversation view for headless agents: prompts, streamed answers, tool calls, results, permission cards. */
'use strict';

const Chat = (() => {
  let root, logEl, statusEl, olderBtn, input, hintEl, current = null, agents = {}, loaded = {}, streaming = null,
    handlers = { answer() {}, seen() {}, prompt() {}, interrupt() {}, mode() {}, tprompt() {}, tinterrupt() {}, tmode() {}, tkey() {}, tseen() {} };
  const isTerm = id => !!(loaded[id] && loaded[id].term);
  const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  // small markdown: fenced code, inline code, bold, bullet lines; everything else stays literal
  function md(text) {
    const parts = String(text ?? '').split(/```/);
    return parts.map((p, i) => {
      if (i % 2 === 1) { const nl = p.indexOf('\n'); const lang = nl > 0 ? p.slice(0, nl).trim() : ''; const body = nl >= 0 ? p.slice(nl + 1) : p; return `<pre data-lang="${esc(lang)}">${esc(body.replace(/\n$/, ''))}</pre>`; }
      return esc(p).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/^#{1,6}\s+(.*)$/gm, '<b>$1</b>').replace(/^(\s*)[-*+] /gm, '$1• ').replace(/^\s*(?:-{3,}|\*{3,})\s*$/gm, '────────');
    }).join('');
  }
  const fmtTime = ts => new Date(ts * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fmtCost = c => c == null ? '' : '$' + Number(c).toFixed(c < 0.01 ? 4 : 3);
  function el(cls, html) { const d = document.createElement('div'); d.className = cls; if (html != null) d.innerHTML = html; return d; }

  function line(cls, glyph, gcls, inner) {
    return el('ln ' + cls, (glyph ? `<span class="${gcls}">${glyph} </span>` : '') + `<span class="tx">${inner}</span>`);
  }
  function resultRow(text, isErr) {
    const lines = String(text || '').split('\n'), short = lines.slice(0, 8).join('\n');
    const row = el('ln res' + (isErr ? ' err' : ''), `<span class="cor">  ⎿  </span><span class="tx">${esc(short)}</span>`);
    if (lines.length > 8) { const m = el('more', `     … +${lines.length - 8} lines`); m.onclick = () => { row.querySelector('.tx').textContent = text; m.remove(); }; row.appendChild(m); }
    return row;
  }
  function render(ev, agent, live = false) {
    const d = ev.data || {}, k = ev.kind;
    if (k === 'user') return line('user', '&gt;', 'gt', esc(d.text));
    if (k === 'assistant') {
      const wrap = el('grp');
      (d.content || []).forEach(b => {
        if (b.type === 'text' && b.text) wrap.appendChild(line('asst', '⏺', 'bul', md(b.text)));
        else if (b.type === 'tool_use') {
          const row = line('tool', '⏺', 'bul', esc(b.summary || b.name));
          if (b.input && !b.input.truncated) { const pre = el('input', `<pre>${esc(JSON.stringify(b.input, null, 2))}</pre>`); pre.hidden = true; row.appendChild(pre); row.querySelector('.tx').style.cursor = 'pointer'; row.querySelector('.tx').onclick = () => { pre.hidden = !pre.hidden; }; }
          wrap.appendChild(row);
        } else if (b.type === 'thinking' && b.chars) wrap.appendChild(line('think', '✻', 'bul', `thinking (${b.chars} chars)`));
      });
      return wrap.children.length ? wrap : null;
    }
    if (k === 'tool_result') {
      const wrap = el('grp');
      (d.results || []).forEach(r => wrap.appendChild(resultRow(r.text, r.is_error)));
      return wrap.children.length ? wrap : null;
    }
    if (k === 'permission') {
      const pending = live ? true : !!(agent && (agent.pending || []).some(p => p.request_id === d.request_id));
      const card = el('perm' + (pending ? ' pending' : ''), `<div class="q"><span class="mark">?</span>Allow <b>${esc(d.summary || d.tool)}</b>?${d.description ? ` <span class="desc">${esc(d.description)}</span>` : ''}</div>`);
      if (d.input && !d.input.truncated) { const pre = el('input', `<pre>${esc(typeof d.input === 'string' ? d.input : JSON.stringify(d.input, null, 2))}</pre>`); card.appendChild(pre); }
      if (pending) {
        const row = el('actions');
        const b1 = document.createElement('button'); b1.className = 'primary'; b1.textContent = 'allow';
        const b2 = document.createElement('button'); b2.textContent = 'allow and remember';
        const b3 = document.createElement('button'); b3.className = 'danger'; b3.textContent = 'deny';
        b1.onclick = () => handlers.answer(current, d.request_id, true, false); b2.onclick = () => handlers.answer(current, d.request_id, true, true); b3.onclick = () => handlers.answer(current, d.request_id, false, false);
        row.append(b1, b2, b3); card.appendChild(row);
      }
      card.dataset.rid = d.request_id;
      return card;
    }
    if (k === 'decision') return el('decision ' + (d.allow ? 'ok' : 'no'), `${d.allow ? 'allowed' : 'denied'} ${esc(d.summary || d.tool)}${d.remember ? ' (remembered)' : ''}${d.message ? ': ' + esc(d.message) : ''}`);
    if (k === 'result') return el('turn' + (d.is_error ? ' err' : ''), `${d.is_error ? 'turn failed' : 'turn done'} · ${((d.duration_ms || 0) / 1000).toFixed(1)} s · ${fmtCost(d.cost_usd)} · out ${(d.tokens || {}).out ?? '?'} tokens${d.text ? ': ' + esc(d.text) : ''}`);
    if (k === 'system') return el('sys', esc(d.text));
    return null;
  }

  const PAGE = 150;
  const home = () => (typeof HOME === 'string' ? HOME : '');
  const tilde = t => { const h = home(); return h && t ? String(t).split(h + '/').join('~/').split(h).join('~') : t; };   // display only: home paths as ~
  function renderTranscript(e0) {   // saved history line {seq, ts, role, text}, drawn like the Claude Code terminal
    const e = { ...e0, text: tilde(e0.text) };
    if (e.role === 'user') return line('user', '&gt;', 'gt', esc(e.text));
    if (e.role === 'assistant') return line('asst', '⏺', 'bul', md(e.text));
    if (e.role === 'tool') return line('tool', '⏺', 'bul', esc(e.text));
    if (e.role === 'result') return resultRow(e.text, false);
    if (e.role === 'session') return el('sys', esc(e.text));
    return null;
  }
  async function loadHistory(id, before) {
    const r = await fetch(`/api/agents/${encodeURIComponent(id)}/history?limit=${PAGE}` + (before != null ? `&before=${before}` : '') + (window.SESSION ? '&session=' + encodeURIComponent(window.SESSION) : ''));
    if (!r.ok) return null;
    return r.json();
  }
  function scrollBottom() { logEl.scrollTop = logEl.scrollHeight; }
  function atBottom() { return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40; }

  async function load(id, before) {
    const r = await fetch(`/api/agents/${encodeURIComponent(id)}/events?limit=150` + (before ? `&before=${before}` : '') + (window.SESSION ? '&session=' + encodeURIComponent(window.SESSION) : ''));
    if (!r.ok) return null;
    return r.json();
  }
  async function show(id) {
    current = id; root.hidden = false; logEl.innerHTML = ''; streaming = null;
    const data = await load(id); if (!data || current !== id) return;
    agents[id] = data.agent; loaded[id] = { first: data.events.length ? data.events[0].id : null, total: data.total, shown: data.events.length, tOffset: 0, tDone: false, tTotal: 0 };
    // the life of the session before it ran headless comes from its Claude Code transcript (entries older than the agent record)
    const h = await loadHistory(id); if (current !== id) return;
    loaded[id].hFirst = null; loaded[id].hTotal = 0;
    if (h && h.entries && h.entries.length) {
      loaded[id].hTotal = h.total || h.entries.length; loaded[id].hFirst = h.entries[0].seq;
      h.entries.forEach(e => { const n = renderTranscript(e); if (n) logEl.appendChild(n); });
      if (data.events.length) logEl.appendChild(el('sys', 'running headless in Agent-Master from here on'));
    } else loaded[id].hFirst = null;
    data.events.forEach(ev => { const n = render(ev, data.agent); if (n) logEl.appendChild(n); });
    if (data.partial) delta(id, data.partial);
    updateOlder(id);
    status(data.agent); hint(data.agent); scrollBottom(); handlers.seen(id);
  }
  async function older() {
    const id = current, st = loaded[id]; if (!st) return;
    if (st.term) return termOlder(id);
    const keep = logEl.scrollHeight, frag = document.createDocumentFragment();
    if (st.total > st.shown && st.first) {   // older stored events first, then the saved history pages
      const data = await load(id, st.first); if (!data || current !== id) return;
      data.events.forEach(ev => { const n = render(ev, agents[id]); if (n) frag.appendChild(n); });
      if (data.events.length) { st.first = data.events[0].id; st.shown += data.events.length; }
    } else if (st.hFirst != null && st.hFirst > 0) {
      const h = await loadHistory(id, st.hFirst); if (!h || current !== id) return;
      (h.entries || []).forEach(e => { const n = renderTranscript(e); if (n) frag.appendChild(n); });
      st.hFirst = (h.entries && h.entries.length) ? h.entries[0].seq : 0;
    }
    const anchor = logEl.firstChild; logEl.insertBefore(frag, anchor); logEl.scrollTop += logEl.scrollHeight - keep;
    updateOlder(id);
  }
  function updateOlder(id) {
    const st = loaded[id]; if (!st) { olderBtn.hidden = true; return; }
    const remain = st.term ? Math.max(0, st.total - st.shown) : Math.max(0, (st.total - st.shown)) + (st.hFirst != null ? st.hFirst : 0);
    olderBtn.hidden = remain <= 0;
    olderBtn.textContent = remain > 0 ? `load ${remain} earlier message${remain === 1 ? '' : 's'}` : 'load older';
  }
  function hide() { current = null; root.hidden = true; if (termTimer) { clearInterval(termTimer); termTimer = null; } }

  // ── conversation view of a Claude Code TERMINAL (t:<id>) ──
  // The entries are Claude Code's own transcript, wrapped to this device's width; prompts and keys go to the pty.
  // Every device keeps its own view of the same session: a phone reads it as a conversation while the desktop and
  // the console keep the real terminal, and nothing here ever resizes the pty.
  let termTimer = null;
  function termLoad(pid, limit, offset) {
    const q = new URLSearchParams({ pane_id: pid, limit, offset, full: 1 }); if (window.SESSION) q.set('session', window.SESSION);
    return fetch('/api/transcript?' + q).then(r => r.ok ? r.json() : null).catch(() => null);
  }
  function appendEntries(entries) { entries.forEach(e => { const n = renderTranscript(e); if (n) logEl.appendChild(n); }); }
  async function showTerm(pid) {
    current = pid; root.hidden = false; logEl.innerHTML = ''; streaming = null;
    if (termTimer) { clearInterval(termTimer); termTimer = null; }
    const st = loaded[pid] = { term: true, total: 0, shown: 0, busy: false };
    const r = await termLoad(pid, PAGE, 0); if (current !== pid) return;
    st.total = (r && r.total) || 0;
    if (r && r.entries && r.entries.length) { appendEntries(r.entries); st.shown = r.entries.length; }
    else logEl.appendChild(el('sys', (r && r.note) || 'no conversation yet: type a prompt below'));
    updateOlder(pid); scrollBottom(); handlers.tseen(pid);
    termTimer = setInterval(() => termRefresh(pid), 3000);
  }
  async function termRefresh(pid) {
    const st = loaded[pid]; if (current !== pid || !st || !st.term || st.busy || document.hidden) return;
    st.busy = true;
    try {
      const r = await termLoad(pid, PAGE, 0); if (!r || !r.entries || current !== pid) return;
      const fresh = r.total - st.total; if (fresh <= 0) return;
      const stick = atBottom();
      if (fresh < PAGE) { appendEntries(r.entries.slice(-fresh)); st.shown += fresh; }
      else { logEl.innerHTML = ''; appendEntries(r.entries); st.shown = r.entries.length; }
      st.total = r.total; updateOlder(pid); if (stick) scrollBottom();
    } finally { st.busy = false; }
  }
  async function termOlder(pid) {
    const st = loaded[pid]; if (!st || st.busy || st.shown >= st.total) { updateOlder(pid); return; }
    st.busy = true;
    try {
      const keep = logEl.scrollHeight, r = await termLoad(pid, PAGE, st.shown);
      if (!r || !r.entries || !r.entries.length || current !== pid) return;
      const frag = document.createDocumentFragment(); r.entries.forEach(e => { const n = renderTranscript(e); if (n) frag.appendChild(n); });
      logEl.insertBefore(frag, logEl.firstChild); logEl.scrollTop += logEl.scrollHeight - keep;
      st.shown += r.entries.length; st.total = Math.max(st.total, r.total || 0); updateOlder(pid);
    } finally { st.busy = false; }
  }
  function termStatus(pid, pane, ws) {
    if (pid !== current || !isTerm(pid)) return;
    const p = pane || {}, st = p.agent_status || (ws && ws.agent_status) || 'idle', cc = p.claude || {};
    const txt = st === 'working' ? 'working…' : st === 'blocked' ? (p.question || 'waiting for your answer') : st === 'done' ? 'done, waiting for your next prompt' : st === 'idle' ? 'idle' : st;
    const keys = st === 'blocked' ? '<span class="chat-keys"><button data-k="\r">Enter</button><button data-k="y">y</button><button data-k="n">n</button><button data-k="\u001b">Esc</button></span>' : '';
    const cost = cc.cost != null ? ` · $${Number(cc.cost).toFixed(2)}` : '';
    statusEl.innerHTML = `<span class="tree-dot ${st}"></span><span class="st">${esc(txt)}</span>${keys}<span class="meta">${esc(cc.model || p.model || '')}${cost}${p.running === false ? ' · process not running' : ''}</span>`;
    statusEl.querySelectorAll('.chat-keys button').forEach(b => { b.onclick = () => handlers.tkey(pid, b.dataset.k); });
    if (hintEl) hintEl.innerHTML = '<span class="hk">▶▶</span> <span class="hm">conversation view</span> <span class="hd">of this terminal · shift+tab cycles the mode · esc interrupts · "terminal" in the tab row shows the real screen</span>';
  }
  function event(id, ev) {
    if (id === current) {
      const stick = atBottom();
      if (ev.kind === 'assistant' && streaming) { streaming.remove(); streaming = null; }
      if (ev.kind === 'decision') logEl.querySelectorAll(`.perm.pending[data-rid="${ev.data.request_id}"]`).forEach(c => { c.classList.remove('pending'); const a = c.querySelector('.actions'); if (a) a.remove(); });
      const n = render(ev, agents[id], true); if (n) logEl.appendChild(n);
      if (loaded[id]) { loaded[id].shown++; loaded[id].total++; }
      if (stick) scrollBottom();
    }
  }
  function delta(id, text) {
    if (id !== current) return;
    const stick = atBottom();
    if (!streaming) { streaming = line('asst streaming', '⏺', 'bul', ''); logEl.appendChild(streaming); streaming._text = ''; }
    streaming._text += text; streaming.querySelector('.tx').innerHTML = md(streaming._text);
    if (stick) scrollBottom();
  }
  function status(agent) {
    if (!agent) return; agents[agent.id] = agent;
    if (agent.id !== current) return;
    const st = agent.status, txt = st === 'working' ? 'working…' : st === 'blocked' ? (agent.question || 'waiting for your approval') : st === 'done' ? 'done, waiting for your next prompt' : st === 'idle' ? 'idle' : st;
    statusEl.innerHTML = `<span class="tree-dot ${st}"></span><span class="st">${esc(txt)}</span><span class="meta">${esc(agent.model || '')}${agent.turns ? ` · ${agent.turns} turns` : ''}${agent.cost ? ` · ${fmtCost(agent.cost)}` : ''}${agent.running ? '' : ' · process not running (starts with the next prompt)'}${agent.error ? ' · ' + esc(agent.error) : ''}</span>`;
    // permission cards follow the pending list
    const pendingIds = new Set((agent.pending || []).map(p => p.request_id));
    logEl.querySelectorAll('.perm.pending').forEach(c => { if (!pendingIds.has(c.dataset.rid)) { c.classList.remove('pending'); const a = c.querySelector('.actions'); if (a) a.remove(); } });
    hint(agent);
  }
  function pending(id) { const a = agents[id]; return a && a.pending && a.pending.length ? a.pending[0].request_id : null; }
  function hist(id) { try { return JSON.parse(localStorage.getItem('ah:' + id) || '[]'); } catch (e) { return []; } }
  function pushHist(id, t) { try { const h = hist(id).filter(x => x !== t); h.unshift(t); localStorage.setItem('ah:' + id, JSON.stringify(h.slice(0, 50))); } catch (e) { } }
  let hi = -1, hdraft = '';
  function init(els) {
    root = els.root; logEl = els.log; statusEl = els.status; olderBtn = els.older; olderBtn.onclick = older;
    input = els.input; hintEl = els.hint;
    const submit = () => { const v = input.value.trim(); if (!v || !current) return; (isTerm(current) ? handlers.tprompt : handlers.prompt)(current, v); pushHist(current, v); hi = -1; input.value = ''; input.style.height = ''; };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); return; }
      if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); (isTerm(current) ? handlers.tmode : handlers.mode)(current); return; }
      if (e.key === 'Escape') { e.preventDefault(); (isTerm(current) ? handlers.tinterrupt : handlers.interrupt)(current); return; }
      const h = hist(current);
      if (e.key === 'ArrowUp' && (input.selectionStart === 0 || !input.value)) { if (!h.length) return; e.preventDefault(); if (hi < 0) hdraft = input.value; hi = Math.min(h.length - 1, hi + 1); input.value = h[hi]; grow(); }
      else if (e.key === 'ArrowDown' && hi >= 0) { e.preventDefault(); hi--; input.value = hi < 0 ? hdraft : h[hi]; grow(); }
    });
    const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(160, input.scrollHeight) + 'px'; };
    input.addEventListener('input', grow);
  }
  function hint(agent) {
    if (!hintEl) return;
    const pm = agent && agent.permission_mode;
    const mode = pm === 'acceptEdits' ? 'auto mode on' : pm === 'plan' ? 'plan mode on' : pm === 'bypassPermissions' ? 'bypass mode on' : 'auto mode off';
    hintEl.innerHTML = `<span class="hk">▶▶</span> <span class="hm">${esc(mode)}</span> <span class="hd">(shift+tab to cycle) · ⧉ ${esc((agent && agent.model) || 'default')} · ← for agents</span>`;
  }
  function focus() { if (input) input.focus(); }
  return { init, show, showTerm, termStatus, hide, event, delta, status, pending, focus, md, on(n, f) { handlers[n] = f; }, get current() { return current; }, agent: id => agents[id] };
})();
