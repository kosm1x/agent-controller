import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { upsertFile } from "../db/jarvis-fs.js";
import { loadSkillsFromJarvisFiles, LoaderLog } from "./loader.js";

let testKbDir: string;

const SILENT_LOG: LoaderLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const VALID = `---
name: send-followup
description: Sends a follow-up WhatsApp message to a lead after a stalled conversation.
version: 1.0.0
output_type: text
trigger_examples:
  - "Send a follow-up to the lead"
  - "Reach out to the contact about Acme"
  - "Check status on the prospect for Q3"
tools_used:
  - whatsapp_send
  - crm_query
inputs_json: '[{"name":"lead_id","type":"string","required":true}]'
tests_json: '[{"name":"happy","input":{"lead_id":"L1"},"expect":{}}]'
---
# Steps

1. Look up the lead.
2. Compose a message.
3. Send it via whatsapp.
`;

beforeEach(() => {
  testKbDir = mkdtempSync(join(tmpdir(), "mc-skills-loader-test-"));
  process.env.JARVIS_KB_MIRROR_DIR = testKbDir;
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
  rmSync(testKbDir, { recursive: true, force: true });
  delete process.env.JARVIS_KB_MIRROR_DIR;
});

describe("loadSkillsFromJarvisFiles", () => {
  it("is a no-op on empty namespace (Phase 1 ship state)", () => {
    const result = loadSkillsFromJarvisFiles(SILENT_LOG);
    expect(result.loaded).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.drift).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("registers a single skill from jarvis_files", () => {
    upsertFile("skills/send-followup/SKILL.md", "send-followup", VALID);
    const result = loadSkillsFromJarvisFiles(SILENT_LOG);
    expect(result.loaded).toBe(1);
    expect(result.errors).toEqual([]);

    const db = getDatabase();
    const versions = db
      .prepare("SELECT skill_id, version, body_sha256 FROM skill_versions")
      .all() as Array<{
      skill_id: string;
      version: string;
      body_sha256: string;
    }>;
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe("1.0.0");
    expect(versions[0].body_sha256).toMatch(/^[a-f0-9]{64}$/);

    const skill = db
      .prepare(
        "SELECT skill_id, name, version, current_version_id, output_type FROM skills WHERE name = ?",
      )
      .get("send-followup") as
      | {
          skill_id: string;
          name: string;
          version: string;
          current_version_id: number;
          output_type: string;
        }
      | undefined;
    expect(skill).toBeDefined();
    expect(skill?.version).toBe("1.0.0");
    expect(skill?.output_type).toBe("text");
    expect(skill?.current_version_id).toBeGreaterThan(0);
  });

  it("is idempotent — second run does not insert a new version", () => {
    upsertFile("skills/send-followup/SKILL.md", "send-followup", VALID);
    loadSkillsFromJarvisFiles(SILENT_LOG);
    const second = loadSkillsFromJarvisFiles(SILENT_LOG);

    expect(second.loaded).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.errors).toEqual([]);

    const db = getDatabase();
    const count = (
      db.prepare("SELECT COUNT(*) as n FROM skill_versions").get() as {
        n: number;
      }
    ).n;
    expect(count).toBe(1);
  });

  it("detects body drift on a pinned version — does NOT overwrite", () => {
    upsertFile("skills/send-followup/SKILL.md", "send-followup", VALID);
    loadSkillsFromJarvisFiles(SILENT_LOG);

    // Edit body content without bumping `version`. Loader must refuse
    // to silently overwrite — that's a forensic-trail invariant.
    const edited = VALID.replace(
      "3. Send it via whatsapp.",
      "3. Send it via whatsapp and log to CRM.",
    );
    upsertFile("skills/send-followup/SKILL.md", "send-followup", edited);

    const result = loadSkillsFromJarvisFiles(SILENT_LOG);
    expect(result.loaded).toBe(0);
    expect(result.drift).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].kind).toBe("drift");
    expect(result.errors[0].message).toContain("bump version");

    const db = getDatabase();
    const count = (
      db.prepare("SELECT COUNT(*) as n FROM skill_versions").get() as {
        n: number;
      }
    ).n;
    expect(count).toBe(1); // no new version
  });

  it("accepts a version bump as a new skill_versions row", () => {
    upsertFile("skills/send-followup/SKILL.md", "send-followup", VALID);
    loadSkillsFromJarvisFiles(SILENT_LOG);

    const bumped = VALID.replace("version: 1.0.0", "version: 1.1.0").replace(
      "3. Send it via whatsapp.",
      "3. Send it via whatsapp and log to CRM.",
    );
    upsertFile("skills/send-followup/SKILL.md", "send-followup", bumped);

    const result = loadSkillsFromJarvisFiles(SILENT_LOG);
    expect(result.loaded).toBe(1);
    expect(result.errors).toEqual([]);

    const db = getDatabase();
    const versions = db
      .prepare(
        "SELECT version FROM skill_versions WHERE skill_id = (SELECT skill_id FROM skills WHERE name = ?) ORDER BY id ASC",
      )
      .all("send-followup") as Array<{ version: string }>;
    expect(versions.map((v) => v.version)).toEqual(["1.0.0", "1.1.0"]);

    // skills row points at the new version
    const skill = db
      .prepare("SELECT version, current_version_id FROM skills WHERE name = ?")
      .get("send-followup") as
      | { version: string; current_version_id: number }
      | undefined;
    expect(skill?.version).toBe("1.1.0");
  });

  it("reports a parse error for a malformed SKILL.md but continues with the rest", () => {
    upsertFile(
      "skills/broken/SKILL.md",
      "broken",
      "no fence here\nname: broken\n",
    );
    upsertFile("skills/send-followup/SKILL.md", "send-followup", VALID);

    const result = loadSkillsFromJarvisFiles(SILENT_LOG);
    expect(result.loaded).toBe(1); // the good one still ships
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].kind).toBe("parse");
    expect(result.errors[0].path).toBe("skills/broken/SKILL.md");
  });

  it("ignores REFERENCE.md and scripts/ under the skills/ prefix", () => {
    upsertFile(
      "skills/send-followup/REFERENCE.md",
      "ref",
      "# this is reference material, not a SKILL.md",
    );
    upsertFile(
      "skills/send-followup/scripts/helper.ts",
      "helper",
      "export const x = 1;",
    );

    const result = loadSkillsFromJarvisFiles(SILENT_LOG);
    expect(result.loaded).toBe(0);
    expect(result.errors).toEqual([]);
  });
});
