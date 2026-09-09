---
name: archived-v6-sprint-audits
description: Archived one-line index of 2026-04 v6.0/v6.2/v6.3/v6.4 sprint QA audits (superseded major versions). Grep here for a v6.x audit; each links its own detail file.
metadata:
  type: project
---

# Archived v6.x sprint audits (2026-04)

Moved out of MEMORY.md 2026-07-01 to keep the live index lean. All from superseded v6.x major versions. Detail lives in each linked topic file.

- [v6-s1-audit](v6-s1-audit.md) — v6.0 S1 branch-gate: file_edit gap, git add -A, require() in ESM, no tests (2026-04-05)
- [v6-s7-audit](v6-s7-audit.md) — v6.0 S7 code search: LIKE wildcard escape, INT/bool mismatch, stale index, thin tests (2026-04-05)
- [sg1-sg5-audit](sg1-sg5-audit.md) — SG1-SG5 safeguard: FAIL, 3 critical bypasses (file_delete, path traversal, sqlite3 cooldown) (2026-04-06)
- [openclaude-behavioral-audit](openclaude-behavioral-audit.md) — OpenClaude batches 2-3: PASS WITH WARNINGS, deferral untested, zero consumers (2026-04-06)
- [batch3-4-audit](batch3-4-audit.md) — Batches 3-4: PASS WITH WARNINGS, corrupted Unicode, no path-safety tests, drift regex URL FPs (2026-04-06)
- [m0-pgvector-audit](m0-pgvector-audit.md) — M0 pgvector KB migration: PASS WITH WARNINGS, 3 critical (access_count, reinforce race, hash encoding), 3/5 untested (2026-04-06)
- [v62-s1-routing-audit](v62-s1-routing-audit.md) — v6.2 S1 smart provider routing: PASS WITH WARNINGS, threshold asymmetry, window mismatch, weak cost test (2026-04-06)
- [v62-s2-cancel-audit](v62-s2-cancel-audit.md) — v6.2 S2 cancel from Telegram: FAIL, status overwrite race (cancelled->failed), abort exitReason unhandled, signal missing in non-fast runners (2026-04-06)
- [v62-m05-extractor-audit](v62-m05-extractor-audit.md) — v6.2 M0.5 background extractor: PASS WITH WARNINGS, 8-char hash collision, no storeFacts tests, duplicate DB read, unbounded latency (2026-04-06)
- [v62-m1-dedup-audit](v62-m1-dedup-audit.md) — v6.2 M1 lesson fingerprinting+dedup: PASS WITH WARNINGS, enforce sweep risk, metadata loss on dedup, no stop cron, no dedup tests (2026-04-06)
- [v62-v1-tts-audit](v62-v1-tts-audit.md) — v6.2 V1 TTS engine: PASS WITH WARNINGS, listVoices dashes bug, splitText contract violation, orphaned temp dirs, dead generatePerSceneTTS (2026-04-06)
- [v63-tool-deferral-audit](v63-tool-deferral-audit.md) — v6.3 tool deferral: FAIL, allowedToolNames never updated after expansion, 83+ tools non-functional, exa_search dual-listed (2026-04-07)
- [v631-optimization-audit](v631-optimization-audit.md) — v6.3.1 optimization: PASS WITH WARNINGS, pgvector race, exa_search still dual-listed, fede-summary gated behind northstar (2026-04-07)
- [v64-sprint-audit](v64-sprint-audit.md) — v6.4 sprint: PASS WITH WARNINGS, isDegraded latency denominator bug, pgCascadeStale unconditional, expandQuery timeout dead, 3 untested modules (2026-04-07)
- [v64-cl1-comprehension-audit](v64-cl1-comprehension-audit.md) — v6.4 CL1 comprehension: PASS WITH WARNINGS, scope.ts >= 0 always-true, setTimeout leak, normalizedText inconsistency, no precedent tests (2026-04-07)
- [v64-h1h3-hardening-audit](v64-h1h3-hardening-audit.md) — v6.4 H1-H3 hardening: PASS WITH WARNINGS, setTimeout leak, always-read bloat risk, no provider failure check, no tests for 3 features (2026-04-07)
