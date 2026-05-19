# V8 Substrate S5 — Implementation Delta vs. Spec

> **Status**: Active spine (v7.7 Spine 3). Phase 1 ✅; Phase 2 ✅; Phase 3 ✅ (B1+B2); Phases 4-5 pending.
> **Authored**: 2026-05-19 · **Spec**: `docs/planning/v8-substrate-s5-spec.md`
> **Phase 1 commit**: `422d985`
> **Phase 2 Bundle 1 commit**: `5866f49`
> **Phase 2 Bundle 2 commit**: `acfbdfd`
> **Phase 3 Bundle 1 commit**: `0d0bd5c`
> **Phase 3 Bundle 2 commit**: `144dc42`

Read this alongside the spec. The spec is _intent_; this is _delivered_. Where they diverge, this document explains _why_. The doc is rewritten on each phase close, accumulating the running ledger.

---

## §1 — High-level shape (running ledger)

| Aspect                      | Spec said                             | Shipped as                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Effort                      | ~10 days across 5 phases              | Phase 1: ~1h; Phase 2 B1: ~2h; Phase 2 B2: ~3h (incl. R1 FAIL→fold→R2 PASS); Phases 3-5 pending                                                                                                                                                                                                                                                             |
| Frontmatter format          | YAML mirror of DATAGEN                | YAML-subset (scalar k/v + string arrays + comments). Complex shapes (`inputs[]`, `tests[]`) JSON-encoded into `*_json` string fields validated via Zod `.refine()`. Real YAML parsers can still read this — we just write a strict subset until/unless `yaml` dep is approved.                                                                              |
| Schema                      | ALTER skills (10 cols) + 3 new tables | Same (P1) — 10 additive `ALTER TABLE skills ADD COLUMN`, plus `skill_versions` / `skill_test_runs` / `skill_failures`. All additive; safe on 67 existing rows.                                                                                                                                                                                              |
| Embeddings                  | qwen3-embedding-coder, dim=1024       | Phase 3 work — not shipped in P1                                                                                                                                                                                                                                                                                                                            |
| Critic gate                 | Voyager pattern, retry budget 3       | P2 B1 shipped: `runSkillCritic` mirrors S2's call shape with skill-specific 5-check prompt (DUPLICATION #6 deferred to Phase 3). Retry budget NOT in lifecycle — spec §8's "3 producer revisions max" refers to a producer agent revising in response to critique. Lifecycle returns critique to caller; Phase 4+ producer-helper may wrap in a retry loop. |
| `skill_run()` callable tool | Phase 4                               | Not shipped in P1                                                                                                                                                                                                                                                                                                                                           |
| Operator surface            | `mc-ctl skills`                       | Phase 5 — partial pre-existence (`mc-ctl skills` exists for legacy DB skills); full surface ships at P5 close                                                                                                                                                                                                                                               |
| Anti-mission                | Registers, does NOT author            | **HELD** in P1 — zero authored skills in bundle                                                                                                                                                                                                                                                                                                             |

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

## §6 — Next phase entry points

**Phase 2 (critic + test harness, ~3d)** ships:

- `src/skills/critic.ts` — second-LLM grade of body against declared tests, returns `{verdict: 'pass'|'fail', critique}` per spec §8
- `src/skills/test-harness.ts` — runs `tests_json` entries; writes `skill_test_runs` rows; `is_certified` flips after N green runs in 7d
- Wires critic into the loader: `created_by='boot-scan'` rows get `critic_verdict='skipped'` (today's state); a separate refresh path runs the critic on activation
- Updates `pointSkillAtVersion` to set `is_certified` based on the test harness outcome

Substrate-availability: Phase 2 unblocks `s5_skill_failure_rate` drift signal (currently `enabled=0` in Spine 2's registry with `awaiting:S5` sentinel).

---

## §7 — Cross-references

- Spec: `docs/planning/v8-substrate-s5-spec.md`
- Entry brief (cold-readable handoff): `docs/planning/v7.7-spine-3-entry-brief.md`
- Phase 1 audit log: `docs/audit/v7.7-spine-3-phase-1.md`
- Phase guide: `docs/V7.7-GUIDE.md` §"Spine 3"
- Predecessor closure deltas (template + patterns): `docs/planning/v8-substrate-s2-impl.md` + `v8-substrate-s3-impl.md`
- Bilateral-maturity pattern: inherited from Spine 2 (`enabled: 0` + `awaiting:` sentinel) — extends to Phase 2's `is_certified: 0` until critic gate clears
