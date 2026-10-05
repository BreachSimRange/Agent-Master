"""Headless agents: Claude Code run by the UI itself, no terminal in between.

Each agent is one `claude -p --input-format stream-json --output-format stream-json` process. Prompts
and permission answers go in as JSON lines; assistant text (streamed), tool calls, tool results,
permission requests and turn results come out as JSON lines. Everything is stored in SQLite and pushed
to the browsers, and each agent is merged into the hub's state as a virtual workspace so the office,
the ribbon, the attention panel and the cards treat it like any other agent.
"""
import asyncio
import json
import logging
import os
import secrets
import shutil
import time

import transcript as _transcript

log = logging.getLogger("agent-master.agents")

FILE_KEYS = ("file_path", "path", "notebook_path")
DEFAULT_MODEL = "claude-opus-5"
DELTA_INTERVAL = 0.08


def claude_binary():
    return shutil.which("claude") or os.path.expanduser("~/.local/bin/claude")


def tool_summary(name, inp):
    inp = inp or {}
    arg = next((inp[k] for k in ("file_path", "path", "command", "pattern", "url", "description", "prompt") if isinstance(inp.get(k), str)), "")
    if len(arg) > 160:
        arg = arg[:157] + "..."
    return f"{name}({arg})" if arg else name


class AgentRunner:
    def __init__(self, manager, row):
        self.m = manager
        self.id = row["id"]
        self.label = row.get("label") or row["id"]
        self.cwd = row.get("cwd") or os.path.expanduser("~")
        self.model = row.get("model") or DEFAULT_MODEL
        self.claude_session_id = row.get("claude_session_id")
        self.permission_mode = row.get("permission_mode")
        self.number = row.get("number") or 0
        self.created = row.get("created") or time.time()
        self.status = row.get("status") if row.get("status") in ("idle", "done") else "idle"
        self.status_since = row.get("status_since") or time.time()
        self.task = row.get("task")
        self.tokens_in = int(row.get("tokens_in") or 0)
        self.tokens_out = int(row.get("tokens_out") or 0)
        self.cost = float(row.get("cost") or 0)
        self.question = None
        self.pending = {}          # request_id -> can_use_tool request
        self.proc = None
        self.reader = None
        self.partial = ""          # streamed assistant text of the current message
        self._delta_task = None
        self._delta_buf = ""
        self.last_error = None
        self.tools = []
        self.turns = 0

    # ── state ──
    def row(self):
        return {"id": self.id, "session": self.m.session, "label": self.label, "cwd": self.cwd, "model": self.model,
                "claude_session_id": self.claude_session_id, "created": self.created, "status": self.status,
                "status_since": self.status_since, "task": self.task, "archived": 0, "tokens_in": self.tokens_in,
                "tokens_out": self.tokens_out, "cost": self.cost, "permission_mode": self.permission_mode, "number": self.number}

    def save(self):
        self.m.store.agent_save(self.row())

    @property
    def wid(self):
        return "a:" + self.id

    def running(self):
        return self.proc is not None and self.proc.returncode is None

    def summary(self):
        return {"id": self.id, "workspace_id": self.wid, "label": self.label, "cwd": self.cwd, "model": self.model,
                "status": self.status, "status_since": self.status_since, "task": self.task, "question": self.question,
                "pending": [{"request_id": k, "tool": v.get("tool_name"), "summary": tool_summary(v.get("tool_name"), v.get("input")),
                             "description": v.get("description")} for k, v in self.pending.items()],
                "running": self.running(), "claude_session_id": self.claude_session_id, "tokens_in": self.tokens_in,
                "tokens_out": self.tokens_out, "cost": round(self.cost, 4), "turns": self.turns, "error": self.last_error, "headless": True, "created": self.created, "permission_mode": self.permission_mode, "history": self.m.store.history_count(self.id)}

    def workspace(self):
        return {"workspace_id": self.wid, "label": self.label, "number": 1000 + self.number, "agent_status": self.status,
                "status_since": self.status_since, "focused": False, "pane_count": 1, "headless": True}

    def pane(self):
        return {"pane_id": self.wid, "workspace_id": self.wid, "agent": "claude", "agent_status": self.status,
                "cwd": self.cwd, "foreground_cwd": self.cwd, "task": self.task, "question": self.question,
                "agent_session": {"source": "agent-master:headless", "agent": "claude", "kind": "id", "value": self.claude_session_id} if self.claude_session_id else None,
                "terminal_title_stripped": "headless " + self.label, "headless": True, "model": self.model}

    async def _set_status(self, st, task=None):
        if st == self.status and task is None:
            return
        prev = self.status
        if st != self.status:
            self.status = st
            self.status_since = time.time()
        if task is not None:
            self.task = task
        if st != "blocked":
            self.question = None
        self.save()
        await self.m.status_changed(self, prev, st)

    async def _emit(self, kind, data, store=True):
        ev = {"ts": time.time(), "kind": kind, "data": data}
        if store:
            ev["id"] = self.m.store.agent_event_add(self.id, kind, data, ev["ts"])
        await self.m.broadcast({"type": "agent_event", "agent_id": self.id, "event": ev})

    # ── process ──
    def import_history(self):
        """Save this session's pre-move transcript into the database, once."""
        if not self.claude_session_id:
            return 0
        if self.m.store.history_count(self.id):
            return self.m.store.history_count(self.id)
        path = _transcript.find_transcript(self.claude_session_id)
        if not path:
            return 0
        try:
            entries = _transcript.all_entries(path)
        except OSError:
            return 0
        n = self.m.store.import_history(self.id, entries)
        log.info("agent %s (%s): imported %d history entries", self.id, self.label, n)
        return n

    async def start(self):
        if self.running():
            return
        argv = [claude_binary(), "-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose",
                "--include-partial-messages", "--permission-prompt-tool", "stdio", "--model", self.model]
        if self.permission_mode:
            argv += ["--permission-mode", self.permission_mode]
        if self.claude_session_id:
            argv += ["--resume", self.claude_session_id]
        env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE")}
        env["AGENT_MASTER_AGENT"] = self.id
        os.makedirs(self.cwd, exist_ok=True)
        self.proc = await asyncio.create_subprocess_exec(
            *argv, cwd=self.cwd, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, env=env, limit=64 * 1024 * 1024)
        self.last_error = None
        self.reader = asyncio.create_task(self._read())
        await self._send({"type": "control_request", "request_id": "init-" + secrets.token_hex(3), "request": {"subtype": "initialize", "hooks": {}}})
        log.info("agent %s (%s) started: %s", self.id, self.label, " ".join(argv[1:]))

    async def _send(self, obj):
        if not self.running() or self.proc.stdin.is_closing():
            raise RuntimeError("agent is not running")
        self.proc.stdin.write((json.dumps(obj) + "\n").encode())
        await self.proc.stdin.drain()

    async def stop(self, reason="stopped"):
        if self.reader:
            self.reader.cancel()
            self.reader = None
        if self.proc and self.proc.returncode is None:
            try:
                self.proc.stdin.close()
            except Exception:
                pass
            try:
                await asyncio.wait_for(self.proc.wait(), 3)
            except asyncio.TimeoutError:
                self.proc.terminate()
                try:
                    await asyncio.wait_for(self.proc.wait(), 3)
                except asyncio.TimeoutError:
                    self.proc.kill()
        self.proc = None
        self.pending.clear()
        if self.status in ("working", "blocked"):
            await self._set_status("idle")
        await self._emit("system", {"text": reason}, store=False)

    # ── actions ──
    async def prompt(self, text):
        text = (text or "").strip()
        if not text:
            return {"error": "empty prompt"}
        if not self.running():
            await self.start()
        await self._emit("user", {"text": text})
        await self._send({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": text}]}})
        self.turns += 1
        await self._set_status("working", task=text[:300])
        return {"ok": True}

    async def answer(self, request_id, allow, message=None, remember=False):
        req = self.pending.pop(request_id, None)
        if not req:
            return {"error": "no such request"}
        if allow:
            resp = {"behavior": "allow", "updatedInput": req.get("input")}
            if remember:
                sugg = [s for s in (req.get("permission_suggestions") or []) if isinstance(s, dict)]
                if sugg:
                    resp["updatedPermissions"] = sugg
        else:
            resp = {"behavior": "deny", "message": message or "Denied by the operator in Agent-Master"}
        await self._send({"type": "control_response", "response": {"subtype": "success", "request_id": request_id, "response": resp}})
        await self._emit("decision", {"request_id": request_id, "tool": req.get("tool_name"), "summary": tool_summary(req.get("tool_name"), req.get("input")),
                                      "allow": bool(allow), "remember": bool(remember), "message": message})
        if not self.pending:
            await self._set_status("working")
        else:
            self.question = self._question_text()
            self.save()
        return {"ok": True}

    MODES = ["default", "acceptEdits", "plan"]

    async def set_mode(self, mode=None):
        if mode is None:   # cycle like shift+tab
            cur = self.permission_mode if self.permission_mode in self.MODES else "default"
            mode = self.MODES[(self.MODES.index(cur) + 1) % len(self.MODES)]
        if mode not in self.MODES:
            return {"error": "bad mode"}
        self.permission_mode = None if mode == "default" else mode
        self.save()
        if self.running():
            try:
                await self._send({"type": "control_request", "request_id": "mode-" + secrets.token_hex(3), "request": {"subtype": "set_permission_mode", "mode": mode}})
            except RuntimeError:
                pass
        await self._emit("system", {"text": "mode: " + mode}, store=False)
        await self.m.broadcast({"type": "agent", "agent": self.summary()})
        return {"ok": True, "mode": mode}

    async def interrupt(self):
        if not self.running():
            return {"error": "agent is not running"}
        await self._send({"type": "control_request", "request_id": "int-" + secrets.token_hex(3), "request": {"subtype": "interrupt"}})
        return {"ok": True}

    def _question_text(self):
        if not self.pending:
            return None
        rid, req = next(iter(self.pending.items()))
        return f"Allow {tool_summary(req.get('tool_name'), req.get('input'))}?"

    # ── output ──
    async def _read(self):
        try:
            while True:
                line = await self.proc.stdout.readline()
                if not line:
                    break
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                try:
                    await self._handle(msg)
                except Exception as exc:   # one bad event must not kill the reader
                    log.warning("agent %s: event handling failed: %s", self.id, exc)
        except asyncio.CancelledError:
            return
        # process ended
        err = ""
        try:
            err = (await asyncio.wait_for(self.proc.stderr.read(4000), 1)).decode("utf-8", "replace").strip()
        except Exception:
            pass
        rc = self.proc.returncode if self.proc else None
        if rc is None and self.proc:
            try:
                rc = await asyncio.wait_for(self.proc.wait(), 2)
            except asyncio.TimeoutError:
                rc = None
        self.proc = None
        self.reader = None
        self.pending.clear()
        self.last_error = (err.splitlines()[-1] if err else None) if rc not in (0, None) else None
        log.info("agent %s (%s) exited rc=%s %s", self.id, self.label, rc, self.last_error or "")
        await self._emit("system", {"text": f"agent process exited (code {rc})" + (": " + self.last_error if self.last_error else "")}, store=bool(self.last_error))
        if self.status in ("working", "blocked"):
            await self._set_status("idle")
        elif self.last_error:
            await self.m.status_changed(self, self.status, self.status)

    async def _flush_delta(self):
        await asyncio.sleep(DELTA_INTERVAL)
        text, self._delta_buf, self._delta_task = self._delta_buf, "", None
        if text:
            await self.m.broadcast({"type": "agent_delta", "agent_id": self.id, "text": text})

    async def _handle(self, msg):
        t = msg.get("type")
        if t == "system":
            if msg.get("subtype") == "init":
                sid = msg.get("session_id")
                if sid and sid != self.claude_session_id:
                    self.claude_session_id = sid
                    self.save()
                self.model = msg.get("model") or self.model
                self.tools = msg.get("tools") or []
            return
        if t == "stream_event":
            ev = msg.get("event") or {}
            if ev.get("type") == "content_block_delta" and (ev.get("delta") or {}).get("type") == "text_delta":
                piece = ev["delta"].get("text", "")
                self.partial += piece
                self._delta_buf += piece
                if not self._delta_task:
                    self._delta_task = asyncio.create_task(self._flush_delta())
            elif ev.get("type") == "message_start":
                self.partial = ""
            return
        if t == "assistant":
            content = (msg.get("message") or {}).get("content") or []
            blocks = []
            for b in content:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "text":
                    blocks.append({"type": "text", "text": b.get("text", "")})
                elif b.get("type") == "tool_use":
                    blocks.append({"type": "tool_use", "id": b.get("id"), "name": b.get("name"), "summary": tool_summary(b.get("name"), b.get("input")),
                                   "input": b.get("input") if len(json.dumps(b.get("input") or {})) < 4000 else {"truncated": True}})
                    await self.m.tool_used(self, b.get("name"), b.get("input") or {})
                elif b.get("type") == "thinking":
                    blocks.append({"type": "thinking", "chars": len(b.get("thinking") or "")})
            self.partial = ""
            if self._delta_task:
                self._delta_task.cancel()
                self._delta_task = None
                self._delta_buf = ""
            if blocks:
                await self._emit("assistant", {"content": blocks})
            if self.status != "blocked":
                await self._set_status("working")
            return
        if t == "user":
            content = (msg.get("message") or {}).get("content") or []
            results = []
            for b in content:
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    c = b.get("content")
                    if isinstance(c, list):
                        c = "\n".join(x.get("text", "") for x in c if isinstance(x, dict))
                    c = str(c or "")
                    lines = c.splitlines()
                    if len(lines) > 40:
                        c = "\n".join(lines[:40]) + f"\n... ({len(lines) - 40} more lines)"
                    results.append({"tool_use_id": b.get("tool_use_id"), "text": c[:6000], "is_error": bool(b.get("is_error"))})
            if results:
                await self._emit("tool_result", {"results": results})
            return
        if t == "control_request":
            req = msg.get("request") or {}
            if req.get("subtype") == "can_use_tool":
                rid = msg.get("request_id")
                self.pending[rid] = req
                self.question = self._question_text()
                await self._set_status("blocked")   # summary (with the pending list) goes out before the event itself
                if self.status == "blocked":
                    await self.m.broadcast({"type": "agent", "agent": self.summary()})
                await self._emit("permission", {"request_id": rid, "tool": req.get("tool_name"), "summary": tool_summary(req.get("tool_name"), req.get("input")),
                                                "description": req.get("description"), "input": req.get("input") if len(json.dumps(req.get("input") or {})) < 4000 else {"truncated": True},
                                                "suggestions": req.get("permission_suggestions")})
            return
        if t == "control_response":
            return
        if t == "result":
            usage = msg.get("usage") or {}
            self.tokens_in += int(usage.get("input_tokens") or 0) + int(usage.get("cache_read_input_tokens") or 0) + int(usage.get("cache_creation_input_tokens") or 0)
            self.tokens_out += int(usage.get("output_tokens") or 0)
            self.cost += float(msg.get("total_cost_usd") or 0)
            await self._emit("result", {"duration_ms": msg.get("duration_ms"), "cost_usd": msg.get("total_cost_usd"), "stop_reason": msg.get("stop_reason"),
                                        "is_error": bool(msg.get("is_error")), "text": (msg.get("result") or "")[:2000] if msg.get("is_error") else None,
                                        "tokens": {"in": usage.get("input_tokens"), "out": usage.get("output_tokens"), "cache_read": usage.get("cache_read_input_tokens")},
                                        "denials": msg.get("permission_denials") or []})
            self.partial = ""
            await self._set_status("blocked" if msg.get("is_error") and self.pending else "done")
            return


class AgentManager:
    """All headless agents of the office."""

    def __init__(self, store, session, hub=None):
        self.store = store
        self.session = session
        self.hub = hub
        self.runners = {}
        for row in store.agents(session):
            self.runners[row["id"]] = AgentRunner(self, row)
        if self.runners:
            log.info("headless agents restored for %s: %s", session, ", ".join(r.label for r in self.runners.values()))

    # ── state for the hub ──
    def entries(self):
        return [(r.workspace(), r.pane()) for r in sorted(self.runners.values(), key=lambda r: r.number)]

    def summaries(self):
        return [r.summary() for r in sorted(self.runners.values(), key=lambda r: r.number)]

    def get(self, agent_id):
        if agent_id and agent_id.startswith("a:"):
            agent_id = agent_id[2:]
        return self.runners.get(agent_id)

    async def broadcast(self, msg):
        if self.hub:
            await self.hub.broadcast(msg)

    async def status_changed(self, runner, prev, st):
        if self.hub:
            self.hub.request_refresh()
        await self.broadcast({"type": "agent", "agent": runner.summary()})

    async def tool_used(self, runner, tool, inp):
        if self.hub:
            await self.hub.hook_event(None, {"tool_name": tool, "tool_input": inp}, src_wid=runner.wid)

    # ── lifecycle ──
    async def create(self, label, cwd, model=None, resume=None, permission_mode=None):
        cwd = os.path.expanduser(cwd or "~")
        if not os.path.isdir(cwd):
            return {"error": f"no such folder: {cwd}"}
        aid = secrets.token_hex(4)
        row = {"id": aid, "session": self.session, "label": (label or os.path.basename(cwd.rstrip("/")) or "agent")[:60], "cwd": cwd,
               "model": model or DEFAULT_MODEL, "claude_session_id": resume, "created": time.time(), "status": "idle",
               "status_since": time.time(), "task": None, "archived": 0, "tokens_in": 0, "tokens_out": 0, "cost": 0,
               "permission_mode": permission_mode, "number": self.store.agent_next_number(self.session)}
        self.store.agent_save(row)
        r = AgentRunner(self, row)
        self.runners[aid] = r
        if resume:
            try:
                r.import_history()
            except Exception as exc:
                log.warning("history import failed for %s: %s", aid, exc)
        await r._emit("system", {"text": ("resumed Claude Code session " + resume[:8] if resume else "new headless agent") + " in " + cwd})
        if self.hub:
            self.hub.request_refresh()
        await self.broadcast({"type": "agent", "agent": r.summary()})
        return {"ok": True, "agent": r.summary()}

    async def archive(self, agent_id):
        r = self.get(agent_id)
        if not r:
            return {"error": "no such agent"}
        await r.stop("closed")
        row = r.row()
        row["archived"] = 1
        self.store.agent_save(row)
        del self.runners[r.id]
        if self.hub:
            self.hub.request_refresh()
        await self.broadcast({"type": "agent_gone", "agent_id": r.id})
        return {"ok": True}

    async def action(self, kind, args):
        r = self.get(args.get("agent_id") or args.get("workspace_id") or args.get("pane_id"))
        if not r:
            return {"error": "no such agent"}
        if kind in ("send", "prompt"):
            return await r.prompt(args.get("text", ""))
        if kind == "answer":
            return await r.answer(args.get("request_id"), bool(args.get("allow")), args.get("message"), bool(args.get("remember")))
        if kind in ("stop_pane", "interrupt"):
            return await r.interrupt()
        if kind in ("set_mode", "cycle_mode"):
            return await r.set_mode(args.get("mode"))
        if kind == "stop":
            await r.stop("stopped by the operator")
            return {"ok": True}
        if kind in ("close_workspace", "archive"):
            return await self.archive(r.id)
        if kind == "seen":
            if r.status == "done":
                await r._set_status("idle")
            return {"ok": True}
        if kind in ("focus_workspace", "focus_pane"):
            return {"ok": True}
        return {"error": f"unknown action {kind} for a headless agent"}

    async def shutdown(self):
        for r in list(self.runners.values()):
            try:
                await r.stop("ui restarting")
            except Exception:
                pass

    def import_all(self):
        total = {}
        for r in self.runners.values():
            try:
                total[r.label] = r.import_history()
            except Exception as exc:
                log.warning("history import failed for %s: %s", r.id, exc)
                total[r.label] = -1
        return total
