# Agent Memory 5-Layer Playbook → Jarvis adoption plan

Date: 2026-09-16 · Source: "Agent Memory — The 5-Layer Playbook" (independent synthesis, Sept 2026; CoALA taxonomy + Mem0/Snowflake/LangChain/Zep materials; not affiliated with Anthropic). Code map verified against `main` on 2026-09-16 (file:line cites below). Baseline numbers from `data/mc.db` read-only, 30-day window ending 2026-09-16.

Related: `jarvis-kb/projects/agent-controller/jarvis-memory-architecture-plan.md` (v2.0, Tracks 2+3 shipped 08-28) · `jarvis-kb/projects/agent-controller/docs/filesystem-memory-paper-plan-2026-09-09.md` (§6 triage) · `docs/planning/hindsight-strategic-options.md` (DEMOTE verdict 05-15) · queue §2026-09-12 "decide the memory gate".

---

## 0. Executive summary

The paper's contribution is a **taxonomy + a 10-item production checklist + 8 behavioral tests**, not its numbers. Jarvis already has code for all five layers. What it lacks is exactly what the paper's anti-pattern table names:

| Paper anti-pattern | Jarvis today (verified) |
| --- | --- |
| **No retrieval — memory exists but unused** | `memory_search`/`memory_store`/`memory_reflect` have 0 calls ever (`hasMemory` = Hindsight-only, `router.ts:575`). Episodic bank `mc-operational`: **565 recalls, 4 used** in 30 d (0.7 %). JME 62/1,396 (4.4 %). `mc-jarvis` 154/919 (16.8 %). |
| **No schema → store becomes dump** | 6 semantic stores (`user_facts`, `jme_facts`, `knowledge_triples`, `conversations`, `jarvis_files`, pgvector), fact categories = 5-value union (`jme.ts:52`), predicates = 8 regexes (`entity-extractor.ts:43-85`). No entity/relation registry. |
| **Contradictions accumulate** | No contradiction detection anywhere. `user_facts` is `UNIQUE(category,key)` silent overwrite, no `status`, no history. Live cases already observed: vehicle-plate value differs between a KB file and `user_facts` (Track 1 ruling b); identity inversion `jme_facts#307` (08-31). |
| **No versioning / stale skills** | Skills HAVE versions + critic gate + drift check (`skills/lifecycle.ts`), but **no rollback surface** and promotion is proposal-only (`skill-discovery.ts:7`). Two skill stores (table vs KB `skills/`). |
| **Storing raw context** | Not a problem: thread buffer 15 turns, prompt budget 12 k, KB cap 8 k. The paper's 90 % token claim is a Mem0 "full history in every call" baseline Jarvis never had. **Not a target.** |

What the paper adds that Jarvis has no equivalent for:

1. **Precedent lookup before a task** (episodic retrieval keyed on task records, with an outcome/validity marker). Today: free-text conversation recall + model-invoked `task_history`. Nothing looks up "the last time this task type ran, it failed at X."
2. **Contradiction detection pipeline** (Table X) with a `status`/`superseded_by` column and operator review of genuine conflicts.
3. **Compaction → durable store handoff** (Listing 1). `context-compressor.ts:69-100` extracts decisions into the summary text only; nothing is written to a store.
4. **The 8 memory tests** (amnesia, contradiction, staleness, promotion, load, cron, continuity, isolation). None exist in `src/**/*.test.ts`.
5. **Memory tax telemetry**: no metric for tokens spent on memory injection per turn (JME, enrichment, KB, user-facts blocks all unmeasured); prompt truncation is a log line (`router.ts:384-390`).

**Recommendation**: adopt the framework as the **organizing spine and the test suite**, not as new storage. Five phases, instrument first, each phase exits on one of the paper's tests run live. Do not migrate to Mem0/Zep (Hindsight was that experiment: 4 % utility / 2.5 s, demoted 05-15 on data).

---

## 1. Paper assessment (what to trust)

- **Trust**: the CoALA four-store taxonomy (Sumers et al.), the forgetting triad (expire / supersede / flag), skill-promotion bar (recurs ≥ weekly, ≥ 3 successes, unambiguous steps, tools available), the decision framework "add the layer only for the observed problem", the production checklist, the test battery, single-writer-per-entity for multi-agent.
- **Treat as motivational, not targets**: Mem0 "90 % tokens / 91 % latency" (vendor figure vs a history-stuffing baseline), Snowflake "+20 % accuracy / −39 % tool calls" (uncited engineering post), "62.2 % on > 20 tool calls" (unsourced). Jarvis measures utility with `recall_audit` and `mc-ctl audit-claim`; those are the numbers.
- **Reject as written**: `conflict_policy: keep_newer` as an auto-resolution default (the paper itself says negations and overlapping scopes need human review; Jarvis's own record shows the "newer" fact was the wrong one on 08-31). Memory-aware routing (Listing 11): Jarvis routes by complexity to 5 runners, not to agents with accumulated expertise. Hierarchical summarization (Listing 10): day-narrative 23:30 + weekly review Sun 20:00 already do this over the day-log.

---

## 2. Layer-by-layer gap map

### L1 Working memory — PRESENT, one handoff missing
- Prompt tiers P1–P4, budget `SYSTEM_PROMPT_TOKEN_BUDGET` 12,000 (`config/constants.ts:91`), drop order P4→P3→P2 (`router.ts:338-386`). KB block 8,000 chars + `capStableContent` (`kb-injection.ts:151,211-256`).
- Compaction: OpenAI path `compactConversation` L0–L3 (`adapter-openai.ts:1334-1420`, `prometheus/compaction-pipeline.ts:190`); SDK path `CLAUDE_CODE_AUTO_COMPACT_WINDOW=165000` (`claude-sdk.ts:808`), SDK-internal.
- **Gap G1**: no compaction → memory write. **Gap G2**: user-facts + enrichment live in P4, the first tier dropped; no counter says how often. (09-06 gave user-facts its own budget; whether P4 still drops at 12 k is unmeasured.)

### L2 Episodic — STORES PRESENT, RETRIEVAL WRONG-SHAPED
- Stores: `tasks`/`runs`/`task_outcomes` (`schema.sql:3,39,100`), day-log (sole writer `router.ts:1258`, model writes blocked), `conversations` `mc-operational` bank via `auto-persist.ts` with `outcome:*` tags + `outcome-bias.ts`, `task_gates` (V8.4 ledger = the validity signal the paper asks for), `recall_audit`.
- Retention: tasks 90 d (`db/retention.ts:64`), `jme_turns` 7 d, `recall_audit` 180 d. Pins = KB qualifiers.
- Hot path today: `enrichContext` recalls free text from `mc-jarvis`/`mc-operational` (`intelligence/enrichment.ts:63-102`); `getToolHintsAndTopTools` is an aggregate 14-day tool rollup, not keyed on the task (`:427-470`); JME recall in `fast-runner.ts:955-1005`.
- **Gap G3**: no similar-past-task lookup keyed on task records, carrying outcome + gate verdict + supersession. The 09-09 live probe (9457 vs 9465) showed retrieval that is faithful but unlabeled launders superseded results; `supersededBy` was queued and not shipped.

### L3 Semantic — FRAGMENTED, NO ONTOLOGY, NO CONFLICT DETECTION
- Stores and their supersession rules: `user_facts` (272 rows; UNIQUE upsert, silent overwrite), `jme_facts` (482; cosine 0.85 dedup / 0.95 skip, per-category TTL `jme.ts:9-14`, identity-inversion guard `:769`), `knowledge_triples` (3,507; `valid_from`/`valid_to` latest-wins `knowledge-graph.ts:45-85`), `conversations` (9,544; trust tiers 1–4 + decay), `jarvis_files` KB, pgvector (dead without `COMMIT_DB_KEY`).
- Always-inject: `formatUserFactsBlock` 3,000 chars (`db/user-facts.ts:89,119`) → P4; `essentials.ts` (12 facts/1,200 chars) only in fast-runner + reflection, **not** the router prompt.
- **Gap G4**: no entity/relation registry with TTL + validation. **Gap G5**: no contradiction detection across stores; no `status`/`superseded_by`/`confirmed_at` on `user_facts`. **Gap G6**: `memory_search/store/reflect` unreachable in prod (`scope.ts:1559,1647`).

### L4 Procedural — STRONGEST LAYER, LOOP NOT CLOSED
- 115 skills, 13,299 uses / 13,142 successes (30 d cumulative counters), 21 `skill_versions`, `is_certified` (live count reads 4 via `sqlite3`; the 09-12c seed reported 5/5 PASS — reconcile in Phase 0), `consecutive_failures` gate, cosine retrieval on `description_embedding` (`skills/retrieval.ts:66-120`) inside `enrichContext`, critic gate + `body_sha256` drift (`lifecycle.ts:106-240`), evolution ritual 23:00 deactivates < 30 % success at ≥ 5 uses.
- **Gap G7**: promotion is proposal-only (`skill-discovery.ts:24-110`, 3+ occurrences, 24 h rate limit, "does NOT auto-save"); no producer. **Gap G8**: no rollback command (`pointSkillAtVersion` exists, nothing exposes it). **Gap G9**: KB `skills/` folder vs `skills` table are two stores (09-09 finding). Activation gate ≥ 5 certified (`mc-ctl:1126-1139`) unmet or barely met.

### L5 Forgetting — EXPIRE YES, SUPERSEDE PARTIAL, FLAG NO
- Expire: JME TTLs, tasks 90 d, `memory-consolidation` Tue/Thu/Sat 02:30, `jme-consolidate` 02:45, `lesson-decay` Sun 02:00 (**pgvector-gated → dead**, `lesson-decay.ts:194-199`).
- Supersede: KG temporal, JME cosine; `user_facts` overwrite.
- Flag: **nothing**. `memory_forget` (KG invalidate + `corrections/*.md` delete, confirm-gated) shipped 09-12, live KG path untested.
- **Gap G10**: no contradiction flagging, no 90-day unconfirmed-fact audit, no single forgetting entrypoint, decay cron dead in prod.

### Cross-cutting
- **Gap G11**: none of the 8 tests exist. **Gap G12**: no `mc_memory_*` metric family; memory tax unknowable.

---

## 3. Phases

Ordering follows the paper's decision framework (add the layer for the observed problem) and the house rule "instrument first, decide later". Each phase: `/ship-it` (typecheck + scoped vitest + qa-auditor), `npm run eval:gate -- --run` whenever prompt text changes, `/multi-round-audit` for bundles > 300 LOC, deploy = operator.

### Phase 0 — Instrument + test scaffold (½ session)
Goal: make the checklist and the memory tax observable before touching behavior.
1. `mc-ctl memory-checklist` (`scripts/memory-checklist.ts`, read-only): the paper's 10 checklist items evaluated from live data — episodic log rows/24 h, precedent retrieval calls (0 until P1), semantic stores + row counts, ontology present (no), conflicts flagged (n/a), skills promoted last 30 d, rollback available (no), expiry crons last-success timestamps (`mc_ritual_last_success_timestamp`), compaction handoff (no), forgetting schedule. Same shape as `mc-ctl briefing-gate`.
2. Metrics: `mc_memory_injection_tokens{block=jme|enrichment|kb|user_facts|skills}` histogram per turn and `mc_prompt_section_dropped_total{tier}` counter at `router.ts:346-386`. This answers G2 and gives the memory-tax denominator.
3. Tests (vitest, mocked DB): **amnesia** (fact stored turn N is recalled turn N+k by `SqliteMemoryBackend`+JME), **isolation** (bank A recall never returns bank B rows; `data/users`-style scoping for `user_facts` categories), **staleness** (expired `jme_facts` row not recalled after `pruneExpiredFacts`), **contradiction** (RED today; goes green in P2). Add `scripts/validate-memory-tests.ts --run` for the live versions (Telegram-owner probe, one fact, two turns).
4. Reconcile `is_certified` count (4 vs 5) and the two skill stores inventory (G9) — report only.
Exit: `mc-ctl memory-checklist` prints 10 rows with evidence; metrics visible on `/metrics`; contradiction test is the one RED.

### Phase 1 — Episodic precedent retrieval (1 session)
Goal: "Agent skips known dead ends" (paper Day 2 exit test), replacing the 0.7 %-utility operational-bank slot.
1. `src/memory/precedents.ts`: `findPrecedents(task, k=3)` over `tasks` ⋈ `task_outcomes` ⋈ `task_gates` ⋈ latest `runs` output snippet. Similarity = existing `embed()` on title+description (never re-awaited bare on the chat hot path; `withTimeout` 1,500 ms like JME) with FTS keyword fallback (`sanitizeFtsQuery` unicode fix applies). Each hit carries `outcome`, gate verdict (`PASSED|FAILED|ABANDONED`), `supersededBy` (later `completed` task with identical normalized title — the queued 09-09 item), age, and the run's error/resolution snippet.
2. Inject as a ≤ 600-token "Precedentes" block in the enrichment slot currently fed by `mc-operational` free-text recall, behind `MEMORY_PRECEDENTS_ENABLED` (default true after gate) with the old path as fallback. Sort superseded/failed last, label them; never drop them silently (the 09-09 lesson: unlabeled retrieval launders; dropped retrieval hides the caveat).
3. Log through `logRecall` with `bank='precedents'` so `markRecallUtility` and `mc-ctl audit-claim utility --stratify-by=bank` measure it for free.
4. Episode record completeness (paper Listing 2): verify `task_outcomes` carries approach / errors / resolution; if not, add the missing columns via `SCHEMA_MIGRATIONS` and populate from `applyCompletionLedger` (one writer, V8.4 seam).
Exit: 14-day readout `precedents` bank utility vs `mc-operational` baseline (4/565); live continuity probe: re-ask a task that failed last week, the reply cites the precedent. eval:gate PASS (prompt text changed).

### Phase 2 — Ontology + contradiction pipeline (1–2 sessions)
Goal: the contradiction test goes green; genuine conflicts reach the operator instead of the prompt.
1. `src/memory/ontology.ts`: ONE typed registry — entity types (`user`, `person`, `project`, `service`, `credential_ref`, `vehicle`, `preference`, …), relation types with `{target, ttl, single_valued, requires_confirmation}`. Consumers: `jme.upsertFact` (category must exist), `entity-extractor` predicates (registry, not 8 regexes), `user_facts` upsert (category/key validated; warn-only for 14 days, then reject). No new store.
2. `user_facts` migration (append-only `SCHEMA_MIGRATIONS`): `status TEXT DEFAULT 'active'`, `superseded_by INTEGER`, `confirmed_at TEXT`, `source_task TEXT`. Upsert becomes: same value → bump `confirmed_at`; different value → old row `superseded`, new row `active` (history kept; pointer-move over row-mutation). `formatUserFactsBlock` reads `status='active'` only.
3. Nightly `memory-conflicts` ritual (via `scheduleCron`, `recordRitualFailure`): Table X rules across `user_facts` × `jme_facts` × `knowledge_triples` × KB always-read files: same entity+relation, different value, both active → `memory_conflicts` row. Auto-resolve ONLY temporal-same-source; negation, scope and cross-store conflicts are flagged. Surface: `mc-ctl memory-conflicts` + one line in the morning briefing (frequency-weighted: cap 3/day). First fixture = the plate case (values redacted in tests).
4. 90-day unconfirmed audit (paper XI-C): `user_facts` with `confirmed_at < now-90d` listed by `mc-ctl memory-conflicts --stale`; not auto-expired (preferences are permanent per the paper's domain table for personal assistants).
5. Decide G6 (queue §2026-09-12): recommendation = make `hasMemory` backend-independent (`backend !== 'none'`) so `memory_search`/`memory_store` register on SQLite, measure 14 d, retire whichever stays at 0 calls. `memory_reflect` stays Hindsight-gated unless `SqliteMemoryBackend.reflect` exists (verify).
Exit: contradiction test GREEN; a seeded conflict appears in `mc-ctl memory-conflicts` and in one briefing line; `memory-checklist` items 4–5 green.

### Phase 3 — Compaction → memory handoff (1 session)
Goal: continuity test across a compaction.
1. OpenAI path: after `compactConversation` L2 produces the summary, write its "decisions made / constraints discovered" section to `mc-operational` tagged `source:compaction`, `task:<id>`, outcome `unknown` (never positive), via the existing retain path (governance rate limit applies).
2. SDK path: verify whether the Agent SDK exposes a PreCompact hook to Jarvis; if yes, same writer; if not, document that the SDK path relies on its own summary and record the gap (no speculative code).
3. Act on the P4-drop counter from Phase 0: if `mc_prompt_section_dropped_total{tier="P4"}` > 5 % of builds, move `user_facts` block to P3 (one constant) and re-run eval:gate.
Exit: continuity test (fact stated before a forced compaction is recalled after it) GREEN live.

### Phase 4 — Close the skill loop (1 session)
Goal: promotion test; rollback exists; one skill store.
1. Producer, gated (paper's bar + V8.4): a `skill-discovery` proposal that (a) recurred ≥ 3 times in ≥ 2 distinct weeks, (b) every occurrence's `task_gates` = PASSED, (c) same tool set each time → draft via `lifecycle.skillSave({createdBy:'refiner'})`, critic must pass, `is_certified` stays 0. **Structural gate**: no code path sets `is_certified=1` outside the operator command; certification remains human. Proposal → draft is the only new automation.
2. `mc-ctl skills rollback <skill_id> <version>` → `pointSkillAtVersion`; `skill_revise` stays library-only.
3. G9: inventory KB `skills/*.md`; each becomes either a `skills` row (via `scripts/seed-*` pattern) or moves under `knowledge/` as documentation. One store for procedures.
4. Retrieval rule from Listing 9 already holds (`consecutive_failures < 3`); add `success_rate` to `skill_list` output so the model sees it.
Exit: promotion test — 3 gated successes of a synthetic task type produce a draft skill row (`is_certified=0`) with critic PASS; rollback round-trips a version.

### Phase 5 — One forgetting engine (½ session)
1. `src/memory/forgetting.ts`: `runForgetting()` composes what exists (retention sweep, `pruneExpiredFacts`, conversation dedup/stale, KG `valid_to`, `user_facts` supersession, conflict scan) behind ONE ritual id with `recordRitualFailure`; individual crons keep running until the composite is proven, then the composite replaces them (pointer-move).
2. Un-gate `lesson-decay` from pgvector: the SQLite `conversations` decay path runs regardless; pgvector leg stays conditional.
3. Memory-tax readout: `mc_memory_injection_tokens` sum per turn vs `precedents`/`jme`/`mc-jarvis` utility — the paper's §F test "does retrieval pay for itself" answered with Jarvis numbers.
Exit: staleness + cron tests GREEN live; `mc-ctl memory-checklist` 10/10 with evidence.

---

## 4. Sequencing and readouts

| When | What |
| --- | --- |
| Session 1 | Phase 0 → Phase 1 (deploy) |
| +14 d (~09-30) | Phase 1 readout (`audit-claim utility --stratify-by=bank`); Phase 2 |
| Session 3 | Phase 3 + Phase 4 |
| Session 4 | Phase 5; checklist 10/10; memory `feedback_session_*` wrap |

Dependencies: P1 → P2.5 decision; P0 metrics → P3.3; P2.2 status column → P5.1. None on operator hardware.

## 5. Not adopting (and why)
- Mem0 / Zep / LangMem migration — Hindsight already tested the "managed memory layer" thesis on live traffic (4 % utility, 2.5 s) and was demoted on data; re-eval trigger stands (`mc-jarvis` SQLite utility < 25 % for 7 d).
- A knowledge-graph product — `knowledge_triples` + ontology registry is the "minimum viable knowledge graph" the paper itself recommends (Listing 7).
- `keep_newer` auto-resolution — flagged conflicts only, per §1.
- Memory-aware routing, hierarchical summarization — already covered or not applicable (§1).
- The 90 % token target — not the baseline Jarvis has; use the memory-tax metric instead.

## 6. Operator decisions
1. G6 `hasMemory` gate: backend-independent registration (recommended) vs retire the three tools.
2. Conflict surfacing: `mc-ctl` only, or also a capped morning-briefing line (recommended, cap 3/day).
3. `user_facts` TTLs by category in the ontology (recommendation: preferences/identity permanent + 90-day confirm audit; projects 180 d; events 30 d).
4. Confirm certification stays operator-only (structural gate in Phase 4.1).

## 7. Verification claims to re-check before Phase 1 code
- `task_outcomes` column set (episode record completeness).
- `SqliteMemoryBackend.reflect` existence (G6 scope).
- Agent SDK PreCompact hook availability from Jarvis's `claude-sdk.ts` (Phase 3.2).
- Live `is_certified` count and which 4/5 rows.
