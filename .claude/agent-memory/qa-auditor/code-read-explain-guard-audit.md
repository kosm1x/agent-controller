---
name: code-read-explain-guard-audit
description: classifier.ts isCodeReadOrExplainTask read/explain-vs-author guard audit (2026-06-26) — FAIL, false-positives strip nanoclaw from real Spanish authoring
metadata:
  type: project
---

# isCodeReadOrExplainTask read-guard audit (2026-06-26)

Fix: `código`/`codebase` extracted to `CODE_NOUN_STRONG`; new `isCodeReadOrExplainTask` = (CODE_READ_INTENT OR TRANSLATE_TO_HUMAN) AND (CODE_CONTEXT OR FILENAME) AND NOT authoring; added as `!isCodeReadOrExplainTask` to BOTH nanoclaw gates (coding ~L409, score-path ~L542). Root bug: bare `código` noun is verb-blind → read/extract of external site (wilab.io) routed coding→nanoclaw→0 output.

VERDICT: FAIL. Original Spanish bug FIXED + ReDoS clear (0.22ms/50k, single `[^.]*` = O(n^2) not exponential) + reference-identity exclusion (`p !== CODE_NOUN_STRONG`) sound + foreign-repo fallthrough intact (guard only ANDs a NOT, can only REMOVE from nanoclaw).

CRITICAL — the guard's authoring-exclusion (L316-319) is NOT exhaustive, so read+author COMPOUND messages strip the sandbox and route authoring→fast (reintroduces task-6511 under-provisioned-coding bug). Verified e2e all → `fast`:
- Accent/clitic gap: `\b` is ASCII-only → CODING_VERB `arregla|corrige|edita|optimiza|modifica` FAIL on accented clitic imperatives `arréglalo/corrígelo/edítalo/optimízalo`. "muéstrame el código y arréglalo" → fast.
- Verb-list gap: CODING_VERB (L206) lacks `mejora/improve`, `simplifica/simplify`, `convierte/convert`. "explica el código y simplifícalo" → fast.
- Translate escape-hatch: TRANSLATE_TO_HUMAN (L288) `|lo\s+que|what)` bypasses the human-language-target gate → porting masked. "traduce el código a Python según lo que necesitamos" → fast.
All require a read-verb to co-occur (mono "arréglalo el código" → nanoclaw correctly). Test suite (71 pass) only probes NON-clitic single-intent forms → false confidence.

WARNING — `code` is in BOTH CODE_CONTEXT (L291) and CODING_VERB (L206 `\bcode\b`) → English read tasks self-trigger authoring=true → never classified read. "explain the code in app.js" (external) → stays nanoclaw → original bug in English. Asymmetric vs Spanish (`código` ∉ CODING_VERB).

DOCTRINE: a read-vs-author guard whose author-exclusion is a hand-maintained verb regex inherits every gap in that list AND every JS-`\b`-vs-accent miss (Spanish clitic imperatives are the killer). Durable fix is to narrow the guard to the ACTUAL failure trigger — an unreachable/external target (URL, "lo que se visualiza", non-mc path) — since nanoclaw can already READ mc's own code; the read-guard only needs to fire when the target is outside the sandbox.

## R2 — re-architected to `referencesExternalWebTarget` (2026-06-26)
Read-guard DELETED; replaced by out-of-sandbox-TARGET guard: EXTERNAL_WEB_SIGNAL (url/domain/rendered-content phrasing) AND not-local (no FILENAME/FOREIGN unless inside http url) AND not-authoring (STRONG∖CODE_NOUN_STRONG OR CODING_VERB on CODE_NOUN_BARE-stripped text OR MSG_SHIP). Added to both nanoclaw gates. 72/72 pass. VERDICT: PASS WITH WARNINGS — big improvement (C1 mono-cases RESOLVED: "muéstrame el código y arréglalo"→nanoclaw; #5 incidental-URL authoring stays sandboxed; ReDoS clear 0.24ms/100k single `\S+`/`[^.]*`; CODE_NOUN_BARE strip + identity exclusion sound; domain alternation rejects node.js/package.json/v8.2/U.S.).
TWO residual Warnings (both verified e2e→fast):
- W-RESURFACE: the SAME C1 clitic/verb-gap class returns whenever an EXTERNAL_WEB_SIGNAL token co-occurs with a missed authoring verb. "muéstrame el código de la página de checkout y arréglalo"/"...la demo y optimízalo"/"mejora el código del sitio"→fast. Phrases "de la página/del sitio/la demo/en pantalla" are AMBIGUOUS local-vs-external. Blast radius shrank a lot (only fires behind an external phrase; many site/página cases route correctly to host since the operator's UI work lives in SIBLING repos anyway), so Warning not Critical. Durable fix is STILL to close the authoring-verb gaps (add mejora/simplifica/convierte + accent-clitic tolerance) so a real verb rescues local work regardless of phrase.
- W-BAREDOMAIN-PATH: hasUrl rescue-bypass only checks `https?://`, but EXTERNAL also matches bare `domain.tld`/`www.`. A bare-domain URL with a code-ext path ("extrae el código de example.com/app.js") trips FILENAME_PATTERN → local-rescue → stays nanoclaw → original 0-output bug for that sub-case. `https://example.com/app.js` works (http gate). Fix: broaden hasUrl to include the bare-domain/www branch.
DOCTRINE-R2: re-keying a guard from intent→target shrinks a false-positive class but does NOT eliminate it when the new key (external phrase) is itself ambiguous and the OLD weak link (verb-list/accent gaps in the authoring rescue) is reused verbatim. The authoring-verb gap is the load-bearing weakness across BOTH architectures — fix it at the source.
