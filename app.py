"""Agent-Master: a workspace manager for AI coding agents, with a pixel office and live terminals served from agent-masterd (ptyd.py)."""

import argparse
import asyncio
import hmac
import ipaddress
import json
import logging
import os
import re
import secrets
import shutil
import subprocess
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

import uvicorn
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from auth import MIN_PASSWORD, SESSION_DAYS, Auth
from chatter import Chatter
from code_server import CodeServer
from agents import AgentManager
from terms import TermError, TermManager
from hub import Hub
from store import Store
from transcript import find_transcript, project_sessions, read_transcript, summary

log = logging.getLogger("agent-master")
ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
COOKIE = "agent_master_session"
PUBLIC_PATHS = {"/login", "/api/auth/status", "/api/auth/login", "/api/auth/setup"}
MAX_BODY = 1_000_000
SAFE_SESSION = re.compile(r"^[A-Za-z0-9._-]{8,80}$")
BASE_CODE = "/code"
transcript_totals = {}   # (path, size, mtime, until) -> entry count, so paging through a long history does not re-count every file each time


def inside_home(path):
    home = Path.home().resolve()
    try:
        p = Path(os.path.expanduser(path)).resolve()
    except OSError:
        return False
    return p == home or home in p.parents
MAX_UPLOAD = 12_000_000   # pasted screenshots
IMAGE_MAGIC = ((b"\x89PNG", "png"), (b"\xff\xd8\xff", "jpg"), (b"GIF8", "gif"), (b"RIFF", "webp"))


def image_kind(data: bytes):
    for magic, ext in IMAGE_MAGIC:
        if data.startswith(magic) and (ext != "webp" or data[8:12] == b"WEBP"):
            return ext
    return None


def paste_dir(config_path: str) -> Path:
    d = Path(config_path).expanduser().resolve().parent / "paste"
    d.mkdir(mode=0o700, parents=True, exist_ok=True)
    return d


def prune_pastes(d: Path, keep=100, max_age=3 * 86400):
    files = sorted(d.glob("paste-*"), key=lambda f: f.stat().st_mtime, reverse=True)
    now = time.time()
    for i, f in enumerate(files):
        if i >= keep or now - f.stat().st_mtime > max_age:
            try:
                f.unlink()
            except OSError:
                pass
MAX_PREFS = 200_000


class Hubs:
    """One office ("default"): the terminals run by agent-masterd and the headless agents."""

    def __init__(self, store, chatter=None):
        self.store = store
        self.chatter = chatter
        self.hubs: dict[str, Hub] = {}

    async def start(self):
        hub = Hub("default", self.store, self.chatter)
        hub.agents = AgentManager(self.store, "default", hub)
        hub.terms = TermManager(hub)
        hub.terms.start()
        self.hubs["default"] = hub
        await hub.start()

    def get(self, name=None):
        return self.hubs.get(name) or self.hubs.get("default")

    def names(self):
        return sorted(self.hubs, key=lambda n: (n != "default", n))


def is_private(host):
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback or ip.is_link_local


def same_origin(request, host_header):
    """Reject browser requests whose Origin does not match the Host we were reached on."""
    origin = request.headers.get("origin")
    if origin:
        try:
            if urlsplit(origin).netloc.lower() != (host_header or "").lower():
                return False
        except ValueError:
            return False
    site = request.headers.get("sec-fetch-site")
    if site and site not in ("same-origin", "same-site", "none"):
        return False
    return True


LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]"}


def loopback_only(client_host, host_header):
    """Tunnel-only mode: the request must come from this machine and be addressed to it."""
    try:
        ip = ipaddress.ip_address(client_host)
    except ValueError:
        return False
    name = (host_header or "").rsplit(":", 1)[0].lower() if not (host_header or "").startswith("[") else (host_header or "").split("]")[0] + "]"
    return ip.is_loopback and name in LOOPBACK_HOSTS


def host_name(host_header):
    h = (host_header or "").strip().lower()
    if h.startswith("["):
        return h.split("]")[0] + "]"
    return h.rsplit(":", 1)[0] if ":" in h else h


def build_app(hubs: Hubs, auth: Auth, store: Store, code: CodeServer = None, tls=False, behind_proxy=False, allow_browse_outside_home=False, tunnel_only=False, allowed_hosts=()) -> FastAPI:
    allowed_hosts = {h.lower() for h in allowed_hosts}
    @asynccontextmanager
    async def lifespan(_app):
        await hubs.start()
        yield
        for hub in list(hubs.hubs.values()):   # headless agents are resumed by session id on the next prompt
            if hub.agents:
                await hub.agents.shutdown()

    app = FastAPI(title="Agent-Master", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.mount("/static", StaticFiles(directory=STATIC), name="static")
    login_locks: dict[str, asyncio.Lock] = {}
    login_gate = asyncio.Semaphore(8)

    def signed_in(request) -> bool:
        return auth.check(request.cookies.get(COOKIE))

    def set_session(resp):
        resp.set_cookie(COOKIE, auth.issue(), httponly=True, samesite="lax", secure=tls or behind_proxy, path="/", max_age=SESSION_DAYS * 86400)   # behind a proxy the browser side is HTTPS too
        return resp

    def client_ip(request):
        return request.client.host if request.client else "?"

    async def body(request: Request):
        try:
            data = await request.json()
        except Exception:
            data = {}
        return data if isinstance(data, dict) else {}

    def err(message, status=400):
        return JSONResponse({"error": message}, status_code=status)

    # ── the error page: a pixel character says No. Pages only; the API and VS Code keep their own answers ──
    ERROR_TEXT = {404: ("There is nothing here.", "The address does not match a page, a workspace or a file of this office."),
                  403: ("You may not.", "This instance answers only for its own hostname, its own origin and its own operator."),
                  405: ("Not like that.", "That page does not take this kind of request."),
                  413: ("Too much.", "The request body is bigger than this office accepts."),
                  500: ("Something broke on my desk.", "The server hit an error. The log has the details: journalctl --user -u agent-master."),
                  502: ("The editor is not answering.", "VS Code is not reachable behind the proxy right now."),
                  503: ("Not right now.", "A service this page needs is not running.")}
    ERROR_PAGE = (STATIC / "error.html").read_text()

    def wants_page(request):
        return request.method in ("GET", "HEAD") and "text/html" in request.headers.get("accept", "") and not request.url.path.startswith(("/api/", "/code/")) and request.url.path != "/code"

    def error_page(request, status):
        title, detail = ERROR_TEXT.get(status, ("That did not work.", "The server answered with an error."))
        html = ERROR_PAGE.replace("{{status}}", str(status)).replace("{{title}}", title).replace("{{detail}}", detail)
        return HTMLResponse(html, status_code=status)

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception):
        log.exception("unhandled error on %s %s", request.method, request.url.path)
        return error_page(request, 500) if wants_page(request) else err("internal error", 500)

    @app.middleware("http")
    async def guard(request: Request, call_next):
        path = request.url.path
        host = request.headers.get("host", "")
        if tunnel_only and not loopback_only(client_ip(request), host):
            return JSONResponse({"error": "this instance is reachable only through the SSH tunnel (http://127.0.0.1)"}, status_code=403)
        if allowed_hosts and host_name(host) not in allowed_hosts:
            return JSONResponse({"error": "use the hostname, not the IP address: " + ", ".join(sorted(allowed_hosts))}, status_code=403)
        is_code = path == "/code" or path.startswith("/code/")   # VS Code behind the proxy: its own bodies and headers, our sign-in, host and origin rules
        if request.method in ("POST", "PUT", "PATCH", "DELETE"):
            if not same_origin(request, host):
                return err("cross-site request blocked", 403)
        if request.method in ("POST", "PUT", "PATCH", "DELETE") and not is_code:
            try:
                if int(request.headers.get("content-length") or 0) > (MAX_UPLOAD if path == "/api/upload" else MAX_BODY):
                    return err("request too large", 413)
            except ValueError:
                return err("bad request", 400)
        if auth.enabled and path not in PUBLIC_PATHS and not path.startswith("/static/") and not signed_in(request):
            if path.startswith("/api/"):
                return err("unauthorized", 401)
            return RedirectResponse("/login")
        resp = await call_next(request)
        if is_code:
            return resp
        if resp.status_code in ERROR_TEXT and wants_page(request):   # a browser asked for a page that does not exist or is refused
            resp = error_page(request, resp.status_code)
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["X-Frame-Options"] = "DENY"
        resp.headers["Referrer-Policy"] = "no-referrer"
        resp.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), payment=()"
        resp.headers["Content-Security-Policy"] = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
                                                   "font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'")
        if tls:
            resp.headers["Strict-Transport-Security"] = "max-age=31536000"
        if path.startswith("/api/"):
            resp.headers["Cache-Control"] = "no-store"
        elif path.startswith("/static/") or path in ("/", "/login"):
            resp.headers["Cache-Control"] = "no-cache"
        return resp

    # ── auth ──
    @app.get("/login")
    async def login_page():
        return FileResponse(STATIC / "login.html")

    @app.get("/api/auth/status")
    async def auth_status(request: Request):
        ok = signed_in(request)
        return {"enabled": auth.enabled, "configured": auth.configured, "authenticated": ok,
                "username": auth.username if ok else None, "min_password": MIN_PASSWORD,
                "setup_needs_token": auth.enabled and not auth.configured}

    def valid_username(name):
        return 1 <= len(name) <= 32 and all(c.isalnum() or c in "._-@" for c in name)

    @app.post("/api/auth/setup")
    async def auth_setup(request: Request):
        if not auth.enabled:
            return err("authentication is disabled (--no-auth)")
        if auth.configured:
            return err("an account already exists; change it from settings", 409)
        data = await body(request)
        client = client_ip(request)
        # first-run setup always needs the token printed in the server log: a proxy on this machine (Tailscale Funnel, nginx)
        # makes every visitor look local, so the client address cannot be trusted to decide who may create the account
        token = str(data.get("setup_token") or "")
        if not token or not hmac.compare_digest(token, auth.get("setup_token") or "-"):
            log.warning("setup attempt from %s without a valid setup token", client)
            return err("creating the account needs the setup token from the server log (journalctl --user -u agent-master)", 403)
        username, password = str(data.get("username") or "").strip(), str(data.get("password") or "")
        if not valid_username(username):
            return err("username: 1 to 32 letters, digits or . _ - @")
        if len(password) < MIN_PASSWORD:
            return err(f"password: use at least {MIN_PASSWORD} characters")
        auth.set_credentials(username, password)
        auth.data.pop("setup_token", None)
        auth._save()
        log.info("account '%s' created from %s", username, client)
        return set_session(JSONResponse({"ok": True}))

    @app.post("/api/auth/login")
    async def auth_login(request: Request):
        client = client_ip(request)
        lock = login_locks.setdefault(client, asyncio.Lock())
        async with login_gate, lock:
            left = auth.locked_for(client) or auth.locked_global()
            if left:
                return err(f"too many failed attempts; try again in {int(left // 60) + 1} min", 429)
            await asyncio.sleep(auth.penalty(client))
            data = await body(request)
            typed = str(data.get("username") or "").strip()[:64]
            ok = auth.verify(typed, str(data.get("password") or "")[:256])
            auth.record(client, ok)
            if not ok:
                log.warning("failed sign-in from %s", client)
                return err("wrong username or password", 401)
            if not auth.username:
                if not valid_username(typed):
                    return err("username: 1 to 32 letters, digits or . _ - @")
                auth.set_credentials(username=typed)
                log.info("account adopted username '%s' from %s", typed, client)
        if len(login_locks) > 5000:
            login_locks.clear()
        return set_session(JSONResponse({"ok": True}))

    @app.post("/api/auth/change")
    async def auth_change(request: Request):
        if not auth.enabled:
            return err("authentication is disabled (--no-auth)")
        data = await body(request)
        if not auth.verify(auth.username, str(data.get("current") or "")[:256]):
            await asyncio.sleep(1.0)
            return err("current password is wrong", 401)
        username = str(data.get("username") or "").strip() or None
        new = str(data.get("new") or "") or None
        if username is not None and not valid_username(username):
            return err("username: 1 to 32 letters, digits or . _ - @")
        if new is not None and len(new) < MIN_PASSWORD:
            return err(f"password: use at least {MIN_PASSWORD} characters")
        if username is None and new is None:
            return err("nothing to change")
        auth.set_credentials(username, new)
        return set_session(JSONResponse({"ok": True, "username": auth.username}))

    @app.post("/api/auth/logout")
    async def auth_logout(request: Request):
        data = await body(request)
        if data.get("everywhere"):
            auth.revoke_all()
        resp = JSONResponse({"ok": True})
        resp.delete_cookie(COOKIE, path="/")
        return resp

    # ── pages + state ──
    @app.get("/")
    async def index():
        return FileResponse(STATIC / "index.html")

    @app.get("/api/sessions")
    async def api_sessions():
        return {"sessions": hubs.names()}

    @app.get("/api/state")
    async def api_state(session: str = None):
        hub = hubs.get(session)
        return hub.state if hub else {"connected": False, "workspaces": [], "panes": []}

    @app.get("/api/events")
    async def api_events(session: str = None, workspace: str = None, kind: str = None, since: float = None, limit: int = 300):
        hub = hubs.get(session)
        return {"events": store.events(hub.name if hub else session, workspace, kind, since, max(1, min(int(limit), 2000)))}

    @app.get("/api/summary")
    async def api_summary(session: str = None, since: float = None):
        hub = hubs.get(session)
        if not hub:
            return {"summary": {}}
        since = since or (time.time() - 86400)
        current = [(w["workspace_id"], w.get("agent_status"), w.get("label"), w.get("status_since")) for w in hub.state["workspaces"]]
        return {"since": since, "summary": store.summary(hub.name, since, current)}

    @app.get("/api/prefs")
    async def get_prefs():
        return store.get_pref("prefs", {}) or {}

    @app.put("/api/prefs")
    async def put_prefs(request: Request):
        raw = await request.body()
        if len(raw) > MAX_PREFS:
            return err("preferences too large", 413)
        try:
            data = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return err("bad json")
        if not isinstance(data, dict):
            return err("bad json")
        data = {k: data[k] for k in ("costumes", "desks", "templates", "chatter") if k in data}
        store.set_pref("prefs", data)
        if hubs.chatter:
            hubs.chatter.configure(data.get("chatter") or {})
        for hub in hubs.hubs.values():
            await hub.broadcast({"type": "prefs", "prefs": data})
        return {"ok": True}

    @app.post("/api/action")
    async def api_action(request: Request):
        data = await body(request)
        hub = hubs.get(data.get("session"))
        if not hub:
            return err("no session", 503)
        try:
            return await hub.action(data.get("action"), data)
        except TermError as exc:
            return err(str(exc))
        except (KeyError, OSError, asyncio.TimeoutError) as exc:
            return err(str(exc) or "request failed")

    @app.get("/api/chatter/status")
    async def chatter_status():
        return hubs.chatter.status() if hubs.chatter else {"backend": "off"}

    @app.post("/api/upload")
    async def api_upload(request: Request):
        """A screenshot pasted or dropped into the UI: saved on this machine so the agent can read it by path."""
        data = await request.body()
        if len(data) > MAX_UPLOAD:
            return err("image too large (12 MB max)", 413)
        ext = image_kind(data)
        if not ext:
            return err("only PNG, JPEG, GIF or WebP images", 415)
        d = paste_dir(auth.path)
        prune_pastes(d)
        name = f"paste-{time.strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(3)}.{ext}"
        target = d / name
        with open(target, "wb") as fh:
            fh.write(data)
        os.chmod(target, 0o600)
        return {"path": str(target), "bytes": len(data)}

    def terms_of(hub):
        t = hub.terms if hub and hub.terms else next((h.terms for h in hubs.hubs.values() if h.terms), None)
        if not t:
            raise TermError("no terminal server")
        return t

    @app.post("/api/terms")
    async def api_terms_create(request: Request):
        """A new terminal workspace run by agent-masterd: Claude Code, another agent, a custom command or a plain shell."""
        data = await body(request)
        cwd = str(data.get("cwd") or "~")
        if not allow_browse_outside_home and not inside_home(cwd):
            return err("folder must be inside the home directory", 403)
        kind = data.get("kind") if data.get("kind") in ("claude", "agent", "shell", "command") else "shell"
        resume = data.get("resume")
        if resume and not SAFE_SESSION.match(str(resume)):
            return err("bad session id", 400)
        mode = data.get("permission_mode") if data.get("permission_mode") in ("acceptEdits", "plan", "default", "bypassPermissions") else None
        try:
            return await terms_of(hubs.get(data.get("session"))).create(
                kind=kind, cwd=cwd, label=str(data.get("label") or "")[:60], command=str(data.get("command") or "")[:1000],
                model=str(data.get("model") or "")[:80] or None, permission_mode=mode, resume=resume, fresh=bool(data.get("fresh")),
                cols=int(data.get("cols") or 0) or None, rows=int(data.get("rows") or 0) or None)
        except (TermError, ValueError) as exc:
            return err(str(exc))

    @app.post("/api/terms/from-headless")
    async def api_terms_from_headless(request: Request):
        """Move every headless agent (or the ones listed) into a real terminal that resumes the same Claude session."""
        data = await body(request)
        hub = hubs.get(data.get("session"))
        if not hub or not hub.agents:
            return err("no session", 503)
        want = set(data.get("ids") or [])
        moved, failed = [], []
        for r in list(hub.agents.runners.values()):
            if want and r.id not in want and r.wid not in want:
                continue
            sid, label, cwd, model = r.claude_session_id, r.label, r.cwd, r.model
            mode = r.permission_mode if r.permission_mode in ("acceptEdits", "plan") else None
            await hub.agents.archive(r.id)   # stop the headless process first: one session, one process
            try:
                res = await terms_of(hub).create(kind="claude", cwd=cwd, label=label, model=model, permission_mode=mode, resume=sid)
                moved.append({"label": label, "workspace_id": res["workspace_id"], "session_id": sid})
            except (TermError, ValueError) as exc:
                failed.append({"label": label, "error": str(exc), "session_id": sid})
        return {"ok": not failed, "moved": moved, "failed": failed}

    @app.get("/api/agents")
    async def api_agents(session: str = None):
        hub = hubs.get(session)
        return {"agents": hub.agents.summaries() if hub and hub.agents else [], "claude": bool(shutil.which("claude"))}

    @app.post("/api/agents")
    async def api_agents_create(request: Request):
        """A new headless agent: Claude Code run by the UI in a folder, optionally resuming a session id."""
        data = await body(request)
        hub = hubs.get(data.get("session"))
        if not hub or not hub.agents:
            return err("no session", 503)
        cwd = str(data.get("cwd") or "~")
        if not allow_browse_outside_home and not inside_home(cwd):
            return err("folder must be inside the home directory", 403)
        resume = data.get("resume")
        if resume and not SAFE_SESSION.match(str(resume)):
            return err("bad session id", 400)
        return await hub.agents.create(str(data.get("label") or "")[:60], cwd, str(data.get("model") or "")[:80] or None, resume,
                                       data.get("permission_mode") if data.get("permission_mode") in ("acceptEdits", "plan", "manual", "dontAsk", None) else None)

    @app.post("/api/agents/import-history")
    async def api_import_history(request: Request):
        data = await body(request)
        hub = hubs.get(data.get("session"))
        if not hub or not hub.agents:
            return err("no session", 503)
        return {"ok": True, "imported": hub.agents.import_all()}

    @app.get("/api/agents/{agent_id}/history")
    async def api_agent_history(agent_id: str, session: str = None, before: int = None, limit: int = 150):
        hub = hubs.get(session)
        r = hub.agents.get(agent_id) if hub and hub.agents else None
        if not r:
            return err("no such agent", 404)
        return {"entries": store.history(r.id, before, max(1, min(400, limit))), "total": store.history_count(r.id)}

    @app.get("/api/agents/{agent_id}/events")
    async def api_agent_events(agent_id: str, session: str = None, before: int = None, limit: int = 200):
        hub = hubs.get(session)
        if not hub or not hub.agents or not hub.agents.get(agent_id):
            return err("no such agent", 404)
        r = hub.agents.get(agent_id)
        return {"agent": r.summary(), "events": store.agent_events(r.id, before, max(1, min(500, limit))), "total": store.agent_event_count(r.id), "partial": r.partial}

    @app.get("/api/agent_info")
    async def api_agent_info(session: str = None, workspace_id: str = ""):
        """Everything known about one workspace's agent, for the character card."""
        hub = hubs.get(session)
        if not hub:
            return err("no session", 404)
        w = next((x for x in hub.state["workspaces"] if x["workspace_id"] == workspace_id), None)
        if not w:
            return err("no such workspace", 404)
        panes = [p for p in hub.state["panes"] if p["workspace_id"] == workspace_id]
        pane = next((p for p in panes if p.get("agent")), panes[0] if panes else None)
        info = {"workspace": {k: w.get(k) for k in ("workspace_id", "label", "number", "agent_status", "status_since")},
                "pane": None, "session": None}
        if pane:
            sess = pane.get("agent_session") or {}
            info["pane"] = {k: pane.get(k) for k in ("pane_id", "agent", "agent_status", "cwd", "foreground_cwd", "branch", "task", "question", "terminal_title_stripped", "left_root")}
            info["pane"]["session_id"] = sess.get("value") if sess.get("kind") == "id" else None
            info["pane"]["session_source"] = sess.get("source")
            path = find_transcript(info["pane"]["session_id"]) if info["pane"]["session_id"] else None
            if path:
                info["session"] = summary(path)
                if info["session"] is not None:
                    info["session"]["file"] = str(path)
        current = [(x["workspace_id"], x.get("agent_status"), x.get("label"), x.get("status_since")) for x in hub.state["workspaces"]]
        info["time"] = (store.summary(hub.name, time.time() - 86400, current) or {}).get(workspace_id)
        return info

    @app.get("/api/transcript")
    async def api_transcript(session: str = None, pane_id: str = "", limit: int = 400, offset: int = 0, full: int = 0, until: float = None):
        """The agent's own conversation history (Claude Code transcript), far beyond the terminal's replay buffer."""
        hub = hubs.get(session)
        pane = next((p for p in (hub.state["panes"] if hub else []) if p["pane_id"] == pane_id), None)
        if not pane:
            return err("pane not found", 404)
        sess = (pane.get("agent_session") or {}).get("value")
        if pane.get("agent") != "claude" or not sess:
            return {"entries": [], "total": 0, "note": "history is available for Claude Code panes with a known session"}
        path = find_transcript(sess)
        if not path:
            return {"entries": [], "total": 0, "note": "no transcript file found for this session yet"}
        # The workspace's whole history: this session first, then the folder's earlier sessions, newest to oldest, as one
        # list paged from the newest end. `offset` counts back from the newest entry across all of them.
        chain = [(sess, path)]
        for s_ in project_sessions(pane.get("cwd") or "", limit=40) if pane.get("cwd") else []:
            p_ = find_transcript(s_["id"]) if s_["id"] != sess else None
            if p_:
                chain.append((s_["id"], p_))
        limit, offset = max(20, min(int(limit), 2000)), max(0, int(offset))

        def page():
            out, total, skip, need = [], 0, offset, limit
            for i, (sid, p_) in enumerate(chain):
                cut = until if i == 0 else None
                key = (str(p_), p_.stat().st_size, int(p_.stat().st_mtime), cut)
                count = transcript_totals.get(key)
                if count is None:
                    count = read_transcript(p_, 1, 0, False, cut)[1]
                    transcript_totals[key] = count
                    if len(transcript_totals) > 256:
                        transcript_totals.clear()
                total += count
                if need <= 0 or skip >= count:
                    skip = max(0, skip - count)
                    continue
                ents, _ = read_transcript(p_, need, skip, bool(full), cut)
                if i > 0 and skip == 0:   # the newest part of an earlier session: mark where it ended
                    st_ = p_.stat()
                    ents = ents + [{"ts": None, "role": "session", "text": f"earlier session {sid[:8]} · last used {time.strftime('%d %b %Y %H:%M', time.localtime(st_.st_mtime))} · the one below is newer"}]
                out = ents + out
                need -= len(ents)
                skip = 0
            return out, total + max(0, len(chain) - 1)   # the seam lines between sessions are entries too, so paging ends exactly at the start

        loop = asyncio.get_running_loop()
        entries, total = await loop.run_in_executor(None, page)
        return {"entries": entries, "total": total, "offset": offset, "file": path.name, "sessions": len(chain)}

    @app.get("/api/claude-sessions")
    async def api_claude_sessions(path: str = "~"):
        """Claude Code conversations recorded for a folder, newest first, for the new-workspace dialog."""
        home = Path.home().resolve()
        p = Path(os.path.expanduser(path)).resolve()
        if not allow_browse_outside_home and p != home and home not in p.parents:
            return err("browsing is limited to your home folder", 403)
        loop = asyncio.get_running_loop()
        return {"sessions": await loop.run_in_executor(None, project_sessions, str(p))}

    # ── VS Code in the browser (code serve-web on localhost, proxied) ──
    @app.get("/api/code/status")
    async def api_code_status():
        return {"available": bool(code and code.available()), "url": BASE_CODE + "/"}

    @app.api_route("/code", methods=["GET", "HEAD"])
    @app.api_route("/code/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])
    async def code_proxy(request: Request, path: str = ""):
        if not code:
            return err("VS Code is not set up", 404)
        folder = request.query_params.get("folder")
        if folder and not allow_browse_outside_home and not inside_home(folder):   # the address bar is not a way around the home-folder rule
            return error_page(request, 403) if wants_page(request) else err("VS Code opens folders inside your home directory only", 403)
        return await code.http(request)

    @app.websocket("/code/{path:path}")
    async def code_ws(ws: WebSocket, path: str = ""):
        origin = ws.headers.get("origin")
        if not code or (tunnel_only and not loopback_only(ws.client.host if ws.client else "?", ws.headers.get("host", ""))) \
                or (allowed_hosts and host_name(ws.headers.get("host", "")) not in allowed_hosts) \
                or (origin and urlsplit(origin).netloc.lower() != (ws.headers.get("host") or "").lower()) \
                or not auth.check(ws.cookies.get(COOKIE)):
            await ws.close(code=4403)
            return
        await code.ws(ws)

    @app.get("/api/browse")
    async def api_browse(path: str = "~"):
        """Directory listing for the new-workspace dialog: directories only, inside the home folder."""
        home = Path.home().resolve()
        p = Path(os.path.expanduser(path)).resolve()
        if not allow_browse_outside_home and p != home and home not in p.parents:
            return err("browsing is limited to your home folder", 403)
        if not p.is_dir():
            return err("not a directory", 404)
        try:
            dirs = sorted([d.name for d in p.iterdir() if d.is_dir() and not d.name.startswith(".")], key=str.lower)
        except PermissionError:
            return err("permission denied", 403)
        return {"path": str(p), "parent": str(p.parent) if p != home or allow_browse_outside_home else str(p), "dirs": dirs, "git": (p / ".git").exists()}

    # ── websocket ──
    @app.websocket("/ws")
    async def websocket(ws: WebSocket):
        await ws.accept()
        if tunnel_only and not loopback_only(ws.client.host if ws.client else "?", ws.headers.get("host", "")):
            await ws.close(code=4403)
            return
        if allowed_hosts and host_name(ws.headers.get("host", "")) not in allowed_hosts:
            await ws.close(code=4403)
            return
        origin = ws.headers.get("origin")
        if origin and urlsplit(origin).netloc.lower() != (ws.headers.get("host") or "").lower():
            await ws.close(code=4403)
            return
        if not auth.check(ws.cookies.get(COOKIE)):
            await ws.close(code=4401)
            return
        hub = hubs.get(ws.query_params.get("session"))
        if not hub:
            await ws.send_text(json.dumps({"type": "state", "state": {"connected": False, "workspaces": [], "panes": []}, "events": [], "sessions": []}))
            await ws.close(code=4503)
            return
        hub.attach(ws)
        attached = {}   # pane id "t:<id>" -> Attachment, for this browser connection
        chat_task = None   # a lounge chat is generated in the background: it can take a minute (claude -p) and must never hold up keystrokes
        cid = secrets.token_hex(4)   # unique per connection: object ids get reused and must not key the streams
        await hub._send(ws, {"type": "hello", "sessions": hubs.names(), "session": hub.name, "prefs": store.get_pref("prefs", {}) or {}, "username": auth.username, "home": str(Path.home()),
                                  "terminals": bool(hub.terms and hub.terms.available), "code": bool(code and code.available())})
        await hub._send(ws, {"type": "state", "state": hub.state, "events": []})
        try:
            while True:
                raw = await ws.receive_text()
                if len(raw) > MAX_BODY:
                    continue
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if not isinstance(msg, dict):
                    continue
                kind = msg.get("type")
                if _env("AGENT_MASTER_STREAM_DEBUG"):
                    log.info("ws message %s %s (client %s)", kind, (msg.get("pane_id") or ""), cid)
                try:
                    if kind == "input":             # text from the prompt box or the quick keys, typed into a terminal
                        att = attached.get(str(msg.get("pane_id", "")))
                        if att:   # through this browser's own attachment, so it counts as this screen using the terminal (the size follows)
                            att.input(str(msg.get("text", ""))[:20000])
                        else:
                            await hub.action("send", {"pane_id": msg["pane_id"], "text": str(msg.get("text", ""))[:20000], "log": bool(msg.get("log"))})
                    elif kind in ("agent_prompt", "agent_answer", "agent_interrupt", "agent_stop", "agent_seen", "agent_archive", "agent_mode"):
                        if hub.agents:
                            act = {"agent_prompt": "prompt", "agent_answer": "answer", "agent_interrupt": "interrupt", "agent_stop": "stop", "agent_seen": "seen", "agent_archive": "archive", "agent_mode": "set_mode"}[kind]
                            res = await hub.agents.action(act, {"agent_id": msg.get("agent_id"), "text": str(msg.get("text", ""))[:20000], "request_id": msg.get("request_id"),
                                                                 "allow": msg.get("allow"), "message": str(msg.get("message") or "")[:500], "remember": msg.get("remember"), "mode": msg.get("mode")})
                            await hub._send(ws, {"type": "action_result", "action": kind, "rid": msg.get("rid"), **res})
                    elif kind == "diag":              # page-side state, logged when stream debugging is on
                        if _env("AGENT_MASTER_STREAM_DEBUG"):
                            log.info("page diag %s", json.dumps(msg.get("d"))[:600])
                    elif kind == "popen":             # attach a browser terminal to a terminal run by agent-masterd
                        pid = str(msg.get("pane_id", ""))
                        old = attached.pop(pid, None)
                        if old:
                            old.close()
                        head = pid.encode()
                        head = bytes([len(head)]) + head

                        async def out(data, head=head):
                            await ws.send_bytes(head + data)

                        async def gone(reason, pid=pid):
                            a = attached.get(pid)
                            if a is not None and a.task is asyncio.current_task():   # only forget the attachment that actually ended
                                attached.pop(pid, None)
                            log.info("terminal attachment %s ended for %s: %s", pid, cid, reason)
                            await hub._send(ws, {"type": "pclosed", "p": pid, "reason": reason})
                        try:
                            attached[pid] = await terms_of(hub).attach(pid[2:], int(msg.get("cols") or 100), int(msg.get("rows") or 30), out, gone, scalable=msg.get("scalable", True) is not False)
                        except TermError as exc:
                            await hub._send(ws, {"type": "pclosed", "p": pid, "reason": str(exc)})
                    elif kind == "pin":               # keystrokes
                        att = attached.get(str(msg.get("pane_id", "")))
                        if att:
                            att.input(str(msg.get("d", ""))[:100000])
                    elif kind == "presize":
                        att = attached.get(str(msg.get("pane_id", "")))
                        if att:
                            att.resize(int(msg.get("cols") or 80), int(msg.get("rows") or 24))
                    elif kind == "pclose":
                        att = attached.pop(str(msg.get("pane_id", "")), None)
                        if att:
                            att.close()
                    elif kind == "action":
                        res = await hub.action(msg.get("action"), msg)
                        await hub._send(ws, {"type": "action_result", "action": msg.get("action"), "rid": msg.get("rid"), **res})
                    elif kind == "refresh":
                        hub.request_refresh()
                    elif kind == "chat":
                        if chat_task is None or chat_task.done():
                            async def make_chat(m=msg):
                                try:
                                    lines, source = await hub.chat(str(m.get("a", ""))[:64], str(m.get("b", ""))[:64], m.get("activities"))
                                except Exception as exc:
                                    log.warning("lounge chat failed: %s", exc)
                                    lines, source = None, "off"
                                await hub._send(ws, {"type": "chat_lines", "a": m.get("a"), "b": m.get("b"), "lines": lines, "source": source})
                            chat_task = asyncio.create_task(make_chat())
                        else:   # one at a time per browser: answer "no lines" so the office falls back to built-in ones
                            await hub._send(ws, {"type": "chat_lines", "a": msg.get("a"), "b": msg.get("b"), "lines": None, "source": "busy"})
                except TermError as exc:
                    await hub._send(ws, {"type": "error", "message": str(exc), "rid": msg.get("rid")})
                except (KeyError, TypeError, OSError, asyncio.TimeoutError) as exc:
                    await hub._send(ws, {"type": "error", "message": str(exc) or "request failed", "rid": msg.get("rid")})
        except (WebSocketDisconnect, RuntimeError):   # RuntimeError: the socket closed while we were about to receive
            pass
        finally:
            hub.drop(ws)
            if chat_task and not chat_task.done():
                chat_task.cancel()
            for att in attached.values():
                att.close()
            if _env("AGENT_MASTER_STREAM_DEBUG"):
                log.info("ws closed (client %s)", cid)

    return app


def ensure_tls(config_dir: Path, host_ip=None, names=()):
    cert, key = config_dir / "cert.pem", config_dir / "key.pem"
    if cert.exists() and key.exists():
        return str(cert), str(key)
    san = "DNS:localhost,IP:127.0.0.1" + (f",IP:{host_ip}" if host_ip else "") + "".join(f",DNS:{n}" for n in names)
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650", "-subj", "/CN=agent-master",
                    "-addext", f"subjectAltName={san}", "-keyout", str(key), "-out", str(cert)], check=True, capture_output=True)
    os.chmod(key, 0o600)
    log.info("generated self-signed certificate at %s (browsers will warn once; accept it)", cert)
    return str(cert), str(key)


def lan_ip():
    try:
        out = subprocess.run(["ip", "-4", "-o", "addr", "show", "scope", "global"], capture_output=True, text=True, timeout=2).stdout
        for line in out.splitlines():
            parts = line.split()
            if len(parts) > 3 and not parts[1].startswith(("docker", "br-", "veth")):
                return parts[3].split("/")[0]
    except OSError:
        pass
    return None


def _env(*names, default=None):
    for n in names:
        if os.environ.get(n) is not None:
            return os.environ[n]
    return default


def _default_config():
    explicit = _env("AGENT_MASTER_CONFIG")
    if explicit:
        return explicit
    return str(Path("~/.config/agent-master/config.json").expanduser())


def main():
    parser = argparse.ArgumentParser(description="Agent-Master")
    parser.add_argument("--host", default=_env("AGENT_MASTER_HOST", default="127.0.0.1"),
                        help="bind address; default localhost for SSH-tunnel access, 0.0.0.0 (IPv4) or :: (IPv4 and IPv6 together) exposes it to the network")
    parser.add_argument("--port", type=int, default=int(_env("AGENT_MASTER_PORT", default="3000")))
    parser.add_argument("--config", default=_default_config())
    parser.add_argument("--no-auth", action="store_true", help="disable the sign-in (trusted network only)")
    parser.add_argument("--reset-password", action="store_true", help="forget the account so the next visitor creates a new one")
    parser.add_argument("--tls", action="store_true", help="serve HTTPS (self-signed certificate generated on first use unless --cert/--key are given)")
    parser.add_argument("--cert", help="certificate chain (PEM) to serve, e.g. from mkcert or Let's Encrypt")
    parser.add_argument("--key", help="private key (PEM) for --cert")
    parser.add_argument("--tls-name", action="append", default=[], help="extra DNS name for the generated certificate (repeatable), e.g. myhost.local")
    parser.add_argument("--behind-proxy", action="store_true", help="trust X-Forwarded-* from a reverse proxy on this machine")
    parser.add_argument("--browse-anywhere", action="store_true", help="let the new-workspace dialog browse outside the home folder")
    parser.add_argument("--verbose", action="store_true", help="log every request and TLS handshake problem")
    parser.add_argument("--tunnel-only", action="store_true", help="SSH-tunnel mode: bind 127.0.0.1 no matter what and refuse anything not addressed to localhost")
    parser.add_argument("--allowed-host", action="append", default=[], metavar="NAME", help="only answer requests addressed to this hostname (repeatable); the IP form is refused")
    args = parser.parse_args()
    if args.tunnel_only:
        if args.host not in ("127.0.0.1", "localhost", "::1"):
            log.warning("--tunnel-only ignores --host %s: binding to 127.0.0.1", args.host)
        args.host = "127.0.0.1"
        args.behind_proxy = False
        log.info("tunnel-only mode: reach the UI with  ssh -N -L %s:127.0.0.1:%s user@this-machine  and open http://127.0.0.1:%s/", args.port, args.port, args.port)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)   # one line per proxied VS Code request otherwise, token included

    auth = Auth(args.config, enabled=not args.no_auth)
    if args.reset_password:
        for key in ("hash", "salt", "username"):
            auth.data.pop(key, None)
        auth.revoke_all()
        log.info("account cleared; the next visitor will be asked to create a username and password")
    auth.data.pop("hook_token", None)   # from the removed herdr hook route
    auth.set("hook_port", args.port)
    if not auth.enabled:
        log.warning("authentication disabled")
    elif not auth.configured:
        auth.set("setup_token", secrets.token_hex(12))
        log.info("no account yet: the first visitor to port %s creates one with this setup token: %s", args.port, auth.get("setup_token"))
    else:
        log.info("account: %s", auth.username or "(username chosen at next sign-in)")

    store = Store(auth.path.parent / "events.db")
    chatter = Chatter()
    chatter.configure((store.get_pref("prefs", {}) or {}).get("chatter") or {})
    log.info("lounge chatter backend: %s (model %s, every %ss)", chatter.backend(), chatter.settings["model"], chatter.settings["interval"])
    hubs = Hubs(store, chatter)
    ssl = {}
    if args.cert or args.key:
        if not (args.cert and args.key and os.path.exists(args.cert) and os.path.exists(args.key)):
            parser.error("--cert and --key must both be given and exist")
        args.tls = True
        ssl = {"ssl_certfile": args.cert, "ssl_keyfile": args.key}
        log.info("using certificate %s", args.cert)
    elif args.tls:
        cert, key = ensure_tls(auth.path.parent, lan_ip(), args.tls_name)
        ssl = {"ssl_certfile": cert, "ssl_keyfile": key}
    ip = lan_ip()
    scheme = "https" if args.tls else "http"
    if args.host in ("0.0.0.0", "::"):
        log.warning("bound to every interface: reachable by anything on the network. Keep it on the home LAN only (see README, Ways to reach the UI).")
    if args.allowed_host:
        log.info("answering only for %s; requests by IP address are refused", ", ".join(args.allowed_host))
        for name in args.allowed_host:
            log.info("serving %s://%s:%s/", scheme, name, args.port)
    else:
        log.info("serving %s://%s:%s/", scheme, ip if args.host in ("0.0.0.0", "::") else args.host, args.port)
    code = CodeServer(auth.path.parent / "code-token")   # VS Code in the browser: `code serve-web` behind /code/, see README
    log.info("VS Code in the browser: %s", "running behind /code/" if code.available() else "not running (systemctl --user start agent-master-code)")
    listen = {"host": args.host, "port": args.port}
    if args.host in ("::", "*", "dual"):   # one socket for IPv6 and IPv4: a name advertised over mDNS resolves to both families
        import socket as _socket
        sock = _socket.socket(_socket.AF_INET6, _socket.SOCK_STREAM)
        sock.setsockopt(_socket.SOL_SOCKET, _socket.SO_REUSEADDR, 1)
        sock.setsockopt(_socket.IPPROTO_IPV6, _socket.IPV6_V6ONLY, 0)
        sock.bind(("::", args.port))
        sock.listen(2048)
        listen = {"fd": sock.fileno()}
    uvicorn.run(build_app(hubs, auth, store, code=code, tls=args.tls, behind_proxy=args.behind_proxy, allow_browse_outside_home=args.browse_anywhere, tunnel_only=args.tunnel_only, allowed_hosts=args.allowed_host),
                **listen, log_level="info" if args.verbose else "warning", access_log=args.verbose, proxy_headers=args.behind_proxy,
                forwarded_allow_ips="127.0.0.1" if args.behind_proxy else None, server_header=False, date_header=False, **ssl)


if __name__ == "__main__":
    main()
