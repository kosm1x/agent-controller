# Memory-architecture plan v2.0 — R3 audit (2026-08-28)

R2 folds verified. Verdict **FAIL**, 2 Critical. 178/178 scoped tests green, tsc clean.
Folds mutation-RED: M1 JSON unwrap, M2 consumer sibling-tail strip, M4 confirmed-preference
supersede guard, M7 strip at the `buildExecutionResults` seam. Folds mutation-GREEN
(= unpinned): M3 indented-code shielding, M5 `f.inferred !== false`, M8 `orderForInjection`
wiring.

## The two Criticals

1. **The R2 W-d fold (shield indented code) CORRUPTS deliverables — and is provably
   redundant.** `shieldCode` (swarm-runner.ts:243-254) replaces a match with
   `` ` CODE${n} ` `` and the replacement carries **no newline**, so line structure is
   destroyed while shielded; worse, `FENCED_CODE_RE` runs FIRST, so a fence *indented under
   a list item* becomes `"     CODE1 \n"`, which `INDENTED_CODE_RE` (line 252) then shields
   AGAIN — and `restoreCode`'s single `String.replace` pass never rescans replacement text,
   so the inner placeholder is delivered literally. **Corpus replay over the live DB (3,032
   `tasks.output` deliverables): 5 rows corrupted, 0 of which contain a `## Shared findings`
   section at all** — `shieldCode`/`restoreCode` runs on EVERY swarm child result via
   `buildExecutionResults`. All 5 are the house style "N. ✅ paso:\n\n    ```\n    salida\n
   ```". Second (latent, 0/3032) failure mode of the same line: an indented run directly
   followed by an H2 swallows the newline ⇒ the H2 is invisible ⇒ `stripSharedFindings`
   deletes to EOF (data loss) or misses the heading entirely (C2 leak reopened).
   Line 252 buys NOTHING: `^ {0,3}##` already rejects a 4-space/tab-indented heading, which
   is why **deleting line 252 leaves 58/58 swarm tests GREEN and takes the corpus to 0/3032**.
   The two tests that "cover" it are written with the blank line / EOF that hides the bug.
   → CLASS: *a text shield must be a bijection. Measure it as one: replay the live corpus and
   assert `restore(shield(x)) === x`, not just "the feature still works".* Third round on the
   same parser (R1 `indexOf` → R2 anchored-vs-JSON → R3 shield) = the 3-strike architectural
   signal; the durable shape is "mask by line index", not "substitute placeholders in text".

2. **C3 closed at ONE of `auditNumbers`' two production sites.** `auditNumbers` has exactly
   two callers; the fold swept `consumer.ts:187`, not **`provenance-gate.ts:199-205`**, whose
   corpus is `[...peekToolEvidence(taskId), taskDescription(taskId), input.priorContent]`
   with `taskDescription()` (line 120-130) returning raw `tasks.description` unless it starts
   with `## Identidad`. For a swarm child `tasks.description` IS `buildSubTaskDescription`
   (swarm-runner.ts:885 → `submitTask({description})`); **1 live `spawn_type='subtask'` row
   already carries `## Sibling goals`**. Mode default is `enforce`. So a sibling's unverified
   figure still licenses a `gsheets_write`/`file_write` with no `fuente`.
   → CLASS: *count the call sites of the sink before declaring a laundering finding closed —
   `auditNumbers(` had 2, the fix touched 1.* (Global rule: grep-sweep before committing.)

## Reusable checks this round earned

- **Corpus-replay a "lossless" transform as an identity assertion.** 3,032 live deliverables,
  `strip(x) === x.trimEnd()` for every x without the section — 5 violations, all invisible to
  the unit suite. Same discipline as [[corpus-replay-before-shipping-a-text-filter]], applied
  to a *sanitizer's* no-op path rather than its active path.
- **A fold whose mutation is GREEN is not shipped, it is proposed.** M3/M5/M8 all green:
  the R2 W-d shielding, the R2 W-f `!== false` fail-safe (every fixture spells `inferred`
  explicitly; none OMITS it — the exact case the fold exists for), and the sole
  `orderForInjection` wiring point (133/133 fast-runner tests green with it deleted).
- **A 1.0 sentinel the model can also write is not an operator signature.** `--confirm` marks
  consent as `confidence = 1.0`, and `upsertFact` now refuses to supersede it — but
  `consolidateAll` defaults a missing confidence to `1.0` and only clamps the *inferred*
  branch, so `{category:"preference", inferred:false}` (no confidence) mints an
  operator-grade, permanently unsupersedable, model-authored fact. Clamp the non-inferred
  branch to `<1.0`, or mark consent out-of-band (`source_task`).
- **Live-DB shape checks beat fixtures, even at n=2.** Both `spawn_type='subtask'` rows with
  output carry `finalAnswer` ⇒ `extractDeliverableText` returns real text ⇒ R2 C4 genuinely
  closed. Also: `user_version=4`, `jme_signals` absent ⇒ mc-ctl's `sqlite_master` guard fires
  (W-h closed) and live `preference` facts are 32, all 0.7<c<1.0 ⇒ 0 inferred, 0 confirmed.
- **JS multiline `$` matches before `\r` too** — the CRLF asymmetry I suspected between
  `extractSharedFindings` (normalizes) and `stripSharedFindings` (does not) does NOT exist.
- The classifier fold is bounded but not neutralized: aggregate cap 3,000 chars ≈ 428 words,
  still over the `wordCount > 200 ⇒ +4` rung (`classifier.ts:546`), and the fixed
  `## Coordination` block is **69** words (the queue note says ~48). Queued as follow-up #7.
- `grep` is still silently broken in this sandbox — use `awk`/`python3`.
