---
name: x-poster-fuzzy-account-audit
description: X/Twitter account fuzzy-match + getXRouter null-guard bug-fix audit (2026-06-23) — PASS WITH WARNINGS
metadata:
  type: project
---

# x-poster fuzzy-account resolution bug-fix audit (2026-06-23)

VERDICT: PASS WITH WARNINGS. Fixes RC1 (handle mangling `iooking4ward`→`lookin4ward`) + RC2 (model reaching for shell_exec/cookies instead of native tweet_post/tweet_probe).

## Files
- `src/lib/x-poster/config.ts` — `fuzzyMatchAccount()` (Levenshtein ≤2, len-guard ≥5 + |Δlen|≤2, UNIQUE-match) + `levenshtein()` helper; `resolveAccount()` exact→fuzzy→input-unchanged.
- `src/lib/x-poster/index.ts:30` — `getXRouter()` null when `!getAccountCreds(handle)`.
- `src/tools/builtin/x-post.ts:49` — `accountsHint()` injects live `listXAccounts()` into tool descriptions at MODULE LOAD.
- `src/lib/x-poster/cookie-backend.ts` — stale-comment fix (probe hits badge_count not v1.1).

## Verified TRUE (empirical)
- Levenshtein math: iooking4ward↔looking4ward=1, ↔lookin4ward=2, mexiconecesario↔mexiconecesari=1, the 2 real accounts are dist=12 apart. kitten↔sitting=3, flaw↔lawn=2 (textbook). The `[prev,curr]=[curr,prev]` buffer swap does NOT corrupt rows — `curr` fully overwritten each outer iter (curr[0]=i + all curr[j]).
- Fuzzy SAFETY: the 2 real accounts are dist 12 apart → can NEVER cross-bind. Unique-guard (`near.length===1`) correct: 0 or >1 → undefined → input unchanged → noAccountError fires.
- `accountsHint()` module-load timing is SAFE in THIS codebase: process gets X_ vars via systemd `EnvironmentFile=/root/claude/mission-control/.env` BEFORE `node dist/index.js` runs. NO runtime dotenv.config() exists (grep dotenv = 0 hits). So module-load env read = fully populated. Code comment claim is correct.
- getXRouter null-guard: only 2 callers (x-post.ts:140,247), both already handle null. probeAllAccounts BYPASSES getXRouter (builds XPostRouter from listXAccounts directly) → guard doesn't touch probe-all. No regression.
- config.test.ts env isolation: afterEach deletes ALL X_ keys then restores from module-load `saved` snapshot → test-seeded keys correctly cleared. New describe block safe.
- 39/39 scoped tests green. typecheck clean for these files.

## WARNINGS / INFO
- INFO (pre-existing, NOT worsened): api-only account (only `X_API_BEARER__h`, no auth_token) → getXRouter returns valid router (getAccountCreds non-null on apiBearer) BUT noAccountError + fuzzy + accountsHint all use listXAccounts() which EXCLUDES api-only handles. Asymmetry predates this change; api-only posting still works via ApiBackend.
- Fuzzy len-guard is |Δlen|≤2 AND edit≤2 AND len≥5 — tight. Worst theoretical risk: a future 3rd account within edit-2 of a real one would make BOTH ambiguous → undefined (safe-by-design, fails to noAccountError not wrong-bind).

## ACI quality (strong)
Tool descriptions now: inject live account list, "use EXACT labels do not re-spell" (RC1), "ONLY X path — never shell_exec/Playwright/user_facts" (RC2). account param description points to CONFIGURED ACCOUNTS list. Good poka-yoke.
