# Usability Phase 5 R2 audit — R1 folds verified (2026-08-24)

**Verdict: FAIL — 3 Critical.** tsc clean; 256/256 scoped tests GREEN (8 Phase-5 files + router).
Everything below was reproduced by replaying 209 REAL `tasks.output` rows (2026-08-04 → 08-24)
through the shipped functions, or by mutation.

## Method

Corpus: `sqlite3 -readonly data/mc.db -json "SELECT task_id,title,created_at,output FROM tasks
WHERE output IS NOT NULL AND created_at >= '2026-08-04' AND (title LIKE 'Signal intelligence%' OR
… OR title LIKE '%[Scheduled]%') ORDER BY created_at ASC"` → `JSON.parse(output).text`.
Replayed inside `src/rituals/__r2_*.test.ts` (vi.mock `../db/index.js` → `:memory:`), back-dating
`ritual_sent_items.created_at` per run so the 14-day window is real; scratch files deleted after.
**A scratch replay must live inside the repo** (module resolution of `./sent-before.js`).

## R1 folds — verdicts

| R1 | fold | R2 |
|----|------|----|
| C1 | anchors exempt AND uncounted | **NOT VERIFIED** — starvation moved, see NEW-C2 |
| C2 | Telegram-only never word-deferred | VERIFIED (but push cap now blocks the same rituals) |
| C3 | ID-keyed sync + no-expiry deferrals | PARTIAL — see NEW-C3 |
| W1 | URL/title identity + Jaccard | **NOT VERIFIED** — 0/366 at the seam, see NEW-C1 |
| W3 | ledger words only if window covered | VERIFIED (guard correct; KPI reference wrong, NEW-W2) |
| W4 | words after sanitizeDeliverable | VERIFIED (`words===3` on a STATUS line) |
| W5 | one line per deferral, outside the limit | VERIFIED (~2 deferrals/day on the corpus) |
| W6 | WA-group member gate | VERIFIED by mutation (delete the `isGroup` branch → 2 RED) |
| W7 | inactive schedules sort last | **REGRESSED** — see NEW-W1 |
| W8 | fixed-minute 60-step | VERIFIED — 126 brute-force cases × both NY DST transitions, 0 mismatches |
| I1 | digest dead code removed | VERIFIED, no stale importers of `DIGEST_RITUAL_IDS`/`buildRitualDigest`/`MORNING_SYNC_NAME_RE`/`alwaysDelivers` |
| I3/I4 | signal-moves 26h/20-48h windows | VERIFIED — `collected_at` is 19-char space-separated, matches `datetime(?,?)` with an ISO+Z first arg |

## CRITICAL

### NEW-C1 — the 5.3 word cap starves the 5.1/5.2 ledger; sent-before drops 0/366

`delivery-policy.ts:395-398` caps `text` to `EMAILED_PUSH_WORD_CAP` (200), then `:445`
`recordSentItems(ritualId, taskId, text)` ledgers the **capped** text. signal-intelligence is
the only member of `SENT_BEFORE_FILTER_RITUALS` and is in `EMAILED_RITUALS`.

21-run replay:
```
AS SHIPPED (records the 200-word capped text): droppableItems=366 dropped=0 (0.0%) ledgered=54
IF RECORDED PRE-CAP:                          droppableItems=366 dropped=11 (3.0%) ledgered=378
```
The 11 pre-cap drops are exactly what §5.1 names (programmatic $5.16B ×4 days, WhatsApp AI ×2,
"Email enviado" status lines). Unpinned: hoisting `recordSentItems` above `capWords` keeps
70/70 GREEN. signal-intelligence also gets no `sentBeforeBlock` prompt (code rituals bypass
`promptExtras`), so after this it has NO dedup lever at all.
Fix: `const preCapText = text;` before the cap; record `preCapText`.

### NEW-C2 — the reading budget delivers 6 pushes / ~1350 words a day and defers the afternoon whole

Per-ritual, 21 real days, through the shipped seam:
```
Nightly close       21/21 delivered   Market EOD scan        0/15  DEFERRED (no email copy)
Signal intelligence 21/21             Williams Journal       0/3   DEFERRED (weekly, no email)
Morning Sync        21/21             Química Básica         6/20
Market morning scan 15/15             MexicoNecesario        6/16
Posthumanismo       15/15             PM daily rebalance    13 del / 7 unchanged (0.3 intact)
Days over 700w: 21/21 · days over 4 pushes: 19/21 · typical day 6 pushes / 1274-1513 words
```
`PUSH_CAP=4` is consumed by ~12:00 MX every day (nightly-close + Morning Sync are anchors and
free), so deferral is a pure function of fire time. R1's C1 rate for market-eod-scan (10/10)
became 15/15. Meanwhile `overWords` at `:429` is `emailed && …`, so Telegram-only pushes are
word-unbounded and the day lands at ~2× the 700-word target. The phase exit
("≤ 4 pushes/day, ≤ 700 words/day", plan §2 5.6) is unreachable by construction.
Fix: either count anchors in PUSH_CAP/WORD_CAP, or word-cap Telegram-only pushes with a
`mc-ctl task <id>` pointer (R1's own C2 fix) instead of exempting them; and give the
afternoon tier its own reserved slot so deferral is not fire-order-determined.

### NEW-C3 — `/rituales silencio` is silently void whenever the Morning Sync is paused

`delivery-policy.ts:404-416` — `defer()`'s "no consumer → deliver rather than lose" branch is
applied to the MUTE branch (`:418`) as well as the budget branch. `/rituales pausa <Morning Sync>`
sets `active=0` → `deferralConsumerActive()` false → an explicit operator silence delivers.
Repro (`REPRO A`): sync active → `{deliver:false, reason:'muted'}`; sync paused, same mute →
`{deliver:true, reason:'default'}`, 0 deferrals, ledger row says `default`, only a console.warn.
The delivery-safe direction is right for `budget` and wrong for `muted` — a mute is an
instruction, not an accident. Untested: the consumer-gate test (`delivery-policy.test.ts:355`)
only exercises `fillBudget(PUSH_CAP)`.
Fix: on `muted` with no consumer, enqueue the deferral anyway (it never expires) or drop, and
record `reason='muted'`.

## WARNINGS

- **NEW-W1 (regression from the W7 fold)** — `rituales-command.ts:72` sorts inactive last, so
  pausing renumbers. `:233` still prints `Reanuda con /rituales reanuda ${hit.n}` computed
  BEFORE the mutation. Repro D: `/rituales pausa 12` (MexicoNecesario) → "reanuda 12" → that
  command **resumes Química Básica**. Fix: echo the name, or re-render after the write.
- **NEW-W2** — `usability-metrics.ts:196` `ledgerWords` sums every `delivered=1` row incl.
  anchors, and `:152` `pushes` includes the email-only Pharma schedule (no ledger row, so
  `silenced/deferred` cannot subtract it). Rows "pushes / day ≤ 4" and "push words / day ≤ 700"
  therefore read ~7 and ~1350 forever. Add `AND anchor = 0`, or restate the targets.
- **NEW-W3** — a `V82_SYNC_SCHEDULE_ID` that matches no row (or a paused sync) makes
  `isMorningSync` false everywhere: exemption AND consumer vanish, so budget + mute go inert and
  everything delivers. Fails safe for loss, but disables 5.5/5.6 with only a per-push warn.
  Live value `6c312196-…089eb` resolves to the active row today.
- **NEW-W4** — `rituales-command.ts:44-48` `scheduleVisible` requires `last_run_at` for inactive
  rows, so pausing a never-run schedule removes it from `/rituales` entirely — unresumable
  from the phone.
- **NEW-W5** — `takeDeferredBlock` marks `consumed_at` at prompt build (`ritual-controls.ts:174`).
  A Morning Sync task that FAILS has already consumed them; `retryScheduledTask`'s
  `promptExtras` then returns "". Rows stay readable but never surface.

## INFO / verified negatives

- No double ledger row on the delivery-miss retry: `handleScheduledTaskResult` returns at
  `dynamic.ts:646` before the seam.
- `defer()` returning the pre-defer `decision` is harmless: both call sites use it only as a
  boolean and `:441` rebuilds from the local `text`/`words` (REPRO E: capped 209 w + pointer).
- `Date.parse("YYYY-MM-DD HH:MM:SSZ")` → correct UTC under `TZ=America/Mexico_City`.
- ALTERs apply cleanly on a snapshot of the live 14-row `ritual_deliveries` (words/day NULL,
  anchor/emailed 0; `budgetUsed` filters `day = ?` so legacy rows never count).
- `ritual_sent_items` does not exist live; `tokens` is added by ALTER even on a fresh DB
  (not in the CREATE) — works, but belongs in the CREATE.
- All 3 `EMAILED_RITUALS` genuinely call `gmail_send` (14/15 market-morning runs show evidence),
  so "📄 Completo en el correo" is truthful. `market-eod-scan` does NOT email — which is why
  deferring it 15/15 is content loss, not a pointer.
- `no_new_items` fired 0/21 — latent, as in R1.
- No live LLM broadcast bypasses the seam: proactive nudge env-gated off, overnight-tuning
  `enabled:false`, `src/lib/s3/push.ts` has no caller; all other `broadcastToAll` are `{raw:true}`.
- `interceptRituales` runs before `interceptPendingConfirmation` — a `/rituales` while a
  confirmation is pending leaves the confirmation pending. Cosmetic.
- `takeDeferredBlock` age label `Math.round(ageH/24)` says "2 días" at 37 h.

## Doctrine crumbs

- **A filter and its own corpus writer must see the SAME text.** When a pipeline both trims a
  payload and ledgers it, the ledger must be fed the pre-trim copy — otherwise the dedup
  feature is starved by the cap that ships beside it (0/366 vs 11/366). Diff the value passed
  to the recorder against the value the matcher will see next run.
- **Exempting members from a cap does not reduce the load they impose.** Excluding anchors made
  the budget arithmetic honest and the reading load worse (4 → 6 pushes/day). Re-measure the
  OUTCOME the phase promised, not the invariant the fix restored.
- **A cap consumed in fire order is a schedule, not a budget.** With PUSH_CAP spent by noon,
  "lower priority" silently means "later in the day" — and the later rituals were the ones
  without a second copy.
- **A fail-open added for one silence reason leaks into the other.** "Deliver rather than lose"
  is right for an accidental hold and wrong for an operator's explicit mute. Split the branches.
- **A stable-numbering fold must fix the ECHO too.** Sorting the list changed what number N
  means; the confirmation line still quoted the pre-sort N and pointed the operator at a
  different ritual.
