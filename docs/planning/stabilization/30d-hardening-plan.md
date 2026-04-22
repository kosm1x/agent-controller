# 30-Day Hardening & Stabilization Plan

> **Window**: 2026-04-22 → 2026-05-22
> **Baseline**: `docs/benchmarks/2026-04-22-baseline.md`
> **Freeze**: No new features during this window. Only hardening, credentials, stabilization.
> **Exit criteria**: All P0 items closed, P1 items triaged (fixed or deferred with explicit trigger), full system audit report filed, re-benchmark shows no regression and measurable improvement on at least efficiency + resilience dimensions.

---

## Scope — what is in / out

**IN scope**

- Bug fixes on known issues (see baseline "Known issues")
- Credential rotation + provisioning (unlock credential-gated v7.3 P4b/P4c + v7.4 S2b work **post-window**)
- Session stabilization (recurring errors, auto-recovery, observability gaps)
- Observability fixes (cost_ledger mislabel, image-existence warnings, etc.)
- Test coverage for paths currently un-tested (e.g., Docker runners' SDK branch now exists; integration-level coverage for claude-sdk path)
- Dependency audit + patch updates (no major-version bumps)
- Documentation: CLAUDE.md invariants, runbooks for recovery scenarios

**OUT of scope**

- New tools
- New runners or runner modes
- New scheduled tasks (other than stabilization-related)
- New feature verticals (F10, v7.5.1, v7.6 deferrals — all wait)
- Upstream-repo pattern adoption (sweep still fires weekly but findings queue for post-window)

---

## P0 — must close this window

| #    | Item                                                                                                                                                                                                                                                                            | Owner             | Est                | Trigger to promote                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------ | ---------------------------------------------------------------------- |
| P0-1 | **Telegram polling 409 Conflict flap** — identify the other poller (dev laptop? forgotten script? rotated bot?) and shut it down or rotate token. Verify `/health.messaging.telegram=true` sustained >24h.                                                                      | Operator          | 1h                 | 138 flaps/day burning auto-recover cycles; intermittent unavailability |
| P0-2 | **cost_ledger model label correctness** — `dispatcher.ts::getModelFromTask()` should branch on `cfg.inferencePrimaryProvider` → `"claude-sonnet-4-6"` vs `cfg.inferencePrimaryModel`. Update pricing table. Re-verify `/health` daily-spend number reflects real Sonnet volume. | Claude            | 1 session          | Observability gap. Budget alerts are 20–50x understated.               |
| P0-3 | **Heavy-runner in-process 31% failure rate investigation** — 26/83 failed over 30d. Pull `tasks` rows where `agent_type='heavy'` + `status='failed'`, categorize error strings, decide fix-or-accept per class.                                                                 | Claude            | 0.5 session        | Baseline's unexplained number.                                         |
| P0-4 | **Runner startup image-existence check** — emit `[runner] configured image '<tag>' NOT PRESENT, containerized path will fail` warning at boot for `heavyRunnerImage`, `nanoclawImage`. Same class of bug masked nanoclaw's 97% fail for 30d.                                    | Claude            | 0.3 session        | Session 100 pattern 2.                                                 |
| P0-5 | **Credential rotation — audit & rotate** — sweep `.env` for long-lived keys; rotate any that are >90 days old or exposed in past sessions; document rotation playbook in `docs/runbooks/credential-rotation.md`.                                                                | Operator + Claude | 2h                 | Security hygiene. Blocker for P4b/P4c/S2b prep.                        |
| P0-6 | **Credential provisioning — v7.3 P4b/P4c + v7.4 S2b** — obtain & store (outside repo) Meta Marketing API + Google Ads API + TBD video-gen credentials. NOT to ship the features during freeze; just provision so day-31 work is unblocked.                                      | Operator          | 2-4h across window | Roadmap blocker per V7-ROADMAP.md                                      |

## P1 — should close this window

| #    | Item                                                                                                                                                                                                                                                               | Est          | Notes                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| P1-1 | v7.9 deferred follow-ups (M1-M3, W2-W4, W7) — 7 items, all on the low-traffic SDK path. Classify which are now relevant now that Sonnet is primary across all paths.                                                                                               | 1-2 sessions | `feedback_v79_deferred_followups.md`. Expect 3 to become P0-adjacent (tokenBudget, provenance, circuit breaker bypass). |
| P1-2 | Integration tests for claude-sdk path in Prometheus + containerized runners — currently only mocked unit tests exist. Run against a mocked Anthropic endpoint or VCR fixtures.                                                                                     | 1 session    | v7.9 W3 in practice.                                                                                                    |
| P1-3 | Playwright MCP ToolSource wrapper (v7.6.1) — IF the audit shows scope-gating is leaking non-browser sessions into loading 21 browser tool schemas. Gate on audit evidence, don't ship speculatively.                                                               | Medium       | Conditional on audit                                                                                                    |
| P1-4 | Allowlist + SSRF audit sweep across all browser-adjacent tools — `screenshot_element`, `web_read`, `web_search`, `video_html_compose`, any tool that calls `page.goto()` or makes outbound HTTP. Confirm each has `validateOutboundUrl()` on user-controlled URLs. | 0.5 session  | Security dimension of audit will surface; don't wait.                                                                   |
| P1-5 | Dependency patch sweep — `npm outdated` → apply patch-level updates for `playwright`, `@anthropic-ai/claude-agent-sdk`, `better-sqlite3`, `hono`, MCP SDK. No major bumps. Re-run full test suite after each batch.                                                | 0.5 session  | Routine hygiene.                                                                                                        |
| P1-6 | `mc-pre-ns-sync.db` (184 MB backup from session 90) — NS sync has been clean for ~36h at snapshot. By day-7 of freeze, safe to drop.                                                                                                                               | 5 min        | Disk recovery ~184 MB.                                                                                                  |
| P1-7 | Circuit breaker state visibility on SDK path — W4 from v7.9. Ensure SDK failures update the same provider-health tracker fast-runner uses.                                                                                                                         | 0.5 session  | Partial block on containerized paths if Anthropic hiccups.                                                              |
| P1-8 | Docker image rebuild discipline — add `./scripts/build-mission-control-image.sh` that runs the build, then a quick smoke of the two workers. Wire into a weekly cron (e.g., after upstream-ref sweep). Prevents silent drift between source and image.             | 0.3 session  | Session 100 rebuild was manual. Automate.                                                                               |

## P2 — triage (decide fix or defer during window)

| #    | Item                                                                                                                                                                                                                                   |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-1 | Timer: v7.5.1 trigger-check results (fires 2026-04-27 first). If any trigger fires, promote the corresponding item to P1 for this window.                                                                                              |
| P2-2 | Session 99-100 memory-file lint: some feedback files may be stale post-fix (e.g., `feedback_v79_deferred_followups.md` claims M1-M3 would be folded into v7.5 — didn't happen). Sweep + update `lastReviewed:` dates.                  |
| P2-3 | Runtime tool coverage audit — are any builtins defined but never routed? Any MCP tools declared but never registered? Prune dead surface.                                                                                              |
| P2-4 | `/tmp/*` cleanup automation — add to the existing weekly ref-sweep task: clean stale repo clones + analysis dirs older than 14 days.                                                                                                   |
| P2-5 | Docker builder cache pruning — 2 GB cache entries are "in use" by current images and not reclaimable by `docker builder prune`. Investigate whether they can be cleaned via `docker buildx prune --all` without affecting live images. |

---

## Stabilization sessions — recurring incidents to eliminate

Catalog what's been wobbly and the stabilization target.

| Incident class                        | Signal                                                             | Target state by day-30                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Telegram polling flap                 | 138×/day at baseline                                               | 0 flaps/day (P0-1)                                                                                        |
| Deferred-WP-tool friction             | Multi-turn degradation on WP-scoped tasks without explicit trigger | Scope regex retuned or auto-activation on URL presence (see `feedback_llm_content_laundering_pattern.md`) |
| `error_max_turns` hits on batch tasks | Truncated partial responses                                        | Either lift ceiling for batch scope OR chunk batch into subtasks at classifier                            |
| Heavy-runner in-process failures      | 31% fail rate                                                      | <10% after P0-3 root-cause classification                                                                 |
| Cost-ledger mislabel                  | All Sonnet calls written as qwen                                   | Correct model string per call (P0-2)                                                                      |
| Missing image on runner boot          | Silent 97% fail for 30d before we noticed                          | Startup warning + doc'd recovery (P0-4)                                                                   |

---

## Credentials work — explicit list

(Populate during P0-5 audit. Do not commit the credentials themselves; commit only the list of what's needed + storage location.)

Known gaps from V7-ROADMAP:

- **Meta Marketing API** (v7.3 P4b): app + access token + ad account IDs
- **Google Ads API** (v7.3 P4b): OAuth refresh token + customer ID + developer token
- **Video-gen** (v7.4 S2b): TBD provider (maybe Kling, Runway, or similar) — credential path undecided

Known rotations due:

- Any API key >90 days old (audit during P0-5)
- Claude Code credentials file (`~/.claude/.credentials.json`) — check session token age; rotate if >60d

---

## Success metrics at day-30

Re-benchmark on 2026-05-22 should show:

| Metric                              | Baseline (2026-04-22) | Target                           |
| ----------------------------------- | --------------------- | -------------------------------- |
| Tests passing                       | 3711                  | ≥3711 + new integration coverage |
| Type errors                         | 0                     | 0                                |
| Nanoclaw fail rate (if any traffic) | 96.8% (image missing) | <10%                             |
| Heavy fail rate                     | 31.3%                 | <10%                             |
| Telegram flaps/day                  | 138                   | 0                                |
| cost_ledger model label accuracy    | wrong (all qwen)      | correct per provider             |
| Deferred v7.9 items                 | 7 open                | ≤4 open (3 folded in)            |
| `/health.messaging.telegram` uptime | intermittent false    | sustained true                   |
| Disk used                           | 72 GB (75%)           | ≤65 GB (68%) via P1-6 + P2-4     |
| Runner image-existence warnings     | none                  | present for both runners         |

---

## Branch discipline during the window

- All changes on `main` (trunk-based). No feature branches.
- Commits tagged `fix(...)`, `chore(...)`, `refactor(...)`, `docs(...)`, `test(...)`, `perf(...)`. No `feat(...)` until day-31.
- Every commit must pass `npm run typecheck && npm test` pre-push.
- Self-audit round-1 required before merge for any change touching runtime behavior.
- Double audit (2-round) required for anything touching security, auth, or container boundaries.
