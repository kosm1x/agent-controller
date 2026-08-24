# Usability Phase 5 R3 audit — verdict verification (2026-08-24)

**Verdict: PASS WITH WARNINGS — 0 Critical, 4 Warnings. Closure-ready YES.**
tsc clean; 411/411 across 25 files (`src/rituals` + `src/messaging/router.test.ts`).
Every R2 fold re-verified by my own mutation or replay; 13 mutations independently RED.

## Method (R3)

Corpus rebuilt from live `data/mc.db` READ-ONLY: 229 real `tasks.output.text` rows,
2026-08-04 → 08-24, ordered by **`completed_at`** (the seam runs at completion, not
submission) and with the **email-only Pharma schedule excluded** (delivery='email'
never reaches `broadcastToAll`, so it consumes no budget). Replayed inside
`src/rituals/__r3_*.test.ts` (vi.mock `../db/index.js` → `:memory:`), deleted after.

> **Both methodology choices are load-bearing.** Ordering by `created_at` inverts
> the market-morning-scan / signal-intelligence outcome (10/0 ↔ 1/9) because both
> cron at 12:00 UTC and only completion times separate them (06:01:19 vs 06:03:43).
> Feeding Pharma through the seam produces 3.73 p/d · 600 w/d · 1 day >700w — a
> false FAIL. With both corrected my numbers match the ship record to the decimal.

## R2 folds — verdicts

| R2 | fold | R3 |
|----|------|----|
| C1 sent-before ledger starved by the cap | `ledgerText` captured pre-cap | **VERIFIED** — mutation M1 (`ledgerText`→`text`) RED. Isolated replay: 21 dropped / 368 ledgered; post-cap mutation: **0 dropped / 4 ledgered** (the exact R2 failure) |
| C2 6 pushes / ~1350 w, exit unreachable | plan-literal caps, anchors count, per-push word caps, emailed share | **VERIFIED** — my replay: **3.67 pushes/day (max 4), 551 words/day (max 663), 0 days over either cap** over 14 d. Per-ritual matches the ship record exactly (close 14/0, sync 14/0, mm-scan 10/0, pm 9/0, signal 4/10, Posthum 4/6, MexNec 0/10, eod 0/10, Williams 0/2) |
| C3 mute void when the sync is paused | consumer gate deleted; `defer()` always enqueues | **VERIFIED** — `deferralConsumerActive` grep-absent repo-wide; the pin seeds a PAUSED sync (`seedSync(0)`); M4 RED |
| W1 pause echo quoted the pre-sort number | echo the name | **VERIFIED** — M12 RED |
| W2 metrics charged Pharma's email as a push | ledger pushes+words when covered | **VERIFIED** — email-only schedules only reach `recordSentItems`, never the ledger |
| W3 unmatched `V82_SYNC_SCHEDULE_ID` | unchanged, fails safe | carried (live id resolves) |
| W4 never-run paused schedule invisible | `last_run_at ?? created_at` | **VERIFIED** — M7 RED |
| W5 consumed at prompt build | `deferralsUpTo` + consume on `tally.sent>0` | **VERIFIED** — M5 RED; the pin covers build / sent=0 / delivered |
| R1 W6 WA-group owner gate | — | **VERIFIED** — deleting the `isGroup` branch → 2 RED |
| R1 W8 `nextCronFire` 188 ms | fixed-minute 60-step | **VERIFIED** — 24 live crons in **28.2 ms** |
| migration | PRAGMA-guarded ALTERs | **VERIFIED** on the live 14-row snapshot: idempotent ×3, legacy rows `words/day` NULL ⇒ `budgetUsed` (filters `day = ?`) reads 0 |

Extra mutations RED (mine): M2 anchors excluded from `budgetUsed` (8 RED) · M3 capped
handle removed · M6 capped row not pre-consumed · M8 anchor reservation removed ·
M9 emailed share removed · M10 word cap removed · M11 36 h expiry restored.
**13 independently RED in R3.** The 17 R1/R2 mutations were not re-run (out of scope).

## WARNINGS (new in R3)

### W1 — the deferral block is unbounded; the fold that removed expiry created it
`ritual-controls.ts:149` `pendingDeferrals()` has no LIMIT; `deferredBlock` no row cap
(only `DEFERRAL_TEXT_CAP = 1500` per row). Measured on the 14-day corpus:
```
sync consuming daily : max 4 rows /  5,923 chars   (/rituales tail 199 ch)
sync NOT consuming   : max 35 rows / 40,834 chars  (/rituales tail 2,044 ch)
```
40 KB into a `fast` prompt whose own description is 3.0 KB, plus "UNA línea por cada
uno" for 35 items. Triggered by exactly the case the R1-C3 fold protects (paused sync,
repeated `tally.sent===0`). Fix: newest 8 rows + "…y N más: /rituales".

### W2 — nothing verifies the sync carried the deferrals, and the block contradicts the sync's own rules
`dynamic.ts` consumes on `tally.sent > 0` alone. The live Morning Sync description
(2,995 chars) says: *"Cada afirmación del briefing debe rastrearse a una línea concreta
de lo que leíste en los PASOS 1-2"* and *"NUNCA inventes nombres de personas, proyectos
o eventos. Si un nombre no aparece textualmente en el day-log, el calendario o el KB
que acabas de leer, no existe para este briefing."* The injected block asks for a
"Diferido de ayer" section naming projects absent from PASO 1-2. A model obeying the
description drops it — and the rows are consumed anyway. `pendingDeferrals` filters
`consumed_at IS NULL`, so `/rituales` stops listing them: the text survives in the
table but the id is un-enumerable. Fix: consume only when the outbound text carries at
least one folded `/rituales completo <id>`, or add the exemption to the description.

### W3 — "0 repeats > 2 days" is measured over TASK rows, not the ledger
`scripts/usability-metrics.ts:224` `for (const p of delivered)` where
`delivered = pushes.filter((p) => !suppressedTitles.test(p.title))` is the **tasks**
query. 5.1/5.2 dedup and 5.6 deferral both act on DELIVERY, so neither can move this
KPI. Live: 1 (7 d) / 2 (30 d). Fix: build `byPrefix` from `ritual_deliveries` under the
same coverage guard as pushes/words.

### W4 — `mc-ctl usability <days>` reads the pre-Phase-5 fallback for `days` days after deploy
The coverage guard needs `MIN(created_at) <= now-days`. Live today: **8.9 pushes/day,
3,289 words/day** — the operator will read a hard FAIL for a week. Operator line:
`./mc-ctl usability 1` from the second day after deploy.

## RECOMMENDATIONS

- **Budget deferrals collapse 3 causes into `reason='budget'`.** 14-day attribution:
  `signal-intelligence {emailedShare:5, pushCap+emailedShare:5}` · Posthumanismo
  `{pushCap:5, pushCap+wordCap:1}` · MexNec `{pushCap:10}` · eod `{pushCap:8, +wordCap:2}`
  · Williams `{pushCap:1, +wordCap:1}`. The fire-order ruling needs this split visible.
- **A capped delivery is invisible in the ledger** (`reason='default'`, `words` post-cap)
  and has no log line. 14-day: 8 telegram-handle + 14 email-pointer capped deliveries.
- **capped-then-deferred = a two-hop chain.** 18/38 budget rows hold the 250-word capped
  text whose tail points at the pre-consumed `capped` row with the full text (example:
  budget #3 "Posthumanismo" 1,087 ch → capped #2 3,656 ch). Reachable, verified, but
  store the pre-cap text on the budget row instead.
- `deferredBlock` says `terminando con su comando "/rituales completo <id>" tal cual` —
  "tal cual" on a literal placeholder. (`formatForTelegram` escapes `<` first, so it
  renders; the risk is the model printing the placeholder, not a delivery failure.)
- A deferred percent restated in the sync gets `(sin verificar)` — `auditNumbers` →
  `["−1.2%"]`, 1 inline mark on a 3-line fold. Honest, mildly noisy.
- A PAUSED Morning Sync keeps its reserved slot (`anchorsPending` stays 2) — pausing it
  costs 1 push/day of headroom instead of freeing it (measured 2 optional either way).
- `nextCronFire` returns null past 8 days ⇒ the ACTIVE yearly VLMP row `0 9 27 7 *`
  renders "→ sin próxima corrida".
- **Standards**: the 4 new `ritual_deliveries` columns + `ritual_sent_items.tokens` are
  PRAGMA-guarded ALTERs inside `ensure*Table`, not `SCHEMA_MIGRATIONS` entries
  (CLAUDE.md: "NEW column adds/drops go there … never as bare ALTER probes"). Verified
  idempotent on the live snapshot ⇒ convention deviation, not a defect.

## Security / resilience / observability checklist

- **`/rituales` owner gate: SOUND, layered.** Telegram adapter `chatId !== OWNER_CHAT_ID
  → return`; WhatsApp DM `jid !== OWNER_JID → continue`; WA groups carry `senderJid` and
  `operatorThreadKey`'s group branch rejects non-owners (2 RED on deletion); email needs
  `mode === "owner-only"`. `getDeferral`'s ONLY caller is the gated command ⇒ no
  non-owner path to another population's content.
- Pointer lines all survive `sanitizeDeliverable`: `/rituales completo N`, `mc-ctl task`,
  the omitted-signals footer, the `📈 Movimientos` lead (incl. as first line).
- Degrade: `isRitualPaused` fails open; `promptExtras` → `""` on a broken DB (pinned);
  `applyRitualDeliveryPolicy` catch → DELIVER raw; `safeTrackedMoves` → `[]`.
- Telegram chunks via `formatForTelegram`, so the ~1.9 KB listing is not truncated.
- Greppable: `[router] ritual X not broadcast (r)`, `[schedules] "N" not broadcast (r)`,
  `[schedules] "N" delivered — K deferral(s) consumed`, `[rituales] channel=…`.
  Missing: any line for a CAP.

## Count-sweep corrections for the ship record

- New files are **11, not 10** — add **`src/rituals/dynamic-budget.test.ts` (8 tests)**.
- Also *modified*: `src/messaging/router.test.ts`, `src/rituals/scheduler.test.ts`,
  `src/rituals/delivery-policy.test.ts` (not only "callsites").
- Per-file totals verified: cron-next 10 · sent-before 16 · ritual-controls 8 ·
  rituales-command 13 · signal-moves 7 · dynamic-budget 8 · delivery-policy 42 ·
  scheduler 40 · router 118 → **411 / 25 files** ✓.
- State the replay method (completed_at ordering + Pharma excluded) — without it the
  numbers are not reproducible.

## Scoreboard: pre-existing vs bundle-regression

24 of 25 R1/R2 findings are **bundle-regressions** — the 5 sources are untracked,
`delivery-policy.ts` is a +349-line Phase-5 rewrite of a Phase-0.3 file (budget, mute,
sent-before, caps all new), and dynamic/scheduler/router/signal-intelligence/
usability-metrics are bundle-touched callsites. **1 pre-existing**: R1-I1
`DIGEST_RITUAL_IDS`/`buildRitualDigest` dead code, from `df8f369 feat(rituals): digest
delivery for skill-evolution broadcast` — removed by this bundle.

## Trade-off: DEFECT or RULING

- **Fire order among optional rituals — RULING.** The mechanism is bounded and lossless:
  over the cap ⇒ enqueued, never expires, reachable by id, folded into the next
  delivered sync. What fire order decides is which of the OPERATOR'S OWN schedules gets
  the live push: eod 0/10, MexNec 0/10, Williams 0/2, Posthum 4/6, signal 4/14 — and 5
  of signal's 10 deferrals are the emailed share alone, i.e. a 47-word market scan
  completing at 06:01 takes the day's single emailed slot from a ~600-word digest
  completing at 06:03. No code can decide which the operator wants; the levers exist.
- **Words not reserved for anchors — RULING, cost measured.** A day can end at ≤700 +
  the close. Worst observed over 22 replayed days with the then-live set (Química
  active): **729 words on 2026-08-16 (+4 %)**; excl. Química the 21-day max is 697 and
  the 14-day max 663. Reserving the close's 250-word cap would defer an operator reading
  daily. Correct trade — publish the 729 number.
- Note for the ship record: exit criterion "Morning Sync untouched" holds for DELIVERY
  (14/14, always exempt) but NOT for its PROMPT — the bundle adds 5.9 KB (normal) to
  40.8 KB (degraded) on top of a 3.0 KB description.

## Doctrine crumbs

- **A seam that runs at COMPLETION must be replayed in completion order.** Two rituals
  cronned at the same minute are separated only by runtime; `created_at` ordering
  inverted which one won the day's single emailed slot (10/0 ↔ 1/9). Ordering IS a
  finding-generator, not a detail.
- **A replay must exclude the populations the seam never sees.** Feeding an email-only
  schedule through a broadcast seam manufactures a FAIL (600 w/d, 1 day over) out of a
  PASS (551 w/d, 0 days over). Enumerate every `delivery` mode before replaying.
- **Removing an expiry converts a loss bug into an unbounded-growth bug.** "Nothing
  expires" fixed the drop and created a 40 KB prompt; the same degraded state (paused
  consumer) drives both. A queue fold needs a size cap in the same commit.
- **A prompt block injected into someone else's prompt must be diffed against that
  prompt's own rules.** The deferral block asks for content the Morning Sync's fidelity
  rules forbid — and consumption is stamped on broadcast success, not on the content
  landing, so the handoff is unverified in exactly the case it fails.
- **An exit criterion measured over the wrong population can never move.** "0 repeats >2
  days" counts task rows; every mechanism the phase shipped acts on delivery rows.
