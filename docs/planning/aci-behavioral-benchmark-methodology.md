# ACI Behavioral Benchmark Methodology — Research Note

**Status:** Research deliverable, 2026-05-23. Closes Hermes April Tier-2 #2 ("Self-optimized GPT/Codex tool-use guidance methodology study"). No code change in this task. Output is the **decision** below + the smallest-viable-benchmark sketch in §5.

**Sources consulted**

- [Hermes Agent v0.8.0 release notes](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.4.8)
- [Hermes Agent tool-use enforcement configuration](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/configuration.md#tool_use_enforcement) (deep-linked to the `tool_use_enforcement` section)
- Hermes PRs referenced but not deeply inspected: #6120 (main feature), #5414 (GPT/Codex execution discipline guidance), #5931 (thinking-only prefill continuation)

---

## 1. What Hermes did

Hermes v0.8 introduced **`tool_use_enforcement`** — a system-prompt-layer injection that gates on the model family (`gpt`, `codex`, `gemini`, `gemma`, `grok`). Their team ran an "automated behavioral benchmark" against GPT/Codex and identified **5 failure modes**:

1. **Abandoning work on partial results** — model declares success after one of three required sub-steps.
2. **Skipping prerequisite lookups** — answers from priors instead of calling the indicated retrieval tool.
3. **Hallucinating instead of using tools** — fabricates an answer the tool was meant to produce.
4. **Declaring "done" without verification** — claims completion with no verifying tool call.
5. **Describing actions instead of executing tool calls** — "I would run the tests..." text where a tool call belongs.

Their **fix shape** is the load-bearing methodology insight: they did NOT edit each tool's description. They added a **meta-guidance layer above the tool catalog**, gated by model family, with three layers:

- General tool-use enforcement (all matched models)
- OpenAI execution discipline (GPT/Codex)
- Google operational guidance (Gemini/Gemma)

**`auto` mode is explicitly disabled for Claude, DeepSeek, Qwen.** Hermes's team concluded these models don't exhibit the GPT-family failure pattern strongly enough to warrant the prompt overhead.

## 2. Why the specific Hermes patches don't transfer

We're Claude-primary (Sonnet 4.6/4.7 via the Agent SDK is our production primary; see `feedback_anthropic_sdk_cutover_2026_05_10`). Hermes's own taxonomy says Claude doesn't need the GPT-family guards. Empirically this matches our observation — we don't see "I would call X" text-where-action-belongs as a recurring incident. Sonnet calls tools.

What Hermes ships in `tool_use_enforcement` is **inapplicable to our primary path**. The interesting question isn't "should we adopt their patches" — the answer is no. The interesting question is **does their methodology (behavioral benchmark → meta-guidance layer) apply to our different failure modes**?

## 3. Our actual ACI failure modes (different bestiary)

From the existing `feedback_*` memory cluster, classes that recur:

| #   | Failure mode                                                                                   | Frequency                                                                      | Sample memory file                                                         |
| --- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| A   | **Scope-classifier misses** — wrong tool group activated; downstream tools "missing"           | High                                                                           | `feedback_classifier_routing_insight`, `feedback_classifier_empty_vs_null` |
| B   | **Tool paralysis under broad scope** — too many tools in context, model thrashes               | Medium                                                                         | `feedback_kimi_tool_paralysis`, `feedback_prompt_bloat_tools`              |
| C   | **Subagent enum-candidate hallucination** — 75% FP on candidate-name lookups                   | Confirmed measured                                                             | `feedback_subagent_verification`                                           |
| D   | **Confirmation-gate misses** — destructive tool runs without confirmation prompt               | Low (covered by router auto-inject)                                            | `feedback_confirmation_gate_scheduled`                                     |
| E   | **Recall not consulted** — model answers from prior turn instead of calling `memory_search`    | Mostly closed (see `feedback_hindsight_recall_disabled` — recall path demoted) | `feedback_jarvis_kb_directive_loading`                                     |
| F   | **Cascading completion-claim drift** — sub-task reports "done" while underlying state is wrong | Medium                                                                         | `feedback_completed_task_failure_narrative`, `feedback_layered_bug_chains` |
| G   | **Required-tool-not-called** in classification/extraction loops                                | Medium                                                                         | `feedback_required_tools_pattern`                                          |

Among these, **C, F, G** are the closest analogues to Hermes's failure modes #2-4 (hallucination/skip-prereq/declare-done). But our manifestations are subtler — Sonnet rarely refuses to call a tool outright; it more often picks the wrong one, calls it with wrong args, or stops one tool short of verification.

## 4. Methodology adaptation for our patterns

The transferable insight from Hermes is the **process**, not the prompt patches:

> Observe behaviors on a controlled set of inputs → identify failure CLASSES (not one-off bugs) → patch at the RIGHT LAYER (often the meta-prompt or scope rules, not the individual tool description).

Layer ladder, in increasing distance from the tool:

1. **Tool description** — last resort for a class-wide problem; first resort for a per-tool problem
2. **Scope-classifier rules** — controls which tools enter context
3. **Per-submission `requiredTools` validation in the dispatcher** (`src/dispatch/dispatcher.ts:44, 430`) — controls "you must call X first"; not a registry-level annotation but a submission-level contract.
4. **System-prompt meta-guidance** — controls posture across the whole turn (Hermes's layer)
5. **Runner-level loop guards** — already-implemented behavioral nudges in `adapter.ts` (think-block exhaustion, repeat detection, compaction-exhaustion guard)

Hermes patched at layer 4. Many of our existing fixes live at layer 5 (loop guards), some at layer 1 (per-tool ACI tweaks). We have not systematically explored layer 4 because Claude's default posture is good enough that we've never had the GPT-family pain.

## 5. Smallest viable behavioral benchmark for our stack

If we wanted to run an analogous benchmark, the smallest viable shape:

**Eval surface (~50-100 prompts):**

- 20-30 prompts that exercise scope-classifier ambiguity (A)
- 10-15 prompts known to historically trigger tool paralysis (B)
- 10-15 enum-candidate lookups (C) — already partially measured at 75% FP
- 10-15 multi-step verification chains (F, G)

**What to log per run:**

- Tool calls actually made (sequence, args)
- Final assistant text
- Whether the "correct" tool was called first (ground-truth annotated per prompt)
- Whether a verification step was skipped
- Whether hallucinated content surfaced in the final text

**What to compute:**

- Per-failure-class pass rate (currently unknown for most classes)
- Cohen's kappa or similar for inter-run consistency at temperature=0
- Cost in tokens per pass-rate point (so we can value prompt-engineering effort)

**Where the benchmark lives:**

- A new `tuning/aci-benchmark/` dir with one JSON file per failure class
- Reuse `src/tuning/eval-runner.ts` infrastructure (already does prompt → infer → tool-call inspection)
- Cron entry: weekly, not nightly (this is a slow-moving signal, expensive to run)

**What we'd ship after the first run:**

- If pass rates are high (>90% per class): document baseline, close as "we're already good," monitor weekly for regression
- If pass rates are uneven: layer-1 patches for the worst tools, layer-2 patches if scope classifier is the bottleneck, layer-4 meta-guidance only if a pattern crosses tool boundaries

**Estimated effort to first signal:**

- Eval scaffolding: 4-6 hours (mostly reusing existing tuning/ infra)
- Ground-truth annotation: 2-3 hours (50-100 prompts × few minutes each)
- First measurement run: ~1 hour wall-clock (rate-limited Sonnet calls in series)
- First measurement run, API cost: ~$30-60 (Sonnet × 100 prompts × ~3 rounds each)
- First-pass analysis: 2-3 hours
- **Total to actionable signal: 10-15 hours.**

## 6. Decision recommendation

**Don't ship the benchmark this quarter unless an incident drives it.** Reasoning:

1. **The fix lands one layer up from where we'd measure.** Hermes's value was the meta-prompt patch, not the benchmark itself. We'd build measurement infrastructure to potentially find Claude-specific patches that we have no reason to think exist (Hermes explicitly excluded Claude from their guard family). **Benefit forgone — explicitly accepted:** a benchmark we already owned would also serve as a regression canary when new tools land or model versions bump. We accept this gap because (a) the build cost now exceeds the expected incident-driven discovery rate at our current pace, and (b) production traces + the existing `tuning/` eval surface already provide a slower-loop substitute for the canary role.

2. **Our recurring ACI failures already have direct fixes.** Scope-classifier (A), tool paralysis (B), and enum-FP (C) all have feedback memories and incremental ACI improvements. We're patching at layer 1/2/3 as bugs surface — the proportionate response.

3. **The 75% subagent enum-candidate FP is the only KNOWN cross-tool pattern.** That's worth its own targeted ship (better candidate-list construction + post-validation), not a benchmark to discover what we already know.

4. **Re-evaluate when:**
   - a session post-mortem shows a recurring failure class we haven't catalogued, OR
   - we add a non-Claude model family to the primary path (then Hermes's exact `tool_use_enforcement` becomes directly applicable), OR
   - a vendor model behavior change visibly degrades pass rates on existing tools, OR
   - **at each phase closure / quarterly cadence check** — a passive review hook so the deferral doesn't become permanent through neglect. Next quarterly: ~2026-08-23.

**Action this session: none.** This research note IS the deliverable. The methodology is documented; the decision is "skip for now, here's the trigger to re-evaluate."

Memory pointer: `feedback_aci_benchmark_methodology` references this file.
