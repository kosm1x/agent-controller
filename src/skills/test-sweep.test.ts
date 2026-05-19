import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { runSkillsTestSweep, SweepLog } from "./test-sweep.js";
import { infer } from "../inference/adapter.js";

vi.mock("../inference/adapter.js", () => ({
  infer: vi.fn(),
}));

const mockInfer = vi.mocked(infer);

let testKbDir: string;

const SILENT: SweepLog = {
  info: () => {},
  warn: () => {},
};

beforeEach(() => {
  testKbDir = mkdtempSync(join(tmpdir(), "mc-test-sweep-"));
  process.env.JARVIS_KB_MIRROR_DIR = testKbDir;
  initDatabase(":memory:");
  mockInfer.mockReset();
});

afterEach(() => {
  closeDatabase();
  rmSync(testKbDir, { recursive: true, force: true });
  delete process.env.JARVIS_KB_MIRROR_DIR;
});

/** Seed a certified, active skill with one passing-shaped test. */
function seedCertifiedSkill(skillId: string, name: string): number {
  const db = getDatabase();
  const tests = JSON.stringify([
    {
      name: "t1",
      input: { x: 1 },
      expect: { output_match: { y: 1 } },
    },
  ]);
  const versionRow = db
    .prepare(
      `INSERT INTO skill_versions (
         skill_id, version, body, body_sha256, inputs_json, tests_json,
         tools_used_json, created_by, critic_verdict
       ) VALUES (?, '1.0.0', '# Steps', 'sha', '[]', ?, '[]', 'operator', 'pass')`,
    )
    .run(skillId, tests);
  const versionId = Number(versionRow.lastInsertRowid);

  db.prepare(
    `INSERT INTO skills (
       skill_id, name, description, trigger_text, steps, tools, source,
       version, inputs_json, output_type, trigger_examples_json, tests_json,
       is_certified, current_version_id, active
     ) VALUES (?, ?, 'desc', 'trigger', '[]', '[]', 'manual', '1.0.0', '[]',
              'text', '[]', ?, 1, ?, 1)`,
  ).run(skillId, name, tests, versionId);
  return versionId;
}

describe("runSkillsTestSweep", () => {
  it("no certified active skills → 0 examined, 0 decertified", async () => {
    const result = await runSkillsTestSweep(SILENT);
    expect(result.examined).toBe(0);
    expect(result.decertified).toBe(0);
    expect(result.reaffirmed).toBe(0);
  });

  it("reaffirms a certified skill whose tests still pass", async () => {
    const skillId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    seedCertifiedSkill(skillId, "good-skill");
    mockInfer.mockResolvedValueOnce({
      content: '{"y":1}',
      usage: {},
    } as Awaited<ReturnType<typeof infer>>);

    const result = await runSkillsTestSweep(SILENT);
    expect(result.examined).toBe(1);
    expect(result.reaffirmed).toBe(1);
    expect(result.decertified).toBe(0);

    const db = getDatabase();
    const skill = db
      .prepare("SELECT is_certified FROM skills WHERE skill_id = ?")
      .get(skillId) as { is_certified: number };
    expect(skill.is_certified).toBe(1);
  });

  it("decertifies a skill whose tests now fail", async () => {
    const skillId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    seedCertifiedSkill(skillId, "regressed-skill");
    mockInfer.mockResolvedValueOnce({
      content: '{"y":999}', // mismatch
      usage: {},
    } as Awaited<ReturnType<typeof infer>>);

    const result = await runSkillsTestSweep(SILENT);
    expect(result.examined).toBe(1);
    expect(result.decertified).toBe(1);
    expect(result.reaffirmed).toBe(0);

    const db = getDatabase();
    const skill = db
      .prepare("SELECT is_certified FROM skills WHERE skill_id = ?")
      .get(skillId) as { is_certified: number };
    expect(skill.is_certified).toBe(0);
  });

  it("ignores skills with active=0", async () => {
    const skillId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const versionId = seedCertifiedSkill(skillId, "inactive-skill");
    // Flip active=0 after seed
    const db = getDatabase();
    db.prepare("UPDATE skills SET active = 0 WHERE skill_id = ?").run(skillId);
    void versionId; // suppress unused

    const result = await runSkillsTestSweep(SILENT);
    expect(result.examined).toBe(0);
  });

  it("processes multiple skills independently — one fails, one passes", async () => {
    const goodId = "11111111-1111-4111-8111-111111111111";
    const badId = "22222222-2222-4222-8222-222222222222";
    seedCertifiedSkill(goodId, "skill-a");
    seedCertifiedSkill(badId, "skill-b");
    mockInfer
      .mockResolvedValueOnce({
        content: '{"y":1}',
        usage: {},
      } as Awaited<ReturnType<typeof infer>>)
      .mockResolvedValueOnce({
        content: '{"y":2}', // mismatch
        usage: {},
      } as Awaited<ReturnType<typeof infer>>);

    const result = await runSkillsTestSweep(SILENT);
    expect(result.examined).toBe(2);
    expect(result.reaffirmed).toBe(1);
    expect(result.decertified).toBe(1);
  });

  it("counts skips when current_version_id is NULL", async () => {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO skills (
         skill_id, name, description, trigger_text, steps, tools, source,
         is_certified, active
       ) VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'orphan', 'd', 't', '[]', '[]', 'manual', 1, 1)`,
    ).run();

    const result = await runSkillsTestSweep(SILENT);
    // current_version_id IS NULL is filtered out at the query level → examined=0
    expect(result.examined).toBe(0);
  });
});
