# v6 Roadmap — Self-Improving Jarvis + Parallel Agents

> Status: DESIGN
> Last updated: 2026-04-05

---

## v6.0 — Self-Improving Jarvis

Jarvis evolves from assistant to engineer. Can code, test, deploy, and improve himself — safely, within bounds, with human review.

**Core principle: Jarvis proposes, humans approve.** No self-modification without review.

### Capability Levels

| Level | Capability                               | Safety                         | Session     |
| ----- | ---------------------------------------- | ------------------------------ | ----------- |
| 0     | Tune tool descriptions (overnight loop)  | Variant archive + rollback     | Done (v5.0) |
| 1     | Write new tools, adapters, tests         | Branch + PR + human merge      | **Done**    |
| 2     | Modify existing code (bug fixes)         | Branch + PR + test suite pass  | **S2**      |
| 3     | Modify own directives/SOPs               | Changelog + user notification  | **S3**      |
| 4     | Manage VPS (deploy, restart, monitor)    | Audit log + confirmation       | **S4**      |
| 5     | Full autonomy (architect → deploy)       | Budget gates + kill switch     | **S5**      |
| 6     | Faithful data relay (no narrativization) | Typed result schemas           | **S6**      |
| 7     | Intelligent code navigation              | Pre-built index, read-only     | **S7**      |
| 8     | Learn from execution history             | Pattern extraction + injection | **S8**      |

### S1 — Branch + PR Workflow (~2d)

Jarvis can create branches, write code, push, and open PRs on his own repo.

- Unlock mission-control for branch operations only (not main)
- Branch naming: `jarvis/{type}/{slug}`
- NanoClaw sandbox for code + tests
- Auto-labeled PRs (`jarvis-authored`)
- **Exit:** Jarvis writes a new intel adapter → branch → tests pass → PR → user gets Telegram notification

### S2 — Self-Repair (~1.5d)

Jarvis can fix bugs in his own code when identified.

- Diagnosis tools: `jarvis_diagnose` (reads error logs), `jarvis_test_run` (runs test suite)
- Repair workflow: identify → branch → fix → test → PR
- **Scope limit:** `src/tools/`, `src/intel/`, `src/messaging/scope.ts`, `src/messaging/prompt-sections.ts`. Core infrastructure stays human-only
- **Exit:** Overnight tuning detects scope regex regression → Jarvis creates fix PR → user merges

### S3 — Directive Evolution (~1d)

Jarvis can propose changes to his own SOPs and directives.

- New tool: `jarvis_propose_directive` — writes to `knowledge/proposals/`, notifies user
- User approves in Telegram → Jarvis applies change → changelog in `logs/decisions/`
- **Constraint:** Can only propose, never apply without explicit approval
- **Exit:** Jarvis notices recurring nudge pattern → proposes new directive → user approves

### S4 — VPS Management (~2d)

Jarvis can monitor, back up, and manage VPS infrastructure.

- `vps_status` — CPU, memory, disk, Docker, services, error count
- `vps_deploy` — build + restart (gates on test suite, health check after)
- `vps_backup` — mc.db backup with 7-day rotation
- `vps_logs` — filtered journalctl
- **Exit:** "haz deploy" → tests → build → restart → health check → report

### S5 — Autonomous Improvement Loop (~3d)

Tie it all together: identify → code → test → deploy → monitor.

- Overnight tuning or user report triggers improvement
- Jarvis creates plan → branch → code → tests → PR → user merge → deploy
- Post-deploy monitoring: error logs every 15 min for 1 hour, auto-revert on spike
- **Safety:** Max 3 PRs/day, $5/cycle, scope-limited, revertable, kill switch
- **Exit:** Jarvis autonomously writes a new intel adapter, tests, deploys, monitors — end to end

### S6 — Structured Tool Result Pipelines (~2d)

Eliminate LLM narrativization of data. When tools return data (sheets, APIs, intel), it goes through a formatter that produces the EXACT output the user sees. The LLM adds commentary AFTER, never inside the data block.

- Apply pre-formatted pattern to top 10 data-returning tools (gsheets_read, intel_query, web_search, etc.)
- Typed result schemas per tool category
- Same pattern that fixed the CRM jarvis_pull data-meshing problem
- **Exit:** gsheets_read returns a formatted table that reaches the user unchanged

### S7 — Semantic Code Search (~2d)

Index the mission-control codebase for intelligent code navigation. Query: "where is hallucination detection?" → `fast-runner.ts:250 detectsHallucinatedExecution()`.

- New tool: `code_search` — function definitions, imports, type references
- Tree-sitter or regex-based indexer over .ts files, stored in SQLite
- Refresh on git pull / branch switch
- **Exit:** Jarvis self-repair finds the exact function to fix in 1 round instead of reading 8 files

### S8 — Execution Pattern Memory (~2d)

Jarvis gets smarter over time. After each successful task, extract 1-2 lessons and store them for future use.

- Auto-extract patterns: "For livingjoyfully analytics, use GA4 ID G-XXXXX via gsheets_read"
- Store in `knowledge/execution-patterns/`
- Inject into context when similar tasks appear (scope group + keyword match)
- **Exit:** Repeat tasks execute faster and more accurately without user re-explaining

### Safety Invariants (v6.0)

1. Jarvis CANNOT push to `main` — branches + PRs only
2. Jarvis CANNOT modify `directives/` without user approval
3. Jarvis CANNOT remove safety guards — guards require PR review
4. Jarvis CANNOT restart without passing tests
5. All actions audited

---

## v6.1 — User-Spawned Background Agents

Today Jarvis is single-threaded from the user's perspective — one message = one blocking task. v6.1 adds parallel execution lanes the user controls.

### How It Works

```
User: "lanza un agente e investiga el tráfico de livingjoyfully.art"
Jarvis: "Excelente. Agente lanzado."
[User continues chatting normally]
[5 min later, Telegram: "Agente terminó. Resumen: 1,200 visitas/mes, bounce 62%, top page: /meditation-guide"]
User: "guárdalo en el KB"
Jarvis: [writes to projects/livingjoyfully/traffic-report.md]
```

### Design Decisions

| Decision              | Choice                                | Rationale                            |
| --------------------- | ------------------------------------- | ------------------------------------ |
| Max concurrent agents | 3                                     | Token budget protection              |
| KB access             | Read freely, write to workspace/ only | User reviews before promoting to KB  |
| Context               | Clean slate + memory enrichment       | Fast, focused, no conversation bleed |
| Notification          | Summary on completion via Telegram    | User can ask for progress anytime    |

### Architecture (thin approach)

No new runner type. Background agents are regular fast/heavy tasks with a flag.

- **Detection:** Router recognizes "lanza un agente", "investiga en background", "averigua mientras"
- **Routing:** Creates task with `spawn_type: "user-background"`, returns immediately
- **Execution:** Runs on existing fast/heavy runner with separate thread
- **Delivery:** Reaction engine sends Telegram notification with summary on completion
- **Results:** Written to `workspace/` scratch files, promoted to KB on user approval

### Agent Management Commands

| Command                        | Action                                     |
| ------------------------------ | ------------------------------------------ |
| "mis agentes" / "agents"       | List running background agents with status |
| "status agente X"              | Progress report for specific agent         |
| "cancela agente X"             | Cancel by name or ID                       |
| "guarda resultado de agente X" | Promote workspace/ results to KB           |

### Implementation (~2d)

1. **Router trigger detection** — scope pattern + spawn logic (~4h)
2. **Background task flag** — `spawn_type: "user-background"` in tasks table, immediate return to user (~2h)
3. **Concurrency gate** — max 3 check before spawn (~1h)
4. **Completion notification** — reaction rule that sends summary to Telegram (~3h)
5. **Management commands** — "mis agentes", "cancela", "status" in scope + fast-path (~4h)
6. **Workspace → KB promotion** — user-triggered write after review (~2h)

### Streaming Responses (~1d)

User waits 15-60s with only "Un momento..." Every modern agent streams tokens in real-time.

- Wire `onTextChunk` through to Telegram for all task types (not just fast-path)
- TelegramStreamController already exists from v2.30 — progressive editMessageText with throttling
- Perceived latency drops from 30s to 2s
- **Exit:** User sees Jarvis thinking in real-time as tokens arrive

### Task Continuity / Checkpoints (~1.5d) — **Done**

When Jarvis hits max_rounds, the work is lost. The user has to re-explain the task.

- At round N-5 (before max_rounds), auto-persist checkpoint to `workspace/checkpoints/{task-id}.md`
- Checkpoint: what was done, what's pending, which files were modified
- On "continúa", router detects pending checkpoint and injects it as context
- Jarvis picks up where it left off instead of starting over
- **Exit:** User says "continúa" after a max_rounds coding task → Jarvis reads checkpoint → finishes git commit/push

---

## Enhancements (Tier 1 — build when opportunity arises)

### Multi-Model Routing

Route different task types to different LLMs. Claude for reasoning, GPT-4 for tool calling, fast model for classification.

**Why:** Single-vendor (DashScope) means when primary degrades, everything degrades. Tonight showed primary+fallback down for 30+ minutes.

### More Intel Adapters

8 no-auth sources ready: IODA, WHO DON, OilPriceAPI, CelesTrak, Safecast, disease.sh, OONI, HN Firebase. 6 API-key sources: Finnhub, FRED, NVD, Cloudflare Radar, ACLED, NewsData.io.

### Unified FS Maturation

- ~~user_facts → knowledge/ migration~~ **Done** (H3, 69 facts migrated, 30 credentials remain)
- Day recaps from nightly ritual
- Auto-persist to meaningful paths (not session IDs)
- INDEX.md project summaries

---

## Enhancements (Tier 2 — design needed)

| Item                            | Why                                            | Effort |
| ------------------------------- | ---------------------------------------------- | ------ |
| ~~Structured outputs~~          | **Moved to v6.0 S6** (structured tool results) | —      |
| NanoClaw production activation  | Sandbox for untrusted code, long test suites   | 1d     |
| Embedding-based scoping         | Replace regex when accuracy drops below 80%    | 3-5d   |
| Task cancellation from Telegram | No way to abort running tasks today            | 1d     |
| Protected paths for file_delete | Prevent deletion of git-tracked research docs  | 0.5d   |
| Per-task mutation log           | Audit what files were created/modified/deleted | 1d     |

---

## Deferred to v7.0+

| Capability                         | Why deferred                         |
| ---------------------------------- | ------------------------------------ |
| Multi-VPS management               | Single VPS for now                   |
| Self-modifying core infrastructure | Too risky for autonomous changes     |
| Training other agents              | Requires multi-agent architecture    |
| Agent-to-agent communication       | Background agents don't need it yet  |
| Full VPS provisioning              | Hostinger API supports it, premature |
| Remove human review gate           | Never — alignment constraint         |
| Persistent agent sessions          | Thin approach first, fat if needed   |
| Agent progress streaming           | Status polling sufficient for v6.1   |

---

## Metrics

| Metric                           | v5.0 Final | v6.0 Target | v6.1 Target |
| -------------------------------- | ---------- | ----------- | ----------- |
| Self-authored PRs                | 0          | 10+/month   | —           |
| Self-fixed bugs                  | 0          | 5+/month    | —           |
| Autonomous deploys               | 0          | 10+/month   | —           |
| Human review turnaround          | N/A        | <1 hour     | —           |
| Post-deploy revert rate          | N/A        | <10%        | —           |
| Directive proposals              | 0          | 2-3/week    | —           |
| Concurrent background agents     | 0          | —           | 3 max       |
| Background agent completion rate | N/A        | —           | >90%        |
| Avg background agent duration    | N/A        | —           | <5 min      |

---

## Dependencies

| Dependency                          | Status                 |
| ----------------------------------- | ---------------------- |
| Git tools with cwd + branch support | Done                   |
| NanoClaw Docker image               | Done                   |
| GitHub org access (EurekaMD-net)    | Done                   |
| Shell guard blocking main push      | Needs branch exception |
| hapi CLI (Hostinger)                | Bookmarked             |
| systemd access                      | Available              |
| Backup directory                    | Created                |
| Task table spawn_type column        | Exists                 |
| Reaction engine Telegram delivery   | Done                   |

---

_v6.0 is where Jarvis stops being a tool and starts being an engineer. v6.1 is where the user stops waiting and starts delegating. The human stays in the loop — not as operator, but as reviewer._
