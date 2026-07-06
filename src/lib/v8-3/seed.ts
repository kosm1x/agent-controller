/**
 * V8.3 — Autonomous Execution Gates: capability seed (Phase 0 + Phase 1).
 *
 * Seeds the 6 capabilities of `capability_autonomy`, all at L1 (the conservative
 * default — L1's gate IS the existing router confirm flow; operators promote
 * individually over weeks via §10). Called from `src/index.ts` AFTER the tool
 * registry is populated (`initAll`), because tool-backed capabilities are
 * resolved against the live registry and cross-checked against its MCP hints.
 *
 * Two design facts that diverge from a naive reading of the spec, verified against
 * the live registry (2026-06-24):
 *
 *  1. `blast_radius` is DECLARED, not hint-derived. All five tool-backed
 *     capabilities are `destructiveHint:true` + `openWorldHint:true`, so the four
 *     MCP hints cannot distinguish self/session/persistent. The §6 table is the
 *     design decision; we declare it and use the hints only to cross-check
 *     (a gated WRITE capability must not be `readOnlyHint`).
 *
 *  2. `reversible_default` is DERIVED from a NAMED reversal mechanism
 *     (`reversal_strategy`), not invented as a bare boolean — see
 *     `deriveReversibleDefault`. This grounds the structural-safety invariant the
 *     gate actually enforces: a capability that is not auto-reversible
 *     (`compensating`/`none`) MUST be capped at `max_level ≤ 2` (§7.4), and a
 *     file-mutating capability stays `≤ 2` until shadow-Git ships (§7.2).
 */

import type Database from "better-sqlite3";
import type { ToolRegistry } from "../../tools/registry.js";
import { getToolAnnotations } from "../../tools/types.js";
import type { CapabilitySeed, ReversalStrategy } from "./types.js";
import { deriveReversibleDefault } from "./types.js";

/**
 * The 6 capabilities (§6). Keys are real registered tool names or a named
 * internal mutation (`task_edit` has no LLM tool — it's a `tasks` row UPDATE).
 */
export const CAPABILITY_SEEDS: readonly CapabilitySeed[] = [
  {
    capability: "gmail_send",
    backing: { kind: "tool", tool_name: "gmail_send" },
    level: 1,
    blast_radius: "persistent",
    reversal_strategy: "compensating", // a sent email cannot be unsent
    gate_config: { reversible_required: true, max_level: 2 },
    odd_predicate: { op: "eq", field: "autonomy_eligible", value: true },
    ux_confirm_flag: false,
    file_mutating: false,
    description:
      "Owner-facing email send (destructive; compensating-only reversal).",
  },
  {
    capability: "northstar_sync",
    backing: { kind: "tool", tool_name: "northstar_sync" },
    level: 1,
    blast_radius: "persistent",
    // Remote LWW store + kb-reindex resurrection (2026-05-12 incident) — local
    // SQL-inverse DML is UNSAFE here, so reversal is compensating-only (§6/§7).
    reversal_strategy: "compensating",
    gate_config: { reversible_required: true, max_level: 2 },
    odd_predicate: { op: "eq", field: "autonomy_eligible", value: true },
    ux_confirm_flag: false,
    file_mutating: false,
    description:
      "NorthStar remote LWW sync (operator-life-strategic; excluded from SQL-inverse).",
  },
  {
    capability: "task_edit",
    backing: { kind: "internal" }, // internal `tasks` row UPDATE, not an LLM tool
    level: 1,
    blast_radius: "persistent",
    reversal_strategy: "sql_inverse", // the v1 workhorse
    gate_config: { reversible_required: true, max_level: 5 },
    // §6 worked example — the L4-intent ODD this capability would gate on.
    odd_predicate: {
      op: "and",
      clauses: [
        { op: "neq", field: "task.priority", value: "urgent" },
        { op: "neq", field: "task.assigned_to", value: "operator" },
        { op: "in", field: "task.status", values: ["pending", "blocked"] },
        {
          op: "in",
          field: "edit_kind",
          values: ["status_update", "due_date_extension", "tag_add"],
        },
        { op: "lte", field: "days_extended", value: 14 },
      ],
    },
    ux_confirm_flag: false,
    file_mutating: false,
    description:
      "Internal task-row edit (the canonical L3+ candidate; SQL inverse DML).",
  },
  {
    capability: "jarvis_file_delete",
    backing: { kind: "tool", tool_name: "jarvis_file_delete" },
    level: 1,
    blast_radius: "persistent",
    reversal_strategy: "tri_restore", // FS-mirror + pgvector + Drive tri-restore exists
    // File-mutating → held at L≤2 until shadow-Git ships (§7.2), despite tri-restore.
    gate_config: { reversible_required: true, max_level: 2 },
    odd_predicate: { op: "eq", field: "autonomy_eligible", value: true },
    ux_confirm_flag: false,
    file_mutating: true,
    description:
      "KB file delete (tri-restore reversible, but file-mutating ⇒ L≤2 until shadow-Git).",
  },
  {
    capability: "skill_run",
    backing: { kind: "tool", tool_name: "skill_run" },
    level: 1,
    blast_radius: "session",
    reversal_strategy: "none", // reversibility depends on the skill — conservative
    gate_config: { reversible_required: true, max_level: 2 },
    odd_predicate: { op: "eq", field: "autonomy_eligible", value: true },
    ux_confirm_flag: false,
    file_mutating: false,
    description:
      "Run a skill (reversibility depends on the skill; conservatively capped at L2).",
  },
  {
    capability: "schedule_task",
    backing: { kind: "tool", tool_name: "schedule_task" },
    level: 1,
    blast_radius: "self",
    reversal_strategy: "delete_inverse", // delete_schedule undoes it
    gate_config: { reversible_required: true, max_level: 5 },
    // Only schedule within waking hours when later considered for autonomy.
    odd_predicate: {
      op: "time_window",
      start_hour: 6,
      end_hour: 22,
      tz: "America/Mexico_City",
    },
    ux_confirm_flag: false,
    file_mutating: false,
    description:
      "Schedule a future task (self-blast, delete_schedule inverse; natural first-flipper).",
  },
] as const;

/**
 * Canonical per-capability reversal strategy — the STRUCTURAL invariant the
 * decision pipeline binds `buildReversalOp` to. Sourced from the IMMUTABLE seed
 * constant, NOT a mutable `capability_autonomy` column: a reversal strategy is a
 * compile-time property of a capability (a sent email is compensating-only,
 * forever), so persisting it as runtime state would only invite drift. The
 * pipeline reads this — never the caller's trigger — so a caller can never coax
 * a compensating-only capability (e.g. `northstar_sync`) into building a local
 * `sql_inverse` (the 2026-05-12 resurrection risk).
 */
const REVERSAL_STRATEGY_BY_CAPABILITY: ReadonlyMap<string, ReversalStrategy> =
  new Map(CAPABILITY_SEEDS.map((s) => [s.capability, s.reversal_strategy]));

export function reversalStrategyForCapability(
  capability: string,
): ReversalStrategy {
  const strategy = REVERSAL_STRATEGY_BY_CAPABILITY.get(capability);
  if (!strategy) {
    throw new Error(
      `V8.3: no canonical reversal strategy for capability '${capability}' (not in CAPABILITY_SEEDS)`,
    );
  }
  return strategy;
}

/**
 * Validate a seed's structural-safety invariants. Returns the first violation
 * message, or null if consistent. These hold over the CAPABILITY_SEEDS constants
 * (a test asserts all pass) and are re-checked at seed time as defense.
 */
export function assertSeedInvariants(seed: CapabilitySeed): string | null {
  const { capability, level, gate_config, blast_radius, file_mutating } = seed;
  const reversible = deriveReversibleDefault(seed.reversal_strategy);
  if (level < 0 || level > 5)
    return `${capability}: level ${level} out of range`;
  if (gate_config.max_level < 0 || gate_config.max_level > 5)
    return `${capability}: max_level ${gate_config.max_level} out of range`;
  if (level > gate_config.max_level)
    return `${capability}: level ${level} exceeds gate_config.max_level ${gate_config.max_level}`;
  if (!["self", "session", "persistent"].includes(blast_radius))
    return `${capability}: invalid blast_radius '${blast_radius}'`;
  // §7.4 — a not-auto-reversible capability can never reach the autonomous path.
  if (!reversible && gate_config.max_level > 2)
    return `${capability}: not auto-reversible (${seed.reversal_strategy}) but max_level ${gate_config.max_level} > 2`;
  // §7.2 — file-mutating capabilities stay L≤2 until shadow-Git exists.
  if (file_mutating && gate_config.max_level > 2)
    return `${capability}: file-mutating but max_level ${gate_config.max_level} > 2 (shadow-Git deferred)`;
  return null;
}

export interface SeedResult {
  /** Rows actually inserted this call (0 on a re-seed — INSERT OR IGNORE). */
  readonly seeded: number;
  /** Capabilities skipped due to a resolution/consistency error. */
  readonly skipped: number;
  /** Human-readable error messages (also logged loudly by the caller). */
  readonly errors: string[];
}

/**
 * Seed `capability_autonomy` idempotently. For each capability: validate
 * invariants, resolve tool-backed keys against the live registry (fail loud into
 * `errors` — never crash boot), cross-check the backing tool is not `readOnlyHint`
 * (a gated write must mutate), then `INSERT OR IGNORE` (PK = capability).
 */
export function seedV83Capabilities(
  db: Database.Database,
  registry: ToolRegistry,
): SeedResult {
  const errors: string[] = [];
  let seeded = 0;
  let skipped = 0;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO capability_autonomy
      (capability, level, odd_predicate_json, gate_config_json, ux_confirm_flag,
       blast_radius, reversible_default, override_window_start_at, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
  `);

  for (const seed of CAPABILITY_SEEDS) {
    const invariant = assertSeedInvariants(seed);
    if (invariant) {
      errors.push(`invariant: ${invariant}`);
      skipped++;
      continue;
    }

    if (seed.backing.kind === "tool") {
      const tool = registry.get(seed.backing.tool_name);
      if (!tool) {
        errors.push(
          `${seed.capability}: backing tool '${seed.backing.tool_name}' not in registry`,
        );
        skipped++;
        continue;
      }
      if (getToolAnnotations(tool).readOnlyHint) {
        errors.push(
          `${seed.capability}: backing tool '${seed.backing.tool_name}' is readOnly — gated writes must mutate`,
        );
        skipped++;
        continue;
      }
    }

    const reversible = deriveReversibleDefault(seed.reversal_strategy) ? 1 : 0;
    const info = insert.run(
      seed.capability,
      seed.level,
      JSON.stringify(seed.odd_predicate),
      JSON.stringify(seed.gate_config),
      seed.ux_confirm_flag ? 1 : 0,
      seed.blast_radius,
      reversible,
      seed.description,
    );
    if (info.changes > 0) seeded++;
  }

  return { seeded, skipped, errors };
}
