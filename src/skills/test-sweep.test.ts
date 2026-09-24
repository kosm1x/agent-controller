import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import {
  runSkillsTestSweep,
  SweepLog,
  SWEEP_RETEST_RUNS,
  SWEEP_TEST_TIMEOUT_MS,
} from "./test-sweep.js";
import { infer } from "../inference/adapter.js";
import {
  claimCertificationRun,
  releaseCertificationRun,
  runSkillTests,
} from "./test-runner.js";

vi.mock("../inference/adapter.js", () => ({
  infer: vi.fn(),
}));

vi.mock("./test-runner.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./test-runner.js")>();
  return { ...mod, runSkillTests: vi.fn(mod.runSkillTests) };
});

const mockRunSkillTests = vi.mocked(runSkillTests);

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
  mockRunSkillTests.mockClear();
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
    // 2026-09-12: the sweep must not run at the mini-runner's 30 s default —
    // a structured skill measured 26.5 s there and a timeout decertifies.
    expect(mockRunSkillTests).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      expect.objectContaining({ timeoutMs: SWEEP_TEST_TIMEOUT_MS }),
    );
    expect(SWEEP_TEST_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
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

  it("recertifies a skill decertified only by error runs; a version with a fail stays out", async () => {
    const db = getDatabase();
    const errId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const failId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const errVersion = seedCertifiedSkill(errId, "timed-out-once");
    const failVersion = seedCertifiedSkill(failId, "really-broken");
    db.prepare("UPDATE skills SET is_certified = 0").run();
    const run = db.prepare(
      "INSERT INTO skill_test_runs (skill_id, version_id, test_name, result) VALUES (?, ?, 't1', ?)",
    );
    run.run(errId, errVersion, "pass");
    run.run(errId, errVersion, "error");
    run.run(failId, failVersion, "fail");
    mockInfer.mockResolvedValueOnce({
      content: '{"y":1}',
      usage: {},
    } as Awaited<ReturnType<typeof infer>>);

    const result = await runSkillsTestSweep(SILENT);
    expect(result.examined).toBe(1);
    expect(result.recertified).toBe(1);
    expect(result.decertified).toBe(0);
    expect(mockRunSkillTests).toHaveBeenCalledTimes(1);
    expect(mockRunSkillTests.mock.calls[0][0]).toBe(errId);
    const certified = (id: string) =>
      (
        db.prepare("SELECT is_certified FROM skills WHERE skill_id = ?").get(id) as {
          is_certified: number;
        }
      ).is_certified;
    expect(certified(errId)).toBe(1);
    expect(certified(failId)).toBe(0);
  });

  it("an uncertified retest that fails again is not counted as decertified", async () => {
    const skillId = "99999999-9999-4999-8999-999999999999";
    seedCertifiedSkill(skillId, "still-flaky");
    getDatabase().prepare("UPDATE skills SET is_certified = 0").run();
    mockInfer.mockResolvedValueOnce({
      content: '{"y":2}',
      usage: {},
    } as Awaited<ReturnType<typeof infer>>);

    const result = await runSkillsTestSweep(SILENT);
    expect(result.examined).toBe(1);
    expect(result.recertified).toBe(0);
    expect(result.decertified).toBe(0);
    expect(result.stillUncertified).toBe(1);
  });

  it("an uncertified retest that errors is counted and retried, up to SWEEP_RETEST_RUNS since the last pass", async () => {
    const skillId = "88888888-8888-4888-8888-888888888888";
    seedCertifiedSkill(skillId, "keeps-timing-out");
    getDatabase().prepare("UPDATE skills SET is_certified = 0").run();
    mockInfer.mockRejectedValue(new Error("provider down"));
    for (let tick = 1; tick <= SWEEP_RETEST_RUNS; tick++) {
      const r = await runSkillsTestSweep(SILENT);
      expect(r.examined).toBe(1);
      expect(r.stillUncertified).toBe(1);
    }
    const after = await runSkillsTestSweep(SILENT);
    expect(after.examined).toBe(0); // bounded: no LLM calls every 6 h forever
    expect(mockRunSkillTests).toHaveBeenCalledTimes(SWEEP_RETEST_RUNS);
  });

  it("the retry bound is per test: a sibling test's pass does not reset a test that keeps timing out", async () => {
    const skillId = "55555555-5555-4555-8555-555555555555";
    const versionId = seedCertifiedSkill(skillId, "one-slow-test");
    const db = getDatabase();
    db.prepare("UPDATE skills SET is_certified = 0").run();
    db.prepare("UPDATE skill_versions SET tests_json = ? WHERE id = ?").run(
      JSON.stringify([
        { name: "fast", input: { x: 1 }, expect: { output_match: { y: 1 } } },
        { name: "slow", input: { x: 2 }, expect: { output_match: { y: 2 } } },
      ]),
      versionId,
    );
    mockInfer.mockImplementation(async (req) =>
      JSON.stringify(req).includes('\\"x\\":2')
        ? Promise.reject(new Error("timeout"))
        : ({ content: '{"y":1}', usage: {} } as Awaited<ReturnType<typeof infer>>),
    );
    for (let tick = 1; tick <= SWEEP_RETEST_RUNS; tick++) {
      const r = await runSkillsTestSweep(SILENT);
      expect(r.stillUncertified).toBe(1);
      // Real ticks are 6 h apart; unixepoch-second rows would all tie.
      db.prepare("UPDATE skill_test_runs SET ran_at = datetime(ran_at, '-6 hours')").run();
    }
    const results = db
      .prepare("SELECT test_name, result FROM skill_test_runs WHERE version_id = ?")
      .all(versionId) as Array<{ test_name: string; result: string }>;
    expect(results.filter((r) => r.test_name === "fast" && r.result === "pass")).toHaveLength(SWEEP_RETEST_RUNS);
    const after = await runSkillsTestSweep(SILENT);
    expect(after.examined).toBe(0);
  });

  it("leaves out an uncertified version with no tests", async () => {
    const skillId = "77777777-7777-4777-8777-777777777777";
    const versionId = seedCertifiedSkill(skillId, "no-tests");
    const db = getDatabase();
    db.prepare("UPDATE skills SET is_certified = 0").run();
    db.prepare("UPDATE skill_versions SET tests_json = '[]' WHERE id = ?").run(versionId);
    const r = await runSkillsTestSweep(SILENT);
    expect(r.examined).toBe(0);
  });

  it("skips a version whose certification run is in flight (kb-file write), then releases nothing it did not claim", async () => {
    const skillId = "66666666-6666-4666-8666-666666666666";
    const versionId = seedCertifiedSkill(skillId, "being-certified");
    getDatabase().prepare("UPDATE skills SET is_certified = 0").run();
    expect(claimCertificationRun(versionId)).toBe(true);
    try {
      const r = await runSkillsTestSweep(SILENT);
      expect(r.examined).toBe(1);
      expect(r.skipped).toBe(1);
      expect(mockRunSkillTests).not.toHaveBeenCalled();
      expect(claimCertificationRun(versionId)).toBe(false); // still the writer's
    } finally {
      releaseCertificationRun(versionId);
    }
    mockInfer.mockResolvedValueOnce({
      content: '{"y":1}',
      usage: {},
    } as Awaited<ReturnType<typeof infer>>);
    const next = await runSkillsTestSweep(SILENT);
    expect(next.recertified).toBe(1);
    expect(claimCertificationRun(versionId)).toBe(true); // the sweep released its claim
    releaseCertificationRun(versionId);
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
