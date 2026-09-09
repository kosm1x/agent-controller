---
name: hermes-ssrf-standing-orders-r1-audit
description: R1 audit (2026-09-01) of the two Hermes cherry-picks — connect-time SSRF safeFetch + directives/ standing-orders guard. FAIL, 3 Critical.
metadata:
  type: project
---

# Hermes upstream R1 — connect-time SSRF guard + standing-orders guard (2026-09-01)

Verdict: **FAIL**, 3 Critical. Bundle: `src/lib/url-safety.ts` (safeFetch/makeSafeLookup/safeDispatcher, 6 call sites swapped) + `src/tools/builtin/immutable-core.ts` `standingOrdersGuard` wired into 6 jarvis-files handlers.

## Lessons (reusable)

1. **A helper assigned to an existing interface must satisfy that interface's OPTIONAL fields.** `citations.ts:63` declares `headers?: { get() }`; `url-safety.ts` safeFetch does `res.headers.get("location")` with no optional chain. Result: `consumer.test.ts:394` RED, and the throw is swallowed by `catch { verdict = "unreachable" }` (citations.ts:401) + cached 24h — a fabrication gate that fails OPEN and silent. Grep the target interface for `?:` before assigning a new impl.
2. **A prefix guard that strips only LEADING `./` and `/` is not a path guard.** `knowledge/../directives/core.md` passes `standingOrdersGuard`, and `mirrorToDisk`'s `join()` (jarvis-fs.ts:118) COLLAPSES it onto the live `/root/claude/jarvis-kb/directives/core.md`. The DB layer never normalizes; the mirror does — the normalizer downstream of an un-normalized guard IS the bypass. Also `Directives/` (case) and leading space.
3. **One-door guards**: `file_write`/`file_edit`/`shell_exec` all allow `/root/claude/jarvis-kb/` (file.ts:34-43, code-editing.ts:23), and `jarvis-reindex.ts:108-124` imports NEW disk files as real rows hourly (`MANAGED_NAMESPACES = ["NorthStar/"]` excludes only NorthStar). Guarding one tool family leaves 3 siblings + an importer.
4. **Injection is keyed by `qualifier`, not by path** (`getFilesByQualifier`, jarvis-fs.ts:219). `enforce` is downgraded for the model (jarvis-files.ts:332) but **`always-read` is not**, and it is budget-EXEMPT (kb-injection.ts:165-167). Protecting `directives/` does not stop a model from installing an every-task standing order.

## Verified clean (don't re-litigate in R2)

- Callback shapes work end-to-end: undici `Agent` + Node global `fetch` honour the npm-undici dispatcher (live 404 from :8080); `tls.connect` honours `lookup`; error arity fine; mixed public/private keeps only public (net can only pick from what we hand back); no global side effect.
- WHATWG `new URL()` normalizes `2130706433` / `0x7f000001` / `0177.0.0.1` / `127.1` / `①②⑦.0.0.1` → `127.0.0.1`; `[::ffff:127.0.0.1]` → `[::ffff:7f00:1]` caught by the hex-mapped regex; userinfo trick resolves to the real host; IPv6 zone-id fails to parse. No literal bypass found.
- Guard sits BEFORE the precious/`confirmed` flow — the router's auto-injected `confirmed:true` cannot unlock a directive delete. Tests pin `mockRun` not called.
- `::7f00:1` (IPv4-compatible) unblocked by `isBlockedAddress` but ENETUNREACH on this box.

## Technique

`node_modules/.bin/tsx` on a scratch `.mts` importing `src/*.ts` by ABSOLUTE path — imports of bare `undici` must be rewritten to the absolute `node_modules/undici/index.js` (scratchpad is outside the package root). Pin a fake resolver into `new Agent({connect:{lookup: makeSafeLookup(fake)}})` and point it at the box's own public IP:8080 to prove the safe path really connects.
