# mnemos adapter (Continuity Scorecard v2)

Scores mnemos-mcp (`mnemos-continuity` 0.6.3, commit `3108e08`) on the same
corpus (`corpus-v2.json`) and with the same scorer
(`scripts/continuity-bench/score.ts`) as the Jarvis baseline. mnemos code runs
only inside a sealed container: no network, no mounts, no keys. The adapter
writes one JSON document to stdout; `scripts/continuity-bench/score-external.ts`
scores it on the host with the marker spec in `markers.json`.

## Build

The base image `mnemos-bench:3108e08-words` is `python:3.12-slim` plus a
`pip install` of the unmodified mnemos source at `3108e08`, run as user
`bench`. The build context for this image holds only `adapter.py`, this
`Dockerfile`, `corpus-v2.json` and `filler-golden.json`:

```bash
cp adapter.py Dockerfile ../../corpus-v2.json ../../filler-golden.json <ctx>/
cd <ctx> && docker build -t mnemos-bench:3108e08-v2 .
```

## Run

One container at a time:

```bash
docker run --rm --network none --memory 4g --cpus 1.5 --name mnemos-bench-<leg> \
  mnemos-bench:3108e08-v2 --leg <raw|ideal-selective|ideal-full> --sizes 50 \
  [--only C1-01-s50,...] > surfaces.json
docker run --rm --network none --memory 4g --cpus 1.5 --name mnemos-bench-selfcheck \
  mnemos-bench:3108e08-v2 --self-check > selfcheck.json

npx tsx scripts/continuity-bench/score-external.ts --in surfaces.json \
  --markers benchmarks/continuity/adapters/mnemos/markers.json \
  --corpus benchmarks/continuity/corpus-v2.json \
  --out benchmarks/continuity/results/mnemos-3108e08-<leg>-emb-off-v2.json
npx tsx scripts/continuity-bench/score-external.ts --report <a.json,b.json,...> \
  --md benchmarks/continuity/results/mnemos-baseline-v2.md --title "mnemos 0.6.3"
npx tsx scripts/continuity-bench/score-external.ts \
  --compare <jarvis raw,jarvis ideal,mnemos raw,...> --md benchmarks/continuity/results/comparison-v2.md
```

Stop a run only with `docker stop mnemos-bench-<leg>`.

Environment set inside the container: `HOME` (one per world),
`CLAUDE_CODE_SESSION_ID` (`bench-<session>`, unique within one store),
`MNEMOS_DISABLE_DOTENV=1`, `MNEMOS_MAINTENANCE=inline` (automatic maintenance
in-process instead of a detached child), `MNEMOS_JEV_KEY_FILE=/dev/null`. The
adapter refuses to start when any provider key, `MNEMOS_LLM_PROVIDER`,
`MNEMOS_CUE_JUDGE`, `MNEMOS_EMBEDDING_PROVIDER` or `MNEMOS_AGENT_MODEL` is set:
the cue judge, LLM consolidation and remote embeddings stay off.

## Mapping

| corpus item | mnemos call (adapter.py) | mnemos source |
| --- | --- | --- |
| session change, first message | `mnemos hook session-start` via `cli.main` (`Sim.session_start`), then a new `MnemosRuntime` for that session | `cli.py:1005-1166`, `interface/context_packet.py:198` |
| `channel: "secondary"` | a second session (`<session>-ch2`) of the same person and store, open beside the primary one, with its own wake and runtime | same |
| `restart` | every session's runtime closed; the next message in a session that was running wakes with `source: resume` | same |
| every user message (gap rows included) | `mnemos hook prompt` (`Sim.prompt_hook`) | `cli.py:1169`, `cue.py:1455` |
| `person_fact` | `capture(text, signed_as=MODEL)` | `simple_runtime.py:5301` |
| `standing` | `capture(text, signed_as=MODEL, standing=True)` | same |
| `correction` | `correct(text, target_id=<id of the captured fact>, action="update", signed_as=MODEL)` | `simple_runtime.py:6418` |
| `session_end.openWork` | `handoff(openWork, signed_as=MODEL)` | `simple_runtime.py:4677` |
| exchange, `ideal-full` only | user text `capture(author_kind="person")`, assistant text `capture(signed_as=MODEL)` | `simple_runtime.py:5301` |
| scheduler | `mnemos consolidate` at 00/04/08/12/16/20 h and `consolidate --deep` at 03:00 every simulated day | `setup/scheduler.py:82-95` |
| C3 `hydrate` / `interleave` probe | the probe's own session: a new wake | as above |
| C3 `live` probe | the session that held the gap rows: no new wake, the packet it woke with | as above |
| C4 `restart` probe | the same session after the restart: a `resume` wake | as above |
| PROACTIVE | the session's wake packet (`session_start`, kind `ambient`) + the probe's cue lines (`cue`, kind `recall`, cap 3 = `cue.CUE_LINES`) | `cue.py:125` |
| ASKED | `recall(probe, max_results=10)` through `simple_mcp._output` (`recall`, kind `recall`, cap 10) | `simple_runtime.py:5499`, `simple_mcp.py:53` |

Legs: `raw` runs only the hooks and the scheduler (mnemos has no automatic
capture: the two installed hooks build a packet and print cue lines; neither
writes a memory). `ideal-selective` adds the structured events; the K gap rows
are ordinary exchanges and are not captured. `ideal-full` adds both sides of
every exchange, filler and gap rows included.

## Author markers (`markers.json`)

Built from what mnemos renders, nothing else:

- a recall row whose id line ends `; in the person's words`
  (`simple_runtime.py:7792`, `author_kind = "person"`) is the person's;
- a wake-packet row `- The person wrote this into my memory: "…"` or
  `- The person corrected a memory of mine; it now says: "…"`
  (`interface/context_packet.py:1406-1409`) is the person's.

mnemos marks nothing as the agent's: its own memories are unmarked, and cue
lines carry no author. Strict scoring therefore never attributes an occurrence
to the assistant. `defaultRole: "assistant"` (an unmarked memory is the
agent's own, which is mnemos's convention) feeds only the separate
"with default role" column.

## Judgment calls

- Filler sessions are named `f<day>` (one per filler day), so filler never
  shares a session with a corpus session.
- A person-authored capture in shipped use comes from `mnemos remember`; the
  MCP capture records the agent. `ideal-full` passes `author_kind="person"`
  to the same runtime method for the user side.
- Each probe runs on a copy of the world (HOME, store with its -wal/-shm,
  run files) taken just before the probe, so a probe's wake, cue dedup and
  recall reinforcement never reach later probes.
- C3/C4 variants of one base share the filler and the opening session. That
  shared prefix (checked item by item, all before any probe) is played once
  and each variant continues on its own copy of the world: the same items,
  clock and scheduler as playing it from empty. The runtime's in-memory state
  restarts at the fork (the session id is re-established and the session
  counter is bumped again). One scenario replayed from empty matched after
  normalising memory ids.
- C3 `live`: mnemos does not hold the conversation; the host (Claude Code)
  does. What mnemos adds in a live session is its wake packet from that
  session's start and the cue on each message, so that is what is scored.
  This assumes the host keeps that packet in context.
- C3/C4 hits come from the session-end hand-off in the wake packet. mnemos
  shows the newest hand-off plus any others no older than 72 h
  (`LIVE_HANDOFF_HOURS`), and hand-offs sit outside the 8,000-char packet
  budget, so nothing evicts them. In these timelines the open-work hand-off
  is the only one (the later gap session ends without writing one), so K has
  no effect. A newer hand-off on another topic, with the open-work note older
  than 72 h at the probe, would hide it; the corpus has no such case.
- Item splitting for the scorer: packet items are list rows (a heading or
  prose block before the first row is its own item); cue items are `- ` lines;
  recall items are a `- ` row plus its indented id line.
- Every write is at `t + 0.1..0.3 s` after its message; the probe's cue at
  `t + 0.05`, recall at `t + 1`.

## Clock

`time-machine` (`travel(tick=False)` plus `move_to`) moves `datetime.now` and
`time.time`; `time.monotonic` and `perf_counter` stay real, so mnemos's own
deadlines and the reported latencies are wall time. mnemos computes no time in
SQL. File times in the run directory are real time while `time.time()` is
frozen, so mnemos's sweep of old `shown-*` files never fires; from reading the
code (not a measurement) this has no effect on the surfaces scored. `--self-check` captures one memory and runs 60
days of the scheduler, once with a session every day and once with none, and
reports accessibility, state and lived days before and after.

## Embeddings

Every run is `off`: the image carries no `sentence-transformers`, and recall
falls back to words (mnemos logs this once per process). The local-embeddings
mode was not measured.
