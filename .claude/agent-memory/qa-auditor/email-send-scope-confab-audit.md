# email-send scope + escape-hatch anti-confabulation audit (2026-06-17)

Files: src/messaging/scope.ts (EMAIL_SEND_RE + DEFAULT_SCOPE_PATTERNS entry + semantic-path injection), scope.test.ts (2 it), prompt-sections.ts (REGLA CRÍTICA tail rewrite), prompt-sections.test.ts (1 it).

Verdict: PASS WITH WARNINGS. Fix is correct and well-targeted; one real false-negative class.

## Verified TRUE (empirical)
- EMAIL_SEND_RE matches all 3 proven failing cases; correctly rejects bare address (no send verb) + "sendero" (\b-anchors English `send`). No ReDoS (25-31ms @ 100k; {0,80} bound + simple tail = linear).
- Dual-path wiring correct: injection IS inside `if (preClassifiedGroups !== undefined)` branch (scope.ts:1125); DEFAULT_SCOPE_PATTERNS entry (scope.ts:666) IS scanned by regex-fallback `else` branch (scope.ts:1252 loops `patterns`). Both new tests FAIL against neutered code (real guards). Prompt test FAILS against old text (real guard).
- Escape-hatch claim "naming usa shell_exec reactivates scope" is mechanically TRUE: codingNounRe matches shell_exec on BOTH paths (semantic coding safety-net at 1166 runs unconditionally inside preClassified branch; regex-fallback scans it). Verified end-to-end via tsx.
- No contradiction with confirmationSection (prompt-sections.ts:259 already says "confirmación NO es bloqueo"); the new text reinforces it. Removed dead-end sentence broke no other test.
- gilda decision DEFENSIBLE: "Suspende todo de gilda-outreach" has zero safe coding signal (no DB noun, no run-verb+script). Broadening to suspende/apaga/detén would over-grant shell_exec on "suspende la reunión" etc. Aligns with scope.ts:1047 NOTE against broad imperative fallbacks. Escape-hatch is the right route.

## WARNING (real FN class)
- `mand[aá]` arm MISSES all enclitic imperatives: mándalo/mándale/mándaselo/mándamelo + voseo mandá. Reason: `mánd...` puts accent on FIRST `a` (`má`), so literal `mand` fails at char 2. enviar is fully covered (`env[ií]a` absorbs accent) → asymmetric. `mándalo a x@y.com` is arguably MORE common than bare `manda`. Fix: `m[aá]nd[aá]` or `m[aá]nd\w*`.

## INFO
- Additive over-grant FPs exist (send verb + incidental address within 80 chars: "escribe en la base de datos que el contacto es ana@x.com" pulls google). Low severity — purely additive scope; LLM still decides to call gmail_send. Same tradeoff as existing google noun regex (matches bare "agenda"/"drive").
