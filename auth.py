"""Password + signed-cookie sessions for the web UI. Config lives in a small JSON file (mode 600)."""

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path

SESSION_DAYS = 30
PBKDF2_ROUNDS = 200_000
MIN_PASSWORD = 10
LOCK_AFTER = 8          # failed attempts per client before a lockout
LOCK_SECONDS = 900      # 15 minutes
GLOBAL_LOCK_AFTER = 40  # failed attempts from everyone together in LOCK_SECONDS: sign-in pauses for all (many addresses cannot add up to a brute force)


class Auth:
    def __init__(self, path, enabled=True):
        self.path = Path(path).expanduser()
        self.enabled = enabled
        self.data = {}
        self.fails = {}     # client -> {"count": n, "ts": last_failure}
        self.global_fails = []   # timestamps of every failure, for the global budget
        self._load()

    def _load(self):
        if self.path.exists():
            self.data = json.loads(self.path.read_text())
        if "secret" not in self.data:
            self.data["secret"] = secrets.token_hex(32)
            self._save()

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, indent=2))
        os.chmod(tmp, 0o600)
        tmp.replace(self.path)
        try:
            os.chmod(self.path.parent, 0o700)
        except OSError:
            pass

    # small settings that share the config file (hook token, port)
    def get(self, key, default=None):
        return self.data.get(key, default)

    def set(self, key, value):
        if self.data.get(key) != value:
            self.data[key] = value
            self._save()

    @property
    def configured(self):
        return bool(self.data.get("hash"))

    @property
    def version(self):
        return int(self.data.get("version", 0))

    @property
    def username(self):
        return self.data.get("username", "")

    def _hash(self, password, salt):
        return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), PBKDF2_ROUNDS).hex()

    def set_credentials(self, username=None, password=None):
        if username is not None:
            self.data["username"] = username
        if password is not None:
            salt = secrets.token_hex(16)
            self.data.update(salt=salt, hash=self._hash(password, salt))
        self.data["version"] = self.version + 1
        self._save()

    def verify(self, username, password):
        if not self.configured:
            return False
        # an account created before usernames existed has none; the first sign-in adopts one
        user_ok = not self.username or hmac.compare_digest(username.strip().lower(), self.username.lower())
        pw_ok = hmac.compare_digest(self._hash(password, self.data["salt"]), self.data["hash"])
        return user_ok and pw_ok

    def revoke_all(self):
        self.data["version"] = self.version + 1
        self._save()

    # ── sessions ──
    def _sign(self, body):
        return hmac.new(bytes.fromhex(self.data["secret"]), body.encode(), hashlib.sha256).hexdigest()

    def issue(self):
        body = base64.urlsafe_b64encode(json.dumps({"v": self.version, "iat": int(time.time())}).encode()).decode().rstrip("=")
        return f"{body}.{self._sign(body)}"

    def check(self, token):
        if not self.enabled:
            return True
        if not token or "." not in token or len(token) > 512:
            return False
        body, sig = token.rsplit(".", 1)
        if not hmac.compare_digest(self._sign(body), sig):
            return False
        try:
            payload = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        except (ValueError, json.JSONDecodeError):
            return False
        if not isinstance(payload, dict) or not isinstance(payload.get("iat"), (int, float)):   # a signed token whose body is not ours is still not a session
            return False
        return payload.get("v") == self.version and time.time() - payload["iat"] < SESSION_DAYS * 86400

    # ── brute-force protection ──
    def locked_for(self, client):
        rec = self.fails.get(client)
        if not rec or rec["count"] < LOCK_AFTER:
            return 0
        left = LOCK_SECONDS - (time.time() - rec["ts"])
        if left <= 0:
            del self.fails[client]
            return 0
        return left

    def locked_global(self):
        cutoff = time.time() - LOCK_SECONDS
        self.global_fails = [t for t in self.global_fails if t > cutoff]
        if len(self.global_fails) < GLOBAL_LOCK_AFTER:
            return 0
        return LOCK_SECONDS - (time.time() - self.global_fails[0])

    def penalty(self, client):
        rec = self.fails.get(client)
        return min(5.0, 0.5 * rec["count"]) if rec else 0.0

    def record(self, client, ok):
        if ok:
            self.fails.pop(client, None)
        else:
            rec = self.fails.setdefault(client, {"count": 0, "ts": 0})
            rec["count"] += 1
            rec["ts"] = time.time()
            self.global_fails.append(rec["ts"])
        if len(self.fails) > 5000:   # never let the table grow without bound
            oldest = sorted(self.fails, key=lambda c: self.fails[c]["ts"])[:2500]
            for c in oldest:
                del self.fails[c]
