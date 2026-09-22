# Agent-controller five-dimension audit — 2026-09-22

Multi-agent read-only audit (performance · memory · context · security · speed), one finder + one adversarial verifier per dimension (10 agents, workflow `wf_16f04fb8-9b3`). 38 findings: 36 confirmed, 1 refuted (overnight tuning — already disabled since 09-18), 1 uncertain (heavy reflect on Opus).

## Baseline (7 d to 2026-09-22, HEAD `94a7dfe`, PID 515719)

| Metric | Value |
| --- | --- |
| fast runner | 245 tasks, $101.77, 282.5k prompt tok/task (cumulative over ~10 turns; includes cache read 233.6k + creation 48.9k), p50 34 s, p90 114 s, max 770 s |
| heavy runner | 13 tasks, $29.59, 466.9k prompt tok/task (39 % creation), p50 130 s, p90 354 s |
| fast cost split | cache writes ≈ 70 % of fast spend (1 h TTL) → prefix stability is the main cost lever |
| pre-submit wait | ≈ 4 s per enriched chat turn (pgvector leg waits for LLM query expansion) |
| event-loop stalls | 23–26 s at 08:30 UTC Tue/Thu/Sat (consolidation VACUUM); 68 five-minute windows > 1 s |
| process | RSS 324 MB (7 d max 425 MB), heap 70–150 MB, no monotonic growth |
| DB | 384 MB; `runs.input` duplicates `tasks.description` (≈ 57 MB); 89 % of embeddings unreachable by recall (≈ 54 MB) |
| deps | `npm audit --omit=dev`: 2 critical, 12 high, 6 moderate |

`cost_ledger.prompt_tokens` = input + cache_creation + cache_read (claude-sdk.ts writes it that way), cumulative per SDK query.

## Batches

**A — security hardening (code only, no prompt change).**
1. `file_read` path guard: refuse `/proc/{self,thread-self,<pid>}[/task/<tid>]/{environ,mem,cmdline,auxv}`; block `/etc/opensandbox/`, `/root/.claude.json`, `/root/.docker/` (critical).
2. `shell_exec`: redact stdout/stderr before they return to the model; refuse any token holding both `/proc/` and `environ`.
3. `video_background_download`: name allow-list regex, resolved-URL SSRF check, curl `--proto =http,https`, `--` before the URL.
4. MCP bridge: DNS-resolved URL validation (localtest.me → ::1 bypass).
5. `/dashboard/:id`: CSP sandbox header + function replacers with `<` escaped.
6. `/docs/raw/:file` and `/docs/*`: private-or-API-key auth; drop `Cache-Control: public`.

**B — performance / memory (code only).**
7. Remove the consolidation VACUUM + FTS rebuild; set `journal_size_limit`.
8. Signal pruner: boot-relative `setInterval` → `scheduleCron` (29 restarts/7 d meant it almost never ran).
9. Fast-runner heartbeat interval leak on the early return / throws before the `try`.
10. `runs.input`: store title + description length, not a second copy of the prompt.
11. Thread buffer: drop `imageUrl` from the previous entry (only the last is ever re-injected).

**A + B status (2026-09-22):** implemented, all fixes mutation-pinned. R1 qa (3 lenses) folded: C1 `file_write content_file` + the `grep` tool (rg absent → `grep -r` fallback) both bypassed the read denylist → guarded + output redacted; C2 curl `-L` followed redirects to loopback → direct downloads now use `safeFetch` (per-hop validation, pinned DNS), yt-dlp host-allow-listed; scheme-less URL args validated as `https://…` (tab/LF stripped; short bare integers exempt, IP literals not); dashboard single-pass fill; R2 C1: a DIRECTORY path passed the guard, so `grep` now filters every output record by its file (`--null`, exact NUL parse) and `--include` precedes the credential excludes (R1 had silently disabled `include_glob`); R3: the guard also checks the raw (untrimmed) spelling's symlink target; `/etc/shadow-`/`/etc/gshadow-` blocked; yt-dlp `--use-extractors default,-generic`; direct downloads capped at 500 MB; watchdog `VACUUM INTO` hint carries the FTS rebuild. Queued residuals: echarts `tooltip.formatter` HTML (contained by the CSP sandbox; page can still self-redirect); shell redaction name rule misses `X_AUTH_TOKEN__…`/`*PASSPHRASE`/encoded output; `/dashboard/:id` route shadows the SPA assets (`/dashboard/app.js` 404, pre-existing); existing `runs.input` rows (3,361, 59 MB) drain via 90-day retention.

**C — context + latency (changes what the model sees → `npm run eval:gate -- --run` first, needs spend approval; KB qualifier edits are operator `mc-ctl db`).**
- context-01 essentials block → variable (`cacheable: false`); context-02 INDEX.md volatile header/`Recientes` out of the stable block; context-03 agent-controller README always-read → conditional/head-only; context-04 skip the `[DEFERRED TOOLS]` text catalog on the SDK path + un-defer the 5 most-searched tools. Combined estimate: 21–35 % of fast calls reuse a ~35k-token prefix, ≈ $6–17/wk, plus fewer ToolSearch rounds.
- speed-01 pgvector recall stops waiting on query expansion (≈ 3 s per enriched turn); speed-02 pass `readOnlyHint` so parallel read-only tool calls run concurrently (≈ 9–10 min/wk, 5–20 s on research turns).

**C status (2026-09-22):** shipped `af960d1` (context-01, 02, 04, speed-01, 02). `eval:gate --run` PASS 69.10 vs incumbent 68.35 (+0.75, $5.64); `validate-tool-search --run` PASS (31 core / 119 deferred, retrieval + seal OK, $0.62). qa R1 FAIL folded: C1 browser `goto`/`navigate` are READ_ONLY in `src/mcp/annotations.ts` but change the page, so speed-02 would have run them beside a same-response read (10 of 57 goto→read pairs in 30 d were one response) → concurrency is decided in `runsConcurrently()` (builtin only, not MCP-bridged, not `gdrive_download`), the Rule-of-Two annotation untouched; W2 the pgvector leg logs `N hits in X ms` / `timed out (1500 ms)`. R2 PASS WITH NOTES; 12 mutants RED; 9,230 tests. context-02 took option (b) (INDEX.md content without counts/date/Recientes). context-03 is the operator step `./mc-ctl db "UPDATE jarvis_files SET qualifier='reference' WHERE path='projects/agent-controller/README.md'"` — the README is still injected when a message names agent-controller (`detectProjectInMessage`); a conditional qualifier would only reach the 8,000-char pointer. The head-only code hardening was NOT done (qa C1 2026-09 found a head-only cut froze a stale snapshot). context-05 (heavy executor split) not in C, queued. Residuals: `scripts/eval-gate.ts` opens the live `mc.db`, and the `jarvis-fs` boot hook rewrites INDEX.md from the working source on every gate run (its header claims read-only); the 1500 ms pgvector timer is never cleared (harmless); INDEX lists `[[/|]]` and junk dirs `a`/`p` from 3 rows with a leading `/`.

**D — operator / follow-up.**
- Dependency updates (stop mission-control first): hono, @hono/node-server, ws, sharp 0.35.x, protobufjs chain.
- Embedding retention (keep newest 2× recall window per bank) vs int8 quantization — operator choice.
- `jarvis_dev` gate: tsc ∥ vitest, vitest scoped to the diff (the 770 s outlier).
- Tracing: heavy-runner per-turn trace, tool execution time in trace events, per-job cron duration.
- `ANALYZE`/`PRAGMA optimize`, `tasks(created_at)` index, pm_signal_weights retention, kb-backup unchanged-skip, JME recall into the parallel batch, rule-of-two for ordinary runs, raw-args audit-log redaction, email SPF/DKIM (latent).

Full per-finding evidence: workflow journal `wf_16f04fb8-9b3` (session transcript dir).
