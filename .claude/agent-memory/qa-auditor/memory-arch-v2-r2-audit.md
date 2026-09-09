# Memory-architecture plan v2.0 — R2 audit (2026-08-28)

R1 folds verified. Verdict **FAIL**, 2 Critical. 169/169 scoped tests green, 5 folds
mutation-RED (M1 migration v5, M2 PATTERNS reversal, M4 follow-up gate, M5 sibling strip)
— and the two Criticals both survive that green suite.

## The two Criticals

1. **The C4 parser fix INERTED the feature it fixed.** `extractSharedFindings` (swarm-runner.ts:195)
   is an anchored multiline heading-LINE regex; its ONLY production call site is
   `extractSharedFindings(tracker.output)` (line 137), and `tracker.output` is the
   **JSON.stringify'd** `tasks.output` blob (set at lines 420/428; the file's own comment at
   513-517 says so). Live: **3032/3032 `tasks.output` rows start with `{`, 3011 carry literal
   `\n` escapes** — no real newlines, so `^##…$` can never match. Reproduced: returns `null`
   on the JSON shape, `"- Fuente…"` on the same markdown. R1's `indexOf` would have found it.
   Consequences: Track 3 forwarding never fires; `SHARED_FINDINGS_TOTAL_MAX_CHARS` and the
   "instead of the 200-char slice" fidelity fold are unreachable; `stripForwardedSiblingFindings`
   is dead code. Every new swarm test seeds `output` as raw markdown, so 50/50 stay green.
   → CLASS: *when you anchor a parser, re-derive the INPUT's real encoding at the call site —
   `indexOf` tolerated a shape the anchored regex cannot.* Same family as
   [[usability-phase3-r2-audit]] ("tightening removed the motivating shape").

2. **C3 still laundering — through the branch the fold left standing.** Because (1) makes
   `shared` always null, the `else` at swarm-runner.ts:141 always fires:
   `— Result: ${tracker.output.slice(0, 200)}`. That 200-char slice of a sibling's JSON output
   carries its figures into `args.taskDescription`, and `stripForwardedSiblingFindings`
   (consumer.ts:426) only matches `## Shared findings from completed siblings` — a heading the
   runner now never emits. `auditNumbers(deliverable, [...evidence, description])` marks the
   sibling's unverified figure verified. The pinning test hand-builds the forwarded heading
   instead of calling `buildSubTaskDescription`.
   → CLASS: *a fold that replaces one branch of an if/else closes the finding only on that branch.*

## C1 — folded, not closed (measured)

Replay of the SAME corpus R1 used (5,700 `conversations` source='router' rows parsed to
operator messages, 156 days) with both new discriminators applied:
- 240-char cap admits **5,150/5,700 = 90.4%** of messages.
- 30-min follow-up gate admits **4,743/5,700 = 83.2%** of ALL messages (it means "not the first
  message in a 30-min session", because the router writes BOTH turns at delivery, back to back —
  router.ts:3018-3030 — so the check only ever sees the PREVIOUS exchange).
- Combined: 41 vocab hits → **32 survive** (gate removes 22%). Read all 32: ~20 are task
  openers. **The exact archetype R1 named survives**: `"Haz un deep search y busca todo lo que se
  sabe acerca de GTA VI. Resumelo."` = **74 chars**, gate passes. The unit test manufactures its
  pass by `.repeat(4)`-padding that same sentence past 240.
→ CLASS: *replay the fold against the corpus that produced the finding; a fixture that pads the
  counter-example past the new threshold pins nothing.*

CLEAN on C1: the consolidator cannot race the window — it selects `ts < now - 30min`
(jme.ts:815) and the window is exactly 30 min, so an in-window Jarvis turn is always present.

## Reusable checks this round earned

- **Mutate the WIRING, not just the function.** Deleting `stripSharedFindings(` at the delivery
  seam (swarm-runner.ts:521-524) left **50/50 swarm tests GREEN** — C2's fold is correct but
  unpinned. Every test calls the pure function directly; none goes through `buildExecutionResults`.
- **Fence-shielding has a PARITY escape.** `stripSharedFindings` replaces ```` ```…``` ```` pairs
  with placeholders; an ODD number of fence markers before the section swallows it into a
  pseudo-fence ⇒ the section is restored verbatim to the operator AND `extractSharedFindings`
  (which DELETES fences) returns null. Verified. Also unhandled: 4-space indented code blocks
  (`[ \t]*` before `##` admits them, so an indented example WINS as the LAST section),
  `##Shared findings` (no space), and a blockquoted heading — all leak.
- **A denominator and a numerator must share a population.** mc-ctl's rate divides
  `jme_signals` (gated to telegram-owner, router.ts:3007-3015) by `recall_audit source='jme'`
  (fired by fast-runner.ts:934 on EVERY chat path, no owner gate) — 752 rows/30d, unattributable
  to a channel in the DB. The rate reads low by an unmeasured factor.
- **A clamp keyed on a model-authored boolean fails open.** jme.ts:936 clamps only when
  `f.inferred === true`; the prompt tells Haiku to OMIT the field for stated preferences, so a
  forgotten flag keeps `confidence ?? 1.0`. Verified correct otherwise: live `jme_facts`
  preferences are 32 rows, 0.72–0.99, **0 at ≤0.7**, so mc-ctl's new discriminator starts the
  inferred population at 0 exactly as its banner claims.
- **A bash CLI ships ahead of its migration.** `mc-ctl jme-preferences` is live on checkout but
  live `user_version=4` and `jme_signals` does not exist — `sqlite3` errors `no such table`
  mid-output. mc-ctl is not built; deploy.sh is.
- **grep is silently broken in this sandbox** (returns nothing, even `-c`). Use `awk`/`python3`.
