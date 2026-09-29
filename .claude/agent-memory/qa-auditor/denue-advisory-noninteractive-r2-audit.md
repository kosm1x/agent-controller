---
name: denue-advisory-noninteractive-r2-audit
description: 09-29 R2 of the DENUE none-variant bundle - W1 call-site test + W2 highRiskCallOf escalate-instead-of-retry in reactions/manager.ts; PASS-W-WARN.
metadata:
  type: project
---

Verdict PASS WITH WARNINGS, 0 Crit, tsc 0, 221/221 (4 files). W1 mutant RED. Manager mutants 4/5 RED; the survivor (latest-run ORDER BY DESC->ASC) is moot: 0 of 3705 tasks have >1 run.

- Live shapes: `runs.tool_calls` = JSON array of bare-name strings; `task_trace_events.tool` holds the bare name (claude-sdk strips `mcp__jarvis__`). Only the fast runner emits `tool.called`; heavy container error/timeout returns carry no toolCalls -> blind spot (0 heavy non-interactive failures/sends in 90d).
- `getEffectiveRiskTier` is an EXACT map lookup, unknown -> "low". High set (177 tools incl. Google): tweet_post, gmail_send, gdrive_share, gdrive_delete, file_delete, jarvis_file_delete, jarvis_files_batch_delete, delete_schedule, memory_forget, jarvis_dev, vps_deploy, jarvis_apply_proposal, northstar_sync, kb_ingest_pdf_structured. shell_exec/jarvis_file_write/user_fact_set = low.
- 90d replay: 2 non-interactive retries, 0 converted. Non-interactive high-tool use = gmail_send 349 tasks, tweet_post 63, all completed.
- Escalation Telegram text omits the new reason ("failed after 0 retries: <error>").

**Why:** CLASS: a risk-tier lookup keyed on recorded names is only as good as the name form recorded; verify writer normalization (prefix strip, alias repair) before trusting an exact-map check.
**How to apply:** for any gate reading recorded tool names, check each writer (sdk strip, openai findClosest repair, heavy/nanoclaw returns) and the resolver's unknown-name default.
