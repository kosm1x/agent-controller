---
name: archived-pre-may-audits
description: Archived qa-auditor index lines for audits dated 2026-04-08 to 2026-05-15 (v7.x, CCP, F7-F9, Google Workspace, security sweep, evolution-log rituals). Grep here for any audit older than 2026-05-15.
metadata:
  type: project
---

# Archived index lines — audits before 2026-05-15

Moved out of MEMORY.md 2026-08-23 for the size cap. Each topic file still exists; only the index hooks live here.


- **Archived: 16 v6.x sprint audits (2026-04)** → [archived-v6-sprint-audits](archived-v6-sprint-audits.md) — grep for any v6.0/v6.2/v6.3/v6.4 sprint audit.
- [sdk-wrapper-vs-direct-call-audit](sdk-wrapper-vs-direct-call-audit.md) — claude-sdk cache_control + phantom-$0 (05-23): FAIL. Audit ALL consumer seams when fixing a shared inference module.
- [skill-evolution-cascade-audit](skill-evolution-cascade-audit.md) — ritual ~50% fail (05-24): PASS W/WARN. Retry drops agent_type/tools/ritualId → re-classifies to nanoclaw.
- [community-manager-email-round2](community-manager-email-round2.md) — email mode R2 (05-15): PASS W/WARN. (R1 [community-manager-email-audit] FAIL: allowlist exposed operator KB/Gmail to anonymous senders.)
- [northstar-sync-strict-mirror-audit](northstar-sync-strict-mirror-audit.md) — strict-mirror (05-08): FAIL. Deletes local files on stale COMMIT_IDs while INDEX claims "no deletes".
- [v76-spine6-round2-audit](v76-spine6-round2-audit.md) — Spine 6 R2 (05-08): PASS W/WARN. Structurally-sound R1 bundles surface forward-looking contract looseness in R2, NOT moved drift.
- [prompt-enhancer-leakage-audit](prompt-enhancer-leakage-audit.md) — RC1-RC5 enhancer leak (05-07): PASS W/WARN. Cold-start guard ignores risk=high; SPLIT marker collision unsanitized.
- [v73-p4a-round2-audit](v73-p4a-round2-audit.md) — v7.3 P4a R2 (04-21): FAIL. Scalar-sanitization bypass; ROAS boundary matches "roast".
- [f81b-pm-paper-audit](f81b-pm-paper-audit.md) — PM paper adapter (04-20): PASS W/WARN. Dust filter blocks full exits; no stale-abort gate.
- [f81a-pm-alpha-round2](f81a-pm-alpha-round2.md) — PM Alpha R2 (04-20): PASS W/WARN. Whale multi-outcome, UTC slice; 4/8 fixes untested.
- [f9-rituals-round2](f9-rituals-round2.md) — Morning/EOD Rituals R2 (04-20): PASS W/WARN. task.failed path bypasses budget.
- [f8-paper-trading-audit](f8-paper-trading-audit.md) — Phase β S11 (04-19): PASS W/WARN. Silent stale-quote fallback distorts totalEquity.
- [f7-round3-production-readiness](f7-round3-production-readiness.md) — F7 R3 (04-18): PASS W/WARN. Zero observability; as_of unvalidated.
- [gdocs-read-full-audit](gdocs-read-full-audit.md) — gdocs_read_full (04-16): FAIL. Missing from GOOGLE_TOOLS scope group + READ_ONLY_TOOLS guard; never loads.
- [google-workspace-audit](google-workspace-audit.md) — Google Workspace (04-10): PASS W/WARN. URL scope injection misses 3 domains.
- [hardening-commit-audit](hardening-commit-audit.md) — commit ed0d56b (04-09): PASS W/WARN. SSRF IPv6 bypass (brackets); Telegram restart/stop null race.
- [inference-prompt-efficiency-audit](inference-prompt-efficiency-audit.md) — inference+prompt (04-09): PASS W/WARN. Pricing drift; max_tokens truncation.
- [security-audit-20260409](security-audit-20260409.md) — full security audit (04-09): PASS W/WARN. Shell injection in code-search, SSRF in http_fetch.
- [ccp5-regression-audit](ccp5-regression-audit.md) — riskTier regression (04-08): FAIL. registry.execute() still blocks 10 tools; Prometheus bypasses the fix.
- [ccp1-ccp4-audit](ccp1-ccp4-audit.md) — CCP1-CCP4 (04-08): FAIL. Browser tool names wrong in UNTRUSTED_TOOLS; WRITE_VERIFICATION markers wrong for 4/11.
- [evolution-log-commit-ritual-audit](evolution-log-commit-ritual-audit.md) — weekly commit ritual (06-17): FAIL. Git tools route through checkMissionControlAccess which THROWS on `main`; git_commit index-scoped not pathspec.
- [evolution-log-append-gate-audit](evolution-log-append-gate-audit.md) — RITUAL_WRITABLE_DOCS append-only gate R2 (06-17): FAIL. An append-only gate keyed on a write-indicator regex inherits every gap in that regex.
