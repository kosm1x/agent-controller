# Jarvis Execution-Improvement Plan (2026-07-04)

Derived from a data-grounded review of Jarvis's recent work (5 sampled task
outputs + `task_outcomes` aggregates). Two levers: **(A) remove friction** that
truncates/blocks good work (raise success), **(B) add gates** that catch subpar
output before it ships (raise the floor). Ordered by leverage ÷ effort.

## Evidence (baseline)

- 7d: 155 completed / 76 `completed_with_concerns` / 10 failed / 2 needs-context. 24h: 31 / 16 / 0 failed.
- The 10 "failures" are mostly `Orphaned across non-graceful restart` — infra, not cognition.
- 30 tracked tools at 100% success; fast runner 98.6% (Jarvis's own evolution audit, task 7050).
- **The `completed_with_concerns` flag over-fires**: task 7057 (a sharp CPQL reframing) is flagged; 7052 (clean VLCRM schema doc) is not — quality is comparable. The metric hides real problems.
- Genuine defects sampled: **7059** `error_max_turns` (35-turn cap → partial response); **7060** tool-scope wall (`no tengo jarvis_file_write/shell_exec en este scope` → circling → asks user) + internal-narration bleed into the delivered text.
- Turn caps: fast runner ~35; Prometheus `maxTurns:50 / maxIterations:90` (`src/prometheus/types.ts:251`).
- Scope is fixed at task start (`src/messaging/scope.ts`); **no mid-loop tool-scope escalation exists**.
- `reflect()`/verify runs only in the heavy runner (Prometheus); the fast runner has no verify gate.

## Phase 0 — Make the success metric trustworthy _(precondition, S)_ — **✅ SHIPPED 2026-07-04**

You can't target what you can't see. Tighten the concern signal so `completed_with_concerns`
means a real defect, and make it attributable.

- Add a `concern_reason` enum to `task_outcomes` (additive column): `max_turns` · `tool_scope_block`
  · `ungrounded_claim` · `delivery_error` · `partial` · `none`.
- Classify at the seam that currently sets `completed_with_concerns`, from concrete signals
  (turn-limit hit, a tool the agent needed was out of scope, empty/failed side effect, delivery
  fallback) — NOT a soft caveat on otherwise-good output.
- **Measure:** baseline the reason distribution for one week → attack the top reason.

## Phase 1a — Mid-task tool-scope escalation _(highest success leverage)_ — **✅ SHIPPED 2026-07-04 (cheap variant)**

Fixes the 7060 class. This is friction the git/write-guard fixes did NOT touch — it is scope
_activation_, not write _access_.

- **Cheap (S, this session):** widen the classification→scope map so build/coding tasks always
  activate the file+shell+git tool group (near-universal for build work). ~1 mapping change.
- **Architectural (M, later):** a `request_tools(group)` escape-hatch — when the loop needs a
  deferred group it asks, and the runner injects it (mirrors ToolSearch). Bounded + logged.
- **Measure:** `tool_scope_block` reason → near zero.

## Phase 1b — Turn budget _(later)_

Fixes the 7059 class. Batch the hot single-item tools (CLAUDE.md batch-tool pattern) to collapse
N turns → 1; budget-aware checkpoint-and-continue near the cap (resumable follow-up, no lost work);
route genuinely multi-step build tasks to heavy (50/90 cap). **Measure:** `max_turns` reason down.

## Phase 2a — Side-effect verify gate _(later)_

Fixes the stale-KB / unverified-deploy class (this session's "Deploy: no está live" _when it was
live_). Lightweight PEV gate on the fast runner for side-effecting tasks: after deploy/write/commit,
run a cheap check (hit the URL, re-read the row, `git HEAD`) and fail-the-claim on mismatch (V9
`PROMETHEUS_VERIFY_GATE` direction, extended to fast). Estado docs: ground in current reality, not
the prior doc — kills the stale-regeneration loop. **Measure:** `ungrounded_claim` reason.

## Phase 2b — Delivery hygiene _(later, S)_

Fixes narration bleed (7060). Deliver the extracted `finalAnswer` (field + `router.extractResultText`
already exist); strip tool-narration from `output.text` at the delivery seam.

## Phase 3 — Infra polish _(low priority)_

Pre-restart drain/checkpoint so deploy-time restarts stop orphaning in-flight tasks (the ~10/week
"failures"). Graceful shutdown partly drains; some still orphan.

## Sequencing & north-star

- **This session:** Phase 0 + 1a-cheap (both S, low-risk, biggest pain).
- **Next:** 1b batch + 2a verify gate + 2b delivery hygiene.
- **Later:** 1a-architectural escalation, Phase 3.
- **North-star:** genuine-defect rate (post-Phase-0 classifier), not the raw concerns flag. Target
  real-defect concerns **<10%** (from the inflated ~⅓), with `max_turns` + `tool_scope_block` → near zero.

Each ships behind a flag → `./scripts/deploy.sh` → live verification.
