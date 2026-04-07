# v6 Roadmap — Self-Improving Jarvis + Parallel Agents

> Last updated: 2026-04-06 — **v6.0 COMPLETE, v6.1 COMPLETE, Behavioral Coherence COMPLETE.**
> Forward roadmap (v6.2→v6.4): see [ROADMAP-v62-v64.md](../ROADMAP-v62-v64.md)

## Status Key

- **Done** — Implemented, tested, shipped
- **Active** — Currently in progress
- **Planned** — Scoped and sequenced (see ROADMAP-v62-v64.md)

---

## Execution Tiers

| Tier               | Sessions                  | Priority              | Rationale                                                 |
| ------------------ | ------------------------- | --------------------- | --------------------------------------------------------- |
| 0 — Self-Improving | S1–S8                     | Ship first            | Jarvis codes, tests, deploys, improves himself            |
| 1 — Safeguards     | SG1–SG5                   | Before activation     | Mechanical safety before autonomous improvement goes live |
| 2 — Background     | v6.1 agents + checkpoints | User-visible value    | Parallel execution lanes the user controls                |
| 3 — Coherence      | 10 OpenClaude patterns    | Behavioral foundation | Prevents drift, improves long-session reliability         |

---

## v6.0 S1 — Branch + PR Workflow (~2d) — **Done**

| Item                                                    | Source       | Status   |
| ------------------------------------------------------- | ------------ | -------- |
| Unlock mission-control for branch operations (not main) | Architecture | **Done** |
| Branch naming: `jarvis/{type}/{slug}`                   | —            | **Done** |
| NanoClaw sandbox for code + tests                       | —            | **Done** |
| Auto-labeled PRs (`jarvis-authored`)                    | —            | **Done** |

**Exit criteria:** Jarvis writes a new intel adapter → branch → tests pass → PR → Telegram notification.

---

## v6.0 S2 — Self-Repair (~1.5d) — **Done**

| Item                                                                                    | Source | Status   |
| --------------------------------------------------------------------------------------- | ------ | -------- |
| Diagnosis tools: `jarvis_diagnose`, `jarvis_test_run`                                   | —      | **Done** |
| Repair workflow: identify → branch → fix → test → PR                                    | —      | **Done** |
| Scope limit: `src/tools/`, `src/intel/`, `src/messaging/scope.ts`, `prompt-sections.ts` | —      | **Done** |

---

## v6.0 S3 — Directive Evolution (~1d) — **Done**

| Item                                                                        | Source | Status   |
| --------------------------------------------------------------------------- | ------ | -------- |
| `jarvis_propose_directive` — writes to `knowledge/proposals/`, notifies     | —      | **Done** |
| User approves in Telegram → Jarvis applies → changelog in `logs/decisions/` | —      | **Done** |
| Rate limit: can only propose, never apply without approval                  | —      | **Done** |

---

## v6.0 S4 — VPS Management (~2d) — **Done**

| Item                                                                | Source | Status   |
| ------------------------------------------------------------------- | ------ | -------- |
| `vps_status` — CPU, memory, disk, Docker, services, error count     | —      | **Done** |
| `vps_deploy` — build + restart (gates on test suite + health check) | —      | **Done** |
| `vps_backup` — mc.db backup with 7-day rotation                     | —      | **Done** |
| `vps_logs` — filtered journalctl                                    | —      | **Done** |

---

## v6.0 S5 — Autonomous Improvement Loop (~3d) — **Done**

| Item                                                                    | Source | Status   |
| ----------------------------------------------------------------------- | ------ | -------- |
| Overnight tuning or user report triggers improvement                    | —      | **Done** |
| Plan → branch → code → tests → PR → user merge → deploy                 | —      | **Done** |
| Post-deploy monitoring: error logs every 15 min for 1 hour, auto-revert | —      | **Done** |
| Safety: max 3 PRs/day, $5/cycle, scope-limited, revertable, kill switch | —      | **Done** |

---

## v6.0 S6–S8 — Tool Results, Code Search, Pattern Memory — **Done**

| Session | What                                                                       | Status   |
| ------- | -------------------------------------------------------------------------- | -------- |
| S6      | Structured tool result pipelines — pre-formatted data bypasses LLM         | **Done** |
| S7      | Semantic code search — `code_search` tool, tree-sitter index, SQLite store | **Done** |
| S8      | Execution pattern memory — auto-extract lessons, inject on similar tasks   | **Done** |

---

## Autonomous Improvement Safeguards (SG1–SG5) — **Done**

Built before enabling `AUTONOMOUS_IMPROVEMENT_ENABLED=true`. Five mechanical safeguards:

| ID  | Safeguard          | What                                                            | Where                                    |
| --- | ------------------ | --------------------------------------------------------------- | ---------------------------------------- |
| SG1 | Weekly Diff Digest | Sunday 8 PM Telegram: all Jarvis-authored changes, 7-day window | `src/rituals/diff-digest.ts`             |
| SG2 | HTTP Kill Switch   | POST /api/admin/kill-autonomous — disables loop + cancels tasks | `src/api/routes/admin.ts`                |
| SG3 | Immutable Core     | 15 files + src/api/ blocked in all write paths                  | `src/tools/builtin/immutable-core.ts`    |
| SG4 | Directive Cooldown | Max 1 proposal per 48h (DIRECTIVE_COOLDOWN_HOURS env)           | `src/tools/builtin/jarvis-directives.ts` |
| SG5 | Pre-Cycle Git Tag  | pre-auto-YYYY-MM-DD before each cycle. Prune >30d, keep min 10  | `src/rituals/scheduler.ts`               |

---

## v6.1 — Background Agents + Task Continuity — **Done**

| Item                                                                                 | Source       | Status   |
| ------------------------------------------------------------------------------------ | ------------ | -------- |
| Trigger detection: "lanza un agente", "investiga en background", "averigua mientras" | Router       | **Done** |
| Max 3 concurrent agents, workspace/ scratch writes, completion notification          | Architecture | **Done** |
| Fork child boilerplate: identity + 6 rules + structured output (Alcance/Resultado)   | OpenClaude   | **Done** |
| Worker isolation: no conversationHistory, scoped tools, 60-min timeout               | OpenClaude   | **Done** |
| Task continuity: checkpoint on max_rounds, "continúa" resumes with context           | Architecture | **Done** |

---

## Behavioral Coherence (10 OpenClaude Patterns) — **Done**

Shipped in 4 batches + 2 audit fixes. Source: Claude Code CLI architecture analysis.

| #   | Pattern                          | File                                            | Status   |
| --- | -------------------------------- | ----------------------------------------------- | -------- |
| 1   | Critical System Reminder         | `adapter.ts`                                    | **Done** |
| 2   | 9-section structured compact     | `context-compressor.ts`                         | **Done** |
| 3   | Verification discipline nudge    | `fast-runner.ts`                                | **Done** |
| 4   | Tool deferral                    | `registry.ts` + `adapter.ts` + `fast-runner.ts` | **Done** |
| 5   | KB omission for read-only tasks  | `fast-runner.ts`                                | **Done** |
| 6   | NO_TOOLS_PREAMBLE sandwich       | `context-compressor.ts`                         | **Done** |
| 7   | Fork child injection boilerplate | `router.ts`                                     | **Done** |
| 8   | Continue-vs-spawn matrix         | `planner.ts`                                    | **Done** |
| 9   | Memory drift verification        | `enrichment.ts`                                 | **Done** |
| 10  | "Never delegate understanding"   | `planner.ts`                                    | **Done** |

---

## Path Safety Pipeline — **Done**

Ported from Claude Code's `validatePath()`. Wired into file_write, file_edit, file_delete.

| Check | What                                                                                     | Status   |
| ----- | ---------------------------------------------------------------------------------------- | -------- |
| 1     | Quote stripping + tilde expansion                                                        | **Done** |
| 2     | UNC path block (SMB credential leak prevention)                                          | **Done** |
| 3     | Tilde variant block (~user, ~+, ~-)                                                      | **Done** |
| 4     | Shell expansion syntax block ($) — TOCTOU prevention                                     | **Done** |
| 5     | Glob block for write/delete operations                                                   | **Done** |
| 6     | Dangerous files (.env.\*, .bashrc, .npmrc, .netrc) + directories (.git/, .ssh/, .gnupg/) | **Done** |
| 7     | isDangerousRemovalPath — root, home, top-level dirs, wildcards                           | **Done** |

58 tests covering all checks.

---

## Pre-v6.0 Hardening — **Done**

| Item | What                                                 | Status   |
| ---- | ---------------------------------------------------- | -------- |
| H1   | Flatten project paths (38 files migrated)            | **Done** |
| H2   | Tighten prompt enhancer (MIN_LENGTH, 2-question cap) | **Done** |
| H3   | Migrate user_facts — 27 to KB, 6 credentials remain  | **Done** |
| H4   | Video pipeline E2E — PASS (5.3s MP4, video+audio)    | **Done** |
| H5   | Self-tuning verified — baseline 79.3%                | **Done** |
| H6   | Provider health baseline — 7-day metrics in KB       | **Done** |

---

## Safety Invariants

1. Jarvis CANNOT push to `main` — branches + PRs only
2. Jarvis CANNOT modify `directives/` without user approval
3. Jarvis CANNOT remove safety guards — SG3 immutable core
4. Jarvis CANNOT restart without passing tests
5. Jarvis CANNOT modify immutable core files — even on jarvis/\* branches
6. Jarvis CANNOT propose directives more than once per 48h (SG4)
7. Jarvis CANNOT write to .env, .bashrc, .ssh/, .git/ — path safety pipeline
8. All actions audited

---

## Deferred to v7.0+

| Capability                         | Why deferred                                            |
| ---------------------------------- | ------------------------------------------------------- |
| Multi-VPS management               | Single VPS for now                                      |
| Self-modifying core infrastructure | Too risky for autonomous changes                        |
| Agent-to-agent communication       | Background agents don't need it yet                     |
| Full VPS provisioning              | Hostinger API supports it, premature                    |
| Remove human review gate           | Never — alignment constraint                            |
| Persistent agent sessions          | Thin approach first, fat if needed                      |
| Embedding-based scoping            | Regex 92%+ accuracy, pgvector in v6.2 may enable hybrid |

---

## Metrics

| Metric                  | v5.0 Final | v6.0+v6.1 Final | Notes                                         |
| ----------------------- | ---------- | --------------- | --------------------------------------------- |
| Tests                   | 1228       | 1377            | +58 path safety, +behavioral coherence tests  |
| Source files            | 214        | 228             |                                               |
| Tools                   | 150        | 163             | +video, +git, +intel, +KB tools               |
| Safeguards              | 0          | 5 (SG1–SG5)     | All mechanical, no LLM in enforcement         |
| Behavioral patterns     | 0          | 10              | From Claude Code architecture analysis        |
| Background agents (max) | 0          | 3               |                                               |
| Provider cascade        | 2-model    | 3-model         | qwen → kimi → groq (different infrastructure) |
| Immutable core files    | 0          | 15              | + src/api/ directory                          |
| Path safety checks      | 0          | 7               | validatePathSafety + isDangerousRemovalPath   |
| Rituals                 | 7          | 9               | +diff digest, +proactive scanner              |

---

_v6.0 is where Jarvis stopped being a tool and became an engineer. v6.1 is where the user stopped waiting and started delegating. The behavioral coherence layer ensures Jarvis stays coherent as sessions get longer, conversations get deeper, and the tool count keeps growing. Next: v6.2 — the reliable foundation._
