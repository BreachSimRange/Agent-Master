"""SQLite event log + preferences (costumes, seating, prompt templates)."""

import json
import os
import sqlite3
import threading
import time
from pathlib import Path

STATUSES = ("working", "blocked", "done", "idle", "unknown", "none")


class Store:
    def __init__(self, path):
        self.path = Path(path).expanduser()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(self.path.parent, 0o700)
        self.lock = threading.Lock()
        self.db = sqlite3.connect(str(self.path), check_same_thread=False)
        for suffix in ("", "-wal", "-shm"):
            p = Path(str(self.path) + suffix)
            if p.exists():
                os.chmod(p, 0o600)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, ts REAL, session TEXT, kind TEXT, "
            "workspace_id TEXT, label TEXT, from_status TEXT, to_status TEXT, detail TEXT)"
        )
        self.db.execute("CREATE INDEX IF NOT EXISTS events_ts ON events(ts)")
        self.db.execute("CREATE TABLE IF NOT EXISTS prefs (key TEXT PRIMARY KEY, value TEXT)")
        # headless agents (run by the UI itself) and their conversation events
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, session TEXT, label TEXT, cwd TEXT, model TEXT, "
            "claude_session_id TEXT, created REAL, status TEXT, status_since REAL, task TEXT, archived INTEGER DEFAULT 0, "
            "tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, cost REAL DEFAULT 0, permission_mode TEXT, number INTEGER)"
        )
        self.db.execute("CREATE TABLE IF NOT EXISTS agent_events (id INTEGER PRIMARY KEY, agent_id TEXT, ts REAL, kind TEXT, data TEXT)")
        self.db.execute("CREATE INDEX IF NOT EXISTS agent_events_agent ON agent_events(agent_id, id)")
        self.db.execute("CREATE TABLE IF NOT EXISTS agent_history (agent_id TEXT, seq INTEGER, ts REAL, role TEXT, text TEXT, PRIMARY KEY (agent_id, seq))")
        self.db.commit()

    # ── events ──
    def log(self, session, kind, workspace_id=None, label=None, from_status=None, to_status=None, detail=None, ts=None):
        row = (ts or time.time(), session, kind, workspace_id, label, from_status, to_status,
               json.dumps(detail) if isinstance(detail, (dict, list)) else detail)
        with self.lock:
            self.db.execute("INSERT INTO events (ts, session, kind, workspace_id, label, from_status, to_status, detail) VALUES (?,?,?,?,?,?,?,?)", row)
            self.db.commit()

    def events(self, session=None, workspace=None, kind=None, since=None, limit=300):
        sql, args = "SELECT id, ts, session, kind, workspace_id, label, from_status, to_status, detail FROM events WHERE 1=1", []
        if session:
            sql += " AND session=?"; args.append(session)
        if workspace:
            sql += " AND (workspace_id=? OR label=?)"; args += [workspace, workspace]
        if kind:
            sql += " AND kind=?"; args.append(kind)
        if since:
            sql += " AND ts>=?"; args.append(float(since))
        sql += " ORDER BY ts DESC LIMIT ?"; args.append(int(limit))
        with self.lock:
            rows = self.db.execute(sql, args).fetchall()
        keys = ("id", "ts", "session", "kind", "workspace_id", "label", "from", "to", "detail")
        out = []
        for r in rows:
            d = dict(zip(keys, r))
            if d["detail"] and d["detail"].startswith(("{", "[")):
                try:
                    d["detail"] = json.loads(d["detail"])
                except json.JSONDecodeError:
                    pass
            out.append(d)
        return out

    def last_status(self, session):
        """Latest recorded status per workspace: {workspace_id: (status, ts)}, to seed status times after a restart."""
        with self.lock:
            rows = self.db.execute(
                "SELECT workspace_id, to_status, MAX(ts) FROM events WHERE session=? AND kind='status' GROUP BY workspace_id", (session,)).fetchall()
        return {wid: (st, float(ts)) for wid, st, ts in rows if wid}

    def summary(self, session, since, current):
        """Seconds spent per status per workspace since `since`, from the status events, closed with the current statuses."""
        now = time.time()
        with self.lock:
            rows = self.db.execute(
                "SELECT ts, workspace_id, label, from_status, to_status FROM events WHERE session=? AND kind='status' AND ts>=? ORDER BY ts",
                (session, float(since)),
            ).fetchall()
        per = {}
        last = {}   # workspace_id -> (status, ts)
        for ts, wid, label, frm, to in rows:
            entry = per.setdefault(wid, {"label": label, "seconds": {s: 0.0 for s in STATUSES}, "blocked_count": 0, "done_count": 0, "tasks": 0})
            entry["label"] = label
            prev = last.get(wid)
            start_status, start_ts = prev if prev else (frm, float(since))
            if start_status in entry["seconds"]:
                entry["seconds"][start_status] += max(0.0, ts - start_ts)
            if to == "blocked":
                entry["blocked_count"] += 1
            if to == "done":
                entry["done_count"] += 1
            if to == "working" and frm != "blocked":
                entry["tasks"] += 1
            last[wid] = (to, ts)
        for wid, (status, ts) in last.items():
            if status in per[wid]["seconds"]:
                per[wid]["seconds"][status] += max(0.0, now - ts)
        for wid, status, label, since_ts in current:
            if wid not in last:
                entry = per.setdefault(wid, {"label": label, "seconds": {s: 0.0 for s in STATUSES}, "blocked_count": 0, "done_count": 0, "tasks": 0})
                if status in entry["seconds"]:
                    entry["seconds"][status] += max(0.0, now - max(float(since), since_ts or float(since)))
        return per

    # ── prefs ──
    def get_pref(self, key, default=None):
        with self.lock:
            row = self.db.execute("SELECT value FROM prefs WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def set_pref(self, key, value):
        with self.lock:
            self.db.execute("INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, json.dumps(value)))
            self.db.commit()

    # ── headless agents ──
    AGENT_COLS = ("id", "session", "label", "cwd", "model", "claude_session_id", "created", "status", "status_since", "task",
                  "archived", "tokens_in", "tokens_out", "cost", "permission_mode", "number")

    def agents(self, session, include_archived=False):
        with self.lock:
            rows = self.db.execute(
                f"SELECT {', '.join(self.AGENT_COLS)} FROM agents WHERE session=?" + ("" if include_archived else " AND archived=0") + " ORDER BY number, created",
                (session,)).fetchall()
        return [dict(zip(self.AGENT_COLS, r)) for r in rows]

    def agent_save(self, row):
        cols = [c for c in self.AGENT_COLS if c in row]
        with self.lock:
            self.db.execute(
                f"INSERT INTO agents ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)}) "
                f"ON CONFLICT(id) DO UPDATE SET {', '.join(f'{c}=excluded.{c}' for c in cols if c != 'id')}",
                [row[c] for c in cols])
            self.db.commit()

    def agent_next_number(self, session):
        with self.lock:
            n = self.db.execute("SELECT COALESCE(MAX(number), 0) FROM agents WHERE session=?", (session,)).fetchone()[0]
        return int(n or 0) + 1

    def agent_event_add(self, agent_id, kind, data, ts=None):
        with self.lock:
            cur = self.db.execute("INSERT INTO agent_events (agent_id, ts, kind, data) VALUES (?,?,?,?)",
                                  (agent_id, ts or time.time(), kind, json.dumps(data)))
            self.db.commit()
            return cur.lastrowid

    def agent_events(self, agent_id, before=None, limit=200):
        with self.lock:
            if before:
                rows = self.db.execute("SELECT id, ts, kind, data FROM agent_events WHERE agent_id=? AND id<? ORDER BY id DESC LIMIT ?",
                                       (agent_id, int(before), int(limit))).fetchall()
            else:
                rows = self.db.execute("SELECT id, ts, kind, data FROM agent_events WHERE agent_id=? ORDER BY id DESC LIMIT ?",
                                       (agent_id, int(limit))).fetchall()
        out = [{"id": r[0], "ts": r[1], "kind": r[2], "data": json.loads(r[3])} for r in rows]
        out.reverse()
        return out

    def agent_event_count(self, agent_id):
        with self.lock:
            return self.db.execute("SELECT COUNT(*) FROM agent_events WHERE agent_id=?", (agent_id,)).fetchone()[0]

    def history_count(self, agent_id):
        with self.lock:
            return self.db.execute("SELECT COUNT(*) FROM agent_history WHERE agent_id=?", (agent_id,)).fetchone()[0]

    def import_history(self, agent_id, entries):
        """Replace the saved history of one agent with `entries` (oldest first: {ts, role, text})."""
        with self.lock:
            self.db.execute("DELETE FROM agent_history WHERE agent_id=?", (agent_id,))
            self.db.executemany("INSERT INTO agent_history (agent_id, seq, ts, role, text) VALUES (?,?,?,?,?)",
                                [(agent_id, i, e.get("ts"), e.get("role"), e.get("text")) for i, e in enumerate(entries)])
            self.db.commit()
        return len(entries)

    def history(self, agent_id, before_seq=None, limit=150):
        with self.lock:
            if before_seq is None:
                rows = self.db.execute("SELECT seq, ts, role, text FROM agent_history WHERE agent_id=? ORDER BY seq DESC LIMIT ?", (agent_id, int(limit))).fetchall()
            else:
                rows = self.db.execute("SELECT seq, ts, role, text FROM agent_history WHERE agent_id=? AND seq<? ORDER BY seq DESC LIMIT ?", (agent_id, int(before_seq), int(limit))).fetchall()
        out = [{"seq": r[0], "ts": r[1], "role": r[2], "text": r[3]} for r in rows]
        out.reverse()
        return out
