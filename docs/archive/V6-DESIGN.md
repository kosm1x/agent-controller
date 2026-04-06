# v6.0 Design — Self-Improving Jarvis

> Jarvis evolves from assistant to autonomous engineer. Can code, test, deploy, and improve himself — safely, within bounds, with human review.
>
> Status: DESIGN
> Last updated: 2026-04-05

---

## Vision

Jarvis today is a powerful assistant that executes tasks. Jarvis v6.0 is an engineer that improves himself. He writes his own tools, fixes his own bugs, tunes his own behavior, manages his own infrastructure — all through a controlled pipeline with human review gates.

The core principle: **Jarvis proposes, humans approve.** No self-modification without review. The safety mechanisms live outside Jarvis's write boundary.

---

## Capability Levels

| Level | Capability                              | Safety                        | v6.0 Target |
| ----- | --------------------------------------- | ----------------------------- | ----------- |
| 0     | Tune tool descriptions (overnight loop) | Variant archive + rollback    | Done (v5.0) |
| 1     | Write new tools, adapters, tests        | Branch + PR + human merge     | **S1**      |
| 2     | Modify existing code (bug fixes)        | Branch + PR + test suite pass | **S2**      |
| 3     | Modify own directives/SOPs              | Changelog + user notification | **S3**      |
| 4     | Manage VPS (deploy, restart, monitor)   | Audit log + confirmation      | **S4**      |
| 5     | Full autonomy (architect → deploy)      | Budget gates + kill switch    | **Future**  |

---

## Architecture

```
User
  ↓ (approves PRs, reviews directives)
Jarvis (agent-controller, running on VPS)
  ↓ (proposes changes)
┌─────────────────────────────────────────────────┐
│  Coding Pipeline                                │
│                                                 │
│  1. Identify task (bug, new tool, optimization) │
│  2. Create branch (git checkout -b jarvis/...)  │
│  3. Write code in NanoClaw sandbox              │
│  4. Run typecheck + tests in sandbox            │
│  5. If pass: commit + push branch               │
│  6. Open PR on GitHub (gh_create_pr)            │
│  7. Notify user via Telegram                    │
│  8. Wait for human merge                        │
│  9. After merge: build + deploy                 │
└─────────────────────────────────────────────────┘
```

### Safety Invariants

1. **Jarvis CANNOT push to `main`** — all code changes go through branches + PRs
2. **Jarvis CANNOT modify `directives/` without user approval** — changelog + notification
3. **Jarvis CANNOT remove safety guards** — guards live in code that requires PR review
4. **Jarvis CANNOT restart the service without passing tests** — deploy tool gates on test suite
5. **All actions are audited** — every code change, deploy, and directive modification is logged

---

## S1 — Branch + PR Workflow (~2d)

> Jarvis can create branches, write code, push, and open PRs on his own repo.

### Changes

**Unlock mission-control for branch operations only:**

- `git_commit` and `git_push`: allow cwd `/root/claude/mission-control/` ONLY when on a non-main branch
- Branch naming convention: `jarvis/{type}/{slug}` (e.g., `jarvis/feat/oilprice-adapter`, `jarvis/fix/scope-regex`)
- Block: `git push origin main` — only `git push origin jarvis/*` allowed

**New tool: `jarvis_create_branch`**

- Creates `jarvis/{type}/{slug}` from current main
- Pulls latest main first
- Returns branch name

**Modify `gh_create_pr`:**

- Auto-set base=main, head=jarvis/\*
- Add label `jarvis-authored` for filtering
- Include test results in PR body

**NanoClaw integration:**

- Jarvis writes code in the sandbox container (mounted workspace)
- Runs `npx tsc --noEmit && npx vitest run` inside the container
- Only commits if tests pass

### Exit Criteria

Jarvis receives "escribe un nuevo adaptador de intel para OilPriceAPI" → creates branch → writes adapter + test → runs tests → opens PR → user receives Telegram notification with PR link.

---

## S2 — Self-Repair (~1.5d)

> Jarvis can fix bugs in his own code when they're identified.

### Changes

**Diagnosis tools:**

- `jarvis_diagnose`: reads recent error logs (`journalctl -u mission-control --since "1h ago" | grep ERROR`), identifies patterns
- `jarvis_test_run`: runs the full test suite, returns pass/fail summary

**Repair workflow:**

1. User reports issue OR overnight tuning detects regression
2. Jarvis reads logs, identifies the failing code
3. Creates `jarvis/fix/{slug}` branch
4. Modifies code (file_edit in sandbox)
5. Runs tests in sandbox
6. If pass: PR with diagnosis + fix + test results
7. User approves merge

**Constraint:** Jarvis can only modify files he understands. Initial scope: `src/tools/`, `src/intel/`, `src/messaging/scope.ts`, `src/messaging/prompt-sections.ts`. NOT: `src/inference/adapter.ts`, `src/runners/`, `src/db/` (core infrastructure stays human-only).

### Exit Criteria

A scope regex fails to match → overnight tuning detects → Jarvis creates branch → fixes regex → tests pass → PR opened → user merges.

---

## S3 — Directive Evolution (~1d)

> Jarvis can propose changes to his own SOPs and directives.

### Changes

**New tool: `jarvis_propose_directive`**

- Takes: directive path, proposed change (diff), reason
- Writes proposal to `knowledge/proposals/{date}-{slug}.md`
- Sends notification to user via Telegram
- Does NOT modify the directive directly

**User approval workflow:**

- User reviews proposal in Telegram or KB
- User says "aprueba la propuesta X" → Jarvis applies the change
- Changelog entry written to `logs/decisions/{date}-directive-change.md`

**Constraint:** Jarvis CANNOT modify directives directly. Only propose. Only apply after explicit user approval in the current message.

### Exit Criteria

Jarvis notices he keeps getting nudged for a specific pattern → proposes adding a new directive → user approves → directive updated → behavior changes.

---

## S4 — VPS Management (~2d)

> Jarvis can monitor, back up, and manage the VPS infrastructure.

### New Tools

**`vps_status`** — System health dashboard

- CPU, memory, disk usage
- Docker container status
- Service status (mission-control, Grafana, Prometheus, Hindsight)
- Recent error count from logs

**`vps_deploy`** — Build + restart service (requiresConfirmation)

- Runs: `npm run build && sudo systemctl restart mission-control`
- Gates on: test suite must pass first
- Waits 10s after restart, checks health endpoint
- Returns: success/failure + health check result

**`vps_backup`** — Database backup

- Copies `data/mc.db` to `backups/mc.db.{timestamp}`
- Reports backup size and count
- Auto-prunes backups >7 days

**`vps_logs`** — Read recent service logs

- Params: lines (default 50), filter (error/warn/info)
- Returns: filtered journalctl output

**`vps_firewall`** — Check/modify firewall rules (requiresConfirmation)

- Uses Hostinger API (`hapi` CLI) if available
- List rules, add/remove ports

### Exit Criteria

User says "haz deploy" → Jarvis runs tests → builds → restarts → verifies health → reports success. User says "estado del servidor" → Jarvis reports CPU/memory/disk/services.

---

## S5 — Autonomous Improvement Loop (~3d)

> Tie it all together: Jarvis identifies improvements, codes them, tests them, deploys them.

### The Loop

```
1. Overnight tuning identifies regression or opportunity
   OR user reports issue
   OR Jarvis detects pattern in logs/outcomes
       ↓
2. Jarvis creates improvement plan
   - What: tool description change / new adapter / scope fix / bug fix
   - Why: outcome data, error logs, user feedback
   - How: specific code changes
       ↓
3. Jarvis creates branch, writes code, runs tests
       ↓
4. If tests pass: opens PR with plan + diff + test results
       ↓
5. Notifies user via Telegram
       ↓
6. User reviews + merges (or rejects with feedback)
       ↓
7. If merged: Jarvis deploys (vps_deploy)
       ↓
8. Monitors for 1 hour post-deploy
   - Checks error logs every 15 min
   - If error rate spikes: auto-reverts (git revert + deploy)
       ↓
9. Records outcome in logs/decisions/
```

### Safety Mechanisms

- **Budget gate:** Max 3 PRs per day, max $5 in inference cost per improvement cycle
- **Scope limit:** Only files in the allowed modification set (S2 constraint)
- **Revert capability:** Every deploy is revertable (previous commit is tagged)
- **Kill switch:** User says "jarvis stop improving" → disables the loop
- **Audit trail:** Every improvement is logged with plan, diff, test results, deploy outcome

### Exit Criteria

Jarvis autonomously identifies that a new Intel Depot source would be valuable → writes the adapter → tests it → opens PR → user merges → Jarvis deploys → monitors for regressions → logs the outcome.

---

## Deferred to v7.0+

| Capability                                               | Why deferred                             |
| -------------------------------------------------------- | ---------------------------------------- |
| Multi-VPS management                                     | Single VPS for now                       |
| Self-modifying core infrastructure (adapter.ts, runners) | Too risky for autonomous changes         |
| Training other agents                                    | Requires multi-agent architecture        |
| Full VPS provisioning (new servers)                      | Hostinger API supports it, but premature |
| Remove human review gate                                 | Never — this is the alignment constraint |

---

## Dependencies

| S1 (Branch + PR) depends on      | Status             |
| -------------------------------- | ------------------ |
| Git tools with cwd support       | Done               |
| NanoClaw Docker image            | Done               |
| GitHub org access (EurekaMD-net) | Done               |
| Shell guard blocking main push   | Needs modification |

| S4 (VPS Management) depends on | Status                    |
| ------------------------------ | ------------------------- |
| hapi CLI (Hostinger)           | Bookmarked, not installed |
| systemd access                 | Available (sudo)          |
| Backup directory               | Created (backups/)        |

---

## Metrics

| Metric                  | v5.0 Final | v6.0 Target |
| ----------------------- | ---------- | ----------- |
| Self-authored PRs       | 0          | 10+/month   |
| Self-fixed bugs         | 0          | 5+/month    |
| Autonomous deploys      | 0          | 10+/month   |
| Human review turnaround | N/A        | <1 hour     |
| Post-deploy revert rate | N/A        | <10%        |
| Directive proposals     | 0          | 2-3/week    |

---

_v6.0 is where Jarvis stops being a tool and starts being an engineer. The human stays in the loop — not as operator, but as reviewer. Jarvis proposes, tests, and deploys. The human approves and course-corrects._
