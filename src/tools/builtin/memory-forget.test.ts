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
