# System-Hardening Sweep — 2026-07-05

Adversarial gap audit (5 lanes: reliability, security, observability, testing, roadmap-debt)
→ this fix sweep. The efficiency refactor (2026-07-05 AM) made the code lean; this sweep
closes the **silent-failure / unverified-edge** class the audit surfaced.

Operator gates (answered up front):

- **Budget** → observability-only (no enforcement; fix docs, raise hourly threshold, add
  daily>80% + spike alerts, drop the 24h cry-wolf mute). No `.env` change.
- **Scope** → Core + honest-debt (Waves 1–4).
- **Docker** → safe limits only (`--cap-drop=ALL`, non-root, memory/cpus/pids, drop
  `MC_API_KEY` from sandbox env); leave network.
- **Dormant** → **build out `resume.ts`**. (NOT "remove rotted" — `hasUserConfirmedDeletion`
  and `SWARM_SUBTASK_RETRY_ENABLED` stay; SOCIAL_PUBLISH stub removal is authorized via the
  honest-debt scope answer.)

WhatsApp finding (audit C1) **discarded** per operator — mc is Telegram + email only;
`WHATSAPP_ENABLED` unset, channel never initializes.

## Wave 1 — core hardening (disjoint file ownership)

| Lane                  | Owns (do NOT touch outside)                                                                                                                                                 | Work                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A · Ops scripts**   | `scripts/healthcheck.sh`, `scripts/watchdog.sh`, `scripts/backup-state-bundle.sh`                                                                                           | healthcheck: drop `npm run build`+deploy → restart-only + flock. watchdog: fix dead `retention.sh` call, fix stale 500 MB alert text, add mc-bundle freshness check + mc-prometheus container-liveness check, raise the cost-anomaly threshold + drop 24h mute. backup: `PRAGMA integrity_check` + `tar -tzf` verify + add `archive/` to bundle. |
| **B · Security**      | `src/tools/builtin/shell.ts`, `src/tools/builtin/http.ts`, `src/runners/container.ts`, `src/runners/nanoclaw-runner.ts`, `src/runners/heavy-runner.ts` (+ their `.test.ts`) | shell H6: redact guard `console.log` via `src/api/mcp-server/redact.ts`. shell H1: scrub secret env from `execAsync` child. http H3: `redirect:"manual"` + re-validate each hop. container H5: `--cap-drop=ALL` + non-root `--user` + `--memory/--cpus/--pids-limit`; drop `MC_API_KEY` from sandbox env (runners pass-through).                 |
| **C · Observability** | `src/observability/prometheus.ts`, `src/observability/*.ts`, `src/rituals/scheduler.ts`, `src/api/routes/health.ts` (+ tests)                                               | `mc_ritual_last_success_timestamp{ritual_id}` gauge set after each successful ritual; subscribe a Telegram notifier to `schedule.run_failed` (currently zero consumers); `/health` ritual-staleness section.                                                                                                                                     |
| **D · Inference obs** | `src/inference/claude-sdk.ts`, `src/inference/adapter.ts`, `src/inference/adapter-openai.ts`, `src/dispatch/dispatcher.ts` (+ tests)                                        | Record provider latency/success in the **claude-sdk** path via existing `providerMetrics.record` (dead since May cutover). Fix cost-ledger phantom-turns: `dispatcher.ts:727` — a timed-out SDK query writes `$0/0 tokens`; skip or tag `degraded` instead of a false $0 row.                                                                    |
| **E · resume.ts**     | `src/prometheus/resume.ts`, `src/prometheus/resume-loader.ts` (new) (+ tests)                                                                                               | New `runs`-row → `OrchestratorResult` deserializer (data persisted at `dispatcher.ts:587` `goal_graph`/`output`/`trace`); wire `resetFromGoal`/`resumeFromGoal` to it. Loader reads via `getDatabase()` — do NOT edit dispatcher.ts (Lane D owns it).                                                                                            |

**Assistant integration (Wave 1, after agents):** `monitoring/alerts.yml` (ritual-staleness +
`up==0` + budget daily>80%/spike rules), `mc-ctl` (`smoke` = one real fast task post-deploy;
`resume` entry point), `scripts/deploy.sh` (wire `validate-migration-runner.ts` + 10-min
post-deploy error-watch), `vitest.config.ts` (cap `maxWorkers` to de-risk OOM),
`.github/workflows/ci.yml` (tsc + sharded vitest). → typecheck → **checkpoint commit 1**.

## Wave 2 — honest-debt + verification gate (disjoint)

| Lane                       | Owns                                                                                                                                                       | Work                                                                                                                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F · Budget**             | `src/config.ts`, `src/budget/service.ts` (+ tests)                                                                                                         | Raise `budgetHourlyLimitUsd` default to a real anomaly threshold; keep `budgetEnabled` false; fix stale doc-comments claiming "hourly $2 binds".                                      |
| **G · Tool-desc honesty**  | `src/tools/builtin/seo-*.ts`, `ads-*.ts`, `ai-overview-track.ts` (+ tests)                                                                                 | Strip "reference this later / revisit / A/B" retrieval promises from descriptions of tools whose tables are write-only (no reader exists).                                            |
| **H · SOCIAL + eval-gate** | `src/tools/builtin/social.ts` (delete), `src/tools/sources/builtin.ts` (remove social block), `src/tuning/*`, `package.json`, `scripts/eval-gate.ts` (new) | Remove the 3-month SOCIAL_PUBLISH stub (tables never existed). Wire `tune:baseline` as a mandatory model-swap/prompt-change gate: ~50 cases replayed from mc.db, scored vs incumbent. |

**Assistant (Wave 2):** docs (PROJECT-STATUS, CLAUDE.md invariants, README, reconcile the 4
drift claims: Hindsight cost-pull "stays active", NorthStar #18, budget binding, reflection
"nothing triggers it"), memory. → typecheck → **checkpoint commit 2**.

## Close-out

qa-auditor on cross-agent seams (metric-name × alert-rule, cost-ledger × provider-metrics,
resume-loader × persisted shape, container-limits × working nanoclaw path) → fix → build +
deploy + verify → final docs/memory commit + push.
