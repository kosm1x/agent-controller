# Next Session Brief — Hardening Phase

> **Authored**: 2026-04-26 end-of-Session-110
> **Window**: 2026-04-22 → 2026-05-22 (day 5 of 30 at next session start)
> **Re-benchmark target**: 2026-05-22 vs `docs/benchmarks/2026-04-22-baseline.md`
> **Phase posture**: Hardening + reliability only. Feature freeze in effect — see `30d-hardening-plan.md` separation policy.

---

## Where Session 110 left things

**Landed today** (4 commits on `main`, all pushed):

| Commit    | Lane                       | Change                                                                                                                                                                                                                                       |
| --------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `be764b6` | observability (V8 S4 Ph 1) | `cost_ledger` schema additive migration + writer + dispatcher forward `cache_read_tokens` + `cache_creation_tokens` end-to-end on fast-runner claude-sdk path                                                                                |
| `2af4d08` | observability (V8 S4 Ph 2) | Cache breakdown extended through Prometheus internals (heavy/nanoclaw runners). `InferenceResponse.usage` + `TokenUsage` widened. SDK shims emit cache fields conditionally; resume.ts spread+conditional. 7 new test cases                  |
| `e52e2b0` | infra                      | `/root/claude/very-light-cms/` added to git-tool `ALLOWED_CWD_PREFIXES` so Jarvis can `git_commit` directly there. Operator-authored after Jarvis's mid-task in-progress branch was reverted (Phase 3 vlcms work parked for clean re-pickup) |
| `1a95b12` | architecture (V8 S1)       | Cache-aware prompt construction. `buildJarvisSystemPrompt` returns `{stable, variable}`; new `buildKnowledgeBaseSections` exposes split KB. Marker-based emission via fast-runner chat branch. A2A + dispatcher persistence strip the marker |

**Net effect**:

- **Cache observability**: cache_read / cache_creation now persist in cost_ledger end-to-end across fast/heavy/nanoclaw paths. Pre-S1 baseline (post-S4, n=5 fast-runner): **81% cache-hit ratio average**.
- **Cache structure**: stable persona + KB now form a fixed prefix; variable scope-conditional content shifted to position 4+ in the LLM message order. Validates the architectural lesson from `feedback_cache_prefix_variability.md`.
- **Tests**: 3832 → 3843 (+11 across S4 + S1)

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
- Query when ready (~24h post-deploy):
  ```sql
  SELECT ROUND(100.0 * SUM(cache_read_tokens) / SUM(prompt_tokens), 1) AS cache_pct,
         COUNT(*) AS n,
         SUM(cost_usd) AS total_cost
  FROM cost_ledger
  WHERE created_at > '2026-04-26 20:23:28' AND agent_type = 'fast';
  ```
- **Decision criteria**:
  - `cache_pct ≥ 87%` → S1 worked, restored cache structure as designed
  - `cache_pct 80-87%` → S1 partial win, document and consider follow-up
  - `cache_pct < 80%` → S1 didn't reach the cache layer expected; re-audit message-emission order, possibly add `cache_control` markers
- Slice by date+hour to detect cold-start effects. Drop first ~5 post-restart tasks.

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

Cleanest fix: append `\b` to the closing `)/i` of the outer group. Likely 1-line change + 4 regression tests.

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
| Service                  | `mission-control` active (PID via systemctl), all channels reconnected post-S1 deploy at 20:23                                                                        |
| Tests                    | 3843 passing, 0 type errors                                                                                                                                           |
| Disk                     | ~26 GB free / 96 GB                                                                                                                                                   |
| Branch state             | `main` clean; all session work pushed to `origin/main` (4 commits)                                                                                                    |
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
