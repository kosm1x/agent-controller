#!/usr/bin/env bash
# Re-benchmark probe — produces a markdown snapshot mirroring docs/benchmarks/2026-04-22-baseline.md.
# Intended for day-30 re-measurement at window close (2026-05-22) to diff against the baseline.
#
# Usage:  ./scripts/re-benchmark.sh > docs/benchmarks/YYYY-MM-DD-post-audit.md
# Or:     ./scripts/re-benchmark.sh YYYY-MM-DD  # auto-writes to docs/benchmarks/<date>-post-audit.md
#
# Self-contained: uses sqlite3 + mc-ctl + systemctl + git. No npm deps.
# Idempotent: read-only except for the output file.

set -euo pipefail

cd "$(dirname "$0")/.."   # project root

DB="${MC_DB:-./data/mc.db}"
DATE_LABEL="${1:-$(date -u +%Y-%m-%d)}"
OUT_PATH=""
if [[ -n "${1:-}" ]]; then
  OUT_PATH="docs/benchmarks/${DATE_LABEL}-post-audit.md"
  exec > "$OUT_PATH"
fi

# ---- helpers ----------------------------------------------------------------
sql() { sqlite3 "$DB" "$1"; }
now_utc() { date -u +"%Y-%m-%d %H:%M UTC"; }

# ---- header -----------------------------------------------------------------
cat <<EOF
# Post-Audit Benchmark — ${DATE_LABEL}

> **Purpose**: Re-measurement snapshot for diff against \`docs/benchmarks/2026-04-22-baseline.md\`.
>
> Captured: $(now_utc)
> Commit: \`$(git rev-parse --short HEAD)\`
> Script: \`scripts/re-benchmark.sh\`

---

## Build metrics

| Metric                        | Value |
| ----------------------------- | ----- |
| Source files (non-test \`.ts\`) | $(find src -name '*.ts' -not -name '*.test.ts' | wc -l) |
| Test files (\`*.test.ts\`)      | $(find src -name '*.test.ts' | wc -l) |
| Tests passing                 | $(grep -oE '"tests":\s*[0-9]+' package.json 2>/dev/null | head -1 | grep -oE '[0-9]+' || echo "run 'npm test' to refresh") |
| Type errors                   | $(npm run typecheck 2>&1 | grep -cE 'error TS' || echo 0) |
EOF

# ---- runtime state ----------------------------------------------------------
cat <<EOF

## Runtime state

| Metric             | Value |
| ------------------ | ----- |
| Service            | $(systemctl is-active mission-control 2>/dev/null || echo "unknown") |
| Uptime             | $(systemctl show mission-control -p ActiveEnterTimestamp --value 2>/dev/null | awk '{print $2, $3}' || echo "unknown") |
| Memory current     | $(systemctl show mission-control -p MemoryCurrent --value 2>/dev/null | awk '{printf "%.0f MB\n", $1/1024/1024}' || echo "unknown") |
| Provider flag      | \`INFERENCE_PRIMARY_PROVIDER=$(grep -oE 'INFERENCE_PRIMARY_PROVIDER=[a-z-]+' /etc/systemd/system/mission-control.service 2>/dev/null | cut -d= -f2 || echo "unknown")\` |
EOF

# ---- host resources ---------------------------------------------------------
cat <<EOF

## Host resources

\`\`\`
$(df -h / | tail -1 | awk '{printf "Disk: %s total, %s used (%s), %s free\n", $2, $3, $5, $4}')
$(free -h | awk 'NR==2 {printf "Memory: %s total, %s used, %s free\n", $2, $3, $4}')
\`\`\`

## Database

| Item                       | Value |
| -------------------------- | ----- |
| \`data/mc.db\` size          | $(du -h "$DB" | cut -f1) |
| \`data/mc.db-wal\` size      | $([ -f "${DB}-wal" ] && du -h "${DB}-wal" | cut -f1 || echo "none") |
| Table count                | $(sql "SELECT COUNT(*) FROM sqlite_master WHERE type='table'") |
| \`tasks\` 30d                | $(sql "SELECT COUNT(*) FROM tasks WHERE created_at >= datetime('now','-30 days')") |
| \`conversations\` 30d        | $(sql "SELECT COUNT(*) FROM conversations WHERE created_at >= datetime('now','-30 days')") |
| \`events\` 30d               | $(sql "SELECT COUNT(*) FROM events WHERE received_at >= datetime('now','-30 days')" 2>/dev/null || echo "n/a") |
EOF

# ---- task volume ------------------------------------------------------------
cat <<EOF

## Task volume — last 30 days

\`\`\`
$(sql "SELECT status, COUNT(*) as count FROM tasks WHERE created_at >= datetime('now','-30 days') GROUP BY status ORDER BY count DESC")
\`\`\`

## Task volume — last 7 days

\`\`\`
$(sql "SELECT agent_type, COUNT(*) as count, printf('%.1f', AVG(CAST((julianday(completed_at) - julianday(started_at)) * 86400 AS REAL))) as avg_secs FROM tasks WHERE created_at >= datetime('now','-7 days') AND completed_at IS NOT NULL GROUP BY agent_type ORDER BY count DESC")
\`\`\`
EOF

# ---- LLM usage / observability ---------------------------------------------
cat <<EOF

## LLM usage — last 30 days (cost_ledger)

### Model distribution (regression check: should be dominated by claude-sonnet when INFERENCE_PRIMARY_PROVIDER=claude-sdk)

\`\`\`
$(sql "SELECT model, COUNT(*) as calls, printf('%.2f', SUM(cost_usd)) as cost_usd FROM cost_ledger WHERE created_at >= datetime('now','-30 days') GROUP BY model ORDER BY calls DESC")
\`\`\`

### Token distribution (regression check: prompt_tokens should reflect cache reads — single-digit values mean the ledger lost cache tokens again)

\`\`\`
$(sql "SELECT agent_type, COUNT(*) as calls, printf('%.0f', AVG(prompt_tokens)) as avg_prompt_tok, printf('%.0f', AVG(completion_tokens)) as avg_compl_tok FROM cost_ledger WHERE created_at >= datetime('now','-30 days') GROUP BY agent_type ORDER BY calls DESC")
\`\`\`

## Scope telemetry — last 7 days

### Activation distribution

\`\`\`
$(sql "WITH parsed AS (SELECT json_each.value as grp FROM scope_telemetry, json_each(scope_telemetry.active_groups) WHERE scope_telemetry.created_at >= datetime('now','-7 days')) SELECT grp, COUNT(*) as activations FROM parsed GROUP BY grp ORDER BY activations DESC LIMIT 20")
\`\`\`

### Deferred-tool yield (regression check: ~1-3% expected; 0% on SDK-branch tasks means recordToolExecution regressed)

\`\`\`
$(sql "WITH per_row AS (SELECT json_array_length(tools_in_scope) as in_scope, json_array_length(tools_called) as called FROM scope_telemetry WHERE created_at >= datetime('now','-7 days')) SELECT SUM(in_scope) as tools_in_scope_total, SUM(called) as tools_called_total, printf('%.2f%%', 100.0 * SUM(called) / NULLIF(SUM(in_scope), 0)) as yield FROM per_row")
\`\`\`
EOF

# ---- resilience state -------------------------------------------------------
cat <<EOF

## Resilience — current state

| Check                                                       | Value |
| ----------------------------------------------------------- | ----- |
| Orphan tasks (pending/queued/running, >30 min old)          | $(sql "SELECT COUNT(*) FROM tasks WHERE status IN ('pending','queued','running') AND created_at < datetime('now','-30 minutes')") |
| \`schedule.run_failed\` events last 7d                        | $(sql "SELECT COUNT(*) FROM events WHERE event_type='schedule.run_failed' AND received_at >= datetime('now','-7 days')" 2>/dev/null || echo "n/a") |
| \`task.failed\` events last 7d                                | $(sql "SELECT COUNT(*) FROM events WHERE event_type='task.failed' AND received_at >= datetime('now','-7 days')" 2>/dev/null || echo "n/a") |
| Circuit breaker OPEN log hits last 24h                      | $(journalctl -u mission-control --since '1 day ago' --no-pager 2>/dev/null | grep -c 'Circuit breaker OPEN' || echo 0) |
| SIGKILL / OOM events last 30d (journal)                     | $(journalctl -u mission-control --since '30 days ago' --no-pager 2>/dev/null | grep -cE 'killed|oom-killer|Signal=9' || echo 0) |
EOF

# ---- speed metrics ----------------------------------------------------------
cat <<EOF

## Speed — recent tool latency (from /health if available)

\`\`\`
$(curl -s -H "X-Api-Key: ${MC_API_KEY:-unknown}" http://localhost:8080/health 2>/dev/null | head -200 || echo "/health unreachable — start mission-control and provide MC_API_KEY")
\`\`\`

## Memory service state

| Item                  | Value |
| --------------------- | ----- |
| Hindsight /healthz    | $(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://localhost:8888/healthz 2>/dev/null || echo "unreachable") |
| Memory backend        | (read from service config) |
EOF

# ---- deltas placeholder -----------------------------------------------------
cat <<EOF

## Deltas vs baseline (2026-04-22)

> Compare this file against \`docs/benchmarks/2026-04-22-baseline.md\`. Expected improvements (regression if absent):
>
> - **Prompt cache**: was 0% hit rate → should be ≥40% sustained (Dim-1 fix)
> - **cost_ledger.model**: was 100% \`qwen3.5-plus\` → should be dominated by \`claude-sonnet-4-6*\` (Dim-1 fix)
> - **Hindsight recall**: was 5005ms → should be ≤1500ms p95 (Dim-2 fix)
> - **Circuit breaker**: was 0 SDK-path wiring → should show transient OPEN/CLOSED cycles, never stuck (Dim-4 fix)
> - **Orphan tasks**: was unbounded across restarts → should be 0 after \`reconcileOrphanedTasks\` runs (Dim-4 fix)
> - **schedule.run_failed events**: was 0 (not emitted) → should fire on every ritual failure (Dim-4 fix)
> - **NFC scope parity**: no direct metric; run \`npm test -- scope.test.ts\` — 3 NFD regression tests must pass (Dim-5 fix)

## Known regressions (to fill in on run)

- (list any metrics that moved in the wrong direction here)

## Follow-up queue — status

> See \`docs/planning/stabilization/30d-hardening-plan.md\` for the P0/P1 list. Mark each closed / still-open.
EOF
