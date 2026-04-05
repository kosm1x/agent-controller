---
name: agent-controller-audit
description: Architecture patterns, tech stack, known issues, and audit findings for the agent-controller (mission-control) codebase
type: project
---

## Tech Stack

- TypeScript, Hono HTTP, better-sqlite3 (WAL mode), node-cron
- Vendor-agnostic LLM inference via raw fetch to OpenAI-compatible endpoints
- 5 runner types: fast (90%+ of tasks), nanoclaw, heavy, swarm, a2a
- Messaging channels: Telegram, WhatsApp (grammy, baileys)
- MCP tools (~156 total as of Google Drive CRUD), singleton pattern for DB/registry/eventbus/config
- 88+ test files, 1204 tests (as of 2026-04-04 session audit)
- Centralized inference constants: src/config/constants.ts (env var overridable)
- Zod v4.3.6 for tool arg validation (added v4.0 S2)
- FTS5 + embedding hybrid search for memory recall (added v4.0 S3)

## Architecture Patterns

- Dynamic tool scoping in router reduces prompt bloat by ~40-50% via keyword regex matching
- Hallucination detection: 7-layer system (zero-tools, read-hallucination, partial, narration, retry, vision-bypass, mechanical replace)
- Context compressor: Hermes-inspired protect-head/tail, summarize middle
- Budget enforcement via cost_ledger table (rolling 24h window, not calendar day)
- Proactive scanner: cron-based, 2 nudges/day max, suppressed if user active in last hour
- CAS checkout for task dispatch (SQLite UPDATE WHERE status='queued')

## Known Issues Found (2026-03-24 Audit)

- SSE parser concatenates tool call names instead of assigning (C1)
- Budget check has TOCTOU gap — concurrent tasks can exceed limit (C2)
- list_schedules duplicated in MISC_TOOLS and SCHEDULE_TOOLS (C3)
- Levenshtein tool repair lacks guard against destructive tool misroutes (H1)
- Container slot double-release in drainContainerQueue catch handler (H2)
- conversationThreads/hydratedChannels maps grow without eviction (H3) — now worse with imageUrl base64
- pendingProactive Set never cleans up failed tasks (H4)
- Context compressor places tool stubs at array end instead of after parent message (H5)
- cost_ledger table defined in db/index.ts instead of schema.sql (S1)

## Issues Found (2026-03-28 Audit — e409fb5)

Critical:

- WP Guard 0 uses content-length equality — same-length edits falsely blocked (C1-new)
- Gradio SSE regex is greedy with /s flag — can capture wrong data block (C2-new)

High:

- allToolCallsReadOnly([]) returns true (vacuous truth) — empty tool_calls increments analysis_paralysis counter (H1-new)
- allResultsAreErrors([]) returns true — empty results increments error counter (H2-new)
- ERROR_RESULT_RE matches "not found" in normal content — single-tool false positives (H3-new)
- Gradio response JSON.parse unchecked — confusing error on malformed response (H4-new)
- isReadHallucination regex duplicated in retry and replace branches of fast-runner (H5-new)

Medium:

- hf_generate/hf_spaces (532 lines) have zero test coverage (M1-new)
- `spaces`/`speech`/`music`/`song` bare words in specialty scope — overly broad (M2-new)
- startsAtColA second regex `/![A-Z]+$/` matches bare non-A columns like Sheet1!K (M3-new)
- result.range not null-checked in gsheets_read before .match() (M4-new)
- pdf-read.test.ts missing afterEach(vi.restoreAllMocks) (M5-new)
- browser\_\_goto in READ_ONLY_TOOLS but causes browser state mutation (M6-new)

## Issues Found (2026-03-29 Audit — v2.29/v2.30/v3.3 session)

Critical:

- Variable shadowing: `calledToolNames` declared at both line 792 (loop) and 1143 (wrap-up) in adapter.ts — benign now but fragile (C1-v3)
- `detectActiveGroups` in scope.ts ignores two-phase scope isolation — logs misleading group activations (C2-v3)

Warnings:

- `consecutiveSmallResults ?? 0` at adapter.ts:1066 — dead nullish coalescing (variable initialized to 0) (W1-v3)
- Fast-path fallback (<=5 words, no triggers, no ?) risks false positives for non-tool emotional/urgent messages (W2-v3)
- SSE regex `(\[.*?\])` non-greedy may mis-capture if Gradio URLs contain `]` characters (W3-v3)
- TelegramStreamController.doEdit() swallows all errors including auth failures (W4-v3)
- Benchmark script `API_KEY!` non-null assertion without runtime guard (W5-v3)
- `enable_thinking: false` at body top level vs `extra_body` inconsistency between adapter.ts and benchmark (W6-v3)

Standards:

- `getOriginalContentHash` in \_testing export but not tested (S1-v3)
- `commit__create_suggestion` in WRITE_TOOLS but missing from COMMIT_WRITE_TOOLS scope group (S2-v3)

New files added: fast-path.ts (38 tests), telegram-stream.ts, huggingface.ts (0 tests), pdf-read.ts (10 tests), benchmark-models.ts

## Issues Found (2026-03-29 Audit — v4.0 S1-S3)

Critical:

- z.coerce.boolean() coerces "false" string to true — affects 8+ boolean tool params (C1-v4)
- FTS5 operator injection: "not" passes extractKeywords → FTS5 syntax error or wrong semantics (C2-v4)

High:

- Missing FTS5 UPDATE trigger — stale index if conversations ever updated (H1-v4)
- Process substitution <() >() bypasses shell guard — same class as $() (H2-v4)
- conversation_embeddings FK has no ON DELETE CASCADE — delete fails on FK violation (H3-v4)
- Embedding search O(n) scan of 500 rows per recall — bounded but no early termination (H4-v4)

Medium:

- FTS5 backfill runs synchronously on every startup (linear scan) (M1-v4)
- $((arithmetic)) blocked as false positive by $() regex (M2-v4)
- Dep policy violation: 10 deps vs documented "6 core + 2 messaging" (M3-v4)
- embed() truncates to 512 chars silently (M4-v4)
- Fire-and-forget embedding in retain() — unbounded concurrent HTTP (M5-v4)

New files added: schema-validator.ts (10 tests), embeddings.ts (7 tests), backup-db.sh, healthcheck.sh

## Issues Found (2026-03-29 Audit — v4.0 S5, 0e022f5)

Warnings:

- parseInt in int() helper returns NaN on non-numeric env var — silently disables all loop guards (W1-S5)
- Promise.race timeout doesn't cancel runEvaluation — leaked async work + untracked cost (W2-S5)
- WRAPUP_TOOL_RESULT_CHARS unnecessary import-alias-reassign indirection (W3-S5)
- EXPERIMENT_TIMEOUT_MS declared inside for-loop body (W4-S5)

Standards:

- HALLUCINATION_RETRY_HEADROOM is plain const, no env var override unlike all other constants (S1-S5)
- CLAUDE.md dep count "9 core + 2 messaging" not reconciled with prior M3-v4 finding of 10 (S2-S5)

Verdict: PASS WITH WARNINGS — 64 test files, 691 tests pass, typecheck clean

New files added: src/config/constants.ts (0 tests)

## Issues Found (2026-03-29 Audit — v4.0 S6, c950571)

Warnings:

- server.close() doesn't destroy keep-alive connections — potential test hang on slow responses (W1-S6)
- Mock server binds to all interfaces (0.0.0.0) instead of 127.0.0.1 — security hygiene (W2-S6)
- providerMetrics singleton leaks state across tests — ~15 calls approach isDegraded threshold (W3-S6)
- Pending setTimeout on delayMs survives server shutdown — unhandled error if used (W4-S6)

Standards:

- Port extraction via string splitting is fragile; should expose port directly (S1-S6)
- Mock response missing `model` field (cosmetic — adapter doesn't read it) (S2-S6)

Verdict: PASS WITH WARNINGS — 8 new integration tests, all pass. Core infer/inferWithTools paths covered. SSE streaming, hallucination detection, provider failover untested (deferred to S7+).

New files added: src/test-utils/mock-llm-server.ts (0 tests), src/test-utils/integration.test.ts (8 tests)

## Issues Found (2026-03-30 Audit — ACE Learning + Hermes v0.5)

High:

- Self-assessment infer() usage tokens discarded — invisible to cost tracking (H1-ace)
- parseLLMJson unsafe cast: malformed SelfAssessment crashes .unmetCriteria.join() (H2-ace)
- insertBullet TOCTOU: SELECT max + INSERT not atomic, UNIQUE violation on concurrent inserts (H3-ace)

Warnings:

- writeWithRetry spin-wait blocks event loop 20-150ms per retry (by design, better-sqlite3 sync) (W1-hermes)
- THINK_BLOCK_RE regex doesn't enforce matching open/close tag names (W2-hermes)
- Executor tests don't mock getMemoryService — relies on try/catch fallback (W3-ace)
- Module-level \_writeCount in db/index.ts leaks state across test files (W4-hermes)
- selfAssess returns met=true on failure — optimistic fallback hides outages (W5-ace)

Standards:

- busy_timeout reduction 5000→1000 not documented in CLAUDE.md (S1-hermes)
- strategy_bullets CRUD doesn't use writeWithRetry (inconsistent with pattern) (S2-ace)
- CLAUDE.md dep count still "9 core + 2 messaging" — not reconciled (S3-carry)

Verdict: PASS WITH WARNINGS — 69 test files, 755 tests pass, typecheck clean

New files added: src/db/strategy-bullets.ts (10 tests), src/memory/consolidate.ts (7 tests), src/db/index.test.ts (6 tests), 13 new adapter tests (stale signals + think blocks)

## Issues Found (2026-03-30 Audit — Scope Telemetry + Self-Tuning Flywheel)

Warnings:

- TOOL_TO_GROUP map in case-miner.ts missing "research" group — research tool scope misses won't generate test cases (W1-tel)
- Dead import: MISC_TOOLS imported but unused in case-miner.ts (W2-tel)
- mined_test_cases table schema duplicated in schema.ts and case-miner.ts — drift risk (W3-tel)
- scope_telemetry table schema duplicated in schema.sql and scope-telemetry.ts — drift risk (W4-tel)
- executor.test.ts mock return shapes missing new toolRepairs field (W5-tel)

Standards:

- scope-telemetry.ts has 0 test files (S1-tel)
- case-miner.ts has 0 test files (S2-tel)

Verdict: PASS WITH WARNINGS — 69 test files, 755 tests pass, typecheck clean

New files: src/intelligence/scope-telemetry.ts (0 tests), src/tuning/case-miner.ts (0 tests)

## Issues Found (2026-03-30 Audit — Gemini Research Tools)

Critical:

- SQLite datetime format mismatch: expires_at stored as ISO (T-separator) compared with datetime('now') (space-separator). Same-day expiry comparison broken in both listActiveGeminiFiles and cleanupExpiredGeminiFiles (C1-gem)

High:

- Scope regex false-negative: "Qué dicen los documentos sobre el impacto económico?" doesn't trigger research scope — seed case ts-gemini-research-01 will fail because gemini_research won't be scoped in (H1-gem)
- Scope regex gaps: "Analiza este documento" (intervening word "este") and "Resume el PDF" (article "el" not matched by "del?") don't trigger research scope (H2-gem)

Warnings:

- Bare keyword false positives: "podcast", "quiz", "research" without document context trigger research scope — ~1289 token waste (W1-gem)
- getApiKey() duplicated identically in gemini-image.ts and gemini-research.ts — extract to shared helper (W2-gem)
- gemini_files table not in schema.sql — third DDL location pattern (after schema.sql and db/index.ts) (W3-gem)
- No afterEach(vi.restoreAllMocks) in gemini-research.test.ts — project convention violation (W4-gem)
- Module-level \_tableReady boolean in gemini-files.ts not resettable across tests (W5-gem)
- Missing test: gemini-files.ts DB module has zero dedicated tests (W6-gem)
- Missing test: pollFileState PROCESSING→ACTIVE path not tested (W7-gem)
- Missing test: URL download timeout not tested (W8-gem)

Standards:

- JSON.parse(rawText) at line 788 of gemini-research.ts gives confusing error if rawText is undefined — should add null guard (S1-gem)

Verdict: PASS WITH WARNINGS — 13 new tests pass, typecheck clean. 1 critical datetime bug, 2 scope pattern gaps.

New files: src/db/gemini-files.ts (0 tests), src/tools/builtin/gemini-research.ts (13 tests)

## Key File Locations

- Inference constants: src/config/constants.ts
- Inference: src/inference/adapter.ts
- Fast runner: src/runners/fast-runner.ts
- Dispatcher: src/dispatch/dispatcher.ts
- CAS checkout: src/dispatch/checkout.ts
- Router: src/messaging/router.ts (~1200 lines)
- Event reactions: src/commit-ai/event-reactions.ts
- Ritual scheduler: src/rituals/scheduler.ts
- Proactive scanner: src/intelligence/proactive.ts
- Tool registry: src/tools/registry.ts
- DB schema: src/db/schema.sql + src/db/index.ts (cost_ledger)
- Context compressor: src/prometheus/context-compressor.ts
- Budget service: src/budget/service.ts
- Fast-path: src/messaging/fast-path.ts
- Telegram streaming: src/messaging/channels/telegram-stream.ts
- Scope isolation: src/messaging/scope.ts
- HuggingFace tools: src/tools/builtin/huggingface.ts
- PDF tool: src/tools/builtin/pdf-read.ts
- Model benchmark: scripts/benchmark-models.ts
- Pricing: src/budget/pricing.ts
- Schema validator: src/tools/schema-validator.ts
- Embeddings: src/memory/embeddings.ts
- SQLite memory: src/memory/sqlite-backend.ts
- Backup script: scripts/backup-db.sh
- Healthcheck: scripts/healthcheck.sh
- Mock LLM server: src/test-utils/mock-llm-server.ts
- Integration tests: src/test-utils/integration.test.ts
- Scope telemetry: src/intelligence/scope-telemetry.ts
- Case miner: src/tuning/case-miner.ts
- Tuning schema (inc. mined_test_cases): src/tuning/schema.ts
- Strategy bullets: src/db/strategy-bullets.ts
- Learning consolidation: src/memory/consolidate.ts
- Task outcomes: src/db/task-outcomes.ts
- Event bus: src/lib/events/bus.ts

## Issues Found (2026-03-31 Audit — S7 Test Coverage)

Critical:

- checkoutTask mock returns `true` (boolean) instead of `{ success: true, taskId }` — dispatcher dispatch lifecycle never exercised, `true.success === undefined` causes silent checkout failure (C1-S7)
- Single prepare() mock returns same run/get/all for all SQL statements — no SQL correctness validation, test ordering fragile (C2-S7)

Warnings:

- No afterEach(vi.restoreAllMocks) in adapter.test.ts or dispatcher.test.ts — project convention violation (W1-S7)
- 6 commit_write regex patterns have zero direct coverage — all tested indirectly via commit_read merge (W2-S7)
- commit_journal scope group entirely untested (W3-S7)
- submitTask tests don't await async dispatch — only ~30% of code path exercised (W4-S7)
- listTasks filter logic (5 params) untested — only empty filter call (W5-S7)

Standards:

- adapter.test.ts uses beforeEach not afterEach for cleanup (S1-S7)
- dispatcher.test.ts missing afterEach import (S2-S7)

Recommendations:

- Add 50-char boundary test for short-message threshold (R1-S7)
- Test hasMemory feature gate (memory_search/memory_store inclusion) (R2-S7)
- Test detectActiveGroups (different behavior from scopeToolsForMessage — no inheritance) (R3-S7)
- Test budget exceeded path in submitTask (R4-S7)
- Add wordpress positive activation test (R5-S7)
- Test getTaskWithRuns export (R6-S7)
- Test cancelTask on "queued" status (R7-S7)

Verdict: FAIL — 75 tests pass, typecheck clean, but critical mock fidelity issues mask untested dispatch lifecycle. 6/16 scope patterns untested.

New/extended files: src/messaging/scope.test.ts (17 tests), src/inference/adapter.test.ts (+7 COMMIT read-only tests), src/dispatch/dispatcher.test.ts (11 tests)

## Issues Found (2026-03-31 Audit — S8 Decomposition)

Warnings:

- No dedicated test files for guards.ts or prompt-sections.ts — 6 guard functions and detectToolFlags have zero unit coverage (W1-S8)
- checkAnalysisParalysis "frozen counter" when uncalled action tools exist — returns currentCount unchanged instead of resetting (W2-S8, pre-existing)
- Empty-array behavior fix in allToolCallsReadOnly/allResultsAreErrors is double-guarded (guards + callers both check), not a bug but redundant (W3-S8)

Standards:

- ERROR_RESULT_RE not re-exported from adapter.ts (no current consumers, cosmetic) (S1-S8)
- adapter.test.ts dead beforeEach block remains (S2-S8, carry from S1-S7)

Verdict: PASS WITH WARNINGS — 71 test files, 801 tests pass, typecheck clean. Clean extraction, correct behavioral equivalence, 2 intentional bug fixes (empty-array guards). Gap: no new tests added despite testability being extraction motivation.

New files: src/inference/guards.ts (0 tests), src/messaging/prompt-sections.ts (0 tests)

## Issues Found (2026-03-31 Audit — v4.0.7 New Capabilities)

High:

- Adaptive limits always fire: Playwright tools in MISC_TOOLS (always-on) cause hasPlaywright=true for EVERY fast-runner invocation → 43% token budget inflation (40K vs 28K) and 75% round increase (35 vs 20) for all tasks, not just browser tasks (H1-v407)
- No size limit on gmail_read attachment downloads — large attachment → OOM on VPS (H2-v407)

Warnings:

- /tmp/gmail-attachments/ files never cleaned up — accumulates over time on long-running VPS (W1-v407)
- BROWSER_TOOLS empty array + "browser" scope group + DEFAULT_SCOPE_PATTERNS browser entry = dead code path (W2-v407)
- mammoth added as 12th production dependency, violates CLAUDE.md "9 core + 2 messaging" invariant (W3-v407, carry from M3-v4/S2-S5/S3-carry)
- Scope test covers Lightpanda tools always-present but not Playwright tools in MISC_TOOLS (W4-v407)
- mammoth.default access pattern fragile if mammoth ever migrates to native ESM (W5-v407)

Standards:

- Zero test coverage for gmail_read tool (extractParts, base64url decode, attachment download, 8K body cap) (S1-v407)
- Zero test coverage for file_read .docx path (readDocx function) (S2-v407)
- No Playwright-specific test in scope.test.ts despite 12 tools added to MISC_TOOLS (S3-v407)

Pre-existing (flagged for awareness):

- Supabase service role key in plaintext in mcp-servers.json (P1-v407)

Verdict: PASS WITH WARNINGS — Features are functionally correct. Path traversal mitigated by Date.now() prefix. mammoth lazy import works correctly. Critical concern: H1-v407 inflates token spend for ALL tasks by 43%.

New/modified files: src/tools/builtin/google-gmail.ts (gmailReadTool), src/tools/builtin/file.ts (.docx support), mcp-servers.json (playwright), src/messaging/scope.ts (MISC_TOOLS expansion, BROWSER_TOOLS emptied), src/config/constants.ts (browser limits), src/runners/fast-runner.ts (adaptive detection), src/messaging/prompt-sections.ts (dual-browser section)

## Issues Found (2026-03-31 Audit — v4.0.6 Hallucination Protocol Enforcement)

Warnings:

- `status:.*completed` regex false positive: matches read-only task status reports ("Status: 3 completed, 2 pending") from commit\_\_list_tasks, triggers hallucination replacement. The `.*` greedy quantifier is too broad and isVerificationRequest exception doesn't cover normal task listing queries (W1-v406)
- `marc(?:ad[oa]|ó)` pattern matches observational "esta marcada como completada" (state description from read tools), not just first-person action claims (W2-v406)
- Zero test coverage for the 2 new Layer 2 status-change narration patterns (lines 258-261 of fast-runner.ts). 32 existing tests, none exercise these patterns (W3-v406)
- detectActiveGroups still diverges from scopeToolsForMessage on follow-up path (carry from C2-v3). Eval harness and scope telemetry won't reflect production behavior for short follow-up messages like "Procede" (W4-v406)
- Hydrated-from-DB exchanges bypass pushToThread live filter, occupy buffer slots — reduced effective history depth when prior sessions had poisoned exchanges (W5-v406, low severity)

Standards:

- WRITE_TOOLS/COMMIT_WRITE_TOOLS sync comment correct but no compile/test-time enforcement. New COMMIT write tools added to one set but not the other would silently break hallucination detection (S1-v406)
- gmail_read missing from READ_ONLY_TOOLS in guards.ts — classified as action tool instead of read-only (S2-v406)

Key findings:

- WRITE_TOOLS (fast-runner.ts) and COMMIT_WRITE_TOOLS+JOURNAL+DESTRUCTIVE (scope.ts) are PERFECTLY IN SYNC — all 14 COMMIT write tools accounted for
- allowedToolNames scope enforcement gate is architecturally sound — correctly prevents out-of-scope tool execution even after Levenshtein repair
- pushToThread live poison filter has no bypass — dual-layer defense (write-time for live, read-time for DB) is correct
- READ_ONLY_TOOLS (guards.ts) perfectly matches COMMIT_READ_TOOLS (scope.ts) — all 7 tools present

Verdict: PASS WITH WARNINGS — 73 test files, 847 tests pass, typecheck clean. Core sync invariants verified correct. Scope gate architecturally sound. W1-v406 (status:.\*completed false positive) is the highest risk item — recommend tightening before next production deploy.

## Issues Found (2026-04-01 Audit — v4.0.13 through v4.0.18)

High:

- WRITE_TOOLS set in fast-runner.ts has 11 phantom tool names and is missing 3 real ones. Phantom: gmail_reply, gmail_draft, gcalendar_create, gcalendar_update, gcalendar_delete, gdrive_upload, gdocs_create, gdocs_update, gslides_update, gtasks_update, gtasks_complete. Missing: calendar_create, calendar_update, gdocs_write. Hallucination guard Layer 2 blind to narrated calendar/docs writes (H1-v418)
- fullCount diagnostic in router.ts:193-204 missing SPECIALTY_TOOLS (5) and RESEARCH_TOOLS (8) — reports 93 instead of 101 when all env vars set. Neither array is imported in router.ts (H2-v418)

Warnings:

- Meta scope in scope.ts:335-346 does not add "commit_journal" group — diagnostic queries never include commit\_\_create_journal. All other groups are added (W1-v418)
- detectActiveGroups diverges from scopeToolsForMessage on follow-up messages (carry from C2-v3, W4-v406). Comment at line 400 says "same logic" — inaccurate. Eval harness uses detectActiveGroups, so eval results don't reflect production behavior for "Procede"-type messages (W2-v418)
- case-miner.ts W1-tel and W2-tel still open (research group missing, MISC_TOOLS unused import) from prior audit (W3-v418, carry)
- SPECIALTY_TOOLS import not in scope.test.ts — only chart_generate spot-checked, not the full array (W4-v418)
- Zero test coverage for detectActiveGroups function (carry from R3-S7) (W5-v418)

Standards:

- "28-50 tools per message" claim in README:399 — with COMMIT_READ always-on, baseline is now 32 (CORE_TOOLS 16 + MISC_TOOLS 16), so range is "32-101" (S1-v418)

Verdict: PASS WITH WARNINGS — 73 test files, 884 tests pass, typecheck clean. Guard stack fixes are correct and well-tested. COMMIT_READ always-on dedup is clean (no duplicates). Key risk: H1-v418 (WRITE_TOOLS phantom names) silently disables hallucination detection for 3 Google tool categories.

## Issues Found (2026-04-01 Audit — Tool Result File Eviction, 4d141ee + c9d97bc)

Warnings:

- data/tool-results/ has no cleanup — 40 files (1.1MB) accumulated in 15 min, unbounded growth (W1-evict)
- writeFileSync/mkdirSync have no try/catch — disk-full crashes lose the truncated result (W2-evict)
- process.cwd() is the only usage in src/ — fragile if service started from different dir (W3-evict)
- Double-eviction: web_read evicts, LLM calls file_read, adapter evicts same content again — 2x disk (W4-evict)
- TOC regex /^#{1,3}\s/ misses h4-h6 headings (W5-evict)
- web-read.ts Date.now() filename collision risk on parallel calls — adapter version uses toolCall.id, immune (W6-evict)

Standards:

- Zero test coverage for eviction logic in both files (S1-evict)
- Eviction logic copy-pasted between adapter.ts and web-read.ts — should extract shared util (S2-evict)

Verdict: PASS WITH WARNINGS — Architecturally sound fix for hallucination root cause. Unbounded disk growth and missing tests are primary risks.

## Issues Found (2026-04-01 Audit — v5.0 S1a, e7593ee)

Critical:

- consecutiveReadOnlyRounds NOT reset in RETRY_DIFFERENT/ESCALATE_MODEL escalation paths — analysis_paralysis re-triggers immediately, skipping escalation levels (C3-S1a)
- canonicalize() has no circular reference guard — exported public API, stack overflow on cyclic input (C1-S1a, low current risk)
- fingerprintCalls([]) and detectCycle with empty toolCalls produce degenerate hashes — false positive on empty arrays (C2-S1a, not reachable in current integration)

Warnings:

- textHashes and callResultPairs Maps grow unbounded within session — comment says "sliding window" but is accumulative (W1-S1a)
- Phantom detection false-positive: "email" bare substring + "sent " verb match on non-action sentences (W2-S1a)
- DELIVERY_TOOLS missing wp_raw_api, wp_plugins, wp_settings, file_write, file_edit (W3-S1a)
- FNV-1a degrades on non-BMP chars (W4-S1a, theoretical)
- console.log on every circuit breaker transition — should use pino logger (W5-S1a)
- repairSession Pass 4 won't insert synthetic error for corrupted-but-present tool results (W6-S1a)
- Doom signal severity field unused by escalation system — high-severity chanting wastes a round on RETRY_DIFFERENT (W7-S1a)

Standards:

- No afterEach(vi.restoreAllMocks) in any of the 4 new test files (S1-S1a)
- circuit-breaker.test.ts uses vi.useFakeTimers() inside tests without afterEach cleanup (S2-S1a)
- canonicalize(undefined) === canonicalize(null) — diverges from JSON semantics (S3-S1a, cosmetic)

Verdict: PASS WITH WARNINGS — 79 test files, 966 tests pass, typecheck clean. 4 new modules well-structured. C3 (missing counter reset) is highest-risk — causes escalation level skipping on analysis_paralysis triggers.

New files: src/inference/doom-loop.ts (24 tests), src/inference/escalation.ts (10 tests), src/inference/session-repair.ts (7 tests), src/lib/circuit-breaker.ts (10 tests), src/runners/write-tools-sync.test.ts (4 tests)

## Issues Found (2026-04-03 Audit — v5.0 S5b Knowledge Maps + file_delete, pre-fix: 26f2077)

Critical:

- force_refresh/stale regeneration does not delete old nodes — INSERT OR IGNORE silently drops new nodes with same sequential IDs. Map returns stale data despite LLM generating fresh content (C1-S5b) **FIXED in a5de2f2**
- nextNodeSeq uses COUNT(\*) not MAX(id suffix) — partial node deletion causes ID collisions, INSERT OR IGNORE drops new inserts silently (C2-S5b) **FIXED in a5de2f2**

Warnings:

- isStale checks created_at instead of updated_at — expanded maps incorrectly considered stale (W1-S5b) **FIXED in a5de2f2**
- searchMaps LIKE patterns don't escape % and \_ wildcard chars in keywords (W2-S5b, low risk)
- file_delete allows deletion of prefix roots themselves (/root/claude/, /tmp/) — no minimum depth check (W3-S5b) **FIXED in a5de2f2** (resolve() strips trailing slash so prefix roots can't match startsWith)
- file_delete not in DESTRUCTIVE_MCP_TOOLS — Levenshtein can fuzzy-match to it, autonomous tasks can execute without confirmation gate (W4-S5b)
- file_delete not covered by write-tools-sync.test.ts — CODING_TOOLS write tools have no sync coverage (W5-S5b)
- knowledge_nodes CASCADE + manual delete dual approach undocumented (W6-S5b)

Standards:

- Zero test coverage for file_delete tool (S1-S5b)
- knowledge_maps/knowledge_nodes DDL in db/index.ts instead of schema.sql — continues pattern from S1 (2026-03-24) (S2-S5b)
- EVOLUTION-LOG.md missing trailing newline (S3-S5b)

Verdict (pre-fix): PASS WITH WARNINGS — 86 test files, 1074 tests pass, typecheck clean.

## Issues Found (2026-04-03 Audit — v5.0 S5b Fix Verification, a5de2f2)

Fix verification:

- C1-S5b FIXED: deleteMap(mapId) called at knowledge-map.ts:232 before upsertMap+insertNodes. deleteMap explicitly DELETEs nodes then map (knowledge-maps.ts:131-138)
- C2-S5b FIXED: nextNodeSeq uses MAX(CAST(SUBSTR(id, LENGTH(?)+1) AS INTEGER)) at knowledge-maps.ts:238. Correct for "mapId/n-12" format
- W1-S5b FIXED: isStale reads map.updated_at at knowledge-maps.ts:65
- W3-S5b FIXED: resolve() strips trailing slashes so "/tmp/" → "/tmp" which doesn't match prefix "/tmp/". Root guard at lines 192-197 is defense-in-depth (unreachable for current prefixes)

New warnings:

- searchMaps generates unbounded AND LIKE clauses from task descriptions — 30+ word descriptions create 30+ conditions, effectively never matching any map. Planner/reflector integration is functionally broken for realistic tasks (W7-S5b)
- requiresConfirmation on file_delete is advisory-only (log.warn), no execution gate. Human-in-the-loop relies solely on LLM honoring tool description (W8-S5b)

Standards:

- PROJECT-STATUS source file count: 194 listed, actual 191 (S4-S5b)

Verdict: PASS WITH WARNINGS — 86 test files, 1074 tests pass, typecheck clean. All 4 prior fixes verified correct. W7 (searchMaps keyword explosion) makes planner/reflector map integration effectively non-functional for realistic task descriptions.

New files: src/db/knowledge-maps.ts (23 tests), src/tools/builtin/knowledge-map.ts (13 tests)

## Issues Found (2026-04-03 Audit — v5.0 S5c Research Verification)

Warnings:

- content_hash column always NULL — computed in extraction but stripped in executor/types, hardcoded null in orchestrator (W1-S5c)
- Missing afterEach(vi.restoreAllMocks) in reflector.test.ts — pre-existing, uses beforeEach(clearAllMocks) instead (W2-S5c)
- getMemoryService not mocked in reflector.test.ts — relies on try/catch fallback (W3-S5c)
- V5-ROADMAP.md S5c items still show "Planned" instead of "Done" (W4-S5c)
- URL regex excludes ) char — Wikipedia-style URLs truncated, misclassified as unverified (W5-S5c)
- Test/source file counts stale in V5-ROADMAP.md: shows 1074/86, actual 1097/88 (W6-S5c)

Standards:

- task_provenance DDL in db/index.ts not schema.sql — 5th table with this pattern (S1-S5c)
- console.warn in provenance.ts — consistent with Prometheus module pattern, not pino (S2-S5c)

Recommendations:

- R1: Test executor provenance extraction path (executor.ts:389-418)
- R2: Test orchestrator provenance persistence (orchestrator.ts:136-148)
- R3: Test classifySources URL deduplication
- R4: Test anchoring penalty edge cases (50% threshold, <3 sources)

Verdict: PASS WITH WARNINGS — 88 test files, 1097 tests pass, typecheck clean. Non-fatal design, parameterized SQL, optional types. content_hash dead column and missing afterEach are primary gaps.

New files: src/db/provenance.ts (7 tests), src/prometheus/provenance.ts (12 tests), +2 reflector tests

## Key File Locations (updated)

- Gmail tools: src/tools/builtin/google-gmail.ts
- File tools: src/tools/builtin/file.ts (file_read, file_write, file_delete)
- Knowledge maps DB: src/db/knowledge-maps.ts
- Knowledge map tools: src/tools/builtin/knowledge-map.ts
- MCP config: mcp-servers.json
- Video tools: src/tools/builtin/video.ts (6 tools)
- Video modules: src/video/ (composer, tts, images, subtitles, script-generator, types)
- Video schema: src/db/video-schema.ts

## Issues Found (2026-04-04 Audit — v5.0 S5d Video Production, 05ffcd4)

Critical:

- require("fs") in ESM module (composer.ts:136) — cleanupJob uses CommonJS require, violates project ESM-only rule (C1-S5d)
- SQL column interpolation without allowlist in updateJob (video.ts:50-57) — object keys injected into SQL string directly (C2-S5d)
- FFmpeg -vf subtitle path injection (composer.ts:114-117) — subtitleFile interpolated into filter string, colon/quote chars break syntax (C3-S5d)

Warnings:

- No concurrency limit on video jobs — unbounded parallel FFmpeg pipelines (W1-S5d)
- expires_at TTL never enforced, cleanupJob never called — /tmp/video-jobs grows unbounded (W2-S5d)
- FFmpeg 240s timeout may be insufficient for 120s@1080p on single-core VPS (W3-S5d)
- execFileSync blocks event loop — entire process unresponsive during renders (W4-S5d)
- updateJob throw inside .catch handler = unhandled rejection → process crash (W5-S5d)
- Pexels API requires auth — without PEXELS_API_KEY every image is solid-color fallback (W6-S5d)
- "video" scope pattern in specialty group (line 221) AND video group (line 277) — double activation, 11 extra tools (W7-S5d)
- "render" keyword in video scope false-positives on React rendering context (W8-S5d)

Standards:

- video_create (most complex tool) has zero test coverage (S1-S5d)
- src/video/ directory has zero test files — subtitles.ts and script-generator.ts are pure/testable (S2-S5d)
- All 6 tools return JSON instead of pre-formatted text (S3-S5d, per feedback_preformat_over_prompt.md)
- generateScript doesn't validate scene.duration > 0 — negative durations pass validation (S4-S5d)

Recommendations:

- R1: Remove unused resolution column or wire it to VIDEO_PROFILES
- R2: formatSrtTime Math.round can produce 1000ms — use Math.floor or clamp
- R3: tts.ts comment says "Primary: Gemini TTS" but Gemini code is absent
- R4: randomUUID().slice(0,8) collision on UNIQUE constraint would crash pipeline

Verdict: FAIL — 3 critical (ESM require, SQL interpolation, FFmpeg filter injection), zero test coverage on core modules, uncapped concurrency, dead TTL cleanup, event-loop-blocking subprocesses.

- Google tool source: src/tools/sources/google.ts
- Web read tool: src/tools/builtin/web-read.ts
- Eviction output: data/tool-results/
- Doom-loop detector: src/inference/doom-loop.ts
- Escalation ladder: src/inference/escalation.ts
- Session repair: src/inference/session-repair.ts
- Circuit breaker: src/lib/circuit-breaker.ts
- WRITE_TOOLS sync test: src/runners/write-tools-sync.test.ts
- Provenance DB CRUD: src/db/provenance.ts
- Provenance extraction/classification: src/prometheus/provenance.ts
- Google Drive tools: src/tools/builtin/google-drive.ts (6 tools, 592 lines, 0 tests)
- Google Docs/Sheets/Slides/Tasks tools: src/tools/builtin/google-docs.ts (7 tools, 754 lines, 0 tests)

## Issues Found (2026-04-03 Audit — Google Drive CRUD + S5c Integration)

Warnings:

- content_file parameter has no path restriction in gdrive_upload, gdocs_write, gdocs_replace — can read /etc/shadow or .env and upload to Drive (W1-GDRIVE)
- gdrive_upload, gdrive_move, gdocs_replace, gdocs_write missing requiresConfirmation: true — autonomous tasks can execute silently (W2-GDRIVE)
- gdrive_delete and gdrive_move not in DESTRUCTIVE_MCP_TOOLS — Levenshtein fuzzy-match can route to them (W3-GDRIVE)
- parentFolderId and query in gdrive_list have no input sanitization — single-quote injection in Drive query (W4-GDRIVE, low risk)
- gdrive_upload allows empty-string content when updating existing files (file_id present, no content) — silently blanks the file (W5-GDRIVE)

Standards:

- Zero test coverage for all 13 Google tools (1,345 lines) in google-drive.ts and google-docs.ts (S1-GDRIVE)
- PROJECT-STATUS.md metrics stale: reports 194/86/1076, actual 193/88/1097 (S2-GDRIVE)
- task_provenance DDL in db/index.ts not schema.sql — 6th table with this pattern (S3-GDRIVE, carry from S1 2026-03-24)

Recommendations:

- R1: Extract content_file resolution to shared utility with path validation (ALLOW_READ_PREFIXES)
- R2: Smoke tests for gdrive_upload multipart, gdrive_delete protected folder guard, gdrive_move body omission, gdocs_replace delete+insert, gdrive_list query construction
- R3: Sync DESTRUCTIVE_MCP_TOOLS with all requiresConfirmation:true tools (15 tools flagged, only 1 in set)
- R4: Add inverse test to write-tools-sync.test.ts — verify no phantom names in WRITE_TOOLS

Verdict: PASS WITH WARNINGS — 88 test files, 1097 tests pass, typecheck clean. WRITE_TOOLS sync correct. Stale loop signature fix sound. Primary risks: content_file unrestricted reads (W1), missing requiresConfirmation (W2), 1,345 lines untested (S1)

## Issues Found (2026-04-04 Audit — v5.0 S5+S6 session, 25 commits 8941d6f..2505bcb)

Session: Prompt enhancer, git tools, shell guard, Intel Depot activation, coding headroom, dead code cleanup, shutdown/crash handlers.

Critical:

- Shell injection in git_commit via $() and backtick in message arg — execSync double-quote escaping doesn't block command substitution (C1-0404)
- Shell injection in git_add via unsanitized file list join (C2-0404)
- Shell injection in git_diff via unsanitized `file` arg (C3-0404)
- Path traversal bypasses ALLOWED_CWD_PREFIXES — startsWith on raw path, no resolve() (C4-0404)
- Volume mount injection in container.ts — no host-path validation on new volumes option (C5-0404)
- Same shell injection in gh_create_pr title/body and gh_repo_create description — $() in double-quoted execSync (C1 variant)

High:

- hasFabricatedOutput regex in adapter.ts:1122 matches "error"/"failed"/"push"/"commit"/"creado" — extreme false-positive rate on legitimate first-round responses (H1-0404)
- Prompt enhancer infer() calls have no timeout/AbortController — can block handleInbound indefinitely (H2-0404)
- Scope pattern "commit" and "push" false-positive in non-coding English contexts (H3-0404)
- Alert delivery partial-delivery: markDelivered not transactional — broadcast succeeds but SQLite write can leave alerts unmarked (H4-0404)
- cancelTask recursive call inside transaction — subtask events emit before outer transaction commits (H5-0404, low practical risk due to better-sqlite3 savepoints)

Warnings:

- Prompt enhancer uses default provider, not cheap/flash tier as documented (W1-0404)
- Prompt enhancer state race — concurrent messages during LLM analysis can overwrite state (W2-0404)
- THREAD_RESPONSE_CAP 1600→3000 — thread buffer can reach 45K chars (~11K tokens) (W3-0404)
- MAX_ROUNDS_CODING 22→35, TOKEN_BUDGET_CODING 30K→50K — worst-case $2-15 per coding task (W4-0404)
- git_push rebase failure silently swallowed — leaves REBASE_IN_PROGRESS state (W5-0404)
- Shell guard git deny patterns bypassable with flag-before-subcommand (git -C path push) (W6-0404)
- appendDayLog read-modify-write non-atomic — safe for single-thread but fragile for future async (W7-0404)
- Intel adapters return [] for both HTTP errors and no-data — broken health tracking (W8-0404)
- formatChange division-by-zero: previous=0 gives pct=0 regardless of current (W9-0404)

Standards:

- gh_repo_create has zero test coverage (S1-0404)
- Prompt enhancer (231 lines) has zero test files (S2-0404)
- vi.clearAllMocks() in intel-tools.test.ts instead of vi.restoreAllMocks() (S3-0404)
- Dead code removal clean — no dangling imports for 4 deleted files (S4-0404, positive)
- FTS5 incremental backfill optimization correct (S5-0404, positive)

New files: src/messaging/prompt-enhancer.ts (0 tests), src/tools/builtin/git.ts (137 lines tests), src/intel/alert-delivery.test.ts (4 tests), src/tools/builtin/intel-tools.test.ts (7 tests), Dockerfile.nanoclaw, scripts/build-nanoclaw.sh, src/tuning/seed-cases.json (56 lines)

Deleted files: src/db/strategy-bullets.ts (clean), src/db/strategy-bullets.test.ts (clean), src/lib/db.ts (clean), src/lib/dispatch/idempotency.ts (clean), src/memory/bank-init.ts (clean)

Verdict: FAIL — 5 critical shell injection and path traversal vulnerabilities in new git tools. Fix required: replace execSync string interpolation with execFileSync array args, add path.resolve() to CWD validation, add volume mount path allowlist.

## Key File Locations (updated 2026-04-04)

- Git tools: src/tools/builtin/git.ts (6 tools, 403 lines)
- Prompt enhancer: src/messaging/prompt-enhancer.ts (231 lines, 0 tests)
- Intel scheduler: src/intel/scheduler.ts
- Intel adapters: src/intel/adapters/ (8 adapters)
- Intel signal store: src/intel/signal-store.ts
- Intel alert router: src/intel/alert-router.ts
- Intel alert delivery: src/intel/alert-delivery.ts
- Intel baselines: src/intel/baselines.ts
- Intel delta engine: src/intel/delta-engine.ts
- Container runner: src/runners/container.ts (new volumes option)
