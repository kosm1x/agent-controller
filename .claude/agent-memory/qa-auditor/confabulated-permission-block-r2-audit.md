# router.ts POISONED_RESPONSE_PATTERNS — 06-17 anchoring FP fix (R2 audit)

Date: 2026-06-17. Files: src/messaging/router.ts (~775-819), router.test.ts (~852-895).
Verdict: PASS WITH WARNINGS. 55/55 tests green. All 5 new tests are sound; 3 are
REAL regression guards (old code disagreed), 2 are forward guards (old==new).

## What changed
- `/problema t[eé]cnico (cr[ií]tico|grave)/i` and `/error de configuraci[oó]n/i`
  → sentence-anchored `/(?:^|[\n.!?]\s*)…/im`.
- bare `/\bdon.?t[\s-]?ask\b/i` → `/(?:modo\s*['"]?\s*don.?t[\s-]?ask|don.?t[\s-]?ask[\s'"-]*mode)/i`.

## Key finding (Warning, accepted-by-design but under-documented)
Anchoring to sentence-start converts the patterns from "match anywhere" to
"match only at clause start". A GENUINE single-sentence self-error that opens
with narrative ("Hubo un error de configuración...", "Tuve un problema técnico
grave al generar la imagen.") is now a TRUE false negative — caught by NO
pattern in the full 31-pattern set (verified by eval-ing the real array, not a
transcription). The OLD code caught all of these. This is a real FN-regression
class, NOT just contrived mid-sentence cases. Acceptable because over-stripping
real answers (the reported incident) is worse than leaving a self-excuse in
buffer, but the code comment claims siblings still catch confabulations — that
is true ONLY for the don't-ask pattern (bloqueado/no-tengo-acceso siblings),
NOT for the two self-error patterns, which have no safety net.

## Doctrine: anchoring a "match-anywhere" poison pattern to sentence-start
trades FP for FN. The FN is invisible at test time unless you write the
"genuine self-error that happens to start mid-narrative" case. ALWAYS eval the
real pattern array from source (readFileSync + eval the literal) rather than
re-typing patterns — re-typing risks a stale/wrong copy of the 31-element set.

## Minor: diff adds 5 tests, prompts/PR often miscount as 6. No ReDoS (all
alternation bounded, [\s'"-]* over a small class, <1ms on 50k adversarial).
dontAskMode fires standalone on both pre-existing positives (not just via
bloqueado sibling). Multi-line anchoring correct: poison at start of line 2
matches via `\n` branch with `m` flag.
