# V8.2 sync-surfacing R1 (2026-08-03) — brief retired, Morning Sync becomes the strategic surface

Bundle: migration v4 (`judgments.surfaced_at`), `src/lib/v8-2/sync-surfacing.ts` (new),
`dynamic.ts` injection + consent stamp, `broadcastToAll` → `{sent,failed}`,
§12 linkage accepts `surfaced_at`, §13 promote-rate SKIP, morning-briefing ritual disabled.

**Verdict R1: FAIL — 3 Critical.**

## DOCTRINE (transferable)

1. **"Resolved ≠ delivered" — audit the ADAPTER, not just the tally.** The bundle
   correctly made `broadcastToAll` return `{sent, failed}` and stamped consent only on
   `sent > 0`. But `src/messaging/channels/telegram.ts:636-639` catches a send failure and
   `return "error"` — it RESOLVES. `router.ts:2262 .then(() => { sent++ })` counts it.
   So `sent>0` is NOT a delivery proof. The adapter's own doc comment (telegram.ts:607-613)
   states the exact invariant line 638 breaks. Pre-existing latent bug; the bundle made it
   CONSENT-BEARING. **Rule: when a new feature starts trusting an existing boolean/counter,
   re-derive that counter from its leaf producer — every `.catch(() => sentinel)` on the way
   down invalidates it.** Multi-chunk amplifies: the appended line lives in the LAST chunk
   (`TG_MAX_LENGTH = 4096`, formatter.ts:8), so chunk-2 failure = line never seen, still stamped.

2. **An env-flag gate is fail-OPEN in any process that doesn't load `.env`.**
   `activation-gate.ts:342 const briefDeliveryOff = process.env.V81_BRIEF_DELIVERY_ENABLED !== "true";`
   The ONLY non-test consumer is `scripts/briefing-gate.ts:56` via `mc-ctl briefing-gate`
   (`mc-ctl:2897`), and **mc-ctl deliberately never sources `.env`** (`mc-ctl:46-51` — sourcing
   aborts under `set -u` on `$N` values; it uses a single-key `env_value()` extractor).
   The service gets env from systemd `EnvironmentFile=`; the CLI gets NOTHING.
   **Empirically proved by running `./mc-ctl briefing-gate` pre-arming:** it printed
   `✓ brief delivery off (surface retired…) ; promote-rate not scored` on the SAME report that
   showed `morning: 8 generated · 5 promoted · 2 discarded · 1 pending · 71.4% (of 7 ruled)`.
   7 live rulings in-window while the gate says the surface is retired.
   **Rule: before believing `process.env.X` gates anything, identify the PROCESS that runs the
   code and how ITS env is populated. systemd EnvironmentFile ≠ operator shell ≠ `npx tsx`.**
   Prefer an in-code constant or a file read for a retirement switch; `!== "true"` defaults to
   the dangerous side.

3. **A "read-only" script that calls `initDatabase()` runs the migration ladder.**
   `scripts/briefing-gate.ts:10` claims "Read-only — no writes"; my single invocation emitted
   `[db] schema migration v4 applied` against live `data/mc.db` while mission-control held it
   open. Migration landed on prod from an operator CLI, out-of-band from `scripts/deploy.sh`.
   (Silver lining: proves the ALTER is safe under WAL with the service running.)
   **Rule: grep any `scripts/*.ts` claiming read-only for `initDatabase(` — it is a WRITER.**

## Verified sound (adversarial checks that found nothing)

- §12 consent SQL: truth table run on a live snapshot. both-NULL→0; malformed `nowIso`→NULL
  (falsy in JS → over-DEMOTE, safe); ISO-format `surfaced_at` vs space-format now→0 (fails safe);
  space-past→1; future→0. The duplicated `nowIso` bind (`judgment-linkage.ts:83`) is correct.
- `datetime(created_at)` handles the producer's real ISO-T rows (`…T12:00:59.190Z` →
  `2026-08-03 12:00:59`); 24h window returned 3 rows, not a lexically-stretched 6.
  All 4 live postures (`highest_leverage/at_risk/momentum/noted`) are in `POSTURE_PRIORITY`.
- `criticVerdict` (judgment-format.ts:45) returns `"—"` on null/unparseable → never "approved".
- Disabling a ritual in `config.ts` does NOT trip staleness alarms: `getRitualStaleness`
  (prometheus.ts:277) iterates the heartbeat MAP, not the config array. A ritual that never
  scheduled cannot go stale. Checked because "disable a ritual → MCRitualLoopStale" was the
  obvious hypothesis; it was wrong.
- Email-retry path drops `strategic` (`dynamic.ts:585` passes only 3 args) — NOT reachable:
  the designated surface `6c312196-… "Morning Sync — Piotr 8am"` has `delivery='telegram'`,
  so `expectsEmail` is false. Latent if delivery is ever changed to `both`.
- `pendingScheduled.delete` before the async chain + captured `meta` → no TOCTOU, no double-fire.

## Warnings recorded

- `executeScheduleNow` (schedule.ts:145, tool-invoked run-now) and the 08:00 cron both call
  `maybeStrategicInjection` independently → same judgment appended twice if both picks land
  before either stamp.
- `PendingSchedule.strategic` is in-memory → restart between submit and completion silently
  drops the day's reading (fails safe, no stamp).
- Consent semantics narrowed: the stamp certifies `subject + firstSentences(prose, 220)` with
  NO verdict affordance, vs the retired brief's full judgment + promote/discard. §12 treats
  them as equal strength.

---

# R2 (fix-the-fix, same day) — verdict FAIL, 1 new Critical

C1 fixed at `telegram.ts:641-647` (rethrow), C2 fixed by DELETING the env read →
`export const BRIEF_SURFACE_RETIRED = true` + `evaluateActivationGate(opts?)`
(code constant = deliberate-commit-to-reverse; the right shape for a ruling).

## NEW DOCTRINE

4. **A suppression fix converts a BENIGN leak into a PERMANENT outage.** W1's fix
   scans `pendingScheduled` for an in-flight strategic run (`dynamic.ts:234-238`).
   But `router.ts:3003-3020 handleTaskCancelled` has **no `isScheduledTask` branch**
   — unlike `handleTaskFailed` (2870) and the completed path (2455). Map deletes
   exist only at `dynamic.ts:607/705`; no reaper, no TTL, no cap. So a CANCELLED
   strategic run leaks an entry that silently suppresses the injection for that
   schedule for the life of the process. **Rule: when a fix starts READING a
   long-lived map/set as a guard, enumerate every terminal path that must delete
   from it — the leak was harmless until you gave it authority.**

5. **Fixing one adapter is not fixing the bug class.** `whatsapp.ts:364-366` and
   `375-379` still `return "queued"` from the disconnected branch AND the catch —
   resolve-on-failure, exactly R1-C1. Counted by `router.ts:2262 .then(()=>{sent++})`.
   Verified LATENT not live: `journalctl -u mission-control --since -14d |
   grep -c "WhatsApp channel active"` → **0** (gate: `messaging/index.ts:25
   WHATSAPP_ENABLED`). Flipping it on re-opens the consent over-claim AND defeats
   five `sent === 0` guards: `briefing/delivery.ts:91` (delivered_at — the ORIGINAL
   §12 path), `no-verdict-reminder.ts:132`, `prometheus-alert-poller.ts:285`,
   `scheduler.ts:172`, `x-poster/probe-cron.ts:91`. Email is clean
   (`email.ts:767` rethrows, with the comment explaining why).
   **Rule: grep every sibling implementation of the interface, then prove
   reachability from journalctl before grading severity.**

## R2 verified clean

- Telegram rethrow escapes nowhere: all 5 `adapter.send` sites guarded —
  `router.ts:2261/2316` (.catch→failed++), `3071`, `3117` (.catch), `3163` (try).
  Nothing reads the old `"error"` sentinel. Callers became MORE strict.
- Gate const: sole consumer `scripts/briefing-gate.ts:56` (no-arg). No v82/v83
  path imports `evaluateActivationGate` or `checks.promoteRate`.
- `briefSurfaceRetired:false` branch is byte-equivalent to pre-bundle logic.
- `delivery==="both"` still loses the line on an email-miss retry (returns before
  the broadcast; `retryScheduledTask` re-watches without `strategic`) — no stamp
  (safe), but silent. Latent: Morning Sync is telegram-only.
