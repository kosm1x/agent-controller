---
name: swarm-fanout-routing-audit
description: Chat fan-out → swarm routing audit (2026-06-20) — classifier isFanOutTask + router extractResultText STRING branch
metadata:
  type: project
---

# Swarm fan-out chat routing audit (2026-06-20)

PASS WITH WARNINGS. classifier.ts `isFanOutTask` (produce-verb AND per-item quantifier) + messaging branch routes swarm before heavy; router.ts `extractResultText` STRING branch extended with content/output/result.

**Load-bearing finding — extractResultText STRING-branch fix targets a shape the live chat path never produces.**
- dispatcher.ts:636-641 is the ONLY `task.completed` emitter; emits `result: result.output` — the RAW OBJECT `{content,score,learnings,goalSummary}` from swarm-runner.ts:665-672 (object literal, never stringified).
- event-bus broadcast (bus.ts:317) is in-process BY REFERENCE. handleTaskCompleted (router.ts:1114→2245→2362) receives the OBJECT → hits extractResultText OBJECT branch (router.ts:2904-2910).
- The OBJECT branch ALREADY had `obj.content` BEFORE this PR (git diff shows only the STRING branch lines 2892-2898 changed; object branch untouched). So swarm chat replies were ALREADY delivered correctly via the object branch.
- router.test.ts manually does `result: JSON.stringify({content...})` + calls completedHandler directly (bypasses dispatcher emit) → tests the STRING branch the author wrote, NOT the OBJECT branch prod runs. Green but non-representative. The event bus is vi.mock'd; the test never exercises dispatcher.ts:639.
- Net: STRING-branch change is harmless/defensible (DB-replay/a2a paths could deliver strings) but is NOT what makes swarm chat replies work; the "without this a swarm reply delivered raw JSON" rationale is FALSE for the in-process path. Object branch did it.

**Precedence asymmetry (Info):** STRING branch order = text>content>output>result; OBJECT branch order = text>output>result>content (content LAST). Divergent. For swarm {content} both still resolve content (only key present) so no live bug, but the "mirror the object branch's key order" comment is inaccurate — orders differ.

**Detector (classifier.ts:275-283):** AND-gate (FANOUT_PRODUCE_VERB && FANOUT_QUANTIFIER) is tight. Verified holes:
- `analiza/analizar/investiga/research` are PRODUCE verbs → "analiza todos los X" / "investiga cada Y" reach swarm. Borderline: read-ish verbs + quantifier escalate to ≤10-agent swarm. Cost blast-radius concern for phrasings like "dame un análisis de cada reunión" — but "dame"/"explícame" aren't in the verb list so most read-each stays fast. "analiza cada" is the realistic over-escalation.
- `todos los` quantifier is broad: "crea un resumen de todos los puntos" → swarm (likely 1 artifact, not N). FANOUT over-fires on "todos los" + produce verb where intent is single-artifact-covering-many.
- coding-fan-out precedence is SAFE: isCodingTask runs FIRST (classify line 316), "escribe un test para cada módulo" → nanoclaw (write+test/módulo). Intended boundary; documented.

**Kill switches verified correct:** SWARM=false → heavy (line 353 isFanOut term); HEAVY=false → advancedRouting false → fast. Both tested.

**UX gap (Warning):** swarm reply = aggregate `content` (reflectionResult.summary, a SUMMARY) not the per-item outputs. User asked "un archivo para cada prospecto" gets "creé 3 archivos" prose, not the 3 files' contents. Per-item outputs live in sub-task rows (parent_task_id), never surfaced to chat. Acceptable if artifacts are files (saved elsewhere); gap if user expected inline per-item results.

**validate-swarm.ts:** safe. Isolated /tmp DB copy, /proc env inherit never printed, --run gates spend. No live-DB write. One note: copies live mc.db incl. memories to world-readable /tmp/swarm-validate.db (not cleaned up) — minor info-at-rest, not secrets-in-logs.
