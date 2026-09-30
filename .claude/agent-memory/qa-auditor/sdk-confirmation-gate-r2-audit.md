---
name: sdk-confirmation-gate-r2-audit
description: claude-sdk wrapTool confirmation gate for high-risk tools, round 2 (2026-09-30) - PASS-W-WARN after R1 FAIL (C1 gws flag-in-segment, C2 no context on dispatch paths)
metadata:
  type: project
---
Round 2 of the uncommitted SDK confirmation gate (base fe5ff2a). R1 FAIL -> R2 PASS WITH WARNINGS, 0 Crit.

- Mutations RED: dispatcher primary wrap, canAskOperator=routerRoot, gws tool-side `^[-+]` reject, fg confirmLine, routerRoot !parentTaskId, parent.interactive inheritance, W2 delimiter neutralize, no-ctx in-run refusal.
- SURVIVED (test gaps): nanoclaw->fast fallback wrap (dispatcher ~:874); background-agent confirmLine append (router ~:3185).
- gateContextFor defaults interactive=true: internal submitters without `interactive:false` (skill-discovery Auto-skill, proactive scan, a2a) now REFUSE gated tools; 0 gated calls in 30d, latent.

**Why:** CLASS: an ALS context computed at submit time must be re-entered on EVERY execute site; the fallback site was wrapped but unpinned.
**How to apply:** on any R3 of this gate, re-run the two surviving mutants first; mutation helper pattern = perl -0pi + cp -p restore + sha256sum -c.

R3 (09-30): PASS-W-WARN. All R2 folds mutation-RED (fallback wrap, bg 🔐 line, a2a flag, skill-discovery/proactive flags, nonce). Residual: formatForWhatsApp runs bold/italic + HTML-tag strip BEFORE/ACROSS inline code (`Peter <evil@x.com>` -> `Peter `, `__init__` -> `_init_`); JSON tail in model order still hides jarvis_dev.action, wp_publish site/status, calendar attendees; gws argv newline breaks the TG code span. CLASS: a "code span is literal" guarantee holds per FORMATTER — check every channel's formatter, not the one the fix was written against.
