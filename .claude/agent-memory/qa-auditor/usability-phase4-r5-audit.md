# Usability Phase 4 R5 audit — R4 folds verified (2026-08-23)

Scope: FINAL VERIFY on the 4 R4 folds only. `tsc --noEmit` clean; 51 test files
/ 1,831 tests green (scoped: src/messaging src/runners src/tools/flailing-guard
src/lib/v8-4 src/dispatch/classifier src/prometheus/orchestrator +
tools/builtin/google-docs). 4 mutation probes; working tree byte-identical at
the end (md5 diff empty). Verdict **SHIP** — 0 Critical. R4's Critical is
CLOSED; 2 Warnings remain, neither a regression from these folds.

## R4 folds that HOLD

- **C1 (journalctl → ALLOW-by-membership)** — the R4 escapes are dead:
  `--cursor-file=` / `--cursor-file X` / `--update-catalog` /
  `--smart-relinquish-var` / `--relinquish-var` / `--vacuum-*` / `--rotate` /
  `--flush` / `--sync` / `--setup-keys` / `--force` / `--interval=` /
  `--verify-key=` / `--image*` / `--totally-unknown-future-flag` / `-Z` /
  `-uZ caddy` all ENFORCE. 24 common diagnostic forms still EXEMPT (`-xeu`,
  `-o json`, `--since`, `--disk-usage`, `-f -u X`, `| grep`, `sudo`,
  `timeout 30`, `--file=`, `-D`, `--root=`, `--namespace=`, …).
  **Audited both allow-lists member-by-member against live `journalctl --help`:
  no mutator admitted.** Short set `abDefgkmnopqrStuUx` = all/boot/directory/
  pager-end/follow/grep/dmesg/merge/lines/output/priority/quiet/reverse/since/
  identifier/unit/until/catalog — every one read-only. `--file=PATH` is
  "Show journal file" (read; no write mode). **Mutation: `journalctlFlagsAllowed`
  → always-true ⇒ 6 RED.** Pinned.
- **W1 (recoveryLegUsed set BEFORE the await)** — the new test
  "cap + resume-throw + 401-in-partial fires exactly 2 legs, never 3"
  (fast-runner.integration.test.ts:1104). **Mutation: fast-runner.ts:1410 gate
  back to `!sdkAutoResumed` ⇒ RED ("expected 2 times, got 3").** Pinned.
- **W2 (owner gate on checkpoint continuation)** — placement correct: the
  `isOwnerChannel` term is INSIDE the `if`, so `findRecentCheckpoint(tk)` never
  runs for a non-owner. Semantics verified from source
  (`!isEmailChannel(channel) || mode === "owner-only"`, `isEmailChannel` =
  `channel === "email" || startsWith("email:")`): telegram/whatsapp DMs PASS,
  community-manager email EXCLUDED, email with `mode` undefined EXCLUDED
  (default-deny). See Warnings for what it does NOT cover.
- **R4-info (`":"` separator pin)** — **Mutation: drop `+ ":"` from
  checkpoint.ts:146 ⇒ RED** at checkpoint.test.ts:396
  (`findRecentCheckpoint("email2:bob@x.com")` returns the "email"-stamped row).
  Pinned.

## W1 — negative-numeric option VALUES lose the exemption

Quote-the-line (flailing-guard.ts:362-365):

```ts
    } else if (w.startsWith("-") && w.length > 1) {
      for (const ch of w.slice(1)) {
        if (!JOURNALCTL_SHORT_ALLOW.has(ch)) return false;
```

There is no value-position awareness, so a separate-word value beginning with
`-` is parsed as a short-flag bundle. Live-confirmed on this box that all three
forms are VALID journalctl:

- `journalctl -b -1 -n 1` → exit 0 (previous boot) — probe says ENFORCE
- `journalctl --since -1h -n 1` → exit 0 — probe says ENFORCE
- `journalctl -S -1h -n 1` → exit 0 — probe says ENFORCE

Direction is fail-safe (the command still runs; it only loses the strike
exemption), but this is exactly the ant-colony incident shape: a novel READ
diagnostic blocked because an unrelated token already struck 3×. One-line fix
inside the loop: `if (/^-\d/.test(w)) continue;`.

## W2 — the owner gate closes EMAIL only; WhatsApp groups still leak

Quote-the-line (router.ts:2252-2254):

```ts
      CONTINUATION_RE.test(msg.text.trim()) &&
      isOwnerChannel(msg.channel, spChannel?.mode)
    ) {
```

`isOwnerChannel("whatsapp", undefined) === true` — the predicate is really
"not a public email channel", not "the operator". A WhatsApp GROUP member
reaches `submitInboundTask` with `tk = whatsapp:<group>@g.us:<senderJid>` and no
owner restriction (only email channels get `applyCommunityChannelScopeOverride`).
Because the runner writers still pass no `threadKey` (R4-W2, still open),
`findRecentCheckpoint` skips its filter for unstamped rows (checkpoint.ts:143 —
`cp.threadKey &&`), so that member's "continúa" pulls the OPERATOR's checkpoint:
`safeSlice(cp.userMessage, 2000)` + `safeSlice(cp.summary, 500)` into their
prompt. The in-code comment's claim ("Checkpoint continuation is an operator
feature") is false for that population.

The codebase already has the right predicate: `operatorThreadKey(msg, tk)`
(router.ts:3823) = `isOwnerChannel` AND, for `metadata.isGroup`, `senderJid ===
getOwnerAddress(channel)`. Line 2253 sits inside `submitInboundTask` (a class
method), so `this.operatorThreadKey(msg, tk) !== undefined` is a drop-in.
Not a regression — before this fold EVERY channel passed.

## W3 — the W2 fold is UNPINNED

`grep -rin checkpoint src/messaging/*.test.ts` → zero hits. **Mutation: delete
`&& isOwnerChannel(msg.channel, spChannel?.mode)` ⇒ 238/238 still GREEN**
(router + cancel + thread-pins + checkpoint + fast-runner.integration). The
router seam has no checkpoint-injection test at all.

## Recommendations

- Add the read-only journalctl options omitted from both lists — they lose the
  exemption for no safety gain: short `c` (--cursor), `N` (--fields),
  `F` (--field), `M` (--machine); long `after-cursor`, `show-cursor`,
  `list-catalog`, `dump-catalog`, `verify`, `truncate-newline`. All read-only
  per live `--help`.
- `journalctl --` (bare double dash) → name `""` → loses exemption. Harmless.

## Info

- Positional match expressions (`journalctl _SYSTEMD_UNIT=caddy.service`) pass
  correctly — the `FOO=bar` stripper only touches words BEFORE the binary.
- `DANGEROUS_FLAGS` is now 3 entries (dmesg/ss/git); journalctl is out of both
  it and `DIAG_SIMPLE`, reachable only through its dedicated branch at
  flailing-guard.ts:478, which is evaluated before the `DANGEROUS_FLAGS` lookup.
- Test count moved 1,821 → 1,831 (10 new).

## Method notes

- Allow-lists are audited the same way DENY lists are: diff EVERY member against
  the live `--help`, in BOTH directions — members that should not be there
  (safety) and read-only options that are missing (usability). The inversion
  moves the failure mode from "escape" to "false negative"; both need a probe.
- A 65-row `isReadOnlyDiagnostic` probe via `npx tsx` (import the real module,
  print EXEMPT/ENFORCE per row) beat reading the regex — it surfaced `-b -1`,
  which no amount of staring at the loop would have.
