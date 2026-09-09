---
name: x-poster-multiaccount-audit
description: Multi-account X-poster extension + scope-regex fix + cron-autonomous rewire (2026-06-23)
metadata:
  type: project
---

# X-poster multi-account audit (2026-06-23) — PASS WITH WARNINGS

Follow-up to [[x-poster-backend-router-audit]] (the 2026-06-23 FAIL: tweet tools registered but unreachable). This change set FIXES that reachability gap and adds multi-account.

## Verified correct
- **Scope reachability NOW FIXED**: social regex (scope.ts:783) has X-session arm `(sesión|cuenta|acceso|credencial|cookies|login|token)\s+(\S+\s+){0,4}(de|en|a|para|to|of|del)\s+(x|twitter)\b` + `tweet_post|tweet_probe` literal names. SOCIAL_TOOLS has both tools, group "social" pushes them, getAllAvailableTools includes them. Full dual-wiring (registration + scope-array + activating regex). scope.test.ts:78 asserts the EXACT prod-failed phrasings. 20/20 adversarial regex cases pass.
- **#4 cron-autonomous (load-bearing) CONFIRMED**: tweet_post (requiresConfirmation:true) does NOT deadlock from cron. Chain: registry.execute() only AUDITS, never blocks (registry.ts:192 single-responsibility); task-executor.ts:93 gates on `context.interactive && riskTier==="high"`; fast-runner.ts:1074 sets interactive from `input.interactive!==false`; BOTH schedule firing paths set `interactive:false` (dynamic.ts:235 executeScheduleNow + :332 checkAndExecuteSchedules). So scheduled tweet_post bypasses confirmation. The schedule itself = prior authorization.
- **#1 account resolution**: bare X_AUTH_TOKEN/X_CT0 does NOT leak to non-default (getAccountCreds bare branch requires getDefaultAccount()===h). 2 accts + no default + tweet_post no `account` → resolveAccount undefined → getXRouter null → clear noAccountError listing configured accts (NOT a wrong-account post). All 5 scenarios verified by hand-replicated logic.
- **#2 secrets**: authToken/ct0/apiBearer appear only in HTTP headers + Playwright cookie payload, NEVER logged or returned. Probe notification references env-var NAMES not values.
- **#5 annotations**: tweet_post (high/destructive/!readOnly/requiresConfirmation) + tweet_probe (readOnly/!destructive/idempotent) pass all registry.test invariants. 46/46 green.
- isXProbeEnabled() NOT dead — wired at index.ts:370 gating dormant probe-cron (mirrors self-healing triage pattern).
- typecheck clean; config 11 / router 9 / probe-cron 8 / scope 340 all green.

## Warnings filed
- **W1 (should-fix) bare-var-only invisible**: config.ts head comment promises "bare pair = default account for migration ease" BUT a bare pair with NO X_DEFAULT_ACCOUNT is COMPLETELY invisible — listXAccounts()=[] (line 72 bare branch needs `def` truthy), anyXAccountConfigured()=false, tweet_post says "not configured". Same silent-not-working class as the prod incident. Fails closed (safe) but the migrating operator gets no hint they need X_DEFAULT_ACCOUNT. Test never covers bare-alone.
- **W2 (nit) social regex x-as-variable FP**: X-session arm fires on ES algebraic-variable idiom: "cuenta de ahorro para x meses", "acceso de x usuarios", "sesión de x horas", "la cuenta de x cliente", "cuenta de x pesos" all FIRE social. Harmless (over-activation only loads deferred tools, no misroute/destructive) but a real systematic class. Fix = anchor `x` to clause-end/punct or `@handle`.
- **nit** account param free `type:"string"` (x-post.ts:85) not enum — defensible (handles env-derived, not static-literal-expressible; handler noAccountError enforces at boundary).

## Doctrine reinforced
- Deferred-tool reachability needs THREE things: registry membership + scope-array membership + activating regex. This audit is the FIX-side proof of the [[x-poster-backend-router-audit]] FAIL-side.
- "requiresConfirmation deadlocks cron" is a FALSE worry IFF the scheduled-task submit path sets interactive:false AND registry.execute() doesn't independently gate. Always trace BOTH: (1) where confirmation is checked (task-executor, not registry), (2) whether the producer path sets interactive:false.
