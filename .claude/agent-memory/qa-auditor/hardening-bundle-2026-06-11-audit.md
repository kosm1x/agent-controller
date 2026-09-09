# Hardening Bundle Audit — 2026-06-11 (pre-audit-2026-06-11 baseline)

5-angle hardening bundle (perf/memory/resilience/hygiene/security), 29 files. Verdict: **SHIP** (no Critical). typecheck + 6195 tests green.

## Verified-correct (high-risk items that passed)
- **Shutdown reorder** (index.ts): drain BEFORE shutdownMessaging/teardownAll is correct — surviving tasks need MCP tools + delivery channel. Re-entry guard (`shuttingDown`) prevents double-teardown / SQLITE_MISUSE. Sound.
- **Telegram send() throw**: ALL callers reach it via router (broadcastToAll/sendBriefingToOwner/sendToChannel/sendLLMReplyToChannel) — every one has `.catch`. No unhandled-rejection introduced. broadcastToAll/sendBriefingToOwner never reject (internal per-channel catch), so `await router.broadcastToAll(...)` callers (diff-digest.ts:163) safe.
- **/metrics + /health gating**: mc-prometheus is on custom Docker net 172.19.0.3 / 172.20.0.4 (NOT default bridge 172.17). Live tcpdump confirmed scrape packet src=172.19.0.3 → 172.17.0.1:8080 with NO SNAT (host-local dest, MASQUERADE only on external egress). 172.19/172.20 BOTH match `isPrivatePeer` regex `172.(1[6-9]|2\d|3[01])`. Scrape NOT broken. No Caddy route proxies to 8080 (direct UFW-open), so XFF-spoof concern N/A. `incoming.socket.remoteAddress` access pattern mirrors existing rate-limit.ts.
- **vectorCache keyed by row.id (=conversations.id)**: conversation_embeddings.conversation_id is PRIMARY KEY → strict 1:1, append-only. No 1:N cache-collision corruption.
- **Promise.all(enrichContext, classifyScopeGroups)**: both internally guarded (enrichContext "never throws"; classifyScopeGroups try/catch→null regex fallback). Promise.all can't reject. No shared mutable state. Error semantics identical to prior sequential. Safe.
- **adapter.ts pricing delegation**: calculateCost(model,prompt,completion) sig matches; deletes drifted MODEL_PRICING. **claude-sdk SONNET_MODEL_ID = "claude-sonnet-4-6"** byte-identical to old literal. 4 cron RITUALS_TIMEZONE imports default to "America/Mexico_City" — no behavior change unless env set.
- **mcp/index.ts DELETE**: zero importers (only comment refs). setMcpAlertFn zero callers. McpToolSource.setAlertFn init ordering OK (initAll@216 before setAlertFn@352; both-order guarded).
- **hindsight recall timeout 3000→8000**: matches recall-compare.ts:41 "Default 8000" invariant. Dormant (HINDSIGHT_ENABLED=false). Test updated.

## Findings (Warning/Note only)
- **W1 vectorCache id-reuse staleness** (sqlite-backend.ts:148): cache is process-lifetime, never invalidated on delete. conversations.id is INTEGER PRIMARY KEY *without AUTOINCREMENT* → SQLite CAN reuse a deleted max-rowid. Delete paths exist (consolidate.ts:163-166, consolidation.ts). A reused id with stale cached vector → wrong cosine scores indefinitely. Low-prob (needs max-id reuse within process life). Fix: invalidate in the DELETE path, or add TTL.
- **W2 fd00:: SSRF gap** (url-safety.ts BLOCKED_IP_PATTERNS): blocks `/^fc00:/i` but NOT fd00::/8 — the actually-used ULA half. auth.ts isPrivatePeer correctly uses `(fc|fd)`. A DNS name (or IPv6 literal) resolving to fd00: bypasses validateOutboundUrlResolved (the whole point of the new rebinding defense) AND pre-existing validateOutboundUrl. Add `/^fd/i`.
- **N1 WhatsApp flush vs send() reorder**: during paced flush (2-3s/msg), a fresh send() with connected=true takes direct-send path, jumps ahead of backlog + bypasses global pacing. No loss/dupe (peek-shift correct, flushing guard prevents re-entrant flush). Minor ordering/ban-pacing nuance only.
- **N2 embedCache TTL only checked on read** (embeddings.ts), not eviction — expired entries linger until size-evicted. Harmless (embeddings deterministic per text; config env-fixed).
