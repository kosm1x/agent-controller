# Phase β Ordering + Parallelization Map

> **Status:** DRAFT — incorporating reality-check findings
> **Purpose:** Validate that the F1→F2→F4→F5→F3→F6→F6.5→F7→F7.5→F8→F9→F10 graph still makes sense post-reality-check, and identify parallelizable pairs to compress calendar time.

---

## Dependency graph (post-reality-check)

```
F1 (Data Layer) ──┬── F2 (Indicators) ─────────┐
  1.7 sess         ├── F4 (Watchlist tools) ───┤
                   ├── F5 (Macro Regime) ──────┤
                   │                            F3 (Signal Detector)
                   │                             1 sess
                   │                            │
                   F6 (Pred Markets + Whales) ──┤
                    1.5 sess                    │
                   F6.5 (Sentiment) ────────────┤
                    0.7 sess                    │
                                                 ↓
                                         F7 (Alpha Combo)
                                          2 sess
                                                 │
                                         F7.5 (Backtester)
                                          1 sess
                                                 │
                                         F8 (Paper Trading)
                                          1.5 sess
                                                 │
                                         F9 (Scan Rituals)
                                          1 sess
                                                 │
                                         F10 (Crypto WS, OPTIONAL)
                                          1 sess — parallel from F3
```

---

## Critical path (longest chain through the graph)

**F1 → F2 → F3 → F7 → F7.5 → F8 → F9**

= 1.7 + 1 + 1 + 2 + 1 + 1.5 + 1 = **9.2 sessions** (sequential only)

Everything else must fit within or around this 9.2-session spine.

---

## Parallelization windows

### Window A — Post-F1 fan-out (3 parallel tracks)

Once F1 lands, F2/F4/F5 can all start independently because they only read from the schema F1 created:

| Track | Tasks                | Sessions |
| ----- | -------------------- | -------- |
| A1    | F2 (Indicators)      | 1        |
| A2    | F4 (Watchlist tools) | 1        |
| A3    | F5 (Macro Regime)    | 0.5      |

**Compressed wall-clock if fully parallel:** max(1, 1, 0.5) = **1 session** instead of 2.5 sequential.

**Realistic:** F2 + F4 in one session (both small, related), F5 in next session paired with F3 startup. Saves ~1 session.

### Window B — Signals + external data fan-out (after F2/F4/F5)

F3 depends on F2 + F4. F6 and F6.5 have NO F1-F5 dependencies — they're external-data fetchers that just need the `signals` table F1 created. Three tracks:

| Track | Tasks                            | Sessions |
| ----- | -------------------------------- | -------- |
| B1    | F3 (Signal Detector)             | 1        |
| B2    | F6 (Prediction Markets + Whales) | 1.5      |
| B3    | F6.5 (Sentiment)                 | 0.7      |

**Compressed wall-clock if fully parallel:** max(1, 1.5, 0.7) = **1.5 sessions** instead of 3.2 sequential.

**Realistic:** F3 + F6.5 in one session (complementary, low-coupling), F6 in next (larger, needs its own attention). Saves ~0.7 sessions.

### Window C — Alpha combination to ritual (must be sequential)

F7 depends on F3 + F5 + F6 + F6.5 (all four must complete). F7.5 depends on F7. F8 depends on F7.5. F9 depends on F8. No parallelization possible in this window.

**Sequential wall-clock:** 2 + 1 + 1.5 + 1 = **5.5 sessions**. No compression available.

### Window D — F10 crypto WS (fully parallel)

F10 has NO dependencies — it's a standalone WebSocket adapter that writes to the same `market_data` table F1 created. It can slot into any session window that has spare capacity.

**Best slot:** pair F10 with F6 in Window B (both are data-fetching, low-coupling). Or defer entirely — it's explicitly optional in the v7 spec.

### Window E — Reality-check Tier 1 adoptions (orthogonal)

From the Hermes v0.9 review, Tier 1 adoption items unrelated to F-series:

| Item                                                    | Session slot                               | Effort   |
| ------------------------------------------------------- | ------------------------------------------ | -------- |
| Empty response recovery (adapter.ts)                    | Slot into any F-session                    | ~30 LOC  |
| Compression floor + activity tracking (orchestrator.ts) | Before F3 (which uses heavy runner)        | ~100 LOC |
| Adaptive streaming backoff                              | Slot anywhere                              | ~40 LOC  |
| Rate-limit header capture                               | Slot with F1 (already touching adapter.ts) | ~50 LOC  |
| Background `watch_patterns`                             | Slot before F9 (rituals expand)            | ~80 LOC  |

**Strategy:** fold the smallest two (rate-limit headers + empty response recovery) into F1 while we're already editing `src/inference/adapter.ts`. Fold compression floor before F3 because F3's signal detector may run Prometheus for multi-symbol scans. Defer the rest.

---

## Compressed Phase β schedule

**Sequential baseline:** 11.4 sessions (from reality-check report).

**With parallelization:**

| Session | Content                                                                         | Cumulative |
| ------- | ------------------------------------------------------------------------------- | ---------- |
| S1      | F1 (Data Layer) — 1 day of focused work, single session                         | 1.7        |
| S2      | F2 + F4 together (both small, same schema reader) + Hermes adapter.ts adoptions | 2.5 (+0.8) |
| S3      | F5 + F3 together (macro + signal detector, complementary)                       | 4.0 (+1.5) |
| S4      | F6 + F6.5 in the same session (external data fetchers, low coupling)            | 6.2 (+2.2) |
| S5      | F7 alone (alpha combination, needs full attention)                              | 7.2 (+1)   |
| S6      | F7 continued + start F7.5                                                       | 8.2 (+1)   |
| S7      | F7.5 finish + F8 start                                                          | 9.2 (+1)   |
| S8      | F8 finish + F9 start                                                            | 10.2 (+1)  |
| S9      | F9 finish + F10 (optional)                                                      | 11.2 (+1)  |

**Compressed wall-clock:** **9 sessions** instead of 11.4 sequential.

**Savings:** 2.4 sessions (~21%) via parallelization.

**Assumption:** F1 lands clean — if it doesn't, parallelization cascades break because F2/F4/F5 all read from F1's schema.

---

## Parallelization caveats

1. **F1 is the bottleneck.** If F1 slips, every downstream compression assumption fails. Don't overpack F1 with adopt-on-the-way items — keep it laser-focused on schema + adapters + validation + tests.

2. **F6 is the second bottleneck.** F6 (prediction markets) has the most external-API complexity (three APIs: Polymarket + Kalshi + SEC EDGAR). Giving it a full session alone is safer than bundling.

3. **F7 is the third bottleneck.** The 11-step alpha combination engine is the most algorithmically complex piece in Phase β. **Do NOT bundle F7 with anything else.** Two full sessions as the spec says.

4. **F8 paper trading has a hidden cost.** pm-trader MCP is Python — we need to verify stdio subprocess works end-to-end on our VPS before budget-committing F8's 1.5 sessions. If pm-trader fails to start cleanly under our systemd-managed process, F8 grows to 2+ sessions while we build a TypeScript wrapper or replace it.

5. **F10 should slip.** It's explicitly optional in the v7 spec, and crypto real-time is a nice-to-have, not a thesis validator. If any earlier session overruns, drop F10 first.

---

## Staging decisions

### When to start Phase β

Per the readiness framework: earliest all-gates-pass is **2026-04-17 evening** (~48h from now). Target **2026-04-18 morning** for F1 session start.

### What ships independently vs together

**F1 ships alone.** Clean commit on its own branch, full audit pass, then merged before F2/F4/F5 begin. This is the cleanest foundation.

**F2 + F4** can ship as a single commit after F1 — same domain, same schema, minimal coupling.

**F5 + F3** can ship as a single commit if F5 is small enough (0.5 sess) to not dominate the session.

**F6 ships alone.** Three APIs, whale tracking logic, dedicated audit.

**F6.5 rides in whatever session has slack.**

**F7 ships alone (2 sessions).** The alpha combination engine is the algorithmic core and deserves full attention.

**F7.5 ships alone.** Backtesting logic has subtle off-by-one risks (walk-forward window boundaries).

**F8 ships alone.** pm-trader integration friction.

**F9 ships alone.** Ritual scheduling has calendar/TZ edge cases (market holidays, half-days) that need isolated testing.

**F10 optional — slot anywhere.**

### Git branching strategy

Each F-session lands on its own feature branch: `phase-beta/f1-data-layer`, `phase-beta/f2-indicators`, etc. Merge to main ONLY after:

1. qa-auditor pass with PASS or PASS WITH WARNINGS
2. Full test suite green
3. 12h observation window on the feature branch deployed to staging (if we have one) or a separate env
4. Operator approval

Jarvis **cannot push to main** per the v6.0 SG1 invariant, so this is automatic.

---

## Session budget vs calendar

Assuming 1 session ≈ 4-6 hours focused work, and we ship ~1-2 sessions per calendar day:

- **Minimum calendar time for Phase β (compressed):** 5 calendar days
- **Realistic calendar time (with audits, reviews, unexpected blockers):** 8-10 calendar days
- **Pessimistic (any Phase β session needs a Phase α-style audit-driven rework):** 14 calendar days

**2026-04-20 autoreason Phase 2 decision** fires automatically during Phase β — expect 0.5 sessions of decision-related work (review gap telemetry, decide P3 tournament).

**2026-05-10 operational validation window** (per `feedback_audit_iteration`) clears. If Phase β finishes by then, we have clean separation between "building" and "validating."

---

## What about Phase γ interleaving?

Per the master roadmap, γ (feature verticals) can run in parallel with β where dependencies allow. Two candidates:

1. **v7.2 Graphify** — zero β dependencies, independent. Could slot between β sessions as palette-cleanser. Estimated 1.5 sess.
2. **v7.3 P2 SEO telemetry** — depends on v7.6 ✅ (done). 1 session. Could slot anywhere.

**Recommendation:** **Do NOT interleave γ into β.** The thesis is β. Split attention hurts velocity and audit discipline. γ can run after F9 (when the F-series critical path exits) and before the 2026-05-10 validation window.

---

## Open question for operator

**Will Phase β actually start next session, or do we let the readiness gate run its 48h course?** If we want to start next session, we need to:

- Make the three F1 decisions right now (AV tier, fallback source, watchlist scope)
- Accept that Production Stability + Memory Integrity gate dimensions will be "best effort" not "48h quiet observed"

**Recommendation:** Let the 48h window run. Start F1 on 2026-04-17 evening or 2026-04-18 morning. Use the 48h for F1 pre-plan finalization, operator decisions, and a first-hour smoke test of the stale-artifact-prune ritual (which fires every hour — we'll have ~48 observations by the time F1 starts).
