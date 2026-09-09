# Efficiency Refactor Phase 0 audit (2026-07-05)

9 surgical perf fixes, uncommitted working tree. VERDICT: PASS WITH WARNINGS.
All typecheck clean (tsc --noEmit exit 0) + scoped tests green (registry 25,
signal-store 14, dispatcher 21, composer 8).

## The one real finding (W1, PRE-EXISTING, not a regression)
`src/intel/signal-store.ts` insertSignals: `let inserted` declared OUTSIDE the
`writeWithRetry(() => {...})` callback. writeWithRetry (src/db/index.ts:1195)
re-invokes fn() on SQLITE_BUSY. On retry the tx re-runs and `inserted`
accumulates across attempts (JS var survives DB rollback) → inflated count.
Old code had identical structure (counter outside retry wrapper) so the
`.changes` refactor neither introduced nor fixed it. Untested: the writeWithRetry
MOCK in tests just runs fn() once, never exercises retry.
DOCTRINE: a counter/accumulator mutated inside a retry-wrapped callback but
declared OUTSIDE it double-counts on retry — DB rollback doesn't reset JS vars.
Fix pattern: `const n = writeWithRetry(() => { let c=0; ...; return c; })`.

## Verified-safe items worth remembering
- UNIQUE-index migration (intel-schema.ts: DROP old idx + CREATE UNIQUE
  idx_signals_hash_uq on every boot, inside ensureIntelTables, NO try/catch,
  called from initDatabase): boot-fatal IF live DB has dup non-NULL content_hash.
  VERIFIED SAFE by querying live mc.db: 0 dup groups. Only writer is
  insertSignals (single-process synchronous dedup). DOCTRINE: promoting an index
  to UNIQUE = query the LIVE DB for existing dups before trusting it; no
  dedup-before-migration guard here (acceptable only because verified clean).
- SELECT * → column projection (dispatcher.ts listTasks → TASK_LIST_COLUMNS,
  drops description/input/output/metadata): changes the GET /tasks API response
  SHAPE. Verify NO external client reads dropped fields from the LIST response
  (in-repo dashboard doesn't; detail route getTaskWithRuns keeps full row).
  TaskListRow=Omit<TaskRow,4 fat cols> matched SQL 17-col list exactly.
- promisify(execFile) vs execFileSync: SAME 1 MiB default maxBuffer; dropping
  `stdio:"pipe"` is behavior-neutral (execFile pipes by default). No regression.
- regex hoist to module scope is safe ONLY when no `/g` flag (else shared
  lastIndex across calls corrupts .test()). All 5 router regexes were `/i`-only.
- deferred-tool reachability invariant test (registry.test.ts): asserts every
  `deferred:true` tool ∈ getAllAvailableTools(all-flags-on) OR ∈ documented
  CHAT_UNREACHABLE_EXCEPTIONS. All 6 exception reasons verified against source
  (evolution.ts:73, v8-3/seed.ts:108, v8-2/reconciliation.ts:61, jarvis-init
  only-def). Good template for guarding the "tool unreachable from chat" bug class.
