# Friction Pickup — 2026-05-09 Diagnosis

Authored 2026-05-09 (post-/compact session). Source brief: `docs/planning/next-session-friction-pickup.md`.

## #1 — `jarvis_file_write` short-confirmation friction

**Disposition**: **resolved**, regression-tested.

The friction class (4 incidents 2026-05-04 → 2026-05-07: "Procede" / "Dale" / "hazlo" / "Tenlo listo para el post 4" failing to produce a write) was rooted in scope-loss — the narrow `jarvis_write` regex required write-verb + file-ish-object and missed every short-confirmation surface. The fix shipped 2026-05-07: write tools were promoted from `JARVIS_WRITE_TOOLS` (scope-gated) to `MISC_TOOLS` (always-on) at `src/messaging/scope.ts:124-139`. The friction-pickup brief was authored 2026-05-08 before the fix had been verified holding; production behavior since shows "Procede"-class confirmations succeeding (e.g. PipeSong README write on 2026-05-07 11:52, narrated in `jarvis-kb/logs/day-narratives/2026-05-07.md`).

The amendment block in the source brief had already invalidated the original scope-loss hypothesis. The remaining open question — "what was the actual root cause if not scope-loss" — is moot: the always-on promotion is a strict superset; whatever the LLM-side gate failure mode was, the always-on tool surface dissolves it.

**Closing artifact**: 10 regression `it.each(...)` cases at `src/messaging/scope.test.ts:1330-1359` pin the always-on contract for every documented trigger phrase ("Procede", "Procede.", "Dale", "Dale.", "hazlo", "Hazlo ya", "Tenlo listo para el post 4", "Se ve bien. Tenlo listo para el post 4", "Adelante", "Confirmado") with NO prior-message context and NO scope-classifier signal. Re-gating these tools without operator approval will fire the test loudly.

## #2 — `max_turns` involuntary truncation

**Disposition**: **diagnosed**. Two distinct patterns; the friction-pickup brief's hypothesis ("re-exploration eats turns") covers only one of them. Concrete data below.

### Data

`mc.db.runs` 2026-05-04 → 2026-05-09: **21 incidents** terminated via `error_max_turns` (the brief said 3 — undercount). Tool-call histograms by run:

| Run                                  | unique tools | total calls | dominant tool                        | pattern |
| ------------------------------------ | ------------ | ----------- | ------------------------------------ | ------- |
| `91e7dabe` (Williams Journal weekly) | 3            | 58          | `shell_exec×55`                      | A       |
| `c329a1af` (deep-search)             | 1            | 55          | `shell_exec×55`                      | A       |
| `38107e8d` (NS bulk delete)          | 2            | 55          | `jarvis_file_delete×54`              | A       |
| `15ff056f` (NS bulk delete)          | 2            | 55          | `jarvis_file_delete×54`              | A       |
| `8895cb4d` (NS bulk delete)          | 2            | 55          | `jarvis_file_delete×54`              | A       |
| `b11d0974` (NS reconstruction)       | 3            | 55          | `jarvis_file_write×52`               | A       |
| `90e910f4` (competencia)             | 9            | 26          | mixed (search-heavy)                 | B       |
| `50a85bb4` (continuation)            | 2            | 24          | exploration                          | B       |
| `b3fc28af` (deep-search clima)       | 2            | 23          | `jarvis_file_read×18` + exa_search×5 | B       |
| `dbb62977` (Fase 3 doc write)        | 5            | 20          | `jarvis_file_read×16`                | B       |
| 11 other runs                        | varies       | 20-22       | mixed                                | B       |

### Pattern A — bulk-throughput throttle (6 incidents, ≥3× cost spike)

**Cause**: tasks that legitimately require 50+ similar tool calls (bulk delete, bulk write, sequential shell scripts) hit `MAX_ROUNDS_CODING=55` because each tool call consumes one round. The dominant root cause is **architectural**, not a turn-budget shortage — even bumping the cap to 100 only postpones the failure to N=100.

**Right fix**: batch tools. `jarvis_files_batch_delete(paths: string[])` and `jarvis_files_batch_write(files: {path, title, content, ...}[])` collapse N rounds → 1. The Williams Journal weekly publish script (55× shell_exec) belongs in a single shell pipeline, not 55 turns.

**Wrong fix**: raising `MAX_ROUNDS_*`. Doesn't solve the root cause; pushes failure to a higher threshold; multiplies cost-per-task linearly.

### Pattern B — exploration-before-write (12 incidents, mostly at `MAX_ROUNDS_DEFAULT=20`)

**Cause**: non-coding fast-runner tasks (chat continuations, search-heavy questions, doc-write requests) hit the 20-round default while still legitimately exploring. The friction-pickup brief's hypothesis applies here: the runner re-explores context every turn (no working memory), so high-diversity-tool tasks burn the budget on bookkeeping. `dbb62977` (Fase 3 doc write) used 16 of 20 rounds reading the existing context, leaving only 4 to actually write.

**Right fix (cheap, ship-able)**: bump `MAX_ROUNDS_DEFAULT` from 20 → 30. The 12-incident cluster sits at exactly 20-26 rounds; a 30-round cap catches the long tail without doubling cost (cache amortization keeps marginal turn cost low).

**Right fix (medium, needs design)**: per-task working memory between turns. Out of scope for this session; tracked as a v8 substrate concern.

**Wrong fix**: raising `MAX_ROUNDS_DEFAULT` to 50+. Drops failure rate but multiplies the cost surface for tasks that don't need it. The 30-cap captures the observed cluster; further increases hit diminishing returns.

### Recommendation

Two-step ship:

1. **Now (this session, low risk)**: bump `MAX_ROUNDS_DEFAULT` from 20 → 30. Single-line config change in `src/config/constants.ts:60`. Override remains via env var. Catches Pattern B's 12-incident cluster.
2. **Follow-up (separate session, needs ACI review)**: design and ship `jarvis_files_batch_write` + `jarvis_files_batch_delete`. Spec the batch-size cap, error-policy (atomic vs partial), and idempotency hint. Catches Pattern A's 6-incident cluster.

The shell_exec×55 incidents (Williams Journal weekly) are a separate ergonomic issue — the script should have been one shell pipeline. The runner-layer fix doesn't help here; the LLM should be guided to compose pipelines via tool description, not via a higher cap.

## #3 — NorthStar compass-reframe operationalization

**Disposition**: **inventory complete, deferred to operator alignment for spec confirmation**. Per the brief: "do NOT start coding until operator confirms scope". Code-level inventory below; the 4 spec decisions remain open and require a single operator decision-pass before any migration starts.

### Inventory — NorthStar/tasks touch surface

**Local filesystem (jarvis-kb)**:

- `NorthStar/tasks/` — **117 task files** currently on disk
- 20 projects under `projects/` (e.g. `vlmp/`, `pipesong/`, `agent-controller/`) — none currently use a `tasks/` subdir; only `README.md`s

**Source code (mission-control)** — 10 files reference `NorthStar/tasks` or `northstar_create_task`:

| File                                     | Role                                              | Migration impact                             |
| ---------------------------------------- | ------------------------------------------------- | -------------------------------------------- |
| `src/tools/builtin/northstar-sync.ts:48` | hardcoded path map `task: "NorthStar/tasks"`      | needs path-redirect or task-kind exclusion   |
| `src/tools/builtin/jarvis-files.ts:479`  | tool description mentions `NorthStar/tasks/`      | description-only update                      |
| `src/rituals/morning.ts:5,18`            | morning briefing reads NorthStar/\*               | needs source-split (intentions vs execution) |
| `src/rituals/nightly.ts:18-19,23`        | nightly reads NorthStar/INDEX.md for active tasks | INDEX must surface execution from KB         |
| `src/rituals/evolution-log.ts:69`        | evolution log reads NorthStar/ for state          | source-split                                 |
| `src/intelligence/enrichment.ts`         | semantic recall over NorthStar                    | path widening to projects/\*/tasks           |
| `src/messaging/scope-classifier.ts`      | scope group `northstar_write`                     | re-anchor or retire                          |
| `src/messaging/precedent.ts`             | precedent inheritance for NS write                | re-anchor                                    |
| `src/tools/builtin/schedule.ts`          | scheduled task creation                           | check what it writes                         |
| `src/tools/builtin/crm-query.ts`         | CRM↔NorthStar bridge                              | likely unaffected                            |

**Database (COMMIT — Supabase via PostgREST)**:

- `tasks` table — populated via `northstar_sync` (LWW + journal tombstones since 2026-05-08 strict-mirror work)
- 4 kinds in sync (`vision | goal | objective | task`); kind axis at `northstar-sync.ts:36,50,57,410-616`
- Strict-mirror invariant means retiring tasks-on-COMMIT requires either: (a) excluding `task` from `KINDS[]` or (b) keeping the table but never reading it from NorthStar-side

### 4 spec decisions — operator-confirmed 2026-05-09

| #   | Decision                                                                                                       | Operator answer                                                 |
| --- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| D1  | Task migration target path: `projects/<slug>/tasks/<task>.md`? Or a flat `tasks/` under each project's README? | **Tasks stay in `NorthStar/tasks/`** — no migration             |
| D2  | What stays in NorthStar/? Visions + goals + objectives only, or keep INDEX.md as the compass?                  | **Keep current shape; rewrite INDEX.md as a compass narrative** |
| D3  | Briefings (morning, nightly, evolution-log) — split intentions (NorthStar) from execution (KB)?                | **Yes — read both** (NorthStar=intent, projects=execution)      |
| D4  | COMMIT tasks table — keep + sync-exclude, or drop entirely?                                                    | **Do nothing** — accept the existing system as-is               |

The narrowed scope ships in **two surfaces** (commit `edd9778`, 2026-05-09):

1. **INDEX.md compass narrative** — extracted to `src/tools/builtin/northstar-index.ts` as a pure renderer over post-sync local entries + commit data. Walks vision → goal → objective → task tree, sorts by status (active first), captures parent-resolution failures in a `## Sin parent` footer. Replaces the flat `## Visions (2) … ## Tasks (4)` listing. 17 unit tests in `northstar-index.test.ts`.

2. **Ritual split** — `morning.ts`, `nightly.ts`, `evolution-log.ts` reframe NorthStar as the compass (intent + recurring rhythms) and the project KB tree as the execution surface. `project_list` added to nightly+evolution-log tool sets so they can surface execution-level activity alongside compass rhythms. Morning was already at 7 tools (deferral pre-active); nightly stayed at 4 (still skipDeferral); evolution-log crossed 6→7 (minor first-call schema-resolution cost on `shell_exec`).

D1 + D4 explicitly skipped per operator. The original migration plan (`projects/<slug>/tasks/`, 117-file backfill, sync filter, ritual lockstep, cutover, verification — 3-5 sessions) is **not happening**.

### Audit findings — round 1 (no round 2 needed; bundle is small)

qa-auditor surfaced 4 issues + 2 test gaps; all addressed in the same bundle:

- **W1 (Critical)**: Markdown injection on user-typed titles ("FX trade [WIP]") — added 4-line `escMd()` helper applied at 10 render sites. 2 tests pin the contract.
- **W2**: strict-mirror fallback could resurrect deleted records on partial Phase-4 failure — `unsynced` flag on `Display`, surfaced as `` `[unsynced]` `` tag. 1 test.
- **W3**: status-line format drift between vision-heading / goal-heading / objective-bullet / task-bullet — extracted `metaSuffix()` helper, applied symmetrically across all 4 levels.
- **W4**: tool-budget creep concern → verified non-blocking; morning was already at 7 tools (deferral was already active before my changes); nightly stays ≤6.
- **W5/W6 test gaps**: orphan kind-ordering and cascading-orphan capture → 2 new tests pin these as operator-visible invariants.

62/62 renderer + sync tests pass; 4592/4592 full suite pass.

## Files Touched This Session

| File                                        | Action | Δ                                                                   |
| ------------------------------------------- | ------ | ------------------------------------------------------------------- |
| `src/messaging/scope.test.ts`               | MODIFY | +30 lines (10 regression cases for #1)                              |
| `src/config/constants.ts`                   | MODIFY | `MAX_ROUNDS_DEFAULT` 20→30 + 9-line rationale comment               |
| `src/tools/builtin/northstar-index.ts`      | NEW    | ~270 lines (compass-narrative renderer + audit-driven hardening)    |
| `src/tools/builtin/northstar-index.test.ts` | NEW    | ~270 lines (17 tests — hierarchy, orphan, escape, unsynced, format) |
| `src/tools/builtin/northstar-sync.ts`       | MODIFY | INDEX-render block rewired to call `renderCompassIndex` (~70 lines) |
| `src/tools/builtin/northstar-sync.test.ts`  | MODIFY | 1 test updated for new format (preserves all original assertions)   |
| `src/rituals/morning.ts`                    | MODIFY | Prompt: NorthStar=intent, project_list=execution; 12 numbered steps |
| `src/rituals/nightly.ts`                    | MODIFY | Prompt + tool: `project_list` added; surface project activity       |
| `src/rituals/evolution-log.ts`              | MODIFY | Prompt + tool: `project_list` added; execution-surface complement   |
| `docs/audit/friction-pickup-2026-05-09.md`  | NEW    | this file                                                           |

**Commits**:

- `6c0be55` — fix(friction): close #1 + #2; queue #3 for operator alignment
- `edd9778` — feat(northstar): close friction-pickup #3 — compass narrative + ritual split
