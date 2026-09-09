# Usability Phase 1 R2 — folds verified + what the folds broke (2026-08-23)

Scope: same bundle as R1 (`scope-miss.ts`, `router.ts`, `telegram-stream.ts`,
`prompt-sections.ts`, `scope-classifier.ts`, `fast-runner.ts`). tsc clean;
518 scoped tests pass; router.test.ts green 3×.

**Verdict: FAIL — 2 Critical, 7 Warnings.** All 9 claimed folds land; two of
them opened new holes and one class (hallucinated ask) was closed by design
choice rather than by fix.

## Doctrine (transferable)

1. **A "return the base, not the union" fix is only as good as the OBJECT
   IDENTITY of `base`.** `decideActiveGroups`' inherited branch returned
   `{groups: inherited, base: inherited}` — one Set, two names. The consumer
   (`scope.ts:1154 activeGroups = preClassifiedGroups;`) mutates the set it is
   handed (20+ `.add()` sites incl. a `meta` expansion that adds 20 groups).
   Proven: prior `{meta}` + a "continúa" turn ⇒ stored prior becomes 21 groups
   / 160 tools. The author KNEW about the mutation (fixed it at the re-run site
   with "pass a copy") and missed the source. **Rule: when you learn a callee
   mutates its argument, grep every construction site of that argument for
   shared references — not just the call you were touching.**
2. **The "deliver as-is when nothing is missing" branch is where the feature's
   OWN failure mode lands.** The fold justified as-is from ONE benign corpus
   FP (11723 gslides_read). Joining the 20 hits against real
   `scope_telemetry.tools_in_scope` showed 3 in that branch: 1 benign, 2
   hallucinated asks — including 12465 where `shell_exec` WAS in scope (97
   tools, coding active) and the reply "…Necesito que me lo actives con
   \"usa shell_exec\"… ¿Me activas shell_exec?" reaches the phone byte-for-byte
   (`sanitizeDeliverable` leaves it unchanged). **Rule: before choosing a
   default for a branch, enumerate the branch's REAL population from telemetry
   — never generalize from the one example that motivated it.**
3. **A resolver that iterates the CLASSIFIER's group list cannot widen into
   groups the classifier can't emit.** `groupsForTool(..., groups = VALID_GROUPS)`
   iterates 23 names while `DEFAULT_SCOPE_PATTERNS` defines 35. 12 groups
   (alpha, backtest, diagram, finance, graph, kb_ingest, market_ritual, paper,
   pm_alpha, pm_paper, skills, utility) ⇒ 43 of 187 scoped tools can never be
   widened. Two lists that must be supersets, no test pinning it.
4. **An identifier regex is a tool-name ALLOW-LIST.** `\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b`
   rejects every double-underscore MCP name — 33/216 tools invisible
   (`mcp__*`, `browser__*`, `playwright__*`, `graphify-code__*`, `xpoz__*`,
   plus `grep`/`glob`). The prompt at prompt-sections.ts:133 names
   `mcp__supabase__query` as the example to ask for. Proven:
   `detectScopeMiss("Necesito \`mcp__supabase__query\` para esto.")` → null,
   and the new one-line prompt shape makes the delivered fragment WORSE than
   the old paragraph it replaced.
5. **Re-submitting a turn with a different tool list must rebuild everything
   DERIVED from the tool list.** The re-run replays `rerunSpec.description` —
   the first run's system prompt — while passing widened `tools`. Flag-gated
   sections diverge (`hasWordpress` false→true ⇒ "PROTOCOLO OBLIGATORIO:
   WordPress" absent while wp tools are live). The W8 fold rebuilt the
   time-context line and stopped there; the prompt is the far bigger derived
   input.
6. **Mutation-test the ROUTER's use of a helper, not just the helper.**
   `groupsForTool` sorts narrowest-first and a unit test pins the order — but
   swapping the router's `const [g] = …` for `gs.at(-1)` leaves 96/96 router
   tests GREEN and silently selects `meta` (160 tools) for every widening.
7. **Recall re-measured on the same corpus: 18/23 ≈ 78%** (was ~50%). The 5
   survivors name their own regex gaps: subjunctive `habilites` vs
   `habil[ií]ta(?:me|lo|la)?(?:s)?`; `me LAS habilites` vs the literal
   `necesito que me (digas|pidas|actives|habilites)`; `mi scope actual` vs
   `en este/el scope`; `Dímelo` absent from the `dime` alternation; markdown
   `**"usa X"` defeating the single-optional-quote ` ?["«"']?`. Plus 12021,
   where the ask is real but a "lo que haré en cuanto los tenga" plan pushes
   it out of the 700-char TAIL_WINDOW.

## Verified-good (do not re-flag)

- C1 fold real: `reset()` clears `editTimer`, zeroes `accumulatedText`, clears
  `finalized`, refreshes `lastEditTime` (so the re-run's first `doEdit` is
  throttled ≥1.5 s behind the fire-and-forget placeholder edit). No late
  chunk from run 1 — `task.completed` is emitted after the runner returns.
  Mutation: delete the `reset()` call → the Telegram test goes RED.
- C2 fold real: both `identitySection()` sites rewritten; a full `src/` grep
  finds no other keyword instruction. `scope-classifier.ts:54` keeps
  `"usa shell_exec"` as a RECOGNITION example — correct, not an instruction.
- W3/W5/W6/W8/W9 folds all land as claimed (`baseGroups` for implicit
  feedback; no `trackTaskOutcome` on the swallowed turn; `skill:` tags
  preserved; `linkScopeToTask` on the re-run; raw history + rebuilt time line;
  copied Set at the re-run site).
- Re-run cannot loop (re-run pending carries `rerunOf`, no `rerunSpec`).
- No flakiness: router.test.ts 3× → 96/96 each; `waAdapter` is rebuilt per test.

## Reproduction commands

- Branch classification (the decisive one): join the detector's hits against
  real telemetry — `SELECT tools_in_scope FROM scope_telemetry WHERE message = <userText>`
  and compute `requestedTools.filter(t => !inScope.includes(t))`. 20 hits →
  17 RERUN, 3 AS-IS.
- Aliasing proof: `decideActiveGroups(new Set(), new Set(["meta"]), () => new Set(), "continúa")`
  then `scopeToolsForMessage("continúa", [], DEFAULT_SCOPE_PATTERNS, opts, d.groups)`
  → `d.base` goes 1 → 21 groups.
- Sticky sim (415 sessions / 1587 decisions, `[scope-miss rerun]` rows excluded):
  median tools turn 1/3/5/10/15/20 — none 29/38/50/50/62/59 · R1 union-all
  29/50/50/50/76/76 · Phase-1 fold 29/50/50/50/62/76. Mean 46.5 / 49.5 / 48.0.
