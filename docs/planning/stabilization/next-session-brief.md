# Next Session Brief — Hardening Phase

> **Authored**: 2026-04-26 end-of-Session-111 · **Refreshed**: 2026-05-03 post-Session-124 (V8 S2 + per-bank Hindsight routing)
> **Window**: 2026-04-22 → 2026-05-22 (day 12 of 30)
> **Re-benchmark target**: 2026-05-22 vs `docs/benchmarks/2026-04-22-baseline.md`
> **Phase posture**: Hardening + reliability only. Feature freeze in effect — see `30d-hardening-plan.md` separation policy.

---

## Session 124 close (2026-05-03 ~07:00 UTC)

Two ships, both freeze-aligned:

| Ship                             | Commit    | Tests | Surface                                                                                                                                                                                                                                                                              |
| -------------------------------- | --------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **V8 substrate S2 — self-audit** | `095647b` | +44   | `src/audit/self-audit.ts` + `src/audit/cli.ts` + `mc-ctl audit-claim METRIC [--window=Nh] [--stratify-by=COL] [--baseline=N] [--min-n=N]`. Stratify-and-warn (small-n / dominance / divergence / baseline) BEFORE the headline. CLAUDE.md doctrine: invoke before reporting metrics. |
| **Per-bank Hindsight disable**   | `267dba0` | +6    | `HINDSIGHT_RECALL_DISABLED_BANKS=csv` skips Hindsight for listed banks; logged as `recall_audit.source='bank-disabled'`. Retain/reflect untouched (bank stays current). Source enum widened in `recall-utility.ts`; all consumers swept.                                             |

**Suite**: 4023 + 1 todo → **4073 + 1 todo** (+50 net). Pre-commit hook validated both.

### Surprising finding the audit caught immediately

7d post-tune utility on the new audit-claim:

```
n=294, headline=19.0%
Stratification:
  mc-jarvis        n=145   30.3%
  mc-operational   n=145    8.3%
WARNING: stratification-divergence
```

This is the **inverse** of yesterday's working H/D/R hypothesis (HARDEN mc-operational + DEMOTE mc-jarvis). Aggregate 19% would have hidden the inversion. **Do not act on this single window** — Path 1 tuning landed midnight 2026-05-03; the data so far is recovery transient. Wait for:

1. The 24h `recall-checkpoint.timer` at 2026-05-04 01:00 UTC (already armed)
2. The 48-72h `mc-ctl recall-compare 30 14d` re-run with fresh queries
3. A second mc-ctl audit-claim 7d run after both checkpoints have landed

If the inversion holds through both, the 5/13 H/D/R verdict becomes:

- **mc-operational** → DEMOTE (set `HINDSIGHT_RECALL_DISABLED_BANKS=mc-operational` and stay on SQLite — primitive shipped this session)
- **mc-jarvis** → HARDEN (Hindsight is now the better path on this bank)

If the inversion is just transient (post-tune metric noise), keep the original hypothesis.

### V8 substrate ladder

- S1 cache-aware prompts ✓
- **S2 self-audit before reporting ✓ (this session)**
- S3 drift detector ✓
- S4 cost_ledger v2 ✓
- S5 skills-as-stored-procedures — deferred past freeze (feature, not hardening)

Substrate work complete inside the freeze window.

---

## End-of-day health snapshot (2026-05-03 00:35 UTC, post-Path-1-tune)

| Item                         | Reading                                                                           | Status                                                    |
| ---------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Service                      | active, PID 1802665, uptime fresh post systemctl restart                          | green                                                     |
| Hindsight container          | `crm-hindsight` healthy, cap=100, qwen3-coder-plus                                | green                                                     |
| mc Hindsight client          | `HINDSIGHT_RECALL_TIMEOUT_MS=8000` verified in /proc/PID/environ                  | green                                                     |
| **30-query A/B (post-tune)** | Hindsight 19/30 success (was 0/30 pre-tune); mc-operational 15/15, mc-jarvis 4/15 | yellow (mc-jarvis still degraded by design at 1,637 mems) |
| SQLite avg latency           | 438ms (top-3 relevant in 30/30 cases)                                             | green (rock-solid fallback)                               |
| mc-jarvis bank               | 1,637 memories, RED in hindsight-monitor since at least 2026-05-02                | yellow — cap re-tuned, root issue is bank size            |
| Tests                        | 4024 (4023 + 1 todo), 248 test files, 0 type errors                               | green                                                     |
| **H/D/R input collected?**   | Yes — 30-query A/B captured pre + post tuning, bank-stratified                    | green (data ready for 5/13 decision)                      |

**Today's lesson (`feedback_recall_aggregate_hides_bank_collapse.md`)**: yesterday's "trilogy delivered 22.2% utility" headline was 88%-on-69mem-bank diluting 7%-on-1637mem-bank. The aggregate-vs-stratified gap masked a complete collapse on the operator's primary bank. Always bank-stratify recall metrics; tune cap to the LARGEST bank, not the aggregate.

**Path 1 tuning applied** (rehab playbook formula, day 12 of 30 freeze, ops-only):

- `crm-azteca/.env` — `HINDSIGHT_RERANKER_MAX_CANDIDATES` 60→100, container restarted
- `mc/.env` — `HINDSIGHT_RECALL_TIMEOUT_MS` 5000→8000, mc restarted
- `mc-ctl recall-compare` cap raised 20→50 so the H/D/R-decision A/B can run at the intended N=30 without silent truncation

**Result**: mc-operational fully recovered (0/15 → 15/15). mc-jarvis partially recovered (0/15 → 4/15). The 1,637-mem bank's parallel_retrieval phase dominates the time budget, leaving inadequate room for reranking even at cap=100/8s timeout. Per playbook, even cap=200/12s would only push mc-jarvis success to ~50% — and 12s tax per miss is too long for chat.

**Strategic shape for the 2026-05-13 H/D/R decision**: per-bank verdict, not single-stack.

- **mc-operational** → HARDEN. Hindsight delivers, current tuning is correct, ship the operational improvements (e.g., bump red-alert thresholds into mc-side logging, not just out-of-tree audit DB).
- **mc-jarvis** → DEMOTE. Set `HINDSIGHT_RECALL_ENABLED=false` on this bank specifically (mc supports per-bank routing). SQLite returned 30/30 semantically relevant top-3 in the A/B at 438ms — operationally superior on this bank.

---

## Tomorrow's queue (24h validation cadence)

1. **24h post-tune recall_audit re-baseline** — fires automatically Mon 2026-05-04 01:00 UTC via `recall-checkpoint.timer`. Output at `docs/audit/latest-recall-checkpoint.md`. **Now also run `mc-ctl audit-claim utility --window=24h --stratify-by=bank --baseline=0.222`** for the warning-aware verdict. If the 22pp inversion above persists, escalate the H/D/R working-hypothesis flip discussion.
2. **Verify circuit breaker fires under the new 8s cap**: `journalctl -u mission-control --since '24h ago' | grep "Circuit breaker OPEN"`. Breaker was tuned to 5s timeouts; check it still triggers correctly at the new 8s tax.
3. **Re-run `mc-ctl recall-compare 30 14d`** in 48-72h with fresh queries from new operator traffic, verify the post-tune ratios hold.
4. ~~Operational tightening — bring red-alert thresholds into mc-side logging~~ — _superseded by the V8 S2 self-audit (Session 124)._ The audit-claim verdict is the new way to surface bank collapse at recall time. The "extend `mc-ctl status` with per-bank counts" idea remains pickable when it becomes operationally necessary, but it's no longer the only path to visibility.
5. ~~Decide whether to commit per-bank `HINDSIGHT_RECALL_ENABLED` routing~~ — **DONE Session 124, commit `267dba0`.** `HINDSIGHT_RECALL_DISABLED_BANKS=csv` is the primitive. Operator action when a verdict crystallizes: `echo 'HINDSIGHT_RECALL_DISABLED_BANKS=mc-XXX' >> mc/.env && systemctl restart mission-control`. Verify via `mc-ctl recall-utility 1h` showing `bank-disabled` rows.

---

## Original end-of-day health snapshot (2026-04-30 00:32 UTC, post-trilogy deploy)

| Item                       | Reading                                                                                   | Status                                          |
| -------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Service                    | active, PID 138425, uptime fresh post `./scripts/deploy.sh`                               | green                                           |
| Hindsight                  | container healthy                                                                         | green                                           |
| Drift detector             | `mc-ctl drift` exit=0, all invariants hold                                                | green                                           |
| Schema migration           | recall_audit has match_type + overlap_score + excluded_count                              | green                                           |
| **`recall-compare` smoke** | Hindsight 5005ms timeout, SQLite 413ms top-3 with relevant Williams Radar journal results | green (eval tool live + producing real signal)  |
| **Trilogy commits**        | A `d8f32f0` + B `aab1b05` + C `926036e` all on origin/main                                | green                                           |
| Tests                      | 4024 (4023 + 1 todo), 248 test files, 0 type errors                                       | green                                           |
| Yesterday's 🟠 watchpoint  | DIAGNOSED: 3 distinct problems, all addressed by trilogy                                  | resolved (instrument fix re-baselines tomorrow) |

**Yesterday's watchpoint resolution** (`feedback_watchpoint_diagnose_before_decide.md`):

The 95%-timeout / 0%-utility headline that yesterday's brief flagged as "if sustained 24h, escalate H/D/R early" was misleading on two of three axes. Today's audit (sample of 4 recall_audit rows joined with task output) found:

- **Layer A — latency tax (real, operational)**: every sqlite-fallback row paid the full 5000ms Hindsight timeout. Root cause: `isCircuitOpen()` reset the failure counter on every cooldown expiry, so with low-traffic >60s gaps the breaker never accumulated. Fixed in Ship A.
- **Layer B — instrument false-negative (real, instrument)**: 22/22 was_used=0 was substantially the verbatim ≥50-char substring matcher missing paraphrased responses. Audit rows 19/20 (Williams Radar Journal) show response IS using recall content under different wording. Fixed in Ship B (dual-signal verbatim + token-overlap).
- **Layer C — Hindsight retrieval quality (real, but n=1)**: row 21 returned shell_exec methodology for an Alpha Vantage Friday cron query. One genuine bad-ranking case. Insufficient to conclude DEMOTE. Ship C builds the manual A/B surface to gather more before 2026-05-13.

**Strategic implication**: had we acted on the watchpoint without diagnosis, we'd have escalated H/D/R on bad data. Saved by the discipline of "sample the underlying data before the strategic protocol fires."

---

## What Sessions 117 + 118 closed (2026-04-29 evening)

**Session 117 — recall-side outcome filter** (commit `c25a1ca`). Closes the read-side of Session 114's poison-source class. `RecallOptions.excludeOutcomes?: string[]` defaults to `["outcome:concerns", "outcome:failed"]`. `MemoryItem.tags?: string[]` carries vendor tags through. `applyOutcomeFilter()` runs after all 4 recall paths in hindsight-backend; SQLite backend threaded through 5 SELECT paths via new `parseTags()` helper. New `recall_audit.excluded_count` column (additive) restores the missing dimension for utility-rate audits. mc-ctl recall-utility extended with `dropped` column. qa-auditor PASS, zero Criticals; W1 fixed pre-commit; W2 deferred to post-deploy smoke (verify Hindsight echoes `outcome:*` tags on recall round-trip). Tests +22.

**Session 118 — V8 substrate S3 drift detector** (commit forthcoming). New `src/observability/drift.ts` + `GET /api/admin/drift` + `mc-ctl drift`. Catches silent drift between running env and declared invariants. DEFAULT_INVARIANTS encodes 6 baseline checks (INFERENCE_PRIMARY_PROVIDER, INFERENCE_PRIMARY_MODEL, HINDSIGHT_URL, HINDSIGHT_RECALL_ENABLED, HINDSIGHT_RECALL_TIMEOUT_MS, TZ). Tri-level exit codes (0/1/2) documented inline. qa-auditor: C1 fixed pre-commit (HINDSIGHT_RECALL_TIMEOUT_MS pattern→exact match, the very drift class it was designed to catch); W1/W2/W4/SV1 fixed; W3 (structured logging on drift) deferred. Tests +21. Substrate ladder now S1 + S3 + S4 done; S2 + S5 remain post-freeze.

---

## What Session 116 closed

**Resolved (was Step 2 from yesterday's brief):** outcome-aware metadata tagging shipped — write-side complement to Session 115's `was_used`. Every memory written via `getMemoryService().retain()` from a task-context call site now carries `outcome:success | outcome:concerns | outcome:failed | outcome:unknown` derived from `tasks.status`. New `src/memory/outcome-tag.ts` (pure mapper + DB lookup with safe fallback). Wired into `auto-persist.ts` and `router.ts:1981` (post-task exchange). `router.ts:1464` (positive feedback) and `router.ts:1509` (fast-path) intentionally NOT wired — no task context. qa-auditor PASS WITH WARNINGS, zero Criticals; race-condition concern fully resolved by trace verification (dispatcher writes status synchronously, eventBus broadcasts inline, router handler reaches getOutcomeTag with status already committed). Documented coverage gap (W1): `handleTaskFailed`/`handleTaskCancelled` do NOT call retain, so `outcome:failed` rows will be near-zero in production — acceptable since Session 114 incident class was `outcome:concerns` (DOES land). W2 deferred (recall-side OR-vs-AND tag matching is a follow-up concern). Tests 3941 → 3960 (+19). Zero new deps. No schema change. Architecture mirrors Session 115's "data first, decide later" — recall-side filtering on the new tag is the natural Step 2-follow-up.

---

## What Session 115 closed

**Resolved (was the top P1 from session 114's brief):** Hindsight `was_used` audit instrumentation shipped — answers "is recall actually used?" so we can decide HARDEN/DEMOTE/REPLACE with data instead of vibes. New `recall_audit` table (additive migration, mc.db). `logRecall()` writes a row at every recall call (all 4 paths: sqlite-only, circuit-open, hindsight-success, hindsight-failure-fallback). `markRecallUtility()` runs at turn end (router auto-persist block, fire-and-forget dynamic import) — claims unmatched rows from last 60s, substring-matches snippets ≥50 chars against the assistant's response, writes `was_used + used_count + task_id + checked_at`. Aggregates via new `mc-ctl recall-utility [Nh|Nd|Nm]` (default 24h). qa-auditor PASS WITH WARNINGS, zero Criticals; W1 (mc-ctl `since_arg` shell injection), W3 (PII redaction), I3 (query whitespace normalize), W2 (snippet floor 30→50), W4 (concurrent-claim regression test), W6 (MAX_ROWS_PER_SWEEP doc) all fixed pre-merge. Tests 3908 → 3934 (+26). Zero new deps. Freeze-aligned hardening per V8-VISION §3-S4 follow-up. Commit (next).

**Diagnosis correction (saved to memory):** manual `POST /consolidate` on mc-jarvis returned `items_count=0` in 85ms — Hindsight's vendor consolidation is **additive** (creates `type=observation` rows alongside source `type=world` rows, doesn't delete either). Auto-consolidation cadence does not exist in the vendor; every consolidation must be explicitly POSTed. Bank growth is by design. The 49% recall timeout rate is reranker scaling against the candidate pool, not a consolidation lag. Bank composition sample (20): 11 observations + 6 worlds + 3 experiences = ~half raw / half derived. The 4/28 03:03→0 monitoring drops were manual deletes from session 112 rehab, not consolidation. Captured at `feedback_hindsight_consolidation_additive.md`.

---

## What Session 114 closed

**Resolved (was queued from Session 113 as the first agenda item):** Jarvis's silent truncation on large file reads is fixed. `jarvis_file_read` and `file_read` now return a structured envelope `{truncated: true, total_chars, total_lines, outline (line-numbered), preview, next_steps}` at the TOP of the JSON for files > 8 KB, plus a `lines='N-M'` parameter for self-chunking. Adapter eviction layer untouched (still safety-nets other tools). New `src/lib/file-slicing.ts` shared module. 50 new tests across 4 files. Live verified on the 106,914-char / 437-line `logs/day-logs/2026-04-04.md`. Memory `feedback_jarvis_large_file_truncation.md` marked RESOLVED. Commit `bbc9820`.

**Other Session 114 ships (chronological):**

- `gdrive_download` builtin tool (commit `0c1ace1`) — Drive PDF/binary read for Jarvis. **Freeze-policy exception, operator-authorized.** qa-auditor caught + fixed pre-merge: C1 path traversal (`../` escape), C2 symlink escape, S1 whitelist too wide, W3 silent ignore.
- Image-only PDF chain wired end-to-end (commit `59dd4ce`): research scope regex broadened (`presentaci[oó]n`/`slides`/`deck`/`.pptx`), `pdf_read` returns `imageOnly: true` hint when chars=0, `gemini_upload` rewritten to documented resumable upload protocol (the multipart shape silently masked text/plain errors as JSON-parse exceptions).
- qa-auditor round 2 on the deck-read fix (commit `db7f917`): SSRF guard on resumable upload URL host, regex tightening, test gaps for phase-2 text/plain + missing upload-url header + pdf_read imageOnly.
- 9-row poisoned-conversations purge: yesterday's `status='completed'` task whose body narrated a failure ("Las herramientas de Drive están bloqueadas") was being recalled as a positive precedent. Memory captured at `feedback_completed_task_failure_narrative.md`.
- `feedback_path_whitelist_traversal.md` — `outputPath.startsWith(root)` on raw string fails to catch `..` traversal AND parent-symlink escape; fix is `path.resolve()` + `fs.realpathSync(dirname)` BEFORE whitelist check.
- Hindsight strategic options doc shipped to `docs/planning/hindsight-strategic-options.md` — 3 paths (HARDEN/DEMOTE/REPLACE), storage-architecture investigation, decision matrix, open questions. Discussion document, NOT a plan.

Tests 3854 → 3908 (+54 net across all session-114 commits).

---

## 🟡 TOMORROW — TOP OF AGENDA

**Steps 1, 2, 3 of `hindsight-strategic-options.md` §8 are DONE. V8 substrate S3 + recall-trilogy hardening also DONE.** Remaining:

1. ~~`was_used` recall instrumentation~~ — DONE Session 115.
2. ~~Outcome-aware metadata tagging at write~~ — DONE Session 116.
3. ~~Recall-side filter on `outcome:concerns` / `outcome:failed`~~ — DONE Session 117.
4. ~~Circuit-breaker latency-tax fix + dual-signal `was_used` + `recall-compare` eval tool~~ — **DONE 2026-04-30 trilogy.**
5. **Manual A/B review of 30 query verdicts** — `mc-ctl recall-compare 30 14d`. Note HINDSIGHT_BETTER / EQUAL / SQLITE_BETTER for each. This is the actual H/D/R input. Run between now and 2026-05-13. Don't escalate H/D/R early on aggregate metrics until the verdicts are in.
6. **Cross-encoder vs cosine-only A/B for 2 weeks** — answers "do we need the reranker." Needs the freeze to lift first.
7. **Then** decide change/demote/harden with data, not vibes.

**V8 substrate ladder**: S1 + S3 + S4 done. **S2 (self-audit before reporting)** and **S5 (skills-as-stored-procedures)** remain. S2 codifies the "Audited?" reflex into a tool/protocol so discipline isn't operator-dependent — depends on S4 (done) for `verified-against:` data sources. S5 is feature-territory; defer past freeze.

**Validation checkpoints (24h after the trilogy — ~2026-05-01 00:30 UTC)**:

- **Ship A circuit breaker**: tail journal for `[memory] Circuit breaker OPEN after 3 failures` and `Circuit breaker: half-open, retrying Hindsight`. Should see open-cycles 1× per cooldown window during degraded-Hindsight periods. Check that `recall_audit.source = 'circuit-open'` rows accumulate (proof the breaker is short-circuiting after the first 3 failures, eliminating the 5s/recall tax). If still 0 `circuit-open` rows after 24h with high timeout traffic, breaker logic regression — re-audit.
- **Ship B dual-signal**: `mc-ctl recall-utility 24h` should show "Utility by match type" with `verbatim` + `token-overlap` + `none` rows beyond the legacy. If still 100% `none` or 100% `verbatim`, threshold tuning needed (W1 deferred — can drop MIN_OVERLAP_TOKENS back to 3 if too few token-overlap matches surface).
- **Ship C recall-compare**: kick off a real 30-query review batch — `mc-ctl recall-compare 30 14d`. Expect ~150s elapsed (5s/query × 30 if Hindsight is slow). Note verdicts.
- **Drift detector**: `mc-ctl drift` exit=0 stays the contract.

**Best Day 11 work**: spend 20 min on the recall-compare review batch (it's the actual decision input), then V8 substrate **S2 (self-audit before reporting)** if there's energy. **P2 wider scope.ts regex sweep** (~30 min, deferred since Session 109) is a pickable side-quest.

**Open watchpoints for next session**:

- 🟠 24h timeout-rate trend post-circuit-breaker fix — does it materially drop now that the breaker actually opens?
- 🟠 `match_type='token-overlap'` distribution — is the threshold of 4 catching paraphrased recalls without false-positives?
- 🟠 Operator-side blocked: AV API key rotation (still pending), vision env vars paste (still pending).

---

## Open P0 (gating)

- **AV API key rotation** — still blocked on operator email to AV support. Only red item gating the day-30 exit declaration.

## Open P1 (carry-forward)

- **Vision env vars from Session 113** still not pasted into `mc/.env`. Three lines:

  ```
  INFERENCE_VISION_URL=https://api.groq.com/openai/v1
  INFERENCE_VISION_KEY=<value of INFERENCE_FALLBACK_KEY>
  INFERENCE_VISION_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
  ```

  Then `systemctl restart mission-control` when traffic is quiet. Without this, `screenshot_element describe:true` falls back to a friendly error. Image-only PDFs still work via `gemini_research` (the deck-read chain shipped tonight handles them); this only affects the screenshot-describe flow specifically.

- **Hindsight bank red** at session 114 close: mc-jarvis at 385 memories, no consolidation drop visible in 24h. May self-resolve if consolidator catches up. If mc-jarvis crosses 500 without a drop, manually trigger or investigate why qwen3-coder-plus consolidation passes are no-op'ing.

## Open P2

- Wider sweep of bare-alternation regex FPs in `src/messaging/scope.ts` (deferred from Session 109).
- W2 setext heading support in `buildOutline` (low frequency in jarvis-kb, complex to get right — deferred from session-114 audit).

---

## Where Session 113 left things (2026-04-28 late)

Three things shipped, one operational lesson, no rollbacks needed.

**Shipped:**

1. **Vision describe on `screenshot_element`** (mc commit `1c9a070`). Opt-in `describe:bool` + `describe_prompt:string`. Captured PNG → base64 → existing `describeImage()` adapter → `description` field in JSON response. Vision failures land in `description_error` and never fail the screenshot itself. Closes the gap where Jarvis could fetch an image URL via playwright/lightpanda but only ever saw a path string back. `src/inference/vision.ts` widened to read `INFERENCE_VISION_URL` + `INFERENCE_VISION_KEY` env overrides falling back to primary — needed because primary (DashScope coding-intl) rejects vision-language model names. Verified end-to-end via Groq Llama-4 Scout against the journal logo. Tests 3851 → 3854 (+3).
2. **`vlcms-ctl` admin console** (vlcms commit `7c2b70b`) — sibling of mc-ctl/crm-ctl. `status`/`deploy`/`restart`/`reap`/`logs`/`tail`. Orphan detector filters by `/proc/$pid/cwd` so it doesn't false-positive on mc (also runs `node dist/index.js`) or Docker containers. Companion ops fix: `/etc/systemd/system/very-light-cms.service` flipped from `Restart=on-failure`/5s → `Restart=always`/2s + `TimeoutStopSec=10`. Plus 2 zombies cleaned (Apr24 wrong-entrypoint leftover + manual orphan).
3. **WIP locked**: thewilliamsradar-journal `14314e3` (W17 editors-note removed → moved to home), very-light-cms `74876e1` (home sidebar + editors-note grid + 4× logo + entry-card refactor). All live + user-validated; committed to make next session start from a clean baseline.

**One operator-side lesson:** task `c3e992e7` killed when `./scripts/deploy.sh` was issued in the same compound Bash invocation as the `running-tasks` SELECT. The check passed (count=0), then a real Telegram message landed in the gap, then the deploy fired regardless. Compound check+act = race condition. Always run the gate as its own tool call before the action.

**Open P0 unchanged:** AV API key rotation, blocked on operator email to AV support. Same item as session 112 — only red gate on day-30 exit declaration.

**Quick-take items the next session should pick up unless overridden:**

- **P1 — N≥30 cache-hit ratio re-measure.** S1 (cache-aware prompts) has been in production since 2026-04-26. Likely enough organic traffic now to validate the ≥80% target from V8-VISION §3-S1 baseline. Pull from `cost_ledger` + `tasks` joining for fast-runner+chat path, exclude first 10 post-deploy tasks per `feedback_metrics_extrapolation.md`.
- **P1 — 24h Hindsight recall stability check.** Recall has been live with cap=60 + 5s timeout since 2026-04-28 ~01:00 UTC. Pull from `/root/claude/ops/hindsight-monitor/audit.db` `recall_audit` table (latency_ms, source, n_results) for the past 24h: success rate, p50/p95 latency, fallback ratio. Compare against rehab playbook's stated targets (95%+ success, p95 ≤4.4s).
- **P0 vision env wiring** if operator hasn't already pasted the 3 lines into `.env` — see Session 113 PROJECT-STATUS entry for exact values.
- **vlcms-ctl battle test** — first time Jarvis hits a journal/vlcms task post-this-session, watch whether he discovers and uses the wrapper (it's in vlcms README and `infrastructure.md`). If he doesn't, may need a tool-description nudge or a CLAUDE.md addendum at the journal/vlcms layer.

---

## Where Session 111 left things (unplanned mid-session)

After Session 110's S1 deploy, three consecutive Telegram tasks (3332-3334) hit `error_max_turns` on operator's vlcms-continuation work. Operator invoked `/diagnose`. Root cause was a **pre-existing scope-classifier collapse**, not an S1 regression — but the failure pattern correlated with the deploy timing, so it surfaced now.

**Diagnosis (4-phase)**:

- Task 3332 (max=55, hit): legitimate task complexity for vlcms Phase-3 redo. Cache 98%, S1 working as designed. Lesson extracted: "Batch file edits to reduce turn count."
- Tasks 3333, 3334 (max=20, hit): "Continúa" follow-ups routed to **wrong `google` scope** (46 tools) instead of inheriting `coding` (73 tools). Chain: semantic classifier returns explicit `[]` for short follow-ups per its own rules → router collapsed empty-Set with null/timeout → regex fallback → bare alts in google regex (`|present|`, `|drive|`, `|agenda|`, `|document[oa]?s?|`) matched generic words from prior conversation → wrong scope → tools missing → max_turns.

**Fix shipped (commit `8835c40`, Option 2 from /diagnose, freeze-aligned)**:

| File                         | Change                                                                                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/messaging/router.ts`    | New exported `decideActiveGroups(semanticGroups, priorScope, regexFallback, currentMessage?)` with three-way decision (`semantic` / `inherited` / `regex_empty` / `regex`). Wrapper `scopeToolsForMessage` takes 4th `priorScope` arg |
| `src/messaging/scope.ts:498` | Closes outer alternation with `\b` (same shape as `react\b` close shipped earlier). Drops bare `\|present\|` alt. Expands `calendar` → `calendars?\|calendarios?` so Spanish form survives `\b` close                                 |
| `src/messaging/scope.ts`     | Hoists `CONVERSATIONAL_PATTERN` to file-scope export so router's inheritance branch can apply the same filter (qa-audit W2: prevents "gracias"/"ok" from inheriting prior coding scope onto topic-closers)                            |

**qa-auditor round** (W1-W4):

- W1 sticky-bad-scope (3 consecutive misclassified inheritances trap user) — **deferred**, documented in `feedback_classifier_empty_vs_null.md`. Operator can break out by typing a real-keyword message; cap inheritance depth on next inheritance change.
- W2 conversational guard — **fixed in same commit**.
- W3 test-improvement nit — **deferred** (cosmetic).
- W4 log condition didn't fire on `regex_empty` source (observability regression I introduced in first pass) — **fixed in same commit**, tag renamed to `regex (post-empty)`.

**Tests**: 3843 → 3851 + 1 todo (+8 / 1 documenting residual `agenda`/`drive`/`documento` bare-alt FPs deferred to post-freeze tightening).

---

## Where Session 110 left things

**Landed earlier today** (4 commits on `main`, all pushed):

| Commit    | Lane                       | Change                                                                                                                                                                                                                                       |
| --------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `be764b6` | observability (V8 S4 Ph 1) | `cost_ledger` schema additive migration + writer + dispatcher forward `cache_read_tokens` + `cache_creation_tokens` end-to-end on fast-runner claude-sdk path                                                                                |
| `2af4d08` | observability (V8 S4 Ph 2) | Cache breakdown extended through Prometheus internals (heavy/nanoclaw runners). `InferenceResponse.usage` + `TokenUsage` widened. SDK shims emit cache fields conditionally; resume.ts spread+conditional. 7 new test cases                  |
| `e52e2b0` | infra                      | `/root/claude/very-light-cms/` added to git-tool `ALLOWED_CWD_PREFIXES` so Jarvis can `git_commit` directly there. Operator-authored after Jarvis's mid-task in-progress branch was reverted (Phase 3 vlcms work parked for clean re-pickup) |
| `1a95b12` | architecture (V8 S1)       | Cache-aware prompt construction. `buildJarvisSystemPrompt` returns `{stable, variable}`; new `buildKnowledgeBaseSections` exposes split KB. Marker-based emission via fast-runner chat branch. A2A + dispatcher persistence strip the marker |

**Net effect**:

- **Cache observability**: cache_read / cache_creation now persist in cost_ledger end-to-end across fast/heavy/nanoclaw paths. Pre-S1 baseline (post-S4, n=5 fast-runner): **81% cache-hit ratio average**.
- **Cache structure**: stable persona + KB now form a fixed prefix; variable scope-conditional content shifted to position 4+ in the LLM message order. Validates the architectural lesson from `feedback_cache_prefix_variability.md`.
- **Scope-classifier resilience**: empty-classifier-result on follow-ups now inherits prior scope instead of falling to regex FP. Should also sharpen the P1-S1 cache-hit measurement window by preventing scope churn during organic traffic.
- **Tests**: 3832 → 3851 (+19 across S4, S1, and Session 111 fix)

**Local hooks installed at `~/.claude/`** (effective at next-session boot):

- `vitest-scope-guard.sh` — blocks bare `vitest run`; force scoped variants
- `tsx-cache-buster.sh` — clears `/tmp/tsx-0/` on crm-azteca edits
- `mc-deploy-reminder.sh` — informs that mc src/ edits need `./scripts/deploy.sh`

Indexed in `reference_local_hooks.md`. Rollback: `mv ~/.claude/settings.json.bak-* ~/.claude/settings.json`.

---

## Tomorrow's queue

### P0 — credential hygiene

**[P0-A] AV API key rotation** — _10–15 min, blocked on operator_

- Plaintext key was logged to `journalctl` earlier this week through `scripts/fetch.sh` invocation. Treat as exposed.
- Operator emailing AV support to revoke + claim new (no rotation UI in AV).
- Steps: receive new key → update env on radar repo + mc → restart both → confirm a fresh fetch succeeds → optional: `journalctl --vacuum-time=...` to scrub.
- Why now: this has been on the carry-forward list for multiple sessions. Each day it sits is another day of valid-but-exposed credential.

### P1 — S1 validation (highest information value)

**[P1-S1] N≥30 cache-hit ratio re-measurement**

- Pre-S1 baseline (post-S4, n=5 fast-runner): 81% cache-hit average
- V8-VISION §3-S1 test bar: **≥80% aggregate cache-read ratio on a full mixed-traffic day**
- Measurement window now starts post Session 111 deploy at **2026-04-26 23:47** (the `8835c40` scope-classifier fix restart) so scope-churn from the misclassified "Continúa" follow-ups doesn't pollute the data
- Query when ready (~24h post-deploy):
  ```sql
  SELECT ROUND(100.0 * SUM(cache_read_tokens) / SUM(prompt_tokens), 1) AS cache_pct,
         COUNT(*) AS n,
         SUM(cost_usd) AS total_cost
  FROM cost_ledger
  WHERE created_at > '2026-04-26 23:47:02' AND agent_type = 'fast';
  ```
- **Decision criteria**:
  - `cache_pct ≥ 87%` → S1 worked, restored cache structure as designed
  - `cache_pct 80-87%` → S1 partial win, document and consider follow-up
  - `cache_pct < 80%` → S1 didn't reach the cache layer expected; re-audit message-emission order, possibly add `cache_control` markers
- Slice by date+hour to detect cold-start effects. Drop first ~5 post-restart tasks.
- Bonus check (Session 111 verification): grep `journalctl -u mission-control` for `Scope groups (inherited from prior turn)` — should fire on real "Continúa"-style follow-ups in coding context. If never fires after 24h of organic use, suspect the inheritance branch isn't being reached.

### P2 — known small cleanups

**[P2-followup] Wider coding-regex `\b` sweep** — _deferred from Session 109, still freeze-aligned_

Audit during P2-C found the same prefix-match defect class on ~12 other bare alternations in `scope.ts:508`. High-impact realistic Spanish FPs:

| Bare alt                                    | FP example                                              | Correct intent |
| ------------------------------------------- | ------------------------------------------------------- | -------------- |
| `programa(r\|ción)?`                        | "el programa de TV"                                     | non-coding     |
| `rutina`                                    | "mi rutina diaria"                                      | non-coding     |
| `funci[oó]n`                                | "la función de teatro"                                  | non-coding     |
| `estructura`                                | "la estructura organizacional"                          | non-coding     |
| `directori`, `carpetas?`, `servidores?`     | physical org references                                 | non-coding     |
| `commit`, `code`, `repositori`, `archivos?` | English "commitment"/"committee", ES "archivos físicos" | non-coding     |

Cleanest fix: append `\b` to the closing `)/i` of the outer group. Likely 1-line change + 4 regression tests. Same shape as the google-regex `\b` close shipped in Session 111 — pair them naturally if you want continuity on the regex hygiene lane.

**[P2-google-residual] Bare exact-word alts on google regex** — _new from Session 111, post-freeze_

Closing `\b` in Session 111 only fixed prefix-match bugs (`presentación` etc.). Generic exact-word alts still leak: `agenda` → "agenda del día" / "mi agenda diaria"; `drive` → "drive de tracción"; `document[oa]?s?` → "documento técnico"; `hojas?` → "hojas del árbol"; `slides?` → bare English use. Captured as `it.todo` in `scope.test.ts`. Fix requires either dropping alts (loses Spanish "agenda" → calendar inference some users rely on) or restructuring to require `google\s*` co-occurrence — both are structural changes outside the freeze.

**[P2-W1] Sticky-bad-scope inheritance cap** — _new from Session 111 qa-audit, design needed_

If turn N gets misclassified to wrong scope (e.g., classifier returns `["wordpress"]` wrongly), turn N+1's "Continúa" inherits `wordpress` indefinitely. Pre-fix regex would at least re-derive each turn. Mitigation options: counter on `previousScopeGroups` dropping after 3 consecutive `[]`-from-classifier turns, or require the classifier to explicitly emit an inheritance-signal vs `[]`. Low operational priority (operator can break out by typing a real-keyword message) but worth fixing on the next inheritance change. See `feedback_classifier_empty_vs_null.md`.

### P3 — calendar

- **2026-05-22**: day-30 re-benchmark. ~26 days out. Compare against `docs/benchmarks/2026-04-22-baseline.md`. Exit criteria from `30d-hardening-plan.md`: all P0 closed, P1 triaged, audit report filed, measurable improvement on efficiency + resilience.

### P4 — V8 substrate continuation

The remaining 3 of 5 substrate items from V8-VISION §3 (S1 + S4 are now done):

- **S2 self-audit before reporting** — depends on S4 (done) for `verified-against:` data sources. Codify the "Audited?" reflex into a tool/protocol so discipline isn't operator-dependent.
- **S3 out-of-band drift detector** — independent, freeze-aligned. The qwen3.6 swap lives in `.env` not git; cron tasks similar. Detector compares running config to declared config.
- **S5 skills-as-stored-procedures** — depends on framing (idempotent + replayable = hardening; new capabilities = feature). Defer past freeze.

Recommendation: pick **S3 next** if you want continuity on the substrate ladder. Independent of all other work, freeze-aligned, ~half-day.

### P5 — Jarvis Phase 3 vlcms work pickup

Jarvis was mid-task on very-light-cms Phase 3 (auth + admin layout) when his branch was interrupted today and the operator chose to revert. The work needs to be redone but the path is now clean: vlcms is allowlisted for `git_commit`. Operator's call when to re-engage Jarvis on this.

---

## Out-of-scope reminders (do NOT pick up casually)

- **Stealth browser fingerprint injection** (`/root/.claude/plans/replicated-jingling-castle.md`) — adds dependency + new capability surface. Feature, not hardening. Park until freeze lifts unless a bot-detection incident promotes it.
- **swarm-runner.ts cost_ledger zero-track** — separate concern from S4 Phase 2. Swarm hardcodes `{prompt:0, completion:0}` regardless of children. Defer.
- **New tools, runners, scope groups, scheduled tasks** — all freeze-violations per separation policy.

---

## Health snapshot at session close

| Item                     | State                                                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service                  | `mission-control` active (PID via systemctl), all channels reconnected post Session 111 deploy at 23:47                                                               |
| Tests                    | 3851 passing + 1 todo, 0 type errors                                                                                                                                  |
| Disk                     | ~26 GB free / 96 GB                                                                                                                                                   |
| Branch state             | `main` clean; all session work pushed to `origin/main` (5 commits across S110 + S111)                                                                                 |
| Hindsight recall         | DISABLED — leave disabled, operator filing upstream                                                                                                                   |
| Stabilization audit      | All 5/5 dimensions CLOSED                                                                                                                                             |
| V8 substrate ladder      | S1 + S4 (Phase 1+2) shipped 2026-04-26. S2/S3/S5 pending. S1 validation needs N≥30 post-deploy data                                                                   |
| cost_ledger cache fields | LIVE — cache_read_tokens / cache_creation_tokens populated end-to-end on fast/heavy/nanoclaw paths. Post-S1 cache-hit ratio measurement window opens 2026-04-26 20:23 |
| Open carry-forward count | 1 (P0-A AV key) + 1 (P2-followup regex) + 1 (P1-S1 N≥30 measurement) + 1 calendar (P3 day-30) + 3 (S2/S3/S5 substrate) + 1 (P5 vlcms Phase 3 re-pickup)               |

---

## Operating notes for tomorrow

1. **Verify branch before commit.** Per `feedback_shared_worktree_branch_inheritance.md` (today's discovery): operator + Jarvis share `mission-control/.git`. Run `git branch --show-current` before any `git commit`. Today I committed Phase 2 onto Jarvis's branch by accident; recovery was a clean ff-merge but the near-miss is documented.
2. **Verify before reporting.** Per `feedback_metrics_extrapolation.md`: re-query data with fresh eyes when challenged with "Audited?". S2 substrate will codify this; until then it's a hard rule.
3. **Pre-commit hook runs full suite (~140s).** Don't trigger it manually with `vitest run` — use scoped `vitest run <file>` (1.3s). The new local hook `vitest-scope-guard.sh` blocks bare `vitest run` automatically next session.
4. **mc src edits need `./scripts/deploy.sh`**. The local hook `mc-deploy-reminder.sh` will print this reminder on every edit next session.
5. **One commit per logical change.** Today's session shipped 4 commits across 3 lanes (S4 Ph1, S4 Ph2, allowlist, S1). Lane separation made audit + revert math easy. Keep the pattern.
