---
name: hermes-ssrf-standing-orders-r2-audit
description: R2 audit (2026-09-01) of the Hermes cherry-picks — R1 folds verified. FAIL, 2 new Criticals. canonicalKbPath still bypassable via ../<kbdir>/directives/; file_delete + shell_exec are ungated disk doors.
metadata:
  type: project
---

# Hermes upstream R2 — R1 folds verified (2026-09-01)

Verdict: **FAIL**, 2 new Critical. C1/W1/W4/W6-W9 folds all verified GREEN (385 tests across 14 suites). C2 and C3 are both INCOMPLETE.

## Lessons (reusable)

1. **A `..`-stripping guard must normalize against a VIRTUAL ROOT, not just strip leading `./` and `/`.** `canonicalKbPath` (immutable-core.ts:405) uses `posix.normalize(...).replace(/^(?:\.\/|\/)+/,"")`, which PRESERVES leading `../`. R1 tested `knowledge/../directives/x` (blocked, correct) and `../directives/x` (allowed, and mirrorToDisk refuses it — looked safe). The live bypass is the spelling that walks OUT and BACK IN: `../jarvis-kb/directives/core.md` → canon keeps the `../`, guard allows, `join(mirrorDir, p)` collapses to `/root/claude/jarvis-kb/directives/core.md`. **When fuzzing a path guard, always include the round-trip spelling `../<basename-of-root>/<protected>`** — testing `../<protected>` alone gives a false PASS. Fix: `posix.normalize("/" + p).slice(1)`.
2. **Counting doors: enumerate by WRITE PRIMITIVE, not by tool family.** The C3 fix wired `isStandingOrdersDiskPath` into `file.ts isWriteAllowed` + `code-editing.ts` and declared the sibling doors closed. But `file_delete` (file.ts:441-509) runs its OWN gate chain and never calls `isWriteAllowed`; and `shell.ts` getAllowWritePrefixes():340 lists `` `${getJarvisKbRoot()}/` `` FIRST with `DENY_WRITE_PATTERNS` covering mission-control only — `shell_exec("echo x > .../directives/core.md")` is explicitly ALLOWED. Two of four+ doors.
3. **An allow-list whose depth rule is keyed to ONE prefix leaks for every other prefix.** file.ts:485 `matchedPrefix === "/root/claude/" && depth < 2` — because `${kbRoot}/` matches FIRST, `file_delete("/root/claude/jarvis-kb/directives")` skips the depth rule and `rmSync(recursive:true)` takes the whole tree.
4. **realResolve vs resolve asymmetry across twin call sites.** file.ts:90 uses `realResolve` (symlinks dereferenced); code-editing.ts:132 uses bare `resolve(path)` and then writes `writeFileSync(path, ...)` on the RAW path (:211). Same guard, one site symlink-proof, the other not. `validatePathSafety(p,"write")` deliberately skips realpath for write mode (immutable-core.ts:247-255) — it is not a substitute.
5. **Prefix containment needs the trailing slash.** `mirrorToDisk` (jarvis-fs.ts:118) `fullPath.startsWith(mirrorDir)` with no `/` — `../jarvis-kb-evil/x.md` passes. Its sibling `syncDeleteFromKbMirror` (jarvis-fs.ts:101) gets it right (`mirrorAbs + "/"`). Pre-existing.

## Verified clean (don't re-litigate in R3)

- **C1 fold**: `res.headers?.get("location") ?? null` — citations `FetchLike` declares `headers?:` (citations.ts:63) and passes `redirect:"manual"` (citations.ts:315), so its own DOI-302 hop loop is preserved. consumer.test.ts + citations.test.ts + url-safety.test.ts all GREEN.
- **W4**: hex-mapped v4 arithmetic correct — 25/25 address cases pass (`::ffff:7f00:1`, `::ffff:a00:1`, uppercase, dotted). Public IPv6 (`2606:`, `2a00:`) correctly unblocked. Still-unblocked (accepted, no local listener): NAT64 `64:ff9b::`, 6to4 `2002:`, `::ffff:0:7f00:1`, CGNAT `100.64/10`, `198.18/15`, multicast.
- **W6**: `new Headers()` handles plain object / `[k,v][]` / `Headers` instance / undefined. No caller reads `.redirected` or `response.url` (grep clean). No safeFetch caller passes a stream body, so the 307/308 replay concern is theoretical.
- **Reindex fold**: `MANAGED_NAMESPACES += "directives/"` pinned positively AND negatively (jarvis-reindex.test.ts). `fsCount` steps down but the only alert is `mc_kb_reindex_drift > 10` (monitoring/alerts.yml:139) — no false alarm. Seeding (jarvis-fs.ts:554/586) calls `upsertFile` directly, unaffected. No inbound Drive→disk sync exists.
- **DECLINE side**: `jarvis-directives.ts` uses `upsertFile`/`deleteFile` from jarvis-fs directly, bypassing the guarded tool handlers — the sanctioned proposal path still works. All 6 mutating `jarvis_file*` tools guarded, pinned with `mockRun not called`.
- `npm ls undici` → `7.29.0 deduped` under `@alibaba-group/opensandbox`. One copy.

## Unfixed from R1

R1 lesson 4 (`always-read` qualifier) is untouched: jarvis-files.ts:288 enum still contains `"always-read",`; only `enforce` is downgraded (:333, :455); kb-injection.ts:164-167 exempts `always-read` from `KB_CHAR_BUDGET`. Protecting the `directives/` PATH does not close the QUALIFIER door.

## Pre-existing SSRF gaps found by the W1 re-sweep (7 files use safeFetch; 8 hits do not)

`huggingface.ts:110` (SSE-payload URL + `Authorization: Bearer ${token}`) · `a2a/client.ts:39,125` (URL from a task-input DB row + bearer + X-Api-Key) · `gemini-research.ts:386` (name-only `.endsWith(".googleapis.com")` on an `x-goog-upload-url` header, then raw fetch with `redirect:"follow"` — same file already uses safeFetch at :280) · `stealth-browser.ts:262` + `screenshot.ts:171` (`page.goto` gated only by the sync, non-resolving `validateOutboundUrl` → DNS rebinding) · `video/images.ts:57` · `web-read.ts:175` · `telegram.ts:101` (bot token in a path handed to r.jina.ai).
