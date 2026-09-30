---
name: jme-full-audit-2026-09-30
description: Whole-engine JME audit 09-30 (operator ruled JME stays): FAIL-to-harden, 3 Crit; turn-order tie, header-driven recall, dedup twin hidden by temporal dedup, no secret/role-spoof guard
metadata:
  type: project
---
Whole JME audit 2026-09-30 (not a diff audit). Verdict FAIL (3 Crit, all confirmed).

- C1 consolidateAll `ORDER BY ts ASC` has no `id` tiebreak; router writes user+jarvis turns in the same ms -> 10/25 live exchanges fed to Haiku REVERSED (Jarvis before Fede). getTurnsForTask had the tiebreak; sibling missed.
- C2 transcript `${role}: ${content}` joined by \n -> a Jarvis turn (web summary) can forge a `Fede:` line; no secret filter before extraction or insert (live #390 holds ESPN SWID). recall-utility/precedents already use redactSecrets.
- C3 upsertFact candidates come from queryMemory k=3 AFTER temporal dedup (keeps NEWEST) -> the true twin is absorbed; 6/32 emulated decisions wrong; 16 live pairs >=0.95.
- W: fast-runner recall query includes the `[Hoy: ...]` header -> "Listo" recalls 8 facts; minScore 0.25 inert (581/607 chat recalls return k=8); keyword top always 1.0.
- Latency: DB+JS 14-21 ms (consolidator-hour rows, queryVec supplied); Gemini embed ~220 ms of 244.
- max_tokens is dropped on the claude-sdk infer path (adapter.ts inferViaClaudeSdk).

**Why:** operator wants JME "as strong and efficient as it could be", keep/cut is closed.
**How to apply:** on the fix round, verify tiebreak, header strip, exact-cosine dedup scan, redaction and role-escaping each with a mutation-RED test.
