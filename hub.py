"""The Hub: the office state built from agent-masterd's terminals and the headless agents, pushed to every browser."""

import asyncio
import json
import logging
import os
import re
import subprocess
import time

from collections import deque

from transcript import find_transcript, read_transcript

log = logging.getLogger("agent-master.hub")

POLL_INTERVAL = 3.0     # a safety refresh: status times, branches and anything a push missed
BRANCH_INTERVAL = 2.0
GIT_TTL = 15.0
FILE_KEYS = ("file_path", "path", "notebook_path", "directory")
EGG = "egg: a plain shell with no agent inside, not intelligent, cannot code or think, only peeps and wobbles"


class Hub:
    def __init__(self, name, store, chatter=None):
        self.name = name
        self.store = store
        self.chatter = chatter
        self.said = deque(maxlen=12)   # recent chat lines, so the model does not repeat itself
        self.state = {"session": name, "workspaces": [], "panes": [], "server": None, "connected": True, "terminals": False}
        self.sockets = set()
        self.status_since = {}        # workspace_id -> epoch
        self.status_estimated = set()  # workspaces whose status time is only 'since we started', not a recorded change
        self._seed = None
        self.agents = None            # AgentManager (headless agents), set by app.py
        self.terms = None             # TermManager: terminals run by agent-masterd, set by app.py
        self.git_cache = {}           # cwd -> (branch, ts)
        self._refresh_lock = asyncio.Lock()
        self._refresh_requested = asyncio.Event()
        self._tasks = []

    # ── lifecycle ──────────────────────────────────────────────────────────
    async def start(self):
        await self.refresh()
        for coro in (self._refresh_worker(), self._poll_loop(), self._branch_loop()):
            self._tasks.append(asyncio.create_task(coro))

    def request_refresh(self):
        self._refresh_requested.set()

    async def _refresh_worker(self):
        while True:
            await self._refresh_requested.wait()
            await asyncio.sleep(0.08)
            self._refresh_requested.clear()
            await self.refresh()

    async def _poll_loop(self):
        while True:
            await asyncio.sleep(POLL_INTERVAL)
            await self.refresh()

    async def _branch_loop(self):
        while True:
            await asyncio.sleep(BRANCH_INTERVAL)
            try:
                await self._refresh_branches()
            except Exception as exc:
                log.debug("git refresh failed: %s", exc)

    # ── state ───────────────────────────────────────────────────────────────
    async def refresh(self):
        async with self._refresh_lock:
            now = time.time()
            workspaces, panes = [], []
            for w, p in self._entries():   # terminals and headless agents carry exact status times
                self.status_since[w["workspace_id"]] = w["status_since"]
                self.status_estimated.discard(w["workspace_id"])
                p["branch"] = self._branch(p.get("cwd"))
                p["left_root"] = False
                workspaces.append(w)
                panes.append(p)
            if self._seed is None:   # first refresh after a start: take status times from the event log where the status still matches
                try:
                    self._seed = self.store.last_status(self.name)
                except Exception:   # a missing or old database must not stop the hub
                    self._seed = {}
            for w in workspaces:
                wid = w["workspace_id"]
                if wid not in self.status_since:
                    seeded = self._seed.get(wid)
                    if seeded and seeded[0] == w.get("agent_status"):
                        self.status_since[wid] = seeded[1]
                    else:
                        self.status_since[wid] = now
                        self.status_estimated.add(wid)
                if w.get("status_since") is None:
                    w["status_since"] = self.status_since[wid]
                if wid in self.status_estimated:
                    w["status_since_estimated"] = True
            new = {"session": self.name, "workspaces": workspaces, "panes": panes, "server": None, "connected": True,
                   "terminals": bool(self.terms and self.terms.available)}
            events = self._diff(self.state, new) if self.state.get("workspaces") or workspaces else []
            for ev in events:
                wid = ev.get("workspace_id")
                if ev["kind"] == "status" and wid:
                    self.status_estimated.discard(wid)
                self.store.log(self.name, ev["kind"], wid, ev.get("label"), ev.get("from"), ev.get("to"),
                               {k: v for k, v in ev.items() if k not in ("kind", "workspace_id", "label", "from", "to")} or None)
            for wid in list(self.status_since):
                if not any(w["workspace_id"] == wid for w in workspaces):
                    del self.status_since[wid]
            changed = events or self._signature(self.state) != self._signature(new)
            self.state = new
            if changed:
                await self.broadcast({"type": "state", "state": new, "events": events})

    def _entries(self):
        out = []
        if self.terms:
            out += self.terms.entries()
        if self.agents:
            out += self.agents.entries()
        return out

    def _branch(self, cwd):
        if not cwd:
            return None
        hit = self.git_cache.get(cwd)
        return hit[0] if hit else None

    async def _refresh_branches(self):
        cwds = {p.get("cwd") for p in self.state["panes"]}
        cwds.discard(None)
        now = time.time()
        loop = asyncio.get_running_loop()
        changed = False
        for cwd in cwds:
            hit = self.git_cache.get(cwd)
            if hit and now - hit[1] < GIT_TTL:
                continue
            branch = await loop.run_in_executor(None, _git_branch, cwd)
            if not hit or hit[0] != branch:
                changed = True
            self.git_cache[cwd] = (branch, now)
        for cwd in list(self.git_cache):
            if cwd not in cwds:
                del self.git_cache[cwd]
        if changed:
            self.request_refresh()

    @staticmethod
    def _signature(state):
        return json.dumps([state.get("workspaces"), state.get("panes"), state.get("terminals")], sort_keys=True)

    @staticmethod
    def _diff(old, new):
        events = []
        old_ws = {w["workspace_id"]: w for w in old.get("workspaces", [])}
        new_ws = {w["workspace_id"]: w for w in new.get("workspaces", [])}
        for wid, w in new_ws.items():
            if wid not in old_ws:
                if old.get("workspaces"):
                    events.append({"kind": "workspace_created", "workspace_id": wid, "label": w.get("label")})
                continue
            o = old_ws[wid]
            if o.get("agent_status") != w.get("agent_status"):
                events.append({"kind": "status", "workspace_id": wid, "label": w.get("label"), "from": o.get("agent_status"), "to": w.get("agent_status")})
            if o.get("label") != w.get("label"):
                events.append({"kind": "renamed", "workspace_id": wid, "label": w.get("label"), "from": o.get("label")})
        for wid, w in old_ws.items():
            if wid not in new_ws:
                events.append({"kind": "workspace_closed", "workspace_id": wid, "label": w.get("label")})
        old_p = {p["pane_id"]: p for p in old.get("panes", [])}
        new_p = {p["pane_id"]: p for p in new.get("panes", [])}
        labels = {w["workspace_id"]: w.get("label") for w in new.get("workspaces", [])}
        for pid, p in new_p.items():
            o = old_p.get(pid)
            if o and o.get("agent") and not p.get("agent"):
                events.append({"kind": "agent_gone", "workspace_id": p["workspace_id"], "label": labels.get(p["workspace_id"]), "pane_id": pid, "agent": o.get("agent")})
            if o and not o.get("agent") and p.get("agent"):
                events.append({"kind": "agent_started", "workspace_id": p["workspace_id"], "label": labels.get(p["workspace_id"]), "pane_id": pid, "agent": p.get("agent")})
        return events

    # ── tool calls reported by the hooks: an agent touching another workspace's files is a visit ──
    async def hook_event(self, pane_id, payload, src_wid=None):
        tool = payload.get("tool_name") or ""
        inp = payload.get("tool_input") or {}
        path = next((inp[k] for k in FILE_KEYS if isinstance(inp.get(k), str)), None)
        if not path and tool == "Bash":
            m = re.search(r"(/home/[^\s'\"]+|/tmp/[^\s'\"]+|/srv/[^\s'\"]+|/opt/[^\s'\"]+)", inp.get("command") or "")
            path = m.group(1) if m else None
        if not path:
            return
        panes = {p["pane_id"]: p for p in self.state["panes"]}
        src = {"workspace_id": src_wid} if src_wid else panes.get(pane_id)
        if not src:
            return
        best = None
        for w in self.state["workspaces"]:
            roots = [p.get("cwd") for p in self.state["panes"] if p["workspace_id"] == w["workspace_id"] and p.get("cwd")]
            for root in roots:
                r = root.rstrip("/") + "/"
                if path == root or path.startswith(r):
                    if best is None or len(root) > len(best[1]):
                        best = (w, root)
        if not best or best[0]["workspace_id"] == src["workspace_id"]:
            return
        target = best[0]
        labels = {w["workspace_id"]: w.get("label") for w in self.state["workspaces"]}
        ev = {"kind": "visit", "workspace_id": src["workspace_id"], "label": labels.get(src["workspace_id"]),
              "to_workspace_id": target["workspace_id"], "to_label": target.get("label"),
              "tool": tool, "path": path, "rel": os.path.relpath(path, best[1]) if path != best[1] else "."}
        self.store.log(self.name, "visit", ev["workspace_id"], ev["label"], None, None, ev)
        await self.broadcast({"type": "state", "state": self.state, "events": [ev]})

    # ── lounge chat: briefing from live state + transcripts, lines from the chatter ───────
    def _fmt_for(self, since):
        s = max(0, time.time() - (since or time.time()))
        return f"{int(s)}s" if s < 60 else f"{int(s // 60)} min" if s < 3600 else f"{s / 3600:.1f} h"

    def _speaker(self, wid, activity):
        w = next((x for x in self.state["workspaces"] if x["workspace_id"] == wid), None)
        if not w:
            return None
        panes = [p for p in self.state["panes"] if p["workspace_id"] == wid]
        p = next((x for x in panes if x.get("agent")), panes[0] if panes else {})
        info = {"name": w["label"], "status": w.get("agent_status"), "idle_for": self._fmt_for(w.get("status_since")),
                "task": p.get("task"), "branch": p.get("branch"), "folder": os.path.basename((p.get("cwd") or "").rstrip("/")), "doing_now": activity,
                "kind": EGG if p.get("kind") == "shell" else "coding agent"}
        sess = (p.get("agent_session") or {}).get("value")
        path = find_transcript(sess) if p.get("agent") == "claude" and sess else None
        if path:
            try:
                entries, _ = read_transcript(path, 40)
                prompts = [e["text"] for e in entries if e["role"] == "user"][-2:]
                answers = [e["text"] for e in entries if e["role"] == "assistant"][-1:]
                tools = [e["text"] for e in entries if e["role"] == "tool"][-4:]
                tidy = lambda s: s.replace("—", "-").replace("\n", " ")
                info["last_prompts"] = [tidy(t)[:160] for t in prompts]
                info["last_said"] = tidy(answers[0])[:240] if answers else None
                info["recent_tools"] = [tidy(t)[:80] for t in tools]
            except Exception:
                pass
        return info

    async def chat(self, a_id, b_id, activities):
        if not self.chatter:
            return None, "off"
        activities = activities if isinstance(activities, dict) else {}
        a = self._speaker(a_id, activities.get(a_id)); b = self._speaker(b_id, activities.get(b_id))
        if not a or not b:
            return None, "off"
        others = []
        for w in self.state["workspaces"]:
            if w["workspace_id"] in (a_id, b_id):
                continue
            p = next((x for x in self.state["panes"] if x["workspace_id"] == w["workspace_id"] and x.get("agent")), {})
            o = {"name": w["label"], "status": w.get("agent_status"), "for": self._fmt_for(w.get("status_since"))}
            if p.get("kind") == "shell":
                o["kind"] = "egg"
            if p.get("task"):
                o["task"] = p["task"][:120]
            if p.get("question"):
                o["question"] = p["question"][-200:]
            others.append(o)
        events = [{"kind": e["kind"], "label": e.get("label"), "from": e.get("from"), "to": e.get("to"), "ago": self._fmt_for(e["ts"])}
                  for e in self.store.events(self.name, limit=6) if e["kind"] in ("status", "visit", "workspace_created", "workspace_closed")]
        briefing = {"time": time.strftime("%A %H:%M"), "speakers": [a, b], "activity": {a["name"]: a["doing_now"], b["name"]: b["doing_now"]},
                    "office": others, "events": events, "already_said": list(self.said)}
        lines, source = await self.chatter.generate(briefing)
        if lines:
            for l in lines:
                self.said.append(l["text"])
            self.store.log(self.name, "chat", a_id, a["name"], None, None, {"with": b["name"], "source": source, "lines": lines})
        return lines, source

    # ── actions: every target is a terminal ("t:<id>") or a headless agent ("a:<id>") ──
    async def action(self, kind, args):
        target = str(args.get("agent_id") or args.get("workspace_id") or args.get("pane_id") or "")
        if self.agents and (target.startswith("a:") or args.get("agent_id")):
            return await self.agents.action(kind, args)
        if kind == "send" and self.terms and args.get("pane_ids"):   # a broadcast: one prompt to several terminals
            for pid in args["pane_ids"]:
                if str(pid).startswith("t:"):
                    await self.terms.action("send", {"pane_id": pid, "text": args.get("text", "")})
            return {"ok": True}
        if self.terms and target.startswith("t:"):
            return await self.terms.action(kind, args)
        raise KeyError(f"unknown target for {kind}")

    # ── websocket plumbing ─────────────────────────────────────────────────
    async def broadcast(self, msg):
        for ws in list(self.sockets):
            await self._send(ws, msg)

    async def _send(self, ws, msg):
        try:
            await ws.send_text(json.dumps(msg))
        except Exception as exc:
            if os.environ.get("AGENT_MASTER_STREAM_DEBUG"):
                log.info("ws send failed (%s): %s", msg.get("type"), exc)
            self.drop(ws)

    def attach(self, ws):
        self.sockets.add(ws)

    def drop(self, ws):
        self.sockets.discard(ws)


def _git_branch(cwd):
    try:
        out = subprocess.run(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], capture_output=True, text=True, timeout=2)
        return out.stdout.strip() or None if out.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None
