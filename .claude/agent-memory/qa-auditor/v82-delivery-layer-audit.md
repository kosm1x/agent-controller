# V8.2 delivery-layer audit (2026-06-26)

Surfaces shadow `judgments` into the delivered brief behind `V82_DELIVERY_ENABLED` (default OFF, independent of `V82_JUDGMENT_PRODUCER_ENABLED`). Files: flags.ts (isV82DeliveryEnabled), judgment-render.ts (NEW renderStrategicSection), render.ts (extraSection param), delivery.ts (wires it). Verdict: PASS WITH WARNINGS. No Critical.

## Findings
- **W1 (top): delivery.ts:60-64 — V8.2 DB read OUTSIDE the try/catch.** `renderStrategicSection` is pure, but `getJudgmentsForBriefing` is a DB read. With the flag ON, a `SQLITE_BUSY` (mc-ctl uses the raw sqlite3 CLI → concurrent write lock) or any SqliteError throws out of `deliverBriefing`, killing the WHOLE V8.1 brief and breaking the documented "Never throws" contract (delivery.ts:39). Mitigant: the pre-existing `getProposedBriefing` read is also outside the try → this WIDENS an existing exposure, not a new class. Fix: wrap the V8.2 block, fall back to `strategicSection=undefined`.
- **W2: judgment-render.ts:70-73 — null-confidence surfaces WITH A/B/C options.** `dropTriggered = red || unfixable`; null is neither → falls to the green/yellow surface-with-options branch (only the ⚪ dot differs). §9 contract reserves the options tier for green/yellow. confidence is nullable in DDL (index.ts:960, no NOT NULL); a half-written producer row (insert sets null, then crash before `updateJudgmentVerdict`) leaks an un-vetted judgment as if vetted. Fix: drop null-confidence (or route optionless).
- **Info: `(row.signalKind ?? "") as Judgment["kind"]`** (judgment-render.ts:81) is SOUND for current behavior — only consumer compares `=== "recurring_blocker"`, so non-enum/"" is harmless. But signal_kind has NO DB CHECK (index.ts:961 `signal_kind TEXT`) → "persisted SignalKind value" comment is not enforced. Latent only if the predicate becomes an exhaustive switch.
- **Info: recurring_blocker carve-out is dead for new rows** — `recurring_blocker` is a RETIRED detector kind (schema.ts:31); nothing live emits it. Only the at_risk carve-out fires in prod. Test line 105 exercises it but no prod row will.
- **Info: a RED highest_leverage judgment drops silently** (spec-compliant §9: red drops unless at_risk/recurring_blocker) — the single most-important call can vanish if its confidence comes back red.

## Verified clean
- criticVerdict `=== "unfixable"` matches BOTH the producer write shape (produce.ts:289 `{verdict,iterations,critique}`) AND the §17 gate parse (v82-activation-gate.ts:148). Consistent.
- Append seam: footer stays last; no-extraSection path byte-identical (test asserts ""/"   "/undefined); blank degrades via `.trim()`.
- Flag gate: `=== "true"` opt-in polarity; producer-on/delivery-off → V8.1 brief; flags independent.
- Defensive parse: renderOptions + criticVerdict imported from judgment-format.js (reused, not re-implemented); both guard null/malformed → no throw.
- classify drop/surface matrix correct for all (confidence×verdict×posture×kind) combos except W2 null case.

## DOCTRINE
A delivery/render path whose pure renderer is fed by a DB read: the read, not the render, is the throw site. Placing it outside the existing try/catch re-arms "throw-breaks-the-whole-delivery" the moment a default-off flag is flipped on. When auditing a flag-gated surface, ask "what new I/O runs before the try, and what breaks if it throws once the flag is on" — not just "is the new render correct."
