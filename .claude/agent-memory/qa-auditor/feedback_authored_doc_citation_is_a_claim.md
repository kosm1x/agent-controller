---
name: authored-doc-citation-is-a-claim
description: When auditing an authored (non-distilled) doc that cites decision IDs or a sibling doc, open the cited file — IDs, enum/family names and figures drift or ship as placeholders.
metadata:
  type: feedback
---

An authored doc's citation (`D-013`, `06-scene-craft.md`, "requirements") is a CLAIM, not provenance. Open the cited file and match the specific token, not the topic.

**Why:** 2026-09-12 screenwriting-corpus audit (lens C). Three defects only visible by opening the source: a table row cited `D-0xx cost analysis` (placeholder; the real ruling is D-005); a "families" table invented three of four family names (the product's PLAN.md defines `cinematic`/`promo`/`briefing`/`training`); a "three dead locations" reference named three items where the cited doc lists seven. All four cited sources existed, so a filename-level check would have passed.

**How to apply:** for each citation in an authored doc — (1) grep the cited file for the exact ID/enum/number; (2) when the doc claims two systems "share one structure", diff the two vocabularies token by token; (3) treat `D-0xx`, `TBD`, `p.N` style placeholders as ship-blockers. Same discipline as quote-the-line: paste the cited line in the finding, else downgrade to Recommendation.

Related: [[verification-claims-need-the-live-store]]
