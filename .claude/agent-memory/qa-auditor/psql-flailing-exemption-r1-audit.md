# psql read-only flailing exemption + http_fetch in CODING_TOOLS — R1 audit (2026-09-09)

Bundle: `isReadOnlyDiagnostic` psql `-c` exemption (flailing-guard.ts), `http_fetch` → CODING_TOOLS
(scope.ts), DENUE density recipe (fast-runner.ts + jarvis-kb denue-patterns.md "Receta B").
Verdict: PASS WITH WARNINGS. 0 Critical, 5 Warnings. 560/560 tests green, tsc 0.

## The crumb that generalises: a flag ALLOW-LOOP is a second body

The body of `-c` was hardened statement-by-statement (every `;` piece must open SELECT, every
`\meta` on an allow-list). But the FLAGS loop in front of it,
`(?:\s+-[A-Za-z]+(?:\s+[^\s"'-]\S*)?)*`, swallows any short flag whose value is a path — and psql
executes `-f` and `-c` TOGETHER. So the doc comment's "`-f file` … stay enforced" is false:

    psql -U postgres -d postgres -f /tmp/migration.sql -c "SELECT 1"   → EXEMPT

Proven live in the container: both ran (`from_f_file 111`, `from_c_flag 222`). Same class:
`-o FILE` and `-L FILE` write arbitrary files (`-o /tmp/x -c "SELECT 333"` wrote the file, EXEMPT).
Order matters — `-c "…" -f X` lands in the remainder and IS enforced. **When you harden the
payload of a flag, enumerate what the flags BEFORE it can do; a flag-value allow-loop is a second
payload nobody audited.**

## Second crumb: "SELECT is a read" is false in vanilla SQL

The comment concedes "a SELECT can still call a side-effecting function". It misses that plain
`SELECT … INTO newtable` is DDL — no function involved. Also `SELECT nextval()`, `SELECT
lo_export()`, `SELECT pg_terminate_backend()`. First-word membership cannot make a body read-only;
the connection ROLE is the only thing that can.

## Third crumb: score a recall fix against the corpus of REAL invocation shapes

Grepping `conversations` for `psql` (55 rows) surfaced the shapes Jarvis actually types. Two are
NOT exempt: **backslash line-continuation** (`psql -U postgres -d postgres \` ⏎ `-c "…"` — `\` is
not `\s`, so the anchored regex dies) and **chained `-c` reads**. Also missed: leading `--` SQL
comment (the KB's own Pattern-3 recipe opens with one), `WITH` CTE, plain `EXPLAIN SELECT`,
`PGPASSWORD=… psql`, `sudo -u postgres psql`, `timeout N docker exec …`. All fail-toward-enforced,
but the fix EXISTS for recall. The incident's own shape (`-c "` + newline + SELECT) IS covered —
verified against the verbatim command recovered from the conversation row.

## Do not repeat my wrong hypothesis

I predicted adding `http_fetch` to CODING_TOOLS would widen `conditionMatches("coding", …)` and
re-inject 16,818 chars of conditional KB. **It does not** — that gate was ALREADY always-true
because `list_dir` ∈ CORE_TOOLS ∩ CODING_TOOLS. Pre-existing dead gate, same shape as the `kbwrite`
one this repo caught 2026-06-24. Probe a membership gate with an EMPTY group set before claiming a
new member widened it.

## Verification anchors

- Enforcement-only CONFIRMED: `isReadOnlyDiagnostic` has exactly one non-test caller
  (checkFlailing:589); `recordCall` at shell.ts:875/908 is unconditional on both exit paths.
- `allowEmpty=false` ≡ old `realSegments > 0`; the `$(`/backtick check moved from `stripped` to raw
  `command` but neither strip pattern contains `$`, backtick or `(` — predicate identical.
- Recipe verified live: 73,315 estab `621211` → 73,280 joined (matches the claimed number exactly);
  0 duplicate `(entidad,mun)` at `loc='0000'` so `COUNT(*)` is not inflated; 1,373 munis survive
  `pobtot>=10000`. The 35 unjoined rows are post-2020 municipios (24059 ×17, 25019/25020, 02007,
  04013, 12082/84/85) — 0.05%, dropped silently.
- Premise CONFIRMED via `scope_telemetry`: all 5 incident turns scoped `["coding"]`/`["coding",
  "browser"]`, never research/specialty ⇒ http_fetch genuinely unreachable.
