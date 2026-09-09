---
name: x-poster-backend-router-audit
description: Native X/Twitter posting backend-router + health probe audit (2026-06-23) — replaces /tmp/*.cjs Playwright anti-pattern. BLOCKER tools unreachable from scope.
metadata:
  type: project
---

# X-poster backend-router audit (2026-06-23) — FAIL

Change set: src/lib/x-poster/{types,config,cookie-backend,api-backend,router,index,probe-cron}.ts + src/tools/builtin/x-post.ts + prometheus.ts (mc_x_backend_healthy gauge) + sources/builtin.ts (registration) + index.ts (cron behind X_PROBE_ENABLED). Replaces memory `x-posting-brittle-path`.

**Why:** centralize cookie/queryId/bearer brittleness behind one router (cookie primary → api fallback) + proactive daily probe so cookie expiry detected BEFORE mid-thread post 401.

## BLOCKER — tools registered but UNREACHABLE from chat (same class as gdocs_read_full FAIL, v6.3 deferral FAIL)
`tweet_post`/`tweet_probe` are `deferred:true` and in `BUILTIN_TOOLS` (pass registry invariant tests) BUT in NO scope array: not CORE_TOOLS, not MISC_TOOLS, not SOCIAL_TOOLS, not any group, not `getAllAvailableTools()` (the meta/inventory union). Chat path (router.ts:1865 `scopeToolsForMessage`) → fast-runner `input.tools` only ever contains scope-array members. `getDeferredCatalog(input.tools)` filters to that list → tweet tools never enter the catalog → LLM never sees them. triggerPhrases (`"postea en X"`,`"tweet this"`) only annotate ALREADY-in-scope deferred tools (registry.ts:153) — they do NOT drive scope activation. Circular dead-end. The `social` regex (scope.ts:781) matches redes/instagram/facebook/tiktok/youtube + "publish to/on" but NOT tweet/twitter/X. Mechanism proof: every reachable deferred tool IS a scope-array member (google_workspace_cli∈GOOGLE_TOOLS, project_get∈MISC_TOOLS). FIX: add both to SOCIAL_TOOLS AND extend social regex with `tweet|tuit|twitter|\ben\s+x\b`. The 16 scoped unit tests are green but NONE assert scope-reachability — the exact blind spot.

DOCTRINE (reinforced 4th time): a new deferred tool needs TWO wirings — (1) registration in BUILTIN_TOOLS [done], (2) membership in a scope-group array in messaging/scope.ts + a regex that activates that group [MISSED]. registry.test.ts invariants only check (1). Always grep `scope.ts` for the new tool name; absent = unreachable from chat regardless of green tests.

## Verified CORRECT (no issue)
- Secrets: authToken/ct0/apiBearer NEVER logged/returned. Error paths use fixed strings on 401/403; raw.slice(0,240) only on non-200 (X returns JSON error objects, not your cookies). registry.execute() logs args for high-risk tools but tweet args = text only, cookies never in args.
- router allAuthExpired: `.every()` vacuous-true on [] is unreachable (active.length===0 early-returns false). Mixed non-auth failure → false (test:76). Correct.
- probe-cron edge-trigger: record() every tick, notify only on transition, first-sight (prev===undefined) skips, never-throws-on-notify-reject (test:84). defaultNotify throws only if router unavailable; tick catches. Sound.
- CookieBackend HTTP shape plausible: context.addCookies on both .x.com/.twitter.com, context.request shares context cookies (correct PW pattern), CreateTweet GraphQL POST + verify_credentials GET shapes match X web-client. 401/403→authExpired, non-200→error, 200-no-id→error. Browser-launch-per-call is INTENTIONAL (TLS fingerprint, file header) not a bug.
- ApiBackend: stub, isConfigured()===false until X_API_BEARER → router skips, cookie-only behavior preserved. 201|200 both accepted (v2 returns 201). fetch+AbortSignal.timeout precedented (Node 22).
- Dormancy: cron registers only on X_PROBE_ENABLED==="true" (index.ts:369), systemd-drop-in pattern matches V8.2 producer / triage. Tools work regardless (correct — only the bg probe is gated).
- Annotations: tweet_post {readOnly:false,destructive:true,idempotent:false,openWorld:true,requiresConfirmation,riskTier:high} — all 4 invariants hold. tweet_probe {readOnly:true,destructive:false,idempotent:true,openWorld:true} — holds. Both deferred. Compliant.
- typecheck clean, no console.log/secret logging in lib, additive prometheus gauge only.

## Should-fix / nits
- isXProbeEnabled() (config.ts:63) exported + JSDoc'd "(see config.isXProbeEnabled)" but index.ts:369 INLINES `process.env.X_PROBE_ENABLED === "true"` → dead export / DRY drift (same I1 pattern as self-healing-triage). Use the helper.
- Gauge staleness nit: record() only fires for CONFIGURED backends (router probes configured-only). cookie config→unconfig leaves mc_x_backend_healthy{backend=cookie} stale at last value (prom gauges don't expire). Real expiry keeps cookie configured (401) so gauge flips correctly — minor.
- defaultNotify resolves OK even when sendBriefingToOwner returns {sent:0,failed:>0} (swallows per-channel send errors) → notification silently lost but gauge already written, alert still fires. Minor.
