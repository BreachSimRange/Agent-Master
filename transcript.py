"""Read an agent's own conversation transcript (Claude Code JSONL) for the history view."""

import json
import re
from pathlib import Path

SAFE_ID = re.compile(r"^[A-Za-z0-9._-]{4,80}$")
MAX_BYTES = 64 * 1024 * 1024


def find_transcript(session_id):
    if not session_id or not SAFE_ID.match(session_id):
        return None
    root = Path.home() / ".claude" / "projects"
    if not root.is_dir():
        return None
    hits = sorted(root.glob(f"*/{session_id}.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
    return hits[0] if hits else None


def _block_text(block, full=False):
    kind = block.get("type")
    if kind == "text":
        return ("assistant", block.get("text", ""))
    if kind == "tool_use":
        inp = block.get("input") or {}
        arg = inp.get("file_path") or inp.get("path") or inp.get("command") or inp.get("pattern") or inp.get("description") or ""
        if isinstance(arg, str) and len(arg) > 160:
            arg = arg[:157] + "..."
        return ("tool", f"{block.get('name', 'tool')}({arg})")
    if kind == "tool_result":
        content = block.get("content")
        if isinstance(content, list):
            content = "\n".join(c.get("text", "") for c in content if isinstance(c, dict))
        text = str(content or "")
        lines = text.splitlines()
        keep = 30 if full else 6
        if len(lines) > keep:
            text = "\n".join(lines[:keep]) + f"\n... ({len(lines) - keep} more lines)"
        return ("result", text[:6000 if full else 1200])
    return None


def _epoch(ts):
    """Claude Code writes ISO timestamps; seconds since the epoch, or None."""
    try:
        from datetime import datetime
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return None


def read_transcript(path, limit=400, offset=0, full=False, until=None):
    """Entries as [{ts, role, text}], oldest first: the last `limit` ones, skipping the newest `offset`.

    `until` (epoch seconds) keeps only entries older than that moment: what a terminal's replay buffer no longer holds."""
    text_cap = 40000 if full else 6000
    entries = []
    size = path.stat().st_size
    with open(path, "rb") as fh:
        if size > MAX_BYTES:
            fh.seek(size - MAX_BYTES)
            fh.readline()
        for raw in fh:
            try:
                d = json.loads(raw)
            except json.JSONDecodeError:
                continue
            kind = d.get("type")
            if kind not in ("user", "assistant"):
                continue
            msg = d.get("message") or {}
            content = msg.get("content")
            ts = d.get("timestamp")
            if kind == "user":
                if isinstance(content, str):
                    if content.strip():
                        entries.append({"ts": ts, "role": "user", "text": content.strip()[:4000]})
                elif isinstance(content, list):
                    for block in content:
                        if not isinstance(block, dict):
                            continue
                        if block.get("type") == "text" and block.get("text", "").strip():
                            entries.append({"ts": ts, "role": "user", "text": block["text"].strip()[:4000]})
                        elif block.get("type") == "tool_result":
                            got = _block_text(block, full)
                            if got and got[1].strip():
                                entries.append({"ts": ts, "role": got[0], "text": got[1]})
            else:
                if isinstance(content, list):
                    for block in content:
                        if not isinstance(block, dict):
                            continue
                        got = _block_text(block, full)
                        if got and got[1].strip():
                            entries.append({"ts": ts, "role": got[0], "text": got[1][:text_cap]})
                elif isinstance(content, str) and content.strip():
                    entries.append({"ts": ts, "role": "assistant", "text": content.strip()[:text_cap]})
    if until:
        entries = [e for e in entries if (_epoch(e.get("ts")) or 0) < until]
    total = len(entries)
    end = total - max(0, offset)
    return entries[max(0, end - limit):end], total


_SUMMARY_CACHE = {}


def summary(path):
    """What the session file says about the agent: model, Claude Code version, effort, turns, tool calls, tokens, timestamps.

    Cached by (path, size, mtime) so the card can be opened freely."""
    try:
        st = path.stat()
    except OSError:
        return None
    key = (str(path), st.st_size, int(st.st_mtime))
    hit = _SUMMARY_CACHE.get(key)
    if hit:
        return hit
    out = {"model": None, "models": [], "version": None, "effort": None, "first_ts": None, "last_ts": None,
           "prompts": 0, "replies": 0, "tool_calls": 0, "tokens": {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0, "thinking": 0}}
    models = {}
    with open(path, "rb") as fh:
        size = st.st_size
        if size > MAX_BYTES:
            fh.seek(size - MAX_BYTES)
            fh.readline()
        for raw in fh:
            try:
                d = json.loads(raw)
            except json.JSONDecodeError:
                continue
            kind = d.get("type")
            if kind not in ("user", "assistant"):
                continue
            ts = d.get("timestamp")
            if ts:
                out["first_ts"] = out["first_ts"] or ts
                out["last_ts"] = ts
            if d.get("version"):
                out["version"] = d["version"]
            msg = d.get("message") or {}
            content = msg.get("content")
            if kind == "user":
                if isinstance(content, str) and content.strip():
                    out["prompts"] += 1
                elif isinstance(content, list) and any(isinstance(b, dict) and b.get("type") == "text" and b.get("text", "").strip() for b in content):
                    out["prompts"] += 1
                continue
            out["replies"] += 1
            if msg.get("model") and not str(msg["model"]).startswith("<"):   # '<synthetic>' marks internal messages, not a model
                out["model"] = msg["model"]
                models[msg["model"]] = models.get(msg["model"], 0) + 1
            if d.get("effort"):
                out["effort"] = d["effort"]
            if isinstance(content, list):
                out["tool_calls"] += sum(1 for b in content if isinstance(b, dict) and b.get("type") == "tool_use")
            u = msg.get("usage") or {}
            t = out["tokens"]
            t["input"] += int(u.get("input_tokens") or 0)
            t["output"] += int(u.get("output_tokens") or 0)
            t["cache_read"] += int(u.get("cache_read_input_tokens") or 0)
            t["cache_write"] += int(u.get("cache_creation_input_tokens") or 0)
            t["thinking"] += int((u.get("output_tokens_details") or {}).get("thinking_tokens") or 0)
    out["models"] = sorted(models, key=lambda m: -models[m])
    if len(_SUMMARY_CACHE) > 64:
        _SUMMARY_CACHE.clear()
    _SUMMARY_CACHE[key] = out
    return out


def all_entries(path, cap=200000):
    """Every user/assistant entry of a session file, oldest first, as {ts, role, text}. For importing history."""
    out = []
    with open(path, "rb") as fh:
        for raw in fh:
            if len(out) >= cap:
                break
            try:
                d = json.loads(raw)
            except json.JSONDecodeError:
                continue
            kind = d.get("type")
            if kind not in ("user", "assistant"):
                continue
            msg = d.get("message") or {}
            content = msg.get("content")
            ts = d.get("timestamp")
            if kind == "user":
                if isinstance(content, str):
                    if content.strip():
                        out.append({"ts": ts, "role": "user", "text": content.strip()[:8000]})
                elif isinstance(content, list):
                    for b in content:
                        if not isinstance(b, dict):
                            continue
                        if b.get("type") == "text" and b.get("text", "").strip():
                            out.append({"ts": ts, "role": "user", "text": b["text"].strip()[:8000]})
                        elif b.get("type") == "tool_result":
                            got = _block_text(b, full=True)
                            if got and got[1].strip():
                                out.append({"ts": ts, "role": got[0], "text": got[1]})
            else:
                if isinstance(content, list):
                    for b in content:
                        got = _block_text(b, full=True)
                        if got and got[1].strip():
                            out.append({"ts": ts, "role": got[0], "text": got[1]})
    return out


def project_dir(cwd):
    """Claude Code's transcript folder for a working directory: every character that is not a letter or digit becomes '-'."""
    return Path.home() / ".claude" / "projects" / re.sub(r"[^A-Za-z0-9]", "-", str(cwd))


def project_sessions(cwd, limit=12):
    """The Claude Code sessions recorded for a folder, newest first: [{id, mtime, size, first_prompt}], skipping empty files."""
    root = project_dir(cwd)
    if not root.is_dir():
        return []
    out = []
    for f in sorted(root.glob("*.jsonl"), key=lambda x: x.stat().st_mtime, reverse=True):
        if not SAFE_ID.match(f.stem) or f.stat().st_size < 200:
            continue
        first = None
        try:
            with open(f, "rb") as fh:
                for raw in fh:
                    if fh.tell() > 512 * 1024:
                        break
                    try:
                        d = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    if d.get("type") != "user":
                        continue
                    c = (d.get("message") or {}).get("content")
                    t = c if isinstance(c, str) else " ".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text") if isinstance(c, list) else ""
                    t = " ".join(t.split())
                    if t and not t.startswith("<"):   # skip hook and system payloads
                        first = t[:120]
                        break
        except OSError:
            continue
        out.append({"id": f.stem, "mtime": f.stat().st_mtime, "size": f.stat().st_size, "first_prompt": first})
        if len(out) >= limit:
            break
    return out


def latest_session(cwd, exclude=()):
    """The newest session of a folder that is not in `exclude` (ids already running elsewhere), or None."""
    for s in project_sessions(cwd, limit=20):
        if s["id"] not in exclude:
            return s["id"]
    return None
