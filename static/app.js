/* Agent-Master: app shell. State over websocket, office, chat, terminals, prompts, palette. */
'use strict';

const $ = id => document.getElementById(id);
const SESSION = new URLSearchParams(location.search).get('session') || '';
let STATE = { workspaces: [], panes: [], server: null, connected: false };
let PREFS = { costumes: {}, desks: {}, templates: [] };
let USERNAME = '';
let selected = null, selectedPane = null;
const paneMemory = (() => { try { return JSON.parse(localStorage.getItem('agent-master-panes') || '{}'); } catch (e) { return {}; } })();
function rememberSelection() { try { localStorage.setItem('agent-master-sel:' + sessionName(), selected || ''); localStorage.setItem('agent-master-panes', JSON.stringify(paneMemory)); } catch (e) { } }
function lastSelection() { try { return localStorage.getItem('agent-master-sel:' + sessionName()) || null; } catch (e) { return null; } }
const opts = loadOpts();

function loadOpts() { try { return Object.assign({ notifyBlocked: false, notifyDone: false, sound: false, light: false }, JSON.parse(localStorage.getItem('agent-master-opts') || '{}')); } catch (e) { return { notifyBlocked: false, notifyDone: false, sound: false, light: false }; } }
function saveOpts() { try { localStorage.setItem('agent-master-opts', JSON.stringify(opts)); } catch (e) { } }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmtAge(sec) { if (sec < 60) return Math.floor(sec) + 's'; if (sec < 3600) return Math.floor(sec / 60) + 'm'; return Math.floor(sec / 3600) + 'h' + String(Math.floor((sec % 3600) / 60)).padStart(2, '0'); }
function fmtDur(sec) { if (sec < 60) return Math.round(sec) + 's'; if (sec < 3600) return Math.round(sec / 60) + 'm'; return (sec / 3600).toFixed(1) + 'h'; }
function wsById(id) { return STATE.workspaces.find(w => w.workspace_id === id); }
function panesOf(id) { return STATE.panes.filter(p => p.workspace_id === id); }
function isHeadless(id) { return typeof id === 'string' && id.startsWith('a:'); }
function isLocal(id) { return typeof id === 'string' && id.startsWith('t:'); }   // a terminal run by agent-masterd on this machine
let TERMINALS = false; const openLocal = new Set();
let CODE = false;   // VS Code (code serve-web) is running behind /code/
let HOME = '';      // the machine's home folder, shown as ~ in paths
function tildePath(p) { return HOME && p && (p === HOME || p.startsWith(HOME + '/')) ? '~' + p.slice(HOME.length) : p; }
function tildePaths(text) { return HOME && text ? text.split(HOME + '/').join('~/').split(HOME).join('~') : text; }   // display only: every home path in a block of text as ~
function agentIdOf(id) { return isHeadless(id) ? id.slice(2) : null; }
function firstPane(id) { const ps = panesOf(id); return (ps.find(p => p.agent) || ps.find(p => p.focused) || ps[0] || {}).pane_id || null; }
function statusOf(w) { const mine = panesOf(w.workspace_id); if (mine.length && !mine.some(p => p.agent)) return 'none'; return w.agent_status || 'unknown'; }
function sessionName() { return STATE.session || SESSION || 'default'; }

// ───────────────────────── office ─────────────────────────
Office.init({ wrap: $('office-wrap'), stage: $('stage'), canvas: $('office'), labels: $('labels'), balloons: $('balloons') });
Office.on('select', id => { selectWorkspace(id); openAgentCard(id); });
// ───────────────────────── character card ─────────────────────────
let cardId = null;
function fmtTokens(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : String(n); }
function fmtDurLong(sec) { sec = Math.max(0, Math.floor(sec)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60); return h ? `${h}h ${String(m).padStart(2, '0')}m` : m ? `${m}m ${String(sec % 60).padStart(2, '0')}s` : `${sec}s`; }
function agentLabel(agent) { return ({ claude: 'Claude Code', codex: 'Codex CLI', opencode: 'OpenCode', copilot: 'Copilot CLI', gemini: 'Gemini CLI', aider: 'Aider', pi: 'Pi', omp: 'OMP', kilo: 'Kilo Code', letta: 'Letta Code' })[agent] || agent || 'no agent';
}
function placeAgentCard(id) {
  const card = $('agent-card'), a = Office.agents().find(x => x.id === id), wrap = $('office-wrap'), v = Office.view();
  if (!a) { card.style.left = (wrap.getBoundingClientRect().left + 12) + 'px'; card.style.top = (wrap.getBoundingClientRect().top + 12) + 'px'; return; }
  const stage = $('stage').getBoundingClientRect(), wr = wrap.getBoundingClientRect();
  let left = stage.left - wr.left + (a.px - v.VX + 20) * v.SCALE, top = stage.top - wr.top + (a.py - v.VY - 10) * v.SCALE;
  const cw = Math.min(340, wr.width - 16), ch = card.offsetHeight || 260;
  if (left + cw > wr.width - 8) left = Math.max(8, stage.left - wr.left + (a.px - v.VX - 4) * v.SCALE - cw);
  if (top + ch > wr.height - 8) top = Math.max(8, wr.height - ch - 8);
  card.style.left = (wr.left + window.scrollX + Math.max(8, left)) + 'px'; card.style.top = (wr.top + window.scrollY + Math.max(8, top)) + 'px';
}
async function openAgentCard(id) {
  const w = wsById(id); if (!w) return;
  cardId = id;
  const card = $('agent-card'), body = $('ac-body');
  $('ac-name').textContent = w.label + (isHeadless(id) ? ' · headless' : ''); $('ac-dot').className = 'tree-dot ' + statusOf(w);
  $('ac-open').textContent = isHeadless(id) ? 'conversation' : 'terminal'; $('ac-history').hidden = isHeadless(id);
  body.innerHTML = '<span class="k">loading</span><span class="v">...</span>'; card.hidden = false; placeAgentCard(id);
  let info = null;
  try { const r = await fetch('/api/agent_info?workspace_id=' + encodeURIComponent(id) + (SESSION ? '&session=' + encodeURIComponent(SESSION) : '')); if (r.ok) info = await r.json(); } catch (e) { }
  if (cardId !== id) return;
  const rows = [], now = Date.now() / 1000;
  const row = (k, val, cls) => { if (val == null || val === '') return; rows.push(`<span class="k">${k}</span><span class="v ${cls || ''}" title="${String(val).replace(/"/g, '&quot;')}">${String(val).replace(/</g, '&lt;')}</span>`); };
  const sec = t => rows.push(`<span class="sec">${t}</span>`);
  const p = (info && info.pane) || {}, s = (info && info.session) || null, st = statusOf(w);
  row('agent', agentLabel(p.agent) + (s && s.version ? ' ' + s.version : ''));
  row('model', s && s.model ? s.model + (s.effort ? ' · effort ' + s.effort : '') : (p.agent ? 'not reported yet' : null), 'wrap');
  if (s && s.models && s.models.length > 1) row('also used', s.models.slice(1).join(', '));
  rows.push(`<span class="k">status</span><span class="v st ${st}">${st === 'none' ? 'no agent' : st}${w.status_since ? ' for ' + fmtDurLong(now - w.status_since) : ''}</span>`);
  row('task', p.task, 'wrap'); row('asks', p.question, 'wrap');
  sec('workspace');
  row('id', `${w.workspace_id}${p.pane_id ? ' · pane ' + p.pane_id : ''}`); row('folder', tildePath(p.foreground_cwd || p.cwd)); row('branch', p.branch); row('terminal', p.terminal_title_stripped);
  if (s) {
    sec('session');
    row('session id', p.session_id ? p.session_id.slice(0, 8) + '…' + p.session_id.slice(-4) : null);
    row('started', s.first_ts ? new Date(s.first_ts).toLocaleString() : null); row('last reply', s.last_ts ? new Date(s.last_ts).toLocaleString() : null);
    row('prompts', `${s.prompts} prompts · ${s.replies} replies · ${s.tool_calls} tool calls`, 'wrap');
    const t = s.tokens || {}; row('tokens', `in ${fmtTokens(t.input)} · out ${fmtTokens(t.output)} · thinking ${fmtTokens(t.thinking)}`, 'wrap'); row('cache', `read ${fmtTokens(t.cache_read)} · write ${fmtTokens(t.cache_write)}`, 'wrap');
  } else if (p.session_id) { sec('session'); row('session id', p.session_id.slice(0, 8) + '…', ''); row('transcript', 'not found on this machine'); }
  const cc = (STATE.panes.find(x => x.pane_id === (p.pane_id || '')) || {}).claude;
  if (cc) {
    sec('claude code');
    row('session name', cc.name);
    row('version', cc.version + (cc.update ? ` · ${cc.installed} installed, restart to use it` : ' · up to date'), cc.update ? 'wrap' : '');
    row('model', [cc.model, cc.thinking ? 'thinking on' : null, cc.fast ? 'fast mode' : null].filter(Boolean).join(' · '));
    if (cc.context_pct != null) row('context', `${cc.context_pct}% of ${fmtTokens(cc.context_size || 0)}`);
    if (cc.cost != null) row('cost', `$${cc.cost.toFixed(2)} this run` + (cc.duration_ms ? ` · ${fmtDurLong(cc.duration_ms / 1000)}` : ''));
    if (cc.lines_added || cc.lines_removed) row('lines', `+${cc.lines_added || 0} -${cc.lines_removed || 0}`);
    if (cc.cache_warm != null) row('prompt cache', cc.cache_warm ? 'warm' + (cc.cache_expires ? ' until ' + new Date(cc.cache_expires * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '') : 'cold');
    if (cc.limit_5h != null || cc.limit_7d != null) row('limits', `5h ${cc.limit_5h}% · 7d ${cc.limit_7d}%`);
  }
  const tm = info && info.time; if (tm && tm.seconds) { sec('last 24 h'); row('time', ['working', 'blocked', 'done', 'idle'].filter(k => tm.seconds[k] > 30).map(k => `${k} ${fmtDurLong(tm.seconds[k])}`).join(' · ') || 'nothing recorded'); if (tm.blocked_count || tm.done_count) row('counts', `${tm.done_count || 0} done · ${tm.blocked_count || 0} blocked`); }
  $('ac-adopt').hidden = !isHeadless(id);
  $('ac-edit').hidden = !codeUrl(id);
  const psPane = STATE.panes.find(x => x.pane_id === (p.pane_id || '')) || {};
  const pinBtn = $('ac-pinsize'); pinBtn.hidden = !isLocal(p.pane_id);
  pinBtn.textContent = (psPane.fixed_cols && psPane.fixed_rows) ? `unpin size (${psPane.fixed_cols}×${psPane.fixed_rows})` : 'pin size';
  if (psPane.prev_session_id && isLocal(p.pane_id)) { sec('session change'); row('previous session', psPane.prev_session_id.slice(0, 8) + '…' + psPane.prev_session_id.slice(-4) + ' · use the "previous session" button to go back', 'wrap'); }
  $('ac-prevsess').hidden = !(psPane.prev_session_id && isLocal(p.pane_id) && p.agent === 'claude');
  body.innerHTML = rows.join(''); placeAgentCard(id);
}
$('ac-prevsess').onclick = () => {
  const w = wsById(cardId), pid = firstPane(cardId); if (!w || !pid) return;
  const p = STATE.panes.find(x => x.pane_id === pid) || {}, prev = p.prev_session_id; if (!prev) return;
  askConfirm(`Go back to the previous session of ${w.label}?`, `Claude Code is restarted with --resume ${prev.slice(0, 8)}…; the conversation from that session comes back. The current session ${(p.agent_session && p.agent_session.value || '').slice(0, 8)}… stays on disk and becomes the "previous" one.`, 'Resume previous session', async () => {
    closeAgentCard();
    const r = await action({ action: 'set_session', pane_id: pid, session_id: prev });
    if (r && r.error) { toast('could not switch session: ' + r.error, 'blocked'); return; }
    const r2 = await action({ action: 'restart', workspace_id: w.workspace_id });
    if (r2 && r2.error) toast('switched, but restart failed: ' + r2.error, 'blocked'); else toast(`${w.label}: resuming session ${prev.slice(0, 8)}…`, 'done', w.workspace_id);
  });
};
function closeAgentCard() { $('agent-card').hidden = true; cardId = null; }
$('ac-x').onclick = closeAgentCard;
$('ac-open').onclick = () => { if (cardId) { selectWorkspace(cardId); closeAgentCard(); if (!isHeadless(cardId)) Terms.focus(); } };
$('ac-adopt').onclick = async () => {
  const w = wsById(cardId); if (!w || !isHeadless(cardId)) return;
  askConfirm(`Move ${w.label} to a terminal?`, 'Agent-Master starts Claude Code in a real terminal on this machine that resumes this same session, and stops the headless copy. The conversation continues where it is.', 'Move to terminal', async () => {
    closeAgentCard();
    let r = null; try { const resp = await fetch('/api/terms/from-headless', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [agentIdOf(w.workspace_id)], session: SESSION || undefined }) }); r = await resp.json(); } catch (e) { r = { error: String(e) }; }
    const target = r && r.moved && r.moved[0] && r.moved[0].workspace_id;
    if (r && r.ok && target) { toast(`${w.label} now runs in a terminal`, 'idle', target); send({ type: 'refresh' }); setTimeout(() => selectWorkspace(target), 800); }
    else toast('move failed: ' + ((r && (r.error || (r.failed && r.failed[0] && r.failed[0].error))) || 'unknown'), 'blocked');
  });
};
$('ac-history').onclick = () => { if (cardId) { selectWorkspace(cardId); closeAgentCard(); showTranscript(true); } };
// VS Code in a new tab, opened on the workspace's folder; served through this app, so the same sign-in applies
function codeUrl(id) { const p = STATE.panes.find(x => x.workspace_id === id && x.cwd); return CODE && p ? '/code/?folder=' + encodeURIComponent(p.cwd) : null; }
function openCode(id) { const u = codeUrl(id); if (!u) { toast('VS Code is not running on the machine (systemctl --user start agent-master-code)', 'blocked'); return; } window.open(u, '_blank', 'noopener'); }
// the button gives focus back afterwards: a button that kept focus would open the editor again on the next Enter or Space typed on the page
$('edit').onclick = e => { e.currentTarget.blur(); if (selected) openCode(selected); Terms.focus(); };
$('ribbon-edit').onclick = e => { e.currentTarget.blur(); if (selected) openCode(selected); };
$('ac-edit').onclick = e => { e.currentTarget.blur(); if (cardId) { const id = cardId; closeAgentCard(); openCode(id); } };
$('ac-costume').onclick = () => { const w = wsById(cardId); if (w) { closeAgentCard(); openCostume(w.label); } };
$('ac-pinsize').onclick = async () => {
  const pid = firstPane(cardId); if (!pid || !isLocal(pid)) return;
  const p = STATE.panes.find(x => x.pane_id === pid) || {};
  if (p.fixed_cols && p.fixed_rows) {
    await action({ action: 'set_size', pane_id: pid, fixed_cols: null, fixed_rows: null });
    toast('size unpinned', 'idle');
  } else {
    const sz = Terms.size(pid);
    const ans = window.prompt('Pin this terminal to a fixed size. Every viewer (desktop, phone, console) will render at this size instead of resizing the terminal.\n\nEnter as COLSxROWS (e.g. 120x36):', `${sz.cols || 120}x${sz.rows || 36}`);
    if (!ans) return;
    const m = /^\s*(\d+)\s*[x×*]\s*(\d+)\s*$/i.exec(ans);
    if (!m) { toast('bad size — use COLSxROWS', 'blocked'); return; }
    const cols = Math.max(20, Math.min(500, +m[1])), rows = Math.max(5, Math.min(200, +m[2]));
    await action({ action: 'set_size', pane_id: pid, fixed_cols: cols, fixed_rows: rows });
    toast(`size pinned to ${cols}×${rows}`, 'done');
  }
  closeAgentCard();
};
document.addEventListener('mousedown', e => { if (!$('agent-card').hidden && !e.target.closest('#agent-card') && !e.target.closest('#office-wrap canvas')) closeAgentCard(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('agent-card').hidden) closeAgentCard(); });
Office.on('context', (id, x, y) => showContext(id, x, y));
Office.on('seat', (label, deskIndex) => { PREFS.desks = PREFS.desks || {}; PREFS.desks[label] = deskIndex; savePrefs(); toast(`${label} now sits at desk ${deskIndex + 1}`, 'unknown'); });
Office.on('chat', (a, b, activities) => { if (!sock || sock.readyState !== 1) return false; if ((PREFS.chatter || {}).mode === 'off') return false; send({ type: 'chat', a, b, activities }); return true; });

// ───────────────────────── toasts + notifications ─────────────────────────
const toastsEl = $('toasts');
let unseen = 0;
function toast(text, status, wsId) {
  const el = document.createElement('div'); el.className = 'toast';
  const dot = document.createElement('span'); dot.className = 'tree-dot ' + (status || ''); el.appendChild(dot);
  el.appendChild(document.createTextNode(text));
  if (wsId) el.onclick = () => selectWorkspace(wsId);
  toastsEl.prepend(el);
  while (toastsEl.children.length > 5) toastsEl.lastChild.remove();
  setTimeout(() => el.remove(), 7000);
  remember(text, status, wsId);
  if (document.hidden || $('notif-pop').hidden) { unseen++; $('bell-badge').textContent = unseen; $('bell-badge').hidden = false; }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('notif-pop').hidden) { unseen = 0; $('bell-badge').hidden = true; } });
let audio = null;
function beep(kind) {
  if (!opts.sound) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const t = audio.currentTime, notes = kind === 'blocked' ? [660, 520] : [520, 780];
    notes.forEach((f, i) => { const o = audio.createOscillator(), g = audio.createGain(); o.type = 'square'; o.frequency.value = f; g.gain.value = 0.04; o.connect(g); g.connect(audio.destination); o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.1); });
  } catch (e) { }
}
function notify(title, body, wsId) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try { const n = new Notification(title, { body, tag: 'agent-master-' + wsId, silent: true }); n.onclick = () => { window.focus(); selectWorkspace(wsId); n.close(); }; } catch (e) { }
}
function onStatus(a, prev, st) {
  if (st === 'blocked') { beep('blocked'); if (opts.notifyBlocked) notify(`${a.name} is blocked`, a.task || 'needs your input', a.id); }
  if (st === 'done') { beep('done'); if (opts.notifyDone) notify(`${a.name} is done`, a.task || 'ready for review', a.id); }
}

// ───────────────────────── state ─────────────────────────
function applyState(state, events) {
  STATE = state;
  Office.sync(state.workspaces || [], state.panes || [], events || [], { toast, status: onStatus });
  $('office-empty').hidden = (state.workspaces || []).length > 0;
  let firstSelect = false;
  if (!selected || !wsById(selected)) { const last = lastSelection(); const f = (last && wsById(last) ? last : null) || Office.selected || (state.workspaces[0] || {}).workspace_id; if (f) { selected = f; selectedPane = paneMemory[f] || null; firstSelect = true; Office.select(f, false); } }
  renderAll();
  if (firstSelect) setTimeout(() => Terms.focus(), 300);
}
function renderAll() { renderSidebar(); renderTermTabs(); renderAttention(); renderStatus(); renderStrip(); }
// the strip above the office: what the selected agent is doing, and team counters that jump to the next agent in that state
function renderStrip() {
  const now = Date.now() / 1000, w = wsById(selected), el = $('strip-agent'); el.innerHTML = '';
  if (w) {
    const st = statusOf(w), p = panesOf(w.workspace_id).find(x => x.agent) || panesOf(w.workspace_id)[0] || {};
    const add = (cls, text) => { const s = document.createElement('span'); s.className = cls; s.textContent = text; el.appendChild(s); return s; };
    const dot = document.createElement('span'); dot.className = 'tree-dot ' + st; el.appendChild(dot);
    add('name', w.label);
    const branch = p.branch || w.branch; if (branch) { add('sep', '·'); add('branch', branch); }
    add('sep', '·'); add('st ' + st, st === 'none' ? 'no agent' : st + (w.status_since ? ' ' + fmtAge(now - w.status_since) : ''));
    const cc = p.claude;   // Claude Code's own numbers for this agent
    if (cc) {
      const bits = [cc.model, cc.context_pct != null ? `context ${cc.context_pct}%` : null, cc.cost ? '$' + cc.cost.toFixed(2) : null,
        (cc.lines_added || cc.lines_removed) ? `+${cc.lines_added || 0} -${cc.lines_removed || 0}` : null].filter(Boolean);
      if (bits.length) { add('sep', '·'); add('cc', bits.join(' · ')); }
      if (cc.update) { add('sep', '·'); const u = add('upd', `update ${cc.installed} ready: restart`); u.title = `This agent runs Claude Code ${cc.version}; ${cc.installed} is installed. Restart the process to use it (the session is resumed).`; u.onclick = () => askConfirm(`Restart ${w.label}?`, `Claude Code ${cc.installed} is installed; ${w.label} still runs ${cc.version}. Restarting resumes the same session with the new version.` + (st === 'working' ? ' It is working right now: the current turn will be cut off.' : ''), 'Restart', () => action({ action: 'restart', workspace_id: w.workspace_id })); }
    }
  }
  renderLimits();
  const counts = {}; STATE.workspaces.forEach(x => { const s = statusOf(x); counts[s] = (counts[s] || 0) + 1; });
  const box = $('strip-counts');
  if (!box.children.length) ['working', 'blocked', 'done', 'idle', 'none'].forEach(s => {   // four little characters, one per state (built once, animated below)
    const chip = document.createElement('span'); chip.className = 'chip ' + s; const cv = document.createElement('canvas'); cv.width = 52; cv.height = 68; chip.appendChild(cv);
    chip.onclick = () => { const list = STATE.workspaces.filter(x => statusOf(x) === s); if (!list.length) return; const i = list.findIndex(x => x.workspace_id === selected); selectWorkspace(list[(i + 1) % list.length].workspace_id); };
    box.appendChild(chip); STRIP_MINIS.push({ status: s, canvas: cv, chip });
  });
  STRIP_MINIS.forEach(m => { const n = counts[m.status] || 0; m.chip.classList.toggle('zero', !n); const label = m.status === 'none' ? 'without an agent' : m.status; m.chip.title = n ? `${n} ${label}: click for the next one` : `none ${label}`; });
}
function renderLimits() {   // account-wide usage limits: the freshest numbers any agent reported
  const cc = STATE.panes.map(p => p.claude).filter(c => c && (c.limit_5h != null || c.limit_7d != null));
  const el = $('sb-limits'); if (!cc.length) { el.textContent = ''; return; }
  const pick = k => Math.max(...cc.map(c => c[k] == null ? -1 : c[k])), h5 = pick('limit_5h'), d7 = pick('limit_7d');
  const reset = k => { const t = Math.max(...cc.map(c => c[k] || 0)); return t ? new Date(t * 1000).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '?'; };
  el.innerHTML = `limits <span class="${h5 >= 80 ? 'hot' : ''}">5h ${h5}%</span> · <span class="${d7 >= 80 ? 'hot' : ''}">7d ${d7}%</span>`;
  el.title = `Claude usage limits (from Claude Code's status line)\n5 hours: ${h5}% used, resets ${reset('limit_5h_reset')}\n7 days: ${d7}% used, resets ${reset('limit_7d_reset')}`;
}
const STRIP_MINIS = []; let miniFrame = 0;
function animateMinis() { if (!document.hidden) { miniFrame++; STRIP_MINIS.forEach(m => Office.drawMini(m.canvas, m.status, miniFrame)); } setTimeout(() => requestAnimationFrame(animateMinis), 70); }
animateMinis();

// ───────────────────────── sidebar ─────────────────────────
const recent = [];   // recent events for the bell popover and the explorer
function remember(text, status, wsId) {
  recent.unshift({ text, status, wsId, ts: Date.now() });
  if (recent.length > 40) recent.pop();
  renderRecent();
}
function renderRecent() {
  const list = $('notif-list'); list.innerHTML = '';
  recent.forEach(r => { const el = document.createElement('div'); el.className = 'notif-item'; el.innerHTML = `<span class="tree-dot ${r.status || ''}"></span><span></span><span class="when">${new Date(r.ts).toLocaleTimeString('en-GB')}</span>`; el.children[1].textContent = r.text; if (r.wsId) el.onclick = () => { selectWorkspace(r.wsId); $('notif-pop').hidden = true; }; list.appendChild(el); });
  if (!recent.length) list.innerHTML = '<div class="notif-empty">Nothing yet. Status changes, visits and openings show up here.</div>';
}
function renderSidebar() { }
function renderServerInfo() {
  const srv = $('settings-server'); srv.innerHTML = '';
  const kv = (k, v, cls) => { const b = document.createElement('b'); b.textContent = k; const s = document.createElement('span'); s.className = cls || ''; s.textContent = v; srv.appendChild(b); srv.appendChild(s); };
  kv('terminals', STATE.terminals ? 'agent-masterd running' : 'agent-masterd not running', STATE.terminals ? 'c-green' : 'c-dim');
  kv('session', sessionName()); kv('web', location.origin);
  const branches = STATE.panes.filter(p => p.branch).map(p => `${(wsById(p.workspace_id) || {}).label}: ${p.branch}${p.left_root ? ' (left root)' : ''}`);
  kv('branches', branches.length ? branches.join(', ') : 'none detected');
}
function renderStatus() {
  const byStatus = {}; STATE.workspaces.forEach(w => { const s = statusOf(w); byStatus[s] = (byStatus[s] || 0) + 1; });
  const parts = [`${STATE.workspaces.length} workspaces`]; ['working', 'blocked', 'done', 'idle'].forEach(s => { if (byStatus[s]) parts.push(`${byStatus[s]} ${s}`); });
  $('sb-counts').textContent = parts.join(' · ');
  $('sb-version').textContent = sessionName();
  $('sb-conn').textContent = STATE.terminals ? 'connected' : 'terminal server offline';
  document.body.classList.toggle('offline', !STATE.terminals);
  document.title = `Agent-Master · ${sessionName()} · ${location.hostname}`;
  const n = attentionItems().filter(i => i.status === 'blocked').length; $('attn-badge').textContent = n; $('attn-badge').hidden = !n;
}

// ───────────────────────── attention queue ─────────────────────────
const LONG_RUN = 20 * 60;
function attentionItems() {
  const now = Date.now() / 1000, out = [];
  STATE.workspaces.forEach(w => {
    const st = statusOf(w), age = now - (w.status_since || now), p = panesOf(w.workspace_id).find(x => x.agent) || panesOf(w.workspace_id)[0] || {};
    if (st === 'blocked') out.push({ id: w.workspace_id, label: w.label, status: st, age, task: p.task, question: p.question, pane: p.pane_id, rank: 0 });
    else if (st === 'done') out.push({ id: w.workspace_id, label: w.label, status: st, age, task: p.task, pane: p.pane_id, rank: 1 });
    else if (st === 'working' && age > LONG_RUN) out.push({ id: w.workspace_id, label: w.label, status: st, age, task: p.task, pane: p.pane_id, rank: 2, long: true });
  });
  return out.sort((a, b) => a.rank - b.rank || b.age - a.age);
}
function renderAttention() {
  const list = $('attn-list'); list.innerHTML = '';
  const items = attentionItems();
  $('attention').classList.toggle('empty', !items.length);
  items.forEach(it => {
    const el = document.createElement('div'); el.className = 'attn-item';
    const keys = it.status === 'blocked' ? ['\r|Enter', 'y\r|y', 'n\r|n', '\u001b|Esc'] : [];
    el.innerHTML = `<span class="tree-dot ${it.status}"></span><div class="attn-main"><div class="attn-head"><span class="attn-name"></span><span class="attn-age">${it.status}${it.long ? ' for' : ''} ${fmtAge(it.age)}</span></div>${it.task ? `<div class="attn-task">${esc(it.task)}</div>` : ''}${it.question ? `<div class="attn-q">${esc(it.question)}</div>` : ''}</div><div class="attn-actions">${keys.map(k => { const [seq, lab] = k.split('|'); return `<button data-seq="${esc(JSON.stringify(seq))}">${lab}</button>`; }).join('')}${it.status === 'done' ? '<button class="primary" data-review="1" title="Open the pane in the terminal app, which marks it reviewed">review in terminal</button>' : ''}<button data-open="1">open</button></div>`;
    el.querySelector('.attn-name').textContent = it.label;
    el.querySelector('.attn-name').onclick = () => selectWorkspace(it.id);
    el.querySelectorAll('button[data-seq]').forEach(b => b.onclick = () => { if (isHeadless(it.id)) agentQuickKey(it.id, JSON.parse(b.dataset.seq)); else sendInput(it.pane, JSON.parse(b.dataset.seq)); });
    const rv = el.querySelector('button[data-review]'); if (rv) rv.onclick = () => { selectWorkspace(it.id); if (isHeadless(it.id)) send({ type: 'agent_seen', agent_id: agentIdOf(it.id) }); else action({ action: 'seen', workspace_id: it.id }); };   // open it and mark the done task as reviewed
    el.querySelector('button[data-open]').onclick = () => selectWorkspace(it.id);
    list.appendChild(el);
  });
}
setInterval(() => { if (STATE.workspaces.length) { renderAttention(); renderStatus(); } }, 15000);

// ───────────────────────── terminals ─────────────────────────
Terms.init($('term-grid'));
Chat.init({ root: $('chat'), log: $('chat-log'), status: $('chat-status'), older: $('chat-older'), input: $('chat-input'), hint: $('chat-hint') });
Chat.on('prompt', (id, text) => send({ type: 'agent_prompt', agent_id: id, text }));
Chat.on('interrupt', id => send({ type: 'agent_interrupt', agent_id: id }));
Chat.on('mode', id => send({ type: 'agent_mode', agent_id: id }));
Chat.on('answer', (id, rid, allow, remember) => send({ type: 'agent_answer', agent_id: id, request_id: rid, allow, remember }));
Chat.on('seen', id => { const w = wsById('a:' + id); if (w && statusOf(w) === 'done') send({ type: 'agent_seen', agent_id: id }); });
// the conversation view of a real terminal: prompts and keys are typed into the pty, nothing is resized
Chat.on('tprompt', (pid, text) => action({ action: 'send', pane_id: pid, text: text + '\r' }));
Chat.on('tinterrupt', pid => action({ action: 'stop_pane', pane_id: pid }));
Chat.on('tmode', pid => action({ action: 'send', pane_id: pid, text: '\x1b[Z' }));
Chat.on('tkey', (pid, k) => action({ action: 'send', pane_id: pid, text: k }));
Chat.on('tseen', pid => { const p = STATE.panes.find(x => x.pane_id === pid), w = p && wsById(p.workspace_id); if (w && statusOf(w) === 'done') action({ action: 'seen', pane_id: pid }); });
// Which view this DEVICE uses for a Claude Code terminal: the real terminal, or the conversation (its transcript, wrapped
// to this screen). Per device, never shared: a phone can read the conversation while the desktop keeps the terminal.
const VIEW_KEY = 'agent-master-view';
function viewPref() { try { return localStorage.getItem(VIEW_KEY) || 'auto'; } catch (e) { return 'auto'; } }
function setViewPref(v) { try { localStorage.setItem(VIEW_KEY, v); } catch (e) { } }
function localClaude(id) { return isLocal(id) && (STATE.panes.find(x => x.workspace_id === id) || {}).agent === 'claude'; }
function wantConversation(id) { if (!localClaude(id)) return false; const v = viewPref(); return v === 'conversation' || (v === 'auto' && window.innerWidth < 800); }
function feedChatStatus() { const pid = Chat.current; if (!pid || !isLocal(pid)) return; const p = STATE.panes.find(x => x.pane_id === pid); Chat.termStatus(pid, p, p && wsById(p.workspace_id)); }
$('view-toggle').onclick = () => { if (!selected) return; setViewPref(wantConversation(selected) ? 'terminal' : 'conversation'); renderPaneChips(); };
let viewResizeTimer = null;
window.addEventListener('resize', () => { if (viewPref() !== 'auto' || !selected || !localClaude(selected)) return; clearTimeout(viewResizeTimer); viewResizeTimer = setTimeout(renderPaneChips, 150); });
function agentQuickKey(id, seq) {   // quick keys / attention buttons for a headless agent
  const aid = agentIdOf(id), rid = Chat.pending(aid);
  if (seq === '\r' || seq === 'y\r') { if (rid) send({ type: 'agent_answer', agent_id: aid, request_id: rid, allow: true }); else Chat.focus(); }
  else if (seq === 'n\r') { if (rid) send({ type: 'agent_answer', agent_id: aid, request_id: rid, allow: false }); }
  else if (seq === '\u001b' || seq === '\u0003') send({ type: 'agent_interrupt', agent_id: aid });
  else if (seq === '\u001b[Z') send({ type: 'agent_mode', agent_id: aid });   // Shift+Tab: cycle auto mode
}
const diag = { keys: 0, long: [] }; let lastKeyAt = 0;
try { new PerformanceObserver(l => l.getEntries().forEach(e => diag.long.push(Math.round(e.duration)))).observe({ entryTypes: ['longtask'] }); } catch (e) { }
setInterval(() => {
  if (!sock || sock.readyState !== 1) return;
  const ae = document.activeElement;
  send({ type: 'diag', d: { focus: ae ? (ae.tagName + (ae.className ? '.' + String(ae.className).slice(0, 30) : '') + (ae.closest('.term-cell') ? ' in-terminal' : '')) : null, primary: Terms.primary, selected, selectedPane, cells: Terms.ids(), keys5s: diag.keys, hidden: document.hidden, w: innerWidth, dpr: devicePixelRatio, renderer: Terms.renderer(), longTasks5s: diag.long.slice(-12), heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null, ua: navigator.userAgent.slice(0, 120), secure: window.isSecureContext }});
  diag.keys = 0; diag.long = [];
}, 5000);
Terms.on('data', (pid, d) => { diag.keys++; lastKeyAt = Date.now(); send({ type: 'pin', pane_id: pid, d }); });
// cols/rows here are what fits this screen (the natural size); the server decides the pty size from every viewer
Terms.on('resize', (pid, cols, rows) => { if (openLocal.has(pid)) send({ type: 'presize', pane_id: pid, cols, rows }); });
let tabsQueued = false;
Terms.on('change', () => { watchAll(); if (tabsQueued) return; tabsQueued = true; setTimeout(() => { tabsQueued = false; renderTermTabs(); }, 0); });
function paneTitle(pid) { if (isHeadless(pid)) { const w = wsById(pid); return w ? w.label + ' · headless' : pid; }
  if (isLocal(pid)) { const w = wsById(pid), p = STATE.panes.find(x => x.pane_id === pid) || {}, cc = p.claude;
    const extra = cc ? [cc.model, cc.context_pct != null ? `context ${cc.context_pct}%` : null, cc.cost ? '$' + cc.cost.toFixed(2) : null, cc.update ? `update ${cc.installed} ready` : null].filter(Boolean).join(' · ') : '';
    return `${w ? w.label : pid} · ${p.agent || (p.kind === 'command' ? 'command' : 'shell')}${p.cwd ? ' · ' + p.cwd.replace(/^\/home\/[^/]+/, '~') : ''}${extra ? ' · ' + extra : ''}`; } const p = STATE.panes.find(x => x.pane_id === pid); if (!p) return pid; const w = wsById(p.workspace_id); return `${w ? w.label : p.workspace_id} · ${pid.split(':')[1]}${p.agent ? ' · ' + p.agent : ''}`; }
function renderTermTabs() {
  const tabs = $('term-tabs'); tabs.innerHTML = '';
  STATE.workspaces.forEach(w => {
    const st = statusOf(w), pinned = panesOf(w.workspace_id).some(p => Terms.isPinned(p.pane_id));
    const t = document.createElement('div'); t.className = 'term-tab' + (w.workspace_id === selected ? ' active' : '') + (pinned ? ' pinned' : '') + (w.headless ? ' headless' : '');
    t.innerHTML = `<span class="tree-dot ${st}"></span><span></span>${w.headless ? '<span class="hl" title="headless agent">◇</span>' : ''}<span class="x" title="Close workspace">×</span>`; t.children[1].textContent = w.label;
    t.lastChild.onclick = e => { e.stopPropagation(); closeWorkspace(w.workspace_id); };
    t.onclick = () => selectWorkspace(w.workspace_id); t.oncontextmenu = e => { e.preventDefault(); showContext(w.workspace_id, e.clientX, e.clientY); };
    tabs.appendChild(t);
  });
  const add = document.createElement('div'); add.className = 'term-tab add'; add.textContent = '+'; add.title = 'New workspace'; add.onclick = openNewWorkspace; tabs.appendChild(add);
  const sh = document.createElement('div'); sh.className = 'term-tab add shell'; sh.textContent = '>_'; sh.title = 'New terminal on this machine (a shell in your home folder)'; sh.onclick = newShell; tabs.appendChild(sh);
  renderPaneChips();
}
function renderPaneChips() {
  const chips = $('pane-chips'); chips.innerHTML = '';
  const panes = panesOf(selected);
  if (!panes.find(p => p.pane_id === selectedPane)) selectedPane = (paneMemory[selected] && panes.find(p => p.pane_id === paneMemory[selected])) ? paneMemory[selected] : firstPane(selected);
  if (isHeadless(selected)) {   // a headless agent: the conversation replaces the terminal grid
    chips.hidden = true; $('term-grid').hidden = true; document.body.classList.add('chat-mode');
    $('prompt-wrap').hidden = true; $('send').hidden = true; $('broadcast').hidden = true;
    if (Chat.current !== agentIdOf(selected)) { Chat.show(agentIdOf(selected)); setTimeout(() => Chat.focus(), 60); }
    watchAll(); return;
  }
  const vt = $('view-toggle'); vt.hidden = !localClaude(selected);
  $('ribbon-edit').hidden = !codeUrl(selected);   // the folder of the selected workspace, when VS Code is running
  if (wantConversation(selected)) {   // this device reads the terminal as a conversation; the pty is untouched
    vt.textContent = 'terminal'; vt.title = 'Show the real terminal on this device';
    chips.hidden = true; $('term-grid').hidden = true; document.body.classList.add('chat-mode');
    $('prompt-wrap').hidden = true; $('send').hidden = true; $('broadcast').hidden = true;
    const pid = selectedPane || firstPane(selected);
    if (Chat.current !== pid) { Chat.showTerm(pid); setTimeout(() => Chat.focus(), 60); }
    if (Terms.has(pid)) Terms.remove(pid);   // no xterm attachment on this device: nothing here can resize the pty
    feedChatStatus(); watchAll(); return;
  }
  vt.textContent = 'conversation'; vt.title = 'Read this workspace as a conversation on this device (phone-friendly); the terminal keeps running untouched';
  if (!$('chat').hidden) { Chat.hide(); document.body.classList.remove('chat-mode'); $('term-grid').hidden = false; $('broadcast').hidden = false; applyPromptBox(); setTimeout(Terms.fitAll, 30); }
  chips.hidden = panes.length < 2;
  panes.forEach(p => {
    const c = document.createElement('span'); c.className = 'pane-chip' + (p.pane_id === selectedPane ? ' active' : '');
    c.textContent = `${p.pane_id.split(':')[1]} ${p.agent || 'shell'} ${p.agent_status || ''}`.trim();
    c.onclick = () => { selectedPane = p.pane_id; paneMemory[selected] = p.pane_id; rememberSelection(); renderPaneChips(); };
    chips.appendChild(c);
  });
  if (selectedPane && (Terms.primary !== selectedPane || !Terms.has(selectedPane))) Terms.show(selectedPane, paneTitle(selectedPane));   // also after the conversation view removed the cell
  Terms.ids().forEach(pid => Terms.setTitle(pid, paneTitle(pid)));
  watchAll();
}
function watchAll() {
  const local = Terms.ids();
  // each cell renders the pty's real grid: at the natural fit when it is the same, scaled down (or swiped) when the pty is bigger
  local.forEach(pid => { const p = STATE.panes.find(x => x.pane_id === pid) || {}; Terms.setGrid(pid, p.cols || 0, p.rows || 0); });
  // terminals from agent-masterd: attach each open cell once; the server replays the screen, then streams live bytes
  if (sock && sock.readyState === 1) {
    if (local.some(pid => !openLocal.has(pid))) Terms.fitAll();
    local.forEach(pid => { if (!openLocal.has(pid)) { openLocal.add(pid); Terms.reset(pid); const sz = Terms.size(pid); send({ type: 'popen', pane_id: pid, cols: sz.cols, rows: sz.rows, scalable: termFit() === 'shrink' }); } });
    [...openLocal].forEach(pid => { if (!local.includes(pid)) { openLocal.delete(pid); send({ type: 'pclose', pane_id: pid }); } });
  }
  local.forEach(pid => loadHistory(pid));
}

// ───────────────────────── conversation history inside the terminal ─────────────────────────
// The transcript is rendered as terminal text into the scrollback above the live screen.
const PAGE = 600, histState = {}, lastRawAt = {};   // when a terminal last received bytes: the replay of a long session streams in over a second or two
const A = { reset: '\x1b[0m', dim: '\x1b[38;5;244m', bold: '\x1b[1m', white: '\x1b[97m', green: '\x1b[38;5;114m', blue: '\x1b[38;5;75m' };
// The assistant writes markdown; Claude Code shows it as bold, headings, bullets and coloured code. The scrollback does the same.
const M = { code: '\x1b[38;5;180m', codeEnd: '\x1b[39m', bold: '\x1b[1m', boldEnd: '\x1b[22m', ital: '\x1b[3m', italEnd: '\x1b[23m', head: '\x1b[1;97m', dim: '\x1b[38;5;244m', reset: '\x1b[0m' };
function mdInline(line) {
  return line
    .replace(/`([^`\n]+)`/g, (_, c) => M.code + c + M.codeEnd)
    .replace(/\*\*([^*\n]+)\*\*/g, (_, b) => M.bold + b + M.boldEnd)
    .replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s.,;:)!?]|$)/g, (_, pre, i) => pre + M.ital + i + M.italEnd)
    .replace(/(^|[\s(])_([^_\s][^_\n]*?)_(?=[\s.,;:)!?]|$)/g, (_, pre, i) => pre + M.ital + i + M.italEnd)
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, txt, url) => txt + ' ' + M.dim + '(' + url + ')' + M.reset);
}
function mdToAnsi(text) {
  const out = []; let fence = false;
  text.split('\n').forEach(raw => {
    const line = raw.replace(/\s+$/, '');
    if (/^\s*```/.test(line)) { fence = !fence; const lang = line.replace(/^\s*```/, '').trim(); out.push(M.dim + (fence ? '┌─ ' + (lang || 'code') : '└─') + M.reset); return; }
    if (fence) { out.push('  ' + M.code + line + M.codeEnd); return; }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { out.push(M.head + mdInline(m[2]) + M.reset); return; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push(M.dim + '─'.repeat(40) + M.reset); return; }
    if ((m = line.match(/^(\s*)[-*+]\s+(.*)$/))) { out.push(m[1] + '• ' + mdInline(m[2])); return; }
    if ((m = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/))) { out.push(m[1] + m[2] + '. ' + mdInline(m[3])); return; }
    if ((m = line.match(/^\s*>\s?(.*)$/))) { out.push(M.dim + '│ ' + mdInline(m[1]) + M.reset); return; }
    out.push(mdInline(line));
  });
  return out.join('\n');
}
function transcriptToAnsi(entries) {
  const out = [];
  entries.forEach(e => {
    const t = e.ts ? A.dim + new Date(e.ts).toLocaleTimeString('en-GB') + A.reset + '  ' : '';
    const text = tildePaths(e.text.replace(/\r/g, ''));
    if (e.role === 'user') out.push('', t + A.blue + A.bold + '> ' + A.reset + A.white + A.bold + text + A.reset);
    else if (e.role === 'assistant') out.push(t + mdToAnsi(text));
    else if (e.role === 'tool') out.push(t + A.green + '● ' + text + A.reset);
    else if (e.role === 'session') out.push('', A.dim + '── ' + text + ' ──' + A.reset, '');   // the seam between two sessions of this workspace
    else out.push(t + A.dim + '⎿ ' + text + A.reset);
  });
  return out.join('\n');
}
async function fetchTranscript(pid, limit, offset) {
  // a local terminal replays its own recent output; the transcript fills in only what is older than that replay
  const p = STATE.panes.find(x => x.pane_id === pid) || {}, q = { session: sessionName(), pane_id: pid, limit, offset, full: 1 };
  if (p.local && p.replay_since) q.until = p.replay_since;
  return fetch(`/api/transcript?${new URLSearchParams(q)}`).then(r => r.json()).catch(() => null);
}
function applyHistory(pid, st) {
  // a big replay is still streaming in when the transcript arrives: draw once the terminal has been quiet for a moment,
  // or the transcript would land in the middle of the replay
  if (Date.now() - (lastRawAt[pid] || 0) < 400 && (st.drawWait = (st.drawWait || 0) + 1) < 12) { clearTimeout(st.drawTimer); st.drawTimer = setTimeout(() => applyHistory(pid, st), 250); return; }   // a busy terminal never goes quiet: draw after 3 s anyway
  st.drawWait = 0;
  const left = st.total - st.entries.length;
  const head = left > 0 ? A.dim + `(${left} earlier entries: scroll up to load them)` + A.reset + '\n' : A.dim + '(start of this session)' + A.reset + '\n';
  const tail = A.dim + '(from here on: the terminal\'s own output)' + A.reset;
  Terms.setHistory(pid, st.entries.length ? head + transcriptToAnsi(st.entries) + '\n' + tail : null);
  historyChip(pid);
}
// a fullscreen program keeps the transcript out of the scrollback: the cell gets a chip that opens it as a page instead
function historyChip(pid) {
  const st = histState[pid], on = Terms.bufferType(pid) === 'alternate' && st && st.total > 0;
  Terms.setHistoryNote(pid, on ? `history · ${st.total} entries` : null);
}
Terms.on('history', pid => { const p = STATE.panes.find(x => x.pane_id === pid); if (!p) return; selectWorkspace(p.workspace_id); selectedPane = pid; paneMemory[p.workspace_id] = pid; showTranscript(true); });
Terms.on('reset', pid => { delete histState[pid]; loadHistory(pid, true); });   // the process was restarted: the transcript has grown since, fetch it again and draw it above the new screen
Terms.on('buffer', pid => {   // fullscreen entered or left: the chip follows, and a cell back on its normal screen gets the transcript drawn
  const st = histState[pid], c = Terms.cell(pid);
  if (Terms.bufferType(pid) !== 'alternate' && st && st.entries.length && c && !c.history) applyHistory(pid, st); else historyChip(pid);
});
// first load: the newest page; new entries are appended every 20 s; older pages are added when you reach the top
async function loadHistory(pid, force) {
  if (!pid || !Terms.has(pid)) return;
  if (isLocal(pid)) {
    // A real terminal keeps its own scrollback while it runs. After a close + resume the pty buffer starts empty and
    // Claude Code only prints a summary line, so the earlier conversation is backfilled once from the transcript;
    // a terminal with a long replay already shows that output and is left alone (it would appear twice).
    const p = STATE.panes.find(x => x.pane_id === pid) || {}, st0 = histState[pid], c = Terms.cell(pid);
    if (st0 && st0.none) return;
    // The replay holds the recent output; the transcript entries older than the replay's start are drawn above it, so the
    // scrollback runs from the first prompt of the session to the live screen with nothing shown twice.
    if (p.agent !== 'claude' || !(p.agent_session && p.agent_session.value)) return;
    if (st0 && st0.entries.length) { if (c && !c.history) applyHistory(pid, st0); return; }   // the cell was reopened: same history, fresh xterm
  }
  const st = histState[pid] || (histState[pid] = { at: 0, total: 0, entries: [], busy: false, none: false });
  if (st.none || st.busy || (!force && st.entries.length && Date.now() - st.at < 20000)) return;
  if (!force && st.entries.length && Date.now() - lastKeyAt < 4000) return;   // never rebuild anything while the user is typing
  st.at = Date.now(); st.busy = true;
  try {
    const r = await fetchTranscript(pid, PAGE, 0);
    if (!r || !Terms.has(pid)) return;
    if (!r.entries || (!r.entries.length && r.note)) { st.none = true; return; }
    if (!st.entries.length) { st.entries = r.entries; st.total = r.total; applyHistory(pid, st); return; }
    const fresh = r.total - st.total;
    if (fresh <= 0) return;
    if (fresh < PAGE) {
      const added = r.entries.slice(-fresh); st.entries = st.entries.concat(added); st.total = r.total;
      if (Terms.appendHistory(pid, transcriptToAnsi(added))) return;   // cheap path: only the new entries are written
    } else { st.entries = r.entries; st.total = r.total; }
    applyHistory(pid, st);
  } finally { st.busy = false; }
}
async function loadOlderHistory(pid) {
  const st = histState[pid];
  if (!st || st.busy || st.entries.length >= st.total) { Terms.doneLoading(pid); return; }
  st.busy = true;
  try {
    const r = await fetchTranscript(pid, PAGE, st.entries.length);
    if (!r || !r.entries || !r.entries.length) { Terms.doneLoading(pid); return; }
    st.entries = r.entries.concat(st.entries); st.total = r.total;
    applyHistory(pid, st);
  } finally { st.busy = false; }
}
Terms.on('top', pid => loadOlderHistory(pid));
setInterval(() => Terms.ids().forEach(pid => loadHistory(pid)), 20000);
function toggleFocus() { document.body.classList.toggle('focus-term'); $('focus-term').classList.toggle('on', document.body.classList.contains('focus-term')); setTimeout(Terms.fitAll, 60); }
$('focus-term').onclick = toggleFocus;
function selectWorkspace(id) {
  if (!wsById(id)) return;
  if (selected !== id) { selected = id; selectedPane = paneMemory[id] || null; }
  rememberSelection();
  Office.select(id, false);
  renderSidebar(); renderTermTabs();
  if (window.innerWidth < 800) document.body.classList.add('hide-office'), $('btn-office').classList.remove('on');
  if (isHeadless(id)) { const w = wsById(id); if (w && statusOf(w) === 'done') send({ type: 'agent_seen', agent_id: agentIdOf(id) }); setTimeout(() => Chat.focus(), 60); return; }
  if (wantConversation(id)) { setTimeout(() => Chat.focus(), 60); return; }
  if (!$('transcript').hidden) loadTranscript(); else setTimeout(() => Terms.focus(), 50);
}

// ───────────────────────── history (agent transcript) ─────────────────────────
let transcriptTimer = null;
function showTranscript(on) {
  $('transcript').hidden = !on; $('term-grid').hidden = on; $('history').classList.toggle('on', on);
  clearInterval(transcriptTimer); transcriptTimer = null;
  if (on) { loadTranscript(); transcriptTimer = setInterval(loadTranscript, 6000); } else { Terms.fitAll(); Terms.focus(); }
}
let transcriptOlder = 0, transcriptPane = null;
function entryEl(e) {
  const el = document.createElement('div'); el.className = 'tr-entry tr-' + e.role;
  const t = document.createElement('span'); t.className = 'tr-time'; t.textContent = e.ts ? new Date(e.ts).toLocaleTimeString('en-GB') : '';
  const x = document.createElement('span'); x.className = 'tr-text'; if (e.role === 'assistant') x.innerHTML = Chat.md(e.text); else x.textContent = e.text;   // md() escapes first, then marks up code, bold and bullets
  el.appendChild(t); el.appendChild(x); return el;
}
window.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); toggleFocus(); } });
async function loadTranscript() {
  if (!selectedPane) return;
  const body = $('transcript-body'), note = $('transcript-note');
  if (transcriptPane !== selectedPane) { transcriptPane = selectedPane; transcriptOlder = 0; body.dataset.key = ''; }
  const r = await fetch(`/api/transcript?${new URLSearchParams({ session: sessionName(), pane_id: selectedPane, limit: 600, full: 1 })}`).then(r => r.json()).catch(() => null);
  if (!r) { note.textContent = 'could not load'; return; }
  $('transcript-title').textContent = 'history · ' + ((wsById(selected) || {}).label || '');
  note.textContent = r.note || `${r.entries.length + transcriptOlder} of ${r.total} entries · ${r.file}`;
  $('transcript-older').hidden = !(r.total > r.entries.length + transcriptOlder);
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40 || !body.children.length;
  const key = JSON.stringify(r.entries.slice(-3)) + r.entries.length;
  if (body.dataset.key === key) return; body.dataset.key = key;
  body.innerHTML = ''; transcriptOlder = 0; $('transcript-older').hidden = !(r.total > r.entries.length);
  r.entries.forEach(e => body.appendChild(entryEl(e)));
  if (!r.entries.length) body.innerHTML = '<div class="notif-empty">Nothing here yet.</div>';
  if (atBottom) body.scrollTop = body.scrollHeight;
}
async function loadOlder() {
  const body = $('transcript-body');
  const shown = body.querySelectorAll('.tr-entry').length;
  const r = await fetch(`/api/transcript?${new URLSearchParams({ session: sessionName(), pane_id: selectedPane, limit: 600, offset: shown, full: 1 })}`).then(r => r.json()).catch(() => null);
  if (!r || !r.entries.length) { $('transcript-older').hidden = true; return; }
  const before = body.scrollHeight;
  const frag = document.createDocumentFragment(); r.entries.forEach(e => frag.appendChild(entryEl(e)));
  body.prepend(frag); body.scrollTop += body.scrollHeight - before;
  transcriptOlder += r.entries.length;
  $('transcript-note').textContent = `${shown + r.entries.length} of ${r.total} entries · ${r.file}`;
  $('transcript-older').hidden = !(r.total > shown + r.entries.length);
}
$('history').onclick = () => showTranscript($('transcript').hidden);
$('transcript-close').onclick = () => showTranscript(false);
$('transcript-refresh').onclick = () => { $('transcript-body').dataset.key = ''; loadTranscript(); };
$('transcript-older').onclick = loadOlder;
function sendInput(pid, text, log = true) { if (pid) send({ type: 'input', pane_id: pid, text, log }); }

// pasted screenshots: uploaded to the server, then the file path is typed into the agent's prompt (Claude Code reads image paths)
async function uploadImage(file) {
  const r = await fetch('/api/upload', { method: 'POST', body: file, headers: { 'Content-Type': file.type } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('upload failed (' + r.status + ')'));
  return j.path;
}
async function pasteImages(files, target, pid) {
  for (const f of files) {
    try {
      const path = await uploadImage(f);
      if (target === 'prompt') { const p = promptEl; const at = p.selectionStart == null ? p.value.length : p.selectionStart; p.value = p.value.slice(0, at) + path + ' ' + p.value.slice(at); p.focus(); }
      else sendInput(pid || selectedPane, path + ' ', false);
      toast(`screenshot saved: ${path.split('/').pop()}`, 'unknown');
    } catch (e) { toast('screenshot: ' + e.message, 'blocked'); }
  }
}
Terms.on('paste', (pid, files) => pasteImages(files, 'term', pid));
let lastPointer = { x: 0, y: 0 };
document.addEventListener('mousemove', e => { lastPointer = { x: e.clientX, y: e.clientY }; }, { passive: true });
function copyFlash(text, x, y, bad) {   // a small tag at the pointer, not a notification
  const d = document.createElement('div'); d.className = 'copy-flash' + (bad ? ' bad' : ''); d.textContent = text;
  d.style.left = Math.min((x || lastPointer.x) + 12, innerWidth - 160) + 'px'; d.style.top = Math.max((y || lastPointer.y) - 28, 4) + 'px';
  document.body.appendChild(d); setTimeout(() => d.classList.add('out'), 900); setTimeout(() => d.remove(), 1400);
}
Terms.on('copied', (pid, ok, n, x, y) => {
  if (ok === null) toast('The browser does not let this page read the clipboard: press Ctrl+V in the terminal instead', 'unknown');
  else if (ok) copyFlash(`copied ${n} character${n === 1 ? '' : 's'}`, x, y); else copyFlash('copy blocked by the browser: press Ctrl+Shift+C', x, y, true);
});
Terms.on('menu', (pid, x, y, m) => {   // right-click in a terminal
  ctx.innerHTML = '';
  const item = (label, fn, enabled = true, hint = '') => { const d = document.createElement('div'); d.innerHTML = `<span></span><span class="ctx-key">${hint}</span>`; d.firstChild.textContent = label; if (!enabled) d.className = 'disabled'; else d.onclick = () => { ctx.hidden = true; fn(); }; ctx.appendChild(d); };
  item('Copy', m.copy, m.hasSelection, 'Ctrl+Shift+C'); item('Paste', m.paste, true, 'Ctrl+V'); item('Select all', m.selectAll, true, '');
  if (m.hasSelection) item('Clear selection', m.clear, true, '');
  item('Selecting text copies it', () => { }, false, '');
  ctx.hidden = false; const r = ctx.getBoundingClientRect();
  ctx.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px'; ctx.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
});
function imageFilesOf(dt) { return dt ? [...(dt.files || [])].filter(f => /^image\/(png|jpeg|gif|webp)$/.test(f.type)) : []; }
$('prompt').addEventListener('paste', e => { const f = imageFilesOf(e.clipboardData); if (f.length) { e.preventDefault(); pasteImages(f, 'prompt'); } });
$('prompt').addEventListener('dragover', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
$('prompt').addEventListener('drop', e => { const f = imageFilesOf(e.dataTransfer); if (f.length) { e.preventDefault(); pasteImages(f, 'prompt'); } });

// prompt box: history + templates
const promptEl = $('prompt');
let histIdx = -1, histDraft = '';
function history() { try { return JSON.parse(localStorage.getItem('hist:' + sessionName() + ':' + selected) || '[]'); } catch (e) { return []; } }
function pushHistory(t) { const h = history().filter(x => x !== t); h.unshift(t); try { localStorage.setItem('hist:' + sessionName() + ':' + selected, JSON.stringify(h.slice(0, 50))); } catch (e) { } }
function sendPrompt() { const t = promptEl.value; if (!t) return; if (isHeadless(selected)) { send({ type: 'agent_prompt', agent_id: agentIdOf(selected), text: t }); } else { if (!selectedPane) return; sendInput(selectedPane, t + '\r'); } pushHistory(t); promptEl.value = ''; histIdx = -1; }
promptEl.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); sendPrompt(); }
  else if (e.key === 'ArrowUp') { const h = history(); if (!h.length) return; e.preventDefault(); if (histIdx < 0) histDraft = promptEl.value; histIdx = Math.min(h.length - 1, histIdx + 1); promptEl.value = h[histIdx]; }
  else if (e.key === 'ArrowDown') { const h = history(); if (histIdx < 0) return; e.preventDefault(); histIdx--; promptEl.value = histIdx < 0 ? histDraft : h[histIdx]; }
  else if (e.key === 'Escape') { promptEl.blur(); }
});
$('send').onclick = sendPrompt;
$('quick-keys').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; const seq = JSON.parse('"' + b.dataset.seq + '"'); if (isHeadless(selected)) agentQuickKey(selected, seq); else if (selectedPane) sendInput(selectedPane, seq, false); });
$('pin-term').onclick = () => { if (selectedPane) { if (!Terms.pin(selectedPane, paneTitle(selectedPane))) toast('Three terminals is the limit; close one first', 'blocked'); } };
// the ⋯ menu: everything that is not typing lives here, so the bar stays quick keys + prompt + send
const moreMenu = $('more-menu');
const MORE = [['history', 'History', 'Full conversation as a page, with load older'],
  ['pin-term', 'Split view', 'Keep this terminal open next to the others'], ['broadcast', 'Broadcast', 'One prompt to several agents'], ['focus-term', 'Focus mode', 'The terminal alone, whole window (Ctrl+Shift+F)']];
function renderMoreMenu() {
  const chat = document.body.classList.contains('chat-mode');
  moreMenu.innerHTML = '';
  MORE.forEach(([id, label, desc]) => {
    const b = $(id); if (!b || b.hidden) return;
    if (chat && (id === 'pin-term' || id === 'focus-term')) return;   // no terminal cell on this device in the conversation view
    const it = document.createElement('div'); it.className = 'tpl-item' + (b.classList.contains('on') ? ' on' : '');
    it.innerHTML = `<b>${label}${b.classList.contains('on') ? ' · on' : ''}</b><span>${desc}</span>`;
    it.onclick = () => { moreMenu.hidden = true; b.click(); };
    moreMenu.appendChild(it);
  });
}
$('more').onclick = e => { e.preventDefault(); e.currentTarget.blur(); moreMenu.hidden = !moreMenu.hidden; if (!moreMenu.hidden) renderMoreMenu(); };
document.addEventListener('click', e => { if (!moreMenu.hidden && !e.target.closest('#more-menu') && !e.target.closest('#more')) moreMenu.hidden = true; });
const tplMenu = $('tpl-menu');
$('tpl-btn').onclick = e => { e.preventDefault(); tplMenu.hidden = !tplMenu.hidden; if (!tplMenu.hidden) renderTplMenu(); };
document.addEventListener('click', e => { if (!e.target.closest('.prompt-wrap')) tplMenu.hidden = true; });
function renderTplMenu() {
  tplMenu.innerHTML = '';
  const tpls = PREFS.templates || [];
  if (!tpls.length) { tplMenu.innerHTML = '<div class="tpl-empty">No templates yet. Add some in Settings.</div>'; return; }
  tpls.forEach(t => { const d = document.createElement('div'); d.className = 'tpl-item'; d.innerHTML = '<b></b><span></span>'; d.querySelector('b').textContent = t.name; d.querySelector('span').textContent = t.text; d.onclick = () => { promptEl.value = t.text; tplMenu.hidden = true; promptEl.focus(); }; tplMenu.appendChild(d); });
}

// ───────────────────────── broadcast ─────────────────────────
$('broadcast').onclick = () => openBroadcast();
function openBroadcast(text) {
  const list = $('bc-list'); list.innerHTML = '';
  STATE.workspaces.forEach(w => { const st = statusOf(w), pid = firstPane(w.workspace_id); if (!pid) return; const l = document.createElement('label'); l.innerHTML = `<input type="checkbox" value="${esc(pid)}" ${st === 'idle' || st === 'done' ? 'checked' : ''}><span class="tree-dot ${st}"></span><span></span>`; l.lastChild.textContent = `${w.label} (${st})`; list.appendChild(l); });
  $('bc-text').value = text || promptEl.value || ''; $('bc-msg').textContent = ''; $('bcast').hidden = false; $('bc-text').focus();
}
$('bc-idle').onclick = () => $('bc-list').querySelectorAll('input').forEach(i => { i.checked = /\((idle|done)\)/.test(i.parentElement.textContent); });
$('bc-all').onclick = () => $('bc-list').querySelectorAll('input').forEach(i => i.checked = true);
$('bc-send').onclick = async () => {
  const ids = [...$('bc-list').querySelectorAll('input:checked')].map(i => i.value), text = $('bc-text').value.trim();
  if (!ids.length || !text) { $('bc-msg').textContent = 'Pick at least one agent and write a prompt.'; return; }
  const r = await action({ action: 'send', pane_ids: ids, text: text + '\r' });
  $('bc-msg').textContent = r && r.ok ? `Sent to ${ids.length} agent${ids.length === 1 ? '' : 's'}.` : (r && r.error) || 'failed';
  pushHistory(text); if (r && r.ok) setTimeout(() => $('bcast').hidden = true, 800);
};

// ───────────────────────── new workspace ─────────────────────────
async function browse(path) {
  const r = await fetch('/api/browse?path=' + encodeURIComponent(path)).then(r => r.json()).catch(() => null);
  if (!r || r.error) { $('nw-msg').textContent = r ? r.error : 'cannot list'; return; }
  $('nw-path').value = r.path; $('nw-path').dataset.parent = r.parent;
  const list = $('nw-dirs'); list.innerHTML = '';
  r.dirs.forEach(d => { const el = document.createElement('div'); el.textContent = d; el.onclick = () => browse(r.path.replace(/\/$/, '') + '/' + d); list.appendChild(el); });
  if (r.git) $('nw-path').classList.add('git'); else $('nw-path').classList.remove('git');
  loadFolderSessions(r.path);
}
// the Claude Code conversations already recorded for the folder: the latest is selected, so the terminal opens with its history
let folderSessionsFor = null;
async function loadFolderSessions(path) {
  folderSessionsFor = path;
  const sel = $('nw-resume'); sel.innerHTML = '<option value="">start a new conversation</option>';
  const r = await fetch('/api/claude-sessions?path=' + encodeURIComponent(path)).then(r => r.json()).catch(() => null);
  if (folderSessionsFor !== path || !r || !r.sessions) return;
  r.sessions.forEach((s, i) => {
    const o = document.createElement('option'); o.value = s.id;
    const when = new Date(s.mtime * 1000).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    o.textContent = `${i === 0 ? 'continue the latest: ' : ''}${when} · ${s.first_prompt || s.id.slice(0, 8)}`;
    sel.appendChild(o);
  });
  if (r.sessions.length) sel.value = r.sessions[0].id;
}
function openNewWorkspace() { $('newws').hidden = false; $('nw-msg').textContent = ''; browse($('nw-path').value || '~'); }
$('act-new').onclick = openNewWorkspace;
$('nw-up').onclick = () => browse($('nw-path').dataset.parent || '/');
$('nw-path').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); browse($('nw-path').value); } });
function syncHeadlessRows() {
  const headless = $('nw-headless').checked, agent = $('nw-agent').value;
  $('nw-agent').hidden = headless; document.querySelector('label[for="nw-agent"]').hidden = headless;
  $('nw-custom').hidden = headless || agent !== 'custom';
  $('nw-claude-opts').hidden = !(headless || agent === 'claude');
}
$('nw-agent').onchange = syncHeadlessRows; $('nw-headless').onchange = syncHeadlessRows; syncHeadlessRows();
function termSize() { const g = $('term-grid').getBoundingClientRect(); return { cols: Math.max(40, Math.floor((g.width - 16) / 7.8)), rows: Math.max(10, Math.floor((g.height - 30) / 17)) }; }
async function createTerminal(spec) {
  let r = null;
  try { const resp = await fetch('/api/terms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign(termSize(), spec, { session: SESSION || undefined })) }); r = await resp.json(); } catch (e) { r = { error: String(e) }; }
  if (r && r.ok) {   // the new workspace reaches STATE with the next state push: select it as soon as it is there
    send({ type: 'refresh' });
    const t0 = Date.now(), pick = () => { if (wsById(r.workspace_id)) selectWorkspace(r.workspace_id); else if (Date.now() - t0 < 5000) setTimeout(pick, 150); };
    setTimeout(pick, 100);
  } else toast('could not start the terminal: ' + ((r && r.error) || 'unknown'), 'blocked');
  return r;
}
async function newShell() {   // a plain terminal on this machine, in the home folder
  await createTerminal({ kind: 'shell', cwd: '~' });
}
$('nw-create').onclick = async () => {
  if ($('nw-headless').checked) {
    $('nw-msg').textContent = 'starting…';
    let r = null;
    try { const resp = await fetch('/api/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: $('nw-path').value, label: $('nw-label').value.trim(), model: $('nw-model').value || 'claude-opus-5', permission_mode: $('nw-perm').value || null, session: SESSION || undefined }) }); r = await resp.json(); } catch (e) { r = { error: String(e) }; }
    if (r && r.ok) { $('newws').hidden = true; $('nw-label').value = ''; toast(`${r.agent.label} started headless`, 'idle', r.agent.workspace_id); send({ type: 'refresh' }); setTimeout(() => selectWorkspace(r.agent.workspace_id), 800); }
    else $('nw-msg').textContent = (r && r.error) || 'failed';
    return;
  }
  const agent = $('nw-agent').value, custom = $('nw-custom').value.trim();
  if (agent === 'custom' && !custom) { $('nw-msg').textContent = 'Type the command to run.'; return; }
  const spec = { cwd: $('nw-path').value, label: $('nw-label').value.trim(),
    kind: agent === 'claude' ? 'claude' : agent === '' ? 'shell' : agent === 'custom' ? 'command' : 'agent', command: agent === 'custom' ? custom : agent };
  if (agent === 'claude') { spec.model = $('nw-model').value || null; spec.permission_mode = $('nw-perm').value || null; if ($('nw-resume').value) spec.resume = $('nw-resume').value; else spec.fresh = true; }
  $('nw-msg').textContent = 'starting…';
  const r = await createTerminal(spec);
  if (r && r.ok) { $('newws').hidden = true; $('nw-label').value = ''; $('nw-msg').textContent = ''; toast(`${r.term.label} started`, 'idle', r.workspace_id); }
  else $('nw-msg').textContent = (r && r.error) || 'failed';
};

// ───────────────────────── context menu + costume ─────────────────────────
const ctx = $('ctx');
function showContext(id, x, y) {
  const w = wsById(id); if (!w) return;
  const pid = firstPane(id), st = statusOf(w);
  const items = isLocal(id) ? [
    ['Open terminal', () => selectWorkspace(id)],
    ['Split: keep terminal open', () => { if (pid) Terms.pin(pid, paneTitle(pid)); }],
    ['Send prompt…', () => { selectWorkspace(id); promptEl.focus(); }],
    ['Broadcast from here…', () => openBroadcast()],
    ['Details…', () => openAgentCard(id)],
    'sep',
    ['Costume and desk…', () => openCostume(w.label)],
    'sep',
    (p.permission_mode === 'bypassPermissions'
      ? ['Stop running every command unasked', () => setBypass(id, false)]
      : ['Run all commands without asking (bypass)…', () => setBypass(id, true), 'danger']),
    ['Interrupt (Ctrl+C)', () => action({ action: 'stop_pane', pane_id: id })],
    ['Restart the process', () => action({ action: 'restart', workspace_id: id })],
    ['Close terminal', () => closeWorkspace(id), 'danger'],
  ] : isHeadless(id) ? [
    ['Open conversation', () => selectWorkspace(id)],
    ['Send prompt…', () => { selectWorkspace(id); promptEl.focus(); }],
    ['Details…', () => openAgentCard(id)],
    'sep',
    ['Costume and desk…', () => openCostume(w.label)],
    'sep',
    ['Interrupt (Esc)', () => send({ type: 'agent_interrupt', agent_id: agentIdOf(id) })],
    ['Stop the process', () => send({ type: 'agent_stop', agent_id: agentIdOf(id) })],
    ['Close agent', () => closeWorkspace(id), 'danger'],
  ] : [
    ['Open terminal', () => selectWorkspace(id)],
    ['Split: keep terminal open', () => { if (pid) Terms.pin(pid, paneTitle(pid)); }],
    ['Open in terminal' + (st === 'done' ? ' (mark reviewed)' : ''), () => action({ action: 'focus_workspace', workspace_id: id })],
    ['Send prompt…', () => { selectWorkspace(id); promptEl.focus(); }],
    ['Broadcast from here…', () => openBroadcast()],
    'sep',
    ['Costume and desk…', () => openCostume(w.label)],
    'sep',
    ['Stop agent (Ctrl+C)', () => { if (pid) action({ action: 'stop_pane', pane_id: pid }); }],
    ['Close workspace', () => closeWorkspace(id), 'danger'],
  ];
  ctx.innerHTML = '';
  items.forEach(it => { const d = document.createElement('div'); if (it === 'sep') { d.className = 'sep'; } else { d.textContent = it[0]; if (it[2]) d.className = it[2]; d.onclick = () => { ctx.hidden = true; it[1](); }; } ctx.appendChild(d); });
  ctx.hidden = false;
  const r = ctx.getBoundingClientRect();
  ctx.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px'; ctx.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
}
document.addEventListener('mousedown', e => { if (!e.target.closest('#ctx')) ctx.hidden = true; });
function askConfirm(title, text, okLabel, fn) {
  $('confirm-title').textContent = title; $('confirm-text').textContent = text; $('confirm-ok').textContent = okLabel;
  $('confirm').hidden = false; $('confirm-ok').focus();
  const done = () => { $('confirm').hidden = true; $('confirm-ok').onclick = null; };
  $('confirm-ok').onclick = () => { done(); fn(); };
  $('confirm-cancel').onclick = $('confirm-x').onclick = done;
}
$('confirm').addEventListener('mousedown', e => { if (e.target === $('confirm')) $('confirm').hidden = true; });
$('confirm').addEventListener('keydown', e => { if (e.key === 'Escape') $('confirm').hidden = true; });
// switch a Claude terminal into (or out of) bypass-permissions mode, then restart it so Claude Code starts with it
async function setBypass(id, on) {
  const w = wsById(id), pid = firstPane(id); if (!w || !pid) return;
  const apply = async () => {
    const r = await action({ action: 'set_mode', pane_id: pid, permission_mode: on ? 'bypassPermissions' : 'default' });
    if (r && r.error) { toast('could not change mode: ' + r.error, 'blocked'); return; }
    const r2 = await action({ action: 'restart', workspace_id: id });
    if (r2 && r2.error) toast('mode set, but restart failed: ' + r2.error, 'blocked');
    else toast(on ? `${w.label}: now runs commands without asking` : `${w.label}: back to asking for commands`, on ? 'blocked' : 'done', id);
  };
  if (on) askConfirm(`Run all commands without asking in ${w.label}?`, 'This lets the agent run any shell command with no prompt. Use it only in a folder you trust. The session is resumed with the new mode.', 'Enable bypass', apply);
  else apply();
}
function closeWorkspace(id) {
  const w = wsById(id); if (!w) return;
  if (isHeadless(id)) {
    askConfirm(`Close ${w.label}?`, `This stops the headless agent and removes it from the office. Its conversation stays in the database and the Claude Code session can be resumed later by session id.`, 'Close agent', () => send({ type: 'agent_archive', agent_id: agentIdOf(id) }));
    return;
  }
  const st = statusOf(w), busy = st === 'working' || st === 'blocked';
  if (isLocal(id)) {
    askConfirm(`Close ${w.label}?`, `This ends the process running in that terminal` + (busy ? ` (the agent is ${st})` : '') + `. A Claude Code conversation stays saved and can be resumed by its session id.`, 'Close terminal', async () => {
      const r = await action({ action: 'close_workspace', workspace_id: id });
      if (r && r.error) toast(`Close failed: ${r.error}`, 'blocked'); else toast(`${w.label} closed`, 'unknown');
    });
    return;
  }
  askConfirm(`Close ${w.label}?`, `This closes the workspace and its terminals` + (busy ? `; the agent is ${st} and will be stopped` : '') + `. It cannot be undone.`, 'Close workspace', async () => {
    const r = await action({ action: 'close_workspace', workspace_id: id });
    if (r && r.error) toast(`Close failed: ${r.error}`, 'blocked'); else toast(`${w.label} closed`, 'unknown');
  });
}
let costumeLabel = null;
function openCostume(label) {
  costumeLabel = label;
  const c = Office.costumeOf(label) || {}; $('cs-title').textContent = `Costume · ${label}`;
  $('cs-gender').value = c.gender || 'f';
  const hs = $('cs-hair-style'); hs.innerHTML = Office.HAIR_STYLES.map(s => `<option value="${s}">${s}</option>`).join(''); hs.value = c.hairStyle || 'short';
  $('cs-hair').value = c.hair || '#3b2418'; $('cs-shirt').value = c.shirt || '#4a9a6a'; $('cs-skin').value = c.skin || '#e6b894';
  const ds = $('cs-desk'); ds.innerHTML = '<option value="">automatic</option>' + Array.from({ length: Office.deskCount() }, (_, i) => `<option value="${i}">desk ${i + 1}</option>`).join('');
  const want = (PREFS.desks || {})[label]; ds.value = Number.isInteger(want) ? String(want) : '';
  $('cs-msg').textContent = ''; $('costume').hidden = false;
}
$('cs-save').onclick = () => {
  PREFS.costumes = PREFS.costumes || {}; PREFS.desks = PREFS.desks || {};
  PREFS.costumes[costumeLabel] = { gender: $('cs-gender').value, hairStyle: $('cs-hair-style').value, hair: $('cs-hair').value, shirt: $('cs-shirt').value, skin: $('cs-skin').value };
  const d = $('cs-desk').value; if (d === '') delete PREFS.desks[costumeLabel]; else PREFS.desks[costumeLabel] = parseInt(d, 10);
  savePrefs(); $('cs-msg').textContent = 'Saved.'; $('cs-msg').className = 'modal-msg ok'; setTimeout(() => $('costume').hidden = true, 500);
};
$('cs-reset').onclick = () => { delete (PREFS.costumes || {})[costumeLabel]; delete (PREFS.desks || {})[costumeLabel]; savePrefs(); $('costume').hidden = true; };
async function savePrefs() { Office.setPrefs(PREFS); await fetch('/api/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(PREFS) }).catch(() => toast('could not save preferences', 'blocked')); }

// ───────────────────────── command palette ─────────────────────────
const pal = $('palette'), palInput = $('palette-input'), palList = $('palette-list');
let palItems = [], palIdx = 0;
function paletteItems(q) {
  q = q.trim().toLowerCase();
  const items = [];
  STATE.workspaces.forEach(w => { const st = statusOf(w); items.push({ label: w.label, kind: st, dot: st, run: () => selectWorkspace(w.workspace_id), key: (w.label + ' ' + st).toLowerCase() }); });
  const cmds = [
    ['New workspace', openNewWorkspace], ['New terminal (shell on this machine)', newShell], ['Broadcast a prompt', () => openBroadcast()], ['Event log', () => showLog(true)], ['Office', () => showLog(false)],
    ['Settings', openSettings], ['Toggle left bar', toggleSide], ['Toggle office', toggleOffice], ['Office on the right / on top', () => applyLayoutMode(layoutPref !== 'side')], ['Close current workspace', () => closeWorkspace(selected)], ['Toggle prompt box', () => { opts.promptBox = opts.promptBox === false; saveOpts(); applyPromptBox(); }], ['Toggle attention panel', toggleAttn], ['Refresh state', () => send({ type: 'refresh' })], ['Sign out', () => logout(false)],
  ];
  cmds.forEach(([label, run]) => items.push({ label, kind: 'command', run, key: label.toLowerCase() }));
  return q ? items.filter(i => i.key.includes(q)) : items;
}
function openPalette(q = '') { pal.hidden = false; palInput.value = q; palInput.focus(); renderPalette(); }
function renderPalette() {
  palItems = paletteItems(palInput.value); palIdx = 0; palList.innerHTML = '';
  palItems.slice(0, 30).forEach((it, i) => { const d = document.createElement('div'); d.className = 'pal-item' + (i === 0 ? ' active' : ''); d.innerHTML = `${it.dot ? `<span class="tree-dot ${it.dot}"></span>` : ''}<span></span><span class="pal-kind">${esc(it.kind)}</span>`; d.children[it.dot ? 1 : 0].textContent = it.label; d.onclick = () => { pal.hidden = true; it.run(); }; palList.appendChild(d); });
}
palInput.addEventListener('input', renderPalette);
palInput.addEventListener('keydown', e => {
  const n = Math.min(palItems.length, 30);
  if (e.key === 'ArrowDown') { palIdx = (palIdx + 1) % n; } else if (e.key === 'ArrowUp') { palIdx = (palIdx - 1 + n) % n; }
  else if (e.key === 'Enter') { const it = palItems[palIdx]; if (it) { pal.hidden = true; it.run(); } return; }
  else if (e.key === 'Escape') { pal.hidden = true; return; } else return;
  e.preventDefault(); [...palList.children].forEach((c, i) => c.classList.toggle('active', i === palIdx));
});
pal.addEventListener('mousedown', e => { if (e.target === pal) pal.hidden = true; });
$('act-palette').onclick = () => openPalette();

// ───────────────────────── event log view ─────────────────────────
function showLog(on) {
  $('log-view').hidden = !on; $('office-wrap').hidden = on; $('sash-h').hidden = on;
  $('tab-log').classList.toggle('active', on); $('tab-office').classList.toggle('active', !on);
  $('act-log').classList.toggle('active', on); $('act-office').classList.toggle('active', !on);
  if (on) loadLog(); else Office.layout();
}
$('tab-log').onclick = () => showLog(true); $('tab-office').onclick = () => showLog(false); $('act-log').onclick = () => showLog(true); $('act-office').onclick = () => showLog(false);
$('log-refresh').onclick = loadLog; ['log-since', 'log-ws', 'log-kind'].forEach(id => $(id).onchange = loadLog);
async function loadLog() {
  const sinceSec = parseInt($('log-since').value, 10), since = sinceSec ? (Date.now() / 1000 - sinceSec) : 0;
  const wsSel = $('log-ws'); const cur = wsSel.value;
  wsSel.innerHTML = '<option value="">all workspaces</option>' + STATE.workspaces.map(w => `<option value="${esc(w.label)}">${esc(w.label)}</option>`).join(''); wsSel.value = cur;
  const q = new URLSearchParams({ session: sessionName(), limit: 400 }); if (since) q.set('since', since); if (wsSel.value) q.set('workspace', wsSel.value); if ($('log-kind').value) q.set('kind', $('log-kind').value);
  const [ev, sm] = await Promise.all([fetch('/api/events?' + q).then(r => r.json()), fetch('/api/summary?' + new URLSearchParams({ session: sessionName(), since: since || 0 })).then(r => r.json())]).catch(() => [null, null]);
  if (!ev) { $('log-note').textContent = 'could not load'; return; }
  const rows = Object.entries(sm.summary || {}).sort((a, b) => b[1].seconds.working - a[1].seconds.working);
  $('log-summary').innerHTML = '<tr><th>workspace</th><th>working</th><th>blocked</th><th>done (unreviewed)</th><th>idle</th><th>tasks</th><th>times blocked</th></tr>' + rows.map(([wid, s]) => `<tr><td>${esc(s.label || wid)}</td><td class="c-yellow">${fmtDur(s.seconds.working)}</td><td class="c-red">${fmtDur(s.seconds.blocked)}</td><td class="c-green">${fmtDur(s.seconds.done)}</td><td>${fmtDur(s.seconds.idle)}</td><td>${s.tasks}</td><td>${s.blocked_count}</td></tr>`).join('');
  $('log-events').innerHTML = '<tr><th>time</th><th>workspace</th><th>event</th><th>detail</th></tr>' + ev.events.map(e => {
    const d = e.detail || {}; let detail = '';
    if (e.kind === 'status') detail = `<span class="t-status">${esc(e.from || '?')} → ${esc(e.to)}</span>`;
    else if (e.kind === 'prompt') detail = esc(d.text || '');
    else if (e.kind === 'visit') detail = `→ ${esc(d.to_label)} · ${esc(d.tool)} ${esc(d.rel)}`;
    else if (e.kind === 'agent_started' || e.kind === 'agent_gone') detail = esc(d.agent || '');
    else if (e.kind === 'renamed') detail = `was ${esc(e.from)}`;
    else if (e.kind === 'chat') detail = `<span class="t-dim">with ${esc(d.with || '?')}${d.source && d.source !== 'cli' && d.source !== 'api' ? ' · ' + esc(d.source) : ''}</span><br>` + (d.lines || []).map(l => `<b>${esc(l.who)}</b>: ${esc(l.text)}`).join('<br>');
    return `<tr><td>${new Date(e.ts * 1000).toLocaleString('en-GB')}</td><td>${esc(e.label || e.workspace_id || '')}</td><td>${esc(e.kind)}</td><td class="wrap">${detail}</td></tr>`;
  }).join('');
  $('log-note').textContent = `${ev.events.length} events`;
}

// ───────────────────────── settings ─────────────────────────
const settingsEl = $('settings');
async function openSettings() {
  settingsEl.hidden = false;
  const s = await fetch('/api/auth/status').then(r => r.json()).catch(() => ({}));
  $('pw-form').hidden = !s.enabled;
  $('auth-note').textContent = s.enabled ? `Signed in as ${s.username}. Everyone who opens this address must sign in. Saving changes signs out every other browser.` : 'Authentication is disabled (server started with --no-auth).';
  $('pw-user').value = s.username || ''; $('pw-msg').textContent = '';
  $('opt-notify-blocked').checked = opts.notifyBlocked; $('opt-notify-done').checked = opts.notifyDone; $('opt-sound').checked = opts.sound; $('opt-light').checked = !!opts.light;
  renderServerInfo();
  $('notify-note').textContent = !('Notification' in window) ? 'This browser does not support notifications.' : Notification.permission === 'denied' ? 'Notifications are blocked for this site in the browser settings.' : '';
  $('tpl-edit').value = (PREFS.templates || []).map(t => `${t.name} | ${t.text}`).join('\n'); $('tpl-msg').textContent = '';
  const c = Object.assign({ mode: 'auto', model: 'claude-opus-5', interval: 75 }, PREFS.chatter || {});
  $('chat-mode').value = c.mode; $('chat-model').value = c.model; $('chat-interval').value = c.interval;
  fetch('/api/chatter/status').then(r => r.json()).then(st => {
    const names = { api: 'Anthropic API (ANTHROPIC_API_KEY)', cli: 'Claude Code on this machine (your subscription)', builtin: 'built-in lines only', off: 'off' };
    $('chat-status').textContent = `Active backend: ${names[st.backend] || st.backend}. ${st.cli ? 'Claude Code CLI found.' : 'No Claude Code CLI.'} ${st.api_key ? 'API key set.' : 'No API key.'} ${st.calls ? st.calls + ' conversations generated this run.' : ''} ${st.last_error ? 'Last error: ' + st.last_error : ''}`;
  }).catch(() => { });
}
$('chat-save').onclick = () => {
  PREFS.chatter = { mode: $('chat-mode').value, model: $('chat-model').value, interval: parseInt($('chat-interval').value, 10) || 75 };
  savePrefs(); $('chat-msg').textContent = 'Saved.'; $('chat-msg').className = 'modal-msg ok'; setTimeout(openSettings, 400);
};
$('act-settings').onclick = openSettings;
document.querySelectorAll('.modal-close').forEach(b => b.onclick = () => $(b.dataset.close).hidden = true);
document.querySelectorAll('.modal-backdrop').forEach(m => m.addEventListener('mousedown', e => { if (e.target === m) m.hidden = true; }));
$('pw-form').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $('pw-msg'); msg.className = 'modal-msg';
  const user = $('pw-user').value.trim(), cur = $('pw-current').value, nw = $('pw-new').value, cf = $('pw-confirm').value;
  if (!cur) { msg.textContent = 'Enter your current password.'; msg.className += ' err'; return; }
  if (nw && nw.length < 10) { msg.textContent = 'Use at least 10 characters.'; msg.className += ' err'; return; }
  if (nw !== cf) { msg.textContent = 'New passwords do not match.'; msg.className += ' err'; return; }
  const payload = { current: cur, username: user }; if (nw) payload.new = nw;
  const r = await fetch('/api/auth/change', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const d = await r.json().catch(() => ({}));
  if (r.ok) { msg.textContent = 'Saved.'; msg.className += ' ok'; ['pw-current', 'pw-new', 'pw-confirm'].forEach(id => $(id).value = ''); USERNAME = d.username || user; $('tb-user').textContent = USERNAME; }
  else { msg.textContent = d.error || 'Failed.'; msg.className += ' err'; }
});
async function logout(everywhere) { await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ everywhere }) }); location.href = '/login'; }
$('logout').onclick = () => logout(false); $('logout-all').onclick = () => logout(true);
$('tb-logout').onclick = () => logout(false); $('act-logout').onclick = () => logout(false);
fetch('/api/auth/status').then(r => r.json()).then(s => { if (!s.enabled) document.body.classList.add('no-auth'); }).catch(() => { });
async function askNotify() { if (!('Notification' in window)) return false; if (Notification.permission === 'granted') return true; const p = await Notification.requestPermission(); return p === 'granted'; }
$('opt-notify-blocked').onchange = async e => { opts.notifyBlocked = e.target.checked && await askNotify(); e.target.checked = opts.notifyBlocked; saveOpts(); };
$('opt-notify-done').onchange = async e => { opts.notifyDone = e.target.checked && await askNotify(); e.target.checked = opts.notifyDone; saveOpts(); };
$('opt-sound').onchange = e => { opts.sound = e.target.checked; saveOpts(); if (opts.sound) beep('done'); };
$('tpl-save').onclick = () => {
  PREFS.templates = $('tpl-edit').value.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const i = l.indexOf('|'); return i > 0 ? { name: l.slice(0, i).trim(), text: l.slice(i + 1).trim() } : { name: l.slice(0, 24), text: l }; });
  savePrefs(); $('tpl-msg').textContent = `${PREFS.templates.length} template${PREFS.templates.length === 1 ? '' : 's'} saved.`; $('tpl-msg').className = 'modal-msg ok';
};

// ───────────────────────── websocket + actions ─────────────────────────
let sock = null, backoff = 500, rid = 0, lastChatSource = null; const pending = {}; const TEXT = new TextDecoder();
function send(msg) { if (sock && sock.readyState === 1) sock.send(JSON.stringify(msg)); }
function action(msg) {
  return new Promise(resolve => {
    if (!sock || sock.readyState !== 1) { resolve({ error: 'not connected' }); return; }
    const id = ++rid; pending[id] = resolve; send({ type: 'action', rid: id, ...msg });
    setTimeout(() => { if (pending[id]) { pending[id]({ error: 'timeout' }); delete pending[id]; } }, 8000);
  });
}
function connect() {
  sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws' + (SESSION ? '?session=' + encodeURIComponent(SESSION) : ''));
  sock.binaryType = 'arraybuffer';
  sock.onopen = () => { backoff = 500; watchAll(); };
  sock.onmessage = ev => {
    if (ev.data instanceof ArrayBuffer) {   // terminal bytes: [id length][id][raw output]
      const u8 = new Uint8Array(ev.data), n = u8[0], pid = TEXT.decode(u8.subarray(1, 1 + n));
      lastRawAt[pid] = Date.now(); Terms.raw(pid, u8.subarray(1 + n)); return;
    }
    const msg = JSON.parse(ev.data);
    if (msg.type === 'hello') {
      PREFS = Object.assign({ costumes: {}, desks: {}, templates: [] }, msg.prefs || {}); Office.setPrefs(PREFS);
      Office.setChatInterval((PREFS.chatter || {}).mode === 'builtin' ? 25 : (PREFS.chatter || {}).interval || 75);
      USERNAME = msg.username || ''; $('tb-user').textContent = USERNAME;
      TERMINALS = !!msg.terminals; CODE = !!msg.code; HOME = msg.home || ''; $('edit').hidden = !CODE; $('ribbon-edit').hidden = !codeUrl(selected);
    }
    else if (msg.type === 'state') { applyState(msg.state, msg.events); feedChatStatus(); }
    else if (msg.type === 'agent_event') { Chat.event(msg.agent_id, msg.event); if (msg.event.kind === 'permission' || msg.event.kind === 'result') send({ type: 'refresh' }); }
    else if (msg.type === 'agent_delta') Chat.delta(msg.agent_id, msg.text);
    else if (msg.type === 'agent') { Chat.status(msg.agent); if (STATE.workspaces.length) renderStrip(); }
    else if (msg.type === 'agent_gone') { if (selected === 'a:' + msg.agent_id) { selected = null; selectedPane = null; Chat.hide(); $('term-grid').hidden = false; } send({ type: 'refresh' }); }
    else if (msg.type === 'pclosed') {   // a terminal attachment ended: reattach while the workspace still exists
      openLocal.delete(msg.p);
      if (/not running/.test(msg.reason || '')) $('sb-conn').textContent = 'terminal server offline';
      setTimeout(() => { if (Terms.has(msg.p) && wsById(msg.p) && !openLocal.has(msg.p)) watchAll(); }, 1500);
    }
    else if (msg.type === 'prefs') { PREFS = Object.assign({ costumes: {}, desks: {}, templates: [] }, msg.prefs || {}); Office.setPrefs(PREFS); Office.setChatInterval((PREFS.chatter || {}).mode === 'builtin' ? 25 : (PREFS.chatter || {}).interval || 75); }
    else if (msg.type === 'chat_lines') { Office.chatReply(msg.a, msg.b, msg.lines); if (msg.source && msg.source !== 'builtin') lastChatSource = msg.source; }
    else if (msg.type === 'action_result') { const r = pending[msg.rid]; if (r) { delete pending[msg.rid]; r(msg); } }
    else if (msg.type === 'error') { if (msg.rid && pending[msg.rid]) { pending[msg.rid]({ error: msg.message }); delete pending[msg.rid]; } toast(msg.message, 'blocked'); }
    else if (msg.type === 'notice') toast(msg.text, 'blocked', msg.workspace_id);
  };
  sock.onclose = ev => {
    openLocal.clear();
    if (ev.code === 4401) { location.href = '/login'; return; }
    STATE.terminals = false; renderStatus(); $('sb-conn').textContent = 'ui server unreachable';
    setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 8000);
  };
  sock.onerror = () => sock.close();
}

// ───────────────────────── resizing, toggles, shortcuts ─────────────────────────
let relayoutQueued = false;
function queueLayout() { if (relayoutQueued) return; relayoutQueued = true; requestAnimationFrame(() => { relayoutQueued = false; if ($('log-view').hidden) Office.layout(); Terms.fitAll(); }); }
new ResizeObserver(queueLayout).observe($('split'));
new ResizeObserver(queueLayout).observe($('office-wrap'));
function drag(sash, onMove) {
  sash.addEventListener('mousedown', e => {
    e.preventDefault(); sash.classList.add('active'); document.body.classList.add('dragging'); document.body.style.cursor = getComputedStyle(sash).cursor;
    const move = ev => onMove(ev), up = () => { sash.classList.remove('active'); document.body.classList.remove('dragging'); document.body.style.cursor = ''; window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); queueLayout(); setTimeout(Terms.fitAll, 80); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  });
}
drag($('sash-h'), ev => {
  if (document.body.classList.contains('side-layout')) {
    const split = $('split').getBoundingClientRect();
    const w = Math.max(240, Math.min(split.width - 340, split.right - ev.clientX));
    document.documentElement.style.setProperty('--office-w', w + 'px'); try { localStorage.setItem('office-w', String(w)); } catch (e) { }
    queueLayout();
  } else { Office.setHeight(ev.clientY - $('office-wrap').getBoundingClientRect().top); Terms.fitAll(); }
});
let layoutPref = 'stacked';
function applyLayoutMode(side) {
  layoutPref = side ? 'side' : 'stacked';
  try { localStorage.setItem('layout', layoutPref); const w = localStorage.getItem('office-w'); if (w) document.documentElement.style.setProperty('--office-w', w + 'px'); } catch (e) { }
  $('btn-layout').classList.toggle('on', side);
  syncLayoutMode();
}
function syncLayoutMode() {   // side by side needs room for both; below 640px the office goes back on top
  const side = layoutPref === 'side' && window.innerWidth >= 640;
  if (document.body.classList.contains('side-layout') === side && Office.mode === (side ? 'side' : 'stacked')) return;
  document.body.classList.toggle('side-layout', side);
  Office.setMode(side ? 'side' : 'stacked');
  setTimeout(() => { Office.layout(); Terms.fitAll(); }, 60);
}
$('btn-layout').onclick = () => applyLayoutMode(layoutPref !== 'side');
window.addEventListener('resize', syncLayoutMode);
try { if (localStorage.getItem('layout') === 'side') applyLayoutMode(true); } catch (e) { }
$('sash-h').addEventListener('dblclick', () => { if (document.body.classList.contains('side-layout')) { document.documentElement.style.setProperty('--office-w', '50%'); try { localStorage.removeItem('office-w'); } catch (e) { } queueLayout(); } else { Office.resetHeight(); Terms.fitAll(); } });
function toggleSide() { document.body.classList.toggle('hide-side'); $('btn-side').classList.toggle('on', !document.body.classList.contains('hide-side')); }
function toggleOffice() { document.body.classList.toggle('hide-office'); $('btn-office').classList.toggle('on', !document.body.classList.contains('hide-office')); Terms.fitAll(); }
function toggleAttn() { document.body.classList.toggle('hide-attn'); $('btn-attn').classList.toggle('on', !document.body.classList.contains('hide-attn')); Terms.fitAll(); }
$('btn-side').onclick = toggleSide; $('sb-side').onclick = toggleSide;
$('btn-office').onclick = toggleOffice; $('sb-office').onclick = toggleOffice; $('btn-attn').onclick = toggleAttn;
$('act-refresh').onclick = () => send({ type: 'refresh' });
$('act-bell').onclick = () => { const p = $('notif-pop'); p.hidden = !p.hidden; if (!p.hidden) { unseen = 0; $('bell-badge').hidden = true; renderRecent(); } };
$('notif-clear').onclick = () => { recent.length = 0; renderRecent(); };
document.addEventListener('mousedown', e => { if (!e.target.closest('#notif-pop') && !e.target.closest('#act-bell')) $('notif-pop').hidden = true; });
function applyTheme() { document.body.classList.toggle('light', !!opts.light); Terms.setTheme(opts.light ? 'light' : 'dark'); $('act-theme').classList.toggle('on', !!opts.light); }
$('act-theme').onclick = () => { opts.light = !opts.light; saveOpts(); applyTheme(); $('opt-light').checked = !!opts.light; };
$('opt-light').onchange = e => { opts.light = e.target.checked; saveOpts(); applyTheme(); };
function applyPromptBox() { const on = opts.promptBox !== false; ['prompt-wrap', 'send', 'broadcast'].forEach(id => { $(id).hidden = !on; }); $('opt-prompt').checked = on; setTimeout(Terms.fitAll, 30); }
$('opt-prompt').onchange = e => { opts.promptBox = e.target.checked; saveOpts(); applyPromptBox(); };
// how this device meets a terminal wider than it shows at 13 px: shrink the text, scroll, or set the width itself (attach as a rigid viewer)
function termFit() { return opts.termFit === 'shrink' ? 'shrink' : 'keep'; }   // the pty follows whoever used it last; when a console owns it, this screen keeps its font and scrolls (default) or shrinks the text to fit
function applyTermFit(reattach) {
  const mode = termFit(); $('opt-termfit').value = mode; Terms.setShrink(mode === 'shrink');
  if (reattach) { [...openLocal].forEach(pid => { openLocal.delete(pid); send({ type: 'pclose', pane_id: pid }); }); watchAll(); }   // the rigid flag lives on the attachment
}
$('opt-termfit').onchange = e => { opts.termFit = e.target.value; saveOpts(); applyTermFit(true); };
applyTermFit(false);
applyPromptBox();
applyTheme();
window.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSide(); }
  else if (mod && e.key.toLowerCase() === 'j') { e.preventDefault(); toggleOffice(); }
  else if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
  else if (e.key === 'Escape') { ['settings', 'newws', 'bcast', 'costume', 'palette'].forEach(id => $(id).hidden = true); ctx.hidden = true; }
});
function tick() {
  if (STATE.workspaces.length) renderStrip(); $('sb-clock').textContent = new Date().toLocaleTimeString('en-GB'); }
tick(); setInterval(tick, 1000);
connect();
