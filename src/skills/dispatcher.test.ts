/**
 * v7.7 Spine 3 Phase 4 — dispatcher tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { runSkill, MAX_SKILL_CALL_DEPTH } from "./dispatcher.js";
import { infer } from "../inference/adapter.js";

vi.mock("../inference/adapter.js", () => ({
  infer: vi.fn(),
}));

const mockInfer = vi.mocked(infer);

let testKbDir: string;

beforeEach(() => {
  testKbDir = mkdtempSync(join(tmpdir(), "mc-dispatcher-"));
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
 * Seed a skill + version with the supplied inputs_json. Returns the
 * skill_id + version_id; also points `skills.current_version_id` at the
 * version (production lifecycle uses pointSkillAtVersion to do this).
 */
function seedSkill(
  inputsJson: string,
  opts: { active?: 0 | 1; currentVersion?: boolean; name?: string } = {},
): { skillId: string; versionId: number } {
  const db = getDatabase();
  const name = opts.name ?? "echo-skill";
  const skillId = `dispatch-${name}-id`;
  db.prepare(
    `INSERT INTO skills (
       skill_id, name, description, trigger_text, steps, tools, source,
       version, inputs_json, output_type, trigger_examples_json,
       tests_json, is_certified, active
     ) VALUES (?, ?, 'desc', 'trigger', '[]', '[]', 'manual',
              '1.0.0', ?, 'text', '[]', '[]', 1, ?)`,
  ).run(skillId, name, inputsJson, opts.active ?? 1);

  const result = db
    .prepare(
      `INSERT INTO skill_versions (
         skill_id, version, body, body_sha256, inputs_json, tests_json,
         tools_used_json, created_by, critic_verdict
       ) VALUES (?, '1.0.0', '# Skill body\n1. Echo the input as {"echoed": <input>}.',
                'sha', ?, '[]', '[]', 'operator', 'pass')`,
    )
    .run(skillId, inputsJson);
  const versionId = Number(result.lastInsertRowid);

  if (opts.currentVersion !== false) {
    db.prepare(
      `UPDATE skills SET current_version_id = ? WHERE skill_id = ?`,
    ).run(versionId, skillId);
  }

  return { skillId, versionId };
}

function mockResponse(content: string): void {
  mockInfer.mockResolvedValueOnce({
    content,
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  } as unknown as Awaited<ReturnType<typeof infer>>);
}

describe("runSkill — early-rejection paths", () => {
  it("returns skill_not_found when the name doesn't match any row", async () => {
    const r = await runSkill("nope", {});
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe("skill_not_found");
    expect(r.skillId).toBeNull();
    expect(mockInfer).not.toHaveBeenCalled();
  });

  it("returns skill_inactive when active=0", async () => {
    seedSkill("[]", { active: 0 });
    const r = await runSkill("echo-skill", {});
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe("skill_inactive");
    expect(r.skillId).not.toBeNull();
    expect(mockInfer).not.toHaveBeenCalled();
  });

  it("returns no_active_version when current_version_id is null", async () => {
    seedSkill("[]", { currentVersion: false });
    const r = await runSkill("echo-skill", {});
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe("no_active_version");
    expect(mockInfer).not.toHaveBeenCalled();
  });

  it("rejects with cycle_detected when name is already in call stack", async () => {
    seedSkill("[]");
    const r = await runSkill(
      "echo-skill",
      {},
      {
        _callStack: ["echo-skill"],
      },
    );
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe("cycle_detected");
    expect(mockInfer).not.toHaveBeenCalled();
  });

  it("rejects when call stack depth reaches MAX_SKILL_CALL_DEPTH", async () => {
    seedSkill("[]");
    const r = await runSkill(
      "echo-skill",
      {},
      {
        _callStack: Array.from(
          { length: MAX_SKILL_CALL_DEPTH },
          (_, i) => `s${i}`,
        ),
      },
    );
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe("cycle_detected");
    expect(r.errorDetail).toMatch(/max skill call depth/);
    expect(mockInfer).not.toHaveBeenCalled();
  });
});

describe("runSkill — input validation", () => {
  it("rejects args that don't match the inputs schema (missing required field)", async () => {
    const inputs = JSON.stringify([
      { name: "msg", type: "string", required: true },
    ]);
    seedSkill(inputs);
    const r = await runSkill("echo-skill", {});
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe("input_validation");
    expect(r.errorDetail).toMatch(/msg/);
    expect(mockInfer).not.toHaveBeenCalled();
  });

  it("increments consecutive_failures AND writes skill_failures on validation fail", async () => {
    const inputs = JSON.stringify([
      { name: "msg", type: "string", required: true },
    ]);
    const { skillId } = seedSkill(inputs);
    await runSkill("echo-skill", {});

    const db = getDatabase();
    const cf = db
      .prepare(
        "SELECT consecutive_failures, use_count FROM skills WHERE skill_id = ?",
      )
      .get(skillId) as { consecutive_failures: number; use_count: number };
    expect(cf.consecutive_failures).toBe(1);
    expect(cf.use_count).toBe(1);

    const failures = db
      .prepare(
        "SELECT error_class, error_detail FROM skill_failures WHERE skill_id = ?",
      )
      .all(skillId) as Array<{ error_class: string; error_detail: string }>;
    expect(failures).toHaveLength(1);
    // input_validation maps onto the schema CHECK enum as 'other'.
    expect(failures[0].error_class).toBe("other");
    expect(failures[0].error_detail).toMatch(/input_validation/);
  });
});

describe("runSkill — happy path", () => {
  it("returns ok with parsed output and increments success_count", async () => {
    seedSkill("[]");
    mockResponse('{"echoed": "hello"}');

    const r = await runSkill("echo-skill", {});
    expect(r.ok).toBe(true);
    expect(r.errorClass).toBeNull();
    expect(r.output).toEqual({ echoed: "hello" });

    const db = getDatabase();
    const row = db
      .prepare(
        "SELECT use_count, success_count, consecutive_failures FROM skills WHERE name = 'echo-skill'",
      )
      .get() as {
      use_count: number;
      success_count: number;
      consecutive_failures: number;
    };
    expect(row.use_count).toBe(1);
    expect(row.success_count).toBe(1);
    expect(row.consecutive_failures).toBe(0);
  });

  it("resolves open skill_failures rows on success (resolution stays NULL pending v8.0 schema reset / S5-P4-B1-I1)", async () => {
    const { skillId } = seedSkill("[]");
    // Plant 2 unresolved failure rows.
    const db = getDatabase();
    for (let i = 0; i < 2; i++) {
      db.prepare(
        `INSERT INTO skill_failures (skill_id, error_class, error_detail) VALUES (?, 'other', 'planted')`,
      ).run(skillId);
    }

    mockResponse('{"echoed": "ok"}');
    await runSkill("echo-skill", {});

    // S5-P4-B1-I1 / S5-P2-I1: schema CHECK enum doesn't admit
    // 'self_recovered' yet — anti-list invariant is encoded by
    // resolved_at IS NULL, so we assert on that (resolution stays NULL).
    const resolved = db
      .prepare(
        "SELECT COUNT(*) as n FROM skill_failures WHERE skill_id = ? AND resolved_at IS NOT NULL",
      )
      .get(skillId) as { n: number };
    expect(resolved.n).toBe(2);
  });

  it("writes a cost_ledger row with agent_type='skill:<name>' + real tokens (C1 regression)", async () => {
    seedSkill("[]");
    // Inline mockInfer so we can assert on the real usage that comes back.
    mockInfer.mockResolvedValueOnce({
      content: '{"echoed": "ok"}',
      usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 },
    } as unknown as Awaited<ReturnType<typeof infer>>);
    await runSkill("echo-skill", {}, { taskId: "task-abc" });

    const db = getDatabase();
    const row = db
      .prepare(
        "SELECT agent_type, task_id, prompt_tokens, completion_tokens FROM cost_ledger WHERE agent_type = 'skill:echo-skill'",
      )
      .get() as {
      agent_type: string;
      task_id: string;
      prompt_tokens: number;
      completion_tokens: number;
    };
    expect(row.agent_type).toBe("skill:echo-skill");
    expect(row.task_id).toBe("task-abc");
    // C1 audit fold: the real provider usage MUST land in cost_ledger.
    // Earlier draft wrote 0/0 — that broke per-skill spend analysis.
    expect(row.prompt_tokens).toBe(123);
    expect(row.completion_tokens).toBe(45);
  });

  it("generates a UUID task_id when caller omits it (C1 regression)", async () => {
    seedSkill("[]");
    mockResponse('{"echoed": "ok"}');
    await runSkill("echo-skill", {}); // no taskId

    const db = getDatabase();
    const row = db
      .prepare(
        "SELECT task_id FROM cost_ledger WHERE agent_type = 'skill:echo-skill'",
      )
      .get() as { task_id: string };
    // UUID v4 format — 36 chars, hyphenated. Anything non-empty + non-trivial.
    expect(row.task_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("bumps consecutive_failures back to 0 after a prior failure", async () => {
    const inputs = JSON.stringify([
      { name: "msg", type: "string", required: true },
    ]);
    const { skillId } = seedSkill(inputs);
    // First call: validation failure → counter=1
    await runSkill("echo-skill", {});
    // Second call: success → counter=0
    mockResponse('{"echoed": "ok"}');
    await runSkill("echo-skill", { msg: "hi" });

    const db = getDatabase();
    const row = db
      .prepare("SELECT consecutive_failures FROM skills WHERE skill_id = ?")
      .get(skillId) as { consecutive_failures: number };
    expect(row.consecutive_failures).toBe(0);
  });
});

describe("runSkill — LLM-side failures", () => {
  it("classifies empty response as wrong_output", async () => {
    seedSkill("[]");
    mockInfer.mockResolvedValueOnce({
      content: "",
      usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 },
    } as unknown as Awaited<ReturnType<typeof infer>>);

    const r = await runSkill("echo-skill", {});
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe("wrong_output");

    const db = getDatabase();
    const row = db
      .prepare(
        "SELECT error_class FROM skill_failures WHERE skill_id LIKE 'dispatch-%'",
      )
      .get() as { error_class: string };
    expect(row.error_class).toBe("wrong_output");
  });

  it("classifies unparseable response as wrong_output", async () => {
    seedSkill("[]");
    mockResponse("not JSON at all");
    const r = await runSkill("echo-skill", {});
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe("wrong_output");
  });

  it("classifies adapter timeout as timeout", async () => {
    seedSkill("[]");
    mockInfer.mockRejectedValueOnce(new Error("test timeout"));
    const r = await runSkill("echo-skill", {});
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe("timeout");

    const db = getDatabase();
    const row = db
      .prepare(
        "SELECT error_class FROM skill_failures WHERE skill_id LIKE 'dispatch-%'",
      )
      .get() as { error_class: string };
    expect(row.error_class).toBe("timeout");
  });

  it("treats skill-emitted {error:...} envelope as wrong_output (skill self-rejected)", async () => {
    seedSkill("[]");
    mockResponse('{"error": "INPUT_REQUIRED", "detail": "msg is empty"}');
    const r = await runSkill("echo-skill", {});
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe("wrong_output");
    expect(r.errorDetail).toMatch(/INPUT_REQUIRED/);
  });
});

describe("runSkill — skill_corrupt (W3 regression)", () => {
  it("classifies a malformed inputs_json column as skill_corrupt, NOT input_validation", async () => {
    // Manually plant a corrupt skill_versions row that bypasses Phase 1
    // parser (simulates DB-side damage discovered at runtime).
    const db = getDatabase();
    const skillId = "corrupt-skill-id";
    db.prepare(
      `INSERT INTO skills (
         skill_id, name, description, trigger_text, steps, tools, source,
         version, inputs_json, output_type, trigger_examples_json,
         tests_json, is_certified, active, current_version_id
       ) VALUES (?, 'corrupt-skill', 'desc', 'trigger', '[]', '[]', 'manual',
                '1.0.0', '[]', 'text', '[]', '[]', 1, 1, NULL)`,
    ).run(skillId);
    const result = db
      .prepare(
        `INSERT INTO skill_versions (
           skill_id, version, body, body_sha256, inputs_json, tests_json,
           tools_used_json, created_by, critic_verdict
         ) VALUES (?, '1.0.0', '# body', 'sha', 'not valid json AT ALL',
                  '[]', '[]', 'operator', 'pass')`,
      )
      .run(skillId);
    db.prepare(
      `UPDATE skills SET current_version_id = ? WHERE skill_id = ?`,
    ).run(Number(result.lastInsertRowid), skillId);

    const r = await runSkill("corrupt-skill", {});
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe("skill_corrupt");
    expect(r.errorDetail).toMatch(/corrupt/);

    // W3 invariant: a corrupt VERSION must NOT burn anti-list strikes.
    const row = db
      .prepare(
        "SELECT consecutive_failures, use_count FROM skills WHERE skill_id = ?",
      )
      .get(skillId) as { consecutive_failures: number; use_count: number };
    expect(row.consecutive_failures).toBe(0);
    expect(row.use_count).toBe(0);

    // Also no skill_failures row — corruption is operator's repair task,
    // not a skill-quality signal.
    const failures = db
      .prepare("SELECT COUNT(*) AS n FROM skill_failures WHERE skill_id = ?")
      .get(skillId) as { n: number };
    expect(failures.n).toBe(0);
  });
});

describe("runSkill — dryRun", () => {
  it("does not mutate skills row when dryRun=true (success path)", async () => {
    const { skillId } = seedSkill("[]");
    mockResponse('{"echoed": "ok"}');
    const r = await runSkill("echo-skill", {}, { dryRun: true });
    expect(r.ok).toBe(true);

    const db = getDatabase();
    const row = db
      .prepare("SELECT use_count, success_count FROM skills WHERE skill_id = ?")
      .get(skillId) as { use_count: number; success_count: number };
    expect(row.use_count).toBe(0);
    expect(row.success_count).toBe(0);
  });

  it("does not write skill_failures when dryRun=true (failure path)", async () => {
    const { skillId } = seedSkill("[]");
    mockResponse("garbage");
    const r = await runSkill("echo-skill", {}, { dryRun: true });
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe("wrong_output");

    const db = getDatabase();
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM skill_failures WHERE skill_id = ?")
      .get(skillId) as { n: number };
    expect(count.n).toBe(0);
  });
});
