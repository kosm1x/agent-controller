# Session Vigilance — Stress-Test Window Runbook

> **Purpose**: Quick-reference for any future Claude session during the 2026-04-22 → 2026-05-22 stabilization window while the user intensively exercises Jarvis. If something feels off, start here. This is not a comprehensive spec — it's the "what to check in the first 5 minutes" list.
>
> **Context for this window**: User is deliberately stress-testing Jarvis post-audit to surface regressions. All 5 audit dimensions closed on 2026-04-22 → 2026-04-23 (session 101). Expect higher traffic, deeper tool chains, and more edge cases than the baseline 7-day window reflects.

---

## The 7 signals to check first — order matters

Run these before interpreting any specific user report. Several audit bugs presented as "user says X doesn't work" but the root cause was observability telling lies.

1. **Branch state**: `git branch --show-current && git status --short`. Must be `main`; no staged files. Jarvis autonomous runs create `jarvis/feat/*` and `jarvis/fix/*` branches — their uncommitted staged files can migrate across branch switches and look like "your" WIP.
2. **Service health**: `./mc-ctl status`. Must be `active` with recent uptime. Check `journalctl -u mission-control --since '5 min ago' --no-pager | tail -20` for startup errors or restart loops.
3. **Orphan tasks on restart**: `./mc-ctl db "SELECT COUNT(*) FROM tasks WHERE status IN ('pending','queued','running') AND created_at < datetime('now', '-30 minutes')"`. Should be 0 post-fix (`reconcileOrphanedTasks` at boot). If >0 and grows across restarts, the reconcile regressed.
4. **Circuit breaker state**: grep logs for `Circuit breaker OPEN`. Should appear only transiently; if stuck OPEN while the provider is healthy (curl to provider works), the breaker state-machine regressed.
5. **Observability truthfulness** (see next section): do the numbers make sense?
6. **Hindsight status**: `curl -s localhost:8888/healthz` (port 8888, crm-hindsight Docker). If 404/timeout, memory backend has degraded — should have dual-write fallback to SQLite, not silent failure.
7. **Recent error patterns**: `./mc-ctl db "SELECT title, error FROM tasks WHERE status='failed' AND completed_at > datetime('now','-1 hour')"`. Any repeated error strings? `completed_with_concerns`? Any "tool X not available" messages in user conversations?

---

## "Impossible numbers" to flag (regression signals)

Every row below is an audit finding that got fixed. If you see it again, the fix regressed and you stop investigating anything else until it's re-fixed.

| Metric                                     | Healthy                                                           | Regression signal                                                                             |
| ------------------------------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `cost_ledger.model`                        | `claude-sonnet-4-6*` when `INFERENCE_PRIMARY_PROVIDER=claude-sdk` | Shows `qwen*` or `unknown` → model-pin regression (Dim-1)                                     |
| `cost_ledger.prompt_tokens`                | Thousands to tens of thousands under prompt caching               | Single digits (like 8) → cache tokens dropped from ledger (Dim-1)                             |
| `scope_telemetry.tools_called`             | Non-empty array on tool-using tasks                               | `[]` on SDK path → `recordToolExecution` not wired on SDK branch (Dim-1)                      |
| Anthropic prompt cache hit rate (over 24h) | ≥40% sustained                                                    | <20% sustained → time-varying content re-entered identitySection prefix (Dim-1)               |
| Hindsight recall p95                       | ≤1500ms                                                           | >3000ms → timeout constant reverted (Dim-2)                                                   |
| claude-sdk 15-min blocking calls           | 0 per hour                                                        | >0 → circuit breaker not guarding queryClaudeSdk (Dim-4)                                      |
| `schedule.run_failed` events               | Emitted on every ritual failure                                   | Absent from events table despite known cron failures → recordRitualFailure regression (Dim-4) |
| Telegram restart count in logs             | ≤5 consecutive, then backoff                                      | Unbounded growth → MAX_RESTART_ATTEMPTS regression (Dim-4)                                    |
| NFD-accented scope activation              | Matches NFC equivalent                                            | Differs → normalizeForMatching not hit at function entry (Dim-5)                              |

Queries for each are in the per-dimension audit reports under `docs/audit/2026-04-22-*.md`.

---

## Freeze discipline — what is and isn't allowed

**IN-scope during freeze**:

- Bug fixes on known issues
- Credential rotation / provisioning
- Observability fixes
- Test coverage for existing paths
- Dependency patch updates (no major bumps)
- Hardening follow-ups per `30d-hardening-plan.md`

**OUT-of-scope — if you catch yourself writing any of these during the window, stop**:

- New `src/tools/builtin/*.ts` files
- New `src/intel/adapters/*.ts` files
- New entries in `DEFAULT_SCOPE_PATTERNS` or `READ_ONLY_TOOLS`
- New runner types or runner modes
- New scheduled tasks (other than stabilization-related)
- Upstream-repo pattern adoptions (sweep still runs but queue post-freeze)

**MCP bridges are the ONLY allowed path for Jarvis-side consumption of new capabilities**. If Jarvis autonomously queues an "integrate with Jarvis" task for something it's building in an external repo, redirect to "expose it as an MCP server in that repo and register via our MCP bridge" — NEVER add a new builtin tool.

Full policy: `feedback_freeze_separation_policy.md`.

---

## Jarvis autonomous behavior watch

The user is exercising Jarvis intensively. Things to notice:

1. **Turn-budget exhaustion**: Fast-runner has a 55-turn cap. Tasks that hit it end with status `completed_with_concerns` and output containing "error_max_turns — Reached maximum number of turns". Check partial work left behind — could be staged files, half-committed branches, or half-written docs in external repos. Session 101 caught one (Phase 5 of xpoz-pipeline) by noticing the truncated output; the staged files migrated across branch switches.
2. **Wrong-tier routing**: Complex tasks classified as `fast` when they should be `heavy`. Look at `classifier.reason` in task detail. If a 55-turn failure was on a "fast" task that's clearly multi-step with dependencies, the classification is wrong (not the runner).
3. **Branch pollution**: Check `git branch | grep jarvis/` regularly. Abandoned feature branches accumulate. Delete those with no unique commits and no pending work.
4. **Cost spikes per task**: `./mc-ctl db "SELECT task_id, SUM(prompt_tokens), SUM(completion_tokens), SUM(cost_usd) FROM cost_ledger WHERE created_at > datetime('now','-1 hour') GROUP BY task_id ORDER BY SUM(cost_usd) DESC LIMIT 5"`. A single task consuming >$1 is worth investigating.
5. **Scope activation pathology**: `./mc-ctl db "SELECT task_id, json_array_length(tools_in_scope) FROM scope_telemetry WHERE json_array_length(tools_in_scope) > 100 ORDER BY id DESC LIMIT 10"`. If >100 tools loaded per task, semantic classifier may be mis-firing or scope inheritance is over-merging.
6. **Jarvis self-modifying behavior**: Jarvis has `jarvis_dev` for sandboxed self-changes. Watch for unexpected edits to mission-control source files that aren't commits from you. If you see them, trace to a `jarvis_dev` call in task history; if there's no trace, something else wrote them.

---

## Intervention guidance

**Fix immediately** (don't wait for the re-benchmark):

- Security regression (any CVE-class bug: SSRF, path exfil, shell injection, auth bypass)
- Circuit breaker stuck OPEN when provider is healthy
- Orphan task count growing across restarts
- Freeze violation: new builtin tool / adapter / scope entry landed in core
- User-facing task silence (pipe break between runner → parser → delivery)

**Document and defer** (post-freeze queue):

- New Major findings that are correctness but not safety
- Dead-tool candidates
- Low-activation scope groups
- Performance improvements that aren't latency-regressions

**Ask before acting**:

- Any change to `data/mc.db` (memories are irreplaceable)
- Any `rm -rf` on /tmp/tsx-0/ during live traffic (will kill in-flight tasks)
- Any systemctl restart during heavy load
- Any `git push --force` anywhere near main
- Any change Jarvis is making autonomously that crosses into mission-control core (see separation policy)

---

## 3-strike rule

If the same class of fix fails 3 times in this session — same kind of patch (regex tweak, scope regex widen, guard add, config bump) retried and still broken — **STOP**. The problem is architectural, not implementational. State what you've tried, why it keeps failing, and propose a different route. Do not attempt a 4th variation without user approval.

Reference: `feedback_3strike_rule.md`.

---

## Reference documents

- Audit reports: `docs/audit/2026-04-22-{efficiency,speed,security,resilience,tool-scoping}.md`
- Baseline snapshot: `docs/benchmarks/2026-04-22-baseline.md`
- 30-day hardening plan: `docs/planning/stabilization/30d-hardening-plan.md`
- Audit methodology: `docs/planning/stabilization/full-system-audit.md`
- Tool catalog by version: `docs/TOOL-CATALOG.md`
- Core memories (in `/root/.claude/projects/-root-claude/memory/`):
  - `feedback_session101_audit_marathon.md` — meta-patterns from 5-dim sweep
  - `feedback_dim{1,2,3,4,5}_*_audit.md` — per-dimension generalizable rules
  - `feedback_freeze_separation_policy.md` — what Jarvis can and can't build during freeze
  - `feedback_layered_bug_chains.md` — trace full request path, 3-5 stacked bugs is normal
  - `feedback_incomplete_migration.md` — "X is now primary" touching one file = partial migration
  - `feedback_3strike_rule.md` — when to stop and pivot
