[← back to the README](../README.md)

# How it works

The parts, the protocols between them, and the reasoning behind the odd bits.

```
browser ──── websocket /ws ────► app.py (FastAPI, uvicorn)
   │  static/app.js  office.js  terminal.js        │
   │                                               ├─ terms.py ── unix socket ────► ptyd.py (agent-masterd)
   │                                               │      one pty per workspace: claude, codex, shells
   │                                               │      ◄── hooks/term-status.py (Claude Code hooks)
   │                                               ├─ hub.py: the office state (terminals + headless agents), pushed to every browser
   │                                               ├─ transcript.py ◄── ~/.claude/projects/<cwd>/<session>.jsonl
   │                                               ├─ chatter.py ──► Anthropic API | claude -p | built-in lines
   │                                               └─ store.py ──► ~/.config/agent-master/events.db (SQLite)
```

**Terminal server.** `ptyd.py` (`agent-masterd`) owns one pseudo-terminal per workspace, started in
the workspace folder as a login shell that runs the agent and then leaves you at a prompt. It listens
on `~/.config/agent-master/ptyd.sock` (mode 600) for newline JSON: a control connection lists,
creates, closes, restarts and sends text, and subscribes to changes; an attach connection receives
the terminal's recent output (up to 4 MB, replayed so a reopened page shows the same screen) and then
the live bytes, and sends keystrokes and resizes back. The terminal list is saved in
`terminals.json`. Claude Code terminals are started with `--session-id <uuid>` (or `--resume` when the
session file exists) and `--settings claude-hooks.json`, which sets `"tui": "default"` (the normal scrolling screen, whatever `~/.claude/settings.json` says, so the transcript can be backfilled into the scrollback) and adds hooks for SessionStart,
UserPromptSubmit, Pre/PostToolUse, Notification, Stop and SessionEnd, plus a `statusLine` command
(the same script with `StatusLine`). Claude Code runs the status line on every screen update with a
JSON snapshot (session name, model, version, cost, lines, context window, prompt cache, rate
limits); the script forwards it to the server, which passes identity changes on at once and the
counters at most every 2 s, and prints the stats line shown under the input box. An update is
reported when the installed `~/.local/bin/claude` is newer than the version the agent runs. Each
Claude terminal is started with `--name <label>`. The hook (`hooks/term-status.py`) reports each event over the socket: that is how the server knows the session
id, the task, working, blocked (a permission prompt), done, and which files a tool touched. An agent
still marked working whose screen has been still for 15 s was interrupted and goes back to idle.

**Terminal server protocol.** Every request is one JSON line on `ptyd.sock`; the reply is one JSON
line with the same `rid` and `ok: true`, or `error`. You can script it with anything that speaks unix
sockets (the console and `terms.py` are both small clients).

| Request | Fields | Does |
|---|---|---|
| `list` | | every terminal with its status, stats, size and viewer count |
| `subscribe` | | like `list`, then a `{"ev": "terms", ...}` line on every change and `{"ev": "tool", ...}` for each tool call |
| `create` | `kind` (`claude`, `agent`, `command`, `shell`), `cwd`, `label`, `command`, `model`, `permission_mode`, `resume`, `cols`, `rows` | starts a terminal |
| `send` | `id`, `text` | types text; a trailing `\r` is sent as its own keystroke so agents treat it as Enter |
| `close` / `restart` / `rename` / `seen` | `id` (`label` for rename) | ends it / starts its process again / renames it / marks done as seen |
| `attach` | `id`, optional `cols`, `rows`, `tail` (bytes of replay), `redraw` | the reply carries the terminal's current `modes` (mouse reporting, bracketed paste, focus events); the raw output follows, starting with those modes restated. Send `{"op": "in", "d": ...}`, `{"op": "resize", ...}` or `{"op": "redraw"}` lines back |
| `hook`, `stats` | `id`, `event`, `data` | used by `hooks/term-status.py` |

**Reload.** On SIGUSR1 (`systemctl --user reload agent-masterd`) the server writes each terminal's
state and output buffer to its config folder, marks the terminals' file descriptors inheritable and
executes its own script again in the same process; the new code adopts the open terminals and the
processes in them (still its children), and viewers reattach within a second or two.

**Browser terminals.** `terms.py` in the web app subscribes to the terminal server and merges each
terminal into the office state as a workspace `t:<id>`. When a browser opens a terminal it sends
`popen` with its size; the web app opens an attach connection and forwards the output as binary
websocket frames (`[id length][id][bytes]`), which the browser writes straight into xterm.js.
Keystrokes go back as `pin`, resizes as `presize`. Nothing is re-rendered or rewritten on the way.

**Console.** `cli.py` (installed as `agent-master`) talks to the same socket as the web app. The
console keeps its own copy of the selected terminal's screen: it asks for the recent output (the
last 200 KB), feeds it and the live bytes through [pyte](https://github.com/selectel/pyte) (a
terminal emulator in Python, vendored in `vendor/pyte`), makes the program repaint at the pane's
size, and draws the changed rows next to the sidebar. Two filters sit in front of pyte: sequences
with a private marker such as `ESC[>4m` (keyboard modes Claude Code sets, which pyte would read as
"underline") are dropped, and dim text (SGR 2, which pyte does not know) is carried in an unused
attribute and drawn dim. `--plain` skips all of that and pipes the raw bytes to your terminal.

**State.** One `Hub` holds the office: every terminal from `agent-masterd` and every headless agent
as a workspace with one pane. The terminal server and the agent runner push a refresh whenever
something changes, and the hub polls every 3 s as a safety net. Each refresh is diffed against the
previous one into events (status changed, workspace opened or closed, agent started or gone) that
are written to SQLite and broadcast to every browser together with the full state. Status times
survive a restart: they are seeded from the last recorded status event, and unknown ones are
flagged so the office does not treat them as fresh. The git branch comes from `git` in each
workspace's directory, cached per directory.

**Headless agents.** `agents.py` runs one `claude -p --input-format stream-json --output-format
stream-json --include-partial-messages --permission-prompt-tool stdio` process per agent, in the
agent's folder, with `--resume <session id>` when the session already exists. A prompt is written
to stdin as a user message; stdout delivers `system/init` (session id, model), `stream_event` text
deltas (forwarded as `agent_delta`, coalesced every 80 ms), `assistant` messages (text, tool calls),
`user` messages carrying tool results, `control_request` / `can_use_tool` permission requests and
the `result` of each turn with tokens and cost. Every event is stored in `agent_events` and pushed
to the browsers as `agent_event`; a permission answer goes back as `control_response`, an interrupt
as a control request. Each agent is merged into the hub's state as a virtual workspace (`a:<id>`)
with its own exact status times, so the office, ribbon, attention panel, balloons, visits (from the
tool calls themselves, no hook needed) and cards need no special cases. The process is stopped on
demand or when the UI restarts and is started again, resuming the same session, by the next prompt.
`chat.js` renders the conversation from the stored events plus the live stream.

**Saved history.** When a session is adopted or resumed, its full Claude Code transcript is imported
once into the `agent_history` table (`transcript.all_entries`), so each workspace carries its own
history independent of Claude Code's files. The chat view loads it newest-first from the database,
paging back to the start, drawn in the terminal style (`> prompt`, `⏺ reply`, `⎿ result`), with a
marker where the session became headless. `POST /api/agents/import-history` (re)imports every agent.

**Transcript in the terminal.** The terminal server knows each Claude Code pane's session id and
when the oldest byte still in its replay buffer was written; `transcript.py` finds the matching
Claude Code session file and pages through the entries older than that moment (600 per page:
prompts, assistant text, tool calls, tool results), then continues into the folder's earlier
sessions, newest first, with a seam entry where each one ended. When a terminal is opened, or a
restarted process resets it, the browser waits for the replay to finish streaming, captures the live
screen with the serialize addon, rebuilds the buffer with those entries in the scrollback and a
marker where the terminal's own output begins, and puts the screen back below them. Scrolling to
the top loads the previous page; the scrollback holds 200,000 lines. A fullscreen program owns the whole screen, so such a cell shows a
"history · N entries" chip that opens the page view instead. The same file gives the card its model, Claude
Code version, effort, counts and token totals, cached by file size and mtime.

**Office.** `office.js` is a canvas engine with no dependencies. A floor plan (wide, compact, or tall
for the side-by-side layout) is chosen from the strip's size; the room is painted once to an
offscreen canvas (floors, walls, furniture, decor, all drawn in code), and every animation frame
draws that room plus the animated layer: lit monitors, the TV scene, the ping-pong ball, the clock
hands, the whiteboard text, nameplates, characters, and at night a tint with light pools. Each
workspace has an agent object with a position, a desk (the first free one, or the one you chose), a
seat, an activity and a small state machine: status changes send it to its desk or keep it lingering
in the work area, idle time sends it to the lounge where it picks free seats and rotates between
them, tool-call hooks make it walk to another workspace's desk for a visit, and drag and drop places
it wherever you like. Costume colours and hairstyle derive from the workspace id unless set in the
costume dialog. Labels and balloons are DOM elements positioned over the canvas. Lounge chats are
requested from the server, which builds a briefing from the transcripts, statuses, events and the
lines already said, and asks Claude (API or CLI) for the next exchange, falling back to built-in lines.

**Visits.** Every tool call reaches the hub through the Claude Code hooks (the terminal server's
`PostToolUse` hook for terminals, the JSON stream for headless agents). The hub maps the file path or
command to the workspace whose directory is its longest prefix; if that is another workspace, the
office plays a visit.

**VS Code.** `code_server.py` proxies `/code/` to `code serve-web` on localhost: HTTP requests are
streamed through with the connection token added as VS Code's `vscode-tkn` cookie, and each browser
websocket is bridged frame by frame to VS Code's, subprotocol included. VS Code for the Web keeps the
user's settings in the browser, so the proxy injects configuration defaults into the workbench page
(dark theme, no chat or agent panel, no welcome page, no Restricted Mode for these folders); a JSON
object in `~/.config/agent-master/code-defaults.json` is merged on top, and anything can still be
changed in VS Code itself. The proxy sits behind the
same sign-in and host checks as everything else; VS Code keeps its own body limits and security
headers. The web app tells the page whether VS Code is listening, and the "Edit with VS Code" buttons open
`/code/?folder=<workspace folder>` in a new tab.

**Browser.** Vanilla JavaScript, no build step: `app.js` (state, ribbon, attention panel, prompts,
palette, log, settings, layouts, cards), `office.js`, `terminal.js` (xterm cells), `style.css`. xterm.js with the fit and serialize addons is vendored. Preferences that matter
across devices (costumes, desks, templates, chatter settings) are stored on the server; layout,
selection and options that are per device stay in `localStorage`.

**Auth.** PBKDF2 password hashes and an HMAC session secret in the config file; every request passes
one middleware that enforces the host rules, the tunnel-only rule, origin checks on writes, body
caps and the security headers before routing.
