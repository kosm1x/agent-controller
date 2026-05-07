# Scope Architecture Rethink — Investigation Scope

**Authored**: 2026-05-07 (queue item #13, P3 deferred)
**Status**: scope/investigation only. Execution deferred until a 4th scope incident lands or until items #1–#12 are cleared.

## Why this exists

Three scope-gate incidents shipped in the 2026-04-22 → 2026-05-07 stabilization window:

1. **algebra-progress** — operator query "ya progresó algo el algebra?" failed to match the `northstar`/`memory` regex; classifier returned no scope; tool surface lacked the project-status query path.
2. **DENUE shell_exec** — operator drilldown query routed to a coding scope without DENUE tools loaded.
3. **Write-tool friction** — `jarvis_file_write` gated behind `jarvis_write` regex (Rumi mitigation 2026-04-14). Short confirmations like "Procede" / "Tenlo listo" didn't trigger; resolved 2026-05-07 by promoting the four `jarvis_file_*` tools to `MISC_TOOLS` always-on.

All three had the same shape: a narrow regex gate too tight to admit legitimate operator phrasing. Each was patched by widening the regex; the third capitulated and dropped the gate entirely.

Per `feedback_two_week_freeze_synthesis.md`: **calling discipline belongs at the tool-description and system-prompt layers, not at scope. Scope decides what's _available_; the model decides what's _called_.** The Rumi class of bug is a calling-discipline problem, not an exposure problem — fix it where calls are decided, not where tools are listed.

**Threshold**: if a fourth scope-gate-related incident hits, this item jumps from P3 to P1 and execution starts.

## Two architectural options to evaluate

### Option A — Keep narrow scope gates + invest in regression suite

**Shape**: scope.ts stays as-is. Add a per-pattern regression test catalog: each scope group's regex gets ≥10 phrasings the operator has actually used (positive examples) and ≥5 phrasings that should NOT match (negative examples). New PRs touching scope.ts must update the catalog.

**Pros**:

- Minimum invasiveness; existing classifier+regex+inheritance flow stays.
- Each regex change is testable — the catalog catches narrow regressions.
- Protects the prompt-token budget: deferred tools stay deferred (52% prompt-cut benefit per `feedback_tool_deferral.md`).

**Cons**:

- Doesn't change the structural fragility — narrow gates remain narrow. Catalog catches drift but doesn't expand admission.
- Each new operator phrasing pattern still requires a regex edit + catalog entry → still one-off patches.
- Doesn't address the Rumi-class anti-pattern (model calls a tool that's available but inappropriate). Different layer.

**Effort**: ~1-2 days. Mostly catalog authoring.

**When this is right**: if scope incidents are a measurement problem (we can't see drift early enough). The catalog gives us drift-tests at PR time.

### Option B — Expand always-on surface for read-heavy / KB-write tools

**Shape**: identify the 5–8 tool clusters that the operator hits across most scope groups and promote them to `MISC_TOOLS` (always-on). Already done for `jarvis_file_*` (2026-05-07). Candidates next: `northstar_*` query tools, `project_list`, recall/retain primitives, cheap KB read-side tools.

The Rumi-class mitigation (preventing inappropriate calls of always-on tools) moves to:

- Tool description ACI guidance ("call this only when…")
- System-prompt high-stakes data guard
- Per-tool confirmation gates for destructive ops

**Pros**:

- Eliminates an entire class of operator friction (short confirmation phrases that don't trigger scope but are clearly intent to use a known tool).
- Calling discipline gets concentrated at the layer where it belongs (tool descriptions, system prompts).
- The prompt-token cost of expanding always-on is bounded — most candidates are read-side and small (<100 tokens of description each).

**Cons**:

- Increases prompt size by N×100 tokens. Need to measure against current 52% cut from deferral.
- Rumi-class bugs become "wrong tool gets called" instead of "tool isn't available" — symptom different, not necessarily fewer.
- Tool-description discipline must be tightened in lockstep, otherwise we just shift the failure class.

**Effort**: ~2-3 days. Per tool: write enhanced description, audit Rumi-class triggers, add system-prompt guard if needed, measure prompt-token delta.

**When this is right**: if scope incidents are an admission problem (the right tool is known but locked behind a phrase the operator wouldn't naturally use).

## Recommended decision sequence

Don't pre-commit to A or B. Run the diagnostic:

1. **Take inventory** of scope incidents over the last ~30 days (2026-04-08 → 2026-05-07). Five identified above; expect ~2-3 more in the historical scrollback.
2. For each incident, classify:
   - **Admission failure** (regex too narrow → operator phrasing didn't match): Option B is the right fix.
   - **Discipline failure** (tool was available, model called it inappropriately): tool-description layer; B doesn't help by itself; need system-prompt + ACI guidance.
   - **Genuine scope decision** (multiple groups overlap, classifier picked the wrong one): could need either tighter classifier (A) or broader admission (B).
3. Tally the distribution. If admission failures dominate → B. If discipline failures dominate → tool-description rework (separate item). If genuine scope decisions → A's catalog.

Threshold for promotion to P1: 4th scope incident in the next 30 days. If we hit that threshold, the inventory above tells us which option to execute first.

## Anti-patterns to avoid (carried from freeze synthesis)

- ⛔ **Don't add another regex arm to scope.ts as a one-off patch** without also updating the catalog (Option A) or scoping the architectural rethink. Three incidents in two weeks is structural, not local.
- ⛔ **Don't expand always-on surface without a tool-description audit** in lockstep. Without ACI guidance, expanding admission just moves the failure class.
- ⛔ **Don't skip the inventory step** before choosing A or B. The decision depends on which failure class dominates, and that's an empirical question, not an opinion.

## Cross-references

- `feedback_two_week_freeze_synthesis.md` — three patterns from the freeze, including this one.
- `feedback_jarvis_writes_always_on.md` — the third incident in the trilogy, capitulated to always-on.
- `feedback_scope_classifier_safety_net.md` — the second-incident-class (LLM classifier wrong group bypasses regex).
- `feedback_aci_workflows.md` — tool-description discipline for creation tools.
- `feedback_tool_deferral.md` — the prompt-token-cut benefit Option B trades against.
- `mc/src/messaging/scope.ts` — the file that would change under either option.
- `mc/docs/planning/next-sessions-queue.md` — item #13 ledger entry.

## Updates log

| Date       | Change                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------- |
| 2026-05-07 | File created. Investigation deferred to post-#1–#12 cleanup or on 4th scope-incident threshold. |
