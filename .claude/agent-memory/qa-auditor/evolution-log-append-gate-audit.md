---
name: evolution-log-append-gate-audit
description: Round-2 audit of shell.ts RITUAL_WRITABLE_DOCS append-only gate (2026-06-17) — FAIL, indicator-only exception has same blast radius as the path-only one it replaced
metadata:
  type: project
---

# shell.ts append-only gate — Round 2 (2026-06-17): FAIL

Re-audit of the structural fix for the EVOLUTION-LOG.md truncation gap.
Gate at `src/tools/builtin/shell.ts:359-375`: exempts a write to `docs/EVOLUTION-LOG.md`
ONLY when `isAppend && !hasOverwrite` (append `>>`).

**Why FAIL:** the gate runs INSIDE the `WRITE_INDICATORS` loop. `WRITE_INDICATORS`
(`shell.ts:185`) = `/(?:>\s*|>>\s*|tee\s+|mv\s+\S+\s+|cp\s+\S+\s+)(\/[^\s]+)/g` —
requires indicator + **absolute** path. Anything it doesn't capture skips the gate,
deny-list, AND allow-prefix check → `{allowed:true}`. Round-1 was path-only exception;
round-2 replaced it with an indicator-only exception = SAME blast radius.

**4 proven truncation bypasses (all returned ALLOWED, all truncated a real file in bash):**
1. `>|` clobber: `echo X >| LOG` — `>\s*` needs whitespace after `>`, `>|` has `|`. 0 captures.
2. `truncate -s 0 LOG` — not in DENY_COMMANDS, no indicator. 0 captures.
3. `sed -i '1,$d' LOG` — `sed` only denied on credential READS, not writes. 0 captures.
4. Relative path: `echo X > docs/EVOLUTION-LOG.md` — WRITE_INDICATORS captures only
   `(\/...)` absolute. Service `WorkingDirectory=/root/claude/mission-control` +
   `execAsync` no cwd (`shell.ts:486`) → bare relative (no `cd`) hits the real log.

**Correct/safe (verified, no action):**
- `sanitized=stripQuotedHeredocs(command)` IS in scope; heredoc body `> LOG` is stripped
  → cannot hide an overwrite from `hasOverwrite`. Using sanitized over raw is right.
- `hasOverwrite` regex `(?:^|[^>])>\s*PATH` correct: NOT fire on `>>`, DOES fire on
  `>`/`2>`/`&>`. Metachar escaping complete. Problem is gate never RUNS for the 4 vectors.
- `tee -a` correctly ALLOWED (append). `mv`/`cp` correctly DENIED (but misleading
  "append-only" reason — mv/cp can't append).
- Test skip guard `onJarvisBranch()` SOUND: false on main → block-assertions run on CI.

**W2:** 6 new tests (`shell.test.ts:597-650`) all green but cover ONLY captured cases
(`>`,`printf >`,`: >`,`tee`,`>>`). Blind to all 4 bypass vectors → false assurance.

**Fix direction:** move append-only enforcement OUT of the WRITE_INDICATORS loop to a
top-of-function check matching the ritual path by basename (relative+absolute), deny
unless only redirect is `>>`; add `truncate`/`ex`/`ed` to DENY_COMMANDS + `sed -i`/`>|`
patterns.

**Doctrine (reusable):** an "append-only / X-only" gate keyed on a heuristic
write-indicator regex inherits every gap in that regex. `>|`, `truncate`, `sed -i`,
and relative paths are the canonical shell-write-detection blind spots — test all four
whenever a shell guard claims a file is overwrite-proof. Pin [[security-audit-20260409]]
(shell injection in code-search, same file family).
