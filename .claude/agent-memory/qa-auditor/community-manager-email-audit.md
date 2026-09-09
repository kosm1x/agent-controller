---
name: community-manager-email-audit
description: 17b69a7 community-manager email mode audit — FAIL. Tool-gate implemented but allowlist over-permissive; cross-sender history bleed; persona-only mitigation.
metadata:
  type: project
---

# v7.x community-manager email mode audit (commit 17b69a7) — 2026-05-15

## Verdict: FAIL (BLOCK activation)

Router-level tool-gate is correctly implemented (override propagates through fast/heavy/swarm/nanoclaw → input.tools → toolRegistry.getDefinitions). The failure is in the COMMUNITY_EMAIL_TOOLS allowlist contents and the thread-key sharing across senders.

## Critical findings

- **C1** `task_history` exposes operator task corpus (`title LIKE %query%`, 500-char output preview) — file `src/tools/builtin/task-history.ts:74-91`
- **C2** `jarvis_file_{read,list,search}` grants full operator KB read access
- **C3** `gmail_search` + `gmail_read` + Calendar + GDocs/Sheets/Slides = full operator personal Gmail/GDrive read (single OAuth credential)
- **C4** `web_read` + `browser__goto` + `browser__markdown` are exfiltration channels (URL query string carries sensitive data; SSRF guard blocks only private IPs)
- **C5** `list_dir` has zero path validation (execFileSync ls/find on user-supplied path) → enumerate `/root/`, `/etc/`, etc.
- **C6** `file_read` denylist sized for owner-only threat model; missing source dirs, KB mirror, docs, project siblings — too narrow for anonymous external senders
- **C7** **Cross-sender conversation history bleed**: `threadKey(channel, from, senderJid)` returns just `channel` for non-`@g.us` from (email never has @g.us). All senders to one mailbox share `tk = "email:<id>"`. `conversationThreads`, `previousScopeGroups`, `previousMessages`, SQLite hydration query all keyed by mailbox not sender. Sender A's PII leaks into Sender B's runner conversationHistory. Commit message claim of per-sender threading is true only for EmailAdapter reply-ID map, false at router level. Verify: `src/messaging/router.ts:485-493` (threadKey), `:800-812` (hydration `baseChannel = tk` for email)
- **C8** `gdrive_download` enumerates+downloads operator Drive to VPS FS
- **C9** `list_schedules` leaks operator routines, cron, team email_to
- **C10** Zero router-level test pins community-manager override contract — load-bearing safety property has no regression coverage

## Warnings

- **W1** Mode-undefined fails open (defense-in-depth: force-restrict any email channel where mode !== "owner-only")
- **W2** System prompt sections (fileSystemSection, personalDataSection, capabilitiesSection) leak operator-private structure to stranger sessions (hasNorthStar+hasGoogle flags fire based on tool list, no mode check)
- **W3** `knowledge_map` calls `infer()` per node — cost amplifier; no rate limit
- **W4** Header construction allows `|`/`[`/`]` injection via mail.from (extractAddress permits anything inside `<...>` except `>`); subject same; CRLF is parser-stripped (good) but the pipe-collision allows fake `Modo: owner-only` / `De: fede@…` tags
- **W5** `vps_status` discloses operator infrastructure
- **W6** `project_list` discloses project slugs + credential KEY names per project
- **W7** No per-sender rate limit; cost-DoS ≈$30-60/day per mailbox at Sonnet rates
- **W8** scope.ts:435-436 comment ("gmail_read is gated by config in scope mode-selection") claims a safety property that doesn't exist — gmail_read is exposed whenever GOOGLE_CLIENT_ID is set

## Verified tool-gate completeness (one positive finding)

The router-level override correctly propagates through every runner:
- `router.ts:1801` passes `tools` to `submitTask`
- `dispatcher.ts:373` propagates to `RunnerInput.tools`
- `fast-runner.ts:664-669` uses `toolRegistry.getDefinitions(input.tools)` (the only path messaging tasks take — classifier hard-codes messaging → fast at `classifier.ts:145-153`)
- `heavy-runner.ts:48,96` passes `input.tools` to `orchestrate()` → `executor.ts:324` calls `toolRegistry.getDefinitions(toolNames)` per goal
- `swarm-runner.ts:343` propagates to subtask `submitTask` calls
- `nanoclaw-runner.ts:41` passes through
- Replan path: `planner.ts:193` (replan) emits goal graph only; executor enforces the gate

Persona/prompt injection in From/Subject can fool the LLM about mode, but the tool-gate is enforced regardless — safety property is preserved.

## Pattern lessons

1. **Tool-gate completeness is necessary but not sufficient** when the allowlist itself is permissive. Each allowlisted tool needs an audit against the threat model (here: external anonymous sender), not just a "read-only" annotation. A "read" tool that reads operator private data is a critical leak even if `readOnlyHint: true`.
2. **Cross-sender state sharing**: thread keys, scope inheritance, conversation buffers — any structure keyed by channel-name leaks across senders in a multi-tenant channel. The `threadKey()` function originally designed for WhatsApp groups (sender JID disambiguation) was not extended to per-sender email.
3. **System prompt is part of the surface**: fileSystemSection / personalDataSection / capabilitiesSection describe operator-private structure. Tool-flag gating (`hasNorthStar`, `hasGoogle`) was the right primitive for owner mode but wrong for community mode.
4. **`readOnlyHint: true` annotation is not the right safety signal for external-sender contexts** — `gdrive_download` is "readOnly" semantically (doesn't mutate Drive) but writes to VPS FS; `gmail_read` is "readOnly" but reads operator-private data; `web_read` is "readOnly" but is an exfil channel.

## Files referenced

- `/root/claude/mission-control/src/messaging/scope.ts:396-465` (allowlist)
- `/root/claude/mission-control/src/messaging/router.ts:1654-1680` (override), `:485-493` (threadKey), `:800-812` (hydration)
- `/root/claude/mission-control/src/messaging/channels/email.ts:528-588` (handleRawEmail), `:367-370` (per-sender adapter thread map)
- `/root/claude/mission-control/src/messaging/types.ts:40` (EmailChannelMode union)
- `/root/claude/mission-control/src/messaging/prompt-sections.ts:65-72` (persona)
- `/root/claude/mission-control/src/tools/builtin/{task-history,jarvis-files,google-drive,google-gmail,code-search,immutable-core,schedule,projects,knowledge-map,web-read}.ts`
