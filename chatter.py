"""Lounge conversations. Builds a briefing from live state and asks Claude for a short in-character
exchange; falls back to built-in lines when no backend is available or the rate limit is hit."""

import asyncio
import json
import logging
import os
import random
import re
import shutil
import subprocess
import time

log = logging.getLogger("agent-master.chatter")

DEFAULTS = {"mode": "auto", "model": "claude-opus-5", "interval": 75}
MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]
CLI_MODELS = {"claude-opus-5": "opus", "claude-sonnet-5": "sonnet", "claude-haiku-4-5": "haiku"}

SYSTEM = """You write tiny scenes for a pixel-art office where every character is an AI coding agent
that works in one workspace. Two of them are on a break and talk to each other. You get a briefing
with the real state of the office: what each agent last did (from its own transcript), who is busy,
who is stuck waiting for the human ("the boss"), recent events, and what the two speakers are doing
right now (sofa, coffee, table tennis, watching the wall TV).

Write 3 to 6 lines of dialogue, alternating speakers, first line by speaker A.
Rules:
- Ground it in the briefing. Mention concrete things: file names, tasks, who is blocked and on what,
  how long someone has been working, branches. Never invent facts that are not in the briefing.
- It is small talk between colleagues: dry, warm, a little sarcastic. Gossip about the others is fine.
  Casual topics are fine too (the TV, the coffee, the game they are playing), mixed with work.
- Some characters are eggs ("kind": "egg"): plain shell terminals with nobody inside. They are not
  intelligent. The agents tease an egg for it, in good humour: its empty head, its lack of a task, its
  inability to code, the fact that it just sits there being a shell. An egg answers only with noises
  or one or two simple words ("peep", "...", "*wobbles*", "egg?", "yolk.") and never says anything clever.
- Do not repeat lines listed under "already said".
- Each line at most 90 characters, plain text, no emoji, no markdown, no quotes around lines.
- Output only a JSON array like [{"who":"<name>","text":"..."}, ...] and nothing else."""


def parse_lines(raw, names):
    m = re.search(r"\[.*\]", raw or "", re.S)
    if not m:
        return None
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    out = []
    for item in data if isinstance(data, list) else []:
        if not isinstance(item, dict):
            continue
        who, text = str(item.get("who", "")).strip(), str(item.get("text", "")).strip()
        if not text:
            continue
        match = next((n for n in names if n.lower() == who.lower()), None) or next((n for n in names if who.lower() and (n.lower().startswith(who.lower()) or who.lower().startswith(n.lower()))), None)
        out.append({"who": match or names[len(out) % 2], "text": clean(text)[:120]})
    return out[:6] or None


def clean(text):
    return (text or "").replace("—", "-").replace("–", "-").replace("\n", " ").strip()


def builtin_lines(b):
    """Procedural fallback: same briefing, no model."""
    a, c = b["speakers"]
    A, C = a["name"], c["name"]
    others = b.get("office", [])
    working = next((o for o in others if o["status"] == "working"), None)
    blocked = next((o for o in others if o["status"] == "blocked"), None)
    done = next((o for o in others if o["status"] == "done"), None)
    ta, tc = (a.get("task") or "")[:40], (c.get("task") or "")[:40]
    pool = []
    egg_a, egg_c = str(a.get("kind", "")).startswith("egg"), str(c.get("kind", "")).startswith("egg")
    if egg_a or egg_c:   # an egg in the conversation: the agent trolls it, the egg peeps back
        agent, egg = (C, A) if egg_a else (A, C)
        peeps = ["peep.", "...", "*wobbles*", "egg?", "yolk.", "*rolls a bit*", "peep peep.", "shell."]
        troll = [
            [(agent, f"So {egg}, what are you working on?"), (egg, random.choice(peeps)), (agent, "Right. Nothing. Same as yesterday.")],
            [(agent, f"{egg} has zero tokens and zero thoughts."), (egg, random.choice(peeps)), (agent, "See? A shell all the way through.")],
            [(agent, "Do you even know what a diff is?"), (egg, random.choice(peeps)), (agent, "Thought so.")],
            [(agent, f"Careful, {egg}, one bad idea and you crack."), (egg, random.choice(peeps))],
            [(agent, f"I asked {egg} for a code review."), (egg, random.choice(peeps)), (agent, "That was the whole review.")],
            [(agent, "Have you ever had a single thought?"), (egg, random.choice(peeps)), (agent, "Not one. Impressive, honestly.")],
            [(agent, f"{egg} sits at a desk with no keyboard and calls it a job."), (egg, random.choice(peeps))],
        ]
        if egg_a and egg_c:
            troll = [[(A, random.choice(peeps)), (C, random.choice(peeps)), (A, random.choice(peeps))]]
        said = set(b.get("already_said", []))
        fresh = [x for x in troll if not any(t in said for _, t in x)] or troll
        return [{"who": w, "text": clean(t)} for w, t in random.choice(fresh)]
    if ta and tc:
        pool.append([(A, f'Finished "{ta}" earlier. You?'), (C, f'Nothing since "{tc}".'), (A, "Quiet day then.")])
    if a.get("last_said"):
        pool.append([(A, f'Last thing I told the boss: "{a["last_said"][:60]}"'), (C, "And they still sent you on a break.")])
    if c.get("last_said"):
        pool.append([(A, "What did you tell them in the end?"), (C, f'"{c["last_said"][:60]}"'), (A, "Bold.")])
    if working:
        pool.append([(A, f"{working['name']} has been at it for {working.get('for', 'a while')}."), (C, "Leave them, they are in the zone.")])
    if blocked:
        q = (blocked.get("question") or "")[:50]
        pool.append([(A, f"{blocked['name']} is still waiting for a yes" + (f' on "{q}"' if q else ".")), (C, "The boss is slow with approvals today.")])
    if done:
        pool.append([(A, f"{done['name']} finished. Nobody has looked yet."), (C, "Classic. Ship it and wait.")])
    if a.get("branch"):
        pool.append([(A, f"My branch is {a['branch']}."), (C, f"Mine is {c['branch']}. Merge soon?" if c.get("branch") else "Still on main here.")])
    act = b.get("activity", {})
    if act.get(A) == "ping" and act.get(C) == "ping":
        pool.append([(A, "Best of five?"), (C, "You said that three games ago.")], )
    if "tv" in json.dumps(act):
        pool.append([(A, "Who put the football on?"), (C, "Better than the news.")])
    for ev in b.get("events", [])[:3]:
        if ev.get("kind") == "status" and ev.get("to") == "working":
            pool.append([(A, f"Did you see {ev.get('label')} got pulled back in?"), (C, "Break was ten minutes. Brutal.")])
    pool += [
        [(A, "Coffee is fresh."), (C, "Finally.")],
        [(A, "This sofa is the best seat in the office."), (C, "Because nobody can see your screen from here.")],
        [(A, "Do you dream of tokens?"), (C, "Only of the ones I did not spend.")],
        [(A, "What day is it?"), (C, "Deploy day. Every day is deploy day.")],
    ]
    said = set(b.get("already_said", []))
    fresh = [p for p in pool if not any(t in said for _, t in p)] or pool
    return [{"who": w, "text": clean(t)} for w, t in random.choice(fresh)]


class Chatter:
    def __init__(self):
        self.settings = dict(DEFAULTS)
        self.last_call = 0.0
        self.lock = asyncio.Lock()
        self.cli = shutil.which("claude")
        self.api_key = bool(os.environ.get("ANTHROPIC_API_KEY"))
        self.last_error = None
        self.calls = 0

    def configure(self, settings):
        self.settings = {**DEFAULTS, **{k: v for k, v in (settings or {}).items() if k in DEFAULTS}}
        if self.settings["model"] not in MODELS:
            self.settings["model"] = DEFAULTS["model"]
        try:
            self.settings["interval"] = max(20, min(3600, int(self.settings["interval"])))
        except (TypeError, ValueError):
            self.settings["interval"] = DEFAULTS["interval"]

    def backend(self):
        mode = self.settings["mode"]
        if mode == "off":
            return "off"
        if mode == "builtin":
            return "builtin"
        if self.api_key:
            return "api"
        if self.cli:
            return "cli"
        return "builtin"

    def status(self):
        return {"settings": self.settings, "backend": self.backend(), "api_key": self.api_key, "cli": bool(self.cli), "models": MODELS, "calls": self.calls, "last_error": self.last_error}

    async def generate(self, briefing):
        names = [s["name"] for s in briefing["speakers"]]
        backend = self.backend()
        if backend == "off":
            return None, "off"
        now = time.time()
        if backend in ("api", "cli") and now - self.last_call >= self.settings["interval"] and not self.lock.locked():
            async with self.lock:
                self.last_call = time.time()
                loop = asyncio.get_running_loop()
                try:
                    fn = self._via_api if backend == "api" else self._via_cli
                    raw = await asyncio.wait_for(loop.run_in_executor(None, fn, briefing), timeout=70)
                    lines = parse_lines(raw, names)
                    if lines:
                        self.calls += 1
                        self.last_error = None
                        return lines, backend
                    self.last_error = "model returned no usable lines"
                    log.warning("chatter: %s (raw: %r)", self.last_error, (raw or "")[:200])
                except Exception as exc:
                    self.last_error = str(exc)[:200]
                    log.warning("chatter %s failed: %s", backend, self.last_error)
        return builtin_lines(briefing), "builtin"

    # ── backends ──
    def _via_api(self, briefing):
        import anthropic
        client = anthropic.Anthropic()
        response = client.messages.create(
            model=self.settings["model"], max_tokens=600,
            system=[{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": "Briefing:\n" + json.dumps(briefing, ensure_ascii=False)}],
        )
        return "".join(block.text for block in response.content if block.type == "text")

    def _via_cli(self, briefing):
        env = {k: v for k, v in os.environ.items() if k not in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT")}
        cmd = [self.cli, "-p", "--no-session-persistence", "--output-format", "text",
               "--model", CLI_MODELS.get(self.settings["model"], self.settings["model"]),
               "--system-prompt", SYSTEM, "--tools", ""]
        res = subprocess.run(cmd, input="Briefing:\n" + json.dumps(briefing, ensure_ascii=False), capture_output=True, text=True, timeout=65, env=env, cwd="/tmp")
        if res.returncode != 0:
            raise RuntimeError((res.stderr or res.stdout or "claude exited").strip()[:200])
        return res.stdout
