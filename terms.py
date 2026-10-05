"""Bridge between the web app and agent-masterd (ptyd.py): terminal list and status, actions, and live attachments."""

import asyncio
import json
import logging
import os
from pathlib import Path

log = logging.getLogger("agent-master.terms")
PREFIX = "t:"


def default_socket():
    s = os.environ.get("AGENT_MASTER_PTYD_SOCK")
    if s:
        return s
    d = os.environ.get("AGENT_MASTER_CONFIG_DIR")
    if d:
        return str(Path(d).expanduser() / "ptyd.sock")
    return str(Path("~/.config/agent-master").expanduser() / "ptyd.sock")


def claude_info(t):
    """The parts of Claude Code's status snapshot the UI shows: identity, update, context, cost, limits."""
    st = t.get("stats") or {}
    if not st:
        return None
    cost, cw, rl, cache = st.get("cost") or {}, st.get("context_window") or {}, st.get("rate_limits") or {}, st.get("prompt_cache") or {}
    lim = lambda k: (rl.get(k) or {}).get("used_percentage")
    return {"name": st.get("session_name"), "model": (st.get("model") or {}).get("display_name"), "model_id": (st.get("model") or {}).get("id"),
            "version": t.get("claude_version"), "installed": t.get("installed_version"), "update": bool(t.get("update")),
            "context_pct": cw.get("used_percentage"), "context_size": cw.get("context_window_size"),
            "cost": cost.get("total_cost_usd"), "lines_added": cost.get("total_lines_added"), "lines_removed": cost.get("total_lines_removed"),
            "duration_ms": cost.get("total_duration_ms"), "limit_5h": lim("five_hour"), "limit_7d": lim("seven_day"),
            "limit_5h_reset": (rl.get("five_hour") or {}).get("resets_at"), "limit_7d_reset": (rl.get("seven_day") or {}).get("resets_at"),
            "cache_warm": cache.get("warm"), "cache_expires": cache.get("expires_at"), "thinking": (st.get("thinking") or {}).get("enabled"),
            "fast": st.get("fast_mode")}


class TermError(Exception):
    pass


class Attachment:
    """One browser terminal attached to one daemon terminal: raw bytes out, keystrokes and size in."""

    def __init__(self, reader, writer, task=None):
        self.reader, self.writer, self.task = reader, writer, task

    def _line(self, msg):
        try:
            self.writer.write((json.dumps(msg) + "\n").encode())
        except Exception:
            pass

    def input(self, text):
        self._line({"op": "in", "d": text})

    def resize(self, cols, rows):
        self._line({"op": "resize", "cols": int(cols), "rows": int(rows)})

    def close(self):
        if self.task:
            self.task.cancel()
        try:
            self.writer.close()
        except Exception:
            pass


class TermManager:
    def __init__(self, hub, sock_path=None):
        self.hub = hub
        self.sock = sock_path or default_socket()
        self.terms = {}           # id -> info from the daemon
        self.available = False
        self._task = None

    def start(self):
        self._task = asyncio.create_task(self._loop())

    async def _loop(self):
        """Subscribe to the daemon; reconnect when it restarts."""
        warned = False
        while True:
            try:
                reader, writer = await asyncio.open_unix_connection(self.sock, limit=8 * 1024 * 1024)
                writer.write(b'{"op": "subscribe"}\n')
                await writer.drain()
                first = json.loads(await reader.readline())
                self.available, warned = True, False
                self._set(first.get("terms") or [])
                log.info("connected to agent-masterd (%d terminals)", len(self.terms))
                while True:
                    line = await reader.readline()
                    if not line:
                        break
                    msg = json.loads(line)
                    if msg.get("ev") == "terms":
                        self._set(msg.get("terms") or [])
                    elif msg.get("ev") == "tool" and self.hub:
                        await self.hub.hook_event(None, {"tool_name": msg.get("tool"), "tool_input": msg.get("input") or {}}, src_wid=PREFIX + str(msg.get("id")))
                    elif msg.get("ev") == "notice" and self.hub:
                        log.warning("%s", msg.get("text"))
                        await self.hub.broadcast({"type": "notice", "text": msg.get("text"), "workspace_id": PREFIX + str(msg.get("id"))})
            except (OSError, ValueError, asyncio.IncompleteReadError) as exc:
                if not warned:
                    log.warning("agent-masterd not reachable at %s (%s); retrying", self.sock, exc)
                    warned = True
            if self.available:
                self.available = False
                self._set([])
            await asyncio.sleep(2)

    def _set(self, terms):
        self.terms = {t["id"]: t for t in terms}
        if self.hub:
            self.hub.request_refresh()

    # ── requests ──
    async def request(self, op, **kw):
        try:
            reader, writer = await asyncio.open_unix_connection(self.sock)
        except OSError:
            raise TermError("the terminal server (agent-masterd) is not running")
        try:
            writer.write((json.dumps({"op": op, **kw}) + "\n").encode())
            await writer.drain()
            line = await asyncio.wait_for(reader.readline(), 15)
        finally:
            writer.close()
        res = json.loads(line or b"{}")
        if res.get("error"):
            raise TermError(res["error"])
        return res

    async def create(self, **kw):
        res = await self.request("create", **kw)
        t = res["term"]
        self.terms[t["id"]] = t
        if self.hub:
            self.hub.request_refresh()
        return {"ok": True, "workspace_id": PREFIX + t["id"], "term": t}

    async def attach(self, tid, cols, rows, on_bytes, on_close, scalable=True):
        try:
            reader, writer = await asyncio.open_unix_connection(self.sock, limit=8 * 1024 * 1024)
        except OSError:
            raise TermError("the terminal server (agent-masterd) is not running")
        # scalable: a browser can shrink its font to show a grid bigger than its own fit, so it never dictates the size over a console
        writer.write((json.dumps({"op": "attach", "id": tid, "cols": int(cols), "rows": int(rows), "scalable": bool(scalable)}) + "\n").encode())
        await writer.drain()
        head = json.loads(await asyncio.wait_for(reader.readline(), 10) or b"{}")
        if head.get("error") or not head.get("ok"):
            writer.close()
            raise TermError(head.get("error") or "attach failed")
        att = Attachment(reader, writer)

        async def pump():
            reason = "terminal closed"
            try:
                while True:
                    data = await reader.read(262144)
                    if not data:
                        break
                    await on_bytes(data)
            except asyncio.CancelledError:
                return
            except Exception as exc:
                reason = str(exc) or reason
            await on_close(reason)

        att.task = asyncio.create_task(pump())
        return att

    # ── office entries ──
    def entries(self):
        out = []
        for t in sorted(self.terms.values(), key=lambda x: x.get("number", 0)):
            wid = PREFIX + t["id"]
            st = t.get("status") or "idle"
            agent = t.get("agent")
            ws = {"workspace_id": wid, "label": t.get("label") or t["id"], "number": 100 + int(t.get("number") or 0), "agent_status": st if agent else "unknown",
                  "status_since": t.get("status_since"), "focused": False, "pane_count": 1, "local": True}
            pane = {"pane_id": wid, "workspace_id": wid, "agent": agent, "agent_status": st if agent else "unknown", "cwd": t.get("cwd"), "foreground_cwd": t.get("cwd"),
                    "task": t.get("task"), "question": t.get("question"), "local": True, "model": t.get("model"), "kind": t.get("kind"),
                    "running": t.get("running"), "viewers": t.get("viewers"), "terminal_title_stripped": t.get("label"),
                    "agent_session": {"source": "agent-master", "agent": "claude", "kind": "id", "value": t["session_id"]} if t.get("kind") == "claude" and t.get("session_id") else None,
                    "claude": claude_info(t), "fixed_cols": t.get("fixed_cols"), "fixed_rows": t.get("fixed_rows"),
                    "replay_bytes": t.get("buf_bytes"), "replay_since": t.get("buf_since"), "prev_session_id": t.get("prev_session_id"), "permission_mode": t.get("permission_mode"),
                    "cols": t.get("cols"), "rows": t.get("rows")}
            out.append((ws, pane))
        return out

    async def action(self, kind, args):
        target = str(args.get("workspace_id") or args.get("pane_id") or "")
        tid = target[len(PREFIX):] if target.startswith(PREFIX) else target
        if kind == "send":
            await self.request("send", id=tid, text=str(args.get("text", "")))
        elif kind == "stop_pane":
            await self.request("send", id=tid, text="\x03")
        elif kind in ("close_workspace", "close_pane"):
            await self.request("close", id=tid)
            self.terms.pop(tid, None)
        elif kind == "rename":
            await self.request("rename", id=tid, label=str(args.get("label") or ""))
        elif kind == "restart":
            await self.request("restart", id=tid)
        elif kind == "seen":
            await self.request("seen", id=tid)
        elif kind == "set_session":
            await self.request("set_session", id=tid, session_id=str(args.get("session_id") or ""))
        elif kind == "set_mode":
            await self.request("set_mode", id=tid, permission_mode=args.get("permission_mode"))
        elif kind == "set_size":
            fc = args.get("fixed_cols")
            fr = args.get("fixed_rows")
            await self.request("set_size", id=tid, fixed_cols=int(fc) if fc else None, fixed_rows=int(fr) if fr else None)
        elif kind in ("focus_workspace", "focus_pane"):
            pass   # there is no separate console to focus: the browser terminal is the console
        else:
            raise TermError(f"unknown action {kind}")
        if self.hub:
            self.hub.request_refresh()
        return {"ok": True}
