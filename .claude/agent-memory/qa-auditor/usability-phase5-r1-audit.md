# Usability Phase 5 R1 audit — ritual diet + `/rituales` (2026-08-24)

**Verdict: FAIL — 3 Critical.** tsc clean; 123/123 Phase-5 scoped tests GREEN. The bundle is
well-tested against its own fixtures and near-inert (5.1/5.2) or actively harmful (5.6) against
the production corpus. Every finding below was reproduced by replaying REAL `tasks.output` rows
from `data/mc.db`, not fixtures.

Scope: NEW `src/rituals/{cron-next,sent-before,ritual-controls,signal-moves,rituales-command}.ts`
· REWRITTEN `delivery-policy.ts` · WIRING `dynamic.ts`, `scheduler.ts`, `signal-intelligence.ts`,
`messaging/router.ts`, `scripts/usability-metrics.ts`.

---

## Method (reusable)

Built a 202-row corpus of real ritual/schedule outputs:

```
sqlite3 -json data/mc.db "SELECT task_id,title,created_at,output FROM tasks
  WHERE (title LIKE 'Signal intelligence%' OR title LIKE '%Posthumanismo%' OR title LIKE '%Pharma%')
    AND output IS NOT NULL ORDER BY title, created_at ASC;"
# then JSON.parse(output).text
```

Replayed it through the REAL functions inside a temporary `src/rituals/__r1_*.test.ts`
(vi.mock `../db/index.js` → `new Database(":memory:")`, the same pattern the shipped tests use),
then deleted the files. **A scratch replay must live inside the repo** — vitest module resolution
of `./sent-before.js` fails from `/tmp`.

Two replays did the work:
1. **Sent-before replay** — chronological, back-dating `ritual_sent_items.created_at` per run so
   the 14-day window is real.
2. **MX-day budget replay** — every real ritual/schedule output from 08-09→08-24 sorted by real
   `created_at`, fed to `applyRitualDeliveryPolicy(id, taskId, text, {displayName, now})`.
   This is the finding generator; medians would have hidden C2 entirely.

---

## CRITICAL

### C1 — The reading budget defers everything after the first ritual; 700 words/day is unreachable

`delivery-policy.ts:340` (`const exempt = …alwaysDelivers`) + `:353`
(`used.pushes >= PUSH_CAP || used.words + words > WORD_CAP`).

Exempt rituals (Morning Sync, nightly-close) bypass BOTH caps but their words still land in
`ritual_deliveries.words`, so they eat the budget without ever being holdable.

16-day replay of real outputs:

```
2026-08-10  pushes=4 words=1105  deferred=[signal-intelligence, post, mex, market-eod-scan]
2026-08-13  pushes=4 words=1137  deferred=[signal-intelligence, post, mex, market-eod-scan]
2026-08-15  pushes=4 words=1165  deferred=[]
2026-08-21  pushes=4 words=1106  deferred=[signal-intelligence, post, mex, market-eod, wil]
Days over the 700-word target: 15/16
```

Per-ritual deferral rate over the window: Posthumanismo 11/11 weekdays · market-eod-scan 10/10 ·
MexicoNecesario 10/10 · Williams 2/2 · signal-intelligence 7/16 · pm-daily-rebalance 1
(**a `changed` PM report — Phase 0.3's whole point — silenced by the budget**, 08-23 13:00Z).

Real medians that drive it: signal-intelligence 611w (fires 06:00, non-exempt, first in the day) ·
Morning Sync 288w (exempt) · nightly-close 149w (exempt) · Posthumanismo 577w · market scans ~400w.
~440 of the 700 is consumed by the two rituals that cannot be held.

Fix: exclude exempt rituals from `budgetUsed` (measure only holdable pushes), or word-cap the big
producers via `RITUAL_WORD_CAPS` instead of deferring them wholesale.

### C2 — A push longer than WORD_CAP can NEVER be delivered

`delivery-policy.ts:353` — with `used.words = 0` and `words = 815`, `0 + 815 > 700` → defer.
There is no cap-and-send branch; only `RITUAL_WORD_CAPS` (`nightly-close` only) shortens text,
and it runs at `:334`, before the budget check.

Reproduced on real data: `2026-08-12 signal-intelligence raw=796w -> silence (budget) | dayTotal=0p/0w`
— deferred on a completely empty budget. Williams Journal median 815w (both runs deferred).
Any ritual that ever exceeds 700 words is permanently undeliverable and only ever reaches the
operator as "≤2 líneas" in the next Morning Sync.

Test gap: `delivery-policy.test.ts` "a push that would exceed 700 words is deferred even under the
push cap" pre-fills 650 words first — the empty-budget case is unpinned.

Fix: when `words > WORD_CAP` and `used.pushes === 0`, `capWords(text, WORD_CAP, pointer)` and deliver.

### C3 — Deferrals are consumed at prompt-build time by a free-text name match; a rename or a pause destroys them

`delivery-policy.ts:66` `MORNING_SYNC_NAME_RE = /morning sync/i` · `dynamic.ts:327`
`if (MORNING_SYNC_NAME_RE.test(schedule.name)) return takeDeferredBlock();` ·
`ritual-controls.ts:143` (`consumed_at` UPDATEd before the task runs) · `:119`
`pendingDeferrals(maxAgeHours = 36)`.

The ONLY consumer of `ritual_deferrals` is a schedule whose mutable `scheduled_tasks.name` matches
`/morning sync/i`. Three ways this loses content silently:
- `/rituales pausa <n of Morning Sync>` → `setScheduleActive(id,false)` → never runs → the 4–5
  deferrals/day (C1) age past 36 h and are dropped. No alert, no re-queue.
- Renaming the row (e.g. "Sync Matutino") does the same, AND silently removes the exemption so the
  Morning Sync itself starts getting budget-deferred.
- `maybeStrategicInjection` keys the SAME row by **ID** (`V82_SYNC_SCHEDULE_ID`,
  `lib/v8-2/flags.ts`). Two identity mechanisms for one row, nothing asserts they agree.

The 36 h drop is pinned as intended behaviour (`ritual-controls.test.ts` "deferrals older than
36 h are not folded"), so no test catches the loss.

Mitigations that hold today: Morning Sync 33/33 completed in 30 d; `retryScheduledTask` calls
`promptExtras` but is only reachable for `email`/`both` delivery, and Morning Sync is `telegram`.

Fix: key exemption + consumer on the schedule ID; alert (or re-queue) rather than silently expire.

---

## WARNING

### W1 — 5.1/5.2 sent-before is inert on the production corpus

`sent-before.ts:54-58` `itemKey` hashes the whole normalised line — including the leading
enumerator and the trailing scores — so a repeat that renumbers or rewords is a new key.

90-run signal-intelligence replay: **8/229 items dropped (3.5 %)**, and all 5 drops in the last
25 runs were process-narration headings, not findings:

```
DROP 2026-08-18 :: **Scoring all signals:**
DROP 2026-08-19 :: **Signal Scoring:**
DROP 2026-08-21 :: **Signal scoring:**
```

Pharma: **0/83 dropped over 25 runs**, while `Tudriqev` — the exact case §5.1 names — appears on
15/25 runs (also Pluvicto 15/25, PipeSong 15/25). 25 near-duplicates (jaccard ≥ 0.6 on >4-char
tokens) missed on signal, 3 on pharma, e.g.

```
new: 5. **AI in WhatsApp Business: Level 4 Autonomous Agents Standard** — 30-60% lead qualification…
old: 6. **AI WhatsApp Business Level 4 autonomous agents** — 30-60% improvement in lead qualification…
```

signal-intelligence is the ONLY ritual in `SENT_BEFORE_FILTER_RITUALS` and it gets no
`sentBeforeBlock` prompt lever (`dynamic.ts:328` serves DB schedules only), so the inert hard
filter is its sole mechanism. Fix: strip the bullet/enumerator before hashing; hash a title
prefix (to the first `—`/`:`); token-set signature for the URL-less case.

### W2 — `no_new_items` is the one silence path with no deferral

`delivery-policy.ts:310` records `delivered=0, reason='no_new_items'` and returns; `muted` (`:346`)
and `budget` (`:354`) both `enqueueDeferral`. Items include process headings (W1), so a digest
whose prose is entirely new can be dropped whole. **Observed rate 0/90 real runs** — latent, not
live (the same key brittleness that makes the filter inert also protects it). 20+ historical runs
had 1–3 items, all headings (e.g. 2026-06-26: the only item is `**Scoring summary (before
filtering):**`, 579 body words).

### W3 — `ledgerWords` mixes pre/post-deploy rows → words/day understated for a full window

`usability-metrics.ts:185-186` sums `words` over `delivered=1 AND words IS NOT NULL`;
`:204` divides by `effectiveDays`. Live `PRAGMA table_info(ritual_deliveries)` has **no** `words`
or `day` column today — all 13 existing rows migrate to NULL. Repro: deploy today, run
`./mc-ctl usability 7` tomorrow → 1 day of words ÷ 7 ≈ 86 % understatement, KPI green for the
wrong reason. Fix: divide by the count of days that actually carry ledger rows.

### W4 — Budget words are counted pre-deliverable-filter

The seam runs before `broadcastToAll`. Measured over 15 real signal runs: 8853 seam words vs
8465 post-`sanitizeDeliverable` words = **4.6 % overcount**. Small, but it is the KPI's own unit.

### W5 — `takeDeferredBlock` contradicts the Morning Sync's own length rule

`ritual-controls.ts:156` appends "No los omitas" + "≤2 líneas por cada uno" for N deferrals to a
prompt whose live `scheduled_tasks.description` says `Longitud: 150-250 palabras`. With C1
producing 4–5 deferrals/day that is +8–10 lines onto a brief already at a 288-word median.
Fix: cap the block at the 2 largest deferrals and restate the length budget inside it.

### W6 — Gate without a pin: the WA-group branch of the `/rituales` owner gate

`router.ts:1757` `if (this.operatorThreadKey(msg, tk) === undefined) return false;`. The group
branch (`msg.metadata.isGroup` + `senderJid !== ownerAddress`) has no test — `router.test.ts`
pins only the community-email fall-through. Deleting the group branch stays GREEN.

### W7 — `/rituales` numbering can shift between the list and the command

`rituales-command.ts:44-48` `scheduleVisible` uses a 30-day `last_run_at` window; `listSchedules(false)`
orders by `created_at ASC`. A schedule created — or an inactive one ageing out — between the two
messages renumbers everything after it. Concrete: Química (`last_run_at 2026-08-23`) leaves the
list on 2026-09-22.

### W8 — `nextCronFire` is a 188 ms synchronous block on the router's inbound path

Measured on the live 15-schedule set; dominated by the yearly `0 9 27 7 *` row scanning the full
8 days (11,520 `Intl.formatToParts`). Fix: short-circuit `dom`/`month` before formatting, or memoise.

---

## INFO

- **I1 dead code**: `router.ts:245` `DIGEST_RITUAL_IDS` / `:249` `buildRitualDigest` are unreachable
  for delivery — `skill-evolution` is their only member and it is in `SUPPRESSED_RITUALS`
  (`delivery-policy.ts:47-51`). Still computed at `router.ts:2722` and thrown away; the old test
  is now `it.skip(...)`.
- **I2**: `RITUAL_WORD_CAPS` holds only `nightly-close: 250`, whose real median is 149w (max 191
  over 15 runs) — `capWords` never fires in production. The rituals that need it
  (signal-intelligence 611/796, Williams 815) have none, which is what makes C2 bite.
- **I3 signal-moves: 2 of 3 tracked sources structurally excluded.** `signal-moves.ts:56` requires
  `collected_at >= datetime(now,'-6 hours')`, but `frankfurter`/`treasury` collect ~2×/day
  (14 distinct instants in 7 d; newest 2026-08-24 00:15 UTC). signal-intelligence fires at 12:00 UTC,
  so the newest FX/treasury row is 11 h 45 m stale and never enters `seen`. Only coingecko
  (342 instants/7 d) can ever produce a lead line. Fix: widen to ~26 h, or per-source.
- **I4**: `signal-moves.ts:68` takes the newest row `<= now-24h` with no floor → a collection gap
  yields a multi-day-old prior labelled "(24h)". Add `AND collected_at >= datetime(?, '-36 hours')`.
- **I5**: `delivery-policy.test.ts` `fillBudget(3,200)` then `fillBudget(1,90)` reuses
  `schedule:filler-0` / task id `f0`. Harmless id collision.
- **I6 checked, no action**: `RITUALES_RE = /^\/?rituales\b/i` accepts a slash-less command —
  **0 false positives across 3,098 real user messages** (`conversations` since 2026-05-01).
  Recorded so R2 does not re-raise it.
- Conventions clean: ESM, `import type`, no `any` in the new sources; `npx tsc --noEmit` clean;
  8 Phase-5 test files, 123/123 GREEN.

---

## Doctrine crumbs

- **A per-day budget whose exempt members still COUNT is not a budget** — it is a guarantee that
  the non-exempt members are starved. Enumerate, in fire order, what the exempt set consumes
  before the first holdable push is even considered.
- **A cap with only a "defer" branch and no "trim" branch turns any oversized producer into a
  permanent silence.** Check the single-item-exceeds-the-whole-cap case on an EMPTY budget.
- **Score a dedup key against the real corpus, not fixtures.** A full-line hash over
  model-authored text dedups nothing: the model renumbers and rewords every run
  (3.5 % caught, 25 near-dups missed). The fixture passed because the fixture was byte-identical.
- **A queue with exactly one consumer, selected by a mutable free-text name, is a delivery-loss
  device.** Ask what happens when the operator pauses or renames the consumer.
- **A silence path that does not enqueue a deferral is not the same feature as one that does** —
  diff the terminal branches of a seam against each other, not against the spec.
