# Claude Code gap plan — 2026-10-17

Source: `/insights` report 2026-10-17 (2 of 42 sessions analysed) + the rubric scored the same evening (4.1 / 5; weak: session hygiene 2, ruling follow-through 3; cost-side: delegation 4, self-measurement 4). Corrections already applied to the report's claims: deploy is operator-only by design (not a classifier accident); the WA outage it cites was closed 10-06.

Rule for this plan: every item has an owner, a change that is small enough to land in one session, and a done-check that can be read later without opinion.

## 1. Session hygiene (owner: operator) — rubric 2 → 4

- Open work with `claude --continue` (or `--resume <id>`); do `/login`, `/model`, `/plugin` inside the working session, never as a session of their own.
- Decide at `/compact` time whether the session is actually finished; if it is, exit without compacting (the summary is only worth paying for when work continues).
- Done-check: the next `/insights` window shows ≤ 30 % empty sessions (today 9 of 13).

## 2. Rulings drain (owner: both) — rubric 3 → 4

- Agent: NOW.md gets a `▶ RULINGS` block — one line per open ruling with its options letter-coded, newest last — maintained at every wrap. Tonight: 4c (verifier every boot), 4d (plan gate re-roots KB paths: a/b/c), 4e (15/43 scope-prompt cases: investigate/accept), reformat-all-drive (retire/keep), 3l.
- Operator: close at least one ruling at the start of each working session before new work is queued.
- Agent: when a ruling has a read-only step that narrows it (4e: list the 15 case ids + expected vs answered groups, no message text), do that step BEFORE presenting the ruling, so the operator decides on facts.
- Done-check: open rulings ≤ 3 on 2026-10-24; none older than 14 days.

## 3. Audit budget per item (owner: agent) — delegation 4 → 5 at lower cost

- Standing rule (AGENT_LEARNINGS § Standing rules): R1 full audit → one fold → R2 confirm. R3+ only when R2 reports a NEW Critical; a round that finds only Warnings/Info closes the item with the warnings logged in the queue.
- The builder brief carries the budget ("R2 is the last round unless a Critical appears") so the implementer front-loads its own mutation proof.
- Done-check: next ship-it push averages ≤ 2.5 rounds per item (today: 3, 3, 4, 3).

## 4. Test tautology guard in the brief (owner: agent)

- Every builder brief includes the three lines: the test imports and calls the exported function (never re-implements it); every assertion is pinned by a mutant shown RED on a scratch copy; the hand-back lists mutant → test pairs.
- qa-auditor brief includes: "flag any test whose assertions mirror the implementation's arithmetic".
- Done-check: no audit round reports a tautological test for the next 3 pushes.

## 5. Wrap-up by skill, not prose (owner: both)

- Operator: end the day with `/session-wrap` (kosm1x-workflows) instead of "update docs, learnings, commit and push".
- Agent: verify the skill's checklist equals today's manual tail (docs → PROJECT-STATUS/ROADMAP rows → learnings → memory wrap + index under cap → NOW.md → commit → push → CI green). If a step is missing, write the patch as a scratch copy + operator apply line (plugin source is self-modification).
- Done-check: one `/session-wrap` run produces the same artefacts as 2026-10-17's manual close with no follow-up message needed.

## 6. Flagged anomalies persist (owner: agent)

- Any infra anomaly the agent notices (service down, 0-byte file, disk growth, failed job) gets a queue line (`next-sessions-queue.md`) with date, symptom and suggested fix BEFORE the session ends, even when the user does not reply.
- The headless cron health check the report suggests is optional and read-only if adopted (never restarts anything; the self-healing triage already ships dormant). Operator decision, not in this plan.
- Done-check: every flagged anomaly in the next 2 weeks has a queue line or a closed note.

## 7. Self-measurement (owner: agent, routes back to the queue)

- Today's recapture gave the first number for the live scope prompt (64.74). Close 4e's read-only step (item 2) and attach the floor consequence (5 lost cases fails the gate) to the ruling.
- Done-check: 4e ruled; the next prompt-text change goes through the gate with a known floor.

## Order

1. Agent now (≈ 1 session, no deploy): items 3, 4, 6 as standing rules in AGENT_LEARNINGS.md; item 2's RULINGS block in NOW.md; item 5's skill check; item 7's read-only 4e listing.
2. Operator habit from the next session: items 1, 2 (close one ruling first), 5 (`/session-wrap`).
3. Then: the queue against the roadmap, rulings first.
