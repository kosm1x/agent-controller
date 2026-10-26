# Archived index entries (moved 2026-10-25 from MEMORY.md "Older audits")

One line per audit, verdict + doctrine crumb; the topic files still live next to this file. Grep here by entry name.

- **Archived: 16 v6.x sprint audits (2026-04)** → [archived-v6-sprint-audits](archived-v6-sprint-audits.md) — grep for any v6.0/v6.2/v6.3/v6.4 sprint audit.
- **Archived: 20 audits 04-08 → 05-15** (CCP1-5, F7-F9, Google Workspace, security sweep, v7.3/v7.6, northstar, prompt-enhancer, sdk-wrapper, …) → [arch...
- [loop-unlimited-r1-audit](loop-unlimited-r1-audit.md) — 08-27: FAIL 2 Crit. A command shipped behind an adapter that drops every "/"-prefixed message.
- [authored_doc_citation_is_a_claim](feedback_authored_doc_citation_is_a_claim.md) — Auditing an authored doc that cites decision IDs or a sibling doc: open the cited file.
- [certified_skill_flake_budget](feedback_certified_skill_flake_budget.md) — S5 skill: a green certification is n=1 evidence; check latency headroom and LLM-judgment assertions.
- [skill_error_envelope_strike](feedback_skill_error_envelope_strike.md) — S5 skills: a body-level {"error":...} return is a wrong_output failure that burns a strike.
- [verification_claims_need_the_live_store](feedback_verification_claims_need_the_live_store.md) — "registered"/"deleted" claims must be checked vs the live store.
- [git-tests-inherit-hook-env](feedback_git_tests_inherit_hook_env.md) — tests spawning git in tmpdir repos must strip GIT_* env (pre-commit exports GIT_DIR).
- [open-items-41-42-r1-audit](open-items-41-42-r1-audit.md) - #41/#42 R1-R3 (09-24): R3 PASS. CLASS: a "since last pass" retry bound must be per-test.
- [sdk-confirmation-gate-r2-audit](sdk-confirmation-gate-r2-audit.md) - R2+R3 (09-30): PASS-W-WARN. CLASS: "inline code is literal" is per-formatter (WA strips `<tag>`).
- [forced-main-mutant-opens-live-db](feedback_forced_main_mutant_opens_live_db.md) - forced-main mutant opened live mc.db (operator gate passes in agent shells): export MC_DB_PATH=scratch first.

## September 2026 audits

- [skills-versioning-kb-file-r1-audit](skills-versioning-kb-file-r1-audit.md) - 09-24: R1 FAIL (new version inherited `is_certified`) -> R2 PASS.
- [skills-autocert-monotonic-r1-audit](skills-autocert-monotonic-r1-audit.md) - 09-24: R1 FAIL -> R2 PASS-W-WARN. Every pointer move must reset is_certified.
- [scope-miss-blocked-path-r1-audit](scope-miss-blocked-path-r1-audit.md) - 09-24: PASS-W-WARN. CLASS: stream finalize() never rejects, so `.catch(sendFresh)` is dead.
- [scope-miss-blocked-path-r2-audit](scope-miss-blocked-path-r2-audit.md) - 09-24: PASS-W-WARN. CLASS: a no-op branch turned into a send duplicates a non-idempotent 2nd call.
- [web-read-tweet-r1-audit](web-read-tweet-r1-audit.md) - 09-25: R1 PASS-W-WARN -> R2 PASS-W-NOTES. CLASS: new branch before execute()'s try skips Jina fallback.
- [rss-direct-feed-parse-r1-audit](rss-direct-feed-parse-r1-audit.md) - 09-25: FAIL. CLASS: lazy `[\s\S]*?` /g regex is O(n^2) on UNCLOSED openers.
- [rss-direct-feed-parse-r2-audit](rss-direct-feed-parse-r2-audit.md) - 09-25: PASS-W-WARN. CLASS: a charset decoder must let the BOM beat a contradicting header.
- [wer-journal-w39-wording-r1-audit](wer-journal-w39-wording-r1-audit.md) - 09-26: PASS-W-NOTES. Latent: 2026 has ISO W53; prevWeek=52 hardcode breaks at 2027-W01.
- [vlcms-project-detect-r1-audit](vlcms-project-detect-r1-audit.md) - 09-26: PASS-W-NOTES. CLASS: a check hoisted above a first-match loop steals from EVERY slug.
- [entity-extractor-registry-slugs-r1-audit](entity-extractor-registry-slugs-r1-audit.md) - 09-26: R1 PASS-W-WARN -> R2 PASS. CLASS: single-word routing aliases ~all FP.
- [docs-refresh-2026-09-26-r1-audit](docs-refresh-2026-09-26-r1-audit.md) - 09-26: PASS-W-WARN. CLASS: header figure refreshed, DERIVED figures left stale.
- [codie-checklist-en-r1-audit](codie-checklist-en-r1-audit.md) - 09-26: PASS-W-WARN. Harness: stub createTransport+fetch; page vs email lever labels drift.
- [sonnet-tier-benchmark-r1-audit](sonnet-tier-benchmark-r1-audit.md) - 09-29: FIX FIRST. CLASS: a DB snapshot does not isolate upsertFile (FS + pgvector + Drive sinks).
- [sonnet-env-canary-r1-audit](sonnet-env-canary-r1-audit.md) - 09-29: PASS-W-WARN. CLASS: env on the exported CONSTANT moves explicit-model callers.
- [jev-long-run-slug-r1-audit](jev-long-run-slug-r1-audit.md) - 09-29: R1 FAIL -> R2 PASS-W-WARN. CLASS: score an egress loosening on the LIVE .env key population.
- [denue-advisory-noninteractive-r1-audit](denue-advisory-noninteractive-r1-audit.md) - 09-29: PASS-W-WARN. CLASS: `top \d+` fired on 5 rituals daily.
- [denue-advisory-noninteractive-r2-audit](denue-advisory-noninteractive-r2-audit.md) - 09-29: PASS-W-WARN. CLASS: exact-map risk lookup trusts the recorded name form.
- [denue-guard-literal-r1-audit](denue-guard-literal-r1-audit.md) - 09-29: PASS-W-WARN. CLASS: msg.text embeds file content; runToolContext Set is per-SESSION.
- [run-schedule-tool-r1-audit](run-schedule-tool-r1-audit.md) - 09-29: PASS-W-WARN. CLASS: requiresConfirmation enforced only on the openai path.
- [denue-guard-literal-r2-audit](denue-guard-literal-r2-audit.md) - 09-29: PASS-W-WARN, 7/7 RED. CLASS: cross-module marker literal unpinned by any test.
- [jme-full-audit-2026-09-30](jme-full-audit-2026-09-30.md) - 09-30: FAIL 3 Crit. CLASS: ORDER BY ts without id tiebreak reverses same-ms turn pairs.
- [jme-hardening-r2-audit-2026-09-30](jme-hardening-r2-audit-2026-09-30.md) - 09-30: FAIL 1 Crit. CLASS: supersede inheriting the INCOMING TTL downgrades a permanent row.
- [jme-hardening-r3-audit-2026-09-30](jme-hardening-r3-audit-2026-09-30.md) - 09-30: FAIL 1 Crit. CLASS: refresh-on-skip + max(confidence) launders echo wording.
- [jme-hardening-r4-audit-2026-09-30](jme-hardening-r4-audit-2026-09-30.md) - 09-30: PASS-W-NOTES, 7/8 RED. CLASS: max-conf inheritance launders only where confidence is a CLASS.
- [jarvis-pull-task-seam-r1-audit](jarvis-pull-task-seam-r1-audit.md) - 09-30: FAIL 1 Crit. CLASS: "no private memory" kept always-read KB + unscoped jarvis_file_*.
- [jarvis-pull-task-seam-r2-audit](jarvis-pull-task-seam-r2-audit.md) - 09-30: FAIL 1 Crit. CLASS: allow-tree-minus-denies policy leaked divorce/health rows.
- [jarvis-pull-task-seam-r3-audit](jarvis-pull-task-seam-r3-audit.md) - 09-30: FAIL 1 Crit (data). CLASS: leak moved to a whole-tree SEED.
- [jarvis-pull-task-seam-r4-audit](jarvis-pull-task-seam-r4-audit.md) - 09-30: PASS-W-WARN, 8/8 RED. CLASS: routerRoot = reply route, not operator watching.
