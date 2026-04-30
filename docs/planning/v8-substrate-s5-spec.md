# V8 Substrate S5 — Skills as Stored Procedures

> **Status**: Spec, not implementation. Freeze-aligned (no code changes proposed for the 2026-04-22 → 2026-05-22 window).
> **Authored**: 2026-04-30 — synthesis of V8-VISION §3-S5, the existing skills shim (`src/db/skills.ts`, 57 skills), the 2026-04-30 scout findings on DATAGEN (frontmatter + 3-level disclosure) and Voyager (description-embedding + critic-as-gate + failed-tasks anti-list).
> **Activation gate** (per V8-VISION §3-S5): "at least 5 production-grade skills exist by end of v8.0; all have green test runs in the prior 7 days; operator can list them with one command."
> **Reading order**: §1 problem → §2 current state → §3 two precedents → §4 frontmatter → §5 storage → §6 retrieval → §7 lifecycle → §8 critic gate → §9 test harness → §10 failure handling → §11 ToolSource integration → §12 cross-substrate → §13 phasing → §14 measurement → §15 open questions.

---

## §1 — Problem

V8.2's Strategic Initiative Layer requires Jarvis to propose work and execute it. "Propose work" cannot scale on ad-hoc tools — the operator should not need to remember whether a capability is a builtin tool, a slash command, an MCP tool, a ritual, or a skill. Anthropic's Skills paradigm makes capabilities first-class, versioned, testable, and discoverable.

Today's skill shim works (57 skills, ToolSource registered, keyword retrieval) but lacks the four properties V8.2 needs:

1. **Versioned** — currently `INSERT OR UPDATE` overwrites silently; no history, no rollback
2. **Testable** — no stored input/output tests, no test-runs table, no green/red signal
3. **Discoverable by intent** — keyword `LIKE` matching loses on Spanish/English mixed corpora and on paraphrased intents
4. **Quality-gated** — `saveSkill()` accepts any input; no critic, no validation pass

S5 closes those four gaps without throwing away the existing shim. The 57 skills migrate forward with a backfill pass; the schema is additive everywhere it can be.

---

## §2 — Current state (what exists)

| Artifact                              | What it does                                                                                                                                                    | What it lacks for v8                                                                                   |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/db/skills.ts`                    | CRUD on `skills` table — 57 rows, `saveSkill`/`getSkill`/`listSkills`/`incrementSkillUsage`/`deactivateSkill`/`getUnderperformingSkills`/`findSkillsByKeywords` | No version history, no tests, no embedding column, no failure log, no critic gate                      |
| `src/tools/sources/skills.ts`         | Registers skills as a tool source — already in `ToolSourceManager`                                                                                              | Currently surfaces skills as prompt context, not as callable tools                                     |
| `src/tools/builtin/skills.ts`         | `skill_save` / `skill_list` user-facing tools                                                                                                                   | No `skill_run`, no `skill_describe`, no `skill_test`, no `skill_load_full`                             |
| `src/intelligence/skill-discovery.ts` | Auto-extracts skill candidates from successful task traces (`source='discovered'`)                                                                              | No critic gate before promotion to active; no test-emission                                            |
| `skills` table                        | `(skill_id, name, description, trigger_text, steps, tools, use_count, success_count, source, active, ...)`                                                      | Steps + tools JSON-encoded inline; no `version`, no `tests`, no `embedding`, no `consecutive_failures` |

**What works well, keep**: `source` enum (manual/discovered/refined) is already a forward-compatible taxonomy. `use_count` + `success_count` are the right primitives. ToolSource integration is sound architecture.

**What blocks v8.2**: keyword retrieval, no critic, no tests, no version history.

---

## §3 — The two precedents (composed)

This spec composes two patterns lifted from external precedents (see `reference_datagen.md` and `reference_voyager.md`):

### From DATAGEN

- **Frontmatter contract** (`name` ≤64, `description` ≤1024, must include trigger conditions)
- **3-level progressive disclosure**: L1 metadata (name + 1-line desc, ~100 tok) → L2 instructions (steps + tool list, ~500 tok) → L3 resources (reference files, examples, scripts — loaded on demand)
- **Multi-file skills** — `SKILL.md` + optional `REFERENCE.md` + optional `scripts/`

### From Voyager

- **Embed the description, not the code** — vector retrieval over the L1 description; the steps body is irrelevant to retrieval
- **Critic LLM as the only write-gate** — separate inference call returning `{verdict, critique}`, retry budget = 3
- **`failed_tasks` anti-list** — failures fed back to the planner as "don't try this again right now"

### From the existing shim

- The `skills` table itself, the source enum, the `ToolSource` integration, and the 57-skill corpus

---

## §4 — Frontmatter contract

Every skill is authored as a markdown document with YAML frontmatter, mirroring DATAGEN exactly so we can adopt their tooling and docs without translation:

```markdown
---
name: skill-name # required, ≤64 chars, lowercase + hyphens
description: One sentence describing what this skill does and when to invoke it. Must include trigger conditions.
version: 1.0.0 # semver, required
inputs: # required, Zod-compatible schema
  - { name: foo, type: string, description: "...", required: true }
  - {
      name: bar,
      type: number,
      description: "...",
      required: false,
      default: 10,
    }
output_type: text | json | structured # required
trigger_examples: # ≥3 examples for retrieval grounding
  - "Send a follow-up to the lead..."
  - "Reach out to the contact about..."
  - "Check status on the prospect for..."
tools_used: # explicit list — read-only, used for capability check
  - whatsapp_send
  - crm_query
tests: # ≥1 required for activation
  - { name: happy_path, input: { ... }, expect: { ... } }
  - { name: empty_input, input: {}, expect_error: "INPUT_REQUIRED" }
---

# Skill body (instructions for the LLM)

## Steps

1. ...
2. ...

## Best practices

- ...

## Examples

- ...
```

**Why mirror DATAGEN exactly**: their docs (`SKILL_CONFIG.md`, `AGENT_CONFIG.md`) become directly usable for our operators. Their tooling decisions (≤64 char name, ≤1024 char description) reflect cache-window and retrieval realities we'll hit too.

**Backwards compat**: the existing 57 skills are auto-converted at migration time. `name` and `description` already exist; `steps` JSON becomes the body's "Steps" section; `tools` JSON becomes `tools_used`; missing fields get sane defaults (`version: 1.0.0`, empty `tests: []`, `inputs: []`). Skills without tests are flagged `is_certified: 0` and excluded from V8.2 proposal selection until tests are added.

---

## §5 — Storage layer (additive migration)

### Existing `skills` table — kept, augmented

```sql
ALTER TABLE skills ADD COLUMN version TEXT NOT NULL DEFAULT '1.0.0';
ALTER TABLE skills ADD COLUMN inputs_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE skills ADD COLUMN output_type TEXT NOT NULL DEFAULT 'text' CHECK (output_type IN ('text','json','structured'));
ALTER TABLE skills ADD COLUMN trigger_examples_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE skills ADD COLUMN tests_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE skills ADD COLUMN body_path TEXT;            -- jarvis_files path (skills/<name>/SKILL.md)
ALTER TABLE skills ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE skills ADD COLUMN last_failure_at TEXT;
ALTER TABLE skills ADD COLUMN is_certified INTEGER NOT NULL DEFAULT 0;   -- has ≥1 green test
ALTER TABLE skills ADD COLUMN current_version_id INTEGER;                -- FK to skill_versions.id
ALTER TABLE skills ADD COLUMN registry_sha TEXT;                          -- SHA256 of canonical form, for S3 drift detection
```

### New `skill_versions` table — write-only history

```sql
CREATE TABLE skill_versions (
  id INTEGER PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(skill_id),
  version TEXT NOT NULL,
  body TEXT NOT NULL,                   -- full SKILL.md content
  body_sha256 TEXT NOT NULL,
  inputs_json TEXT NOT NULL,
  tests_json TEXT NOT NULL,
  tools_used_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT NOT NULL,             -- 'operator' | 'discovery' | 'refiner' | 'critic-revised'
  supersedes_id INTEGER REFERENCES skill_versions(id),
  critic_verdict TEXT NOT NULL CHECK (critic_verdict IN ('pass', 'fail_returned_anyway', 'skipped')),
  critic_critique TEXT,
  UNIQUE(skill_id, version)
);
CREATE INDEX idx_skill_versions_skill ON skill_versions(skill_id);
```

**Why a versions table not a soft-delete on skills**: Voyager's pattern (`nameV2.js`, `V3.js` filenames) gets the forensic trail right but the wrong storage. SQLite version history with `supersedes_id` FK gives us:

- Read-after-rollback: query a previous version body without filesystem traversal
- Cross-skill dependency tracking: a future skill can pin to "version 2.x.x"
- Audit invariant: `current_version_id` on `skills` table always points to a row in `skill_versions`

### New `skill_test_runs` table

```sql
CREATE TABLE skill_test_runs (
  id INTEGER PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(skill_id),
  version_id INTEGER NOT NULL REFERENCES skill_versions(id),
  test_name TEXT NOT NULL,
  ran_at TEXT NOT NULL DEFAULT (datetime('now')),
  result TEXT NOT NULL CHECK (result IN ('pass','fail','error','timeout')),
  actual_output_json TEXT,
  expected_output_json TEXT,
  diff_summary TEXT,
  duration_ms INTEGER,
  task_id TEXT REFERENCES tasks(id)
);
CREATE INDEX idx_skill_test_runs_skill ON skill_test_runs(skill_id, ran_at DESC);
CREATE INDEX idx_skill_test_runs_recent ON skill_test_runs(ran_at DESC);
```

**Activation invariant**: a skill is "certified" (`is_certified=1`) iff every test in `tests_json` has a `result='pass'` row in `skill_test_runs` for the current `version_id` within the last 7 days. The V8.0 activation gate ("≥5 with green test runs in prior 7 days") becomes a single query.

### New `skill_failures` table — Voyager's anti-list

```sql
CREATE TABLE skill_failures (
  id INTEGER PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(skill_id),
  task_id TEXT REFERENCES tasks(id),
  failed_at TEXT NOT NULL DEFAULT (datetime('now')),
  input_json TEXT,
  error_class TEXT NOT NULL,            -- 'wrong_output' | 'tool_unavailable' | 'timeout' | 'critic_runtime_fail' | 'other'
  error_detail TEXT,
  resolved_at TEXT,                     -- NULL = active in anti-list
  resolution TEXT                        -- 'reverted_version' | 'fixed_in_new_version' | 'archived' | NULL
);
CREATE INDEX idx_skill_failures_active ON skill_failures(skill_id, resolved_at) WHERE resolved_at IS NULL;
```

### Body storage: `jarvis_files` with `skills/<name>/` qualifier path

- `skills/<name>/SKILL.md` — frontmatter + body, `qualifier='reference'`
- `skills/<name>/REFERENCE.md` — optional, loaded on demand
- `skills/<name>/scripts/*.ts` — optional, executable helpers (post-V8.0)

**Why split `skills` table from `jarvis_files` body**: separates fast-path metadata (loaded into prompt at every task) from cold-path body (loaded only when skill is selected). Mirrors DATAGEN's L1/L2/L3 directly.

---

## §6 — Retrieval (vector embedding over descriptions)

### The Voyager pattern, applied

Today's `findSkillsByKeywords()` does `LIKE '%word%'`. Replace with vector retrieval over the description field, indexed via `sqlite-vec` (already in jarvis stack via Hindsight).

```sql
ALTER TABLE skills ADD COLUMN description_embedding BLOB;  -- 1024-dim, sqlite-vec format
CREATE VIRTUAL TABLE skills_vec USING vec0(
  skill_id TEXT PRIMARY KEY,
  embedding FLOAT[1024]
);
```

**Indexing**:

- At every `skill_save` (and on migration backfill), embed `description + "\n" + trigger_examples.join("\n")` into the vec table
- Embedding model: same as Hindsight (currently qwen3-embedding-coder, dim=1024) — cache-friendly, already in the stack
- Re-embed on description or trigger_examples change

**Query**:

```typescript
function retrieveSkills(taskContext: string, k = 5): SkillRow[] {
  const queryEmbedding = embed(taskContext);
  const skillIds = db
    .prepare(
      `
    SELECT skill_id FROM skills_vec
    WHERE embedding MATCH ? AND k = ?
    ORDER BY distance
  `,
    )
    .all(queryEmbedding, k);
  return skillIds
    .map(({ skill_id }) => getSkill(skill_id))
    .filter(
      (s) => s && s.is_certified && s.consecutive_failures < 3 && !s.archived,
    );
}
```

**Failure-list filter**: skills with `consecutive_failures >= 3` are filtered out of retrieval automatically — Voyager's anti-list pattern at the query layer, not the planner layer. (We can revisit if the planner needs visibility into "what was attempted and failed.")

**Cache implications (S1 alignment)**: skill descriptions surface in the **variable** half of the prompt (not stable). Top-k results land in the variable section after the cache-break marker. Confirmed safe: per `feedback_cache_prefix_variability.md`, variable content placed AFTER stable prefix doesn't reset the cache.

### Surfacing skills to the LLM

Two modes, both supported:

1. **As prompt context** (current default — kept) — top-k descriptions injected into variable half. Model selects via natural reasoning.
2. **As callable tools** (new) — when scope `skills` is active, the top-k matched skills are registered as deferred tools `skill__<name>` with the L1 description as the tool description and the L2 inputs as the Zod schema. Model selects via tool call.

Mode 2 is what V8.2 needs. Mode 1 stays for backward compatibility and for cases where the model wants to read the steps and execute manually (the existing 57-skill behavior).

---

## §7 — Lifecycle (the tool surface)

```typescript
// L1 metadata — cheap, no body load
skill_describe(name: string): { name, description, version, inputs, output_type, is_certified, last_test_run }

// L2 instructions — load steps + tools, no scripts
skill_load(name: string, version?: string): { ...L1, steps_md, tools_used, trigger_examples }

// L3 resources — load reference files + scripts (loaded into prompt as resources)
skill_load_full(name: string, version?: string): { ...L2, reference_md?, scripts? }

// Execute
skill_run(name: string, args: object, options?: { dry_run?: bool, version?: string }): SkillRunResult

// Test
skill_test(name: string, version?: string, test_name?: string): TestRunResult[]

// Author / revise
skill_save(frontmatter, body): SaveResult  // goes through critic, may bump version

// Lifecycle
skill_list(filter?: { active?, certified?, source? }): SkillRow[]
skill_archive(name: string, reason: string): void
skill_revert(name: string, to_version: string): void
```

`skill_run` semantics:

- Looks up active version of skill
- Validates `args` against `inputs` Zod schema
- Resolves `tools_used` against current scope (fail loud if any required tool unavailable)
- Executes steps via the existing fast-runner pathway with the skill's L2 body as system prompt
- Records to `cost_ledger` with `agent_type='skill:<name>'` (S4 alignment — every skill_run becomes a uniform cost row)
- On failure: increments `consecutive_failures`, inserts `skill_failures` row
- On success: resets `consecutive_failures=0`, increments `success_count`

---

## §8 — Critic gate (the Voyager pattern)

Every `skill_save` and `skill_revise` flows through a critic LLM call. This is the same primitive as S2's report critic — composed, not duplicated.

### Critic system prompt (template)

```
You are the audit gate for a skill submission. Your job is to detect:

1. INTENT CLARITY: does `description` clearly state what the skill does AND when to invoke it? "Helper for X" is a fail. "When the user asks to <X>, do <Y>" is a pass.
2. INPUT/OUTPUT INTEGRITY: do `inputs` declarations match what the steps actually consume? Does `output_type` match what steps produce?
3. TOOL DECLARATION: are all tools the steps reference present in `tools_used`? Are any in `tools_used` unused?
4. TEST COVERAGE: ≥1 test covering happy path, ≥1 edge case (empty input, invalid input, or boundary). Single-test skills are flagged unless V8.0 activation gate is the explicit context.
5. NAMING: does `name` reflect the action (verb-led: "send-follow-up", not "follow-up-helper")? Is it ≤64 chars, lowercase+hyphens?
6. DUPLICATION: does this skill already exist? Vector-search the existing skill descriptions and flag close matches (>0.85 similarity).

Return ONLY: { "verdict": "pass" | "fail", "critique": "<one paragraph max if fail; empty if pass>" }
```

### Retry policy

- 3 producer revisions max
- After 3, the submission is rejected with a `concerns` field; operator sees the critique and chooses to override (writes `created_by='operator-override'`)
- Override path is operator-only (not Jarvis-autonomous) — pre-V8.3 perimeter

### Cost model

- Critic ~30% of producer prompt size (sees only the frontmatter + body, not the full task context)
- Worst case: 4× critic per submission
- **Mitigation**: critic is the same call shape as S2's report critic. Build once, use twice.

---

## §9 — Test harness

### Test format (in frontmatter)

```yaml
tests:
  - name: happy_path
    input: { lead_id: "abc123", message_kind: "follow_up_24h" }
    expect:
      output_type: structured
      output_match:
        sent_count: 1
        recipient: "abc123"
  - name: empty_lead
    input: { lead_id: "", message_kind: "follow_up_24h" }
    expect_error:
      class: INPUT_REQUIRED
      detail_contains: "lead_id"
```

### Test execution

- `skill_test(name)` runs every test in `tests_json` in isolation
- Each test is a `dry_run=true` `skill_run` call against a sandboxed scope (no actual writes to external systems — tools registered with `dry_run` flag return mock outputs declared in the test fixture)
- Result written to `skill_test_runs`
- A skill becomes `is_certified=1` iff every test has `result='pass'` for the current version within the last 7 days

### Scheduled test sweeps

- Cron-driven (every 6h) test pass over all `is_certified=1` skills
- Failures decertify automatically (`is_certified=0`) and emit a notification
- `mc-ctl skill-health` shows certified count, last-run age, failures by category

---

## §10 — Failure handling (Voyager's anti-list)

### Per-call failure tracking

Every `skill_run` failure (validation error, tool error, output mismatch, timeout) writes to `skill_failures` and increments `consecutive_failures` on the skill.

### Anti-list semantics

- `consecutive_failures < 3`: skill is normally retrievable
- `consecutive_failures >= 3`: skill is filtered out of vector retrieval (anti-list active)
- Operator sees failed skills via `mc-ctl skill-health` with the recent failure entries
- A successful run resets `consecutive_failures=0` AND marks all unresolved `skill_failures` rows as `resolved_at = now`, `resolution='self_recovered'`
- A `skill_revise` (new version) marks resolved as `resolution='fixed_in_new_version'` and resets the counter

### Distinct from S2

S2's critic catches **reports** that fail audit. S5's critic catches **skills** at write-time. S5's failure log catches **skills** at run-time. All three are different stages — same critic primitive, different artifacts.

---

## §11 — ToolSource integration (the discovery surface)

The existing `src/tools/sources/skills.ts` already registers skills with `ToolSourceManager`. The S5 changes:

### Mode 1 — prompt context (existing, kept)

Top-k retrieved skill descriptions injected into variable section of system prompt. Model reads, decides, executes inline by following the steps. No tool call. Cheapest, works for all 57 existing skills as-is post-migration.

### Mode 2 — callable tools (new, V8.2-ready)

When scope `skills` is active OR when a task message matches the skill scope regex, the top-k matched skills are registered as **deferred tools** named `skill__<name>` with:

- `description` = skill's L1 description (~1 sentence)
- `inputSchema` = generated Zod from the frontmatter `inputs`
- `handler` = wraps `skill_run(name, args)`

**Why deferred**: per `feedback_tool_deferral.md`, deferring saves 52% prompt tokens. Skills should default to deferred — the L1 metadata for a top-5 retrieved skill stays in prompt; the full tool definition only loads when the skill is invoked.

### Failure visibility to the LLM

A skill in the anti-list (`consecutive_failures >= 3`) is hidden from retrieval but visible to a future "skill-health-aware planner" via `skill_list({active: true, anti_list: true})`. V8.2 may want to surface "I tried `send_follow_up` but it failed 3 times — proposing manual handling instead." Defer this to V8.2 design.

---

## §12 — Cross-substrate alignment

S5 is the substrate item that touches the most other substrate items. Explicit alignment:

| Substrate                       | Alignment                                                                                                                                                                                                                                    |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S1 (cache-aware prompts)**    | Skill descriptions surface in variable half of prompt (after cache-break marker). Top-k retrieval is per-task; stable prefix unchanged                                                                                                       |
| **S2 (self-audit)**             | Skill outputs that are reports (briefings, proposals) MUST call `submit_report` before delivery. Skill `tests` use `verified_against` discipline for any numeric expectations                                                                |
| **S3 (drift detector)**         | Add `skill_registry_sha` to S3's drift invariants. Boot-time check compares `SELECT GROUP_CONCAT(registry_sha ORDER BY name) FROM skills WHERE active=1` against snapshot. Drift = unexpected skill add/remove/edit                          |
| **S4 (cost_ledger v2)**         | Every `skill_run` writes to `cost_ledger` with `agent_type='skill:<name>'`. Per-skill cost analysis becomes one query: `SELECT name, AVG(cost_usd), COUNT(*) FROM cost_ledger WHERE agent_type LIKE 'skill:%' GROUP BY agent_type`           |
| **V8.1 (proactive context)**    | Morning brief generation is itself a skill (`skill__morning_brief`). Lets us version the brief template, test it, audit it. V8.1 becomes "a particular instance of S5" rather than "a separate subsystem"                                    |
| **V8.2 (strategic initiative)** | Proposal generation is a skill set. `skill__propose_weekly_agenda`, `skill__propose_at_risk_review`. Each goes through critic + tests. The "options A/B/C" output discipline is enforced at the skill `output_type: structured` schema level |
| **V8.3 (autonomous gates)**     | Pre-authorized actions are skills with a `requires_approval: false` marker in frontmatter. The perimeter list V8.3 needs becomes "skills marked auto-approved." Gate logging hooks into `skill_run` lifecycle                                |

The compounding effect: once S5 ships, V8.1/V8.2/V8.3 become skill-authoring problems, not new-runner-building problems.

---

## §13 — Phasing (post-freeze)

### Phase 1 — schema + frontmatter parser (~2 days)

1. Migration: 9 ALTER TABLE columns on `skills`, 3 new tables (`skill_versions`, `skill_test_runs`, `skill_failures`)
2. Backfill: convert existing 57 skills to v1.0.0, populate `body_path` to `skills/<name>/SKILL.md` in `jarvis_files`, write initial `skill_versions` rows
3. `src/skills/frontmatter.ts` — parse + validate per §4 schema
4. Tests: schema validation, backfill correctness, version-history insert path

### Phase 2 — critic + test harness (~3 days)

1. `src/skills/critic.ts` — wraps S2's critic primitive (built first), critic-skill-specific prompt
2. `src/skills/test-runner.ts` — execute `tests_json` against skill in dry-run mode
3. `src/skills/lifecycle.ts` — `skill_save`/`skill_revise` flow with critic + retry budget
4. Cron task: 6-hourly test sweeps; decertify on failure; emit notifications
5. `mc-ctl skill-health` admin command
6. Tests: critic mock pass/fail, retry budget, decertification on failure, recovery path

### Phase 3 — vector retrieval (~2 days)

1. Migration: `description_embedding` column + `skills_vec` virtual table
2. Backfill: embed all 57 skills' descriptions
3. Replace `findSkillsByKeywords` with vector-based `retrieveSkills`
4. `src/skills/embedding.ts` — re-embed on description change (hook into `skill_save`)
5. Tests: retrieval quality on a held-out set of "task → expected skill" pairs (build the eval set during this phase)

### Phase 4 — callable-tools mode (~2 days)

1. Update `src/tools/sources/skills.ts` to register top-k matched skills as deferred tools when scope active
2. Tool descriptions = L1 description; schemas generated from `inputs`
3. Handler wraps `skill_run` with cost_ledger logging
4. Tests: deferred-tool registration, scope activation, schema validation on tool call

### Phase 5 — operator surface + activation gate (~1 day)

1. `mc-ctl skill list / show / test / health / archive`
2. Frontend: skills directory, recent runs, certification status
3. **Activation check**: `SELECT COUNT(*) FROM skills WHERE is_certified=1 AND active=1` ≥ 5
4. Pick 5 highest-leverage skills from the existing 57, write tests for them, certify

**Total**: ~10 days post-freeze. S5 is the largest substrate item by effort. Phasing lets us ship Phase 1+2 (schema + critic + tests) before Phase 3+4 (retrieval + callable-tools) — the test harness is the prerequisite for the activation gate.

---

## §14 — Activation gate & measurement

Per V8-VISION §3-S5: **"at least 5 production-grade skills exist by end of v8.0; all have green test runs in the prior 7 days; operator can list them with one command."**

### V8.0 activation query

```sql
SELECT name, version, last_test_run_at,
       (SELECT COUNT(*) FROM skill_test_runs WHERE skill_id = s.skill_id AND result='pass' AND ran_at >= datetime('now','-7 days')) AS recent_passes
FROM skills s
WHERE s.is_certified = 1 AND s.active = 1
ORDER BY s.use_count DESC;
```

V8.0 ships when this returns ≥5 rows with `recent_passes >= test_count` for each.

### Operational metrics (post-V8.0)

- **Certification rate**: `is_certified=1 / total active skills` — target >50% within 90 days of V8.0
- **Skill usage distribution**: top-10 skills by `use_count` should account for <80% of total runs (long-tail health)
- **Failure recurrence**: skills with `consecutive_failures >= 1` reset to 0 within 7 days >70% of the time (auto-recovery health)
- **Critic pass rate**: target 60-80% on first submission (lower = critic too strict, higher = critic too lenient)

### Watchpoints

- Critic pass rate < 50% sustained → critic prompt needs tuning
- Vector retrieval recall < 70% on eval set → re-embed with different model or expand `trigger_examples`
- `skill_failures` table growing >50 rows/week → underlying skill quality issue, not anti-list issue

---

## §15 — Open questions

1. **Embedding model choice**: same as Hindsight (qwen3-embedding-coder, 1024d) — but Hindsight has known recall issues per `feedback_hindsight_rehab.md`. Worth piloting a smaller/faster model (e.g., bge-small) on the held-out eval set in Phase 3. Decision: defer to Phase 3 measurement.

2. **Skill scripts execution sandbox**: Phase 4+ adds `scripts/*.ts` support. Where do scripts run? Inline in fast-runner (security risk) or in nanoclaw (Docker isolation, latency cost)? Per `reference_smolagents.md` rejection of local AST sandbox, default to nanoclaw. Decision: defer to post-V8.0.

3. **Curriculum agent (Voyager pattern, full)**: Voyager has a curriculum module that proposes the next skill to attempt. We don't need this for V8.0 — skills are operator-authored or discovery-extracted. Defer to V8.2 (proactive context engine could propose new skills from observed gaps).

4. **Cross-skill composition**: can skill A invoke skill B? Spec says yes via `skill_run` from within the L2 body's tool list. But: detect cycles, bound depth (max 3), define what happens if B fails mid-A. Decision: spec allows it, implementation defers depth-bounding to Phase 4.

5. **Multi-language skills**: existing 57 skills are mostly Spanish (`leer_y_escribir_hoja_calculo`, `sincronizar_hojas_con_categorias_wp`). Frontmatter `description` and `trigger_examples` should be bilingual or consistently in operator's primary language? Recommend: language-tagged trigger_examples (`{lang: 'es', example: '...'}`); descriptions stay in operator's primary language. Decision: defer.

6. **Skill discovery → critic loop**: existing `skill-discovery.ts` extracts candidates from successful traces. Should auto-discovered skills go through critic before becoming `active=1`? Spec says yes — `created_by='discovery'` versions get critic-gated like manual ones. Adds latency to the discovery pipeline but matches Voyager's discipline. Decision: yes, ship in Phase 2.

7. **Operator override of critic**: can operator force-publish a critic-rejected skill? Yes, with `created_by='operator-override'` mark. Visible in `mc-ctl skill-health` for review. Pre-V8.3, this is the only override path; V8.3 may extend.

---

## §16 — Cross-references

- V8-VISION.md §3-S5 — original requirement
- `docs/planning/v8-substrate-s2-spec.md` — critic primitive shared with S5
- `reference_datagen.md` — frontmatter contract + 3-level disclosure
- `reference_voyager.md` — description-embedding + critic-as-gate + failed-tasks anti-list
- `feedback_tool_deferral.md` — defer skill tools by default
- `feedback_aci_hierarchy.md` + `feedback_aci_workflows.md` — skill descriptions teach domain hierarchy + workflow guidance
- `feedback_cache_prefix_variability.md` — skill descriptions are variable, after cache-break
- `feedback_hindsight_rehab.md` — embedding model latency reality
- `src/db/skills.ts` — existing shim, kept and extended

---

## §17 — One-page summary

| Item                 | Decision                                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Storage**          | Existing `skills` table + 9 new columns + 3 new tables (`skill_versions`, `skill_test_runs`, `skill_failures`). Body in `jarvis_files` with `skills/<name>/` qualifier path |
| **Frontmatter**      | DATAGEN's contract verbatim — `name`/`description`/`version`/`inputs`/`output_type`/`trigger_examples`/`tools_used`/`tests`                                                 |
| **Retrieval**        | Vector embedding over description + trigger_examples via `sqlite-vec`. Replaces `findSkillsByKeywords`. Top-k=5 default, anti-list filtered                                 |
| **Write gate**       | Critic LLM call on `skill_save` + `skill_revise`. 3-retry budget. Reuses S2 critic primitive                                                                                |
| **Test harness**     | `tests_json` in frontmatter. `skill_test_runs` table records every run. `is_certified=1` iff all tests pass within 7 days                                                   |
| **Failure handling** | `skill_failures` table = Voyager's anti-list. `consecutive_failures >= 3` filters from retrieval                                                                            |
| **Tool surface**     | `skill_describe`/`skill_load`/`skill_run`/`skill_test`/`skill_save`/`skill_archive`/`skill_revert`. Plus deferred `skill__<name>` tools when scope active                   |
| **Migration**        | Existing 57 skills auto-converted. Schema additive, applies live                                                                                                            |
| **Activation gate**  | ≥5 certified skills with green tests within 7 days                                                                                                                          |
| **Effort**           | ~10 days post-freeze across 5 phases                                                                                                                                        |
| **Freeze posture**   | Spec only. No code changes during freeze. Implementation post 2026-05-22                                                                                                    |
| **Dependencies**     | S2 critic primitive (built first; S5 reuses it). Embedding model already in stack                                                                                           |
| **Unblocks**         | V8.1 (morning brief becomes a skill), V8.2 (proposals become skills), V8.3 (pre-authorized = skill flag)                                                                    |
| **Open Q count**     | 7 (§15) — none are blocking                                                                                                                                                 |
