/**
 * Versioned-skill KB write path: jarvis_file_write on skills/<name>/SKILL.md
 * registers the skill (critic-gated) before the file lands, the sibling
 * writers refuse the path, and skill_load / skill_save give accurate guidance
 * for legacy (unversioned) skill_save procedures.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { getFile, upsertFile } from "../db/jarvis-fs.js";
import { reindexJarvisKb } from "../db/jarvis-reindex.js";
import { infer } from "../inference/adapter.js";
import {
  jarvisFileWriteTool,
  jarvisFileUpdateTool,
  jarvisFileMoveTool,
  jarvisFileDeleteTool,
  jarvisFilesBatchWriteTool,
  jarvisFilesBatchDeleteTool,
} from "../tools/builtin/jarvis-files.js";
import { skillLoadTool } from "../tools/builtin/skill-load.js";
import { skillSaveTool } from "../tools/builtin/skills.js";
import { isSkillFileDiskPath } from "../tools/builtin/immutable-core.js";
import { runSkill } from "./dispatcher.js";
import { parseSkillFile } from "./frontmatter.js";
import { skillSave } from "./lifecycle.js";
import { loadSkillsFromJarvisFiles } from "./loader.js";
import { pointSkillAtVersion } from "./storage.js";
import { runSkillTests } from "./test-runner.js";

vi.mock("../inference/adapter.js", () => ({
  infer: vi.fn(),
}));

const mockInfer = vi.mocked(infer);
const pass = {
  content: '{"verdict": "pass", "critique": ""}',
  usage: { cost_usd: 0.001 },
} as Awaited<ReturnType<typeof infer>>;
const reject = {
  content: '{"verdict": "fail", "critique": "Steps are too vague."}',
  usage: { cost_usd: 0.001 },
} as Awaited<ReturnType<typeof infer>>;
const reply = (content: string) =>
  ({ content, usage: { cost_usd: 0.001 } }) as Awaited<ReturnType<typeof infer>>;
const TESTS =
  '[{"name":"happy_path","input":{"brief":"Despacho contable"},"expect":{"output_match":{"ok":true}}},' +
  '{"name":"empty_brief","input":{"brief":""},"expect_error":{"class":"INPUT_REQUIRED","detail_contains":"brief"}}]';
const HAPPY = reply('{"ok":true}');
const EMPTY_BRIEF = reply('{"error":"INPUT_REQUIRED","detail":"brief es obligatorio"}');

const PATH = "skills/ogilvy-slogan/SKILL.md";

function skillFile(
  opts: { version?: string; body?: string; description?: string; tests?: string } = {},
): string {
  return `---
name: ogilvy-slogan
description: ${opts.description ?? "Genera 3 opciones de slogan con los 7 principios de Ogilvy."}
version: ${opts.version ?? "1.0.0"}
output_type: text
trigger_examples:
  - "Hazme un slogan para mi marca"
  - "Necesito opciones de slogan"
  - "Crea un slogan estilo Ogilvy"
tools_used:
inputs_json: '[{"name":"brief","type":"string","required":true,"description":"Marca y producto"}]'
tests_json: '${opts.tests ?? "[]"}'
---

${opts.body ?? "# Ogilvy slogan\n\n## Steps\n1. Decodificar la marca.\n2. Escribir 3 opciones."}`;
}

async function write(path: string, content: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await jarvisFileWriteTool.execute({ path, title: "Ogilvy slogan", content }),
  );
}

function versionCount(): number {
  return (
    getDatabase().prepare("SELECT COUNT(*) AS n FROM skill_versions").get() as {
      n: number;
    }
  ).n;
}

let kbDir: string;

beforeEach(() => {
  kbDir = mkdtempSync(join(tmpdir(), "mc-skills-kbfile-test-"));
  process.env.JARVIS_KB_MIRROR_DIR = kbDir;
  initDatabase(":memory:");
  mockInfer.mockReset();
});

afterEach(() => {
  closeDatabase();
  rmSync(kbDir, { recursive: true, force: true });
  delete process.env.JARVIS_KB_MIRROR_DIR;
});

describe("jarvis_file_write on skills/<name>/SKILL.md", () => {
  it("registers the skill before writing the file, so skill_load works at once", async () => {
    mockInfer.mockResolvedValueOnce(pass);
    const r = await write(PATH, skillFile());
    expect(r.success).toBe(true);
    expect(r.skill).toMatchObject({
      name: "ogilvy-slogan",
      version: "1.0.0",
      status: "registered",
      certified: false,
    });
    expect(String((r.skill as { next: string }).next)).toContain("no valid tests");
    expect(getFile(PATH)?.content).toBe(skillFile());

    const row = getDatabase()
      .prepare(
        "SELECT s.current_version_id, s.body_path, v.created_by, v.critic_verdict FROM skills s JOIN skill_versions v ON v.id = s.current_version_id WHERE s.name = ?",
      )
      .get("ogilvy-slogan") as Record<string, unknown>;
    expect(row).toMatchObject({
      body_path: PATH,
      created_by: "refiner",
      critic_verdict: "pass",
    });

    const loaded = JSON.parse(await skillLoadTool.execute({ name: "ogilvy-slogan" }));
    expect(loaded.ok).toBe(true);
    expect(loaded.skill.version).toBe("1.0.0");
    expect(loaded.skill.body).toContain("Decodificar la marca");
  });

  it("leaves the next boot scan a no-op for a registered file", async () => {
    mockInfer.mockResolvedValueOnce(pass);
    await write(PATH, skillFile());
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const boot = loadSkillsFromJarvisFiles(log);
    expect(boot).toMatchObject({ loaded: 0, skipped: 1, drift: 0 });
  });

  it("writes nothing when the critic rejects the file", async () => {
    mockInfer.mockResolvedValueOnce(reject);
    const r = await write(PATH, skillFile());
    expect(r).toMatchObject({
      error: "SKILL_CRITIC_FAILED",
      critique: "Steps are too vague.",
      saved: false,
    });
    expect(getFile(PATH)).toBeNull();
    expect(versionCount()).toBe(0);
  });

  it("writes nothing when the critic cannot run", async () => {
    mockInfer.mockRejectedValueOnce(new Error("provider down"));
    const r = await write(PATH, skillFile());
    expect(r.error).toBe("SKILL_CRITIC_UNAVAILABLE");
    expect(getFile(PATH)).toBeNull();
    expect(versionCount()).toBe(0);
  });

  it("returns the frontmatter format on invalid frontmatter, without calling the critic", async () => {
    const r = await write(PATH, skillFile().replace("version: 1.0.0", "version: 1"));
    expect(r.error).toBe("SKILL_FRONTMATTER_INVALID");
    expect(String(r.message)).toContain("version");
    expect(String(r.format)).toContain("trigger_examples:");
    expect(mockInfer).not.toHaveBeenCalled();
    expect(getFile(PATH)).toBeNull();
  });

  it("refuses a frontmatter name that differs from the folder", async () => {
    const r = await write("skills/otro-nombre/SKILL.md", skillFile());
    expect(r.error).toBe("SKILL_NAME_MISMATCH");
    expect(mockInfer).not.toHaveBeenCalled();
  });

  it("refuses spellings the boot loader would never register", async () => {
    for (const p of [
      "skills/Ogilvy-Slogan/SKILL.md",
      "skills/ogilvy-slogan/skill.md",
      "./skills/ogilvy-slogan/SKILL.md",
      "skills/ogilvy_slogan/SKILL.md",
      "knowledge/../skills/ogilvy-slogan/SKILL.md",
    ]) {
      const r = await write(p, skillFile());
      expect(r.error, p).toBe("SKILL_PATH_INVALID");
      expect(getFile(p), p).toBeNull();
    }
    expect(mockInfer).not.toHaveBeenCalled();
  });

  it("registers a new version and moves the pointer", async () => {
    mockInfer.mockResolvedValue(pass);
    await write(PATH, skillFile());
    const r = await write(PATH, skillFile({ version: "1.1.0", body: "# v2\n\n1. Nuevo paso." }));
    expect(r.skill).toMatchObject({ version: "1.1.0", status: "registered" });
    const loaded = JSON.parse(await skillLoadTool.execute({ name: "ogilvy-slogan" }));
    expect(loaded.skill.version).toBe("1.1.0");
    expect(versionCount()).toBe(2);
  });

  it("refuses a changed body under the same version and keeps the old file", async () => {
    mockInfer.mockResolvedValue(pass);
    await write(PATH, skillFile());
    const r = await write(PATH, skillFile({ body: "# changed\n\n1. Otro paso." }));
    expect(r.error).toBe("SKILL_VERSION_EXISTS");
    expect(getFile(PATH)?.content).toBe(skillFile());
  });

  it("refuses changed frontmatter under the same version and body", async () => {
    mockInfer.mockResolvedValue(pass);
    await write(PATH, skillFile());
    const r = await write(PATH, skillFile({ description: "Otra descripcion distinta." }));
    expect(r.error).toBe("SKILL_VERSION_EXISTS");
    expect(getFile(PATH)?.content).toBe(skillFile());
  });

  it("accepts an identical rewrite as unchanged", async () => {
    mockInfer.mockResolvedValue(pass);
    await write(PATH, skillFile());
    const r = await write(PATH, skillFile());
    expect(r.success).toBe(true);
    expect(r.skill).toMatchObject({ status: "unchanged" });
  });

  it("settles a registered version without calling the critic", async () => {
    mockInfer.mockResolvedValueOnce(pass);
    await write(PATH, skillFile());
    mockInfer.mockReset();
    const same = await write(PATH, skillFile());
    expect(same.skill).toMatchObject({ status: "unchanged" });
    const changed = await write(PATH, skillFile({ body: "# otro\n\n1. Paso." }));
    expect(changed.error).toBe("SKILL_VERSION_EXISTS");
    expect(mockInfer).not.toHaveBeenCalled();
  });

  it("refuses rewriting an older, no-longer-current version", async () => {
    mockInfer.mockResolvedValue(pass);
    await write(PATH, skillFile());
    await write(PATH, skillFile({ version: "1.1.0", body: "# v2\n\n1. Nuevo." }));
    const r = await write(PATH, skillFile());
    expect(r.error).toBe("SKILL_VERSION_NOT_HIGHER");
    expect(String(r.message)).toContain("current version 1.1.0");
  });

  it("decertifies a certified skill when a new version is registered", async () => {
    mockInfer.mockResolvedValue(pass);
    await write(PATH, skillFile());
    getDatabase().prepare("UPDATE skills SET is_certified = 1 WHERE name = 'ogilvy-slogan'").run();
    const r = await write(PATH, skillFile({ version: "2.0.0", body: "# v2\n\n1. Nuevo." }));
    expect(r.skill).toMatchObject({ status: "registered", certified: false });
    const row = getDatabase()
      .prepare("SELECT is_certified FROM skills WHERE name = 'ogilvy-slogan'")
      .get() as { is_certified: number };
    expect(row.is_certified).toBe(0);
  });

  it("writes other files under skills/ without the critic", async () => {
    const r = await write("skills/ogilvy-slogan/REFERENCE.md", "# notas");
    expect(r.success).toBe(true);
    expect(r.skill).toBeUndefined();
    expect(mockInfer).not.toHaveBeenCalled();
  });
});

describe("auto-certification on registration", () => {
  function certifiedFlag(): number {
    return (
      getDatabase()
        .prepare("SELECT is_certified FROM skills WHERE name = 'ogilvy-slogan'")
        .get() as { is_certified: number }
    ).is_certified;
  }

  it("certifies a new version whose tests all pass", async () => {
    mockInfer
      .mockResolvedValueOnce(pass)
      .mockResolvedValueOnce(HAPPY)
      .mockResolvedValueOnce(EMPTY_BRIEF);
    const r = await write(PATH, skillFile({ tests: TESTS }));
    expect(r.skill).toMatchObject({
      status: "registered",
      certified: true,
      tests: [
        { name: "happy_path", result: "pass" },
        { name: "empty_brief", result: "pass" },
      ],
    });
    expect(String((r.skill as { next: string }).next)).toContain("Certified");
    expect(certifiedFlag()).toBe(1);
    const runs = getDatabase()
      .prepare("SELECT COUNT(*) AS n FROM skill_test_runs WHERE result = 'pass'")
      .get() as { n: number };
    expect(runs.n).toBe(2);
  });

  it("registers but does not certify when a test fails, and names the failure", async () => {
    mockInfer
      .mockResolvedValueOnce(pass)
      .mockResolvedValueOnce(reply('{"ok":false}'))
      .mockResolvedValueOnce(EMPTY_BRIEF);
    const r = await write(PATH, skillFile({ tests: TESTS }));
    expect(r.success).toBe(true);
    expect(r.skill).toMatchObject({ status: "registered", certified: false });
    const next = String((r.skill as { next: string }).next);
    expect(next).toContain("happy_path (fail");
    expect(next).toContain("higher `version`");
    expect(certifiedFlag()).toBe(0);
  });

  it("a failing new version of a certified skill leaves it uncertified", async () => {
    mockInfer
      .mockResolvedValueOnce(pass)
      .mockResolvedValueOnce(HAPPY)
      .mockResolvedValueOnce(EMPTY_BRIEF);
    await write(PATH, skillFile({ tests: TESTS }));
    expect(certifiedFlag()).toBe(1);
    mockInfer
      .mockResolvedValueOnce(pass)
      .mockResolvedValueOnce(HAPPY)
      .mockResolvedValueOnce(reply('{"error":"OTHER","detail":"x"}'));
    const r = await write(
      PATH,
      skillFile({ version: "1.1.0", body: "# v2\n\n1. Nuevo.", tests: TESTS }),
    );
    expect(r.skill).toMatchObject({ version: "1.1.0", certified: false });
    expect(certifiedFlag()).toBe(0);
  });

  it("re-runs the tests of an uncertified current version on an identical rewrite", async () => {
    mockInfer
      .mockResolvedValueOnce(pass)
      .mockRejectedValueOnce(new Error("provider down"))
      .mockResolvedValueOnce(EMPTY_BRIEF);
    const first = await write(PATH, skillFile({ tests: TESTS }));
    expect(first.skill).toMatchObject({ certified: false });
    mockInfer.mockReset();
    mockInfer.mockResolvedValueOnce(HAPPY).mockResolvedValueOnce(EMPTY_BRIEF);
    const again = await write(PATH, skillFile({ tests: TESTS }));
    expect(again.skill).toMatchObject({ status: "unchanged", certified: true });
    expect(mockInfer).toHaveBeenCalledTimes(2); // the two tests, no critic
    expect(certifiedFlag()).toBe(1);
  });

  it("does not re-run a version whose test failed; it needs a new version", async () => {
    mockInfer
      .mockResolvedValueOnce(pass)
      .mockResolvedValueOnce(reply('{"ok":false}'))
      .mockResolvedValueOnce(EMPTY_BRIEF);
    await write(PATH, skillFile({ tests: TESTS }));
    mockInfer.mockReset();
    const again = await write(PATH, skillFile({ tests: TESTS }));
    expect(again.skill).toMatchObject({ status: "unchanged", certified: false });
    expect(String((again.skill as { next: string }).next)).toContain("failed its tests");
    expect(mockInfer).not.toHaveBeenCalled();
  });

  it("stops re-running unfinished tests after 3 runs of a version", async () => {
    mockInfer.mockResolvedValueOnce(pass).mockRejectedValue(new Error("provider down"));
    await write(PATH, skillFile({ tests: TESTS })); // run 1
    await write(PATH, skillFile({ tests: TESTS })); // run 2
    await write(PATH, skillFile({ tests: TESTS })); // run 3
    mockInfer.mockReset();
    const fourth = await write(PATH, skillFile({ tests: TESTS }));
    expect(fourth.skill).toMatchObject({ certified: false });
    expect(String((fourth.skill as { next: string }).next)).toContain("did not finish in 3 runs");
    expect(mockInfer).not.toHaveBeenCalled();
  });

  it("writes the KB file before running the tests", async () => {
    let seen: string | undefined;
    mockInfer
      .mockResolvedValueOnce(pass)
      .mockImplementationOnce(async () => {
        seen = getFile(PATH)?.content;
        return HAPPY;
      })
      .mockResolvedValueOnce(EMPTY_BRIEF);
    await write(PATH, skillFile({ tests: TESTS }));
    expect(seen).toBe(skillFile({ tests: TESTS }));
  });

  it("a test run of a superseded version cannot certify the current one", async () => {
    mockInfer
      .mockResolvedValueOnce(pass)
      .mockResolvedValueOnce(HAPPY)
      .mockResolvedValueOnce(EMPTY_BRIEF);
    await write(PATH, skillFile({ tests: TESTS }));
    const db = getDatabase();
    const old = db
      .prepare("SELECT skill_id, current_version_id AS id FROM skills WHERE name = 'ogilvy-slogan'")
      .get() as { skill_id: string; id: number };
    mockInfer
      .mockResolvedValueOnce(pass)
      .mockResolvedValueOnce(reply('{"ok":false}'))
      .mockResolvedValueOnce(EMPTY_BRIEF);
    await write(PATH, skillFile({ version: "1.1.0", body: "# v2\n\n1. Nuevo.", tests: TESTS }));
    expect(certifiedFlag()).toBe(0);
    mockInfer.mockResolvedValueOnce(HAPPY).mockResolvedValueOnce(EMPTY_BRIEF);
    const late = await runSkillTests(old.skill_id, old.id);
    expect(late.certified).toBe(false);
    expect(certifiedFlag()).toBe(0);
  });

  it("every pointer move decertifies: boot scan and skillSave of a new version", async () => {
    mockInfer
      .mockResolvedValueOnce(pass)
      .mockResolvedValueOnce(HAPPY)
      .mockResolvedValueOnce(EMPTY_BRIEF);
    await write(PATH, skillFile({ tests: TESTS }));
    expect(certifiedFlag()).toBe(1);
    upsertFile(PATH, "Ogilvy slogan", skillFile({ version: "1.1.0", body: "# roto", tests: TESTS }));
    loadSkillsFromJarvisFiles({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    expect(certifiedFlag()).toBe(0);
    getDatabase().prepare("UPDATE skills SET is_certified = 1 WHERE name = 'ogilvy-slogan'").run();
    mockInfer.mockResolvedValueOnce(pass);
    await skillSave(parseSkillFile(skillFile({ version: "1.2.0", body: "# otro", tests: TESTS })));
    expect(certifiedFlag()).toBe(0);
  });

  it("says a no-tests skill has no valid tests on an identical rewrite", async () => {
    mockInfer.mockResolvedValueOnce(pass);
    await write(PATH, skillFile());
    const again = await write(PATH, skillFile());
    expect(String((again.skill as { next: string }).next)).toContain("no valid tests");
  });

  it("does not re-run the tests of a certified version on an identical rewrite", async () => {
    mockInfer
      .mockResolvedValueOnce(pass)
      .mockResolvedValueOnce(HAPPY)
      .mockResolvedValueOnce(EMPTY_BRIEF);
    await write(PATH, skillFile({ tests: TESTS }));
    mockInfer.mockReset();
    const again = await write(PATH, skillFile({ tests: TESTS }));
    expect(again.skill).toMatchObject({ status: "unchanged", certified: true });
    expect(mockInfer).not.toHaveBeenCalled();
  });
});

describe("versions only move up", () => {
  function current(): string {
    return (
      getDatabase()
        .prepare(
          "SELECT v.version FROM skills s JOIN skill_versions v ON v.id = s.current_version_id WHERE s.name = 'ogilvy-slogan'",
        )
        .get() as { version: string }
    ).version;
  }

  it("kb write: refuses a new lower version before the critic", async () => {
    mockInfer.mockResolvedValue(pass);
    await write(PATH, skillFile({ version: "1.1.0" }));
    mockInfer.mockReset();
    const r = await write(PATH, skillFile({ version: "1.0.5", body: "# old\n\n1. Paso." }));
    expect(r).toMatchObject({ error: "SKILL_VERSION_NOT_HIGHER", saved: false });
    expect(String(r.message)).toContain("higher than 1.1.0");
    expect(mockInfer).not.toHaveBeenCalled();
    expect(versionCount()).toBe(1);
    expect(current()).toBe("1.1.0");
    expect(getFile(PATH)?.content).toBe(skillFile({ version: "1.1.0" }));
  });

  it("compares versions numerically, not as text", async () => {
    mockInfer.mockResolvedValue(pass);
    await write(PATH, skillFile({ version: "1.9.0" }));
    const r = await write(PATH, skillFile({ version: "1.10.0", body: "# v10\n\n1. Paso." }));
    expect(r.skill).toMatchObject({ version: "1.10.0", status: "registered" });
    expect(current()).toBe("1.10.0");
  });

  it("kb write: names a registered-but-not-current higher version", async () => {
    mockInfer.mockResolvedValue(pass);
    await write(PATH, skillFile());
    const db = getDatabase();
    db.prepare(
      `INSERT INTO skill_versions (skill_id, version, body, body_sha256, inputs_json, tests_json, tools_used_json, created_by)
       SELECT skill_id, '2.0.0', 'orphan', 'x', '[]', '[]', '[]', 'operator' FROM skills WHERE name = 'ogilvy-slogan'`,
    ).run();
    const r = await write(PATH, skillFile({ version: "2.0.0" }));
    expect(r.error).toBe("SKILL_VERSION_EXISTS");
    expect(String(r.message)).toContain("not its current version (1.0.0)");
  });

  it("skillSave refuses, atomically, when a higher version lands during the critic", async () => {
    mockInfer.mockResolvedValue(pass);
    await write(PATH, skillFile());
    mockInfer.mockReset();
    mockInfer.mockImplementationOnce(async () => {
      const db = getDatabase();
      const { skill_id } = db
        .prepare("SELECT skill_id FROM skills WHERE name = 'ogilvy-slogan'")
        .get() as { skill_id: string };
      const id = db
        .prepare(
          `INSERT INTO skill_versions (skill_id, version, body, body_sha256, inputs_json, tests_json, tools_used_json, created_by)
           VALUES (?, '3.0.0', 'x', 'x', '[]', '[]', '[]', 'operator')`,
        )
        .run(skill_id).lastInsertRowid;
      db.prepare("UPDATE skills SET current_version_id = ? WHERE skill_id = ?").run(id, skill_id);
      return pass;
    });
    const r = await skillSave(
      parseSkillFile(skillFile({ version: "2.0.0", body: "# v2\n\n1. Paso." })),
    );
    expect(r).toMatchObject({ ok: false, kind: "version_not_higher" });
    const versions = getDatabase()
      .prepare("SELECT version FROM skill_versions ORDER BY id")
      .all()
      .map((v) => (v as { version: string }).version);
    expect(versions).toEqual(["1.0.0", "3.0.0"]);
    expect(current()).toBe("3.0.0");
  });

  it("refuses versions with leading zeros", async () => {
    const r = await write(PATH, skillFile({ version: "1.0.01" }));
    expect(r.error).toBe("SKILL_FRONTMATTER_INVALID");
  });

  it("skillSave refuses a lower version without calling the critic", async () => {
    mockInfer.mockResolvedValue(pass);
    await write(PATH, skillFile({ version: "2.0.0" }));
    mockInfer.mockReset();
    const r = await skillSave(parseSkillFile(skillFile({ body: "# v1\n\n1. Paso." })));
    expect(r).toMatchObject({ ok: false, kind: "version_not_higher" });
    expect(mockInfer).not.toHaveBeenCalled();
    expect(versionCount()).toBe(1);
  });

  it("boot scan skips a KB file older than the current version", async () => {
    mockInfer.mockResolvedValue(pass);
    await write(PATH, skillFile({ version: "2.0.0" }));
    upsertFile(PATH, "Ogilvy slogan", skillFile({ version: "1.5.0", body: "# old\n\n1. Paso." }));
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const boot = loadSkillsFromJarvisFiles(log);
    expect(boot.loaded).toBe(0);
    expect(boot.errors).toEqual([
      expect.objectContaining({ path: PATH, kind: "version_not_higher" }),
    ]);
    expect(versionCount()).toBe(1);
    expect(current()).toBe("2.0.0");
  });

  it("the database refuses pointing a skill at a lower version, whoever writes", async () => {
    mockInfer.mockResolvedValue(pass);
    await write(PATH, skillFile());
    await write(PATH, skillFile({ version: "1.2.0", body: "# v2\n\n1. Paso." }));
    const db = getDatabase();
    const { skill_id } = db
      .prepare("SELECT skill_id FROM skills WHERE name = 'ogilvy-slogan'")
      .get() as { skill_id: string };
    const low = db
      .prepare("SELECT id FROM skill_versions WHERE version = '1.0.0'")
      .get() as { id: number };
    expect(() =>
      db
        .prepare("UPDATE skills SET current_version_id = ? WHERE skill_id = ?")
        .run(low.id, skill_id),
    ).toThrow(/SKILL_VERSION_NOT_HIGHER/);
    expect(() =>
      pointSkillAtVersion(skill_id, parseSkillFile(skillFile()).frontmatter, low.id),
    ).toThrow(/SKILL_VERSION_NOT_HIGHER/);
    expect(current()).toBe("1.2.0");
  });
});

describe("kb-reindex never imports a disk-only SKILL.md", () => {
  it("imports other skill files but not SKILL.md", () => {
    mkdirSync(join(kbDir, "skills", "x-y"), { recursive: true });
    writeFileSync(join(kbDir, "skills", "x-y", "SKILL.md"), skillFile());
    writeFileSync(join(kbDir, "skills", "x-y", "REFERENCE.md"), "# notas");
    reindexJarvisKb({ kbRoot: kbDir });
    expect(getFile("skills/x-y/SKILL.md")).toBeNull();
    expect(getFile("skills/x-y/REFERENCE.md")).not.toBeNull();
  });
});

describe("sibling KB writers refuse SKILL.md", () => {
  beforeEach(() => {
    upsertFile("drafts/ogilvy.md", "draft", skillFile());
    upsertFile(PATH, "skill", skillFile());
  });

  it.each([
    ["jarvis_file_update", () => jarvisFileUpdateTool.execute({ path: PATH, append: "\n4. extra" })],
    ["jarvis_file_move into", () => jarvisFileMoveTool.execute({ old_path: "drafts/ogilvy.md", new_path: "skills/x-y/SKILL.md" })],
    ["jarvis_file_move out", () => jarvisFileMoveTool.execute({ old_path: PATH, new_path: "drafts/moved.md" })],
    ["jarvis_file_delete", () => jarvisFileDeleteTool.execute({ path: PATH, confirmed: true })],
    ["jarvis_files_batch_write", () => jarvisFilesBatchWriteTool.execute({ files: [{ path: "skills/x-y/SKILL.md", title: "x", content: skillFile() }] })],
    ["jarvis_files_batch_delete", () => jarvisFilesBatchDeleteTool.execute({ paths: [PATH], confirmed: true })],
    ["jarvis_file_update (spelling)", () => jarvisFileUpdateTool.execute({ path: "Skills/ogilvy-slogan/skill.md", append: "x" })],
  ])("%s", async (_label, call) => {
    const r = JSON.parse(await call());
    expect(r.error).toBe("SKILL_FILE_PROTECTED");
    expect(getFile(PATH)?.content).toBe(skillFile());
    expect(getFile("skills/x-y/SKILL.md")).toBeNull();
    expect(getFile("drafts/ogilvy.md")).not.toBeNull();
  });
});

describe("legacy skill_save procedures", () => {
  function seedLegacy(name: string, steps: string[]): void {
    getDatabase()
      .prepare(
        "INSERT INTO skills (skill_id, name, description, trigger_text, steps, tools, source) VALUES (?, ?, 'desc', 'trig', ?, '[\"web_search\"]', 'manual')",
      )
      .run(`id-${name}`, name, JSON.stringify(steps));
  }

  it("skill_load returns the saved steps with an accurate note", async () => {
    seedLegacy("ogilvy_slogan", ["1. DECODIFICAR", "2. UN SOLO TRABAJO"]);
    const r = JSON.parse(await skillLoadTool.execute({ name: "ogilvy_slogan" }));
    expect(r.ok).toBe(true);
    expect(r.skill).toMatchObject({
      name: "ogilvy_slogan",
      versioned: false,
      steps: ["1. DECODIFICAR", "2. UN SOLO TRABAJO"],
      tools_used: ["web_search"],
    });
    expect(r.note).toContain("skills/<verb-led-kebab-name>/SKILL.md");
    expect(r.note).toContain("jarvis_file_write");
    expect(r.note).not.toContain("never went through");
  });

  it("skill_load keeps no_active_version for a row with no steps", async () => {
    seedLegacy("empty_one", []);
    const r = JSON.parse(await skillLoadTool.execute({ name: "empty_one" }));
    expect(r).toMatchObject({ ok: false, reason: "no_active_version" });
    expect(r.hint).toContain("jarvis_file_write");
  });

  it("skill_run explains the unversioned procedure instead of blaming skill_save", async () => {
    seedLegacy("ogilvy_slogan", ["1. DECODIFICAR"]);
    const r = await runSkill("ogilvy_slogan", {});
    expect(r.errorClass).toBe("no_active_version");
    expect(r.errorDetail).toContain("skill_load returns its saved steps");
  });

  it("skill_save says it saved an unversioned procedure", async () => {
    const r = JSON.parse(
      await skillSaveTool.execute({
        name: "ogilvy_slogan",
        description: "d",
        trigger: "t",
        steps: ["a", "b"],
        tools: [],
      }),
    );
    expect(r).toMatchObject({ saved: true, versioned: false });
    expect(r.note).toContain("skills/<verb-led-kebab-name>/SKILL.md");
  });
});

describe("isSkillFileDiskPath", () => {
  const root = "/srv/kb";
  it("matches SKILL.md under <kbRoot>/skills/<name>/ in any spelling", () => {
    for (const p of [
      "/srv/kb/skills/ogilvy-slogan/SKILL.md",
      "/srv/kb/knowledge/../skills/x/SKILL.md",
      "/srv/kb/Skills/x/skill.md",
    ]) {
      expect(isSkillFileDiskPath(p, root), p).toBe(true);
    }
  });
  it("lets other files and roots through", () => {
    for (const p of [
      "/srv/kb/skills/x/REFERENCE.md",
      "/srv/kb/skills/x/y/SKILL.md",
      "/srv/kb2/skills/x/SKILL.md",
      "/tmp/skills/x/SKILL.md",
    ]) {
      expect(isSkillFileDiskPath(p, root), p).toBe(false);
    }
  });
});
