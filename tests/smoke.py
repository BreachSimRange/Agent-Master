#!/usr/bin/env python3
"""Smoke test: a throwaway terminal server and web app on private ports and a private config folder.

Checks that nothing answers without a session, that the setup token is required, that an account can be
created and used, that a terminal can be opened, typed into and read back, and that the transcript and
VS Code routes answer as documented. Needs only the project's own dependencies.

    python3 tests/smoke.py            # ~20 s; exits 1 on the first failure
"""

import asyncio
import http.client
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = int(os.environ.get("SMOKE_PORT", "3079"))
failures = []


def check(name, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + name + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        failures.append(name)


def http_req(method, path, body=None, headers=None):
    c = http.client.HTTPConnection("127.0.0.1", PORT, timeout=15)
    h = {"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{PORT}", **(headers or {})}
    c.request(method, path, body=json.dumps(body).encode() if body is not None else None, headers=h)
    r = c.getresponse()
    data = r.read()
    c.close()
    return r.status, r.getheader("location"), r.getheader("set-cookie"), data


def ptyd_op(sock, **kw):
    s = socket.socket(socket.AF_UNIX)
    s.connect(sock)
    s.sendall((json.dumps({"rid": 1, **kw}) + "\n").encode())
    b = b""
    while b"\n" not in b:
        b += s.recv(1 << 20)
    s.close()
    return json.loads(b.split(b"\n")[0])


def replay(sock, tid):
    s = socket.socket(socket.AF_UNIX)
    s.connect(sock)
    s.sendall((json.dumps({"op": "attach", "id": tid, "cols": 100, "rows": 30}) + "\n").encode())
    s.settimeout(1.0)
    b = b""
    try:
        while True:
            c = s.recv(1 << 20)
            if not c:
                break
            b += c
    except socket.timeout:
        pass
    s.close()
    return b


def main():
    work = Path(tempfile.mkdtemp(prefix="agent-master-smoke-"))
    sock = str(work / "ptyd.sock")
    env = {**os.environ, "AGENT_MASTER_PTYD_SOCK": sock}
    daemon = subprocess.Popen([sys.executable, str(ROOT / "ptyd.py"), "--config-dir", str(work), "--socket", sock], stdout=open(work / "ptyd.log", "w"), stderr=subprocess.STDOUT, env=env)
    app = subprocess.Popen([sys.executable, str(ROOT / "app.py"), "--port", str(PORT), "--config", str(work / "config.json"), "--host", "127.0.0.1"], stdout=open(work / "app.log", "w"), stderr=subprocess.STDOUT, env=env)
    try:
        for _ in range(60):
            time.sleep(0.5)
            try:
                if http_req("GET", "/api/auth/status")[0] == 200:
                    break
            except OSError:
                pass
        else:
            print("the web app did not come up; log:", (work / "app.log").read_text()[-800:])
            sys.exit(1)

        # ── nothing without a session ──
        st, loc, _, _ = http_req("GET", "/")
        check("page without session redirects to the login", st == 307 and loc == "/login", f"{st} {loc}")
        check("API without session is 401", http_req("GET", "/api/state")[0] == 401)
        check("POST without session is 401", http_req("POST", "/api/terms", {"kind": "shell", "cwd": "~"})[0] == 401)
        check("VS Code path without session redirects", http_req("GET", "/code/?folder=/tmp")[0] == 307)
        check("static assets are public", http_req("GET", "/static/app.js")[0] == 200)

        # ── the account ──
        status = json.loads(http_req("GET", "/api/auth/status")[3])
        check("first run: no account, token needed", status["configured"] is False and status["setup_needs_token"] is True)
        check("setup without the token is refused", http_req("POST", "/api/auth/setup", {"username": "me", "password": "correct-horse-battery"})[0] == 403)
        token = json.loads((work / "config.json").read_text()).get("setup_token")
        st, _, cookie, _ = http_req("POST", "/api/auth/setup", {"username": "me", "password": "correct-horse-battery", "setup_token": token})
        check("setup with the token creates the account", st == 200 and cookie and "HttpOnly" in cookie, f"{st} {cookie}")
        session = cookie.split(";")[0]
        auth = {"Cookie": session}
        check("wrong password is 401", http_req("POST", "/api/auth/login", {"username": "me", "password": "nope"})[0] == 401)
        check("cross-site login POST is blocked", http_req("POST", "/api/auth/login", {"username": "me", "password": "correct-horse-battery"}, {"Origin": "https://evil.example"})[0] == 403)
        st, _, _, body = http_req("GET", "/api/state", headers=auth)
        check("state with a session", st == 200 and json.loads(body)["terminals"] is True, f"{st} {body[:80]}")

        # ── a terminal round trip ──
        check("workspaces outside home are refused", http_req("POST", "/api/terms", {"kind": "shell", "cwd": str(work)}, auth)[0] == 403)
        st, _, _, body = http_req("POST", "/api/terms", {"kind": "shell", "cwd": "~"}, auth)
        term = json.loads(body)
        check("a shell workspace can be created", st == 200 and term.get("ok"), f"{st} {body[:120]}")
        if not term.get("ok"):
            raise SystemExit(1)
        tid = term["term"]["id"]
        check("a shell is named like an egg", " · " in term["term"]["label"], term["term"]["label"])
        time.sleep(1.5)
        st, _, _, body = http_req("POST", "/api/action", {"action": "send", "pane_id": "t:" + tid, "text": "echo SMOKE_$((40+2))\r"}, auth)
        time.sleep(1.5)
        out = replay(sock, tid)
        check("typed text reaches the shell and comes back", b"SMOKE_42" in out, out[-200:])
        st, _, _, body = http_req("GET", f"/api/transcript?pane_id=t:{tid}", headers=auth)
        check("transcript route answers for a shell", st == 200 and "note" in json.loads(body))
        check("browsing outside home is refused", http_req("GET", "/api/browse?path=/etc", headers=auth)[0] == 403)
        st, _, _, _ = http_req("POST", "/api/action", {"action": "close_workspace", "workspace_id": "t:" + tid}, auth)
        time.sleep(0.8)
        check("the workspace can be closed", st == 200 and not any(t["id"] == tid for t in ptyd_op(sock, op="list")["terms"]))

        # ── the websocket ──
        async def ws_probe():
            import websockets
            try:
                async with websockets.connect(f"ws://127.0.0.1:{PORT}/ws", open_timeout=8) as ws:
                    try:
                        await asyncio.wait_for(ws.recv(), 3)
                        return "open"
                    except Exception as exc:
                        return str(getattr(getattr(exc, "rcvd", None), "code", type(exc).__name__))
            except Exception as exc:
                return "refused " + type(exc).__name__
        check("websocket without a session is closed with 4401", asyncio.run(ws_probe()) == "4401")

        # ── sign out everywhere ──
        http_req("POST", "/api/auth/logout", {"everywhere": True}, auth)
        check("sessions are revoked by sign-out everywhere", http_req("GET", "/api/state", headers=auth)[0] == 401)
    finally:
        for p in (app, daemon):
            p.terminate()
        for p in (app, daemon):
            try:
                p.wait(timeout=8)
            except subprocess.TimeoutExpired:
                p.kill()
        shutil.rmtree(work, ignore_errors=True)
    print()
    print("all good" if not failures else f"{len(failures)} failed: {', '.join(failures)}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
