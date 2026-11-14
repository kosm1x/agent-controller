/**
 * Directive proposal cooldown on the real `safeguard_state` table.
 *
 * jarvis-directives.test.ts stubs `prepare`, so it proves only which values
 * are bound. These cases run the cooldown SELECT and the timestamp upsert on
 * `initDatabase(":memory:")` and read the row back.
 *
 * The proposal file itself is never written: `upsertFile` is a recorder, and
 * the knowledge-base calls the propose tool must not make throw. The rest of
 * the module stays real because `initDatabase` seeds directives through it.
 * The cooldown compares two JavaScript clock readings, so Date is fixed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const kb = vi.hoisted(() => ({
  upsertFile: vi.fn(),
  refuse: (name: string) => () => {
    throw new Error(`${name} must not be called by the propose tool`);
  },
}));

vi.mock("../../db/jarvis-fs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db/jarvis-fs.js")>()),
  upsertFile: kb.upsertFile,
  getFile: kb.refuse("getFile"),
  deleteFile: kb.refuse("deleteFile"),
  listFiles: kb.refuse("listFiles"),
}));

import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import { jarvisProposeTool } from "./jarvis-directives.js";

const NOW = Date.parse("2026-03-10T18:00:00.000Z");
const HOUR = 3_600_000;
const KEY = "directive_last_proposal_at";
const OLD = "2000-01-01 00:00:00";
const SQLITE_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const args = {
  title: "Test Proposal",
  target_path: "directives/core.md",
  change_type: "modify",
  current_content: "old text",
  proposed_content: "new text",
  reason: "synthetic reason",
};

type StateRow = { key: string; value: string; updated_at: string };

function seed(key: string, value: string): void {
  getDatabase()
    .prepare(
      "INSERT INTO safeguard_state (key, value, updated_at) VALUES (?, ?, ?)",
    )
    .run(key, value, OLD);
}

const rows = () =>
  getDatabase()
    .prepare("SELECT key, value, updated_at FROM safeguard_state ORDER BY key")
    .all() as StateRow[];

const savedCooldown = process.env.DIRECTIVE_COOLDOWN_HOURS;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  process.env.DIRECTIVE_COOLDOWN_HOURS = "48";
  kb.upsertFile.mockReset();
  initDatabase(":memory:");
});

afterEach(() => {
  try {
    closeDatabase();
    vi.restoreAllMocks();
  } finally {
    vi.useRealTimers();
    if (savedCooldown === undefined) delete process.env.DIRECTIVE_COOLDOWN_HOURS;
    else process.env.DIRECTIVE_COOLDOWN_HOURS = savedCooldown;
  }
});

describe("jarvis_propose_directive on the real safeguard_state table", () => {
  it("a first proposal records its time under the cooldown key and leaves other keys alone", async () => {
    seed("other_guard", new Date(NOW - HOUR).toISOString());

    const out = await jarvisProposeTool.execute(args);

    expect(out).toContain("Propuesta creada");
    expect(kb.upsertFile).toHaveBeenCalledOnce();
    expect(kb.upsertFile.mock.calls[0][0]).toBe(
      "knowledge/proposals/2026-03-10-test-proposal.md",
    );
    const [cooldown, other] = rows();
    expect(other).toEqual({
      key: "other_guard",
      value: new Date(NOW - HOUR).toISOString(),
      updated_at: OLD,
    });
    expect(cooldown.key).toBe(KEY);
    expect(cooldown.value).toBe(new Date(NOW).toISOString());
    expect(cooldown.updated_at).toMatch(SQLITE_DATETIME);
    expect(rows()).toHaveLength(2);
  });

  it("a proposal inside the cooldown is refused and the stored time stays", async () => {
    await jarvisProposeTool.execute(args);
    vi.setSystemTime(NOW + 2 * HOUR);

    const out = await jarvisProposeTool.execute(args);

    expect(out).toContain("Cooldown active");
    expect(out).toContain("Last proposal was 2.0h ago.");
    expect(kb.upsertFile).toHaveBeenCalledOnce();
    expect(rows()).toEqual([
      expect.objectContaining({ key: KEY, value: new Date(NOW).toISOString() }),
    ]);
  });

  it("a proposal after the cooldown updates the one row in place", async () => {
    seed(KEY, new Date(NOW - 50 * HOUR).toISOString());

    const out = await jarvisProposeTool.execute(args);

    expect(out).toContain("Propuesta creada");
    expect(kb.upsertFile).toHaveBeenCalledOnce();
    const [row] = rows();
    expect(rows()).toHaveLength(1);
    expect(row.value).toBe(new Date(NOW).toISOString());
    expect(row.updated_at).toMatch(SQLITE_DATETIME);
    expect(row.updated_at).not.toBe(OLD);
  });
});
