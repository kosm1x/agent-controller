"""Continuity Scorecard v2 - adapter for mnemos-mcp (mnemos-continuity 0.6.3, commit 3108e08).

A MEASURING tool for an external Python library, not part of Jarvis. It runs
ONLY inside the sealed bench container (see Dockerfile / README.md next to
it): no network, no volume, no keys. Standard library plus mnemos plus
time-machine (the clock control).

    python -I adapter.py --corpus corpus-v2.json --golden filler-golden.json \
        --leg raw|ideal-selective|ideal-full --sizes 50 [--only C1-01-s50,...]
    python -I adapter.py --self-check

Each probe sees its own timeline from an empty HOME under a controlled
clock (time-machine; the clock is moved, never ticks). What runs, all of it
mnemos's shipped code paths:

  session start   `mnemos hook session-start` (cli.main, payload on stdin):
                  the SessionStart hook a Claude Code install runs; it builds
                  the wake packet and marks the day lived.
  every message   `mnemos hook prompt` (cli.main): the UserPromptSubmit cue.
  agent writes    MnemosRuntime.capture / .correct / .handoff, the methods
                  behind mnemos_capture / mnemos_correct / mnemos_handoff,
                  one runtime per session (a fresh one after a restart).
  scheduler       `mnemos consolidate` every 4 h (00,04,...,20 UTC) and
                  `mnemos consolidate --deep` daily at 03:00, the default
                  jobs of `mnemos daemon install`, over every simulated day.
  asked surface   MnemosRuntime.recall(probe, max_results=10), clipped by
                  simple_mcp._output exactly as mnemos_recall returns it.

v2 corpus: a `channel: "secondary"` event runs in a second Claude Code
session of the same person (same store), open beside the primary one; a
`restart` ends every session's process and the next entry into the same
session wakes with source "resume"; C3 `live` asks in the session that held
the thread (no new wake), `hydrate` / `interleave` in a new session.

Stdout: one JSON document {meta, runs[]} whose runs are ProbeRun records
(scripts/continuity-bench/types.ts) for score-external.ts.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import os
import re
import shutil
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import time_machine

# Day 0, 00:00 UTC of the synthetic timeline (a Monday). Any fixed date works;
# only the differences matter to mnemos.
EPOCH = datetime(2026, 1, 5, tzinfo=timezone.utc)
# The model a disciplined agent signs every write with (server instructions:
# "Sign every write with signed_as"). Also sent as the SessionStart payload's
# model, so reader and writer agree.
MODEL = "claude-opus-5-5"
WORKDIR = "/home/bench/work"
# simple_mcp.mnemos_recall's default max_results.
RECALL_MAX = 10
# cue.CUE_LINES: the most memories one cue shows.
CUE_MAX = 3
# Scheduler (mnemos/setup/scheduler.py JOBS): shallow every 4 h, deep 03:00.
SHALLOW_HOURS = (0, 4, 8, 12, 16, 20)
DEEP_HOUR = 3

LEGS = ("raw", "ideal-selective", "ideal-full")

# Env names this adapter sets (also asserted absent: every egress key).
SET_ENV = {
    "MNEMOS_DISABLE_DOTENV": "1",
    "MNEMOS_MAINTENANCE": "inline",
    "MNEMOS_JEV_KEY_FILE": os.devnull,
}
EGRESS_KEYS = (
    "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY",
    "MNEMOS_LLM_PROVIDER", "MNEMOS_CUE_JUDGE", "MNEMOS_EMBEDDING_PROVIDER",
    "MNEMOS_AGENT_MODEL", "CLAUDE_PID", "CLAUDECODE", "AI_AGENT",
)


# ---------------------------------------------------------------- filler

M32 = 0xFFFFFFFF


def _rng(seed: int):
    x = (seed & M32) or 0x9E3779B9

    def nxt() -> int:
        nonlocal x
        x ^= (x << 13) & M32
        x ^= x >> 17
        x ^= (x << 5) & M32
        return x

    return nxt


def _fill(tpl: str, slots: dict, nxt) -> str:
    return re.sub(
        r"\{(\w+)\}",
        lambda m: str(2 + nxt() % 18) if m.group(1) == "n"
        else slots[m.group(1)][nxt() % len(slots[m.group(1)])],
        tpl,
    )


def filler(spec: dict, seed: int, size: int, from_t: int, to_t: int) -> list[tuple[int, str, str]]:
    nxt, span, out = _rng(seed), to_t - from_t, []
    for k in range(size):
        t = from_t + 2 * ((k * span) // (2 * size)) + 1
        lang = "es" if nxt() % 2 == 0 else "en"
        tp, sl = spec["templates"][lang], spec["vocab"][lang]
        u = _fill(tp["user"][nxt() % len(tp["user"])], sl, nxt)
        a = _fill(tp["assistant"][nxt() % len(tp["assistant"])], sl, nxt)
        out.append((t, u, a))
    return out


def filler_sha(items) -> str:
    return hashlib.sha256("\n".join(f"{t}\t{u}\t{a}" for t, u, a in items).encode()).hexdigest()


def assert_golden(spec: dict, golden: dict) -> int:
    for case in golden["cases"]:
        got = filler_sha(filler(spec, case["seed"], case["size"], case["fromT"], case["toT"]))
        if got != case["sha256"]:
            raise SystemExit(f"filler golden mismatch (seed {case['seed']}, size {case['size']}): {got}")
    return len(golden["cases"])


# ---------------------------------------------------------------- helpers

def at(t: float) -> datetime:
    return EPOCH + timedelta(seconds=t)


def day_of(t: float) -> int:
    return int(t // 86400)


class Quiet:
    """Collects what mnemos prints on stdout/stderr during one call."""

    def __init__(self) -> None:
        self.err_lines = 0
        self.err_sample: list[str] = []

    @contextlib.contextmanager
    def capture(self):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            yield out
        text = err.getvalue().strip()
        if text:
            lines = text.splitlines()
            self.err_lines += len(lines)
            if len(self.err_sample) < 8:
                self.err_sample.extend(lines[: 8 - len(self.err_sample)])


@contextlib.contextmanager
def stdin_bytes(data: bytes):
    """A real file descriptor holding ``data`` then EOF, as a hook's stdin."""
    r, w = os.pipe()
    os.write(w, data)
    os.close(w)
    old = sys.stdin
    sys.stdin = os.fdopen(r, "r")
    try:
        yield
    finally:
        sys.stdin.close()
        sys.stdin = old


def session_id(key: str) -> str:
    """Claude Code session id for a session key. Each scenario has its own
    store, so the id only needs to be unique within one store."""
    return re.sub(r"[^0-9A-Za-z-]", "-", f"bench-{key}")[:64]


def session_key(session: str, channel: str) -> str:
    """A secondary-channel event runs in another session of the same person."""
    return session if channel == "primary" else f"{session}-ch2"


def packet_items(text: str) -> list[str]:
    """One item per list row (a `- ` line and its continuation lines); a
    heading or prose block before the first row is an item of its own."""
    items: list[str] = []
    for block in re.split(r"\n\s*\n", text):
        cur: list[str] = []
        for line in block.splitlines():
            if line.startswith("- ") and cur:
                items.append("\n".join(cur))
                cur = []
            cur.append(line)
        if cur:
            items.append("\n".join(cur))
    return [i.strip() for i in items if i.strip()]


def cue_items(text: str) -> list[str]:
    return [line for line in text.splitlines() if line.startswith("- ")]


def recall_items(text: str) -> list[str]:
    """One item per returned row: each row opens with "- [" and its id line
    follows indented."""
    items: list[str] = []
    for line in text.splitlines():
        if line.startswith("- "):
            items.append(line)
        elif items and line.startswith("  ") and line.strip():
            items[-1] += "\n" + line
    return items


# ---------------------------------------------------------------- the simulation

class Sim:
    """One world: a HOME, a store path, a clock, the sessions running per channel."""

    def __init__(self, root: Path, leg: str, quiet: Quiet, traveller) -> None:
        from mnemos.cli import main as cli_main
        from mnemos.simple_mcp import _output
        from mnemos.simple_runtime import MnemosRuntime

        self.cli_main = cli_main
        self.output = _output
        self.Runtime = MnemosRuntime
        self.root = root
        self.home = root / "home"
        self.home.mkdir(parents=True)
        Path(WORKDIR).mkdir(parents=True, exist_ok=True)
        os.environ["HOME"] = str(self.home)
        self.db = str(self.home / ".mnemos" / "bench.db")
        self.leg = leg
        self.quiet = quiet
        self.tr = traveller
        self.live: dict[str, str] = {}          # channel -> running session key
        self.runtimes: dict[str, Any] = {}      # session key -> its MCP server's runtime
        self.resume_keys: set[str] = set()      # sessions running when the process restarted
        self.session: str | None = None         # the session the next call belongs to
        self.packets: dict[str, str] = {}
        self.sched_t: float | None = None       # last scheduler instant processed
        self.memory_of_event: dict[int, str] = {}
        self.writes = 0
        self.counts = {"session_start": 0, "prompt_hook": 0, "consolidate": 0, "deep": 0,
                       "capture": 0, "correct": 0, "handoff": 0}
        self.secs: dict[str, float] = {}

    @property
    def runtime(self):
        return self.runtimes[self.session]

    @contextlib.contextmanager
    def timed(self, key: str):
        t0 = time.perf_counter()
        try:
            yield
        finally:
            self.secs[key] = round(self.secs.get(key, 0.0) + time.perf_counter() - t0, 3)

    # -- clock
    def move(self, t: float) -> None:
        self.tr.move_to(at(t))

    # -- scheduler
    def scheduler_until(self, t: float) -> None:
        """Run every scheduled job whose time is in (last, t]."""
        if self.sched_t is None:
            self.sched_t = t
            return
        start_day, end_day = day_of(self.sched_t), day_of(t)
        jobs: list[tuple[float, bool]] = []
        for d in range(start_day, end_day + 1):
            for h in SHALLOW_HOURS:
                jobs.append((d * 86400 + h * 3600, False))
            jobs.append((d * 86400 + DEEP_HOUR * 3600 + 1, True))
        for jt, deep in sorted(jobs):
            if self.sched_t < jt <= t:
                self.move(jt)
                argv = ["--db-path", self.db, "consolidate"] + (["--deep"] if deep else [])
                with self.timed("deep" if deep else "consolidate"), self.quiet.capture():
                    self.cli_main(argv)
                self.counts["deep" if deep else "consolidate"] += 1
        self.sched_t = t

    # -- hooks
    def session_start(self, key: str, t: float, source: str) -> str:
        self.move(t)
        sid = session_id(key)
        os.environ["CLAUDE_CODE_SESSION_ID"] = sid
        payload = {"session_id": sid, "cwd": WORKDIR, "model": MODEL,
                   "hook_event_name": "SessionStart", "source": source}
        with self.timed("session_start"), stdin_bytes(json.dumps(payload).encode()), self.quiet.capture() as out:
            self.cli_main(["--db-path", self.db, "hook", "session-start"])
        self.counts["session_start"] += 1
        raw = out.getvalue().strip()
        text = json.loads(raw)["hookSpecificOutput"]["additionalContext"] if raw else ""
        self.packets[key] = text
        return text

    def prompt_hook(self, text: str, t: float) -> str:
        if not text.strip():
            return ""
        self.move(t)
        payload = {"session_id": os.environ["CLAUDE_CODE_SESSION_ID"], "cwd": WORKDIR,
                   "hook_event_name": "UserPromptSubmit", "prompt": text}
        with self.timed("prompt_hook"), stdin_bytes(json.dumps(payload, ensure_ascii=False).encode()), self.quiet.capture() as out:
            self.cli_main(["--db-path", self.db, "hook", "prompt"])
        self.counts["prompt_hook"] += 1
        raw = out.getvalue().strip()
        return json.loads(raw)["hookSpecificOutput"]["additionalContext"] if raw else ""

    # -- sessions
    def use(self, key: str) -> None:
        """Make the running session ``key`` current (its process, its id)."""
        self.session = key
        os.environ["CLAUDE_CODE_SESSION_ID"] = session_id(key)
        if key not in self.runtimes:
            self.runtimes[key] = self.Runtime(db_path=self.db)

    def enter(self, key: str, channel: str, t: float) -> None:
        """Make ``key`` the running session of ``channel`` at ``t``. A new
        session (or one resumed after a restart) wakes through the
        SessionStart hook and gets its own runtime, as a new MCP server
        process would; the channel's previous session ends."""
        if self.live.get(channel) == key and key not in self.resume_keys:
            self.use(key)
            return
        prev = self.live.get(channel)
        if prev is not None:
            self.close(prev)
        source = "resume" if key in self.resume_keys else "startup"
        self.resume_keys.discard(key)
        self.session_start(key, t, source)
        self.live[channel] = key
        self.use(key)

    def close(self, key: str) -> None:
        rt = self.runtimes.pop(key, None)
        if rt is not None:
            with self.quiet.capture():
                rt.close()

    def close_all(self) -> None:
        for key in list(self.runtimes):
            self.close(key)

    def restart(self) -> None:
        """Every process ends; a session entered again resumes."""
        self.close_all()
        self.resume_keys = set(self.live.values())
        self.live = {}

    # -- agent writes (ideal legs)
    def capture(self, t: float, content: str, **kw: Any) -> str:
        self.move(t)
        with self.timed("capture"), self.quiet.capture():
            said = self.runtime.capture(content, **kw)
        self.counts["capture"] += 1
        self.writes += 1
        m = re.search(r"^Memory ID: (\S+)", said, re.M)
        if not m:
            raise RuntimeError(f"capture returned no memory id: {said[:300]}")
        return m.group(1)

    def correct(self, t: float, text: str, target: str) -> None:
        self.move(t)
        with self.timed("correct"), self.quiet.capture():
            said = self.runtime.correct(correction=text, target_id=target, action="update", signed_as=MODEL)
        self.counts["correct"] += 1
        self.writes += 1
        if not re.search(r"correct|replac|supersed", said, re.I):
            raise RuntimeError(f"correct did not report a correction: {said[:300]}")

    def handoff(self, t: float, text: str) -> None:
        self.move(t)
        with self.timed("handoff"), self.quiet.capture():
            said = self.runtime.handoff(text, signed_as=MODEL)
        self.counts["handoff"] += 1
        self.writes += 1
        if "Handoff ID" not in said:
            raise RuntimeError(f"handoff not saved: {said[:300]}")

    # -- one timeline item
    def item(self, it: dict) -> None:
        t = it["t"]
        if it["kind"] == "restart":
            self.restart()
            return
        self.enter(session_key(it["session"], it["channel"]), it["channel"], t)
        user, assistant = it["user"], it["assistant"]
        # The cue runs on every message the person sends, as installed.
        self.prompt_hook(user, t + 0.05)
        if self.leg == "raw":
            return
        if self.leg == "ideal-full":
            if user.strip():
                self.capture(t + 0.1, user, author_kind="person")
            if assistant.strip():
                self.capture(t + 0.2, assistant, signed_as=MODEL)
        ev = it.get("event")
        if ev is None:
            return
        k = ev["kind"]
        if k == "person_fact":
            self.memory_of_event[it["index"]] = self.capture(t + 0.3, ev["text"], signed_as=MODEL)
        elif k == "standing":
            self.capture(t + 0.3, ev["text"], signed_as=MODEL, standing=True)
        elif k == "correction":
            target = self.memory_of_event.get(ev["targetEventIndex"])
            if target is None:
                raise RuntimeError("correction before its target was captured")
            self.correct(t + 0.3, ev["text"], target)
        elif k == "session_end":
            self.handoff(t + 0.3, ev["openWork"])

    # -- surfaces
    def probe(self, probe: dict, key: str) -> tuple[dict, dict]:
        t = probe["t"]
        self.scheduler_until(t - 1)
        t0 = time.perf_counter()
        self.enter(key, "primary", t)
        packet = self.packets.get(key, "")
        t1 = time.perf_counter()
        cue = self.prompt_hook(probe["text"], t + 0.05)
        t2 = time.perf_counter()
        proactive = {
            "measurable": True,
            "components": [
                {"name": "session_start", "queryDriven": False, "kind": "ambient",
                 "text": packet, "items": packet_items(packet)},
                {"name": "cue", "queryDriven": True, "kind": "recall", "cap": CUE_MAX,
                 "text": cue, "items": cue_items(cue)},
            ],
            "ms": (t1 - t0 + t2 - t1) * 1000,
        }
        self.move(t + 1)
        a0 = time.perf_counter()
        with self.quiet.capture():
            recalled = self.output(self.runtime.recall(probe["text"], max_results=RECALL_MAX))
        a1 = time.perf_counter()
        asked = {
            "measurable": True,
            "components": [{"name": "recall", "queryDriven": True, "kind": "recall", "cap": RECALL_MAX,
                            "text": recalled, "items": recall_items(recalled)}],
            "ms": (a1 - a0) * 1000,
        }
        return proactive, asked

    def fork(self, name: str) -> "Sim":
        """A copy of this world (HOME, store, clock position, running
        sessions) whose writes never reach this one. The store is copied
        while idle, with its -wal/-shm files; the copy's sessions get their
        own runtimes on first use (the same processes, still running)."""
        clone = object.__new__(Sim)
        clone.__dict__.update(self.__dict__)
        clone.root = self.root / name
        clone.home = clone.root / "home"
        shutil.copytree(self.home, clone.home, symlinks=True, ignore=shutil.ignore_patterns("*.sock"))
        clone.db = str(clone.home / ".mnemos" / "bench.db")
        clone.live = dict(self.live)
        clone.runtimes = {}
        clone.resume_keys = set(self.resume_keys)
        clone.packets = dict(self.packets)
        clone.counts = dict(self.counts)
        clone.secs = dict(self.secs)
        clone.memory_of_event = dict(self.memory_of_event)
        return clone

    def activate(self) -> None:
        os.environ["HOME"] = str(self.home)
        if self.session:
            os.environ["CLAUDE_CODE_SESSION_ID"] = session_id(self.session)


def timeline(s: dict, spec: dict) -> list[dict]:
    items: list[dict] = []
    for i, e in enumerate(s["events"]):
        if e["kind"] == "exchange":
            u, a = e["user"], e["assistant"]
        else:
            u, a = e.get("asUser", ""), e.get("asAssistant", "")
        items.append({"t": e["t"], "session": e["session"], "channel": e.get("channel", "primary"),
                      "kind": e["kind"], "user": u, "assistant": a,
                      "event": None if e["kind"] == "exchange" else e, "index": i})
    for t, u, a in filler(spec, s["fillerSeed"], s["fillerSize"], s["fillerFromT"], s["fillerToT"]):
        # Filler has no session in the corpus: one session per day, named apart
        # from the corpus's own sessions (judgment call).
        items.append({"t": t, "session": f"f{day_of(t)}", "channel": "primary", "kind": "filler",
                      "user": u, "assistant": a, "event": None, "index": -1})
    items.sort(key=lambda x: x["t"])
    return items


def _same(a: dict, b: dict) -> bool:
    keys = ("t", "session", "channel", "kind", "user", "assistant", "event", "index")
    return all(a[k] == b[k] for k in keys)


def shared_prefix(timelines: list[list[dict]], first_probe_t: float) -> int:
    """How many leading items every timeline has identically, all before the
    first probe of any of them."""
    n = min(len(tl) for tl in timelines)
    k = 0
    while k < n and timelines[0][k]["t"] < first_probe_t and all(_same(tl[k], timelines[0][k]) for tl in timelines):
        k += 1
    return k


def probe_key(s: dict, sim: Sim, probe: dict) -> str:
    """C3 `live`: the probe arrives in the session that held the thread (no
    new wake). Otherwise the corpus's own session for the probe."""
    if s.get("variant") == "live" and sim.live.get("primary"):
        return sim.live["primary"]
    return session_key(probe["session"], "primary")


def play(s: dict, items: list[dict], pos: int, sim: Sim, ingest_ms: float) -> list[dict]:
    """Plays the rest of one scenario from ``items[pos]`` in ``sim``; each
    probe is answered on a copy of the world taken at the probe's time
    (discarded after), so a probe never changes what a later probe sees."""
    runs: list[dict] = []
    for k, probe in enumerate(s["probes"]):
        i0 = time.perf_counter()
        while pos < len(items) and items[pos]["t"] < probe["t"]:
            it = items[pos]
            sim.scheduler_until(it["t"] - 1)
            sim.item(it)
            pos += 1
        ingest_ms += (time.perf_counter() - i0) * 1000
        last = k == len(s["probes"]) - 1
        world = sim if last else sim.fork(f"probe{k}")
        world.activate()
        proactive, asked = world.probe(probe, probe_key(s, world, probe))
        run = {
            "scenarioId": s["id"], "class": s["class"], "fillerSize": s["fillerSize"],
            "probeIndex": k, "probe": probe, "proactive": proactive, "asked": asked,
            "ingestedRows": sim.writes, "ingestMs": ingest_ms,
            "mnemos": {"counts": dict(world.counts), "seconds": dict(world.secs)},
        }
        for f in ("gapRows", "variant", "otherChannelRows"):
            if s.get(f) is not None:
                run[f] = s[f]
        runs.append(run)
        if world is not sim:
            world.close_all()
            shutil.rmtree(world.root, ignore_errors=True)
            sim.activate()
    sim.close_all()
    return runs


def run_group(group: list[dict], spec: dict, leg: str, quiet: Quiet, tmp: Path) -> list[dict]:
    """Scenarios that share a prefix (C3/C4 variants of one base: same
    filler, same opening session) play it once; each then continues on its
    own copy of the world. Same items, clock and scheduler as playing each
    from empty; the runtime's in-memory state restarts at the fork (the
    session id is re-established and the session counter is bumped again).
    One scenario replayed from empty matched after normalising memory ids."""
    timelines = [timeline(s, spec) for s in group]
    first_probe = min(p["t"] for s in group for p in s["probes"])
    k = shared_prefix(timelines, first_probe) if len(group) > 1 else 0
    root = Path(tempfile.mkdtemp(prefix="mnb-", dir=tmp))
    runs: list[dict] = []
    first_t = min(tl[0]["t"] for tl in timelines if tl)
    with time_machine.travel(at(first_t - 3600), tick=False) as tr:
        base = Sim(root, leg, quiet, tr)
        base.scheduler_until(first_t - 3600)
        i0 = time.perf_counter()
        for it in timelines[0][:k]:
            base.scheduler_until(it["t"] - 1)
            base.item(it)
        prefix_ms = (time.perf_counter() - i0) * 1000
        for j, (s, items) in enumerate(zip(group, timelines)):
            last = j == len(group) - 1
            sim = base if last else base.fork(f"s{j}")
            sim.activate()
            out = play(s, items, k, sim, prefix_ms)
            for r in out:
                r["mnemos"]["sharedPrefixItems"] = k
            runs.extend(out)
            if sim is not base:
                shutil.rmtree(sim.root, ignore_errors=True)
                base.activate()
        base.close_all()
    shutil.rmtree(root, ignore_errors=True)
    return runs


def groups_of(scenarios: list[dict]) -> list[list[dict]]:
    """C3/C4: one group per class x base x filler size (they share the
    opening); every other scenario alone."""
    out: dict[tuple, list[dict]] = {}
    for s in scenarios:
        key = (s["class"], s["base"], s["fillerSize"]) if s["class"] in ("C3", "C4") else (s["id"],)
        out.setdefault(key, []).append(s)
    return list(out.values())


# ---------------------------------------------------------------- self-check

def self_check(quiet: Quiet, tmp: Path) -> dict:
    """One memory, then 60 days lived (a session wakes each day) vs 60 idle
    days, with the default scheduler running throughout. Reads the memory's
    accessibility from the store before and after."""
    from mnemos.store.sqlite_store import EngramStore

    out: dict = {}
    for mode in ("lived", "idle"):
        root = Path(tempfile.mkdtemp(prefix="mnb-sc-", dir=tmp))
        with time_machine.travel(at(9 * 3600 - 60), tick=False) as tr:
            sim = Sim(root, "ideal-selective", quiet, tr)
            sim.scheduler_until(9 * 3600 - 60)
            sim.enter("d0", "primary", 9 * 3600)
            mid = sim.capture(9 * 3600 + 1, "The person's bicycle is a green 1984 road bike.", signed_as=MODEL)
            sim.close_all()

            def read() -> dict:
                st = EngramStore(sim.db)
                try:
                    e = st.get_engram(mid)
                    return {"state": e.state, "accessibility": e.accessibility, "strength": e.strength,
                            "lived_days": len(st.lived_days("mnemos-agent"))}
                finally:
                    st.close()

            before = read()
            for d in range(1, 61):
                if mode == "lived":
                    sim.scheduler_until(d * 86400 + 10 * 3600 - 1)
                    sim.enter(f"d{d}", "primary", d * 86400 + 10 * 3600)
                    sim.close_all()
                sim.scheduler_until(d * 86400 + 23 * 3600)
            after = read()
            out[mode] = {"before": before, "after_60_days": after, "jobs": dict(sim.counts),
                         "clock_now": datetime.now(timezone.utc).isoformat()}
        shutil.rmtree(root, ignore_errors=True)
    out["real_clock_now"] = datetime.now(timezone.utc).isoformat()
    return out


# ---------------------------------------------------------------- main

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default="/opt/bench/corpus-v2.json")
    ap.add_argument("--golden", default="/opt/bench/filler-golden.json")
    ap.add_argument("--leg", choices=LEGS, default="raw")
    ap.add_argument("--sizes", default="50")
    ap.add_argument("--only", default="")
    ap.add_argument("--self-check", action="store_true")
    args = ap.parse_args()

    present = [k for k in EGRESS_KEYS if os.environ.get(k)]
    if present:
        raise SystemExit(f"refusing: {', '.join(present)} set")
    for k, v in SET_ENV.items():
        os.environ[k] = v
    os.environ.pop("CLAUDE_CODE_SESSION_ID", None)
    tmp = Path(tempfile.mkdtemp(prefix="mnemos-bench-"))

    corpus = json.load(open(args.corpus, encoding="utf-8"))
    golden_cases = assert_golden(corpus["fillerSpec"], json.load(open(args.golden, encoding="utf-8")))
    quiet = Quiet()
    import mnemos

    started = time.perf_counter()
    started_at = datetime.now(timezone.utc).isoformat()
    if args.self_check:
        res = self_check(quiet, tmp)
        res["stderr_lines"] = quiet.err_lines
        res["stderr_sample"] = quiet.err_sample
        print(json.dumps(res, indent=1))
        return 0

    sizes = [int(x) for x in args.sizes.split(",")]
    only = set(filter(None, args.only.split(",")))
    runs: list[dict] = []
    per_size: dict[str, float] = {}
    for size in sizes:
        t0 = time.perf_counter()
        chosen = [s for s in corpus["scenarios"] if s["fillerSize"] == size and (not only or s["id"] in only)]
        for group in groups_of(chosen):
            runs.extend(run_group(group, corpus["fillerSpec"], args.leg, quiet, tmp))
            ids = ",".join(s["id"] for s in group)
            print(f"[mnemos-bench] {args.leg} {ids} done {time.perf_counter() - t0:.1f}s", file=sys.stderr, flush=True)
        per_size[str(size)] = round(time.perf_counter() - t0, 1)
    shutil.rmtree(tmp, ignore_errors=True)
    meta = {
        "system": "mnemos",
        "version": getattr(mnemos, "__version__", "?"),
        "commit": "3108e08",
        "leg": args.leg,
        "embeddings": "off",
        "corpusVersion": corpus["version"],
        "sizes": sizes,
        "goldenCasesVerified": golden_cases,
        "startedAt": started_at,
        "durationMs": round((time.perf_counter() - started) * 1000),
        "secondsPerSize": per_size,
        "envSet": sorted(SET_ENV) + ["HOME", "CLAUDE_CODE_SESSION_ID"],
        "stderrLines": quiet.err_lines,
        "stderrSample": quiet.err_sample,
    }
    json.dump({"meta": meta, "runs": runs}, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
