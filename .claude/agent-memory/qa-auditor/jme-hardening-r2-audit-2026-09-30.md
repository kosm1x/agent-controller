---
name: jme-hardening-r2-audit-2026-09-30
description: R2 of the JME hardening fold (09-30): PASS-WITH-WARNINGS-pending-1-Crit (FAIL); 12/12 mutations RED; stated preference downgraded to 60 d inferred on supersede; +21 ms sync recall
metadata:
  type: project
---
# JME hardening R2 audit, 2026-09-30

Verdict: FAIL (1 Critical). Everything else is at Warning level or below. tsc 0. The 4 scoped suites pass, 206/206. 12 of 12 hand mutations went RED.

## Critical
- C1 `jme.ts:127` + `:955-956`: upsertFact supersede takes the INCOMING confidence and TTL, then expires the whole cluster. A stated permanent preference (0.99, `expires_at` NULL) superseded by an inferred re-extraction at cosine 0.85-0.95 gets expired, and a 0.7 row with 60 d replaces it. Repro (throwaway test Ra): rows after = `[{id:1,conf:0.99,perm:0,days:-0},{id:2,conf:0.7,perm:0,days:60}]`, outcome `superseded`. The 40 live inferred preferences that are permanent today also turn into 60 d rows on their next supersede. Fix: the new row inherits max(confidence, capped at 0.99) and the permanence of the strongest member of the cluster.

## Warnings
- W1 A malformed extractor element (no `factText`) throws in upsertFact at `jme.ts:854`. `upsertError` at `:1261` then keeps the whole window. Repro Rb: `turns left 1` plus `TypeError ... 'trim'`. The 7 d `pruneStaleTurns` bounds it, and `run_failed` fires every night. Fix: validate the element shape and count it as `dropped`.
- W2 `queryMemory` hot path went from p50 10.5 ms to 31.7 ms (p90 14 to 39), all synchronous. Cause: `deduplicateFacts(fused, ..., k)` at `:670` compares k anchors against all fused candidates. Fix: apply the relative cutoff first, or dedup only the top 3k.
- W3 Redaction damage (8/456 live rows would change): Fede's own email (#264, #293, #332, #535), league ID #425 becomes `[digits]`, Sheet ID #525 becomes `[token]`. None is dropped (under 40 %). The transcript is redacted too, so these facts can never be learned again.
- W4 Shapes that escape redaction: `password: hunter2`, `contraseña es Tigre2024!`, letters-only 32-character tokens, URL-encoded espn_s2 (the live case: `%` splits the runs), and a space-separated card number.
- W5 TRANSIENT_FACT_RE (`:111`) hits 38/300 project/event rows. Durable ones get 30 d: #425 (league ID, "10 teams"), #341 ("Trustr document v1.0"), #268. `\b4a\b` also matches any "4a".
- W6 A ≥ 0.95 skip keeps the OLD wording and extends it (`:918`). An update like "W39" to "W40" is discarded and the stale row lives on. Stale facts can stay alive indefinitely as long as they keep being re-extracted.
- W7 B1 skips "¿y Trustr?", "¿y VLMP?", "sí, hazlo" (single-entity questions). Only 6/611 chat turns in 14 d would skip, so the gain is small.

## Verified OK
- The backfill dry run matches an independent pairwise pass: 2 clusters, 8 rows. #237 is linked at 0.977 to #204, and #346 at 0.959 to #358 and 0.964 to #373. These are true ≥ 0.95 chains, not a union-find bug. The cross-category twin #264/#332 (0.995) is out of scope by design.
- Nothing reads `top_k_ids` outside the write paths.
- A confirmed preference is never superseded: the confirmed check precedes the supersede branch.
- `--confirm` sets `expires_at = NULL` on live rows.
- Recall result count on a fact-surrogate replay: median 4 (it was about 8). This is PLAUSIBLE for real queries.
- `scripts/` is excluded from tsconfig, so the backfill script is not type-checked. It runs.
