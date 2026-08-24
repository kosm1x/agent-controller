# Usability Phase 4 R4 audit — R3 folds verified (2026-08-23)

Scope: VERIFY pass on the R3 folds only. tsc --noEmit clean; 51 test files /
1,821 tests green (scoped: src/messaging src/runners src/tools/flailing-guard
src/lib/v8-4 src/dispatch/classifier src/prometheus/orchestrator +
tools/builtin/google-docs). 5 mutation probes, all RED where claimed; working
tree byte-identical at the end (md5 22/22). Verdict **FIX-FIRST** (1 Critical) —
every R3 fold HOLDS; the Critical is a NEW member of the class R3 already
declared architectural.

## R3 folds that HOLD (mutation-probed, not assumed)

- **C1 (DIAG_SIMPLE inversion + bundling-proof `DANGEROUS_FLAGS`)** — all 9 R3
  escapes now ENFORCED (`sort -uo`, `dmesg -Cw`, `dmesg -cw`, `ss -Kn`,
  `rg --pre`, `hostname X`, `xxd a b`, `uniq in out`, `file -C -m`); all 6
  incident commands still EXEMPT. **Mutation: bundled-letter loop →
  `w.length === 2` single-flag check ⇒ 2 RED** (`dmesg -Cw`, `ss -Kn`). Pinned.
- **C2 (hard-stop retain)** — mechanism traced end-to-end:
  `getMemoryService()` → `SqliteMemoryBackend.retain` → `INSERT INTO
  conversations (bank, tags, content, trust_tier, source)` with
  `source='router'`, `bank='mc-jarvis'`, content verbatim. `sqlite3` check:
  `'User: Para ya'||char(10)||'Jarvis: Detenido: 2 …' LIKE '%Jarvis: Detenido:%'`
  = 1. The stop path returns BEFORE the task-completed path, so no
  auto-persist twin ⇒ no double count. **Mutation: delete the retain block ⇒
  router.test.ts RED.** Pinned.
- **W1 (thread-pins sweep)** — **Mutation: delete the global sweep loop from
  `addPin` ⇒ RED, "expected 51 to be 1".** The R3 finding (test passed with the
  sweep gone) is genuinely closed by asserting `_threadPinKeyCount()`.
- **W2 (`recoveryLegUsed` before the await)** — no test existed; I wrote the
  scenario (leg-1 capped text containing 401 + resume REJECTS): 2 SDK calls.
  **Mutation: gate back to `!sdkAutoResumed` ⇒ 3 calls.** Fix real, test absent.
- **W3 (thread-scoped checkpoints)** — **Mutation: delete the threadKey filter
  ⇒ 2 RED.** Prefix rule confirmed safe by reading: `"emailx".startsWith("email:")`
  is false, and no crafted stamp is reachable (the ONLY stamp producer is the
  boot-orphan writer, stamping `tags[1]` = the channel).
- **W4 (`source != 'auto-persist'`)** — live 45d re-verified: `%no agotes%`
  all=10 → filtered=7 → **distinct_content=7** (residual double-count zero);
  `User: Contin%` 16/16/16. `stops_honoured` + `¿Sigo?` are 0 today (not
  deployed). No other new metric double-counts — the 4 new metrics are the only
  additions and all route through the one filtered `contRow`.

## C1 — 4th recurrence: `DANGEROUS_FLAGS.journalctl` misses 3 mutating options

Quote-the-line (flailing-guard.ts:305-307, ALL new in this diff):

```ts
  journalctl: {
    longRe: /^--(vacuum|rotate|flush|relinquish|setup-keys|sync)/,
  },
```

`journalctl --help` on this box lists these mutators NOT covered by that regex:

- `--cursor-file=FILE` — "Show entries after cursor in FILE **and update FILE**".
  **Live proof**: `journalctl -n 1 --cursor-file=/tmp/cur_r4` created a 128-byte
  root-owned file; re-run rewrote it; it also fills a 0-byte file. (It refuses a
  file holding non-cursor bytes — "Failed to seek to cursor" — so the primitive is
  create-or-refresh, NOT arbitrary overwrite. Weaker than R3's `sort -uo`.)
- `--update-catalog` — writes `/var/lib/systemd/catalog/database`.
- `--smart-relinquish-var` — the `--relinquish-var` sibling; the `^--relinquish`
  anchor cannot reach it (starts `--smart-`). NOP only when the log dir is on the
  root mount.

Probe: all three return `isReadOnlyDiagnostic === true` (EXEMPT).
`validateShellCommand` does not save this — it is a base-name DENY list and
`journalctl` is not on it, so the command runs.

`dmesg` (`CcDEn` + `^--(clear|console|read-clear)`) and `ss` (`K` + `^--kill`)
are COMPLETE against their live `--help`. `git`'s `^--output` covers
`git diff --output=` and `git log -p --output=` (both probed ENFORCED).

Minimal fix: `/^--(vacuum|rotate|flush|relinquish|setup-keys|sync|cursor-file|update-catalog|smart-relinquish)/`.
Doctrine note: this is the 4th round of the same enumeration miss (R1 `\n`, R2
`&`+5 flag rows, R3 bundling+4 binaries, R4 3 journalctl options). R3's
recommendation — a positive shape rule instead of a subtraction list — still
stands; a 5th subtraction is a 3-strike violation.

## Warnings

- **W2's fold is UNPINNED.** No test in the shipped suite exercises
  cap→resume-throws→401-in-leg-1. Reverting `!recoveryLegUsed` to
  `!sdkAutoResumed` keeps every scoped suite green; only my throwaway probe
  caught it. Add the case to `fast-runner.integration.test.ts`.
- **W3's fold covers the SMALL producer only.** `index.ts:210` stamps the
  boot-orphan checkpoint; the two runner writers (`fast-runner.ts:1459` — the
  NEW Phase-4 SDK double-cap writer — and `:2242`) pass no `threadKey` and
  `RunnerInput` carries no channel/thread field at all, so they emit UNSTAMPED
  checkpoints that match ANY thread. In-code comment admits it ("the runner
  writers stamp nothing"). The cross-sender leak R3 named (sender A's "continúa"
  gets sender B's `userMessage` + partial injected at router.ts:2253) is
  therefore still open for the dominant producer. Thread the tk into
  `RunnerInput` to close it.
- **A channel-level stamp still crosses senders inside one channel** — by
  design (`whatsapp` stamp prefix-matches `whatsapp:<group>:<sender>`), so a WA
  group member's 60-char truncated title can reach another member's
  continuation prompt. Deliberate + documented; note it, don't "fix" it inline.

## Info

- `!threadKey.startsWith(cp.threadKey + ":")` — the `+ ":"` separator is
  UNPINNED: removing it keeps checkpoint.test.ts 17/17 green. Code is correct
  and no crafted stamp is reachable, so risk ≈ 0; add the `"email"` vs
  `"emailx"` row if the guard is ever touched.
- The wrapper stripper shifts any `FOO=bar` prefix, so
  `LD_PRELOAD=/tmp/x.so cat /etc/passwd` and `PATH=/tmp/evil ls /` are EXEMPT.
  Both need a pre-planted file and are outside the flailing threat model
  (an LLM writing variation N+1 does not do this). Not worth a subtraction.
- The hard-stop retain adds low-signal rows ("User: Para ya\nJarvis: Detenido:
  1 tarea cancelada.") to the mc-jarvis recall bank, embedded like any exchange.
  Few per day; acceptable.
- `stops_honoured` counts the no-op stop ("Detenido: no había tareas activas.")
  as well as real cancellations — consistent with the exit criterion
  ("stops ANSWERED with the one-line Detenido:"), not a defect.

## Method notes

- The decisive step for the Critical was reading `journalctl --help` on the live
  box and diffing it against the regex's alternation, then executing the
  candidate against a victim file — NOT reasoning about the option name.
  Same lesson as R3: run the real binary.
- Mutation ordering that worked: baseline md5 of all 22 files first, one
  mutation at a time, `cp` restore + md5 compare after EACH (not at the end).
- Probing a fold with NO test: copy the integration test file to
  `__r4probe.test.ts`, append one describe reusing its mock scaffolding, run
  with `-t`, delete the copy. Cheap way to turn "missing test" into a proven
  claim in both directions.
