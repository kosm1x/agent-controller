/**
 * V8.3 capability seed (Phase 0 + Phase 1).
 *
 * Asserts: the 6 capabilities seed at L1; tool-backed keys resolve against the
 * registry (fail loud into `errors`, never crash); a readOnly backing tool is
 * rejected (gated writes must mutate); `reversible_default` derives from the named
 * reversal strategy; `blast_radius`/`gate_config` persist per the §6 table; the
 * structural-safety invariants hold over every seed; and re-seeding is idempotent.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import type { Tool } from "../../tools/types.js";
import type { ToolRegistry } from "../../tools/registry.js";
import type { CapabilitySeed, GateConfig } from "./types.js";
import {
  CAPABILITY_SEEDS,
  assertSeedInvariants,
  seedV83Capabilities,
} from "./seed.js";

const TOOL_KEYS = [
  "gmail_send",
  "northstar_sync",
  "jarvis_file_delete",
  "skill_run",
  "schedule_task",
];

/**
 * Stub registry whose `get` returns a minimal write-tool (readOnlyHint:false) for
 * each known tool name. `missing` drops a name; `readOnly` flips one to readOnly.
 */
function fakeRegistry(
  opts: { missing?: string[]; readOnly?: string[] } = {},
): ToolRegistry {
  const missing = new Set(opts.missing ?? []);
  const readOnly = new Set(opts.readOnly ?? []);
  const map = new Map<string, Tool>();
  for (const name of TOOL_KEYS) {
    if (missing.has(name)) continue;
    map.set(name, {
      name,
      readOnlyHint: readOnly.has(name),
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    } as unknown as Tool);
  }
  return { get: (n: string) => map.get(n) } as unknown as ToolRegistry;
}

function rows() {
  return getDatabase()
    .prepare("SELECT * FROM capability_autonomy ORDER BY capability")
    .all() as Array<{
    capability: string;
    level: number;
    blast_radius: string;
    reversible_default: number;
    gate_config_json: string;
    odd_predicate_json: string;
    override_window_start_at: string;
  }>;
}

beforeEach(() => {
  initDatabase(":memory:");
});
afterEach(() => {
  closeDatabase();
});

describe("seedV83Capabilities — happy path", () => {
  it("seeds all 6 capabilities at L1 with no errors", () => {
    const result = seedV83Capabilities(getDatabase(), fakeRegistry());
    expect(result.errors).toEqual([]);
    expect(result.seeded).toBe(6);
    const r = rows();
    expect(r).toHaveLength(6);
    expect(r.every((x) => x.level === 1)).toBe(true);
    expect(r.map((x) => x.capability).sort()).toEqual(
      [
        "gmail_send",
        "jarvis_file_delete",
        "northstar_sync",
        "schedule_task",
        "skill_run",
        "task_edit",
      ].sort(),
    );
  });

  it("is idempotent — a second seed inserts nothing and keeps 6 rows", () => {
    seedV83Capabilities(getDatabase(), fakeRegistry());
    const second = seedV83Capabilities(getDatabase(), fakeRegistry());
    expect(second.seeded).toBe(0);
    expect(second.errors).toEqual([]);
    expect(rows()).toHaveLength(6);
  });

  it("derives reversible_default from the named reversal strategy", () => {
    seedV83Capabilities(getDatabase(), fakeRegistry());
    const byCap = new Map(
      rows().map((r) => [r.capability, r.reversible_default]),
    );
    // sql_inverse / delete_inverse / tri_restore ⇒ reversible (1)
    expect(byCap.get("task_edit")).toBe(1);
    expect(byCap.get("schedule_task")).toBe(1);
    expect(byCap.get("jarvis_file_delete")).toBe(1);
    // compensating / none ⇒ NOT auto-reversible (0)
    expect(byCap.get("gmail_send")).toBe(0);
    expect(byCap.get("northstar_sync")).toBe(0);
    expect(byCap.get("skill_run")).toBe(0);
  });

  it("persists the declared blast_radius per the §6 table", () => {
    seedV83Capabilities(getDatabase(), fakeRegistry());
    const byCap = new Map(rows().map((r) => [r.capability, r.blast_radius]));
    expect(byCap.get("gmail_send")).toBe("persistent");
    expect(byCap.get("northstar_sync")).toBe("persistent");
    expect(byCap.get("task_edit")).toBe("persistent");
    expect(byCap.get("jarvis_file_delete")).toBe("persistent");
    expect(byCap.get("skill_run")).toBe("session");
    expect(byCap.get("schedule_task")).toBe("self");
  });

  it("caps non-reversible + file-mutating capabilities at max_level ≤ 2", () => {
    seedV83Capabilities(getDatabase(), fakeRegistry());
    const cap = (c: string): GateConfig =>
      JSON.parse(rows().find((r) => r.capability === c)!.gate_config_json);
    expect(cap("gmail_send").max_level).toBe(2);
    expect(cap("northstar_sync").max_level).toBe(2);
    expect(cap("skill_run").max_level).toBe(2);
    expect(cap("jarvis_file_delete").max_level).toBe(2); // file-mutating
    expect(cap("task_edit").max_level).toBe(5);
    expect(cap("schedule_task").max_level).toBe(5);
  });

  it("persists odd_predicate as valid JSON", () => {
    seedV83Capabilities(getDatabase(), fakeRegistry());
    for (const r of rows()) {
      expect(() => JSON.parse(r.odd_predicate_json)).not.toThrow();
    }
    const taskEdit = rows().find((r) => r.capability === "task_edit")!;
    expect(JSON.parse(taskEdit.odd_predicate_json).op).toBe("and");
  });
});

describe("seedV83Capabilities — fail-loud resolution", () => {
  it("reports an error and skips a tool-backed capability missing from the registry", () => {
    const result = seedV83Capabilities(
      getDatabase(),
      fakeRegistry({ missing: ["gmail_send"] }),
    );
    expect(result.errors.some((e) => e.includes("gmail_send"))).toBe(true);
    expect(result.skipped).toBe(1);
    expect(result.seeded).toBe(5);
    expect(rows().some((r) => r.capability === "gmail_send")).toBe(false);
  });

  it("rejects a backing tool that is readOnly (gated writes must mutate)", () => {
    const result = seedV83Capabilities(
      getDatabase(),
      fakeRegistry({ readOnly: ["schedule_task"] }),
    );
    expect(result.errors.some((e) => /schedule_task.*readOnly/i.test(e))).toBe(
      true,
    );
    expect(rows().some((r) => r.capability === "schedule_task")).toBe(false);
  });

  it("never throws — boot resilience even with all tools missing", () => {
    expect(() =>
      seedV83Capabilities(getDatabase(), fakeRegistry({ missing: TOOL_KEYS })),
    ).not.toThrow();
    // task_edit is internal (no tool) so it still seeds; the 5 tool-backed skip.
    expect(rows().map((r) => r.capability)).toEqual(["task_edit"]);
  });
});

describe("CAPABILITY_SEEDS — structural invariants", () => {
  it("all seeds are valid (assertSeedInvariants returns null)", () => {
    for (const seed of CAPABILITY_SEEDS) {
      expect(assertSeedInvariants(seed)).toBeNull();
    }
  });

  it("all seeds default to L1", () => {
    expect(CAPABILITY_SEEDS.every((s) => s.level === 1)).toBe(true);
  });

  it("tool-backed keys name themselves; task_edit is the only internal action", () => {
    for (const seed of CAPABILITY_SEEDS) {
      if (seed.backing.kind === "tool") {
        expect(seed.backing.tool_name).toBe(seed.capability);
      } else {
        expect(seed.capability).toBe("task_edit");
      }
    }
  });

  it("flags a non-reversible capability allowed above L2", () => {
    const bad: CapabilitySeed = {
      ...CAPABILITY_SEEDS[0],
      capability: "bad",
      reversal_strategy: "none",
      gate_config: { reversible_required: true, max_level: 5 },
    };
    expect(assertSeedInvariants(bad)).toMatch(/not auto-reversible/);
  });

  it("flags a file-mutating capability allowed above L2", () => {
    const bad: CapabilitySeed = {
      ...CAPABILITY_SEEDS[2], // task_edit: sql_inverse (reversible)
      capability: "badfile",
      file_mutating: true,
      gate_config: { reversible_required: true, max_level: 4 },
    };
    expect(assertSeedInvariants(bad)).toMatch(/file-mutating/);
  });

  it("flags a level above its own max_level", () => {
    const bad: CapabilitySeed = {
      ...CAPABILITY_SEEDS[2],
      capability: "overlevel",
      level: 4,
      gate_config: { reversible_required: true, max_level: 2 },
    };
    expect(assertSeedInvariants(bad)).toMatch(/exceeds gate_config\.max_level/);
  });
});
