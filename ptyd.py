"""agent-masterd: the terminal server of Agent-Master.

Owns one real pseudo-terminal per workspace (Claude Code, another agent, or a plain shell), keeps recent output
in memory so any browser can reattach instantly, remembers each Claude session id and resumes it after a restart,
and learns agent status (working, blocked, done) from Claude Code hooks instead of reading the screen.

It runs as its own service, so restarting or updating the web UI never touches a running agent.
Clients talk to it over a unix socket (mode 0600) with newline-delimited JSON:

  control connection   {"op": "list"|"create"|"close"|"rename"|"restart"|"send"|"subscribe"|"hook", "rid": ..., ...}
  attach connection    first line {"op": "attach", "id": ..., "cols": ..., "rows": ..., "active": bool}; the reply line is followed by
                       the raw terminal output (replay, then live bytes). Lines sent back: {"op": "in", "d": "..."} and
                       {"op": "resize", "cols": ..., "rows": ...}.
"""

import argparse
import asyncio
import errno
import fcntl
import json
import logging
import re
import os
import secrets
import shlex
import shutil
import signal
import struct
import subprocess
import sys
import termios
import time
import uuid
from pathlib import Path

from transcript import find_transcript, latest_session

log = logging.getLogger("agent-masterd")
ROOT = Path(__file__).resolve().parent
REPLAY_BYTES = 4 * 1024 * 1024      # output kept per terminal for reattaching
MAX_CLIENT_BACKLOG = 8 * 1024 * 1024  # a viewer this far behind is dropped (it reattaches and gets the replay)
DEFAULT_SIZE = (120, 40)
SILENT_IDLE = 15.0                   # a "working" agent whose screen has been still this long was interrupted
AGENTS = {"claude", "codex", "gemini", "opencode", "aider"}
# terminal modes a viewer must know even when the sequence that set them is older than the replay:
# mouse reporting (and its SGR encoding), bracketed paste, focus events
TRACKED_MODES = {1000, 1002, 1003, 1006, 2004, 1004}
MODE_SEQ = re.compile(rb"\x1b\[\?([\d;]+)([hl])")
HOOK_EVENTS = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop"]


def version_tuple(v):
    try:
        return tuple(int(x) for x in str(v).split("."))
    except ValueError:
        return ()


def config_dir():
    d = os.environ.get("AGENT_MASTER_CONFIG_DIR")
    if d:
        return Path(d).expanduser()
    return Path("~/.config/agent-master").expanduser()


def user_shell():
    sh = os.environ.get("SHELL") or ""
    if not sh or not os.path.exists(sh):
        try:
            import pwd
            sh = pwd.getpwuid(os.getuid()).pw_shell
        except (KeyError, ImportError):
            sh = ""
    return sh if sh and os.path.exists(sh) else "/bin/bash"


def find_exe(name):
    extra = [str(Path("~/.local/bin").expanduser()), str(Path("~/.npm-global/bin").expanduser()), "/usr/local/bin"]
    return shutil.which(name) or shutil.which(name, path=os.pathsep.join(extra + [os.environ.get("PATH", "")]))


class Adopted:
    """A child process inherited across a reload (exec keeps the pid, but the Popen object is gone)."""

    def __init__(self, pid):
        self.pid, self.returncode = pid, None

    def poll(self):
        if self.returncode is None:
            try:
                p, status = os.waitpid(self.pid, os.WNOHANG)
            except ChildProcessError:
                self.returncode = -1
                return self.returncode
            if p:
                self.returncode = os.waitstatus_to_exitcode(status)
        return self.returncode

    def wait(self, timeout=None):
        end = time.time() + (timeout if timeout is not None else 1e9)
        while self.poll() is None:
            if time.time() > end:
                raise subprocess.TimeoutExpired("adopted", timeout)
            time.sleep(0.05)
        return self.returncode


class Term:
    def __init__(self, d, rec):
        self.d = d
        self.id = rec["id"]
        self.number = rec.get("number", 1)
        self.label = rec.get("label") or self.id
        self.cwd = rec.get("cwd") or str(Path.home())
        self.kind = rec.get("kind") or "shell"          # claude | agent | shell | command
        self.command = rec.get("command") or ""         # agent name or custom command line
        self.model = rec.get("model")
        self.permission_mode = rec.get("permission_mode")
        self.session_id = rec.get("session_id")
        self.prev_session_id = rec.get("prev_session_id")   # the id before the last change, so a wrong resume can be undone
        self.agent_active = rec.get("agent_active", self.kind != "shell")
        self.created = rec.get("created") or time.time()
        self.status = "idle" if self.agent_active else "none"
        self.status_since = time.time()
        self.task = rec.get("task")
        self.question = None
        self.cols, self.rows = DEFAULT_SIZE
        self.fixed_cols = rec.get("fixed_cols") or None
        self.fixed_rows = rec.get("fixed_rows") or None
        if self.fixed_cols and self.fixed_rows:
            self.cols, self.rows = int(self.fixed_cols), int(self.fixed_rows)
        self.follow = bool(rec.get("follow"))   # kept for older records; the size rule below no longer needs it
        self.owner = None          # the viewer whose size the pty follows: the one that attached, typed or resized last
        self.owner_at = 0.0
        self.viewer_sizes = {}    # attach writer -> (cols, rows) that viewer can show
        self.fd = None
        self.proc = None
        self.buf = bytearray()
        self.buf_since = float(rec.get("buf_since") or 0.0)   # when the oldest byte still in the replay was written: the transcript fills in what is older
        self._marks = [tuple(m) for m in (rec.get("marks") or [])]   # (offset, time) checkpoints through the replay, for buf_since after a trim
        self.clients = set()      # attach writers
        self.pending_in = bytearray()
        self.last_output = 0.0
        self.exited = None        # exit code once the process ended
        self.started = 0.0
        self.stats = rec.get("stats") or {}   # Claude Code's status snapshot: model, version, cost, context, limits
        self.modes = {int(k): v for k, v in (rec.get("modes") or {}).items()}   # tracked terminal modes currently on or off
        self._stats_due = None

    # ── persistence ──
    def record(self):
        return {"id": self.id, "number": self.number, "label": self.label, "cwd": self.cwd, "kind": self.kind, "command": self.command,
                "model": self.model, "permission_mode": self.permission_mode, "session_id": self.session_id,
                "agent_active": self.agent_active, "created": self.created, "task": self.task, "stats": self.stats,
                "fixed_cols": self.fixed_cols, "fixed_rows": self.fixed_rows, "follow": self.follow, "prev_session_id": self.prev_session_id,
                "buf_since": self.buf_since, "marks": self._marks[-64:]}

    def set_session(self, sid):
        """Switch to another Claude Code session id, keeping the current one as prev_session_id."""
        if not sid or sid == self.session_id:
            return False
        if self.session_id:
            self.prev_session_id = self.session_id
        self.session_id = sid
        return True

    def info(self):
        run = (self.stats or {}).get("version")
        inst = self.d.installed_version()
        return {**self.record(), "stats": self.stats, "claude_version": run, "installed_version": inst,
                "update": bool(run and inst and version_tuple(inst) > version_tuple(run)), "status": self.status, "status_since": self.status_since, "question": self.question,
                "running": self.exited is None and self.proc is not None, "exit_code": self.exited, "pid": self.proc.pid if self.proc else None,
                "cols": self.cols, "rows": self.rows, "viewers": len(self.clients), "agent": self.agent_name() if self.agent_active else None,
                "buf_bytes": len(self.buf), "buf_since": self.buf_since}

    def agent_name(self):
        if self.kind == "claude":
            return "claude"
        if self.kind == "agent":
            return (self.command.split() or ["agent"])[0]
        return None

    # ── process ──
    def argv(self):
        sh = user_shell()
        if self.kind == "shell" or not self.agent_active:
            return [sh, "-l"]
        if self.kind == "claude":
            exe = find_exe("claude") or "claude"
            cmd = [exe, "--settings", str(self.d.hooks_file), "--name", self.label]
            if self.session_id and find_transcript(self.session_id):
                cmd += ["--resume", self.session_id]
            else:
                if self.session_id:   # a resume that cannot find its transcript must not silently become a new chat
                    old = self.session_id
                    log.warning("%s: no transcript for session %s on this machine; starting a new session (old id kept)", self.label, old)
                    self.set_session(str(uuid.uuid4()))
                    self.d.emit({"ev": "notice", "id": self.id, "label": self.label,
                                 "text": f"{self.label}: session {old[:8]}… has no transcript on this machine, so a new session was started. "
                                         "The card offers the previous session."})
                    self.d.changed(save=True)
                else:
                    self.session_id = str(uuid.uuid4())
                cmd += ["--session-id", self.session_id]
            if self.model:
                cmd += ["--model", self.model]
            if self.permission_mode == "bypassPermissions":   # run every command without asking: needs the explicit opt-in flag too
                cmd += ["--permission-mode", "bypassPermissions", "--dangerously-skip-permissions"]
            elif self.permission_mode:
                cmd += ["--permission-mode", self.permission_mode]
            line = shlex.join(cmd)
        else:
            line = self.command
        # the agent runs inside a login shell and leaves you at a prompt when it exits, like a normal terminal tab
        return [sh, "-lc", f"{line}; exec {shlex.quote(sh)} -l"]

    def env(self):
        env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "AGENT_MASTER_", "INVOCATION_ID", "JOURNAL_STREAM", "NOTIFY_SOCKET"))}
        env.pop("CLAUDECODE", None)
        local_bin = str(Path("~/.local/bin").expanduser())
        if local_bin not in env.get("PATH", "").split(os.pathsep):
            env["PATH"] = local_bin + os.pathsep + env.get("PATH", "/usr/local/bin:/usr/bin:/bin")
        env.update({"TERM": "xterm-256color", "COLORTERM": "truecolor", "TERM_PROGRAM": "agent-master",
                    "AGENT_MASTER_TERM": self.id, "AGENT_MASTER_SOCK": str(self.d.sock_path)})
        env.setdefault("LANG", "C.UTF-8")
        env.setdefault("HOME", str(Path.home()))
        return env

    def start(self):
        master, slave = os.openpty()
        self._winsize(slave)
        cwd = self.cwd if os.path.isdir(self.cwd) else str(Path.home())

        def child_setup():   # runs after setsid(): make the pty our controlling terminal
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)
            signal.signal(signal.SIGPIPE, signal.SIG_DFL)

        self.proc = subprocess.Popen(self.argv(), stdin=slave, stdout=slave, stderr=slave, cwd=cwd, env=self.env(),
                                     start_new_session=True, preexec_fn=child_setup, close_fds=True)
        os.close(slave)
        os.set_blocking(master, False)
        self.fd = master
        self.exited = None
        self.started = time.time()
        self.buf_since, self._marks = self.started, []   # a fresh process, a fresh replay
        self.last_output = time.time()
        asyncio.get_running_loop().add_reader(master, self._on_read)
        log.info("started %s (%s) pid %s in %s", self.label, self.kind, self.proc.pid, cwd)

    def _winsize(self, fd):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", self.rows, self.cols, 0, 0))

    def resize(self, cols, rows):
        if self.fixed_cols and self.fixed_rows:
            cols, rows = int(self.fixed_cols), int(self.fixed_rows)
        cols, rows = max(20, min(int(cols), 500)), max(5, min(int(rows), 200))
        if (cols, rows) == (self.cols, self.rows):
            return
        self.cols, self.rows = cols, rows
        self.d.emit({"ev": "terms", "terms": self.d.list()})   # the new size goes out before the repaint, so a viewer that emulates the screen resizes first
        if self.fd is not None:
            try:
                self._winsize(self.fd)
                os.killpg(self.proc.pid, signal.SIGWINCH)
            except OSError:
                pass

    def apply_size(self):
        """The pty follows whoever typed last: that viewer owns the size (and its own resizes follow), and every other
        viewer shows that grid its own way (a margin when it is smaller, scrolling or a smaller font when it is bigger).
        Opening a workspace in a second app changes nothing until you type there, so a console and a browser can both
        have it open and each looks right while it is the one in use. The first viewer of a terminal sets its size.
        A pinned size overrides all of this; with no viewer the last size stays."""
        if self.fixed_cols and self.fixed_rows:
            self.resize(self.fixed_cols, self.fixed_rows)
            return
        if self.owner not in self.viewer_sizes:   # the owner left: the most recent remaining viewer takes over
            self.owner = next(reversed(self.viewer_sizes), None)
        size = self.viewer_sizes.get(self.owner) if self.owner is not None else None
        if size:
            self.resize(size[0], size[1])

    def take_size(self, writer):
        """A viewer used the terminal: it owns the size from now on (typing switches at most every 1.5 s, so two people
        typing at once do not make the program repaint on every keystroke)."""
        now = time.monotonic()
        if writer is self.owner:
            return
        if now - self.owner_at < 1.5:
            return
        self.owner, self.owner_at = writer, now
        self.apply_size()

    def set_fixed_size(self, cols, rows):
        """Pin the pty to (cols, rows). Pass None for both to unfix. Returns the new (cols, rows) or None."""
        if cols and rows:
            cols = max(20, min(int(cols), 500))
            rows = max(5, min(int(rows), 200))
            self.fixed_cols, self.fixed_rows = cols, rows
            self.follow = False
            prev = (self.cols, self.rows)
            self.cols, self.rows = cols, rows
            if self.fd is not None and prev != (cols, rows):
                try:
                    self._winsize(self.fd)
                    os.killpg(self.proc.pid, signal.SIGWINCH)
                except OSError:
                    pass
            return (cols, rows)
        self.fixed_cols = self.fixed_rows = None
        self.follow = True
        return None

    def mode_prefix(self):
        """Escape sequences that put a fresh viewer into the terminal's current modes."""
        return "".join(f"\x1b[?{n}{'h' if on else 'l'}" for n, on in sorted(self.modes.items())).encode()

    def redraw(self):
        """Make the program repaint its whole screen: a quick size change sends it two SIGWINCH."""
        if self.fd is None or not self.proc:
            return
        cols, rows = self.cols, self.rows
        try:
            fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", max(5, rows - 1), cols, 0, 0))
            os.killpg(self.proc.pid, signal.SIGWINCH)
        except OSError:
            return

        def back():
            if self.fd is not None and (self.cols, self.rows) == (cols, rows):
                try:
                    self._winsize(self.fd)
                    os.killpg(self.proc.pid, signal.SIGWINCH)
                except OSError:
                    pass
        asyncio.get_running_loop().call_later(0.08, back)

    def _on_read(self):
        try:
            data = os.read(self.fd, 65536)
        except BlockingIOError:
            return
        except OSError as exc:
            if exc.errno != errno.EIO:
                log.warning("%s: read failed: %s", self.label, exc)
            data = b""
        if not data:
            self._ended()
            return
        self.last_output = time.time()
        if b"\x1b[?" in data:
            for nums, flag in MODE_SEQ.findall(data):
                for n in nums.split(b";"):
                    if n.isdigit() and int(n) in TRACKED_MODES:
                        self.modes[int(n)] = flag == b"h"
        self.buf += data
        if not self._marks or len(self.buf) - self._marks[-1][0] >= 65536:   # a checkpoint every 64 KB of output
            self._marks.append((len(self.buf), time.time()))
        if len(self.buf) > REPLAY_BYTES:
            cut = len(self.buf) - REPLAY_BYTES
            nl = self.buf.find(b"\n", cut)
            n = nl + 1 if 0 <= nl < cut + 65536 else cut
            del self.buf[:n]
            self._marks = [(o - n, t) for o, t in self._marks if o - n > 0]
            self.buf_since = self._marks[0][1] if self._marks else time.time()   # the oldest kept byte is no newer than the first remaining checkpoint
        for w in list(self.clients):
            if w.transport.get_write_buffer_size() > MAX_CLIENT_BACKLOG:
                log.info("%s: dropping a viewer that fell behind", self.label)
                self.clients.discard(w)
                w.close()
                continue
            w.write(data)

    def _ended(self):
        loop = asyncio.get_running_loop()
        if self.fd is not None:
            loop.remove_reader(self.fd)
            loop.remove_writer(self.fd)
            try:
                os.close(self.fd)
            except OSError:
                pass
            self.fd = None
        code = self.proc.poll() if self.proc else None
        if code is None and self.proc:
            try:
                code = self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                code = -1
        self.exited = code if code is not None else -1
        msg = f"\r\n\x1b[2m[process exited with code {self.exited} · press Enter to start it again]\x1b[0m\r\n".encode()
        self.buf += msg
        for w in list(self.clients):
            w.write(msg)
        self.agent_active = False if self.kind == "shell" else self.agent_active
        self.set_status("none" if self.kind == "shell" else "idle")
        log.info("%s exited with %s", self.label, self.exited)
        self.d.changed()

    def write(self, data: bytes):
        if self.fd is None:
            if self.exited is not None and b"\r" in data:
                self.restart()
            return
        self.pending_in += data
        self._flush_in()

    def _flush_in(self):
        loop = asyncio.get_running_loop()
        while self.pending_in and self.fd is not None:
            try:
                n = os.write(self.fd, bytes(self.pending_in[:65536]))
            except BlockingIOError:
                loop.add_writer(self.fd, self._flush_in)
                return
            except OSError:
                self.pending_in.clear()
                return
            del self.pending_in[:n]
        if self.fd is not None:
            loop.remove_writer(self.fd)

    def stop(self, sig=signal.SIGHUP):
        if self.proc and self.exited is None:
            try:
                os.killpg(self.proc.pid, sig)
            except (ProcessLookupError, PermissionError):
                pass

    def restart(self):
        if self.exited is None and self.proc:
            return
        if self.kind != "shell":
            self.agent_active = True
            self.status = "idle"
            self.status_since = time.time()
        del self.buf[:]   # a new process starts on a clean screen: the old output is gone from every viewer after the reset, so the replay drops it too
        self.buf += b"\x1bc"
        for w in list(self.clients):
            w.write(b"\x1bc")
        self.start()
        self.d.changed()

    # ── status ──
    def set_status(self, st, task=None, question=None):
        changed = False
        if st and st != self.status:
            self.status, self.status_since, changed = st, time.time(), True
        if task is not None and task != self.task:
            self.task, changed = task, True
        q = question if st == "blocked" else None
        if q != self.question:
            self.question, changed = q, True
        if changed:
            self.d.changed(save=task is not None)

    def hook(self, event, data):
        name = event or data.get("hook_event_name")
        if name == "SessionStart":
            sid = data.get("session_id")
            if sid and sid != self.session_id:
                self.set_session(sid)
            self.agent_active = True
            self.set_status("idle")
            self.d.changed(save=True)
        elif name == "SessionEnd":
            self.agent_active = False
            self.set_status("none")
            self.d.changed(save=True)
        elif name == "UserPromptSubmit":
            prompt = " ".join(str(data.get("prompt") or "").split())
            self.set_status("working", task=prompt[:160] or None)
        elif name in ("PreToolUse", "PostToolUse"):
            self.set_status("working")
            if name == "PostToolUse":
                self.d.emit({"ev": "tool", "id": self.id, "tool": data.get("tool_name"), "input": data.get("tool_input") or {}})
        elif name == "Notification":
            kind, msg = data.get("notification_type") or "", str(data.get("message") or "")
            if kind == "permission_prompt" or (not kind and "permission" in msg.lower()):
                self.set_status("blocked", question=msg[:400])
            elif kind == "elicitation_dialog":
                self.set_status("blocked", question=msg[:400])
        elif name == "Stop":
            self.set_status("idle" if self.clients else "done")

    def seen(self):
        if self.status == "done":
            self.set_status("idle")

    def set_stats(self, data):
        """A status snapshot from Claude Code, several a second while it works: identity changes are sent at once,
        counters (cost, context, limits) at most every 2 s."""
        old = self.stats or {}
        self.stats = data
        ident = lambda st: (st.get("session_name"), (st.get("model") or {}).get("id"), st.get("version"), st.get("session_id"))
        if ident(old) != ident(data):
            sid = data.get("session_id")
            if sid and sid != self.session_id:
                self.set_session(sid)
            self.d.changed(save=True)
        elif self._stats_due is None:
            def fire():
                self._stats_due = None
                self.d.changed()
            self._stats_due = asyncio.get_running_loop().call_later(2.0, fire)


class Daemon:
    def __init__(self, cfg: Path, sock=None):
        self.cfg = cfg
        self.cfg.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.sock_path = Path(sock) if sock else cfg / "ptyd.sock"
        self.state_file = cfg / "terminals.json"
        self.hooks_file = cfg / "claude-hooks.json"
        self.terms: dict[str, Term] = {}
        self.subscribers = set()
        self._notify = None
        self._save_due = False
        self._inst = (None, 0.0)
        self.server = None

    # ── setup ──
    def installed_version(self):
        now = time.time()
        if now - self._inst[1] > 30:
            name = os.path.basename(os.path.realpath(find_exe("claude") or ""))
            self._inst = (name if name[:1].isdigit() else None, now)
        return self._inst[0]

    def write_hooks(self):
        hook = ROOT / "hooks" / "term-status.py"
        py = shutil.which("python3") or "python3"
        hooks = {}
        for ev in HOOK_EVENTS:
            entry = {"hooks": [{"type": "command", "command": f"{shlex.quote(py)} -S {shlex.quote(str(hook))} {ev}", "timeout": 5}]}
            if ev in ("PreToolUse", "PostToolUse"):
                entry["matcher"] = "*"
            hooks[ev] = [entry]
        status_line = {"type": "command", "command": f"{shlex.quote(py)} -S {shlex.quote(str(hook))} StatusLine", "padding": 0}
        tmp = self.hooks_file.with_suffix(".tmp")
        # "tui": "default" keeps Claude Code on the normal screen in Agent-Master's terminals even when ~/.claude/settings.json
        # says "fullscreen": the fullscreen view owns the whole buffer, so the transcript could not be backfilled into the
        # scrollback after a close + start, and the replay would repaint only its last screen. Terminals outside Agent-Master keep the global choice.
        tmp.write_text(json.dumps({"hooks": hooks, "statusLine": status_line, "tui": "default"}, indent=1))
        os.replace(tmp, self.hooks_file)

    def load(self):
        try:
            recs = json.loads(self.state_file.read_text())
        except (OSError, ValueError):
            recs = []
        for rec in recs if isinstance(recs, list) else []:
            if isinstance(rec, dict) and rec.get("id"):
                self.terms[rec["id"]] = Term(self, rec)

    def save(self):
        recs = [t.record() for t in sorted(self.terms.values(), key=lambda t: t.number)]
        tmp = self.state_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(recs, indent=1))
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.state_file)

    def changed(self, save=False):
        self._save_due = self._save_due or save
        if self._notify is None:   # coalesce bursts of hook events into one update
            self._notify = asyncio.get_running_loop().call_later(0.05, self._flush_changes)

    def _flush_changes(self):
        self._notify = None
        if self._save_due:
            self._save_due = False
            try:
                self.save()
            except OSError as exc:
                log.warning("could not save terminals: %s", exc)
        self.emit({"ev": "terms", "terms": self.list()})

    def emit(self, msg):
        line = (json.dumps(msg) + "\n").encode()
        for w in list(self.subscribers):
            try:
                w.write(line)
            except Exception:
                self.subscribers.discard(w)

    def list(self):
        return [t.info() for t in sorted(self.terms.values(), key=lambda t: t.number)]

    # ── operations ──
    EGG_NAMES = ["Eggbert", "Shelly", "Yolko", "Humpty", "Benedict", "Omelette", "Scramble", "Sunny", "Poach", "Ovid",
                 "Eggatha", "Cracker", "Yolanda", "Shellby", "Eggsy", "Albumen", "Dumpty", "Peep", "Wobble", "Meringue"]

    def egg_name(self):
        """A plain shell is an egg in the office: it gets an egg name nobody else in the office is using."""
        used = {(t.label or "").split(" · ")[-1] for t in self.terms.values()}
        free = [n for n in self.EGG_NAMES if n not in used]
        if free:
            return free[0]
        n = 2
        while any(f"{name} {n}" in used for name in self.EGG_NAMES):
            n += 1
        return f"{self.EGG_NAMES[0]} {n}"

    def create(self, a):
        cwd = os.path.expanduser(str(a.get("cwd") or "~"))
        if not os.path.isdir(cwd):
            raise ValueError(f"{cwd} is not a directory")
        kind = a.get("kind") or "shell"
        command = str(a.get("command") or "").strip()
        if kind == "agent" and command == "claude":
            kind = "claude"
        if kind not in ("claude", "agent", "shell", "command") or (kind in ("agent", "command") and not command):
            raise ValueError("bad terminal kind")
        tid = secrets.token_hex(3)
        while tid in self.terms:
            tid = secrets.token_hex(3)
        number = max([t.number for t in self.terms.values()] + [0]) + 1
        label = str(a.get("label") or "").strip()[:60]
        if not label:
            label = os.path.basename(os.path.realpath(cwd).rstrip("/")) or "home"
            if kind == "shell":   # a shell is an egg in the office: its folder, then its egg name
                label = f"{label} · {self.egg_name()}"[:60]
        resume = a.get("resume") or None
        if kind == "claude" and not resume and not a.get("fresh"):
            # A folder that already has Claude Code conversations gets its latest one back, so the terminal opens with
            # its history instead of an empty chat. "fresh": true (the dialog's "start a new conversation") skips this;
            # a session another terminal is running right now is never taken.
            busy = {t.session_id for t in self.terms.values() if t.session_id and t.exited is None}
            resume = latest_session(os.path.realpath(cwd), exclude=busy)
            if resume:
                log.info("%s: continuing the folder's latest session %s", label, resume[:8])
        rec = {"id": tid, "number": number, "cwd": os.path.realpath(cwd), "kind": kind, "command": command, "label": label,
               "model": a.get("model") or None, "permission_mode": a.get("permission_mode") or None,
               "session_id": resume, "agent_active": kind != "shell", "created": time.time()}
        t = Term(self, rec)
        if a.get("cols") and a.get("rows"):
            t.cols, t.rows = max(20, min(int(a["cols"]), 500)), max(5, min(int(a["rows"]), 200))
        self.terms[tid] = t
        t.start()
        self.changed(save=True)
        return t.info()

    def close(self, tid):
        t = self.terms.pop(tid, None)
        if not t:
            raise KeyError("no such terminal")
        t.stop(signal.SIGHUP)
        asyncio.get_running_loop().call_later(3, t.stop, signal.SIGKILL)
        for w in list(t.clients):
            w.close()
        self.changed(save=True)

    async def handle_control(self, first, reader, writer):
        async def reply(rid, **kw):
            writer.write((json.dumps({"rid": rid, **kw}) + "\n").encode())
        line = first
        while line:
            try:
                msg = json.loads(line)
            except ValueError:
                msg = None
            if isinstance(msg, dict):
                op, rid = msg.get("op"), msg.get("rid")
                try:
                    if op == "list":
                        await reply(rid, ok=True, terms=self.list())
                    elif op == "subscribe":
                        self.subscribers.add(writer)
                        await reply(rid, ok=True, terms=self.list())
                    elif op == "create":
                        await reply(rid, ok=True, term=self.create(msg))
                    elif op == "close":
                        self.close(str(msg.get("id")))
                        await reply(rid, ok=True)
                    elif op == "rename":
                        t = self.terms[str(msg.get("id"))]
                        t.label = str(msg.get("label") or t.label)[:60]
                        self.changed(save=True)
                        await reply(rid, ok=True)
                    elif op == "set_size":
                        t = self.terms[str(msg.get("id"))]
                        fc, fr = msg.get("fixed_cols"), msg.get("fixed_rows")
                        t.set_fixed_size(fc, fr)
                        t.apply_size()   # unpinned: back to the smallest viewer's size
                        self.changed(save=True)
                        await reply(rid, ok=True, term=t.info())
                    elif op == "set_session":   # switch a Claude terminal to another session id; restart it to resume there
                        t = self.terms[str(msg.get("id"))]
                        sid = str(msg.get("session_id") or "")
                        if not re.fullmatch(r"[0-9a-fA-F-]{8,64}", sid):
                            raise ValueError("bad session id")
                        if t.kind != "claude":
                            raise ValueError("not a Claude Code terminal")
                        t.set_session(sid)
                        self.changed(save=True)
                        await reply(rid, ok=True, term=t.info())
                    elif op == "set_mode":   # change a Claude terminal's permission mode; the caller restarts it to apply
                        t = self.terms[str(msg.get("id"))]
                        m = msg.get("permission_mode") or None
                        if m not in (None, "default", "acceptEdits", "plan", "bypassPermissions"):
                            raise ValueError("bad permission mode")
                        if t.kind != "claude":
                            raise ValueError("not a Claude Code terminal")
                        t.permission_mode = None if m in (None, "default") else m
                        self.changed(save=True)
                        await reply(rid, ok=True, term=t.info())
                    elif op == "restart":
                        t = self.terms[str(msg.get("id"))]
                        if t.exited is None:
                            t.stop(signal.SIGHUP)
                            for _ in range(30):
                                await asyncio.sleep(0.1)
                                if t.exited is not None:
                                    break
                        t.restart()
                        await reply(rid, ok=True)
                    elif op == "send":            # typed text from the prompt box, quick keys or a broadcast
                        t = self.terms[str(msg.get("id"))]
                        text = str(msg.get("text") or "")
                        if len(text) > 1 and text.endswith("\r"):   # an agent reads a burst ending in Enter as a paste: send Enter on its own
                            t.write(text[:-1].encode())
                            await asyncio.sleep(0.06)
                            text = "\r"
                        t.write(text.encode())
                        t.seen()
                        await reply(rid, ok=True)
                    elif op == "seen":
                        self.terms[str(msg.get("id"))].seen()
                        await reply(rid, ok=True)
                    elif op == "stats":
                        t = self.terms.get(str(msg.get("id")))
                        if t and isinstance(msg.get("data"), dict):
                            t.set_stats(msg["data"])
                        await reply(rid, ok=True)
                    elif op == "hook":
                        t = self.terms.get(str(msg.get("id")))
                        if t:
                            t.hook(msg.get("event"), msg.get("data") if isinstance(msg.get("data"), dict) else {})
                        await reply(rid, ok=True)
                    else:
                        await reply(rid, error=f"unknown op {op}")
                except (KeyError, ValueError, TypeError, OSError) as exc:
                    await reply(rid, error=str(exc).strip("'") or "failed")
            line = await reader.readline()

    async def handle_attach(self, msg, reader, writer):
        t = self.terms.get(str(msg.get("id")))
        if not t:
            writer.write(b'{"error": "no such terminal"}\n')
            return
        writer.write((json.dumps({"ok": True, "term": t.info(), "modes": {str(k): v for k, v in t.modes.items()}}) + "\n").encode())
        writer.write(t.mode_prefix())
        buf = bytes(t.buf)
        tail = msg.get("tail")
        if isinstance(tail, int) and 0 < tail < len(buf):   # only the recent output (a client that parses it itself)
            cut = len(buf) - tail
            nl = buf.find(b"\n", cut)
            buf = buf[nl + 1:] if nl >= 0 else buf[cut:]
        writer.write(buf)
        t.clients.add(writer)
        clamp = lambda c, r: (max(20, min(int(c), 500)), max(5, min(int(r), 200)))
        want = (msg.get("cols"), msg.get("rows"))
        scalable = bool(msg.get("scalable"))   # a browser: it can shrink its font to show a bigger grid; a console cannot
        peer = "?"
        try:   # who is looking: the pid and command behind this connection (SO_PEERCRED), for the log
            import socket as _socket
            ppid = struct.unpack("iII", writer.get_extra_info("socket").getsockopt(_socket.SOL_SOCKET, _socket.SO_PEERCRED, 12))[0]
            with open(f"/proc/{ppid}/cmdline", "rb") as fh:
                peer = f"pid {ppid} " + fh.read().replace(b"\0", b" ").decode("utf-8", "replace").strip()[:80]
        except Exception:
            pass
        log.info("%s: viewer attached (%s) size %s%s, now %d viewer(s)", t.label, peer, want, " scalable" if scalable else "", len(t.clients))
        if all(isinstance(v, int) for v in want):
            t.viewer_sizes[writer] = clamp(*want) + (scalable,)
            # the console says "active": it is the app in front of you, so opening a workspace there takes the size at once.
            # A browser does not: a tab left open must never resize the console. Otherwise the first viewer sets the size.
            if msg.get("active") or t.owner not in t.viewer_sizes:
                t.owner, t.owner_at = writer, 0.0
            if msg.get("redraw") and (t.cols, t.rows) == t.viewer_sizes[writer][:2]:
                t.redraw()
            else:
                t.apply_size()
        t.seen()
        self.changed()
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                try:
                    m = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(m, dict):
                    continue
                if m.get("op") == "in":   # typing here makes this viewer the one the size follows
                    t.take_size(writer)
                    t.write(str(m.get("d") or "").encode())
                    if t.status == "done":
                        t.seen()
                elif m.get("op") == "resize":   # a viewer's own size changed: the terminal follows only if that viewer is the one in use
                    t.viewer_sizes[writer] = clamp(m.get("cols") or t.cols, m.get("rows") or t.rows) + (scalable,)
                    if writer is t.owner:
                        t.apply_size()
                elif m.get("op") == "redraw":
                    t.redraw()
        finally:
            t.clients.discard(writer)
            t.viewer_sizes.pop(writer, None)
            t.apply_size()   # if the owner left, the most recent remaining viewer takes over
            log.info("%s: viewer detached (%s), now %d viewer(s)", t.label, peer, len(t.clients))
            self.changed()

    async def on_client(self, reader, writer):
        try:
            first = await reader.readline()
            try:
                msg = json.loads(first) if first else None
            except ValueError:
                msg = None
            if isinstance(msg, dict) and msg.get("op") == "attach":
                await self.handle_attach(msg, reader, writer)
            elif first:
                await self.handle_control(first, reader, writer)
        except (ConnectionError, asyncio.IncompleteReadError, ValueError):
            pass
        finally:
            self.subscribers.discard(writer)
            try:
                writer.close()
            except Exception:
                pass

    async def watchdog(self):
        """An agent shown as working whose screen has not moved for a while was interrupted (no hook fires then)."""
        while True:
            await asyncio.sleep(2)
            now = time.time()
            for t in list(self.terms.values()):
                if t.status == "working" and now - max(t.last_output, t.status_since) > SILENT_IDLE:
                    t.set_status("idle")

    # ── reload without closing the terminals ──
    def reexec(self):
        """SIGUSR1: run the current ptyd.py in this same process. The terminals' file descriptors stay open across
        exec and the programs in them are still our children, so nothing in them notices; viewers reattach."""
        log.info("reloading: handing %d terminal(s) to the new code", len(self.terms))
        state = []
        for t in self.terms.values():
            rec = {**t.record(), "modes": {str(k): v for k, v in t.modes.items()}, "cols": t.cols, "rows": t.rows, "status": t.status, "status_since": t.status_since,
                   "question": t.question, "exited": t.exited, "fd": None, "pid": None}
            if t.fd is not None and t.proc and t.exited is None:
                os.set_inheritable(t.fd, True)
                rec["fd"], rec["pid"] = t.fd, t.proc.pid
            buf = self.cfg / f"reload-{t.id}.buf"
            buf.write_bytes(bytes(t.buf))
            os.chmod(buf, 0o600)
            state.append(rec)
        path = self.cfg / "reload.json"
        path.write_text(json.dumps(state))
        os.chmod(path, 0o600)
        self.save()
        if self.server:
            self.server.close()
        try:
            self.sock_path.unlink()
        except OSError:
            pass
        os.environ["AGENT_MASTER_RELOAD"] = str(path)
        os.execv(sys.executable, [sys.executable, os.path.abspath(sys.argv[0])] + sys.argv[1:])

    def adopt(self, path):
        recs = json.loads(Path(path).read_text())
        loop = asyncio.get_running_loop()
        for rec in recs:
            t = Term(self, rec)
            t.cols, t.rows = rec.get("cols") or t.cols, rec.get("rows") or t.rows
            t.status, t.status_since, t.question = rec.get("status") or t.status, rec.get("status_since") or t.status_since, rec.get("question")
            buf = self.cfg / f"reload-{t.id}.buf"
            try:
                t.buf = bytearray(buf.read_bytes())
                buf.unlink()
            except OSError:
                pass
            if not t.modes:   # handed over by an older version: learn the modes from the output kept so far
                for nums, flag in MODE_SEQ.findall(bytes(t.buf)):
                    for n in nums.split(b";"):
                        if n.isdigit() and int(n) in TRACKED_MODES:
                            t.modes[int(n)] = flag == b"h"
            if rec.get("fd") is not None and rec.get("pid"):
                t.fd, t.proc, t.exited = rec["fd"], Adopted(rec["pid"]), None
                t.started = t.last_output = time.time()
                if not t.buf_since and t.proc:   # adopted from a daemon that did not track it: an untrimmed replay reaches back to the process start
                    try:
                        t.buf_since = os.stat(f"/proc/{t.proc.pid}").st_ctime
                    except OSError:
                        t.buf_since = time.time()
                os.set_blocking(t.fd, False)
                loop.add_reader(t.fd, t._on_read)
            else:
                t.exited = rec.get("exited") if rec.get("exited") is not None else -1
            self.terms[t.id] = t
        Path(path).unlink()
        log.info("reloaded with %d terminal(s) kept running", len(self.terms))

    async def run(self):
        self.write_hooks()
        reload_from = os.environ.pop("AGENT_MASTER_RELOAD", None)
        if reload_from and os.path.exists(reload_from):
            self.adopt(reload_from)
        else:
            self.load()
            for t in list(self.terms.values()):
                try:
                    t.start()
                except OSError as exc:
                    log.warning("could not start %s: %s", t.label, exc)
        if self.sock_path.exists():
            self.sock_path.unlink()
        old = os.umask(0o177)
        server = await asyncio.start_unix_server(self.on_client, path=str(self.sock_path), limit=4 * 1024 * 1024)
        self.server = server
        os.umask(old)
        log.info("agent-masterd listening on %s with %d terminal(s)", self.sock_path, len(self.terms))
        asyncio.create_task(self.watchdog())
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for s in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(s, stop.set)
        loop.add_signal_handler(signal.SIGUSR1, self.reexec)
        async with server:
            await stop.wait()
        self.save()
        for t in self.terms.values():   # sessions are resumed by id on the next start
            t.stop(signal.SIGHUP)
        await asyncio.sleep(0.5)


def main():
    ap = argparse.ArgumentParser(description="agent-masterd: terminal server for Agent-Master")
    ap.add_argument("--config-dir", default=None, help="default ~/.config/agent-master")
    ap.add_argument("--socket", default=os.environ.get("AGENT_MASTER_PTYD_SOCK"), help="unix socket path (default <config-dir>/ptyd.sock)")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    cfg = Path(args.config_dir).expanduser() if args.config_dir else config_dir()
    asyncio.run(Daemon(cfg, args.socket).run())


if __name__ == "__main__":
    main()
