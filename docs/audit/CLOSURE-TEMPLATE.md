# V<X.Y>-CLOSURE.md — Template

> **Use**: copy to `docs/V<X.Y>-CLOSURE.md`, fill in placeholders, run `npx tsx scripts/validate-closure-doc.ts docs/V<X.Y>-CLOSURE.md` before tagging.
>
> **Lines marked `<!-- AUDIT: required -->` are scoreboard claims** the validator scans. Every such line needs an adjacent `verified_against:` citation. Lines without the marker are narrative prose and pass through.
>
> Citation grammar: `verified_against: { type: <enum>, ...fields }` on the line directly below the claim, OR in a `verified_against` column of a markdown table.

---

## Status

**Phase**: v<X.Y> · **Status**: Closed <YYYY-MM-DD> · **Tag**: `v<X.Y>-closed`

**Predecessor**: [`V<X.Y-1>-CLOSURE.md`](./V<X.Y-1>-CLOSURE.md)
**Successor target**: V<X.Y+1> (see `V<X.Y+1>-GUIDE.md` or `V<X+1>-VISION.md`)
**Operating principle of the phase**: <one-line principle from the GUIDE>

---

## Scoreboard

| Metric                               | Value       | verified_against                                                                                                 |
| ------------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------- |
| Spines closed                        | N/N         | { type: file, path: docs/V<X.Y>-GUIDE.md, sha256: ... }                                                          |
| Closure commits                      | <list>      | { type: git, sha: <head-sha> }                                                                                   |
| Total tests                          | <N> passing | { type: tool_output, tool_name: vitest, call_id: pre-commit-<sha>, output_sha256: ..., queried_at: ... }         |
| Tools live                           | <N>         | { type: tool_output, tool_name: mc-ctl status, call_id: post-deploy-<pid>, output_sha256: ..., queried_at: ... } |
| Pre-existing bugs found across phase | <N>         | { type: file, path: docs/audit/v<X.Y>-spine-\*.md, sha256: ... }                                                 |
| Bundle-regressions caught            | <N>         | { type: file, path: docs/audit/v<X.Y>-spine-\*.md, sha256: ... }                                                 |
| Days from open to close              | <N>         | { type: git, sha: <open-tag-or-commit>, path: docs/V<X.Y>-GUIDE.md }                                             |

---

## Spine-by-spine evidence

### Spine 1 — <name>

- Shipped <YYYY-MM-DD> · commits: `<sha1>`, `<sha2>`, ... <!-- AUDIT: required -->
  verified_against: { type: git, sha: <head-of-spine-1> }
- Tests added: <N> <!-- AUDIT: required -->
  verified_against: { type: file, path: docs/audit/v<X.Y>-spine-1-\*.md, sha256: ... }
- Audit log: [docs/audit/v<X.Y>-spine-1.md](./audit/v<X.Y>-spine-1.md)
- Pre-existing bugs caught: <N> <!-- AUDIT: required -->
  verified_against: { type: file, path: docs/audit/v<X.Y>-spine-1.md, sha256: ... }
- Bundle-regression catches: <N>C / <M>W / <K>I <!-- AUDIT: required -->
  verified_against: { type: file, path: docs/audit/v<X.Y>-spine-1.md, sha256: ... }

<!-- repeat for each spine -->

---

## Three patterns observed in this phase

Lessons that generalized. Each pattern names the bug-class it prevents, where future maintainers can apply it, and which spine(s) surfaced it. Narrative — citations NOT required (these are interpretations, not measurements).

### Pattern 1 — <name>

<2-3 paragraph description. Cite specific findings from spine audit logs.>

### Pattern 2 — <name>

<...>

### Pattern 3 — <name>

<...>

---

## Residuals by tier

| Tier | Description                                                 | Items  |
| ---- | ----------------------------------------------------------- | ------ |
| A    | Open queue items (actionable next phase)                    | <list> |
| B    | Anti-mission deferrals (will not ship per phase contract)   | <list> |
| C    | Hygiene items (low-priority, queued with trigger)           | <list> |
| G    | Phase-boundary watchlist (e.g. stability re-benchmark date) | <list> |

---

## Recommended <next-phase> entry point

Concrete first action for the next phase. Reference the entry-brief doc if one exists.

---

## Closure criteria (per GUIDE)

Mirror the closure criteria from the phase's GUIDE. Tick each. Document any open items.

- [x] Criterion 1
      verified_against: { type: file, path: src/<file>, sha256: ... } <!-- AUDIT: required if metric -->
- [x] Criterion 2
- [ ] Criterion N — DEFERRED (reason + trigger in next-sessions-queue.md)

---

## Cross-references

- Operational guide: `docs/V<X.Y>-GUIDE.md`
- Pre-plan (READ-ONLY): `docs/V<X.Y>-PREPLAN.md`
- Spine audit logs: `docs/audit/v<X.Y>-spine-*.md`
- Phase memory: `~/.claude/projects/-root-claude/memory/project_v<X.Y>_closure.md`
- Source roadmap: `docs/V<X>-ROADMAP.md`

---

## Validator pre-commit

```bash
npx tsx scripts/validate-closure-doc.ts docs/V<X.Y>-CLOSURE.md
# Exit 0 = clean (all scoreboard claims cite sources)
# Exit 1 = N unverified claims (fix before tagging)
# Exit 2 = parse error
```

The lint is advisory — failures don't block commit, but they DO block the annotated tag. Convention: only ship `git tag v<X.Y>-closed` after the validator exits 0.
