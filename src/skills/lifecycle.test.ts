import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { skillRevise, skillSave } from "./lifecycle.js";
import { infer } from "../inference/adapter.js";
import type { ParsedSkillFile } from "./frontmatter.js";

vi.mock("../inference/adapter.js", () => ({
  infer: vi.fn(),
}));

const mockInfer = vi.mocked(infer);

let testKbDir: string;

const FIXTURE: ParsedSkillFile = {
  frontmatter: {
    name: "echo-skill",
    description:
      "When asked to echo a string, return the same string verbatim. Used by Phase 2 test harness.",
    version: "1.0.0",
    output_type: "text",
    trigger_examples: [
      "Echo the message hello",
      "Repeat the input back to me",
      "Send the same string verbatim",
    ],
    tools_used: [],
    inputs_json: '[{"name":"msg","type":"string","required":true}]',
    tests_json:
      '[{"name":"happy","input":{"msg":"x"},"expect":{"output_match":{"echoed":"x"}}}]',
  },
  body: "# Steps\n1. Take the input msg.\n2. Return it as `echoed`.",
};

const passVerdict = {
  content: '{"verdict": "pass", "critique": ""}',
  usage: { cost_usd: 0.001 },
} as Awaited<ReturnType<typeof infer>>;

const failVerdict = {
  content: '{"verdict": "fail", "critique": "Description is too vague."}',
  usage: { cost_usd: 0.001 },
} as Awaited<ReturnType<typeof infer>>;

beforeEach(() => {
  testKbDir = mkdtempSync(join(tmpdir(), "mc-skills-lifecycle-test-"));
  process.env.JARVIS_KB_MIRROR_DIR = testKbDir;
  initDatabase(":memory:");
  mockInfer.mockReset();
});

afterEach(() => {
  closeDatabase();
  rmSync(testKbDir, { recursive: true, force: true });
  delete process.env.JARVIS_KB_MIRROR_DIR;
});

describe("skillSave — critic-pass path", () => {
  it("writes skill + skill_versions row when critic passes", async () => {
    mockInfer.mockResolvedValueOnce(passVerdict);
    const result = await skillSave(FIXTURE);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.criticVerdict).toBe("pass");
    expect(result.versionId).toBeGreaterThan(0);

    const db = getDatabase();
    const ver = db
      .prepare(
        "SELECT created_by, critic_verdict, version FROM skill_versions WHERE id = ?",
      )
      .get(result.versionId) as
      | { created_by: string; critic_verdict: string; version: string }
      | undefined;
    expect(ver).toBeDefined();
    expect(ver?.created_by).toBe("operator");
    expect(ver?.critic_verdict).toBe("pass");
    expect(ver?.version).toBe("1.0.0");

    const skill = db
      .prepare("SELECT current_version_id, version FROM skills WHERE name = ?")
      .get("echo-skill") as
      | { current_version_id: number; version: string }
      | undefined;
    expect(skill?.current_version_id).toBe(result.versionId);
    expect(skill?.version).toBe("1.0.0");
  });

  it("respects createdBy override (e.g. 'discovery')", async () => {
    mockInfer.mockResolvedValueOnce(passVerdict);
    const result = await skillSave(FIXTURE, { createdBy: "discovery" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const db = getDatabase();
    const ver = db
      .prepare("SELECT created_by FROM skill_versions WHERE id = ?")
      .get(result.versionId) as { created_by: string };
    expect(ver.created_by).toBe("discovery");
  });
});

describe("skillSave — critic-fail path", () => {
  it("returns rejection without writing when critic returns fail", async () => {
    mockInfer.mockResolvedValueOnce(failVerdict);
    const result = await skillSave(FIXTURE);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("critic_failed");
    expect(result.critique).toContain("vague");

    const db = getDatabase();
    const rows = db
      .prepare("SELECT COUNT(*) as n FROM skill_versions")
      .get() as {
      n: number;
    };
    expect(rows.n).toBe(0);

    const skillRows = db
      .prepare("SELECT COUNT(*) as n FROM skills WHERE name = ?")
      .get("echo-skill") as { n: number };
    expect(skillRows.n).toBe(0);
  });

  it("returns critic_error when critic infrastructure fails", async () => {
    mockInfer.mockResolvedValueOnce({
      content: "",
      usage: {},
    } as Awaited<ReturnType<typeof infer>>);
    const result = await skillSave(FIXTURE);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("critic_error");
    expect(result.critic?.error).toBe(true);
  });
});

describe("skillSave — operator override", () => {
  it("writes with critic_verdict='fail_returned_anyway' (created_by stays under caller — schema CHECK lacks 'operator-override')", async () => {
    mockInfer.mockResolvedValueOnce(failVerdict);
    const result = await skillSave(FIXTURE, {
      createdBy: "operator",
      forceOperatorOverride: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.criticVerdict).toBe("fail_returned_anyway");

    const db = getDatabase();
    const ver = db
      .prepare(
        "SELECT created_by, critic_verdict, critic_critique FROM skill_versions WHERE id = ?",
      )
      .get(result.versionId) as
      | {
          created_by: string;
          critic_verdict: string;
          critic_critique: string | null;
        }
      | undefined;
    // The Phase 1 CHECK constraint doesn't include 'operator-override' —
    // critic_verdict='fail_returned_anyway' is the unambiguous signal.
    expect(ver?.created_by).toBe("operator");
    expect(ver?.critic_verdict).toBe("fail_returned_anyway");
    expect(ver?.critic_critique).toContain("vague");
  });

  it("override is a no-op when critic passes (R1-R2 fold: override fires only on fail/error)", async () => {
    mockInfer.mockResolvedValueOnce(passVerdict);
    const result = await skillSave(FIXTURE, {
      createdBy: "operator",
      forceOperatorOverride: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Critic passed → override is ignored → verdict stays 'pass', not 'fail_returned_anyway'
    expect(result.criticVerdict).toBe("pass");

    const db = getDatabase();
    const ver = db
      .prepare("SELECT critic_verdict FROM skill_versions WHERE id = ?")
      .get(result.versionId) as { critic_verdict: string };
    expect(ver.critic_verdict).toBe("pass");
  });

  it("override also writes on critic_error (infrastructure failure)", async () => {
    mockInfer.mockResolvedValueOnce({
      content: "",
      usage: {},
    } as Awaited<ReturnType<typeof infer>>);
    const result = await skillSave(FIXTURE, { forceOperatorOverride: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.criticVerdict).toBe("fail_returned_anyway");
  });
});

describe("skillSave — version conflicts", () => {
  it("returns 'unchanged' when same (name, version, body) is saved twice", async () => {
    mockInfer.mockResolvedValue(passVerdict);

    const first = await skillSave(FIXTURE);
    expect(first.ok).toBe(true);

    const second = await skillSave(FIXTURE);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.kind).toBe("unchanged");

    const db = getDatabase();
    const count = (
      db.prepare("SELECT COUNT(*) as n FROM skill_versions").get() as {
        n: number;
      }
    ).n;
    expect(count).toBe(1);
  });

  it("returns 'drift' when same version is saved with different body", async () => {
    mockInfer.mockResolvedValue(passVerdict);

    await skillSave(FIXTURE);
    const edited = { ...FIXTURE, body: FIXTURE.body + "\n\nedited" };
    const result = await skillSave(edited);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("drift");
    expect(result.critique).toContain("Bump frontmatter");
    expect(result.existingShaPrefix).toMatch(/^[a-f0-9]{8}$/);
  });

  it("accepts a version bump as a new skill_versions row", async () => {
    mockInfer.mockResolvedValue(passVerdict);

    await skillSave(FIXTURE);
    const bumped: ParsedSkillFile = {
      frontmatter: { ...FIXTURE.frontmatter, version: "1.1.0" },
      body: FIXTURE.body + "\n\n# Phase 2 addendum",
    };
    const result = await skillSave(bumped);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const db = getDatabase();
    const versions = db
      .prepare("SELECT version FROM skill_versions ORDER BY id ASC")
      .all() as Array<{ version: string }>;
    expect(versions.map((v) => v.version)).toEqual(["1.0.0", "1.1.0"]);

    const skill = db
      .prepare("SELECT version FROM skills WHERE name = ?")
      .get("echo-skill") as { version: string };
    expect(skill.version).toBe("1.1.0");
  });
});

describe("skillRevise", () => {
  it("defaults createdBy to 'refiner'", async () => {
    mockInfer.mockResolvedValueOnce(passVerdict);
    const result = await skillRevise(FIXTURE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const db = getDatabase();
    const ver = db
      .prepare("SELECT created_by FROM skill_versions WHERE id = ?")
      .get(result.versionId) as { created_by: string };
    expect(ver.created_by).toBe("refiner");
  });

  it("respects explicit createdBy override", async () => {
    mockInfer.mockResolvedValueOnce(passVerdict);
    const result = await skillRevise(FIXTURE, { createdBy: "operator" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const db = getDatabase();
    const ver = db
      .prepare("SELECT created_by FROM skill_versions WHERE id = ?")
      .get(result.versionId) as { created_by: string };
    expect(ver.created_by).toBe("operator");
  });
});
