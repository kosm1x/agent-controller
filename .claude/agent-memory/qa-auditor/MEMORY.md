# QA Auditor Memory Index

> One line per entry: link + date + verdict + one doctrine crumb. Full detail lives in each topic file — Read the file, don't inline paragraphs here.
> Retention: hooks ≤180 chars. Never inline a paragraph. Cap ~17KB.
> Full pre-trim hooks (2026-10-03): `archived-index-2026-10-03.md` — grep it by entry name.

## Project Knowledge

- [six-item-queue-2026-10-07-r1-audit](six-item-queue-2026-10-07-r1-audit.md) - 10-07: FAIL 1 Crit. CLASS: schema-head bump pinned in a SIBLING test + deploy.sh gate; eval probe blind to STATUS_SUFFIX.
- [grader-item11-be-r2-audit](grader-item11-be-r2-audit.md) - 10-06: R1 + R2 both PASS-W-WARN, 0 Crit. CLASS: a "never rejects" promise needs a timer callback that cannot throw before resolve().
- [grader-item11-be-r1-audit](grader-item11-be-r1-audit.md) - 10-06: PASS-W-WARN. CLASS: a nonce fence covers only the sections it wraps (provenance unfenced).
- [flywheel-pin-displacement-r1-audit](flywheel-pin-displacement-r1-audit.md) - 10-04: PASS-W-WARN, 5/7 RED. CLASS: oldest-first over a batch insert is id order in disguise; miner DISARMED.
- [cb-probe-token-inbound-deadline-r2-audit](cb-probe-token-inbound-deadline-r2-audit.md) - 10-04: PASS-W-WARN, 6/6 RED. CLASS: outer deadline over a stage with its own env budget couples the knobs.
- [cb-probe-release-r1-audit](cb-probe-release-r1-audit.md) - 10-04: PASS-W-WARN, 7/7 RED. CLASS: an unjudged probe release has no OWNER; a non-holder can release another's probe.

- [pm-archive-error-re-r1-audit](pm-archive-error-re-r1-audit.md) - 10-04: PASS-W-WARN. CLASS: a negation lookbehind with `\s+` crosses NEWLINES ("0/0/0\nError:" suppressed).

- [concern-detail-v7-r1-audit](concern-detail-v7-r1-audit.md) - 10-04: PASS-W-WARN, 3/4 RED. CLASS: a note→take map before a SYNC emit; note-after-emit mutant survived.
- [kb-mirror-live-db-gate-r1-audit](kb-mirror-live-db-gate-r1-audit.md) - 10-04: PASS-W-WARN. CLASS: a default-dir write must be keyed to the LIVE db identity (realpath), uncached.

- [v9-w1-grader-gate-r3-audit](v9-w1-grader-gate-r3-audit.md) - 10-04: R1 7W -> R2 4W -> R3 PASS-W-NOTES (r1-r3 files). CLASS: lexical ban atop EXPLAIN adds only false rejects.
- [landscape-review-1-r2-audit](landscape-review-1-r2-audit.md) - 10-03: PASS-W-WARN, R1 C1+W1-W8 closed; W6 force-add at commit.
- [landscape-review-1-r1-audit](landscape-review-1-r1-audit.md) - 10-03: FAIL 1 Crit, 8 Warn. CLASS: "now counts as no decision" is new only if the OLD path differed for us.
- [numbers-zero-bytes-exempt-r1-audit](numbers-zero-bytes-exempt-r1-audit.md) - 09-23: PASS-W-WARN. CLASS: "unverifiable so exempt" must be checked vs EVERY consumer's pass path.
- [perf-sec-followups-r4-audit](perf-sec-followups-r4-audit.md) - 09-22: PASS, 3/3 RED. CLASS: vi.mock("node:fs") hits a sibling's `from "fs"`; a missing export THROWS.
- [perf-sec-followups-r3-audit](perf-sec-followups-r3-audit.md) - 09-22: FAIL 1 Crit. CLASS: validator realpaths the RAW spelling, writer uses resolve(raw).
- [perf-sec-followups-r2-audit](perf-sec-followups-r2-audit.md) - 09-22: FAIL 2 Crit. CLASS: catch-all NAME=\S+ callback lets a non-secret CONSUME the next secret.
- [perf-sec-followups-r1-audit](perf-sec-followups-r1-audit.md) - 09-22: FAIL 2 Crit. CLASS: dangling-link follower resolving a RELATIVE target lexically re-opens the escape.
- [perf-batch-c-r1-audit](perf-batch-c-r1-audit.md) - 09-22: R1 FAIL -> R2 PASS-W-NOTES. CLASS: a RISK annotation (readOnlyHint) fed to the CLI SCHEDULER.
- [perf-sec-batchAB-r4-audit](perf-sec-batchAB-r4-audit.md) - 09-22: PASS-W-WARN. rg is NOT on the service PATH (prod = grep 3.11).
- [perf-sec-batchAB-r3-audit](perf-sec-batchAB-r3-audit.md) - 09-22: PASS-W-WARN. CLASS: a by-example exemption (`"10"`) exempts attack spellings of its shape.
- [perf-sec-batchAB-r2-audit](perf-sec-batchAB-r2-audit.md) - 09-22: FAIL 1 Crit. CLASS: a denylist on a recursive reader's ROOT guards only the root.
- [perf-sec-batchA-r1-audit](perf-sec-batchA-r1-audit.md) - 09-22: FAIL 2 Crit. CLASS: a read-block list is only as strong as the UNGUARDED sibling reader.
- [perf-sec-batch-b-r1-audit](perf-sec-batch-b-r1-audit.md) - 09-22: PASS-W-NOTES. CLASS: removing a VACUUM also removes its paired FTS rebuild.
- [jev-readout-harness-r2-audit](jev-readout-harness-r2-audit.md) - 09-22: PASS-W-WARN. CLASS: a "never" in a doc comment is a claim about EVERY producer branch.
- [jev-readout-harness-r1-audit](jev-readout-harness-r1-audit.md) - 09-22: FAIL 2 Crit. CLASS: a joined diagnostic column measures a DIFFERENT text than its label.
- [jev-shadow-consumers-r4-audit](jev-shadow-consumers-r4-audit.md) - 09-21: FAIL 1 Crit, 6/20 mutants survived. CLASS: an UPSTREAM cut in another subsystem the hook inherits.
- [jev-shadow-consumers-r3-audit](jev-shadow-consumers-r3-audit.md) - 09-21: FAIL 1 Crit. CLASS: a fixed-offset `.slice()` IS a rewrite — it cuts the label.
- [jev-scope-classifier-r1-audit](jev-scope-classifier-r1-audit.md) - 09-21: PASS-W-WARN, 3/12 mutants survived. CLASS: a constant consumed by its OWN fixture.
- [jev-scope-chain-r1-audit](jev-scope-chain-r1-audit.md) - 09-21: FAIL 3 Crit. CLASS: a line-oriented redactor over a value carrying its own `\n`.
- [jev-scope-replay-r2-audit](jev-scope-replay-r2-audit.md) - 09-21: PASS-W-WARN. CLASS: a self-test printing the same `PASS` + exit 0 as the real verdict.
- [jev-scope-replay-r1-audit](jev-scope-replay-r1-audit.md) - 09-21: FAIL 2 Crit. CLASS: the VERDICT function was the one untested path; errors censored.
- [ritual-boot-retry-arm-r1-audit](ritual-boot-retry-arm-r1-audit.md) - 09-19: PASS-W-WARN. CLASS: a boot-time re-arm is only as safe as the MARKER it reads.
- [notification-warning-consumer-r1-audit](notification-warning-consumer-r1-audit.md) - 09-19: PASS-W-WARN. CLASS: a LINE-ANCHORED sanitizer is a no-op on a one-line alert.
- [kb-conditional-heavy-r1-audit](kb-conditional-heavy-r1-audit.md) - 09-19: PASS-W-WARN, 1 Crit (data). CLASS: a NULL `condition` row matches...
- [weekly-polygon-stitch-r2-audit](weekly-polygon-stitch-r2-audit.md) - 09-18: PASS-W-WARN. CLASS: `INSERT OR REPLACE` safe only after proving nobody holds the row IDENTITY.
- [weekly-polygon-stitch-r1-audit](weekly-polygon-stitch-r1-audit.md) - 09-18: FAIL 1 Crit. CLASS: an EMPTY provider response is not an error.
- [dbbars-session-dedupe-r1-audit](dbbars-session-dedupe-r1-audit.md) - 09-18: PASS-W-NOTES. CLASS: a `LIMIT` whose unit changed ROWS->SESSIONS re-prices count freshness.
- [polygon-bar-window-r1-audit](polygon-bar-window-r1-audit.md) - 09-18: PASS-W-NOTES. CLASS: a provider `limit` can cap a DIFFERENT UNIT than the caller's.
- [v84-stop-hook-allowed-event-r1-audit](v84-stop-hook-allowed-event-r1-audit.md) - 09-18: PASS-W-NOTES. CLASS: "closes the blind spot" vs the population that REACHES the code.
- [dream-rsi-phase0-probe-r2-audit](dream-rsi-phase0-probe-r2-audit.md) - 09-18: R2 FAIL 3 Crit -> R3 PASS. CLASS: mirroring a producer's INDEX rule is not mirroring its BASE.
- [dream-rsi-phase0-probe-r1-audit](dream-rsi-phase0-probe-r1-audit.md) - 09-18: FAIL 4 Crit. CLASS: an offline replay must score only what the policy can EMIT.
- [tuning-corpus-honesty-r1-audit](tuning-corpus-honesty-r1-audit.md) - 09-18: PASS-W-NOTES. CLASS: a guard on ONE writer does not cover the CORPUS.
- [kb-mirror-vitest-guard-r1-audit](kb-mirror-vitest-guard-r1-audit.md) - 09-18: FAIL 1 Crit. CLASS: a NEW fs call in a shared helper breaks PARTIAL fs mocks.
- [jme-phase4-r1-audit](jme-phase4-r1-audit.md) - 09-18: PASS-W-NOTES. CLASS: the "exported, tested, dead" defect moved from the function to its...
- [dep-trust-shell-gate-r16-audit](dep-trust-shell-gate-r16-audit.md) - 09-16: PASS-W-WARN. Open: `^[({]+` stripped once at SEGMENT HEAD, so `do (rm -rf build); done` ALLOWs.
- **Archived: dep-trust-shell-gate R13-R15 (09-16, all FAIL)** -> grep `dep-trust-shell-gate-r1[345]-audit.md`. Crumb: a span function is a GRAMMAR not an equality test.
- **Archived: dep-trust-shell-gate R3-R12 (09-16, R6 PASS-W-WARN, rest FAIL)** -> grep `dep-trust-shell-gate-r([3-9]|1[012])-audit.md`. Crumb: TOKENIZER is the attack surface.
- **Archived: dep-trust-shell-gate R1-R2 (09-16, both FAIL)** -> grep `dep-trust-shell-gate-r[12]-audit.md`. Crumb: a per-SEGMENT gate dies on anything that RE-ENTERS a shell.
- [agent-memory-t1-p1-r2-audit](agent-memory-t1-p1-r2-audit.md) - 09-16: PASS-W-WARN. A one-file exclusion fix missed its SIBLING reader 43 lines below.
- [skills-scope-group-r1-audit](skills-scope-group-r1-audit.md) - 09-13: PASS-W-WARN. Measured: 0 `skills` lines in 216 classifications/30d.
- [screenwriting-corpus-r2-audit](screenwriting-corpus-r2-audit.md) - 09-12: PASS-W-NOTES. SQLite `length()` counts CHARACTERS not bytes.
- **Archived: gate-settleable-expect R1/R1-lens-A/R2 · tool-desc-ratchet R1/R2 (09-12)** -> grep by name. Crumb: a write-time refusal is also READ-time when specs are STORED.
- **Archived: email-verify R2/R3/R5 · perf-usefulness · logic-sql · observability · sec-approvals (09-10→12, FAIL)** -> grep by name. Crumb: HOISTED phrase list inherits FPs.
- [security-batch-sec01-18-r4-audit](security-batch-sec01-18-r4-audit.md) - 09-10: FAIL 1 Crit. "Strictly additive" describes the CODE PATH, not the VERDICT.
- **Archived: security-batch SEC-01..18 R1–R3 (09-10, all FAIL)** → grep `security-batch-sec01-18-r[1-3]-audit.md`. Crumb: a per-rule sanitiser needs the PIPELINE receiver.
- [kb-citation-searchoutput-r3-audit](kb-citation-searchoutput-r3-audit.md) - 09-09: PASS-W-WARN. `matchSnippet` anchors on the EARLIEST token, the one the TITLE already matched.
- **Archived: kb-citation R1 · diag-four-fixes R1 · stuck-watchdog R2 · psql-flailing R1 (09-03→09-09)** → grep by name. Crumb: TEXT affinity is not a constraint (BLOBs).
- [diag-four-fixes-r2-audit](diag-four-fixes-r2-audit.md) - 09-06: PASS-W-NOTES, 3/3 RED. A substring keyword score has NO word boundary.
- [strategy-relay-guard-r11-audit](strategy-relay-guard-r11-audit.md) - 09-05: PASS-W-NOTES. Ten deny-list rounds lost; anchor BOTH ends (allow-by-shape).
- **Archived: strategy-relay-guard R1–R8 (09-05, deny-list → allow-by-shape)** → grep `strategy-relay-guard-r[1-8]-audit.md`. Crumb: JS `\b` is ASCII-only.
- [trustr-remote-deadend-r2-audit](trustr-remote-deadend-r2-audit.md) — 09-01: SHIP. Answer "did anchoring lose a shape?" with a printed OLD-vs-NEW table over real spellings.

- [sdk-bump-0-3-245-r1-audit](sdk-bump-0-3-245-r1-audit.md) — 09-01: PASS W/WARN. An `else if` chain with NO trailing `else` makes added stream frames inert.

- [nanoclaw-upstream-review-r1-audit](nanoclaw-upstream-review-r1-audit.md) — 09-01: PASS W/WARN. A live `docker run` proved the motivating break (`Cannot find package undici`).

- [hermes-ssrf-standing-orders-r3-audit](hermes-ssrf-standing-orders-r3-audit.md) — 09-01: PASS W/WARN. A FUNCTION-level guard can be unpinned at every CALL SITE.
- **Archived: hermes-ssrf R1–R2 · trustr R1 · memory-arch-v2 R1–R3 · opensandbox R1 · rule-of-two R1 · v82-combinator R2** -> grep by name. Crumb: `..` vs VIRTUAL ROOT.
- [piotr-identity-fix-r1-audit](piotr-identity-fix-r1-audit.md) — 08-31: PASS W/WARN. Spanish `te llama` is unambiguous; the literal keeps the cache prefix static.
- [memory-arch-v2-r4-audit](memory-arch-v2-r4-audit.md) — 08-28: PASS W/WARN, closure-ready. Identity replay re-derived 3032/3032 plus a clean bijection.
- [budget-ruling-5-1400-audit](budget-ruling-5-1400-audit.md) — 08-27: PASS W/WARN, 2 Crit. Raising a cap DELETED it (`slots x per-push cap` < WORD_CAP).
- **Archived: 19 jarvis-usability audits P0–P5 (08-23/24, all SHIPPED)** → grep `usability-phase*-audit.md`. Crumb: score a text filter against the LIVE CORPUS not fixtures.
- **Archived: 10 audits 08-02 → 08-17 (v83 seam-origin · v85 opensandbox R2 · v84 honest-done · …)** -> grep by name. Crumb: `sent>0` ≠ delivered (error RESOLVES).
- **Archived: 18 audits 07-05 → 07-27 (planner sizing · graded-down delivery · v83 phases 5/6/7 · …)** -> grep by name. Crumb: decision-table row is DORMANT until emitted.
## Older audits

- **Archived: 16 v6.x sprint audits (2026-04)** → [archived-v6-sprint-audits](archived-v6-sprint-audits.md) — grep for any v6.0/v6.2/v6.3/v6.4 sprint audit.
- **Archived: 20 audits 04-08 → 05-15** (CCP1-5, F7-F9, Google Workspace, security sweep, v7.3/v7.6, northstar, prompt-enhancer, sdk-wrapper, …) → [arch...
- [loop-unlimited-r1-audit](loop-unlimited-r1-audit.md) — 08-27: FAIL 2 Crit. A command shipped behind an adapter that drops every "/"-prefixed message.
- [authored_doc_citation_is_a_claim](feedback_authored_doc_citation_is_a_claim.md) — Auditing an authored doc that cites decision IDs or a sibling doc: open the cited file.
- [certified_skill_flake_budget](feedback_certified_skill_flake_budget.md) — S5 skill: a green certification is n=1 evidence; check latency headroom and LLM-judgment assertions.
- [skill_error_envelope_strike](feedback_skill_error_envelope_strike.md) — S5 skills: a body-level {"error":...} return is a wrong_output failure that burns a strike.
- [verification_claims_need_the_live_store](feedback_verification_claims_need_the_live_store.md) — "registered"/"deleted" claims must be checked vs the live store.
- [git-tests-inherit-hook-env](feedback_git_tests_inherit_hook_env.md) — tests spawning git in tmpdir repos must strip GIT_* env (pre-commit exports GIT_DIR).
- [skills-versioning-kb-file-r1-audit](skills-versioning-kb-file-r1-audit.md) - 09-24: R1 FAIL (new version inherited `is_certified`) -> R2 PASS.
- [skills-autocert-monotonic-r1-audit](skills-autocert-monotonic-r1-audit.md) - 09-24: R1 FAIL -> R2 PASS-W-WARN. Every pointer move must reset is_certified.
- [scope-miss-blocked-path-r1-audit](scope-miss-blocked-path-r1-audit.md) - 09-24: PASS-W-WARN. CLASS: stream finalize() never rejects, so `.catch(sendFresh)` is dead.
- [scope-miss-blocked-path-r2-audit](scope-miss-blocked-path-r2-audit.md) - 09-24: PASS-W-WARN. CLASS: a no-op branch turned into a send duplicates a non-idempotent 2nd call.
- [open-items-41-42-r1-audit](open-items-41-42-r1-audit.md) - #41/#42 R1-R3 (09-24): R3 PASS. CLASS: a "since last pass" retry bound must be per-test.
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
- [sdk-confirmation-gate-r2-audit](sdk-confirmation-gate-r2-audit.md) - R2+R3 (09-30): PASS-W-WARN. CLASS: "inline code is literal" is per-formatter (WA strips `<tag>`).
- [jme-full-audit-2026-09-30](jme-full-audit-2026-09-30.md) - 09-30: FAIL 3 Crit. CLASS: ORDER BY ts without id tiebreak reverses same-ms turn pairs.
- [jme-hardening-r2-audit-2026-09-30](jme-hardening-r2-audit-2026-09-30.md) - 09-30: FAIL 1 Crit. CLASS: supersede inheriting the INCOMING TTL downgrades a permanent row.
- [jme-hardening-r3-audit-2026-09-30](jme-hardening-r3-audit-2026-09-30.md) - 09-30: FAIL 1 Crit. CLASS: refresh-on-skip + max(confidence) launders echo wording.
- [jme-hardening-r4-audit-2026-09-30](jme-hardening-r4-audit-2026-09-30.md) - 09-30: PASS-W-NOTES, 7/8 RED. CLASS: max-conf inheritance launders only where confidence is a CLASS.
- [jarvis-pull-task-seam-r1-audit](jarvis-pull-task-seam-r1-audit.md) - 09-30: FAIL 1 Crit. CLASS: "no private memory" kept always-read KB + unscoped jarvis_file_*.
- [jarvis-pull-task-seam-r2-audit](jarvis-pull-task-seam-r2-audit.md) - 09-30: FAIL 1 Crit. CLASS: allow-tree-minus-denies policy leaked divorce/health rows.
- [jarvis-pull-task-seam-r3-audit](jarvis-pull-task-seam-r3-audit.md) - 09-30: FAIL 1 Crit (data). CLASS: leak moved to a whole-tree SEED.
- [jarvis-pull-task-seam-r4-audit](jarvis-pull-task-seam-r4-audit.md) - 09-30: PASS-W-WARN, 8/8 RED. CLASS: routerRoot = reply route, not operator watching.
