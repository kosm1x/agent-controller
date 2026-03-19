/**
 * Skill evolution ritual — nightly analysis of task outcomes.
 *
 * Analyzes 7 days of outcomes, identifies underperforming skills,
 * and stores evolution insights in memory for enrichment to consume.
 */

import type { TaskSubmission } from "../dispatch/dispatcher.js";

export function createEvolutionRitual(dateLabel: string): TaskSubmission {
  return {
    title: `Skill evolution — ${dateLabel}`,
    description: `You are Jarvis in evolution mode. Analyze recent task outcomes to improve future performance.

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

4. Store your evolution report via memory_store:
   - bank: "operational"
   - tags: ["evolution", "ritual"]
   - Content should include: date, tool patterns found, skills deactivated, recommendations

5. If there are no outcomes or insufficient data (<5 outcomes), store a brief note and stop.

## Report format

EVOLUTION REPORT — ${dateLabel}

**Tool patterns:**
- [tool]: [success rate]% on [task type] tasks — [recommendation]

**Skills deactivated:**
- [skill name] (success rate: X%, uses: N) — [reason]

**Recommendations:**
- [actionable improvement for tomorrow]`,
    agentType: "heavy",
    tools: ["evolution_get_data", "evolution_deactivate_skill", "memory_store"],
  };
}
