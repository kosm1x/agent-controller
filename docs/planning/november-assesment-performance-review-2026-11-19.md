# November Assesment — dimension 2 (PERFORMANCE): review and ruling list

> Opened 2026-11-19 03:40 UTC and reviewed the same day at `main` `f5172fd4`, live build `29e95dd3`. Read-only: nothing in `src/`, `scripts/` or the live host was changed. This file ends at the ruling list; nothing is built until the operator rules, and no code is committed before the outside-copies removal has said clean (queue 4gd).
> Parent: `docs/planning/november-assesment-2026-11-09.md` (§2 Performance, score 6). Queue: 4gf.

## Method

Six sub-dimensions (the wait of a chat reply · prompt size, the reusable-prompt store and number of model calls · side calls and the heavy and swarm runners · event loop, database and background work · tools and outside calls · observability and the build loop), each worked the same way:

1. A fresh reviewer (no shared context) with the code, a pack of live measurements and the instruction to verify, extend and size — not to confirm.
2. The orchestrator ran every live count itself (read-only: numbers, names, query plans) and re-read the lines the main claims rest on.
3. Three separate adversarial verifiers tried to break the 33 load-bearing claims: 18 confirmed, 13 right in part (corrected below), 2 refuted.
4. Only what survived is below. Where the three disagreed, the correction is stated.

No test, typecheck or build was run by any reviewer. All numbers are for the 30 days to 2026-11-19 unless a line says 7 or 14 days. Security and privacy notes are stated as categories only; detail is kept off-repo.

## Bottom line

**The machine is not the limit.** Average CPU use of the service is under 1 % of a core, at most 4 runs overlap, nothing queues. A reply is slow for four reasons, none of them hardware:

1. **A chat reply is 3 to 4 round trips to the model, each carrying a large package.** 1,155 fast tasks made 4,415 model calls (mean 3.8, median 3, p90 7). The first call carries a median of 62,431 tokens. A call, including the tool run before it, takes a median of 4.7 s (p90 13.9 s). Fast run: median 18.7 s, p90 52.2 s, p99 165 s. One-call replies take a median of 6.7 s; 4 calls 27.5 s; 8 or more 62.8 s.
2. **Part of the wait is not measured at all.** Before a task exists, the router sends the placeholder and then waits for memory enrichment and the scope classifier (bounded at 15 s). The first classifier answered 482 times in about 0.3 s; it declined or failed 305 times, and those messages (about 1 in 3 chat messages) wait for a second model call. The memory lookup waits on an outside embedding call with no bound short of the 15 s stage limit (138 of 1,793 lookups took over 1.5 s, 45 over 5 s, worst 7.9 s). Delivery after completion is not measured either.
3. **The service freezes itself.** 79 freezes of over 1 s in 7 days (16 over 5 s; worst 9.1 s; 24.4 s in 30 days). Two causes are proven: a nightly job at 05:59 UTC that reads the whole task table (6–7 s, six nights of six), and a "similar past tasks" lookup that runs on the main thread for every chat message in shadow mode (its result is never shown to the model): 10 of its 50 logged runs this week took over 1 s, worst 6.8 s, and the two longest chat-time freezes fall on the same minutes. 19 of the 79 freezes fell inside the windows of only 76 chat replies.
4. **The operator sees only a placeholder until the whole answer is ready.** Nothing is streamed on the main path and Telegram shows no typing sign.

**On cost: the ledger's dollars are list-price equivalents computed by the SDK, not an invoice** (the service runs on a plan; only usage beyond the plan's allowance is billed, and the ledger cannot tell which calls those were). In those terms, about 70 % of the fast runner's booked cost is writing prompt text into the one-hour reusable store at twice the input price (47.1 M tokens ≈ $188 of $268), and most of what is written is the per-task conversation text, which is never read again after the task ends. 59 % of tasks start with nothing reusable (677 of 1,155 first calls), mainly because the tool list differs from one kind of message to the next: 71 different tool lists in 14 days, and 42 % of consecutive large calls differ in their tool list, which invalidates everything after it.

**Heavy tasks** (52 runs, median 107 s) spend a median of 18.7 s planning, 73.2 s executing, 15.3 s reflecting and 17.8 s (average) in the quality grader. The grader stays (ruling). Planning and reflecting receive the full chat prompt.

### Where the assessment was wrong

| Assessment (2026-11-09) | Verdict | What is true |
| --- | --- | --- |
| "a turn chain averages about 8 turns per task" | WRONG | The trace writes one row per content block, not per model call. Model calls: mean 3.8, median 3. |
| "Model turn latency median 1.8 s — fine" | WRONG | Same cause, and each row's time includes the tool run before it. Per call including tools: median 4.7 s. Pure model time is read from the SDK and then dropped. |
| "Telegram streaming softens the wait" | WRONG | Nothing streams on the main path; the placeholder stays until the full answer. A first interim text comes only at 120 s. |
| "Prompt cache read share fast 82.8 %" | MISLEADING | True by token count, but 59 % of tasks read nothing on their first call, and writes are about 70 % of the booked fast cost. |
| "Booked cost per task / by month" | MISLEADING | List-price equivalents, not money billed. Rows with an empty cost basis are also list-priced; the field only shows which code path wrote the row. |
| "Event-loop lag … overnight database jobs on a cold file cache" | PARTLY | The largest daily freeze is one nightly job; a quarter of the freezes over 1 s fall inside chat replies and come from the per-message lookup. |
| "2,024 SDK calls are booked without an owner" | EXPLAINED | They are the extraction calls made after a reply is sent (facts, lessons, patterns) plus tool handlers' own model calls. Nobody waits on them; they only lack a label. |
| "The swarm path gets almost no cache benefit" | EXPECTED | Two one-off calls with different prompts; 2 swarm runs in 30 days. Not a target. |
| "enrichment plus scope classification run before the first [turn]" | RIGHT, undersized | Right, and this stage is recorded nowhere. |

Corrections between reviewers and verifiers: the skills test sweep does **not** explain the freezes at 02/08/14/20 UTC (it only awaits model calls; other jobs share those marks, and the 12:00 and 05:00 UTC clusters are still unexplained); "no cap on tool output" was too strong (the SDK's own program caps a tool result at about 25,000 tokens); "every side call writes its prompt and never reads it" is refuted for the fixed-prompt side calls (the scope classifier read 1.0 M of its 1.77 M prompt tokens from the store, the grader 1.17 M of 1.87 M) and holds only for the unlabelled extraction calls and the morning reflection (0 read); the one-hour lifetime is not a fixed default (it applies while usage is inside the plan; on overage the program falls back to five minutes — booked prices sit at or above the one-hour price on 1,106 of 1,109 large fast rows, in the five-minute band on 3); the event-loop alert on the 99th percentile cannot fire on isolated freezes, but a second rule on the maximum exists and can.

## The ruling list

Five decisions. Everything else in "Work ahead" needs no ruling (measurement, or a fix that changes nothing the model sees and nothing the operator sees).

| # | Decision | Recommended | Why | Cost / risk |
| --- | --- | --- | --- | --- |
| 1 | Show Telegram's "typing…" sign while a reply is being prepared | YES | Today the only sign of life is the placeholder; WhatsApp already has the equivalent. Changes how the wait feels, not its length. | Small; one unprotected file; no model-visible change. |
| 2 | Store the per-task conversation text for five minutes instead of one hour (tool list and instructions stay at one hour) | YES | That text is never read after its task ends, and it is most of what is written at the double price: up to ≈ $70 per 30 days in list-price terms. Not one byte of what the model sees changes. | Small. The real effect on plan usage cannot be measured from here; the proof is the before/after split of writes, which batch P1 starts recording. Reversible by one setting. |
| 3 | The health probe restarts the service only after two failed checks, not one | YES | A single 10 s probe every 5 minutes restarts the service and kills replies in flight; a freeze or a slow outside database alone can fail it. 8 failed probes in the last 30 days, 1 logged restart. The second watchdog already works this way. | Small; operator-installed script change; a real outage is noticed about 10 s later. |
| 4 | Let the per-message effort setting reach the main model path, judged by the one eval-gate run of batch 10 | YES | The classifier already decides how hard each message is, but that decision has never reached the main path since it was wired in July: every message runs at one fixed effort. Simple messages could answer faster. | Model-visible → eval gate; ships only if the gate passes. Needs the current fixed value (operator-side setting) recorded first. |
| 5 | Design and measure (not build) one stable tool list across message kinds | YES | The changing tool list is the main reason 59 % of tasks start with nothing reusable — the largest single lever on both the first-call wait and the booked cost. | Research only; the build would be model-visible and comes back as its own ruling with numbers. |

Considered and **not** recommended: streaming partial answer text (collides with the delivery checks: the final answer is the result text, scope questions are never delivered, every send is sanitised); moving the grader, the gates or the citation check off the wait (rulings); a cheaper model for the heavy tier (ruling); replacing the full test run in the commit check with related tests only (the full run is the one sanctioned gate before a direct push; CI median is 132 s and is not the bottleneck); a worker thread or a second database connection (ruled out in queue 4br); widening the greeting fast path (0 uses in 30 days and it would be a full model call anyway); an index for the skills test sweep (milliseconds).

## Rulings

Given by the operator on 2026-11-19 (UTC), one at a time (queue 4gg).

| # | Ruling | Reason or note |
| --- | --- | --- |
| 1 | NO | The typing sign is used for agents with several users, not for a personal one-on-one agent. Not to be proposed again for this agent. |
| 2 | NO — one hour stays | The operator sometimes returns to a thread after more than 20 minutes. Batch P5 is dropped; not to be proposed again. |
| 3 | YES | Two failed checks before a restart; operator-installed. |
| 4 | YES | Follow the design: the effort rating reaches the main model path. Batch 10; ships only on a passing eval-gate run. |
| 5 | YES — study and propose | Design and numbers only; a build comes back as its own ruling. |

## Work ahead

Order: the Code build queue finishes first (operator ruling 2026-11-18); Performance builds follow, each piece builder → separate auditor → commit → deploy → proof. Batches P1 and P2 change nothing the model sees.

### Batch P1 — Measure what is not measured (no ruling needed)

1. One trace row per model call (grouped by message id) and one task-level row with the SDK's own model time, number of model calls and duration. Proof: calls per task and pure model time readable from the trace.
2. One trace row per tool call with its duration and result size (today: last 100 per tool, in memory only).
3. Two trace events around a reply: the stage before the task (placeholder, enrichment, classifier, each in ms) and delivery.
4. Duration per scheduled job (today no job records how long it ran) — this is what settles the unexplained 12:00 and 05:00 UTC freeze clusters.
5. Ledger: carry the cost basis and the five-minute / one-hour write split through the runner path; give the post-reply extraction calls their own labels.
6. Price table: two entries carry wrong store prices, pinned by their tests (used only when the SDK reports no cost: 7 rows, $4.88 in 30 days).
7. Planning, reflecting and self-assessment of the heavy runner: phase rows in the trace.
8. Step timings in the deploy and boot logs (boot is serial before the server listens; 66 process starts in 30 days).

### Batch P2 — Stop the freezes (no ruling needed)

1. Bound the nightly whole-table read (05:59 UTC). One live row has a completion time after its update time, so the bounded form must test both columns.
2. Make the per-message "similar past tasks" lookup index-served so it stops reading the wide rows (live plan: an index on the spawn type only, then every root row). Its shadow output is unchanged.
3. Bound the embedding wait inside memory lookup at 1.5 s; text search still answers. Closes the gap between the code and the project's own written rule.
4. Then, from the job durations of P1.4: the canary, the nightly memory consolidation, the retention archive (compression on the main thread), the hourly knowledge-base reindex, in order of measured cost.
5. A size check before `file_read` reads and scrubs a whole file on the main thread (protected file; error text for oversize files is model-visible → batch P4 if the text changes).
6. Root cause, noted and not proposed now: chat tasks store the whole assembled prompt in a column that sits ahead of status and timestamps (average 38,573 characters × 3,645 chat rows ≈ 141 MB of the 178 MB table), so any query that reads those columns without a covering index reads the wide rows. Each fix so far covered one query (queue 4am, 4aq, 4bf, 4br). Moving the prompt to a side table closes the class; it is a large change touching protected files and waits for a ruling of its own.

### Batch P3 — The wait as the operator feels it (ruling 3)

1. The placeholder sent alongside the pre-task stage instead of before it (0.1–0.4 s). The typing sign is not built (ruling 1: no).
2. Second health probe (ruling 3) — operator-installed, like the watchdog change.
3. Voice messages: the handler waits for download and transcription while Telegram intake handles one update at a time (worst case about 90 s of blocked intake). Count voice messages first (P1.3), then decide.

### Batch P4 — Model-visible, with the one eval-gate run of batch 10 (rulings 4, 5)

1. Effort setting on the main path (ruling 4).
2. Stable tool list: design and numbers only (ruling 5). Inputs already measured: 278 tool-search calls in 30 days, most often followed by the same handful of tools.
3. Candidates that wait for P1 numbers before they are proposed: what planning and reflecting receive (the full chat prompt today); the second classifier call for 1 in 3 messages; a result-size limit for the largest tool outputs; the `task_history` search (scans every run's output per search word; 55 calls in 30 days).

### Batch P5 — Store lifetime (ruling 2: no, dropped)

Not built; one hour stays. The write split of P1.5 is still recorded, as a measurement only.

## What this review did not answer

- Pure model time per call (dropped today) and the real length of the pre-task and delivery stages — P1.
- What causes the freeze clusters at 12:00 and 05:00 UTC, and how long each scheduled job blocks — P1.4.
- How much of plan usage the store writes consume; whether any call in the window ran on overage.
- The current fixed effort value and whether any store-lifetime setting is already present in the service environment (operator-side; one yes/no check at build time).
- How many of the 66 process starts in 30 days were deploys, crashes or probe restarts.
- Share of run time spent inside tools (one reviewer estimated 4–12 %; not verifiable until P1.2).
- Four security-category notes surfaced on the way (credential placement in request addresses ×2, an operator command building queries from its arguments, personal data in public source) are passed to the Security and privacy dimension; detail off-repo.

## Next

The rulings are in (above). The tool-list study (ruling 5) starts now, read-only. After the Code queue: P1 → P2 → P3, and P4 with batch 10's eval-gate run. Re-score Performance after the proofs.
