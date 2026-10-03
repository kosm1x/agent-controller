---
name: landscape-review-1-r2-audit
description: R2 audit of S2 landscape review #1 (docs-only, uncommitted on 16fa9e4, 2026-10-03) - verifies R1 fixes (Stop-hook claim, register split, A2A rows, L5)
metadata:
  type: project
---

# Landscape review #1 - R2 audit (uncommitted, base 16fa9e4, 2026-10-03)

**Verdict: PASS WITH WARNINGS, 0 Crit, 1 Warn (W6 force-add, owned by the orchestrator), 2 Info.** R1 is in [[landscape-review-1-r1-audit]].

## Closed and verified
- **C1:** the note's headline 1 (:22), the a16 row (:58) and the new L5 row (:151) now say the gap exists at the pin under both semantics. "inert" and "One real behaviour change" are gone. New cites checked: `consumer.ts:166` = `export async function applyCompletionLedger`; `stop-hook.ts:42-43` = `stopHookEnabled` with `TASK_GATES_STOP_HOOK`.
- **L5:** consistent across the note (:151), LANDSCAPE (:25, build, owner L5), ROADMAP (:31) and the Session log row. It is not sequenced on L1, and L1's scope no longer carries it.
- **W1/W2:** the register is now one row per id or per same-verdict group. a21, a22, a23, b6, b10 and d7 have rows, and b10 is in L4's scope.
- **W3/W4:** c6 = ignore (retire candidate). The A2A register has 4 rows (c1/c2/c4, c3, c5, c6) matching the note. a6 is now owned by "operator ruling".
- **W5:** agent-card cited at :67,71. **W7:** L4 is in ROADMAP "Not now". **W8:** the a11, a13, b8 and b10 greps all return 0.
- **Info items:** 70 non-test files; hono widening noted; a22 is about Managed Agents; c5 lists its peers.
- ROADMAP is 62 lines.

## Left open
- W: W6 (`git add -f` the archive) is pending at commit.
- Info: the note's Audit table (:186) still says "R1 pending". c1 owner and trigger differ slightly from the register ("L3" and "prod A2A traffic or a named peer" in the note, vs "L3 -> operator ruling" and "VPS data on A2A use" in the register).

## Doctrine
- A fix round that splits grouped rows should be re-verified id by id against the note. Here it held.
