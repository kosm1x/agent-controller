import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockAll = vi.hoisted(() => ({
  upsertFile: vi.fn(),
  getFile: vi.fn(),
  deleteFile: vi.fn(),
  listFiles: vi.fn().mockReturnValue([]),
  dbGet: vi.fn(),
  dbRun: vi.fn(),
  dbPrepare: vi.fn(),
}));

vi.mock("../../db/jarvis-fs.js", () => ({
  upsertFile: mockAll.upsertFile,
  getFile: mockAll.getFile,
  deleteFile: mockAll.deleteFile,
  listFiles: mockAll.listFiles,
}));

vi.mock("../../db/index.js", () => ({
  getDatabase: () => ({ prepare: mockAll.dbPrepare }),
}));

import { jarvisProposeTool } from "./jarvis-directives.js";

describe("jarvis_propose_directive cooldown (SG4)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no prior proposal
    mockAll.dbGet.mockReturnValue(undefined);
    mockAll.dbPrepare.mockImplementation(() => ({
      get: (...a: unknown[]) => mockAll.dbGet(...a),
      run: (...a: unknown[]) => mockAll.dbRun(...a),
    }));
    // Set short cooldown for tests
    process.env.DIRECTIVE_COOLDOWN_HOURS = "48";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.DIRECTIVE_COOLDOWN_HOURS = originalEnv.DIRECTIVE_COOLDOWN_HOURS;
  });

  const validArgs = {
    title: "Test Proposal",
    target_path: "directives/core.md",
    change_type: "modify",
    current_content: "old text",
    proposed_content: "new text",
    reason: "Testing cooldown",
  };

  it("allows first proposal with no prior record", async () => {
    const result = await jarvisProposeTool.execute(validArgs);
    expect(result).toContain("Propuesta creada");
    expect(mockAll.upsertFile).toHaveBeenCalledOnce();
  });

  it("blocks proposal within cooldown period", async () => {
    // Simulate proposal 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    mockAll.dbGet.mockReturnValue({ value: twoHoursAgo.toISOString() });

    const result = await jarvisProposeTool.execute(validArgs);
    expect(result).toContain("Cooldown active");
    expect(result).toContain("2.0h ago");
    expect(mockAll.upsertFile).not.toHaveBeenCalled();
  });

  it("allows proposal after cooldown expires", async () => {
    // Simulate proposal 50 hours ago (> 48h cooldown)
    const fiftyHoursAgo = new Date(Date.now() - 50 * 60 * 60 * 1000);
    mockAll.dbGet.mockReturnValue({ value: fiftyHoursAgo.toISOString() });

    const result = await jarvisProposeTool.execute(validArgs);
    expect(result).toContain("Propuesta creada");
    expect(mockAll.upsertFile).toHaveBeenCalledOnce();
  });

  it("records timestamp after successful proposal", async () => {
    await jarvisProposeTool.execute(validArgs);
    // dbPrepare is called twice: once for cooldown check, once for recording
    expect(mockAll.dbRun).toHaveBeenCalled();
  });

  it("respects DIRECTIVE_COOLDOWN_HOURS=0 (disabled)", async () => {
    process.env.DIRECTIVE_COOLDOWN_HOURS = "0";
    // Even with a recent proposal, cooldown=0 skips check
    const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000);
    mockAll.dbGet.mockReturnValue({ value: oneHourAgo.toISOString() });

    const result = await jarvisProposeTool.execute(validArgs);
    expect(result).toContain("Propuesta creada");
  });

  it("proceeds if safeguard_state table is missing", async () => {
    mockAll.dbPrepare.mockImplementation((sql: string) => {
      if (sql.includes("safeguard_state")) throw new Error("no such table");
      return { get: vi.fn(), run: vi.fn() };
    });

    const result = await jarvisProposeTool.execute(validArgs);
    expect(result).toContain("Propuesta creada");
  });
});
