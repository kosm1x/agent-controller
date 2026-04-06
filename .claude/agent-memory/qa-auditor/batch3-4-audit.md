---
name: batch3-4-audit
description: Behavioral coherence batches 3-4 audit (a0d6fef, d20cb91): path safety pipeline, drift verification, boilerplate, progress labels
type: project
---

Batch 3 (a0d6fef) and Batch 4 (d20cb91) — behavioral coherence improvements.

**Key findings:**

- validatePathSafety: corrupted Unicode (U+FFFD x3) in error message at line 141 of immutable-core.ts
- validatePathSafety: `%` regex blocks legitimate Linux filenames containing literal `%` — false positive risk is LOW (LLM rarely generates such paths)
- validatePathSafety: validates a cleaned (quote-stripped, tilde-expanded) path but callers continue using raw path — validate-vs-use mismatch. Not exploitable because Node fs functions don't expand tilde/quotes
- isDangerousRemovalPath: receives rawPath (not cleaned) in file_delete — resolve() won't strip quotes. Covered by defense-in-depth (ALLOW_DELETE_PREFIXES check later)
- isDangerousRemovalPath: does NOT follow symlinks. A symlink at /tmp/safe pointing to /etc would pass. Low risk due to ALLOW_DELETE_PREFIXES
- DANGEROUS_FILES: missing .env.development, .env.staging, .env.test, .npmrc, .netrc
- Memory drift regex: false-positives on URLs containing /var/, /tmp/, /etc/ path segments. Non-blocking, best-effort
- Dynamic import("fs") in enrichment.ts: works at runtime, intentional lazy load
- BACKGROUND_AGENT_BOILERPLATE: correctly replaces old text, defined as local const (SCREAMING_CASE in method scope)
- Progress label .pop(): returns last by insertion order, not execution completion order — cosmetic only
- Zero tests for validatePathSafety and isDangerousRemovalPath despite 152 new lines of security logic

**Why:** Path safety is a security-critical pipeline. Missing tests could mask regressions.
**How to apply:** Require test coverage for any new security enforcement function.
