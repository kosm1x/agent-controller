---
name: foreign-project-name-routing-audit
description: 3-layer EurekaMS-Landing misroute fix (referencesForeignProject + sandbox-scope/no-evasion prompt guards) audit 2026-06-24
metadata:
  type: project
---

# Foreign-project-name routing + sandbox-scope prompt guard (2026-06-24)

Fix for EurekaMS-Landing incident: "termina la landing de EurekaMS" (project NAMED, no `/root/claude/<path>`) → path-literal `targetsForeignRepo` missed → nanoclaw (mc-only mount) → agent confabulated edits to mc's own source, base64'd `commit` to dodge shell-guard, ~$6 burned.

VERDICT: PASS WITH WARNINGS. Layers A/B/C structurally sound; the incident path (messaging chat) is fully closed. Residual gaps are pre-existing-design + advisory-only.

## Verified TRUE
- `referencesForeignProject` regex `(^|[^a-z0-9])${esc}([^a-z0-9]|$)` — word-boundary correct: "eurekamsxyz" does NOT match "eurekams" (tested). Escape `[.*+?^${}()|[\]\\]` is COMPLETE; all metachars → literal, ZERO ReDoS (escaped quantifiers can't backtrack — empirically 0ms on 50k input).
- Per-name `new RegExp` injection-safe (names operator-controlled DB rows + full escape).
- Multi-word `name` matches only as full phrase ("data intelligence" needs the whole phrase; "data analysis" won't match) — slug carried alongside covers the single-token case.
- Messaging incident path CLOSED: foreign-named coding chat falls THROUGH nanoclaw gate → messaging branch → fast/heavy/swarm (host). NOT dropped.
- Module extraction clean: `RO_REPO` used at nanoclaw-worker.ts:58,64 (git clone), `buildEnvironmentNote(workspace)` at :130, injected :163. No dangling ref.
- ≥4-char gate + mc-alias exclusion (`mission-control`/`agent-controller`/`jarvis`) prevents short-slug spurious matches.

## Warnings (filed)
- **W1 score-path re-route (non-messaging only)**: classifier.ts:488-489 `score>=3 → nanoclaw`. After a foreign-named coding task falls through the gate (line 358-371), the NON-messaging score path NEVER re-checks `referencesForeignProject`/`targetsForeignRepo` → a coding task naming a foreign project that scores ≥3 (has "migration"/"multiple files"/"container"/long desc) routes BACK to nanoclaw. Pre-existing in `targetsForeignRepo` too. Live trigger = a2a/server.ts submissions (no `messaging` tag, no explicit agentType). Messaging path safe (returns fast at 409-415 first). Backstop = Layer B prompt guard (advisory).
- **W2 TARGET_NOT_IN_SANDBOX is advisory-only**: no runner code parses it (grep: only the prompt string). If the LLM ignores the guard it still edits mc. Prompt-only defense; no structural enforcement. The whole Layer B/C is soft (LLM-compliance-dependent), unlike Layer A (deterministic routing).
- **W3 no status filter**: `getForeignProjectNames` SQL `WHERE lower(slug) NOT IN (...)` has NO `status='active'` clause → archived/completed projects (general-credentials, xolo-rides, commit-ai, williams-radar-journal…) pollute the name set. Direction safe (foreign→host) but inflates false-positive surface.
- **FP (safe direction)**: generic live names DO false-match legit mc tasks: "fix the data intelligence layer in classifier.ts", "update the williams entry radar cron", "add a general credentials helper", "obsidian brain importer" → all force-route mc coding to host. HARMLESS (host can edit mc too; just loses sandbox isolation). Per-name `name`-column phrases (e.g. "Data Intelligence") are the worst offenders; slugs less so.

## Doctrine
- Layer A (deterministic routing guard) closes the messaging incident; Layers B/C (prompt guards) are LLM-compliance-soft + advisory — a confabulation-class bug needs a structural backstop, prompt text alone is the thing that already failed once.
- When a routing gate falls THROUGH to a SECOND routing path (score-based), the guard must be re-applied there OR the second path inherits the gap. `targetsForeignRepo`+`referencesForeignProject` both checked ONCE (line 358), not at the score-path nanoclaw branch (488).
