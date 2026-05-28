/**
 * v7.7 Spine 3 Phase 4 Bundle 2 — builtin-tool tests for the L1/L2/exec
 * trio (`skill_describe`, `skill_load`, `skill_run`).
 *
 * These tests verify the JSON-envelope contract that the LLM sees. The
 * dispatcher itself is tested separately in `src/skills/dispatcher.test.ts`;
 * here we only verify the wrapping + arg validation layer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import { skillDescribeTool } from "./skill-describe.js";
import { skillLoadTool } from "./skill-load.js";
import { skillRunTool } from "./skill-run.js";
import { infer } from "../../inference/adapter.js";

vi.mock("../../inference/adapter.js", () => ({
  infer: vi.fn(),
}));

const mockInfer = vi.mocked(infer);

let testKbDir: string;

beforeEach(() => {
  testKbDir = mkdtempSync(join(tmpdir(), "mc-skill-dispatch-tools-"));
  process.env.JARVIS_KB_MIRROR_DIR = testKbDir;
  initDatabase(":memory:");
  mockInfer.mockReset();
});

afterEach(() => {
  closeDatabase();
  rmSync(testKbDir, { recursive: true, force: true });
  delete process.env.JARVIS_KB_MIRROR_DIR;
});

/**
 * Seed a fully-formed Phase 4-shaped skill (active, certified, with a
 * current_version_id pointer). Returns the skill_id.
 */
function seedSkill(opts: {
  name: string;
  inputsJson?: string;
  body?: string;
  triggerExamples?: string[];
  toolsUsed?: string[];
  certified?: boolean;
  active?: boolean;
}): string {
  const db = getDatabase();
  const skillId = `${opts.name}-id`;
  const inputsJson = opts.inputsJson ?? "[]";
  const triggerExamples = JSON.stringify(opts.triggerExamples ?? []);
  db.prepare(
    `INSERT INTO skills (
       skill_id, name, description, trigger_text, steps, tools, source,
       version, inputs_json, output_type, trigger_examples_json,
       tests_json, is_certified, active
     ) VALUES (?, ?, 'desc', 'trigger', '[]', '[]', 'manual',
              '1.0.0', ?, 'text', ?, '[]', ?, ?)`,
  ).run(
    skillId,
    opts.name,
    inputsJson,
    triggerExamples,
    (opts.certified ?? true) ? 1 : 0,
    (opts.active ?? true) ? 1 : 0,
  );

  const result = db
    .prepare(
      `INSERT INTO skill_versions (
         skill_id, version, body, body_sha256, inputs_json, tests_json,
         tools_used_json, created_by, critic_verdict
       ) VALUES (?, '1.0.0', ?, 'sha', ?, '[]', ?, 'operator', 'pass')`,
    )
    .run(
      skillId,
      opts.body ?? "# Steps\n1. Echo input.",
      inputsJson,
      JSON.stringify(opts.toolsUsed ?? []),
    );
  db.prepare("UPDATE skills SET current_version_id = ? WHERE skill_id = ?").run(
    Number(result.lastInsertRowid),
    skillId,
  );
  return skillId;
}

describe("skill_describe builtin", () => {
  it("returns the L1 envelope for an existing skill", async () => {
    seedSkill({ name: "echo-skill" });
    const raw = await skillDescribeTool.execute({ name: "echo-skill" });
    const parsed = JSON.parse(raw);
    expect(parsed.ok).toBe(true);
    expect(parsed.skill.name).toBe("echo-skill");
    expect(parsed.skill.version).toBe("1.0.0");
    expect(parsed.skill.is_certified).toBe(true);
    expect(parsed.skill.active).toBe(true);
    expect(Array.isArray(parsed.skill.inputs)).toBe(true);
  });

  it("returns ok:false skill_not_found on missing name", async () => {
    const raw = await skillDescribeTool.execute({ name: "nope" });
    expect(JSON.parse(raw)).toEqual({
      ok: false,
      reason: "skill_not_found",
      name: "nope",
    });
  });

  it("rejects missing/non-string name", async () => {
    const raw1 = await skillDescribeTool.execute({});
    expect(JSON.parse(raw1).ok).toBe(false);
    const raw2 = await skillDescribeTool.execute({ name: 123 });
    expect(JSON.parse(raw2).ok).toBe(false);
  });

  it("parses the inputs declaration into structured JSON", async () => {
    const inputs = JSON.stringify([
      { name: "msg", type: "string", required: true },
    ]);
    seedSkill({ name: "with-inputs", inputsJson: inputs });
    const raw = await skillDescribeTool.execute({ name: "with-inputs" });
    const parsed = JSON.parse(raw);
    expect(parsed.skill.inputs).toEqual([
      { name: "msg", type: "string", required: true },
    ]);
  });
});

describe("skill_load builtin", () => {
  it("returns the L2 envelope with body + triggers + tools", async () => {
    seedSkill({
      name: "echo-skill",
      body: "# Steps\n1. Do thing.",
      triggerExamples: ["echo this", "say back the input"],
      toolsUsed: ["http_get"],
    });
    const raw = await skillLoadTool.execute({ name: "echo-skill" });
    const parsed = JSON.parse(raw);
    expect(parsed.ok).toBe(true);
    expect(parsed.skill.body).toContain("Steps");
    expect(parsed.skill.trigger_examples).toEqual([
      "echo this",
      "say back the input",
    ]);
    expect(parsed.skill.tools_used).toEqual(["http_get"]);
  });

  it("returns skill_not_found on missing name", async () => {
    const raw = await skillLoadTool.execute({ name: "missing" });
    expect(JSON.parse(raw).reason).toBe("skill_not_found");
  });

  it("returns version_not_found when explicit version doesn't exist", async () => {
    seedSkill({ name: "echo-skill" });
    const raw = await skillLoadTool.execute({
      name: "echo-skill",
      version: "9.9.9",
    });
    expect(JSON.parse(raw).reason).toBe("version_not_found");
  });

  it("returns no_active_version when current_version_id is NULL", async () => {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO skills (
         skill_id, name, description, trigger_text, steps, tools, source,
         version, inputs_json, output_type, trigger_examples_json,
         tests_json, is_certified, active, current_version_id
       ) VALUES ('orphan-id', 'orphan-skill', 'desc', 't', '[]', '[]', 'manual',
                '1.0.0', '[]', 'text', '[]', '[]', 0, 1, NULL)`,
    ).run();
    const raw = await skillLoadTool.execute({ name: "orphan-skill" });
    expect(JSON.parse(raw).reason).toBe("no_active_version");
  });

  it("returns version_pointer_dangling when current_version_id points to a deleted skill_versions row", async () => {
    // Defensive branch — current_version_id should always satisfy the FK,
    // but if the row gets deleted out from under the pointer (e.g. manual
    // SQL cleanup, partial rollback), we surface a typed reason instead of
    // crashing on a null versionRow. Without an FK CASCADE this can happen.
    seedSkill({ name: "echo-skill" });
    const db = getDatabase();
    // Repoint to a non-existent version row.
    db.prepare(
      "UPDATE skills SET current_version_id = 999999 WHERE name = ?",
    ).run("echo-skill");

    const raw = await skillLoadTool.execute({ name: "echo-skill" });
    const parsed = JSON.parse(raw);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe("version_pointer_dangling");
    expect(parsed.currentVersionId).toBe(999999);
  });
});

describe("skill_run builtin", () => {
  it("dispatches successfully and returns the LLM JSON output", async () => {
    seedSkill({ name: "echo-skill" });
    mockInfer.mockResolvedValueOnce({
      content: '{"echoed": "hi"}',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    } as unknown as Awaited<ReturnType<typeof infer>>);

    const raw = await skillRunTool.execute({
      name: "echo-skill",
      args: {},
    });
    const parsed = JSON.parse(raw);
    expect(parsed.ok).toBe(true);
    expect(parsed.output).toEqual({ echoed: "hi" });
    expect(parsed.skillName).toBe("echo-skill");
  });

  it("rejects missing name with input_validation envelope", async () => {
    const raw = await skillRunTool.execute({ args: {} });
    const parsed = JSON.parse(raw);
    expect(parsed.ok).toBe(false);
    expect(parsed.errorClass).toBe("input_validation");
    expect(mockInfer).not.toHaveBeenCalled();
  });

  it("rejects when args is not a JSON object (array)", async () => {
    seedSkill({ name: "echo-skill" });
    const raw = await skillRunTool.execute({
      name: "echo-skill",
      args: ["not", "an", "object"],
    });
    const parsed = JSON.parse(raw);
    expect(parsed.ok).toBe(false);
    expect(parsed.errorClass).toBe("input_validation");
    expect(mockInfer).not.toHaveBeenCalled();
  });

  it("rejects when args is null", async () => {
    seedSkill({ name: "echo-skill" });
    const raw = await skillRunTool.execute({
      name: "echo-skill",
      args: null,
    });
    const parsed = JSON.parse(raw);
    expect(parsed.ok).toBe(false);
    expect(parsed.errorClass).toBe("input_validation");
  });

  it("forwards dryRun option to the dispatcher", async () => {
    const skillId = seedSkill({ name: "echo-skill" });
    mockInfer.mockResolvedValueOnce({
      content: '{"echoed": "ok"}',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    } as unknown as Awaited<ReturnType<typeof infer>>);

    const raw = await skillRunTool.execute({
      name: "echo-skill",
      args: {},
      options: { dryRun: true },
    });
    expect(JSON.parse(raw).ok).toBe(true);

    const db = getDatabase();
    const row = db
      .prepare("SELECT use_count FROM skills WHERE skill_id = ?")
      .get(skillId) as { use_count: number };
    expect(row.use_count).toBe(0);
  });

  it("returns skill_not_found via dispatcher envelope", async () => {
    const raw = await skillRunTool.execute({
      name: "nonexistent",
      args: {},
    });
    const parsed = JSON.parse(raw);
    expect(parsed.ok).toBe(false);
    expect(parsed.errorClass).toBe("skill_not_found");
  });
});

describe("audit folds — regression coverage", () => {
  it("C1: skill_run with args containing unknown keys on inputs:[] skill returns input_validation", async () => {
    seedSkill({ name: "no-inputs", inputsJson: "[]" });
    const raw = await skillRunTool.execute({
      name: "no-inputs",
      args: { unknown_key: "bar" },
    });
    const parsed = JSON.parse(raw);
    expect(parsed.ok).toBe(false);
    expect(parsed.errorClass).toBe("input_validation");
    // The dispatcher's strict() check kicks in BEFORE the LLM call.
    expect(mockInfer).not.toHaveBeenCalled();
  });

  it("C2: skill_load version_is_current=false when explicit version != current_version_id", async () => {
    const skillId = seedSkill({ name: "multi-version" });
    // Add a second version row and point current_version_id at it.
    const db = getDatabase();
    const v2 = db
      .prepare(
        `INSERT INTO skill_versions (
           skill_id, version, body, body_sha256, inputs_json, tests_json,
           tools_used_json, created_by, critic_verdict
         ) VALUES (?, '2.0.0', '# v2 body', 'sha2', '[]', '[]', '[]', 'operator', 'pass')`,
      )
      .run(skillId);
    db.prepare(
      "UPDATE skills SET current_version_id = ? WHERE skill_id = ?",
    ).run(Number(v2.lastInsertRowid), skillId);

    // Load the OLD version explicitly.
    const raw = await skillLoadTool.execute({
      name: "multi-version",
      version: "1.0.0",
    });
    const parsed = JSON.parse(raw);
    expect(parsed.ok).toBe(true);
    expect(parsed.skill.version).toBe("1.0.0");
    expect(parsed.skill.version_is_current).toBe(false);

    // Load the CURRENT version explicitly — flag flips.
    const raw2 = await skillLoadTool.execute({
      name: "multi-version",
      version: "2.0.0",
    });
    const parsed2 = JSON.parse(raw2);
    expect(parsed2.skill.version_is_current).toBe(true);
  });

  it("C2: skill_load with no version arg always returns version_is_current=true", async () => {
    seedSkill({ name: "single-version" });
    const raw = await skillLoadTool.execute({ name: "single-version" });
    const parsed = JSON.parse(raw);
    expect(parsed.skill.version_is_current).toBe(true);
  });

  it("W3: safeParse fallback returns the default when JSON is corrupt", async () => {
    const skillId = seedSkill({ name: "corrupt-tools" });
    // Stomp tools_used_json with garbage post-seed.
    const db = getDatabase();
    db.prepare(
      `UPDATE skill_versions SET tools_used_json = 'not valid json' WHERE skill_id = ?`,
    ).run(skillId);

    const raw = await skillLoadTool.execute({ name: "corrupt-tools" });
    const parsed = JSON.parse(raw);
    expect(parsed.ok).toBe(true);
    // Fallback to [] on corrupt JSON — caller sees a typed array.
    expect(parsed.skill.tools_used).toEqual([]);
  });
});

describe("annotations sanity", () => {
  it("describe + load are read-only + idempotent", () => {
    expect(skillDescribeTool.readOnlyHint).toBe(true);
    expect(skillDescribeTool.destructiveHint).toBe(false);
    expect(skillDescribeTool.idempotentHint).toBe(true);
    expect(skillLoadTool.readOnlyHint).toBe(true);
    expect(skillLoadTool.destructiveHint).toBe(false);
    expect(skillLoadTool.idempotentHint).toBe(true);
  });

  it("run is destructive + open-world (skills can call any tool)", () => {
    expect(skillRunTool.readOnlyHint).toBe(false);
    expect(skillRunTool.destructiveHint).toBe(true);
    expect(skillRunTool.openWorldHint).toBe(true);
  });

  it("all three are deferred", () => {
    expect(skillDescribeTool.deferred).toBe(true);
    expect(skillLoadTool.deferred).toBe(true);
    expect(skillRunTool.deferred).toBe(true);
  });
});
