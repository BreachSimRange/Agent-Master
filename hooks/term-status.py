#!/usr/bin/env python3
# Claude Code hook and status line for terminals run by agent-masterd.
#   term-status.py <HookEvent>   report session and status events (working, blocked, done, session id)
#   term-status.py StatusLine    forward Claude Code's status snapshot (model, version, cost, context, limits)
#                                and print the stats line Claude Code shows under its input box
# Fire-and-forget: never blocks Claude for long, never fails.
import json
import os
import socket
import sys

event = sys.argv[1] if len(sys.argv) > 1 else ""
tid, path = os.environ.get("AGENT_MASTER_TERM"), os.environ.get("AGENT_MASTER_SOCK")
try:
    data = json.load(sys.stdin)
except Exception:
    data = {}


def send(msg, wait):
    if not tid or not path:
        return
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(0.5)
        s.connect(path)
        s.sendall((json.dumps(msg) + "\n").encode())
        if wait:
            s.recv(256)
        s.close()
    except Exception:
        pass


def installed_version():
    try:
        exe = os.path.realpath(os.path.expanduser("~/.local/bin/claude"))
        name = os.path.basename(exe)
        return name if name[:1].isdigit() else None
    except Exception:
        return None


def newer(a, b):
    try:
        return tuple(int(x) for x in a.split(".")) > tuple(int(x) for x in b.split("."))
    except Exception:
        return False


if event == "StatusLine":
    keep = ("session_id", "session_name", "model", "version", "cost", "context_window", "exceeds_200k_tokens", "prompt_cache",
            "fast_mode", "thinking", "rate_limits", "output_style")
    stats = {k: data[k] for k in keep if k in data}
    if isinstance(stats.get("prompt_cache"), dict):
        stats["prompt_cache"] = {k: stats["prompt_cache"].get(k) for k in ("warm", "ttl", "expires_at", "hit_ratio")}
    if isinstance(stats.get("context_window"), dict):
        cw = stats["context_window"]
        stats["context_window"] = {k: cw.get(k) for k in ("used_percentage", "context_window_size", "total_input_tokens", "total_output_tokens")}
    send({"op": "stats", "id": tid, "data": stats}, wait=False)
    # the line under Claude Code's input box
    DIM, ORANGE, R = "\x1b[2m", "\x1b[38;5;215m", "\x1b[0m"
    parts = []
    model = (data.get("model") or {}).get("display_name")
    if model:
        parts.append(model)
    pct = (data.get("context_window") or {}).get("used_percentage")
    if pct is not None:
        parts.append(f"context {pct}%")
    cost = (data.get("cost") or {}).get("total_cost_usd")
    if cost:
        parts.append(f"${cost:.2f}")
    c = data.get("cost") or {}
    if c.get("total_lines_added") or c.get("total_lines_removed"):
        parts.append(f"+{c.get('total_lines_added') or 0} -{c.get('total_lines_removed') or 0}")
    rl = data.get("rate_limits") or {}
    limits = [f"{k} {rl[key]['used_percentage']}%" for key, k in (("five_hour", "5h"), ("seven_day", "7d"))
              if isinstance(rl.get(key), dict) and rl[key].get("used_percentage") is not None]
    if limits:
        parts.append("limits " + " ".join(limits))
    line = DIM + " · ".join(parts) + R
    inst, run = installed_version(), data.get("version")
    if inst and run and newer(inst, run):
        line += f"  {ORANGE}update {inst} installed · restart to use it{R}"
    print(line)
    sys.exit(0)

keep = ("hook_event_name", "session_id", "prompt", "tool_name", "tool_input", "notification_type", "message", "source", "reason", "cwd")
data = {k: data[k] for k in keep if k in data}
if isinstance(data.get("tool_input"), dict):   # only what the office needs (file paths, the command), never file contents
    data["tool_input"] = {k: v for k, v in data["tool_input"].items() if k in ("file_path", "path", "notebook_path", "directory", "command", "pattern") and isinstance(v, str) and len(v) < 2000}
send({"op": "hook", "id": tid, "event": event or data.get("hook_event_name"), "data": data}, wait=True)
sys.exit(0)
