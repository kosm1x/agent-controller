import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { runSkillTests } from "./test-runner.js";
import { infer } from "../inference/adapter.js";

vi.mock("../inference/adapter.js", () => ({
  infer: vi.fn(),
}));

const mockInfer = vi.mocked(infer);

let testKbDir: string;

beforeEach(() => {
  testKbDir = mkdtempSync(join(tmpdir(), "mc-test-runner-"));
  process.env.JARVIS_KB_MIRROR_DIR = testKbDir;
  initDatabase(":memory:");
  mockInfer.mockReset();
});

afterEach(() => {
  closeDatabase();
  rmSync(testKbDir, { recursive: true, force: true });
  delete process.env.JARVIS_KB_MIRROR_DIR;
});

/** Helper: seed a skill + version with given tests_json. Returns ids. */
function seedSkill(testsJson: string): { skillId: string; versionId: number } {
  const db = getDatabase();
  const skillId = "11111111-1111-4111-8111-111111111111";
  db.prepare(
    `INSERT INTO skills (
       skill_id, name, description, trigger_text, steps, tools, source,
       version, inputs_json, output_type, trigger_examples_json, tests_json, is_certified
     ) VALUES (?, 'echo-skill', 'desc', 'trigger', '[]', '[]', 'manual',
              '1.0.0', '[]', 'text', '[]', ?, 0)`,
  ).run(skillId, testsJson);

  const result = db
    .prepare(
      `INSERT INTO skill_versions (
         skill_id, version, body, body_sha256, inputs_json, tests_json,
         tools_used_json, created_by, critic_verdict
       ) VALUES (?, '1.0.0', '# Steps\n1. Echo the input.', 'sha', '[]', ?, '[]', 'operator', 'pass')`,
    )
    .run(skillId, testsJson);
  return { skillId, versionId: Number(result.lastInsertRowid) };
}

const passingTest = JSON.stringify([
  {
    name: "happy",
    input: { msg: "x" },
    expect: { output_match: { echoed: "x" } },
  },
]);

const failingTest = JSON.stringify([
  {
    name: "happy",
    input: { msg: "x" },
    expect: { output_match: { echoed: "different" } },
  },
]);

const errorTest = JSON.stringify([
  {
    name: "empty_input",
    input: {},
    expect_error: { class: "INPUT_REQUIRED", detail_contains: "msg" },
  },
]);

describe("runSkillTests — happy path", () => {
  it("returns pass + flips is_certified=1 when LLM output deep-matches", async () => {
    const { skillId, versionId } = seedSkill(passingTest);
    mockInfer.mockResolvedValueOnce({
      content: '{"echoed":"x","extra":"ignored"}',
      usage: {},
    } as Awaited<ReturnType<typeof infer>>);

    const result = await runSkillTests(skillId, versionId);
    expect(result.certified).toBe(true);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].result).toBe("pass");

    const db = getDatabase();
    const run = db
      .prepare("SELECT result FROM skill_test_runs WHERE skill_id = ?")
      .get(skillId) as { result: string };
    expect(run.result).toBe("pass");

    const skill = db
      .prepare("SELECT is_certified FROM skills WHERE skill_id = ?")
      .get(skillId) as { is_certified: number };
    expect(skill.is_certified).toBe(1);
  });

  it("returns fail when output does not match expected", async () => {
    const { skillId, versionId } = seedSkill(failingTest);
    mockInfer.mockResolvedValueOnce({
      content: '{"echoed":"x"}',
      usage: {},
    } as Awaited<ReturnType<typeof infer>>);

    const result = await runSkillTests(skillId, versionId);
    expect(result.certified).toBe(false);
    expect(result.outcomes[0].result).toBe("fail");
    expect(result.outcomes[0].diffSummary).toContain("expected");

    const db = getDatabase();
    const skill = db
      .prepare("SELECT is_certified FROM skills WHERE skill_id = ?")
      .get(skillId) as { is_certified: number };
    expect(skill.is_certified).toBe(0);
  });
});

describe("runSkillTests — expect_error path", () => {
  it("matches when LLM returns error class + detail substring", async () => {
    const { skillId, versionId } = seedSkill(errorTest);
    mockInfer.mockResolvedValueOnce({
      content:
        '{"error":"INPUT_REQUIRED","detail":"missing required field msg"}',
      usage: {},
    } as Awaited<ReturnType<typeof infer>>);

    const result = await runSkillTests(skillId, versionId);
    expect(result.certified).toBe(true);
    expect(result.outcomes[0].result).toBe("pass");
  });

  it("fails when error class differs", async () => {
    const { skillId, versionId } = seedSkill(errorTest);
    mockInfer.mockResolvedValueOnce({
      content: '{"error":"SOMETHING_ELSE","detail":"msg missing"}',
      usage: {},
    } as Awaited<ReturnType<typeof infer>>);

    const result = await runSkillTests(skillId, versionId);
    expect(result.certified).toBe(false);
    expect(result.outcomes[0].result).toBe("fail");
    expect(result.outcomes[0].diffSummary).toContain("expected error class");
  });

  it("fails when detail does not contain expected substring", async () => {
    const { skillId, versionId } = seedSkill(errorTest);
    mockInfer.mockResolvedValueOnce({
      content: '{"error":"INPUT_REQUIRED","detail":"missing some other field"}',
      usage: {},
    } as Awaited<ReturnType<typeof infer>>);

    const result = await runSkillTests(skillId, versionId);
    expect(result.outcomes[0].result).toBe("fail");
    expect(result.outcomes[0].diffSummary).toContain("detail did not contain");
  });
});

describe("runSkillTests — error paths", () => {
  it("empty LLM response → 'error' result + is_certified=0", async () => {
    const { skillId, versionId } = seedSkill(passingTest);
    mockInfer.mockResolvedValueOnce({
      content: "",
      usage: {},
    } as Awaited<ReturnType<typeof infer>>);

    const result = await runSkillTests(skillId, versionId);
    expect(result.outcomes[0].result).toBe("error");
    expect(result.outcomes[0].diffSummary).toContain("empty");
    expect(result.certified).toBe(false);
  });

  it("non-JSON response → 'error' result", async () => {
    const { skillId, versionId } = seedSkill(passingTest);
    mockInfer.mockResolvedValueOnce({
      content: "Sure, here are the results: pass!",
      usage: {},
    } as Awaited<ReturnType<typeof infer>>);

    const result = await runSkillTests(skillId, versionId);
    expect(result.outcomes[0].result).toBe("error");
    expect(result.outcomes[0].diffSummary).toContain("parseable JSON");
  });

  it("infer throws → 'error' result with caught message", async () => {
    const { skillId, versionId } = seedSkill(passingTest);
    mockInfer.mockRejectedValueOnce(new Error("upstream gateway 502"));

    const result = await runSkillTests(skillId, versionId);
    expect(result.outcomes[0].result).toBe("error");
    expect(result.outcomes[0].diffSummary).toContain("502");
  });
});

describe("runSkillTests — multi-test aggregation", () => {
  it("requires ALL tests pass to certify", async () => {
    const twoTests = JSON.stringify([
      { name: "a", input: { x: 1 }, expect: { output_match: { y: 1 } } },
      { name: "b", input: { x: 2 }, expect: { output_match: { y: 2 } } },
    ]);
    const { skillId, versionId } = seedSkill(twoTests);
    mockInfer
      .mockResolvedValueOnce({
        content: '{"y":1}',
        usage: {},
      } as Awaited<ReturnType<typeof infer>>)
      .mockResolvedValueOnce({
        content: '{"y":99}', // mismatch
        usage: {},
      } as Awaited<ReturnType<typeof infer>>);

    const result = await runSkillTests(skillId, versionId);
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes[0].result).toBe("pass");
    expect(result.outcomes[1].result).toBe("fail");
    expect(result.certified).toBe(false);
  });
});

describe("runSkillTests — abort semantics (R1-W1 regression)", () => {
  it("caller-aborted run does NOT decertify a previously-certified skill", async () => {
    const { skillId, versionId } = seedSkill(passingTest);

    // Pre-mark the skill as certified to simulate a prior successful sweep.
    const db = getDatabase();
    db.prepare("UPDATE skills SET is_certified = 1 WHERE skill_id = ?").run(
      skillId,
    );

    const ac = new AbortController();
    ac.abort(new Error("operator SIGTERM"));

    const result = await runSkillTests(skillId, versionId, {
      signal: ac.signal,
    });

    // Run produced no outcomes (aborted before first test ran).
    expect(result.outcomes).toHaveLength(0);
    // Critical: certified state preserved, not flipped to false.
    expect(result.certified).toBe(true);

    const skill = db
      .prepare("SELECT is_certified FROM skills WHERE skill_id = ?")
      .get(skillId) as { is_certified: number };
    expect(skill.is_certified).toBe(1);
    expect(mockInfer).not.toHaveBeenCalled();
  });
});

describe("runSkillTests — schema robustness", () => {
  it("returns empty outcomes + is_certified=0 when tests_json is malformed JSON", async () => {
    const { skillId, versionId } = seedSkill("not-json");
    const result = await runSkillTests(skillId, versionId);
    expect(result.outcomes).toHaveLength(0);
    expect(result.certified).toBe(false);

    const db = getDatabase();
    const skill = db
      .prepare("SELECT is_certified FROM skills WHERE skill_id = ?")
      .get(skillId) as { is_certified: number };
    expect(skill.is_certified).toBe(0);
  });

  it("returns empty outcomes when tests array is empty (vacuous certification refused)", async () => {
    const { skillId, versionId } = seedSkill("[]");
    const result = await runSkillTests(skillId, versionId);
    expect(result.outcomes).toHaveLength(0);
    expect(result.certified).toBe(false);
  });

  it("returns empty outcomes when test has BOTH expect and expect_error (mutex violation)", async () => {
    const conflicting = JSON.stringify([
      {
        name: "bad",
        input: {},
        expect: { output_match: {} },
        expect_error: { class: "X" },
      },
    ]);
    const { skillId, versionId } = seedSkill(conflicting);
    const result = await runSkillTests(skillId, versionId);
    expect(result.outcomes).toHaveLength(0);
    expect(result.certified).toBe(false);
  });
});
