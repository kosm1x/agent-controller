---
name: three-fix-incident-audit-20260620
description: Audit of 3 surgical 2026-06-20 incident fixes (classifier repo-word removal, shell .env guard, overnight-tuning direct-broadcast) — PASS WITH WARNINGS
metadata:
  type: project
---

# Three surgical incident fixes (2026-06-20) — PASS WITH WARNINGS

Scope: classifier.ts, shell.ts, overnight-tuning.ts + 3 test files. Uncommitted on `main`. 158/158 scoped tests green, tsc clean.

## Fix 1 — classifier.ts: removed lone `repo|repositor\w*` from STRONG_CODING_PATTERNS (kept codebase|c[oó]digo)
Incident: bare "repo" forced "guarda esto en el repo" (KB save, task 6548) to nanoclaw → 0 tool calls, nothing saved.
- Fix CORRECT for incident: `guarda`/`save` not in CODING_VERB → no longer coding.
- **W1 RESIDUAL (verified empirically):** `add`/`agrega`+`repo` STILL fires verb×noun → nanoclaw. `isCodingTask("add this note to the repo")`=true, `isCodingTask("agrega esto al repo")`=true. KB-save class survives for verb-paired phrasings, UNSAFE direction (sandbox has no KB tools). Narrower than before but same bug class. Queue: a `guarda|save|anota|registra ... repo` KB-intent pre-empt.
- W2: `código`/`codebase` is a STRONG solo signal → "explica el código"/"analiza el código" route to coding sandbox (read/explain ≠ authoring). Pre-existing, benign direction (over-provision).

## Fix 2 — shell.ts:145-147: DENY_PATTERN blocking reader-cmd + literal /root/claude/mission-control/.env
Incident: agent grepped mc .env to lift Telegram bot token, raw send.
- Two order-independent lookaheads (`(?=[\s\S]*\breader\b)(?=[\s\S]*\.env...)`) — deliberately NOT adjacent `[^|;&]*` because grep arg `"A\|B"` has a `|` that truncates an adjacent span. VERIFIED: incident `grep -n "TELEGRAM_BOT_TOKEN\|..." .env` fires correctly.
- DENUE project .env READ PRESERVED (`grep '^API_KEY=' /root/claude/projects/.../denue-data-analysis/.env`) — fast-runner.ts ~line 954 instructs it; would break authenticated DENUE if blocked. Verified passes.
- `.env.local`/`.env.backup` blocked; `.environment` correctly NOT blocked (`\b` after `.env`, `_`/word-char fails).
- **W3 BYPASSES (verified, ACCEPTED — same as sibling guards):** enumerated-reader filter misses `cut`/`tr <`/`xargs <`/`while read</`paste`/`fold`/`column`/`pr`/`mapfile`/`cmp`; path obfuscation `/./`,`//`,`..`,`~`,`$HOME`; relative `cd mc && cat .env`; `vim`; `python open()`. Identical limitation to `.credentials.json`/`.ssh` guards (same `\b(cat|...)\b[^|;&]*<path>` shape). Defense-in-depth vs realistic vector, NOT airtight. Prompt pre-acknowledged relative-path limit.
- W4: `.env-prod` over-blocks (`-` non-word → `\b` matches) — safe direction, no such file.

## Fix 3 — overnight-tuning.ts: submitTask("deliver via Telegram",fast) → direct getRouter().broadcastToAll
Incident: LLM delivery agent w/o telegram_send tool reverse-engineered mc, lifted bot token, shelled raw send (17 turns ~$1).
- CORRECT: mirrors diff-digest.ts exactly. getRouter() null-guarded (no throw). submitTask import removed, only comment refs remain, tsc clean. broadcastToAll(text) single-arg correct, swallows per-channel failures internally + outer try/catch wraps.
- Rec: test only asserts no-win summary + router-null + empty-report; `experiments_won>0` "Found N improvements" branch + `?.toFixed(1)` UNTESTED. `?.toFixed(1)` on null score → literal "undefined" (unreachable: truthy report implies baseline).

## Doctrine
- A "strong noun" coding signal (repo/código/codebase) mis-fires on non-authoring intents (KB-save, explain) sharing that noun. Removing one noun (repo) from the STRONG list narrows but doesn't close it — verb×noun still pairs the noun with an overlapping verb (add/agrega). Test the verb-paired paraphrase, not just the incident phrasing.
- Enumerated-reader + literal-path credential guards: ALWAYS enumerate the bypass set at report time (reader synonyms, path obfuscation, relative path, editors, runtime open()). Accept as defense-in-depth ONLY when sibling guards share the limitation; never call airtight. Same memory class as [[evolution-log-append-gate-audit]] (indicator-keyed gate inherits every gap in its keying regex).
