# Beta 1.0 — definition and evidence

> What "Beta 1.0" means for agent-controller, how each of its four tests is judged, what evidence exists today and what is missing. Source of the destination: `docs/V8-VISION.md` §8. Current state of the work: `docs/ROADMAP.md`. Written 2026-10-18 from the repo; production figures are as last recorded in the linked docs, not re-read (cloud session, no production data).

## 1. What Beta 1.0 is

Beta 1.0 is a **maturity declaration, not a software version** (`docs/V8-VISION.md` §8). It is reached when the V7–V9 record shows that an operator with the required strategic clarity can amplify their capabilities with this system sustainably and verifiably, and an outside observer can say _"that works, and I can see why."_

Decided 2026-10-03: Beta means **both**

- **(a) it works for the first operator (Fede), with evidence**, and
- **(b) any other operator could adopt it.**

Fede is the first operator and super beta tester. His setup becomes the **first operator profile**, not a special case: everything that is his today (name, language, timezone, paths, projects, schedules) must end up in a profile or a project record that a second operator fills in differently, with no code change.

Standing constraints that Beta does not change:

- **Platform (option A, 2026-10-03):** Jarvis stays self-hosted, one install per operator. Hosted Managed Agents are not adopted; their designs are borrowed. The bar is to stay competitive with them in functionality, looping and tool use.
- **Thesis:** the harness and the loop are the lever, not the model weights (`docs/V9-ROADMAP.md` §1; CLAUDE.md "Loop vocabulary").
- Budget hard-cap enforcement stays closed (ruling 2026-07-13). A2A stays (ruling 2026-10-09).

## 2. The four tests

Each test is **passed** only when every pass condition below holds and is shown by evidence in the repo or in `mc-ctl` output, never by assertion.

| Test | Question (V8-VISION §8) | Pass condition |
| --- | --- | --- |
| Replicability | Can the operator model be described precisely enough for another operator to adopt? | A synthetic second operator runs on the same build with zero first-operator literals reaching prompts, scope or tools (the S6 replicability suite, contract spec §6, criteria 1–5; criterion 6 once WS7 lands), and the first operator loses nothing (spec §5 migration checks, and §6: no first-operator code path changed between runs). |
| Teachability | Can the strategic consciousness needed to operate Jarvis be articulated and transmitted? | An operator onboarding guide exists, and one transfer attempt (a person other than the first operator, or a scripted dry run of the guide on a clean install) is recorded with what failed. |
| Scalability | Does the architecture deploy to other operators without a rebuild? | Identity, language, timezone, paths, channels, KB seed and projects come from the operator profile and project records; a fresh install reaches a working chat turn by configuration only. |
| Credibility | Is the V7+V8+V9 history evidence, not marketing? | The V9 questions (`docs/V8-VISION.md` §7, Q1–Q4) each have a measured answer, or an explicit "no population", from a read-only report (W3), and the W1 verify gate meets its activation checklist. |

## 3. Evidence today and what is missing

### Replicability

**Evidence**

- Inventory of everything hardcoded to the first operator or this VPS: 1,700 source sites, classed prompt 657 · profile 453 · leave 331 · KB seed 111 · env 96 · infra 52 (`docs/planning/s6-operator-abstraction-inventory-2026-10-09.md`).
- Project contract (`docs/planning/s6-project-contract-spec-2026-10-11.md`): a project enters Jarvis only through its record `projects/<slug>/project.md`, projected into its `projects` row; capability through per-project MCP servers; attribution columns; `mc-ctl project <slug>` as the per-project record.
- Built and deployed: WS1 record parser, projector and guard (`f4f6c73`); WS2 attribution columns, schema v9 (`2a59503`), proven by two chat tasks attributed on 2026-10-11; WS3 MCP servers from records with names-only child env (`9026838`); WS3b record-declared tools and X accounts (built 2026-10-17, deployed in build `741b35c`; **proof open**: its env-fallback trace has not been seen yet). Records: Entry radar exported 2026-10-11; DENUE + `uncharted-lite` applied 2026-10-11; the 3f records applied and read-back verified 2026-10-18, with proof of use due when the 2026-10-19 daily tweet is attributed to its record.
- Rulings in force: profile store = a KB file; language = Spanish default, English on command; ruling 3 MCP trust; 5b no core-tool exceptions; xpoz is a service outside the contract (`docs/planning/next-sessions-queue.md`, S6 sections).

**Missing**

- The operator profile itself (KB file parsed into `config.ts`): not built.
- WS4 write allow-list fed by `profile.workspaceRoot` and record `repos` (6 hardcoded sites): not built.
- WS5 remaining code-wired project families (DENUE server, CRM capability, `DEFAULT_CWD`, slug lists): not built; needs the paid eval gate.
- WS6 replicability suite (`src/projects/replicability.test.ts`, synthetic operator `acme`): not written. This is the test's main evidence.
- WS7 sandboxed MCP transport for `trusted: false` servers: not built.

### Teachability

**Evidence**

- The vision and plans that explain the model: `docs/V8-VISION.md`, `docs/V9-ROADMAP.md`, `docs/planning/v8-where-we-are-going.md`, CLAUDE.md (loop vocabulary, invariants), this file.
- Existing guides for the first operator: `docs/V8.1-GUIDE.md`, `docs/TRAINING-JARVIS.md`.

**Missing**

- An operator onboarding guide written for someone who is not the first operator (install, profile, first project record, first schedule, how to read the ledger and the gates). It follows the profile workstream, since it documents that profile.
- Any transfer attempt. None is planned yet; this is the test with the least movement since 2026-10-03.
- An articulation of the "strategic clarity" the operator needs. V8-VISION names it but does not describe it.

### Scalability

**Evidence**

- Single process, single SQLite file, `SANDBOX_BACKEND` seam for runners; one install per operator by design.
- Channels are already clean: owner ids, group JIDs, email accounts, port and bind host all come from env (inventory §1 item 6).
- New projects enter through records (WS1–WS3b above), not code; the first operator's 7 code-wired projects still need WS5.

**Missing**

- Language: 949 fixed-Spanish lines, 557 of them model-facing (a paid eval-gate change).
- Identity: 117 lines; 50 of the 71 code lines are persona or tool-description prose.
- Timezone half-seamed: `USER_TIMEZONE` and 11 literals ignore `RITUALS_TIMEZONE`.
- Paths: the 6 allow-list sites (WS4) and 49 install-dir lines.
- Config: `config.ts` holds 47 keys while `src/` reads 136 env keys from 105 other files; the operator keys are not in `config.ts`.
- KB seed and the 20 scheduled tasks (18 of them operator-personal or portfolio tasks) have no clean-install story.
- A2A: it stays, but the 1.0 shim waits on the date of the first consumer, which the operator has not set.

### Credibility

**Evidence**

- V8.4 Honest Done gates ENFORCE since 2026-08-27; every completion path goes through `applyCompletionLedger`.
- Model-swap eval gate with a committed incumbent: baseline re-captured 2026-10-17 under scoring v4 (`f606d04`, composite 78.63, the first measurement of the live scope prompt); last compare PASS 2026-10-18 (78.55 vs 78.63).
- W1 verify gate (fresh-context grader inside the ledger) in shadow since 2026-10-06. Label ledger `docs/planning/v9-w1-labels.md`: **17/30** `really done` labels as of 2026-10-09, 1 false positive (stale registry copy, since fixed by `5a8583e`), 1 confirmed catch; latency/cost readout n=15 (median 20.4 s, $0.20 per graded task) reported, not yet accepted.
- W3 step 1 inventory of the evaluation data (`docs/planning/v9-w3-inventory-2026-10-09.md`, 33 sources). Its three rulings were **RULED 2026-10-18** (queue §2026-10-09 (late) W3): (1) tool-call count + wall-clock as the size axis, censoring note on every number; (2) finished = `completed` AND every runnable ledger gate met, W1 label overrides, Q2 reported now with the rating asymmetry printed; (3) archive past 90 d may be read, trace retention stays 30 d, day-log content may be read for Q1/Q3 (counts and labels only).
- Incident and decision history kept, not rewritten: `docs/archive/status-history-*`, `docs/PROJECT-STATUS.md`, this roadmap's session log.

**Missing**

- W1: 13 more `really done` labels (≥30 with ≤2 false positives), then the operator accepts the latency/cost readout, then `enforce`. At ~12–16 gradeable tasks a week this is traffic-bound, not build-bound.
- W3 step 2: the read-only weekly report (`src/eval/queries.ts`, `src/eval/report.ts`, `mc-ctl eval`). Unblocked by the 2026-10-18 rulings; not built.
- Q1 (amplify vs execute) and Q3 (bilateral learning) have no population in `mc.db`; with ruling 3 they can be read from day-log content, but no reader exists. Q2's cost-of-errors side has no population either (W3 inventory §6).
- No outside observer has looked at the evidence. The "that works, and I can see why" condition needs one, after Replicability and Credibility have their reports.

## 4. Order of work toward Beta

1. **Credibility first, because it is the cheapest to close:** keep labelling W1 to 30 and arm `enforce`; build W3 step 2 as ruled.
2. **Replicability:** operator profile (KB file) → WS4 allow-list → WS6 replicability suite (first pass) → WS5 → WS6 final pass; WS7 before any untrusted server.
3. **Scalability** rides on the profile: language, identity and timezone move behind it, each model-facing change through the paid eval gate.
4. **Teachability** last: the onboarding guide documents the profile and records once they exist, then one transfer attempt.

Beta 1.0 is declared when all four tests pass, in a session-log row that links the evidence for each.

## 5. How to update this file

- Change a test's **pass condition** only by operator ruling, recorded in the roadmap's session log.
- Update **Evidence** and **Missing** when a session moves a test, with a commit, a PR or a doc path for every claim. Move a line from Missing to Evidence only when it is deployed and proven, not when it is built.
- Figures from production carry their date and source doc. Cloud sessions do not re-read production; they say a figure is as last recorded.
