# Sprint 1 R-2 — Tool Description Tightening: Sprint 2 Hand-off

**Status:** R-2 (Sprint 1) shipped the **structural guardrail only**. Bulk trimming of 15 outliers is queued for Sprint 2+.
**Date:** 2026-05-23.
**Closes:** task #205 (R-2 of Sprint 1).
**Hand-off target:** any Sprint 2 trimming session.

---

## What R-2 actually shipped (Sprint 1)

Three guardrail tests in `src/tools/registry.test.ts` ("Tool description length guardrail (Sprint 1 R-2)"):

1. **DESC_THRESHOLD = 1500 chars** — any tool whose `definition.function.description` exceeds this MUST be in `TOOL_DESC_EXCEPTIONS`.
2. **Stale-exception check** — exception keys must reference live tool names.
3. **Stale-safety-net check** — exempted tools must actually exceed the threshold (catches trimmed-but-not-removed entries).
4. **Per-tool drift cap (audit W1 fold)** — each exempted tool has a `maxLen` ceiling. Without this, exempted tools could grow without bound while the other three tests still pass.

The guardrail is **one-shot work** — it prevents future creep regardless of whether Sprint 2 actually trims anything.

## What R-2 did NOT ship

**No tool descriptions were modified.** The original task description called for halving mean tool description size (30% reduction across ~250 tools). After surveying, the honest re-scope was: each of the 15 outliers is **load-bearing ACI** per `CLAUDE.md` ("Tool definitions are prompts — they deserve more engineering than the handler code"). Bulk trimming risks degrading the LLM's tool-selection accuracy.

The guardrail forces deliberate deferral rather than silent neglect: every tool above 1500 chars is named in the exception list with a documented reason.

## The 15 currently-exempted tools (Sprint 2 candidates)

Listed by length descending; the maxLen in `TOOL_DESC_EXCEPTIONS` is `current_length + 50` (slack for minor edits).

| Tool                        | Current len | maxLen cap | Reason for length                                         |
| --------------------------- | ----------- | ---------- | --------------------------------------------------------- |
| `video_html_compose`        | 5278        | 5328       | HTML/CSS composition rules + render policy                |
| `northstar_sync`            | 2928        | 2978       | 4-phase sync architecture + LWW + safety abort            |
| `infographic_generate`      | 2551        | 2601       | chart taxonomy + spec validation + format constraints     |
| `google_workspace_cli`      | ~2594       | 2644       | dispatch routing across Google Workspace APIs             |
| `submit_report`             | ~2124       | 2174       | quality-gate ritual instructions for report drafts        |
| `wp_publish`                | ~2057       | 2107       | WordPress publish policy + idempotency rules              |
| `hf_generate`               | ~2017       | 2067       | HuggingFace task taxonomy + model selection guidance      |
| `user_fact_set`             | ~1927       | 1977       | fact-persistence policy + conflict-resolution rules       |
| `gdrive_download`           | ~1789       | 1839       | binary-vs-export disambiguation + size limits             |
| `skill_run`                 | ~1745       | 1795       | skill invocation contract + arg-validation rules          |
| `jarvis_file_write`         | 1939        | 1989       | KB write policy + tag conventions + path rules            |
| `jarvis_files_batch_write`  | 1618        | 1668       | batch write contract + cap + partial-error policy         |
| `jarvis_files_batch_delete` | 1598        | 1648       | batch delete contract + confirmation + precious-path scan |
| `jarvis_file_read`          | ~1580       | 1630       | KB read modes (by path vs by tags) + result shape         |
| `gemini_research`           | 1547        | 1597       | Gemini Q&A research mode + document reference shape       |

**Sprint 2 first targets (highest leverage):** the three >2500-char outliers (`video_html_compose`, `northstar_sync`, `infographic_generate`). Halving each trims ~5400 chars from the catalog — more than the other 12 combined.

## Trimming acceptance criteria (for Sprint 2)

When trimming a tool description, the contributor MUST:

1. **Preserve all routing semantics** — keep WHEN-TO-USE and WHEN-NOT-TO-USE clauses. These drive correct tool selection.
2. **Preserve all safety semantics** — error policies (permanent vs transient), abort conditions, confirmation flows, idempotency rules. Trimming these risks regressions like the 2026-05-12 `northstar_sync` mass-deletion incident.
3. **Move OPERATIONAL detail to code comments** — 4-phase architectures, internal mechanics, debugging history. The LLM doesn't need these turn-by-turn.
4. **Move PARAMETER edge cases to Zod `.describe()` annotations** — per-arg constraints, format details, defaults. These travel with the schema and don't bloat the top-line description.
5. **Update the entry in `TOOL_DESC_EXCEPTIONS`**:
   - If the new length ≤ 1500: remove the entry (test 3 will trip if you forget).
   - If still > 1500: lower the `maxLen` to `new_length + 50` so the cap stays tight (test 4 will trip if you forget).
6. **Run the full test suite** — pre-commit hook validates the four guardrails AND any tool-specific tests.

## Sprint 2+ lowering of `DESC_THRESHOLD`

Once the 15 exceptions are trimmed (or the worst few are):

- Lower `DESC_THRESHOLD` from 1500 → 1200. This surfaces 11 additional candidates currently in the 1200-1500 range.
- 1200 → 1000 surfaces another 13 tools.
- 1000 is probably the practical floor (median is 91, mean is 271; the long tail past 1000 is consistently load-bearing tools).

## What the guardrail does NOT catch (known gaps for Sprint 2+)

- **Tool descriptions that grow via separate template-literal concatenation** — e.g., a tool that uses `description: "${BASE}\n${EXTRA}"` where BASE and EXTRA are constants defined elsewhere. The test reads `definition.function.description` after construction, so this works at test time; but if a contributor edits BASE or EXTRA externally, the guardrail still fires correctly.
- **Parameter descriptions** — the guardrail only checks the top-level function description, not per-parameter `.describe()` annotations. Per-parameter bloat is a separate (smaller) lever.
- **Deferred tool catalog text** — separate from individual tool descriptions; lives in the registry.

## References

- `/root/claude/mission-control/src/tools/registry.test.ts:383-588` — the guardrail tests
- `/root/claude/mission-control/docs/planning/sprint-1-baseline.md` — T-02 baseline (9% tool utilization, 50.7 mean tools loaded)
- `CLAUDE.md` — ACI principles section ("Tool descriptions are prompts...")
- Audit verdict: PASS WITH WARNINGS; W1 (drift cap) and W4 (this doc) folded same-bundle.
