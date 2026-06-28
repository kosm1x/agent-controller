/**
 * Skill evolution ritual — nightly analysis of task outcomes.
 *
 * Comprehensively audits 7 days of outcomes, identifies underperforming
 * skills, and deactivates them.
 *
 * The evolution report is persisted to memory DETERMINISTICALLY by the
 * dispatcher (`TaskSubmission.persistResult`), NOT by the agent calling
 * `memory_store`. That single discretionary call failed ~100% of the time on
 * Sonnet (0/10) — see the skill-evolution /diagnose, 2026-06-28 — gating the
 * whole ritual as "failed" for 9 straight days. The agent now does only the
 * tool-grounded analysis (get data → deactivate skills → emit report); the
 * report it produces as its final answer is what the dispatcher stores, so
 * persistence no longer depends on the model's tool choice.
 *
 * Model-tier note: the description carries complex signals so `resolveUseOpus`
 * (model-tier.ts) routes the ritual to Opus, not Sonnet. The load-bearing words
 * are `audit`, `thorough`, and `investigation` — NOT "comprehensively" (the
 * COMPLEX pattern is `/\bcomprehensive\b/i`, which the `-ly` suffix defeats).
 * Two independent risks: (1) re-adding a SIMPLE-pattern word — the OLD ritual's
 * "## Report format" header matched `/\bformat\b/i` (a SIMPLE signal) and is the
 * likely reason it ran on Sonnet; do not reintroduce "format"/other simple
 * words. (2) stripping all complex words — `assessTaskComplexity` defaults
 * no-signal text to complex, so that alone stays Opus, but don't rely on it.
 * The guarding test in evolution.test.ts pins `resolveUseOpus(description) ===
 * true` and catches the net flip either way.
 */

import type { TaskSubmission } from "../dispatch/dispatcher.js";

export function createEvolutionRitual(dateLabel: string): TaskSubmission {
  return {
    title: `Skill evolution — ${dateLabel}`,
    description: `You are Jarvis in evolution mode. Comprehensively audit recent task outcomes to improve future performance — a thorough investigation of which tools and skills are underperforming.

## Instructions

1. Call evolution_get_data to retrieve:
   - Tool effectiveness (per-tool success rates by task type, last 7 days)
   - Runner performance (daily success rate + avg latency)
   - Underperforming skills (active skills with <40% success rate on 5+ uses)

2. Analyze the data:
   - Which tools fail consistently for which task types? (e.g. "web_search fails 70% of the time on weather queries")
   - Are there runner performance trends? (e.g. "success rate dropped from 85% to 60% this week")
   - Which skills should be deactivated? (consistently low success, not useful)

3. For each underperforming skill with <30% success rate and 5+ uses:
   - Call evolution_deactivate_skill with the skill_id
   - Note it in your report

4. If there are no outcomes or insufficient data (<5 outcomes), say so briefly and produce a short report noting it.

## Output

Your FINAL ANSWER must BE the evolution report below — it is persisted
automatically. Do NOT call memory_store (you don't have it) and do NOT try to
save the report yourself; just produce it as your answer. (You SHOULD still call
evolution_deactivate_skill in step 3 when a skill qualifies — that is the
analysis acting on the data, not saving the report.)

EVOLUTION REPORT — ${dateLabel}

**Tool patterns:**
- [tool]: [success rate]% on [task type] tasks — [recommendation]

**Skills deactivated:**
- [skill name] (success rate: X%, uses: N) — [reason]

**Recommendations:**
- [actionable improvement for tomorrow]`,
    agentType: "heavy",
    tools: ["evolution_get_data", "evolution_deactivate_skill"],
    persistResult: { bank: "mc-operational", tags: ["evolution", "ritual"] },
  };
}
