# Closure-doc convention (v7.7 Spine 1 Phase 2c)

> **Audience**: anyone (operator or agent) authoring a phase-closure document (`V<X>-CLOSURE.md`, `V<X.Y>-CLOSURE.md`, project-closure docs).
>
> **Why this exists**: the v7.6 closure-audit pattern caught 4 fidelity bugs (R1-C1 stale tool count, R1-C2 missing §205 stability-rebenchmark acknowledgement, R1-W1 mis-attributed `aff70dc`, R1-W2 n=315 sample-window reframe). Each was a "claim made in the closure doc without an adjacent citation that would have surfaced the staleness." Codifying `verified_against:` on scoreboard rows turns the manual qa-auditor grep into a mechanical lint.

---

## The rule

**Every metric or factual claim in a closure-doc scoreboard MUST have an adjacent `verified_against:` line citing its source.**

A "metric claim" is any standalone number, count, percentage, dollar amount, commit hash, or named entity asserted as fact:

- "188 tools annotated"
- "4912 tests passing"
- "+1041 / -25 LOC"
- "shipped in commit `8c371fe`"
- "10 days from open"

A "scoreboard" is any section titled `## Scoreboard`, `## Ship summary`, `## Bundle scope`, `## Final tally`, or any markdown table or list whose primary purpose is enumerating shipped artifacts with measurements.

---

## Citation syntax

Adopt the same 8-variant discriminated union from the V8 S2 spec (`src/audit/report-schema.ts`). Each citation is a YAML-style line directly below the claim it cites:

```markdown
- 188 tools annotated
  verified_against: { type: sqlite, table: tools_registry, query_sha: a1b2..., row_count: 188, queried_at: 2026-05-19T01:30:00Z }
```

Or, for git-shipped artifacts:

```markdown
- Phase 2b shipped in commit `8c371fe`
  verified_against: { type: git, sha: 8c371fee123..., path: src/messaging/community-reply-gate.ts }
```

Or, for file-derived counts:

```markdown
- +1041 / -25 LOC
  verified*against: { type: git, sha: 8c371fe, path: /* `git show --stat 8c371fe` \_/ }
```

### The 8 citation variants

Mirror the S2 schema verbatim — the validator accepts the same shapes:

| Variant        | Fields                                                               | Use for                                            |
| -------------- | -------------------------------------------------------------------- | -------------------------------------------------- |
| `git`          | `sha`, `path?`                                                       | "shipped in commit X" claims, file-existence proof |
| `sqlite`       | `table`, `query_sha`, `row_count`, `queried_at`                      | DB-derived counts (tasks, tests, tools)            |
| `file`         | `path`, `sha256?`, `lines?`                                          | File-content claims, line-count from `wc -l`       |
| `cost_ledger`  | `query_sha`, `row_count`, `window_start`, `window_end`, `queried_at` | Cost claims                                        |
| `journal`      | `pid`, `window_start`, `window_end`, `line_count`, `queried_at`      | Operator-journal-derived claims                    |
| `recall_audit` | `query_sha`, `row_count`, `window_start`, `window_end`, `queried_at` | Recall/utility claims                              |
| `http`         | `url`, `status`, `fetched_at`, `body_sha256`                         | External-API-derived claims                        |
| `tool_output`  | `tool_name`, `call_id`, `output_sha256`, `queried_at`                | Runtime-tool-derived claims                        |

### Inline-table form (concise)

For scoreboard tables, the citation can live in a dedicated column instead of a separate line:

```markdown
| Metric | Value        | verified_against                                                                                                                    |
| ------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Tests  | 4941 passing | { type: tool_output, tool_name: vitest, call_id: pre-commit-8c371fe, output_sha256: ..., queried_at: 2026-05-19T02:10:57Z }         |
| Tools  | 249 live     | { type: tool_output, tool_name: mc-ctl status, call_id: post-deploy-2924246, output_sha256: ..., queried_at: 2026-05-19T02:09:00Z } |
```

The validator accepts both forms.

---

## What's exempt

Not every line in a closure doc needs a citation:

- **Narrative prose** — paragraphs describing context, rationale, trade-offs
- **Section headers** — `## Spine 1 — S2: Self-audit before reporting`
- **Lessons-learned text** — "R2 catches bugs INSIDE R1's fixes" (rule of thumb, not a measurement)
- **TODO / next-phase plans** — forward-looking, can't have queried_at >= started_at
- **Cross-references to other docs** — `See docs/V7.6-CLOSURE.md §X`

The convention applies to claims of past fact, especially measurements. If a line begins with a number or contains `N LOC | N tests | N% | commit X | shipped`, it's a candidate.

---

## How the lint works

`scripts/validate-closure-doc.ts <path/to/CLOSURE.md>` does:

1. Parse the markdown by line
2. Identify scoreboard sections (heading match + table/list detection)
3. For each line in a scoreboard, classify: claim, citation, prose, header
4. Match claims to citations — claim N matches citation N if the citation appears within `±SEARCH_RADIUS` lines (default 3)
5. Report unmatched claims with file:line + the claim text
6. Exit code: 0 clean, 1 warnings (unverified claims found), 2 parse error or invalid input

Example:

```
$ scripts/validate-closure-doc.ts docs/V7.6-CLOSURE.md
docs/V7.6-CLOSURE.md:204: claim "188/188 non-MCP production tools annotated" has no adjacent verified_against citation
docs/V7.6-CLOSURE.md:267: claim "10 days from open" has no adjacent verified_against citation
Exit 1: 2 unverified claims in 1 scoreboard
```

---

## Lessons the convention encodes

The v7.6 closure-audit's 4 fidelity bugs map to convention gaps:

| Bug                                                      | What the convention would have prevented                                                                                                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1-C1 stale 188-vs-186 tool count                        | `verified_against: { type: sqlite, query_sha: ..., row_count: 188 }` forces author to actually run the query at closure time, not paste from prior closure doc               |
| R1-C2 missing §205 stability-rebenchmark acknowledgement | Convention doesn't directly fix prose omissions — but the audit log's "criteria checklist" template (see CLOSURE-TEMPLATE.md) makes the omission visible                     |
| R1-W1 mis-attributed `aff70dc` to Spine 4                | `verified_against: { type: git, sha: aff70dc }` would have surfaced the actual commit message and exposed the misattribution                                                 |
| R1-W2 n=315 sample-window reframe                        | `verified_against: { type: recall_audit, query_sha: ..., row_count: 315, window_start: ..., window_end: ... }` makes the window explicit so a reader can spot temporal drift |

In aggregate: machine-checkable closure docs eliminate the entire bug-class of "claim without re-derivation at closure time."

---

## Adoption schedule

- **v7.7 (current)** — convention defined. v7.7-CLOSURE.md uses the template.
- **v7.6-CLOSURE.md** — NOT retroactively edited. Historical record stays. The validator can run against it as a back-test (and will surface ~30-40 unverified claims; that's expected, it predates the convention).
- **v7.8+** — convention enforced for all phase closures. Spine 7's `mc audit-closure` continuity tool will invoke `validate-closure-doc` automatically.
- **Project closures** (`project_*_closure.md` in memory) — convention is recommended but NOT required. These are operator-facing retrospectives, not phase-tag artifacts.

---

## Cross-references

- Template for new CLOSURE.md files: `docs/audit/CLOSURE-TEMPLATE.md`
- Validator CLI: `scripts/validate-closure-doc.ts`
- Validator library: `src/audit/closure-doc-validator.ts`
- Validator tests: `src/audit/closure-doc-validator.test.ts`
- Spine 1 Phase 2c audit log + retroactive V7.6-CLOSURE back-test: `docs/audit/v7.7-spine-1-phase-2c.md`
- Source schema (citation variants): `src/audit/report-schema.ts`
- v7.6 closure audit that motivated the convention: `docs/V7.6-CLOSURE.md` (fidelity-bug catches embedded in the doc itself)
- Spine 7 continuity tool that will wrap this validator: V7.7-GUIDE Spine 7 Part B (`mc audit-closure`)
