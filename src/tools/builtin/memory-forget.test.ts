import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, initDatabase } from "../../db/index.js";

const pg = vi.hoisted(() => ({
  pgDelete: vi.fn(async () => true),
  isPgvectorEnabled: vi.fn(() => true),
}));
vi.mock("../../db/pgvector.js", () => pg);

import { addTriple, getEntityHistory, queryTriples } from "../../memory/knowledge-graph.js";
import { CORRECTION_PATH_RE, memoryForgetTool } from "./memory.js";

beforeEach(() => {
  initDatabase(":memory:");
  pg.pgDelete.mockClear();
  pg.isPgvectorEnabled.mockReturnValue(true);
});

afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
});

describe("memory_forget", () => {
  it("is confirm-gated, deferred and classified as a sensitive write", () => {
    expect(memoryForgetTool.requiresConfirmation).toBe(true);
    expect(memoryForgetTool.riskTier).toBe("high");
    expect(memoryForgetTool.deferred).toBe(true);
    expect(memoryForgetTool.destructiveHint).toBe(true);
    expect(memoryForgetTool.untrustedInputHint).toBe(false);
    expect(memoryForgetTool.sensitiveAccessHint).toBe(true);
  });

  it("invalidates the subject's active facts but keeps their history", async () => {
    addTriple("Cuatro Flor", "status_is", "paused");
    addTriple("Cuatro Flor", "owner_is", "operator");
    addTriple("Other", "status_is", "live");
    const out = JSON.parse(
      await memoryForgetTool.execute({ subject: "cuatro flor", reason: "wrong project" }),
    );
    expect(out.invalidated).toBe(2);
    expect(queryTriples({ subject: "cuatro flor" })).toHaveLength(0);
    expect(getEntityHistory("cuatro flor")).toHaveLength(2);
    expect(queryTriples({ subject: "other" })).toHaveLength(1);
  });

  it("narrows to one predicate when given", async () => {
    addTriple("Cuatro Flor", "status_is", "paused");
    addTriple("Cuatro Flor", "owner_is", "operator");
    const out = JSON.parse(
      await memoryForgetTool.execute({
        subject: "cuatro flor",
        predicate: "status_is",
        reason: "status wrong",
      }),
    );
    expect(out.invalidated).toBe(1);
    expect(queryTriples({ subject: "cuatro flor" })).toHaveLength(1);
  });

  it("deletes only correction-loop paths and never calls pgDelete for anything else", async () => {
    const bad = JSON.parse(
      await memoryForgetTool.execute({ correction_path: "notes/secret.md", reason: "x" }),
    );
    expect(bad.error).toMatch(/corrections\/<12 hex>/);
    expect(pg.pgDelete).not.toHaveBeenCalled();

    const ok = JSON.parse(
      await memoryForgetTool.execute({
        correction_path: "corrections/3386ce090f4b.md",
        reason: "wrong intent mapping",
      }),
    );
    expect(ok.correction_deleted).toBe(true);
    expect(pg.pgDelete).toHaveBeenCalledWith("corrections/3386ce090f4b.md");
    expect(CORRECTION_PATH_RE.test("corrections/3386ce090f4b.md")).toBe(true);
    expect(CORRECTION_PATH_RE.test("corrections/../x.md")).toBe(false);
    // Anchoring pins (qa-audit W-4: an unanchored mutant passed the suite).
    expect(CORRECTION_PATH_RE.test("evil/corrections/3386ce090f4b.md")).toBe(false);
    expect(CORRECTION_PATH_RE.test("corrections/3386ce090f4b.md/../../directives/core.md")).toBe(false);
    expect(CORRECTION_PATH_RE.test("corrections/3386ce090f4b.md\nnotes/secret.md")).toBe(false);
  });

  it("reports a disabled KB instead of pretending to delete", async () => {
    pg.isPgvectorEnabled.mockReturnValue(false);
    const out = JSON.parse(
      await memoryForgetTool.execute({ correction_path: "corrections/3386ce090f4b.md", reason: "x" }),
    );
    expect(out.correction_deleted).toBe(false);
    expect(pg.pgDelete).not.toHaveBeenCalled();
  });

  it("refuses a call with neither subject nor correction_path", async () => {
    const out = JSON.parse(await memoryForgetTool.execute({ reason: "x" }));
    expect(out.error).toMatch(/subject/);
  });
});

// Description pins: the tool's whole description text as registered, and the exact text of the parameters pinned below.
describe("tool description texts", () => {
  it("memory_forget carries exactly this description", () => {
    expect(memoryForgetTool.definition.function.description).toBe(
      [
        "Retract a WRONG memory — KG facts by subject and/or ONE corrections/<hash>.md; confirm first; not for user facts or files.",
        "",
        "Invalidates the ACTIVE knowledge-graph facts about a subject and/or deletes a rephrase-correction entry from the KB so it is never injected again.",
        "",
        "USE WHEN:",
        "- The user says a remembered fact is wrong (\"eso no es así\", \"olvida eso\", \"borra ese recuerdo\") and names the subject.",
        "- A correction stored by the correction loop (path corrections/<hash>.md) is wrong. Until now removing one needed a manual database delete.",
        "",
        "DO NOT USE WHEN:",
        "- The fact is a personal fact about the user (name, birthday, preference) → use user_fact_delete when it is among your tools.",
        "- The user wants to delete a KB note or file → use jarvis_file_delete when it is among your tools.",
        "",
        "Knowledge-graph invalidation is temporal (valid_to is stamped, history is kept). Correction deletion is permanent. Always confirm with the user first.",
      ].join("\n"),
    );
  });

  it("memory_forget property subject carries exactly this text", () => {
    const props = (
      memoryForgetTool.definition.function.parameters as {
        properties: Record<string, { description?: string }>;
      }
    ).properties;
    expect(props.subject?.description).toBe(
      "Knowledge-graph subject whose active facts to invalidate (case-insensitive, e.g. 'acme website'). Add predicate to narrow to one relation.",
    );
  });

  it("memory_forget property correction_path carries exactly this text", () => {
    const props = (
      memoryForgetTool.definition.function.parameters as {
        properties: Record<string, { description?: string }>;
      }
    ).properties;
    expect(props.correction_path?.description).toBe(
      "KB path of the correction entry to delete, exactly 'corrections/<12 lowercase hex chars>.md'.",
    );
  });
});
