# Phase β — Exploration Plan for the Readiness Gate Window

> **Status:** PROPOSED — awaiting operator selection
> **Window:** 48h readiness gate (until ~2026-04-17 evening)
> **Purpose:** Productively use the wait time to derisk Phase β bottlenecks BEFORE any F-series session starts. Zero code commits, pure planning + research artifacts.

---

## Tier 1 — do before F1 starts (high value, gap-relevant)

### A. F7 alpha combination engine math study

**Budget:** ~45 min via Explore agent
**Why:** F7 is the algorithmic core of Phase β (2 sessions, solo) and the most fragile piece. The v7 spec references "11-step pipeline, ISQ dimensions, layer weights, weight versioning, minimum signal threshold" without the actual math. If we discover a fundamental issue mid-F7, we lose a session.
**Method:** Explore agent reads `docs/V7-ALPHA-COMBINATION-EQUATIONS.md` (if it exists) + any reference repos flagged for F7 patterns. Reports: equations, weight-derivation logic, dimensionality, worked example.
**Deliverable:** `docs/planning/phase-beta/06-f7-math-study.md`
**Risk derisked:** F7 algorithmic rework mid-session (2 sessions blast radius)

### B. F8 pm-trader integration dry-run

**Budget:** ~30 min hands-on, no code committed
**Why:** Phase β risk table flagged "pm-trader Python subprocess fails on our systemd deploy" as Medium/High. Actual risk unknown until we try. A throwaway sandbox install + MCP inspector stdio roundtrip tells us the answer cheaply.
**Method:** Install `agent-next/polymarket-paper-trader` in a scratch directory (NOT in mission-control), spawn the subprocess, exchange a `tools/list` and a single `tools/call`, report what happens. No commits, no systemd touches.
**Deliverable:** `docs/planning/phase-beta/07-pm-trader-dryrun.md` — status note + verified tool count (does it really have 26?) + any integration friction observed
**Risk derisked:** F8 session overrun due to pm-trader incompatibility

### C. Polygon.io hands-on verification

**Budget:** ~20 min
**Why:** We committed to Polygon.io free tier as F1 fallback based on an Explore agent's secondary-source read. Worth actually hitting the endpoints once to confirm response shape, rate-limit behavior on request 6+/minute, and real-time WS availability.
**Method:** `curl` the daily bars endpoint for SPY, measure latency, burst-test the rate limiter, capture a sample response.
**Deliverable:** `docs/planning/phase-beta/08-polygon-verification.md` + a fixture JSON to seed F1 golden-file tests
**Risk derisked:** F1 fallback adapter built against wrong response shape

### D. Hermes Tier 1 adoption design drafts

**Budget:** ~30 min per item (2 items = ~60 min)
**Why:** Two items fold naturally into F1 (rate-limit header capture, empty response recovery for reasoning models). Drafting them now as mini-specs means F1 doesn't get derailed by "how do we do this."
**Method:** Read the relevant Hermes v0.9 PRs (#6847, #6488, #6541) + our current `src/inference/adapter.ts` surface. Produce a 30-line implementation sketch for each.
**Deliverable:** `docs/planning/phase-beta/09-hermes-tier1-drafts.md`
**Risk derisked:** F1 session bloats from adopt-on-the-way work

---

## Tier 2 — valuable but less time-critical

### E. Session 67 postmortem

**Budget:** ~30 min retrospective
**Why:** Session 67 shipped 15 commits including 4 critical audit saves and one live ship-blocker caught with 45-minute margin (mc-grafana). Patterns from this kind of session are worth extracting into protocol memory before they fade.
**Method:** Read the session 67 entries in `PROJECT-STATUS.md` + the 4 new `feedback_*.md` files written during it. Extract patterns that belong in doctrine.
**Deliverable:** `memory/feedback_session_20260414_postmortem.md`

### F. v7.1 chart-layer reality check

**Budget:** ~30 min Explore agent
**Why:** v7.1 depends on `lightweight-charts` + Puppeteer for PNG generation. Not in Phase β critical path but slots in after F3. Knocking out the dep check early means v7.1 pre-plan has fewer unknowns when it lands.
**Method:** Explore agent checks `lightweight-charts` current version, Puppeteer headless PNG compatibility, any 2026 breaking changes, alternative chart libraries if the primary has drifted.
**Deliverable:** `docs/planning/phase-beta/10-v71-chart-deps.md`

---

## Tier 3 — save for later (NOT this window)

These are explicitly deferred because running them now produces stale findings by the time they're used:

- **v7.5 upstream sweep (48 repos, ~4h)** — mandatory per `feedback_v75_upstream_sweep_directive.md`, but v7.5 is multiple weeks away. Running now means the findings are stale by v7.5 start. Run it as a dedicated half-day session immediately before v7.5 pre-plan.
- **v7.2 Graphify use case decision** — γ work, user directive says no interleaving during β.
- **Operator-level business framing** (Does the thesis need Polymarket? Would equity-only paper trading suffice?) — requires operator input, can't explore alone.

---

## Recommendations

### Full slice (~3 hours of work)

**Run A + B + C + D in sequence.** Derisks F7 (2 sessions downstream), F8 (1.5 sessions downstream), F1 fallback (immediate), and folds Hermes adoption into F1 cleanly. Zero code commits. All outputs land in `docs/planning/phase-beta/`.

### Minimal slice (~50 min)

**Run only B + C.** Derisks the two concrete Phase β bottlenecks that could still surprise us. Skips the algorithmic deep-dive (F7) and the Hermes drafts — both can be done during the F1 session itself if needed.

### Paranoia slice (~4 hours)

**Run A + B + C + D + E + F.** Full Tier 1 + Tier 2. Includes session 67 postmortem (retrospective value) and v7.1 chart deps (small, knocks a γ dep out early).

---

## Selection protocol

Operator picks one slice (minimal / full / paranoia) or cherries specific letters (e.g., "run B + D only"). I execute in order, each item lands as a new file in `docs/planning/phase-beta/`, each file gets pushed to origin/main as a standalone docs commit so you can review progressively without waiting for the full batch.

If any item surfaces a ship-blocker (e.g., pm-trader stdio subprocess fails), I stop and report before continuing — same stop-and-report discipline used for the audit marathon.

No source code touched. No schema migrations. No service restarts. Pure planning state — matches the "without pushing it yet, until Jarvis is ready" directive.
