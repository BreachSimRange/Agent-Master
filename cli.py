#!/usr/bin/env python3
"""agent-master: the Agent-Master console for any shell on this machine (locally or over SSH).

  agent-master                        open the console: workspaces on the left, the live terminal on the right
  agent-master attach NAME            open the console on that workspace
  agent-master attach NAME --plain    attach this terminal directly, without the console (Ctrl+] detaches)
  agent-master list                   list the workspaces
  agent-master new [DIR] [--claude | --shell | --cmd "COMMAND"] [--label L] [--model M] [--no-attach]
  agent-master send NAME "TEXT"       type TEXT into it and press Enter
  agent-master close NAME [-y]        end the process in it

Console keys use the prefix Ctrl+B: Ctrl+B then w (pick a workspace), n / p (next, previous),
1..9 (jump), c (new shell here), N (new workspace), W (rename), x (close), b (sidebar), [ (scroll back),
? (all keys), q (detach). Everything else goes to the terminal. Agents keep running when you detach.
"""

import argparse
import asyncio
import codecs
import fcntl
import json
import os
import re
import shlex
import shutil
import signal
import struct
import sys
import termios
import textwrap
import time
import tty
from pathlib import Path

HERE = Path(os.path.realpath(__file__)).parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "vendor"))
from terms import default_socket  # noqa: E402

PREFIX = "\x02"          # Ctrl+B
DETACH = b"\x1d"         # Ctrl+] (plain attach only)
SIDEBAR = 26
TAIL = 200_000           # bytes of recent output replayed into the console's own screen
HISTORY = 5000           # scrollback lines kept by the console
RESTORE = b"\x1b[?1049l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?1004l\x1b[0m"
TOKEN = re.compile(r"\x1b\[<[\d;]*[Mm]|\x1b\[[\d;?]*[~A-Za-z]|\x1bO[A-Za-z]|\x1b[\x00-\x7f]?|.", re.S)
MOUSE = re.compile(r"\x1b\[<(\d+);(\d+);(\d+)([Mm])")

# palette (256 colours, so it looks the same in any modern terminal)
DIM, TXT, BRIGHT = "\x1b[38;5;243m", "\x1b[38;5;250m", "\x1b[38;5;255m"
SEL_BG, SIDE_BG, TAB_ON, TAB_OFF = "\x1b[48;5;237m", "\x1b[48;5;234m", "\x1b[48;5;111m\x1b[38;5;16m", "\x1b[38;5;245m"
STATUS_FG = {"working": "\x1b[38;5;214m", "blocked": "\x1b[38;5;203m", "done": "\x1b[38;5;114m", "idle": "\x1b[38;5;245m", "none": "\x1b[38;5;240m"}
R = "\x1b[0m"


def die(msg, code=1):
    print(f"agent-master: {msg}", file=sys.stderr)
    sys.exit(code)


# ───────────────────────── daemon client ─────────────────────────
class Client:
    def __init__(self, sock):
        self.sock = sock

    async def request(self, op, soft=False, **kw):
        try:
            reader, writer = await asyncio.open_unix_connection(self.sock)
        except OSError:
            if soft:
                return {"error": "the terminal server is not running"}
            die(f"the terminal server is not running (no socket at {self.sock}).\n  start it with: systemctl --user start agent-masterd")
        writer.write((json.dumps({"op": op, **kw}) + "\n").encode())
        await writer.drain()
        line = await reader.readline()
        writer.close()
        res = json.loads(line or b"{}")
        if res.get("error") and not soft:
            die(res["error"])
        return res

    async def terms(self):
        return (await self.request("list"))["terms"]


def resolve(terms, name):
    """A workspace by id, label, list number or a unique prefix; None plus a message when there is no single match."""
    key = name[2:] if name.startswith("t:") else name
    low = key.lower()
    for t in terms:
        if t["id"] == key or (t.get("label") or "").lower() == low or str(t.get("number")) == key:
            return t, None
    hits = [t for t in terms if t["id"].startswith(key) or (t.get("label") or "").lower().startswith(low)]
    if len(hits) == 1:
        return hits[0], None
    if hits:
        return None, f"'{name}' matches several workspaces: " + ", ".join(t["label"] for t in hits)
    return None, f"no workspace named '{name}' (agent-master list)"


def tty_size():
    try:
        rows, cols = struct.unpack("HH", fcntl.ioctl(sys.stdout.fileno(), termios.TIOCGWINSZ, b"\0" * 4))
        if cols and rows:
            return cols, rows
    except OSError:
        pass
    s = shutil.get_terminal_size((100, 30))
    return s.columns, s.lines


def ago(ts):
    s = max(0, time.time() - (ts or time.time()))
    return f"{int(s)}s" if s < 60 else f"{int(s // 60)}m" if s < 3600 else f"{int(s // 3600)}h" if s < 172800 else f"{int(s // 86400)}d"


def claude_bits(t):
    """Claude Code's own numbers for a terminal: model, context used, cost."""
    st = t.get("stats") or {}
    if not st:
        return ""
    model = (st.get("model") or {}).get("display_name")
    pct = (st.get("context_window") or {}).get("used_percentage")
    cost = (st.get("cost") or {}).get("total_cost_usd")
    return " · ".join(x for x in (model, f"context {pct}%" if pct is not None else None, f"${cost:.2f}" if cost else None) if x)


def limits_values(terms):
    vals = {"five_hour": None, "seven_day": None}
    for t in terms:
        rl = (t.get("stats") or {}).get("rate_limits") or {}
        for k in vals:
            v = (rl.get(k) or {}).get("used_percentage")
            if v is not None and (vals[k] is None or v > vals[k]):
                vals[k] = v
    return list(vals.values())


def limits_text(terms):
    h5, d7 = limits_values(terms)
    if h5 is None and d7 is None:
        return ""
    return f"limits 5h {h5 if h5 is not None else '?'}% 7d {d7 if d7 is not None else '?'}%"


def status_of(t):
    return (t.get("status") or "idle") if t.get("agent") else "none"


def fit(text, width):
    text = str(text)
    return text if len(text) <= width else text[:max(0, width - 1)] + "…"


# ───────────────────────── feeding pyte ─────────────────────────
# pyte ignores the private marker in sequences like ESC[>4m (keyboard modes Claude Code sets) and would read them as
# SGR (underline on). Those, and other queries meant for the outer terminal, are removed before pyte sees them.
PRIVATE_CSI = re.compile(r"\x1b\[[<>=][\d;:]*[A-Za-z]|\x1b\[\?[\d;]*u")
MODE_RE = re.compile(r"\x1b\[\?([\d;]+)([hl])")
APP_MOUSE = {1000, 1002, 1003}
PARTIAL_ESC = re.compile(r"\x1b(\[[<>=?]?[\d;:]*)?$")


class Feeder:
    """UTF-8 decoding plus filtering in front of a pyte stream, safe across chunk boundaries."""

    def __init__(self, stream, on_modes=None):
        self.stream = stream
        self.on_modes = on_modes
        self.decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self.carry = ""

    def feed(self, data: bytes):
        text = self.carry + self.decoder.decode(data)
        m = PARTIAL_ESC.search(text)
        if m:
            self.carry, text = text[m.start():], text[:m.start()]
        else:
            self.carry = ""
        if self.on_modes and "\x1b[?" in text:
            for nums, flag in MODE_RE.findall(text):
                self.on_modes([int(n) for n in nums.split(";") if n.isdigit()], flag == "h")
        self.stream.feed(PRIVATE_CSI.sub("", text))


def screen_class(pyte):
    class Screen(pyte.HistoryScreen):
        """pyte has no "dim" attribute; it is kept in the unused blink field and drawn as SGR 2."""

        def select_graphic_rendition(self, *attrs, **kw):
            out, i, attrs = [], 0, list(attrs)
            while i < len(attrs):
                a = attrs[i]
                if a in (38, 48):     # colour parameters pass through untouched: 38;5;n and 38;2;r;g;b
                    n = 3 if i + 1 < len(attrs) and attrs[i + 1] == 5 else 5
                    out += attrs[i:i + n]
                    i += n
                    continue
                if a == 2:
                    out.append(5)
                elif a == 22:         # normal intensity ends both bold and dim
                    out += [22, 25]
                else:
                    out.append(a)
                i += 1
            super().select_graphic_rendition(*out, **kw)
    return Screen


# ───────────────────────── pyte cells to ANSI ─────────────────────────
NAMED = {"black": 0, "red": 1, "green": 2, "brown": 3, "yellow": 3, "blue": 4, "magenta": 5, "cyan": 6, "white": 7}


def colour(value, base):
    if not value or value == "default":
        return str(base + 9)
    if value.startswith("bright") and value[6:] in NAMED:
        return str(base + 60 + NAMED[value[6:]])
    if value in NAMED:
        return str(base + NAMED[value])
    if len(value) == 6:
        try:
            r, g, b = int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)
            return f"{base + 8};2;{r};{g};{b}"
        except ValueError:
            pass
    return str(base + 9)


def sgr(ch):
    parts = ["0", colour(ch.fg, 30), colour(ch.bg, 40)]
    if ch.bold:
        parts.append("1")
    if ch.blink:            # dim, see screen_class
        parts.append("2")
    if ch.italics:
        parts.append("3")
    if ch.underscore:
        parts.append("4")
    if ch.reverse:
        parts.append("7")
    if ch.strikethrough:
        parts.append("9")
    return "\x1b[" + ";".join(parts) + "m"


def line_ansi(line, width, default, x0=0):
    """`width` cells of a pyte line starting at column x0 (a pinned terminal wider than the pane is panned sideways)."""
    out, last = [], None
    x = x0
    width += x0
    while x < width:
        ch = line[x] if x in line else default
        if ch.data == "":   # right half of a wide character
            x += 1
            continue
        style = sgr(ch)
        if style != last:
            out.append(style)
            last = style
        out.append(ch.data or " ")
        x += 1
    return "".join(out) + R


# ───────────────────────── the console ─────────────────────────
class Console:
    def __init__(self, client, select=None):
        import pyte
        self.pyte = pyte
        self.client = client
        self.terms = []
        self.sel = None                 # selected terminal id
        self.want = select
        self.sidebar = True
        self.mode = "normal"            # normal | prefix | pick | scroll | input | confirm | help
        self.pick = 0
        self.scroll = 0
        self.pan = None                 # column offset into a pinned terminal wider than the pane; None = the cursor's side
        self.prompt = None              # (label, text, on_done) while typing a name or folder
        self.confirm = None             # (question, on_yes)
        self.note = ""                  # one-line message on the tab row
        self.note_until = 0
        self.screen = None
        self.stream = None
        self.att = None                 # (reader, writer, task)
        self.render_due = None
        self.full = True
        self.out = sys.stdout.buffer
        self.decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self.pending_input = ""
        self.quit = asyncio.Event()
        self.W, self.H = tty_size()

    # layout
    @property
    def sb(self):
        return SIDEBAR if self.sidebar and self.W >= 60 else 0

    @property
    def pane(self):
        return max(10, self.W - self.sb), max(3, self.H - 1)

    def current(self):
        return next((t for t in self.terms if t["id"] == self.sel), None)

    def flash(self, text, secs=4):
        self.note, self.note_until = text, time.time() + secs
        self.schedule(full=True)

    # ── terminal list ──
    async def watch_terms(self):
        while not self.quit.is_set():
            try:
                reader, writer = await asyncio.open_unix_connection(self.client.sock, limit=8 * 1024 * 1024)
                writer.write(b'{"op": "subscribe"}\n')
                await writer.drain()
                self.set_terms(json.loads(await reader.readline()).get("terms") or [])
                while True:
                    line = await reader.readline()
                    if not line:
                        break
                    msg = json.loads(line)
                    if msg.get("ev") == "terms":
                        self.set_terms(msg.get("terms") or [])
            except (OSError, ValueError):
                pass
            self.flash("terminal server unreachable, retrying", 3)
            await asyncio.sleep(2)

    def sync_screen_size(self):
        """Keep the console's emulated screen at the terminal's pinned size when the pin appears or changes while
        attached (the first viewer pins it; the card can re-pin it); otherwise the program paints for a size we
        are not emulating and the pane turns to garbage."""
        t = self.current()
        if not (t and self.screen and t.get("cols") and t.get("rows")):
            return False
        cols, rows = int(t["cols"]), int(t["rows"])
        if (self.screen.columns, self.screen.lines) == (cols, rows):
            return False
        self.screen.resize(rows, cols)
        self.pan = None
        self.send({"op": "redraw"})   # the program repaints its whole screen at the pinned size
        self.schedule(full=True)
        return True

    def set_terms(self, terms):
        self.terms = terms
        self.sync_screen_size()
        chosen = False
        if self.want:
            t, err = resolve(terms, self.want)
            self.want = None
            if t:
                self.sel = t["id"]   # claim it now: select() runs later, and the fallback below must not race it
                asyncio.ensure_future(self.select(t["id"]))
                chosen = True
            else:
                self.flash(err)
        if self.sel and not self.current():   # closed elsewhere
            self.sel = None
            self.detach_pane()
        if not chosen and not self.sel and terms:
            self.sel = terms[0]["id"]
            asyncio.ensure_future(self.select(terms[0]["id"]))
        self.schedule(full=True)

    # ── attachment to one terminal ──
    def detach_pane(self):
        if self.att:
            _, writer, task = self.att
            task.cancel()
            try:
                writer.close()
            except Exception:
                pass
            self.att = None

    def new_screen(self):
        pw, ph = self.pane
        t = self.current()
        if t and t.get("cols") and t.get("rows"):   # emulate the pty's real size; the pane clips or pads around it
            pw, ph = int(t["cols"]), int(t["rows"])
        self.screen = screen_class(self.pyte)(pw, ph, history=HISTORY, ratio=0.5)
        self.app_mouse, self.app_sgr = set(), False   # mouse modes the program in the pane asked for
        self.stream = Feeder(self.pyte.Stream(self.screen), self.app_modes)

    def debug(self, what):
        """AGENT_MASTER_CONSOLE_LOG=/path: append one line per attach, detach and reconnect (the screen is the TUI, so a file)."""
        path = os.environ.get("AGENT_MASTER_CONSOLE_LOG")
        if path:
            try:
                with open(path, "a") as fh:
                    fh.write(f"{time.strftime('%H:%M:%S')} {what}\n")
            except OSError:
                pass

    async def select(self, tid):
        import traceback
        self.debug(f"select {tid} attached={bool(self.att)} sel={self.sel} from {' <- '.join(f.name for f in traceback.extract_stack()[-4:-1])}")
        if tid == self.sel and self.att:
            return
        self.detach_pane()
        self.sel, self.scroll, self.pan = tid, 0, None
        if self.mode == "scroll":
            self.mode = "normal"
        self.new_screen()
        self.full = True
        pw, ph = self.pane   # our own size: the server gives the pty the smallest viewer's size
        try:
            reader, writer = await asyncio.open_unix_connection(self.client.sock, limit=8 * 1024 * 1024)
            writer.write((json.dumps({"op": "attach", "id": tid, "cols": pw, "rows": ph, "tail": TAIL, "active": True}) + "\n").encode())   # the console is the app in front of you: opening a workspace here takes its size
            await writer.drain()
            head = json.loads(await reader.readline() or b"{}")
        except (OSError, ValueError):
            self.flash("could not attach: the terminal server is not running")
            return
        if not head.get("ok"):
            self.flash(head.get("error") or "attach failed")
            return
        if self.sel != tid:   # another selection happened meanwhile
            writer.close()
            return
        # the reply carries the terminal as it is now, our attach included: emulate exactly that size
        info = head.get("term") or {}
        if info.get("cols") and info.get("rows"):
            sz = (int(info["cols"]), int(info["rows"]))
            if (self.screen.columns, self.screen.lines) != sz:
                self.screen.resize(sz[1], sz[0])
                self.pan = None
        for n, on in (head.get("modes") or {}).items():   # modes set before the replay starts (mouse reporting and so on)
            if str(n).isdigit():
                self.app_modes([int(n)], bool(on))
        # the replay arrives as one burst: keep only its recent part (older servers send all of it), then make the
        # program repaint at our size so the screen is exact (two quick resizes, supported by every server version)
        burst = b""
        t_end = time.time() + 2
        while time.time() < t_end:
            try:
                chunk = await asyncio.wait_for(reader.read(262144), 0.06)
            except asyncio.TimeoutError:
                break
            if not chunk:
                break
            burst += chunk
        if len(burst) > TAIL:
            nl = burst.find(b"\n", len(burst) - TAIL)
            burst = burst[nl + 1:] if nl >= 0 else burst[-TAIL:]
        self.stream.feed(burst)
        # the replay holds frames older than the current screen: one full repaint, or stale cells linger wherever the
        # program has not drawn since
        writer.write((json.dumps({"op": "redraw"}) + "\n").encode())

        async def pump():
            try:
                while True:
                    data = await reader.read(262144)
                    if not data:
                        break
                    self.stream.feed(data)
                    self.schedule()
            except asyncio.CancelledError:
                return
            except Exception as exc:
                self.debug(f"pump {tid} ended with {type(exc).__name__}: {exc}")
            else:
                self.debug(f"pump {tid} ended: the server closed the attachment")
            if self.sel == tid and not self.quit.is_set():   # the terminal went away or the server restarted
                self.att = None
                await asyncio.sleep(1)
                if self.sel == tid and self.current():
                    self.sel = None
                    await self.select(tid)

        self.att = (reader, writer, asyncio.create_task(pump()))
        self.schedule(full=True)

    def send(self, msg):
        if self.att:
            try:
                self.att[1].write((json.dumps(msg) + "\n").encode())
            except Exception:
                pass

    # ── rendering ──
    def schedule(self, full=False):
        self.full = self.full or full
        if self.render_due is None:
            self.render_due = asyncio.get_running_loop().call_later(0.008, self.render)

    def render(self):
        self.render_due = None
        W, H, sb = self.W, self.H, self.sb
        pw, ph = self.pane
        o = ["\x1b[?25l"]
        if self.full:
            o.append("\x1b[0m\x1b[2J")
        if sb:
            o.append(self.draw_sidebar())
        o.append(self.draw_tabs())
        if self.screen is None:
            o.append(self.draw_empty())
        elif self.mode == "help":
            o.append(self.draw_help())
        else:
            o.append(self.draw_pane())
        o.append(self.draw_cursor())
        self.full = False
        try:
            self.out.write("".join(o).encode("utf-8", "replace"))
            self.out.flush()
        except (BlockingIOError, OSError):
            pass

    def row(self, y, x, text):
        return f"\x1b[{y + 1};{x + 1}H{text}"

    def draw_sidebar(self):
        sb, H = self.sb, self.H
        w = sb - 1
        lines = [None] * H

        def put(i, left, right="", bg=SIDE_BG, lstyle=DIM, rstyle=DIM):
            if 0 <= i < H:
                space = max(0, w - len(left) - len(right) - 1)
                lines[i] = f"{bg}{lstyle} {fit(left, w - 1)}{' ' * space}{rstyle}{right}{bg} "
        put(0, "spaces")
        top = 2
        mid = max(top + len(self.terms) + 1, min(H // 2, H - 6))
        for i, t in enumerate(self.terms):
            y = top + i
            if y >= mid - 1:
                put(y, f"+{len(self.terms) - i} more")
                break
            st = status_of(t)
            dot = "·" if st == "none" else "●"
            chosen = t["id"] == self.sel
            picked = self.mode == "pick" and i == self.pick
            bg = SEL_BG if (picked or (chosen and self.mode != "pick")) else SIDE_BG
            num = str(t.get("number") or "")   # the workspace number: the same one the tab row, `list` and `attach N` use
            label = fit(t.get("label") or t["id"], w - 5 - len(num))
            left = f"{STATUS_FG[st]}{dot}{R}{bg} {BRIGHT if chosen else TXT}{label}"
            space = max(0, w - 3 - len(label) - len(num))
            lines[y] = f"{bg} {left}{' ' * space}{DIM}{num}{bg} "
        put(mid, "new", "menu ?")
        agents = [t for t in self.terms if t.get("agent")]
        put(mid + 2, "agents", "status")
        y = mid + 3
        for t in agents:
            if y >= H - 1:
                break
            st = status_of(t)
            right = f"{st} {ago(t.get('status_since'))}"
            label = fit(t.get("label") or t["id"], w - len(right) - 3)
            space = max(0, w - 2 - len(label) - len(right))
            bg = SEL_BG if t["id"] == self.sel and self.mode != "pick" else SIDE_BG
            lines[y] = f"{bg} {TXT} {label}{' ' * space}{STATUS_FG[st]}{right}{bg} "
            y += 1
        love_text = "With love to the community from breachsimrange.io"
        love_lines = textwrap.wrap(love_text, max(4, w - 3)) if w > 6 else [love_text]
        love_lines = love_lines[:3] or [love_text]
        n = len(love_lines)
        lim = limits_text(self.terms)
        if lim and H - 1 - n > y:
            hot = any(v is not None and v >= 80 for v in limits_values(self.terms))
            put(H - 1 - n, lim, rstyle=DIM, lstyle="\x1b[38;5;222m" if hot else DIM)
        for i, ln in enumerate(love_lines):
            is_last = i == n - 1
            marker = f"{DIM}«" if is_last else ""
            pad = max(0, w - 2 - len(ln) - (1 if is_last else 0))
            lines[H - n + i] = f"{SIDE_BG} \x1b[3m{DIM}{ln}{R}{SIDE_BG}{' ' * pad}{marker}{SIDE_BG} "
        out = []
        for i in range(H):
            text = lines[i] if lines[i] is not None else f"{SIDE_BG}{' ' * sb}"
            out.append(self.row(i, 0, text + R))
        return "".join(out)

    def draw_tabs(self):
        x0, pw = self.sb, self.pane[0]
        t = self.current()
        if self.note and time.time() > self.note_until:
            self.note = ""
        if self.mode == "input" and self.prompt:
            label, text, _ = self.prompt
            body = f"\x1b[48;5;236m{BRIGHT} {label}: {TXT}{text}\x1b[7m \x1b[27m{DIM}   enter to confirm · esc to cancel"
            return self.row(0, x0, fit_ansi(body, pw) + R)
        if self.mode == "confirm" and self.confirm:
            body = f"\x1b[48;5;52m{BRIGHT} {self.confirm[0]} {DIM}[y/N]"
            return self.row(0, x0, fit_ansi(body, pw) + R)
        tab = f" {t['number'] if t else ''} {fit(t['label'], 30) if t else 'no workspace'} "
        mode = {"prefix": "ctrl+b …", "pick": "pick a workspace: ↑↓ enter esc", "scroll": f"scroll {self.scroll} lines up · ↑↓ pgup pgdn · q to leave", "help": "keys"}.get(self.mode, "")
        clip = ""
        if self.screen and self.screen.columns > pw:   # a pinned grid wider than this pane: say which slice is shown and how to move it
            extra = self.screen.columns - pw
            px = self.pan if self.pan is not None else (extra if self.screen.cursor.x >= pw else 0)
            px = max(0, min(px, extra))
            clip = f"cols {px + 1}-{px + pw} of {self.screen.columns} · ctrl+b h l" if pw >= 90 else f"{px + 1}-{px + pw}/{self.screen.columns} ^b h l"
        right = self.note or mode or clip or "ctrl+b ? keys"
        info = ""
        if t:
            folder = (t.get("cwd") or "").replace(str(Path.home()), "~", 1)
            st = status_of(t)
            word = st if st != "none" else (t.get("kind") or "shell")
            cc = claude_bits(t)
            if cc:
                word += " · " + cc
            upd = f"update {t.get('installed_version')} ready: ctrl+b R" if t.get("update") else ""
            room = pw - len(tab) - 5 - len(word) - 3 - len(right) - 2 - (len(upd) + 3 if upd else 0)
            if room < 0 and cc:   # a narrow pane: the Claude Code numbers go before the message on the right does
                word = st if st != "none" else (t.get("kind") or "shell")
                room = pw - len(tab) - 5 - len(word) - 3 - len(right) - 2 - (len(upd) + 3 if upd else 0)
            if len(folder) > room:   # keep the end of the path, it is the part that tells folders apart
                folder = "…" + folder[-max(1, room - 1):] if room > 4 else ""
            info = f"{STATUS_FG[st]}{word}{DIM}{' · ' + folder if folder else ''}" + (f"{DIM} · \x1b[38;5;215m{upd}{DIM}" if upd else "")
        body = f"{TAB_ON}{tab}{R}{TAB_OFF}  +  {DIM}{info}"
        vis = len(tab) + 5 + len(strip(info))
        style = "\x1b[38;5;215m" if self.note else DIM
        brand = "Agent-Master, hacked together by Abx."
        pad_left = pw - vis - len(brand) - len(right) - 5
        if pad_left >= 2:
            tail = " " * pad_left + "\x1b[3m" + DIM + brand + R + "   " + style + right + " "
        else:
            tail = " " * max(1, pw - vis - len(right) - 1) + style + right + " "
        return self.row(0, x0, fit_ansi(body + tail, pw) + R)

    def draw_empty(self):
        x0, (pw, ph) = self.sb, self.pane
        msg = ["No workspaces yet.", "", "ctrl+b N   new workspace (Claude Code in a folder)", "ctrl+b c   new shell", "ctrl+b q   detach"]
        out = [self.row(1 + y, x0, "\x1b[K") for y in range(ph)]
        for i, m in enumerate(msg):
            out.append(self.row(2 + i, x0 + 2, DIM + m + R))
        return "".join(out)

    def draw_pane(self):
        x0, (pw, ph) = self.sb, self.pane
        sc = self.screen
        default = sc.default_char
        out = []
        if self.scroll:
            hist = list(sc.history.top)
            lines = hist + [sc.buffer[y] for y in range(sc.lines)]
            start = max(0, len(lines) - ph - self.scroll)
            for y in range(ph):
                i = start + y
                ln = lines[i] if i < len(lines) else {}
                out.append(self.row(1 + y, x0, line_ansi(ln, pw, default)))
            return "".join(out)
        rows = range(ph) if self.full else sorted(y for y in sc.dirty if y < ph)
        # a pinned terminal wider than the pane: show `pw` columns from the pan offset (ctrl+b h / l), the cursor's side by default
        extra = max(0, sc.columns - pw)
        if self.pan is None:
            self.pan = extra if extra and sc.cursor.x >= pw else 0
        px = max(0, min(self.pan, extra))
        for y in rows:
            out.append(self.row(1 + y, x0, line_ansi(sc.buffer[y], min(pw, sc.columns), default, px) + ("\x1b[K" if sc.columns < pw else "")))
        sc.dirty.clear()
        return "".join(out)

    def draw_help(self):
        x0, (pw, ph) = self.sb, self.pane
        keys = [("w  g", "pick a workspace (arrows, enter)"), ("n  p", "next, previous workspace"), ("1..9", "jump to the workspace with that number"),
                ("c", "new shell in this folder"), ("N", "new workspace: Claude Code in a folder"), ("W", "rename this workspace"),
                ("x  D", "close this workspace"), ("R", "restart the process"), ("b", "show or hide the sidebar"), ("[", "scroll back (also the mouse wheel)"),
                ("h  l", "pan a pinned terminal wider than this pane"),
                ("ctrl+b", "send ctrl+b itself"), ("q  d", "detach (everything keeps running)"), ("?", "this help")]
        out = [self.row(1 + y, x0, "\x1b[K") for y in range(ph)]
        out.append(self.row(2, x0 + 3, BRIGHT + "Agent-Master console · prefix ctrl+b" + R))
        for i, (k, d) in enumerate(keys):
            out.append(self.row(4 + i, x0 + 3, f"\x1b[38;5;111m{k:<8}{R}{TXT}{d}{R}"))
        out.append(self.row(5 + len(keys), x0 + 3, DIM + "click a workspace in the sidebar to switch · any key closes this" + R))
        self.full = True
        return "".join(out)

    def draw_cursor(self):
        if self.mode in ("pick", "help", "input", "confirm") or self.scroll or not self.screen:
            return "\x1b[?25l"
        c = self.screen.cursor
        pw, ph = self.pane
        px = max(0, min(self.pan or 0, max(0, self.screen.columns - pw)))
        cx = c.x - px
        if c.hidden or c.y >= ph or cx < 0 or cx > pw:
            return "\x1b[?25l"
        return f"\x1b[{c.y + 2};{self.sb + min(cx, pw - 1) + 1}H\x1b[?25h"

    # ── input ──
    def on_input(self):
        try:
            data = os.read(sys.stdin.fileno(), 65536)
        except OSError:
            data = b""
        if not data:
            self.quit.set()
            return
        text = self.pending_input + self.decoder.decode(data)
        self.pending_input = ""
        m = re.search(r"\x1b(\[<?[\d;]*)?$", text)   # an escape sequence cut in half waits for the next read; a lone Esc key does not
        if m and text != "\x1b":
            self.pending_input, text = text[m.start():], text[:m.start()]
        fwd = []

        def flush():
            if fwd:
                self.send({"op": "in", "d": "".join(fwd)})
                fwd.clear()
        for tok in TOKEN.findall(text):
            mm = MOUSE.fullmatch(tok)
            if mm:
                flush()
                self.mouse(int(mm.group(1)), int(mm.group(2)) - 1, int(mm.group(3)) - 1, mm.group(4) == "M")
                continue
            if self.mode == "normal":
                if tok == PREFIX:
                    flush()
                    self.mode = "prefix"
                    self.schedule(full=True)
                else:
                    fwd.append(tok)
                continue
            flush()
            self.key(tok)
        flush()

    def app_modes(self, nums, on):
        for n in nums:
            if n in APP_MOUSE:
                (self.app_mouse.add if on else self.app_mouse.discard)(n)
            elif n == 1006:
                self.app_sgr = on

    def mouse(self, b, x, y, press):
        in_pane = x >= self.sb and y >= 1 and self.screen is not None
        if in_pane and self.app_mouse and self.app_sgr and self.mode == "normal" and not self.scroll:
            # the program uses the mouse itself (Claude Code's fullscreen view scrolls its history with the wheel):
            # pass the event on, with coordinates inside the pane
            self.send({"op": "in", "d": f"\x1b[<{b};{x - self.sb + 1};{y}{'M' if press else 'm'}"})
            return
        if b in (64, 65):   # wheel
            if in_pane:
                self.scroll_by(3 if b == 64 else -3)
            return
        if not press or b & 3 != 0:
            return
        if x < self.sb:
            top = 2
            i = y - top
            if 0 <= i < len(self.terms):
                self.mode = "normal"
                asyncio.ensure_future(self.select(self.terms[i]["id"]))
                self.schedule(full=True)

    def scroll_by(self, n):
        hist = len(self.screen.history.top) if self.screen else 0
        self.scroll = max(0, min(hist, self.scroll + n))
        self.mode = "scroll" if self.scroll else ("normal" if self.mode == "scroll" else self.mode)
        self.schedule(full=True)

    def key(self, k):
        UP, DOWN = ("\x1b[A", "\x1bOA", "k"), ("\x1b[B", "\x1bOB", "j")
        if self.mode == "prefix":
            self.mode = "normal"
            self.prefix_key(k)
        elif self.mode == "help":
            self.mode = "normal"
        elif self.mode == "pick":
            if k in UP:
                self.pick = max(0, self.pick - 1)
            elif k in DOWN:
                self.pick = min(len(self.terms) - 1, self.pick + 1)
            elif k in ("\r", "\n", " "):
                self.mode = "normal"
                if self.terms:
                    asyncio.ensure_future(self.select(self.terms[self.pick]["id"]))
            elif k.isdigit() and k != "0":
                self.mode = "normal"
                self.jump(k)
            elif k in ("\x1b", "q", PREFIX):
                self.mode = "normal"
        elif self.mode == "scroll":
            ph = self.pane[1]
            if k in UP:
                self.scroll_by(1)
            elif k in DOWN:
                self.scroll_by(-1)
            elif k in ("\x1b[5~", "b", "\x02"):
                self.scroll_by(ph - 2)
            elif k in ("\x1b[6~", " ", "f"):
                self.scroll_by(-(ph - 2))
            elif k == "g":
                self.scroll_by(10 ** 6)
            elif k in ("G", "q", "\x1b", "\r"):
                self.scroll = 0
                self.mode = "normal"
        elif self.mode == "input":
            label, text, done = self.prompt
            if k in ("\r", "\n"):
                self.mode, self.prompt = "normal", None
                asyncio.ensure_future(done(text))
            elif k == "\x1b":
                self.mode, self.prompt = "normal", None
            elif k in ("\x7f", "\x08"):
                self.prompt = (label, text[:-1], done)
            elif k == "\x15":
                self.prompt = (label, "", done)
            elif len(k) == 1 and k >= " ":
                self.prompt = (label, text + k, done)
        elif self.mode == "confirm":
            q, yes = self.confirm
            self.mode, self.confirm = "normal", None
            if k in ("y", "Y"):
                asyncio.ensure_future(yes())
        self.schedule(full=True)

    def jump(self, digit):
        """1..9: the workspace with that number (as the sidebar, the tab row and `agent-master list` show it)."""
        t = next((x for x in self.terms if x.get("number") == int(digit)), None)
        if t:
            asyncio.ensure_future(self.select(t["id"]))
        else:
            self.flash(f"no workspace {digit}")

    def prefix_key(self, k):
        idx = next((i for i, t in enumerate(self.terms) if t["id"] == self.sel), 0)
        t = self.current()
        if k in ("w", "g"):
            self.mode, self.pick = "pick", idx
        elif k in ("n", "p") and self.terms:
            j = (idx + (1 if k == "n" else -1)) % len(self.terms)
            asyncio.ensure_future(self.select(self.terms[j]["id"]))
        elif k.isdigit() and k != "0":
            self.jump(k)
        elif k in ("q", "d"):
            self.quit.set()
        elif k == "b":
            self.sidebar = not self.sidebar
            self.relayout()
        elif k in ("h", "l") and self.screen and self.screen.columns > self.pane[0]:   # pan a pinned terminal sideways
            step = max(8, self.pane[0] // 3)
            self.pan = max(0, min((self.pan or 0) + (step if k == "l" else -step), self.screen.columns - self.pane[0]))
            self.schedule(full=True)
        elif k == "[":
            if self.screen:
                self.scroll_by(1)
        elif k == "?":
            self.mode = "help"
        elif k == PREFIX:
            self.send({"op": "in", "d": PREFIX})
        elif k == "c":
            cwd = (t or {}).get("cwd") or str(Path.home())
            asyncio.ensure_future(self.create({"kind": "shell", "cwd": cwd}))
        elif k == "N":
            start = ((t or {}).get("cwd") or str(Path.home())).replace(str(Path.home()), "~", 1)
            self.mode, self.prompt = "input", ("new Claude Code workspace in folder", start, self.new_in)
        elif k == "W" and t:
            self.mode, self.prompt = "input", ("rename to", t.get("label") or "", self.rename)
        elif k in ("x", "D", "X") and t:
            self.mode, self.confirm = "confirm", (f"close {t['label']}? this ends the process running in it", self.close_current)
        elif k == "R" and t:
            asyncio.ensure_future(self.restart_current())

    async def create(self, spec):
        pw, ph = self.pane
        res = await self.client.request("create", soft=True, cols=pw, rows=ph, **spec)
        if res.get("error"):
            self.flash(res["error"])
            return
        await self.select(res["term"]["id"])

    async def new_in(self, folder):
        path = os.path.realpath(os.path.expanduser(folder.strip() or "~"))
        if not os.path.isdir(path):
            self.flash(f"{folder} is not a folder")
            return
        await self.create({"kind": "claude", "cwd": path})

    async def rename(self, label):
        t = self.current()
        if t and label.strip():
            await self.client.request("rename", soft=True, id=t["id"], label=label.strip())

    async def close_current(self):
        t = self.current()
        if t:
            await self.client.request("close", soft=True, id=t["id"])
            self.flash(f"closed {t['label']}")

    async def restart_current(self):
        t = self.current()
        if t:
            await self.client.request("restart", soft=True, id=t["id"])
            self.flash(f"restarting {t['label']}")

    def relayout(self):
        self.W, self.H = tty_size()
        pw, ph = self.pane
        if self.screen:
            self.send({"op": "resize", "cols": pw, "rows": ph})   # our new size: the pty follows whoever used it last, and the terms event resizes the emulator
        self.pan = None
        self.schedule(full=True)

    async def tick(self):
        while not self.quit.is_set():   # status times in the sidebar
            await asyncio.sleep(5)
            self.schedule(full=False)

    async def run(self):
        if not sys.stdin.isatty() or not sys.stdout.isatty():
            die("the console needs an interactive terminal")
        fd = sys.stdin.fileno()
        saved = termios.tcgetattr(fd)
        loop = asyncio.get_running_loop()
        self.out.write(b"\x1b[?1049h\x1b[H\x1b[2J\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b]0;agent-master\x07")
        self.out.flush()
        tty.setraw(fd)
        loop.add_reader(fd, self.on_input)
        loop.add_signal_handler(signal.SIGWINCH, self.relayout)
        tasks = [asyncio.create_task(self.watch_terms()), asyncio.create_task(self.tick())]
        self.schedule(full=True)
        try:
            await self.quit.wait()
        finally:
            loop.remove_reader(fd)
            loop.remove_signal_handler(signal.SIGWINCH)
            for task in tasks:
                task.cancel()
            self.detach_pane()
            termios.tcsetattr(fd, termios.TCSADRAIN, saved)
            self.out.write(RESTORE + b"\x1b]0;\x07")
            self.out.flush()
            n = sum(1 for t in self.terms if t.get("agent"))
            print(f"detached from Agent-Master. {len(self.terms)} workspaces keep running ({n} with an agent). agent-master to come back.")


SGR_RE = re.compile(r"\x1b\[[\d;]*m")


def strip(s):
    return SGR_RE.sub("", s)


def fit_ansi(s, width):
    """Cut a styled string to `width` visible cells and pad it to exactly that width."""
    out, n, i = [], 0, 0
    while i < len(s) and n < width:
        m = SGR_RE.match(s, i)
        if m:
            out.append(m.group(0))
            i = m.end()
            continue
        out.append(s[i])
        n += 1
        i += 1
    return "".join(out) + " " * (width - n)


# ───────────────────────── plain attach (no console) ─────────────────────────
async def plain_attach(client, t, watch=False):
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        die("attach needs an interactive terminal")
    cols, rows = tty_size()
    try:
        reader, writer = await asyncio.open_unix_connection(client.sock, limit=8 * 1024 * 1024)
    except OSError:
        die("the terminal server is not running (systemctl --user start agent-masterd)")
    hello = {"op": "attach", "id": t["id"], "tail": TAIL * 5, "active": True}
    if not watch:
        hello.update(cols=cols, rows=rows, redraw=True)
    writer.write((json.dumps(hello) + "\n").encode())
    await writer.drain()
    head = json.loads(await reader.readline() or b"{}")
    if not head.get("ok"):
        die(head.get("error") or "attach failed")
    out, fd_in = sys.stdout.buffer, sys.stdin.fileno()
    saved = termios.tcgetattr(fd_in)
    loop = asyncio.get_running_loop()
    done = asyncio.Event()
    reason = {"text": "detached"}
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")

    def send(msg):
        try:
            writer.write((json.dumps(msg) + "\n").encode())
        except Exception:
            done.set()

    def on_input():
        try:
            data = os.read(fd_in, 65536)
        except OSError:
            data = b""
        if not data:
            done.set()
            return
        if DETACH in data:
            data = data[:data.index(DETACH)]
            if data and not watch:
                send({"op": "in", "d": decoder.decode(data)})
            done.set()
            return
        if not watch:
            text = decoder.decode(data)
            if text:
                send({"op": "in", "d": text})

    def on_winch():
        if not watch:
            c, r = tty_size()
            send({"op": "resize", "cols": c, "rows": r})

    async def pump():
        while True:
            data = await reader.read(262144)
            if not data:
                reason["text"] = "the terminal was closed"
                break
            out.write(data)
            out.flush()
        done.set()

    label = t.get("label") or t["id"]
    out.write(b"\x1b[H\x1b[2J\x1b[3J" + f"\x1b]0;{label} · agent-master · Ctrl+] detaches\x07".encode())
    out.flush()
    tty.setraw(fd_in)
    loop.add_reader(fd_in, on_input)
    loop.add_signal_handler(signal.SIGWINCH, on_winch)
    task = asyncio.create_task(pump())
    try:
        await done.wait()
    finally:
        loop.remove_reader(fd_in)
        loop.remove_signal_handler(signal.SIGWINCH)
        task.cancel()
        writer.close()
        termios.tcsetattr(fd_in, termios.TCSADRAIN, saved)
        out.write(RESTORE + b"\r\n")
        out.write(f"\x1b[2m[{reason['text']}: {label}. It keeps running; agent-master attach {label} to go back]\x1b[0m\n".encode())
        out.flush()


def print_list(terms):
    if not terms:
        print("No workspaces yet. Start one with: agent-master new ~/project   (or --shell)")
        return
    colour = sys.stdout.isatty()
    home = str(Path.home())
    rows = []
    for t in terms:
        st = status_of(t)
        what = t.get("agent") or ("command" if t.get("kind") == "command" else "shell")
        rows.append((str(t.get("number")), (t.get("label") or t["id"]) + ("*" if t.get("prev_session_id") else ""), what, st, ago(t.get("status_since")), str(t.get("viewers") or 0),
                     (t.get("cwd") or "").replace(home, "~", 1), (t.get("task") or "")[:60]))
    head = ("#", "NAME", "RUNS", "STATUS", "FOR", "VIEW", "FOLDER", "LAST PROMPT")
    changed = [t for t in terms if t.get("prev_session_id")]
    widths = [max(len(r[i]) for r in rows + [head]) for i in range(len(head) - 1)]

    def fmt(r, paint=False):
        cells = [r[i].ljust(widths[i]) for i in range(len(r) - 1)]
        if paint:
            cells[3] = STATUS_FG.get(r[3], "") + cells[3] + R
        return "  ".join(cells) + "  " + r[-1]
    print(DIM + fmt(head) + R if colour else fmt(head))
    for r in rows:
        print(fmt(r, colour))
    for t in changed:   # a resume that found no transcript started a new chat: say so, and how to go back
        print((DIM if colour else "") + f"* {t.get('label')}: session id changed; previous session {t['prev_session_id']}"
              f" — agent-master new {(t.get('cwd') or '~').replace(home, '~', 1)} --label {shlex.quote(t.get('label') or '')} --resume {t['prev_session_id']}" + (R if colour else ""))


async def main():
    ap = argparse.ArgumentParser(prog="agent-master", description="The Agent-Master console and workspace commands.",
                                 formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog="With no command, opens the console (prefix ctrl+b, then ? for keys).")
    ap.add_argument("--socket", default=None, help="terminal server socket (default ~/.config/agent-master/ptyd.sock)")
    sub = ap.add_subparsers(dest="action")
    sub.add_parser("list", aliases=["ls"], help="list the workspaces")
    a = sub.add_parser("attach", aliases=["a"], help="open the console on a workspace")
    a.add_argument("name")
    a.add_argument("--plain", action="store_true", help="attach this terminal directly, without the console (Ctrl+] detaches)")
    a.add_argument("--watch", action="store_true", help="with --plain: read only, keep the size the other viewers use")
    n = sub.add_parser("new", help="start a workspace and open it")
    n.add_argument("dir", nargs="?", default=".")
    g = n.add_mutually_exclusive_group()
    g.add_argument("--claude", action="store_true", help="run Claude Code (the default)")
    g.add_argument("--shell", action="store_true", help="just a shell")
    g.add_argument("--cmd", dest="command", metavar="COMMAND", help="run this command line")
    n.add_argument("--label")
    n.add_argument("--model", help="Claude model, e.g. claude-opus-5")
    n.add_argument("--resume", metavar="SESSION_ID", help="resume this Claude Code session")
    n.add_argument("--no-attach", action="store_true")
    s = sub.add_parser("send", help="type text into a workspace and press Enter")
    s.add_argument("name")
    s.add_argument("text", nargs="+")
    c = sub.add_parser("close", help="end the process in a workspace and remove it")
    c.add_argument("name")
    c.add_argument("-y", "--yes", action="store_true")
    args = ap.parse_args()
    client = Client(args.socket or default_socket())

    if args.action is None:
        await client.request("list")   # fails early with a clear message when the server is down
        await Console(client).run()
    elif args.action in ("list", "ls"):
        print_list(await client.terms())
    elif args.action in ("attach", "a"):
        t, err = resolve(await client.terms(), args.name)
        if not t:
            die(err)
        if args.plain:
            await plain_attach(client, t, watch=args.watch)
        else:
            await Console(client, select=t["id"]).run()
    elif args.action == "new":
        cwd = os.path.realpath(os.path.expanduser(args.dir))
        if not os.path.isdir(cwd):
            die(f"{args.dir} is not a directory")
        spec = {"cwd": cwd, "label": args.label or ""}
        if args.shell:
            spec["kind"] = "shell"
        elif args.command:
            spec.update(kind="command", command=args.command)
        else:
            spec.update(kind="claude", model=args.model, resume=args.resume)
        if sys.stdout.isatty():
            spec["cols"], spec["rows"] = max(20, tty_size()[0] - SIDEBAR), max(5, tty_size()[1] - 1)
        t = (await client.request("create", **spec))["term"]
        print(f"started {t['label']} ({t['id']}) in {cwd.replace(str(Path.home()), '~', 1)}")
        if not args.no_attach and sys.stdin.isatty() and sys.stdout.isatty():
            await Console(client, select=t["id"]).run()
    elif args.action == "send":
        t, err = resolve(await client.terms(), args.name)
        if not t:
            die(err)
        await client.request("send", id=t["id"], text=" ".join(args.text) + "\r")
        print(f"sent to {t['label']}")
    elif args.action == "close":
        t, err = resolve(await client.terms(), args.name)
        if not t:
            die(err)
        if not args.yes:
            if not sys.stdin.isatty():
                die("add -y to close without asking")
            if input(f"Close {t['label']}? This ends the process running in it. [y/N] ").strip().lower() not in ("y", "yes"):
                print("kept")
                return
        await client.request("close", id=t["id"])
        print(f"closed {t['label']}")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
