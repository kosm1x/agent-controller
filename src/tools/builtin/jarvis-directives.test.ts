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

import {
  jarvisProposeTool,
  jarvisApplyProposalTool,
} from "./jarvis-directives.js";

/** A whole-call failure: one error object, `error` its first and only key. */
function errorText(result: string): string {
  expect(result.startsWith('{"error":')).toBe(true);
  const parsed = JSON.parse(result) as Record<string, unknown>;
  expect(Object.keys(parsed)).toEqual(["error"]);
  return parsed.error as string;
}

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
    // The success text stays plain text, not an error object.
    expect(result.startsWith("📝 **Propuesta creada:** Test Proposal\n")).toBe(
      true,
    );
    expect(mockAll.upsertFile).toHaveBeenCalledOnce();
  });

  it("blocks proposal within cooldown period", async () => {
    // Simulate proposal 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    mockAll.dbGet.mockReturnValue({ value: twoHoursAgo.toISOString() });

    const result = await jarvisProposeTool.execute(validArgs);
    expect(result.startsWith("{")).toBe(false);
    expect(result).toBe(
      "⏳ Cooldown active.\nLast proposal was 2.0h ago.\nNext allowed in 46.0h.\n(Cooldown: 48h)",
    );
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

  it("refuses the proposal when the cooldown state cannot be read (fails closed)", async () => {
    // An unreadable cooldown is not an expired one: the rate limit must hold.
    mockAll.dbPrepare.mockImplementation((sql: string) => {
      if (sql.startsWith("SELECT value FROM safeguard_state")) {
        throw new Error("database disk image is malformed");
      }
      return {
        get: (...a: unknown[]) => mockAll.dbGet(...a),
        run: (...a: unknown[]) => mockAll.dbRun(...a),
      };
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await jarvisProposeTool.execute(validArgs);
    expect(result.startsWith("{")).toBe(false);
    expect(result).toBe(
      "❌ Could not verify the proposal cooldown — proposal not created. Try again later.",
    );
    expect(mockAll.upsertFile).not.toHaveBeenCalled();
    expect(mockAll.dbRun).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("database disk image is malformed"),
    );
  });

  it("refuses the proposal when the stored cooldown timestamp is not a valid date", async () => {
    mockAll.dbGet.mockReturnValue({ value: "not-a-date" });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await jarvisProposeTool.execute(validArgs);
    expect(result.startsWith("{")).toBe(false);
    expect(result).toBe(
      "❌ Could not verify the proposal cooldown — proposal not created. Try again later.",
    );
    expect(mockAll.upsertFile).not.toHaveBeenCalled();
    expect(mockAll.dbRun).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledOnce();
    // The stored value itself is never logged.
    expect(String(errSpy.mock.calls[0][0])).not.toContain("not-a-date");
  });

  it("keeps the default cooldown when DIRECTIVE_COOLDOWN_HOURS is not a number", async () => {
    process.env.DIRECTIVE_COOLDOWN_HOURS = "forty-eight";
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    mockAll.dbGet.mockReturnValue({ value: twoHoursAgo.toISOString() });

    const result = await jarvisProposeTool.execute(validArgs);
    expect(result.startsWith("{")).toBe(false);
    expect(result).toBe(
      "⏳ Cooldown active.\nLast proposal was 2.0h ago.\nNext allowed in 46.0h.\n(Cooldown: 48h)",
    );
    expect(mockAll.upsertFile).not.toHaveBeenCalled();
  });

  it("keeps the default cooldown when DIRECTIVE_COOLDOWN_HOURS is empty", async () => {
    process.env.DIRECTIVE_COOLDOWN_HOURS = "";
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    mockAll.dbGet.mockReturnValue({ value: twoHoursAgo.toISOString() });

    const result = await jarvisProposeTool.execute(validArgs);
    expect(result.startsWith("{")).toBe(false);
    expect(result).toBe(
      "⏳ Cooldown active.\nLast proposal was 2.0h ago.\nNext allowed in 46.0h.\n(Cooldown: 48h)",
    );
    expect(mockAll.upsertFile).not.toHaveBeenCalled();
  });

  it("logs the error but keeps the proposal when recording the cooldown timestamp fails", async () => {
    mockAll.dbRun.mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await jarvisProposeTool.execute(validArgs);
    expect(result).toContain("Propuesta creada");
    expect(mockAll.upsertFile).toHaveBeenCalledOnce();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("database is locked"),
    );
  });
});

describe("jarvis_apply_proposal failures are one error object", () => {
  const PROPOSAL_PATH = "knowledge/proposals/2026-11-21-test-proposal.md";
  const proposalText = (type: string): string =>
    [
      "# Proposal: Test Proposal",
      "",
      "**Target:** directives/core.md",
      `**Type:** ${type}`,
      "",
      "## Current Content",
      "<<<CURRENT>>>",
      "old text",
      "<<<END_CURRENT>>>",
      "",
      "## Proposed Content",
      "<<<PROPOSED>>>",
      "new text",
      "<<<END_PROPOSED>>>",
    ].join("\n");
  const target = {
    title: "Core",
    content: "old text here",
    tags: "[]",
    qualifier: "reference",
    priority: 50,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAll.listFiles.mockReturnValue([{ path: PROPOSAL_PATH }]);
    mockAll.upsertFile.mockImplementation(() => {});
    mockAll.deleteFile.mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockAll.listFiles.mockReturnValue([]);
    mockAll.getFile.mockReset();
    mockAll.upsertFile.mockReset();
  });

  /** getFile answers the proposal path and the target path separately. */
  function files(proposal: unknown, targetFile: unknown): void {
    mockAll.getFile.mockImplementation((path: string) =>
      path === PROPOSAL_PATH ? proposal : targetFile,
    );
  }

  function expectNoWrite(): void {
    expect(mockAll.upsertFile).not.toHaveBeenCalled();
    expect(mockAll.deleteFile).not.toHaveBeenCalled();
  }

  it("a proposal that is not there", async () => {
    mockAll.listFiles.mockReturnValue([]);
    const result = await jarvisApplyProposalTool.execute({
      proposal_slug: "test-proposal",
    });
    expect(errorText(result)).toBe(
      'Proposal "test-proposal" not found in knowledge/proposals/.',
    );
    expectNoWrite();
  });

  it("a proposal that cannot be read", async () => {
    files(null, target);
    const result = await jarvisApplyProposalTool.execute({
      proposal_slug: "test-proposal",
    });
    expect(errorText(result)).toBe(`Could not read proposal at ${PROPOSAL_PATH}.`);
    expectNoWrite();
  });

  it("a proposal without a target or a type", async () => {
    files({ content: "# Proposal: no fields" }, target);
    const result = await jarvisApplyProposalTool.execute({
      proposal_slug: "test-proposal",
    });
    expect(errorText(result)).toBe(
      "Could not parse proposal — missing target or type.",
    );
    expectNoWrite();
  });

  it("a modify proposal whose target file is missing", async () => {
    files({ content: proposalText("modify") }, null);
    const result = await jarvisApplyProposalTool.execute({
      proposal_slug: "test-proposal",
    });
    expect(errorText(result)).toBe("Target file directives/core.md not found.");
    expectNoWrite();
  });

  it("a remove proposal whose target file is missing", async () => {
    files({ content: proposalText("remove") }, null);
    const result = await jarvisApplyProposalTool.execute({
      proposal_slug: "test-proposal",
    });
    expect(errorText(result)).toBe("Target file directives/core.md not found.");
    expectNoWrite();
  });

  it("a write that throws", async () => {
    files({ content: proposalText("add") }, target);
    mockAll.upsertFile.mockImplementation(() => {
      throw new Error("disk full");
    });
    const result = await jarvisApplyProposalTool.execute({
      proposal_slug: "test-proposal",
    });
    expect(errorText(result)).toBe("Failed to apply: disk full");
    expect(mockAll.upsertFile).toHaveBeenCalledOnce();
    expect(mockAll.deleteFile).not.toHaveBeenCalled();
  });

  it("success stays plain text", async () => {
    files({ content: proposalText("add") }, null);
    const result = await jarvisApplyProposalTool.execute({
      proposal_slug: "test-proposal",
    });
    const lines = result.split("\n");
    expect(lines[0]).toBe("✅ **Propuesta aplicada:** test-proposal");
    expect(lines[1]).toBe("Target: directives/core.md (add)");
    expect(lines[2]).toMatch(
      /^Decision logged: logs\/decisions\/\d{4}-\d{2}-\d{2}-test-proposal\.md$/,
    );
    expect(lines).toHaveLength(3);
    expect(mockAll.deleteFile).toHaveBeenCalledWith(PROPOSAL_PATH);
  });
});
