# V8 Substrate S5 — Implementation Delta vs. Spec

> **Status**: ✅ Spine 3 CLOSED 2026-05-19. All 5 phases shipped; activation gate (spec §14) MET.
> **Authored**: 2026-05-19 · **Spec**: `docs/planning/v8-substrate-s5-spec.md`
> **Phase commits**: P1 `422d985` · P2 `5866f49`+`acfbdfd` · P3 `0d0bd5c`+`144dc42` · P4 `9712536`+`6a456f0` · P5 `16e7ac8`+`e179c56`

Read this alongside the spec. The spec is _intent_; this is _delivered_. Where they diverge, this document explains _why_. The doc is rewritten on each phase close, accumulating the running ledger.

---

## §1 — High-level shape (running ledger)

| Aspect                      | Spec said                             | Shipped as                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Effort                      | ~10 days across 5 phases              | All 5 phases shipped 2026-05-19 (one calendar day, ~11 bundles). Spec's 10-day estimate compressed by phase-independence + tight bundle-slice cadence.                                                                                                                                                                                                      |
| Frontmatter format          | YAML mirror of DATAGEN                | YAML-subset (scalar k/v + string arrays + comments). Complex shapes (`inputs[]`, `tests[]`) JSON-encoded into `*_json` string fields validated via Zod `.refine()`. Real YAML parsers can still read this — we just write a strict subset until/unless `yaml` dep is approved.                                                                              |
| Schema                      | ALTER skills (10 cols) + 3 new tables | Same (P1) — 10 additive `ALTER TABLE skills ADD COLUMN`, plus `skill_versions` / `skill_test_runs` / `skill_failures`. All additive; safe on 67 existing rows.                                                                                                                                                                                              |
| Embeddings                  | qwen3-embedding-coder, dim=1024       | P3 shipped — reused `src/memory/embeddings.ts` (Gemini embedding-001 @ 1536d), no new dep. `description_embedding` BLOB column + cosine retrieval.                                                                                                                                                                                                          |
| Critic gate                 | Voyager pattern, retry budget 3       | P2 B1 shipped: `runSkillCritic` mirrors S2's call shape with skill-specific 5-check prompt (DUPLICATION #6 deferred to Phase 3). Retry budget NOT in lifecycle — spec §8's "3 producer revisions max" refers to a producer agent revising in response to critique. Lifecycle returns critique to caller; Phase 4+ producer-helper may wrap in a retry loop. |
| `skill_run()` callable tool | Phase 4                               | P4 shipped — `runSkill` dispatcher + 3 deferred builtin tools (`skill_describe`/`skill_load`/`skill_run`). Cost ledger + anti-list + cycle detection + Prom counter.                                                                                                                                                                                        |
| Operator surface            | `mc-ctl skills`                       | P5 shipped — `mc-ctl skills list/show/certify/archive/revert` + `skill-health`. Frontend page DEFERRED to V8.x per V7.7-GUIDE (CLI is the operator surface).                                                                                                                                                                                                |
| Anti-mission                | Registers, does NOT author            | **HELD P1-P4** (zero authored skills). **P5 carve-out**: authoring 5 production skills IS the Phase 5 mission (spec §14 activation-gate deliverable). 5 authored, critic-passed, certified.                                                                                                                                                                 |

---

## §2 — Substrate state at Phase 1 close

Already shipped from earlier work:

- `src/db/skills.ts` — CRUD on `skills` table (67 live rows). Continues to work via DEFAULT values on the new ALTER'd columns; no breaking change.
- `src/skills/catalog.ts` — v7.6 Spine 5's frozen first-party catalog (HTML compose + SVG diagram = 6 skills). Separate layer from DB skills; not affected by Spine 3.

Shipped in v7.7 Spine 3 Phase 3 Bundle 2 (closes Phase 3):

- `src/skills/retrieval.ts`: `retrieveSkills(taskContext, options)` async — embed query, load `is_certified=1 AND active=1 AND consecutive_failures < 3 AND description_embedding IS NOT NULL`, cosine-rank, threshold-filter (default 0.4), top-k (default 5). Fallback to `findSkillsByKeywords` when zero candidates OR query-embed null OR all candidates dim-mismatched (R1-W1 fold). `fallbackToKeyword: false` opt-out.
- `src/intelligence/enrichment.ts` wire: `getMatchingSkills` async; routes through `retrieveSkills({k: 3})` + `getSkill(skillId)` for rich-block lookup. Placeholder rendering for new-schema skills with empty `steps`/`tools` (R1-W3 fold) so the prompt block doesn't show confusing empty sections.
- `scripts/skills-retrieve.ts`: tsx-resolvable CLI bridge with stderr `[retrieval] path=<vector|keyword|empty>` log (R1-W4 fold) so operators can distinguish empty-because-vector-empty from empty-because-API-down.
- `mc-ctl skills retrieve "<task>" [--k=N] [--threshold=F]`: live operator surface. --k validated as positive int; --threshold accepts negative for explicit no-filter.

Spec §13.3 all 5 tasks complete: migration ✓, backfill ✓ (B1), replace findSkillsByKeywords ✓ (B2 via retrieveSkills + kept as fallback), re-embed hook ✓ (B1), tests ✓ (+32 across B1+B2).

Shipped in v7.7 Spine 3 Phase 3 Bundle 1:

- Schema: additive `ALTER TABLE skills ADD COLUMN description_embedding BLOB` (idempotent PRAGMA-check).
- `src/skills/embedding.ts`: `composeEmbeddingText` (spec §6) + `embedAndStoreSkill` + `loadSkillEmbedding`. Reuses `src/memory/embeddings.ts` primitives — no new dep.
- `src/skills/lifecycle.ts` wire: after `pointSkillAtVersion`, calls `embedAndStoreSkill`. Null-return info-logged so operator can distinguish API unavailability from "no saves yet" (R1-W2 fold).
- `src/skills/backfill-embeddings.ts`: operator-triggered idempotent backfill with `{limit?, sleepMs?, onProgress?}` options. Returns `{considered, embedded, skipped, errors[]}`.
- `scripts/skills-backfill-embeddings.ts`: tsx-resolvable script bridge for the bash wrapper (R1-C2 fold — original `npx tsx -e` inline failed because tsx `-e` doesn't auto-resolve `.js → .ts`).
- `mc-ctl skills`: dispatcher merged with pre-existing list-only `cmd_skills` (R1-C1 fold). Subcommands: `list` (default) / `backfill-embeddings [--limit=N] [--sleep-ms=N]` / `help`. `--limit=0` explicitly rejected (R1-W3 fold). `retrieve` subcommand deferred to B2 per anti-confusion discipline.

Shipped in v7.7 Spine 3 Phase 2 Bundle 2:

- Test runner (`src/skills/test-runner.ts`): mini-LLM executor that bypasses Phase 4's ToolSource. For each `tests_json` entry, sends `system=RUNNER_PREFIX + body, user=test.input`, parses JSON output, matches against `expect.output_match` (deep partial) OR `expect_error.{class, detail_contains}`. Writes per-test rows to `skill_test_runs`; bumps `mc_skills_test_runs_total{result}`. Flips `skills.is_certified` on aggregate. Caller-abort preserves existing certification (R1-W1).
- Test sweep (`src/skills/test-sweep.ts`): node-cron `0 2,8,14,20 * * *` Mexico City. Iterates `is_certified=1 AND active=1 AND current_version_id IS NOT NULL`, runs tests, reaffirms or decertifies. Per-skill try/catch keeps the sweep alive on single-skill failures. Boot wire in `src/index.ts` with `JARVIS_SKILLS_TEST_SWEEP_DISABLED` env gate.
- Prom counter (`src/observability/prometheus.ts`): `mc_skills_test_runs_total{result}` with closed cardinality (pass|fail|error|timeout).
- Operator surface (`mc-ctl skill-health`): subcommand showing certification state + recent passes/fails + consecutive_failures + override summary + activation gate snapshot (spec §14). Regex-sanitized `--name=` filter against SQL injection (R1-C1).

Shipped in v7.7 Spine 3 Phase 2 Bundle 1:

- Shared parser (`src/lib/critic-verdict.ts`): extracted `parseCriticVerdict` + `extractBalancedObjects` from S2's `src/audit/critic.ts` per spec §8 "build once, use twice." S2's 38 tests pass post-refactor.
- Skill critic (`src/skills/critic.ts`): `runSkillCritic` mirrors S2's CALL SHAPE (timeout/abort/infer/parseCriticVerdict). System prompt covers 5 of 6 spec §8 checks; DUPLICATION (#6) deferred to Phase 3 (needs vector retrieval).
- Storage helpers (`src/skills/storage.ts`): extracted `ensureSkillRow` / `recordVersion` / `pointSkillAtVersion` from Phase 1's loader; Phase 1 + Phase 2 both use them.
- Loader refactor (`src/skills/loader.ts`): now imports storage helpers; loader-specific code shrinks to walk + per-file try/catch. 21 Phase 1 tests pass unchanged.
- Lifecycle (`src/skills/lifecycle.ts`): `skillSave(parsed, options)` runs critic → on pass writes skill_versions row → on fail returns rejection. Operator override (`forceOperatorOverride: true`) writes with `critic_verdict='fail_returned_anyway'`. `skillRevise()` is a thin wrapper defaulting `createdBy='refiner'`.

Shipped in v7.7 Spine 3 Phase 1:

- Schema (`src/db/index.ts`):
  - `ALTER TABLE skills ADD COLUMN` × 10 (version, inputs_json, output_type, trigger_examples_json, tests_json, body_path, consecutive_failures, last_failure_at, is_certified, current_version_id, registry_sha)
  - `CREATE TABLE skill_versions` (write-only history; UNIQUE(skill_id, version))
  - `CREATE TABLE skill_test_runs` (per-test result row; Phase 2 writes here)
  - `CREATE TABLE skill_failures` (Voyager anti-list; Phase 4 writes here)
- Parser (`src/skills/frontmatter.ts`):
  - Strict YAML-subset parser (`parseYamlSubset`) — handles scalar k/v, string arrays, quote-aware comments. ~220 LOC.
  - Zod schema (`ParsedSkillSchema`) — validates parsed map against semver/name regex/length caps/enum/`*_json` parseability.
  - `FrontmatterError` with stable `kind: 'no_fence' | 'parse' | 'validation'` for caller categorization.
- Loader (`src/skills/loader.ts`):
  - Walks `jarvis_files` for `skills/<name>/SKILL.md` matching a strict path regex.
  - `ensureSkillRow` finds/creates the parent `skills` row by frontmatter name (UNIQUE on `name`).
  - `recordVersion` returns `{kind: 'inserted'|'unchanged'|'drift', ...}` per (skill_id, version) state.
  - `pointSkillAtVersion` updates the parent's metadata + `current_version_id` only on a new insert.
  - Idempotent: re-running on unchanged content is a no-op. Body drift on a pinned version logs a warning and refuses to overwrite (forensic trail invariant).
- Boot wire (`src/index.ts`):
  - Dynamic import + try/catch with `log.warn(non-fatal)`.
  - Env gate `JARVIS_SKILLS_BOOT_LOAD_DISABLED=true` for tests that init the DB without a loader run.

---

## §3 — Decisions vs. spec §15 open questions

The spec lists 7 open Qs. P1 touched Q4. P2 B1 confirmed Q6 + partially resolved Q7.

| Q                                                              | Spec default                             | Phase 1 outcome                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1 Embedding model choice (qwen3-embedding-coder vs bge-small) | Pilot in Phase 3                         | DEFERRED — Phase 3                                                                                                                                                                                                                                                                                                |
| Q2 Phase 4 sandbox (nanoclaw vs inline)                        | Nanoclaw default                         | DEFERRED — Phase 4                                                                                                                                                                                                                                                                                                |
| Q3 Failed-task anti-list TTL                                   | 7 days                                   | Phase 1 ships the `skill_failures` table only; TTL evaluation happens at retrieval time (Phase 3)                                                                                                                                                                                                                 |
| Q4 Frontmatter format strictness                               | Mirror DATAGEN                           | **Confirmed strict + narrowed** — JSON-encoded inline for complex fields; bare YAML for scalars/arrays only. Spec's "mirror DATAGEN exactly" preserved on the SHAPE; the implementation choice is a no-dep narrowing.                                                                                             |
| Q5 Cross-skill composition (cycle detection)                   | Depth bound 3                            | DEFERRED — Phase 4                                                                                                                                                                                                                                                                                                |
| Q6 `created_by='discovery'` promotion path                     | Same critic gate                         | **CONFIRMED in P2 B1** — `skillSave({createdBy: 'discovery'})` routes through the same `runSkillCritic` gate as operator submissions. No special code path.                                                                                                                                                       |
| Q7 Operator override of critic                                 | Yes via `created_by='operator-override'` | **PARTIAL in P2 B1** — `forceOperatorOverride: true` write IS supported, but `created_by` cannot be `'operator-override'` (Phase 1 CHECK enum gap; queued as `S5-P2-I1` for v8.0 reset). Override is carried via `critic_verdict='fail_returned_anyway'`, which is unreachable except via override → unambiguous. |

**3 of 7 touched in P2 B1 ledger**: Q4 (carried from P1) + Q6 confirmed-as-default + Q7 partial.

---

## §4 — Decisions NOT anticipated by spec

| Decision                                                                               | Phase              | Rationale                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quote-aware comment stripping in the frontmatter parser                                | P1 (R1-W1/W4 fold) | Naive `indexOf("#")` silently truncated `description: "Priority #1 ticket"`. R1 caught this.                                                                                                                                                                            |
| `JARVIS_SKILLS_BOOT_LOAD_DISABLED` env flag                                            | P1                 | Tests init DB without firing the loader. Cleaner than mock-injection.                                                                                                                                                                                                   |
| Loader logs structured fields via `pino` adapter (msg + fields swap)                   | P1                 | mc uses pino's `({fields}, msg)` shape; the loader's `LoaderLog` interface uses `(msg, fields)` for ergonomics. Adapter at boot wire site.                                                                                                                              |
| `body_sha256` drift → log warning + leave row unchanged                                | P1                 | Forensic-trail invariant per spec §5. Auto-overwrite would lose the prior body before Phase 4 ships skill_run.                                                                                                                                                          |
| 67 live skill rows NOT backfilled                                                      | P1                 | Spec §4 says "auto-converted at migration time" → deferring to Phase 5 cleanup so the activation gate doesn't certify legacy bodies as Phase 1 noise. Tracked as `S5-P1-I1` in `next-sessions-queue.md`.                                                                |
| Extract `parseCriticVerdict` + `extractBalancedObjects` to `src/lib/critic-verdict.ts` | P2 B1              | Spec §8 "build once, use twice." S2 + S5 critics share JSON-extraction discipline. Refactor preserves S2's 38 tests.                                                                                                                                                    |
| Override signal carried via `critic_verdict='fail_returned_anyway'` ONLY               | P2 B1              | Spec §8 mandates `created_by='operator-override'` but Phase 1 CHECK enumerates only 5 non-override values. SQLite cannot ALTER a CHECK without destructive re-create. `'fail_returned_anyway'` is unreachable except via override → unambiguous. Tracked as `S5-P2-I1`. |
| 8000-char body excerpt cap in critic call                                              | P2 B1              | Bounds critic cost ~30% of producer per spec §8; no skill body exceeds 8k today. Surfacing `body_truncated` deferred (`S5-P2-W2`).                                                                                                                                      |
| `SkillSaveResult.kind='unchanged'` returns `ok:false`                                  | P2 B1              | Coalesced no-op success into rejection class for simplicity. Caller distinguishability deferred to Phase 4 producer-retry loop (`S5-P2-W1`).                                                                                                                            |
| No producer-side retry loop in lifecycle                                               | P2 B1              | Spec §8's "3 producer revisions max" describes a producer agent revising in response to critique. Phase 2 returns critique; Phase 4+ producer-helper may wrap in a retry loop.                                                                                          |

---

## §5 — Phase 1 acceptance evidence

| Acceptance                                        | Evidence                                                                                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Schema migration applies on populated DB          | 67 live rows + 10 NOT NULL ALTERs with DEFAULTs ✓; loader.test.ts in-memory DB runs through full migration on `:memory:`      |
| Frontmatter parser handles valid + invalid inputs | 13 parser tests pass (happy + 5 validation + 2 parse + 2 quote-aware-comment regressions + 3 misc)                            |
| Boot loader registers SKILL.md files idempotently | 8 loader tests pass (empty / single / idempotent / drift detect / version bump / parse-error-isolation / non-SKILL.md filter) |
| Loader is a no-op on empty namespace              | Production boot log post-deploy: `[skills:loader] complete loaded=0 skipped=0 drift=0 errors=0`                               |
| qa-auditor R1                                     | 0 Crit / 4 Warn (all folded) — see `docs/audit/v7.7-spine-3-phase-1.md`                                                       |
| Anti-mission held                                 | grep shows zero authored skill bodies in the diff — only schema + parser + loader                                             |

---

## §6 — Spine 3 CLOSED 2026-05-19

All 5 phases shipped. The S5 substrate is complete: skills are versioned,
critic-gated, test-certified, vector-retrieved, callable via `skill_run`,
and operator-manageable via `mc-ctl skills`. The V8.0 activation gate
(spec §14) is MET — 5 certified production skills with green tests.

Substrate-availability: Spine 2's `s5_skill_failure_rate` drift signal
(`enabled=0` with `awaiting:S5` sentinel) can now be flipped on by the
operator — the substrate it awaited exists.

---

## §6.1 — Phase 4 Bundle 1 closure (2026-05-19)

**Commit**: `9712536` — dispatcher + inputs schema + mini-runner extract + cycle detection + Prom counter.

**Shipped surfaces**:

- `src/skills/inputs.ts` — `buildArgsSchema(inputs_json)` builds a runtime Zod schema from the frontmatter inputs[] declaration. 7 supported types (`string|number|integer|boolean|enum|object|array`). `.strict()` rejects unknown args.
- `src/skills/mini-runner.ts` — shared `runSkillPrompt(body, payload, options)` extracted from Phase 2 B2's `test-runner.ts`. Both the test-runner AND the new dispatcher use this; first-instruction-wins `RUNNER_PREFIX` + JSON-only contract + override-detection clause. C1 audit fold lifted `MiniRunUsage` (promptTokens/completionTokens/model) into the return shape so the dispatcher can write real spend to cost_ledger.
- `src/skills/dispatcher.ts` — `runSkill(name, args, options): SkillRunResult`. Resolves `current_version_id` → validates args via `validateSkillArgs` → runs mini-runner → updates `skills.use_count|success_count|consecutive_failures|last_used|last_failure_at` → writes `skill_failures` (CHECK-enum mapped) → writes `cost_ledger` (`agent_type='skill:<name>'`, real tokens, UUID taskId fallback) → resolves open failures as recovery → bumps `mc_skills_run_total{name, result}` counter.
- `src/skills/test-runner.ts` — refactored to use `runSkillPrompt` from the shared module. Mini-runner status → TestRunOutcome mapping (ok/empty/unparseable/timeout/error). 17 test-runner tests still pass post-refactor.
- `src/observability/prometheus.ts` — `mc_skills_run_total{name, result}` Counter + `recordSkillRun()`. 10 closed-cardinality result classes (`ok | skill_not_found | skill_inactive | no_active_version | input_validation | cycle_detected | tool_unavailable | wrong_output | timeout | other`). Defensive name clip to 64 chars.

**Spec compliance**:

- §7 `skill_run(name, args, options)`: ✅ implemented
- §10 anti-list write path: ✅ `consecutive_failures` increments on dispatcher-side failure; `skill_failures` row written. **Schema gap**: `resolution='self_recovered'` is in spec but NOT in Phase 1 CHECK enum (`reverted_version | fixed_in_new_version | archived | NULL`). Workaround: `resolved_at` set, `resolution` NULL. Tracked **S5-P4-B1-I1** for v8.0 schema reset.
- §12 S4 alignment: ✅ `cost_ledger` row with `agent_type='skill:<name>'` written per dispatch. C1 audit fold ensured real prompt_tokens + completion_tokens from `MiniRunUsage` land in the row (not 0/0 as the first draft did).
- §15 Q4 cycle detection: ✅ `MAX_SKILL_CALL_DEPTH = 3`, `_callStack` reject path; **caveat**: Phase 4 doesn't ship body-side recursion, so the contract isn't externally exercised yet. W2 queued for the Phase 5 contract test.

**R1 audit folds (in-bundle)**: C1 cost-ledger real-tokens regression + UUID taskId; W3 `skill_corrupt` errorClass split (corrupt inputs_json doesn't burn anti-list); W5 `safeJson` keys fallback; S1 test rename. R2 SKIPPED with documented rationale (C1 fold is contained data-flow change pinned by regression).

**P3 queue items added** (`docs/planning/next-sessions-queue.md`): S5-P4-B1-W1 (consecutive_failures unbounded auto-archive), S5-P4-B1-W2 (chained-dispatch cycle test for Phase 5), S5-P4-B1-R1 (env-override MAX_SKILL_CALL_DEPTH), S5-P4-B1-R2 (counter-increment regression test), S5-P4-B1-I1 (`resolution='self_recovered'` enum extension — batches with S5-P2-I1 for v8.0 schema reset).

**What's left in Phase 4**: nothing — B2 ships next and closes Phase 4 (see §6.2).

---

## §6.2 — Phase 4 Bundle 2 + Phase 4 closure (2026-05-19)

**Commit**: `6a456f0` — 3 deferred builtin tools + ToolSource registration. Closes Phase 4.

**Shipped surfaces**:

- `src/tools/builtin/skill-describe.ts` — L1 metadata tool. Returns `{ok, skill?: {name, description, version, inputs[], output_type, is_certified, active, use_count, success_count, consecutive_failures, last_test_run_at, last_used}}`. `deferred:true readOnlyHint:true idempotentHint:true`.
- `src/tools/builtin/skill-load.ts` — L2 view tool. Returns L1 + `{body, trigger_examples[], tools_used[], version_is_current}`. Supports explicit `version` arg with proper version-not-found / dangling-pointer envelopes. C2 audit fold added `version_is_current` so callers can scope `is_certified` correctly. `deferred:true readOnlyHint:true idempotentHint:true`.
- `src/tools/builtin/skill-run.ts` — thin wrapper over `runSkill` from B1's dispatcher. Validates `name` + `args` envelope; surfaces a uniform JSON envelope: success → `{ok:true, output, durationMs}`, failure → `{ok:false, errorClass, errorDetail, durationMs}`. `deferred:true destructiveHint:true openWorldHint:true riskTier:medium`.
- `src/tools/sources/skills.ts` — manifest bump to 1.1.0; registers 5 tools (skill_save + skill_list legacy + the new L1/L2/exec trio).
- `src/tools/registry.test.ts` — ALL_TOOLS production invariant set extended with the 3 new tools; expected count 189 → 192 (audit trail comment added).

**Spec compliance**:

- §7 L1/L2/execute disclosure ladder: ✅ implemented as 3 separate deferred tools
- §11 Mode 2 callable tools: ✅ all 3 tools `deferred:true` per the spec's prompt-token-budget invariant. Per `feedback_tool_deferral.md`, deferring saves ~52% prompt tokens — load-bearing on a 192-tool registry

**R1 audit folds (in-bundle)**:

- **C1 args strictness clarity**: tool description now explains "unknown keys are rejected; for `inputs: []` skills pass `args: {}`" — regression test added
- **C2 per-version certification semantics**: `version_is_current` field added to L2 payload; 2 regression tests (explicit current/non-current branches)
- **W1 description honesty**: dropped "certified" claim from skill_run USE WHEN; matches dispatcher's active-only gate
- **W3 safeParse signature**: tightened return type from `T | unknown` to `T`; regression test pins fallback
- **W4 query consolidation**: skill_describe now issues 2 SELECTs instead of 3 (folded inputs_json into extras)

**R1 audit findings rejected (auditor self-corrected)**:

- **W2 idempotentHint=true on describe**: MCP spec says idempotentHint describes the call's side effects, not result stability. describe has no side effects → flag is correct. No fold.
- **W6 \_callStack escape hatch**: `_callStack` is intentionally NOT in the tool JSON schema. Phase 5 in-process recursion (when a skill body calls another skill) MUST go through `runSkill()` directly, not `skillRunTool.execute()`. The tool surface is LLM-facing only.

**P3 queue items added** (`docs/planning/next-sessions-queue.md`):

- S5-P4-B2-W5 (skill_load body excerpt mode — measure cost first)
- S5-P4-B2-R2 (version_pointer_dangling test — defensive branch unreachable via lifecycle)
- S5-P4-B2-R3 (rename internal errorClass strings on public channels — when community-manager scope gets skill_run access)

**Phase 4 cumulative scoreboard**:

| Metric                   | B1     | B2     | Phase 4 total |
| ------------------------ | ------ | ------ | ------------- |
| LOC                      | +1450  | +810   | **+2260**     |
| Tests                    | +37    | +27    | **+64**       |
| R1 verdict               | PASS-W | PASS-W | —             |
| Folds in-bundle          | 4      | 5      | **9**         |
| Queued P3 items          | 5      | 3      | **8**         |
| Pre-existing-bug catches | 1      | 0      | **1**         |
| Production regressions   | 0      | 0      | **0**         |

**Live deploy verification**: `[mc] Tool source "skills" initialized (5 tools)` in boot log (2026-05-19 20:53 UTC). All 3 new tools registered alongside skill_save + skill_list.

**Live deploy verification**: `[mc] Tool source "skills" initialized (5 tools)` in boot log (2026-05-19 20:53 UTC).

---

## §6.3 — Phase 5 + Spine 3 closure (2026-05-19)

**Commits**: B1 `16e7ac8` (CLI surface) · B2 `e179c56` (5 production skills). Closes Phase 5 AND Spine 3.

**Bundle 1 — `mc-ctl skills` operator surface**:

- 4 subcommands added to `cmd_skills()`: `show <name>` (L2 view), `certify <name>` (manual is_certified override + audit-marker row), `archive <name> "<reason>"` (soft-delete active=0 + skill_failures audit row), `revert <name> <version>` (current_version_id repoint).
- All reuse the `cmd_skill_health` name-regex sanitizer. R1 PASS WITH WARNINGS: 1 Crit (archive non-transactional → folded BEGIN/COMMIT) + 3 Warn folded.

**Bundle 2 — 5 production skills**:

- `scripts/skills-seed-phase5.ts` — reads 5 SKILL.md from `seed/skills/`, upserts to jarvis_files, runs `skillSave` (critic) + `runSkillTests`.
- 5 skills authored as pure-reasoning transforms (the mini-runner test harness runs bodies as pure LLM calls, no tools): `planificar-proyecto-por-fases`, `resumir-avance-de-tareas`, `clasificar-prioridad-tarea`, `construir-peticion-http`, `evaluar-roi-de-fase`. Derived from the operator's highest-use legacy workflows.
- Live result: 5/5 critic-passed, 10/10 test runs pass, **activation gate query returns 5**.
- R1 PASS WITH WARNINGS, 0 Critical confirmed; 2 folds (drift-branch hint, cwd guard).

**Spec §13.5 — all Phase 5 tasks complete**:

1. ✅ `mc-ctl skills list/show/certify/archive/revert` + pre-existing `skill-health`
2. ⏭️ Frontend skills page — DEFERRED (V7.7-GUIDE: CLI is the operator surface; frontend is V8.x)
3. ✅ Activation check: `SELECT COUNT(*) ... is_certified=1 AND active=1` ≥ 5 → returns 5
4. ✅ 5 production skills picked, authored, tested, certified

**Spec §14 activation gate — MET**: 5 certified active skills, each with `result='pass'` test runs in the last 7 days. V8.0's S5 prerequisite is satisfied.

**Cumulative Spine 3 scoreboard (Phases 1-5)**:

| Metric                   | Value                                                            |
| ------------------------ | ---------------------------------------------------------------- |
| Phases                   | 5/5 closed                                                       |
| LOC                      | ~7355 net across ~55 files                                       |
| Tests                    | +176 vitest + 5 certified production skills (10 skill-test runs) |
| Bundles                  | 10 (P1x1, P2x2, P3x2, P4x2, P5x3 — P5-B3 is the closure doc)     |
| R1 audits                | 9 (one per code bundle; P5-B3 doc-only)                          |
| R2 audits                | 1 (Phase 2 B2 — prompt-injection bundle)                         |
| In-bundle folds          | ~30                                                              |
| P3 hygiene queued        | 21                                                               |
| Pre-existing-bug catches | 4                                                                |
| Production regressions   | 0                                                                |

**Open queue (21 P3 items)**: all in `docs/planning/next-sessions-queue.md` with triggers. Most load-bearing: S5-P2-I1 + S5-P4-B1-I1 + S5-P5-B1-W4 — three schema-CHECK-enum-gap items batched for the v8.0 schema reset.

**Substrate unblock**: Spine 2's `s5_skill_failure_rate` drift signal can now be operator-enabled.

---

## §7 — Cross-references

- Spec: `docs/planning/v8-substrate-s5-spec.md`
- Entry brief (cold-readable handoff): `docs/planning/v7.7-spine-3-entry-brief.md`
- Phase 1 audit log: `docs/audit/v7.7-spine-3-phase-1.md`
- Phase guide: `docs/V7.7-GUIDE.md` §"Spine 3"
- Predecessor closure deltas (template + patterns): `docs/planning/v8-substrate-s2-impl.md` + `v8-substrate-s3-impl.md`
- Bilateral-maturity pattern: inherited from Spine 2 (`enabled: 0` + `awaiting:` sentinel) — extends to Phase 2's `is_certified: 0` until critic gate clears
