# V8 Substrate S5 — Implementation Delta vs. Spec

> **Status**: Active spine (v7.7 Spine 3). Phase 1 of 5 complete; Phases 2-5 pending.
> **Authored**: 2026-05-19 · **Spec**: `docs/planning/v8-substrate-s5-spec.md`
> **Phase 1 commit**: `<this commit>`

Read this alongside the spec. The spec is _intent_; this is _delivered_. Where they diverge, this document explains _why_. The doc is rewritten on each phase close, accumulating the running ledger.

---

## §1 — High-level shape (running ledger)

| Aspect                      | Spec said                             | Shipped as                                                                                                                                                                                                                                                                     |
| --------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Effort                      | ~10 days across 5 phases              | Phase 1: ~1 hour (single bundle); Phases 2-5 pending                                                                                                                                                                                                                           |
| Frontmatter format          | YAML mirror of DATAGEN                | YAML-subset (scalar k/v + string arrays + comments). Complex shapes (`inputs[]`, `tests[]`) JSON-encoded into `*_json` string fields validated via Zod `.refine()`. Real YAML parsers can still read this — we just write a strict subset until/unless `yaml` dep is approved. |
| Schema                      | ALTER skills (10 cols) + 3 new tables | Same (P1) — 10 additive `ALTER TABLE skills ADD COLUMN`, plus `skill_versions` / `skill_test_runs` / `skill_failures`. All additive; safe on 67 existing rows.                                                                                                                 |
| Embeddings                  | qwen3-embedding-coder, dim=1024       | Phase 3 work — not shipped in P1                                                                                                                                                                                                                                               |
| Critic gate                 | Voyager pattern, retry budget 3       | Phase 2 work — not shipped in P1                                                                                                                                                                                                                                               |
| `skill_run()` callable tool | Phase 4                               | Not shipped in P1                                                                                                                                                                                                                                                              |
| Operator surface            | `mc-ctl skills`                       | Phase 5 — partial pre-existence (`mc-ctl skills` exists for legacy DB skills); full surface ships at P5 close                                                                                                                                                                  |
| Anti-mission                | Registers, does NOT author            | **HELD** in P1 — zero authored skills in bundle                                                                                                                                                                                                                                |

---

## §2 — Substrate state at Phase 1 close

Already shipped from earlier work:

- `src/db/skills.ts` — CRUD on `skills` table (67 live rows). Continues to work via DEFAULT values on the new ALTER'd columns; no breaking change.
- `src/skills/catalog.ts` — v7.6 Spine 5's frozen first-party catalog (HTML compose + SVG diagram = 6 skills). Separate layer from DB skills; not affected by Spine 3.

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

The spec lists 6 open Qs. Phase 1 touches Q4 and Q5 only.

| Q                                                              | Spec default     | Phase 1 outcome                                                                                                                                                                                                       |
| -------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1 Embedding model choice (qwen3-embedding-coder vs bge-small) | Pilot in Phase 3 | DEFERRED — Phase 3                                                                                                                                                                                                    |
| Q2 Phase 4 sandbox (nanoclaw vs inline)                        | Nanoclaw default | DEFERRED — Phase 4                                                                                                                                                                                                    |
| Q3 Failed-task anti-list TTL                                   | 7 days           | Phase 1 ships the `skill_failures` table only; TTL evaluation happens at retrieval time (Phase 3)                                                                                                                     |
| Q4 Frontmatter format strictness                               | Mirror DATAGEN   | **Confirmed strict + narrowed** — JSON-encoded inline for complex fields; bare YAML for scalars/arrays only. Spec's "mirror DATAGEN exactly" preserved on the SHAPE; the implementation choice is a no-dep narrowing. |
| Q5 Cross-skill composition (cycle detection)                   | Depth bound 3    | DEFERRED — Phase 4                                                                                                                                                                                                    |
| Q6 `created_by='discovery'` promotion path                     | Same critic gate | DEFERRED — Phase 2                                                                                                                                                                                                    |

**1 of 6 touched in P1**: Q4 confirmed-with-narrowing.

---

## §4 — Decisions NOT anticipated by spec

| Decision                                                             | Phase              | Rationale                                                                                                                                                                                                |
| -------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quote-aware comment stripping in the frontmatter parser              | P1 (R1-W1/W4 fold) | Naive `indexOf("#")` silently truncated `description: "Priority #1 ticket"`. R1 caught this.                                                                                                             |
| `JARVIS_SKILLS_BOOT_LOAD_DISABLED` env flag                          | P1                 | Tests init DB without firing the loader. Cleaner than mock-injection.                                                                                                                                    |
| Loader logs structured fields via `pino` adapter (msg + fields swap) | P1                 | mc uses pino's `({fields}, msg)` shape; the loader's `LoaderLog` interface uses `(msg, fields)` for ergonomics. Adapter at boot wire site.                                                               |
| `body_sha256` drift → log warning + leave row unchanged              | P1                 | Forensic-trail invariant per spec §5. Auto-overwrite would lose the prior body before Phase 4 ships skill_run.                                                                                           |
| 67 live skill rows NOT backfilled                                    | P1                 | Spec §4 says "auto-converted at migration time" → deferring to Phase 5 cleanup so the activation gate doesn't certify legacy bodies as Phase 1 noise. Tracked as `S5-P1-I1` in `next-sessions-queue.md`. |

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
