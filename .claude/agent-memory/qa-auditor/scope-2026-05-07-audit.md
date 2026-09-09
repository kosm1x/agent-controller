---
name: scope-2026-05-07-audit
description: 2026-05-07 scope.ts audit — algebra-progress incident fix introduces FP risk on legit project-status phrasing
type: project
---

## scope.ts ES learning vocab fix audit (2026-05-07)

**Why:** Two surgical regex extensions to recover from chant-loop incident: (1) codingNounRe added `jarvis_file_*` literal arm without `\b` (correct — `_` traps boundaries); (2) DEFAULT_SCOPE_PATTERNS jarvis_write group added `progreso|aprendizaje|lecci[oó]n(?:es)?|patr[oó]n(?:es)?` to file-ish noun list.

**How to apply:** When tightening jarvis_write nouns, beware these high-FP cases that now fire write tools (incl. `jarvis_file_delete`):
- "actualiza el progreso del proyecto Atlas" — also fires `projects` group; user intent is project_update
- "registra/anota el progreso del sprint" — sprint-progress narratives common in CRM
- "crea un reporte de progreso para el cliente" — generic content creation
- "registra el aprendizaje del equipo" — retrospective narratives

The `(?:\s+\S+){0,2}` slop after determiners means **any** of those write verbs paired with these ES nouns now fires regardless of "mi/my" possessive context. The existing `lesson|pattern` EN nouns had narrower contexts.

**Tightening recipe (deferred — post-hardening):** require possessive "mi" or "del usuario" specifically for the learning-vocab arm; or constrain to first-person message context (no "del proyecto/sprint/cliente"). Alternative: split arm so progreso/aprendizaje/lecci[oó]n only fire when paired with "mi" or as direct object without "del X" PP.

**Adjacent incident-family gaps:** these natural phrasings still miss the safety net:
- `apunta mi progreso de Algebra` — `apunta` only in KB-specific second arm
- `guárdame mi progreso` — clitic-attached imperatives
- `documenta mi progreso` — `documenta` not in verb list
- `registra mi avance en Algebra` — `avance` synonym not added
- EN: `save my progress in Algebra`

**codingNounRe substring check:** `jarvis_file_write` substring-match is safe in practice (no realistic Spanish chatter contains the literal token), but technically would fire on filenames containing the tool name. Cost trivial vs FN risk so judged acceptable.
