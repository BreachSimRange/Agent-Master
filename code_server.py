"""VS Code in the browser: `code serve-web` runs on localhost and is reached only through Agent-Master.

The web app proxies everything under /code/ to it, so VS Code sits behind the same sign-in, host rules and
TLS as the rest of the UI and is never exposed on its own. A connection token (a file in the config folder,
mode 600) is a second lock: the proxy adds it to every upstream request, so even a process on this machine
cannot use the editor without reading that file."""

import logging
import os
import secrets
import socket
import time
from pathlib import Path

import html
import json
import re

import httpx
import websockets
from fastapi import Request, WebSocket
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.background import BackgroundTask

log = logging.getLogger("agent-master.code")

HOST, PORT, BASE = "127.0.0.1", 8043, "/code"
HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "cookie"}
DROP_BACK = {"transfer-encoding", "connection", "keep-alive"}
# Settings the workbench starts with. VS Code for the Web keeps the user's own settings in the browser, so these are
# injected into the workbench page as configuration defaults: the dark theme, no chat or agent panel, no welcome page.
# The user can still change any of them in VS Code itself. A JSON object in <config dir>/code-defaults.json is merged on top.
DEFAULTS = {
    "workbench.colorTheme": "Default Dark Modern",
    "workbench.startupEditor": "none",
    "workbench.secondarySideBar.defaultVisibility": "hidden",
    "workbench.tips.enabled": False,
    "chat.commandCenter.enabled": False,
    "chat.agent.enabled": False,
    "chat.disableAIFeatures": True,
}
META = re.compile(r'(<meta id="vscode-workbench-web-configuration" data-settings=")([^"]*)(")')


class CodeServer:
    def __init__(self, token_file: Path):
        self.token_file = Path(token_file)
        self.token = self._ensure_token()
        self.client = httpx.AsyncClient(base_url=f"http://{HOST}:{PORT}", timeout=httpx.Timeout(None, connect=5.0),
                                        limits=httpx.Limits(max_connections=64, max_keepalive_connections=16))
        self._avail = (False, 0.0)
        self.defaults = dict(DEFAULTS)
        try:
            extra = json.loads((self.token_file.parent / "code-defaults.json").read_text())
            if isinstance(extra, dict):
                self.defaults.update(extra)
        except (OSError, ValueError):
            pass

    def _inject(self, page: bytes) -> bytes:
        """Add our configuration defaults to the workbench page's embedded configuration; the folder stays trusted."""
        text = page.decode("utf-8", "replace")
        def patch(m):
            try:
                cfg = json.loads(html.unescape(m.group(2)))
            except ValueError:
                return m.group(0)
            cfg["configurationDefaults"] = {**(cfg.get("configurationDefaults") or {}), **self.defaults}
            cfg["enableWorkspaceTrust"] = False   # the folders are this machine's own workspaces: no Restricted Mode banner
            return m.group(1) + html.escape(json.dumps(cfg), quote=True) + m.group(3)
        return META.sub(patch, text, count=1).encode("utf-8")

    def _ensure_token(self):
        try:
            tok = self.token_file.read_text().strip()
            if tok:
                return tok
        except OSError:
            pass
        tok = secrets.token_urlsafe(32)
        self.token_file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        tmp = self.token_file.with_suffix(".tmp")
        tmp.write_text(tok + "\n")
        os.chmod(tmp, 0o600)
        tmp.replace(self.token_file)
        log.info("connection token for VS Code written to %s", self.token_file)
        return tok

    def available(self):
        """Is the VS Code web server listening? Checked at most every 10 s."""
        ok, at = self._avail
        now = time.time()
        if now - at < 10:
            return ok
        try:
            with socket.create_connection((HOST, PORT), timeout=0.3):
                ok = True
        except OSError:
            ok = False
        self._avail = (ok, now)
        return ok

    def _cookie(self, headers):
        parts = [p.strip() for p in (headers.get("cookie") or "").split(";") if p.strip() and not p.strip().startswith("vscode-tkn=")]
        parts.append(f"vscode-tkn={self.token}")
        return "; ".join(parts)

    @staticmethod
    def _target(url):
        return url.path + ("?" + url.query if url.query else "")

    async def http(self, request: Request):
        if not self.available():
            return JSONResponse({"error": "VS Code is not running on this machine: systemctl --user start agent-master-code"}, status_code=503)
        headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP}
        headers["cookie"] = self._cookie(request.headers)
        # the browser's own Host goes through: VS Code builds the workbench's websocket address from it, so it must be the
        # public name (through this proxy), not the localhost port
        headers["host"] = request.headers.get("host", f"{HOST}:{PORT}")
        headers["x-forwarded-proto"] = request.url.scheme
        content = await request.body() if request.method in ("POST", "PUT", "PATCH") else None
        req = self.client.build_request(request.method, self._target(request.url), headers=headers, content=content)
        try:
            up = await self.client.send(req, stream=True)
        except httpx.HTTPError as exc:
            self._avail = (False, time.time())
            return JSONResponse({"error": f"VS Code is unreachable: {exc}"}, status_code=502)
        if up.headers.get("content-type", "").startswith("text/html") and request.url.path.rstrip("/") == BASE:   # the workbench page itself
            body = self._inject(await up.aread())
            await up.aclose()
            resp = Response(content=body, status_code=up.status_code)
            resp.raw_headers = [(k.lower().encode(), v.encode()) for k, v in up.headers.multi_items() if k.lower() not in DROP_BACK | {"content-length", "content-encoding"}]
            resp.raw_headers.append((b"content-length", str(len(body)).encode()))
            return resp
        resp = StreamingResponse(up.aiter_raw(), status_code=up.status_code, background=BackgroundTask(up.aclose))
        resp.raw_headers = [(k.lower().encode(), v.encode()) for k, v in up.headers.multi_items() if k.lower() not in DROP_BACK]
        return resp

    async def ws(self, ws: WebSocket):
        """Bridge one browser websocket to VS Code: text and binary frames both ways, the subprotocol carried over."""
        headers = {"Cookie": self._cookie(ws.headers), "Host": ws.headers.get("host", f"{HOST}:{PORT}")}
        for k in ("user-agent", "accept-language"):
            if ws.headers.get(k):
                headers[k] = ws.headers[k]
        protos = [p.strip() for p in (ws.headers.get("sec-websocket-protocol") or "").split(",") if p.strip()] or None
        try:
            up = await websockets.connect(f"ws://{HOST}:{PORT}{self._target(ws.url)}", additional_headers=headers, subprotocols=protos,
                                          max_size=None, ping_interval=None, open_timeout=10)
        except Exception as exc:
            log.warning("VS Code websocket failed: %s", exc)
            await ws.close(code=1011)
            return
        await ws.accept(subprotocol=up.subprotocol)

        async def to_code():
            while True:
                msg = await ws.receive()
                if msg["type"] == "websocket.disconnect":
                    return
                if msg.get("bytes") is not None:
                    await up.send(msg["bytes"])
                elif msg.get("text") is not None:
                    await up.send(msg["text"])

        async def to_browser():
            async for m in up:
                if isinstance(m, (bytes, bytearray)):
                    await ws.send_bytes(bytes(m))
                else:
                    await ws.send_text(m)

        import asyncio
        tasks = [asyncio.create_task(to_code()), asyncio.create_task(to_browser())]
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for t in tasks:
                t.cancel()
            try:
                await up.close()
            except Exception:
                pass
            try:
                await ws.close()
            except Exception:
                pass
