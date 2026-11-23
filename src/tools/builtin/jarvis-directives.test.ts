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
  const OLDER_PATH = "knowledge/proposals/2026-11-20-test-proposal.md";
  /** `current` null leaves the Current block out; "" gives an empty block. */
  const proposalText = (
    type: string,
    current: string | null = "old text",
  ): string =>
    [
      "# Proposal: Test Proposal",
      "",
      "**Target:** directives/core.md",
      `**Type:** ${type}`,
      "",
      ...(current === null
        ? []
        : [
            "## Current Content",
            "<<<CURRENT>>>",
            current,
            "<<<END_CURRENT>>>",
            "",
          ]),
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
  function files(
    proposal: unknown,
    targetFile: unknown,
    proposalPath = PROPOSAL_PATH,
  ): void {
    mockAll.getFile.mockImplementation((path: string) =>
      path === proposalPath ? proposal : targetFile,
    );
  }

  /** The proposal paths getFile was asked for. */
  function proposalsRead(): string[] {
    return mockAll.getFile.mock.calls
      .map((c) => c[0] as string)
      .filter((p) => p.startsWith("knowledge/proposals/"));
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

  const apply = (name: unknown): Promise<string> =>
    jarvisApplyProposalTool.execute({ proposal_slug: name });

  for (const [label, current] of [
    ["without a current-content block", null],
    ["whose current-content block is empty", ""],
  ] as const) {
    it(`a modify proposal ${label} is refused before any write`, async () => {
      files({ content: proposalText("modify", current) }, target);
      expect(errorText(await apply("test-proposal"))).toBe(
        `Proposal at ${PROPOSAL_PATH} is a modify without current content — nothing applied. Propose it again with the text to replace.`,
      );
      expectNoWrite();
    });

    it(`a remove proposal ${label} is refused before any write`, async () => {
      files({ content: proposalText("remove", current) }, target);
      expect(errorText(await apply("test-proposal"))).toBe(
        `Proposal at ${PROPOSAL_PATH} is a remove without current content — nothing applied. Propose it again with the text to remove.`,
      );
      expectNoWrite();
    });
  }

  for (const type of ["modify", "remove"]) {
    it(`a ${type} proposal whose current text is not in the target is refused before any write`, async () => {
      files({ content: proposalText(type, "absent text") }, target);
      expect(errorText(await apply("test-proposal"))).toBe(
        `The current content in ${PROPOSAL_PATH} is not in directives/core.md — nothing applied.`,
      );
      expectNoWrite();
    });
  }

  it("a proposal with an unknown type word is refused before any write", async () => {
    files({ content: proposalText("rename") }, target);
    expect(errorText(await apply("test-proposal"))).toBe(
      `Proposal at ${PROPOSAL_PATH} has the unknown type "rename" — nothing applied.`,
    );
    expectNoWrite();
  });

  it("a modify writes the replaced text, then the decision log, then deletes the proposal", async () => {
    files({ content: proposalText("modify") }, target);
    const lines = (await apply("test-proposal")).split("\n");
    expect(lines[0]).toBe("✅ **Propuesta aplicada:** test-proposal");
    expect(lines[1]).toBe("Target: directives/core.md (modify)");
    expect(lines).toHaveLength(3);
    expect(mockAll.upsertFile).toHaveBeenCalledTimes(2);
    expect(mockAll.upsertFile.mock.calls[0]).toEqual([
      "directives/core.md",
      "Core",
      "new text here",
      [],
      "reference",
      50,
    ]);
    expect(mockAll.upsertFile.mock.calls[1][0]).toMatch(
      /^logs\/decisions\/\d{4}-\d{2}-\d{2}-test-proposal\.md$/,
    );
    expect(mockAll.deleteFile).toHaveBeenCalledOnce();
    expect(mockAll.deleteFile).toHaveBeenCalledWith(PROPOSAL_PATH);
    expect(mockAll.upsertFile.mock.invocationCallOrder[1]).toBeLessThan(
      mockAll.deleteFile.mock.invocationCallOrder[0],
    );
  });

  it("a modify replaces every occurrence of the current text", async () => {
    files(
      { content: proposalText("modify") },
      { ...target, content: "old text, then old text again" },
    );
    await apply("test-proposal");
    expect(mockAll.upsertFile.mock.calls[0][2]).toBe(
      "new text, then new text again",
    );
  });

  it("an add appends the new text to an existing target", async () => {
    files({ content: proposalText("add") }, target);
    await apply("test-proposal");
    expect(mockAll.upsertFile.mock.calls[0][0]).toBe("directives/core.md");
    expect(mockAll.upsertFile.mock.calls[0][2]).toBe("old text here\nnew text");
    expect(mockAll.deleteFile).toHaveBeenCalledWith(PROPOSAL_PATH);
  });

  it("a remove deletes the current text and trims the rest", async () => {
    files({ content: proposalText("remove") }, target);
    const result = await apply("test-proposal");
    expect(result.split("\n")[1]).toBe("Target: directives/core.md (remove)");
    expect(mockAll.upsertFile.mock.calls[0][0]).toBe("directives/core.md");
    expect(mockAll.upsertFile.mock.calls[0][2]).toBe("here");
    expect(mockAll.deleteFile).toHaveBeenCalledWith(PROPOSAL_PATH);
  });

  it("an empty or missing name is refused before the proposals are listed", async () => {
    // A proposal whose name part is empty exists, so only the refusal keeps
    // an empty name from applying it.
    const emptyNamePath = "knowledge/proposals/2026-11-21-.md";
    mockAll.listFiles.mockReturnValue([{ path: emptyNamePath }]);
    files({ content: proposalText("add") }, target, emptyNamePath);
    for (const name of ["", undefined]) {
      expect(errorText(await apply(name))).toBe(
        "No proposal name given — nothing applied.",
      );
    }
    expect(mockAll.listFiles).not.toHaveBeenCalled();
    expect(mockAll.getFile).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it("a name that is only part of a proposal's path is not found", async () => {
    files({ content: proposalText("add") }, target);
    for (const name of [
      "t",
      "test",
      "proposals",
      "knowledge/proposals/",
      "2026-11-21",
      "-",
      ".md",
    ]) {
      expect(errorText(await apply(name))).toBe(
        `Proposal "${name}" not found in knowledge/proposals/.`,
      );
    }
    expect(mockAll.getFile).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it("two proposals with the same name part are refused, naming both dated names", async () => {
    mockAll.listFiles.mockReturnValue([
      { path: OLDER_PATH },
      { path: PROPOSAL_PATH },
    ]);
    files({ content: proposalText("add") }, target);
    expect(errorText(await apply("test-proposal"))).toBe(
      '2 proposals match "test-proposal" — nothing applied. Pass one of these names: 2026-11-20-test-proposal, 2026-11-21-test-proposal.',
    );
    expect(mockAll.getFile).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it("the dated name applies that proposal and no other", async () => {
    mockAll.listFiles.mockReturnValue([
      { path: OLDER_PATH },
      { path: PROPOSAL_PATH },
    ]);
    files({ content: proposalText("add") }, target);
    await apply("2026-11-21-test-proposal");
    expect(proposalsRead()).toEqual([PROPOSAL_PATH]);
    expect(mockAll.deleteFile).toHaveBeenCalledOnce();
    expect(mockAll.deleteFile).toHaveBeenCalledWith(PROPOSAL_PATH);
  });

  it("a name that starts a longer one applies the exact one, even when the longer is listed first", async () => {
    const shortPath = "knowledge/proposals/2026-11-21-test.md";
    mockAll.listFiles.mockReturnValue([
      { path: OLDER_PATH },
      { path: shortPath },
    ]);
    files({ content: proposalText("add") }, target, shortPath);
    await apply("test");
    expect(proposalsRead()).toEqual([shortPath]);
    expect(mockAll.deleteFile).toHaveBeenCalledOnce();
    expect(mockAll.deleteFile).toHaveBeenCalledWith(shortPath);
  });

  it("the full path applies that proposal and no other", async () => {
    mockAll.listFiles.mockReturnValue([
      { path: OLDER_PATH },
      { path: PROPOSAL_PATH },
    ]);
    files({ content: proposalText("add") }, target);
    await apply(PROPOSAL_PATH);
    expect(proposalsRead()).toEqual([PROPOSAL_PATH]);
    expect(mockAll.deleteFile).toHaveBeenCalledOnce();
    expect(mockAll.deleteFile).toHaveBeenCalledWith(PROPOSAL_PATH);
  });

  it("a proposal in a sub-folder is named by its path below the proposals folder", async () => {
    // The leading date is dropped only at the start of that path, so the
    // sub-folder stays part of the name.
    const subPath = "knowledge/proposals/sub/2026-11-21-test-proposal.md";
    mockAll.listFiles.mockReturnValue([{ path: subPath }]);
    files({ content: proposalText("add") }, target, subPath);
    expect(errorText(await apply("test-proposal"))).toBe(
      'Proposal "test-proposal" not found in knowledge/proposals/.',
    );
    expectNoWrite();
    await apply("sub/2026-11-21-test-proposal");
    expect(mockAll.deleteFile).toHaveBeenCalledOnce();
    expect(mockAll.deleteFile).toHaveBeenCalledWith(subPath);
  });

  it("only the leading date is cut from a name part, and the case of the name counts", async () => {
    const datePart = "knowledge/proposals/2026-11-21-2026-11-20-plan.md";
    const digitPart = "knowledge/proposals/2026-11-21-2026-plan.md";
    mockAll.listFiles.mockReturnValue([
      { path: datePart },
      { path: digitPart },
      { path: PROPOSAL_PATH },
    ]);
    files({ content: proposalText("add") }, target, datePart);
    for (const name of ["plan", "11-20-plan", "Test-Proposal"]) {
      expect(errorText(await apply(name))).toBe(
        `Proposal "${name}" not found in knowledge/proposals/.`,
      );
    }
    expectNoWrite();
    await apply("2026-11-20-plan");
    expect(proposalsRead()).toEqual([datePart]);
    expect(mockAll.deleteFile).toHaveBeenCalledOnce();
    expect(mockAll.deleteFile).toHaveBeenCalledWith(datePart);
  });
});

// Whole-text pins: these descriptions are what the model reads when it
// chooses a tool. No handler is called.
describe("jarvis_propose_directive and jarvis_apply_proposal — description text", () => {
  it("jarvis_propose_directive: the whole description, with its not-for block", () => {
    expect(jarvisProposeTool.definition.function.description).toBe(`Propose a change to your own directives or SOPs. Does NOT apply immediately — requires user approval.

USE WHEN:
- You notice a recurring pattern that should be a directive (e.g., hallucination nudge keeps firing)
- You want to add/modify a Knowledge Base SOP based on experience
- Overnight tuning identifies a behavioral improvement

WORKFLOW:
1. Call jarvis_propose_directive with the proposal
2. You tell the user what you proposed (this tool sends no message itself)
3. User says "aprueba la propuesta" → use jarvis_apply_proposal when it is among your tools
4. Change is applied + logged in decisions/

CONSTRAINT: You can ONLY propose. You CANNOT modify directives directly.
Proposals go to knowledge/proposals/ where the user reviews them.

DO NOT USE WHEN:
- The change should take effect now: this tool only saves a proposal and does not change the target file.
- The target is code or any other file outside the knowledge base: proposals apply only to knowledge-base files.
- A modify or remove without the exact current text: without current_content the proposal is saved but cannot be applied — read the target first; use jarvis_file_read when it is among your tools.
- The text to change appears more than once and only one place should change: applying changes every occurrence of current_content.

AFTER PROPOSING: Tell the user what you proposed and ask for approval.`);
  });

  it("jarvis_apply_proposal: the whole description, with its not-for block", () => {
    expect(jarvisApplyProposalTool.definition.function.description).toBe(`Apply an approved directive proposal. Only call this AFTER the user explicitly approves.

USE WHEN:
- User says "aprueba la propuesta X" or "aprueba" after reviewing a proposal

NEVER call this without explicit user approval in the current message.

DO NOT USE WHEN:
- No proposal exists yet for the change: this tool only applies a proposal already saved under knowledge/proposals/, found by its exact name — use jarvis_propose_directive when it is among your tools.
- The user asks for changes to the proposal: this tool applies the saved text exactly and takes no new text.`);
  });
});
