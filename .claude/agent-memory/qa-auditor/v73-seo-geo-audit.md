---
name: v7.3 Phase 2+3+5 SEO/GEO tool suite — Round 1 audit
description: Round 1 found 1 CRITICAL (SSRF bypass in 3 of 4 tools due to validateOutboundUrl try/catch anti-pattern), 6 MAJOR, 8 warnings
type: project
---

**2026-04-21 — v7.3 Phase 2+3+5 SEO/GEO round 1 audit — FAIL**

Scope: 4 new tools (ai-overview-track, seo-telemetry, seo-robots-audit, seo-llms-txt-generate) + content_quality extension to seo-page-audit.

**Why:** Catch bugs before commit. Tool suite spans 5 new files, 2 new DB tables, scope regex extension.

**How to apply:** When auditing any new tool that makes outbound fetches in this codebase — verify the `validateOutboundUrl` call pattern. The function returns `string | null`, never throws. Seen 3 tools in one sprint get this wrong by wrapping in try/catch. The correct pattern (seo-page-audit.ts:653-656):

```ts
const err = validateOutboundUrl(url);
if (err) return JSON.stringify({ error: err });
```

Wrong pattern (SSRF bypass):

```ts
try { validateOutboundUrl(url); } catch (err) { return ... }  // never fires
```

**Other lessons from this audit:**

- Broad text regexes (`/\bAI Overview\b/i`) across full HTML blobs false-positive on blog posts that mention the phrase in organic results.
- GSC API has two property types: URL property (`https://example.com/`) and Domain property (`sc-domain:example.com`, the Google default since 2018). Tools that only build URL-property form fail for the more common case.
- Sitemap URL cap placement matters: capping the _loop_ doesn't cap per-body ingestion. A single 50k-URL sitemap bypasses a 5k loop guard.
- Duplicated regex on curly-quote line was actually the straight-quote regex — double-inflates counts. Diff regexes between "straight" and "curly" must use `“`/`”` escapes.
- stealthFetch launches a fresh Chromium per call with no pool → concurrent AI-overview-track invocations spawn N browsers (~300 MB each).
