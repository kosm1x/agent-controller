/**
 * S6 WS1 — project_update routes to the project record (spec
 * docs/planning/s6-project-contract-spec-2026-10-11.md §2 "Write paths").
 * Record present → the record's JSON block is rewritten through the registry
 * upsert path and the projector re-projects the row; record absent → today's
 * behaviour, byte-identical (snapshot below was captured against the
 * pre-change implementation). Synthetic fixtures only.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, initDatabase } from "../../db/index.js";
import { createProject, deleteProject, getProject } from "../../db/projects.js";
import { getFile, upsertFile } from "../../db/jarvis-fs.js";
import { upsertFromDiskWrite } from "../../db/jarvis-reindex.js";
import { parseProjectRecord, projectRecordRelPath } from "../../projects/record.js";
import { OPERATOR_ONLY_CONFIG_KEYS, projectUpdateTool } from "./projects.js";
import { cachedProjectStatus } from "../../lib/project-status-cache.js";

let kbDir: string;

beforeEach(() => {
  kbDir = mkdtempSync(join(tmpdir(), "mc-projrec-tool-"));
  process.env.JARVIS_KB_MIRROR_DIR = kbDir;
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
  rmSync(kbDir, { recursive: true, force: true });
  delete process.env.JARVIS_KB_MIRROR_DIR;
});

/** Row columns a caller can see, minus timestamps and the random id. */
function rowView(slug: string) {
  const p = getProject(slug)!;
  return {
    slug: p.slug,
    name: p.name,
    description: p.description,
    status: p.status,
    urls: p.urls,
    credentials: p.credentials,
    config: p.config,
    commit_goal_id: p.commit_goal_id,
  };
}

describe("project_update — no record: today's behaviour (snapshot of the pre-change implementation)", () => {
  it("update of a legacy row: same result string and same row", async () => {
    createProject("legacy-alpha", "Legacy Alpha", {
      description: "old text",
      urls: { site: "https://alpha.example.test", admin: "https://alpha.example.test/admin" },
      config: { phase: "one", nested: { a: 1, b: 2 } },
    });
    const out = await projectUpdateTool.execute({
      slug: "legacy-alpha",
      name: "Legacy Alpha Two",
      description: "new text",
      status: "paused",
      urls: { site: "https://alpha2.example.test", admin: null },
      config: { phase: "two", nested: { b: null, c: 3 }, aliases: ["alpha"] },
      commit_goal_id: "goal-synthetic-1",
    });
    expect(out).toBe(
      '{"action":"updated","project":{"slug":"legacy-alpha","name":"Legacy Alpha Two","status":"paused","credential_keys":[]}}',
    );
    expect(rowView("legacy-alpha")).toEqual({
      slug: "legacy-alpha",
      name: "Legacy Alpha Two",
      description: "new text",
      status: "paused",
      urls: { site: "https://alpha2.example.test" },
      credentials: {},
      config: { phase: "two", nested: { a: 1, c: 3 }, aliases: ["alpha"] },
      commit_goal_id: "goal-synthetic-1",
    });
  });

  it("create of a new slug: same result string and same row", async () => {
    const out = await projectUpdateTool.execute({
      slug: "fresh-beta",
      name: "Fresh Beta",
      // Queue 3b: stall_exempt became operator-only; a plain key keeps the snapshot.
      config: { phase: "one" },
    });
    expect(out).toBe(
      '{"action":"created","project":{"slug":"fresh-beta","name":"Fresh Beta","status":"active","credential_keys":[]}}',
    );
    expect(rowView("fresh-beta")).toEqual({
      slug: "fresh-beta",
      name: "Fresh Beta",
      description: "",
      status: "active",
      urls: {},
      credentials: {},
      config: { phase: "one" },
      commit_goal_id: null,
    });
  });
});

const block = (json: unknown) => "```json\n" + JSON.stringify(json, null, 2) + "\n```\n";
const REL = projectRecordRelPath("acme-radar");
const RECORD =
  "# Acme Radar\n\n" +
  block({
    slug: "acme-radar",
    name: "Acme Radar",
    status: "active",
    aliases: ["acme"],
    schedules: ["sched-0001"],
    links: { site: "https://acme.example.test" },
  }) +
  "\nSynthetic lead paragraph.\n\n## Runtime\n\nhand-written notes stay\n";

function seedRecord(): void {
  upsertFromDiskWrite(REL, RECORD); // registry row + row projection
}

const recordJson = () =>
  parseProjectRecord(String(getFile(REL)!.content), { folderSlug: "acme-radar" }).json;

describe("project_update — record present: the record is the write target", () => {
  it("name/status/description/urls.site/owned config go into the record; the row is re-projected", async () => {
    seedRecord();
    const out = JSON.parse(
      await projectUpdateTool.execute({
        slug: "acme-radar",
        name: "Acme Radar Two",
        status: "paused",
        description: "New synthetic lead.",
        urls: { site: "https://acme2.example.test" },
        config: { aliases: ["acme", "radar"], schedules: ["sched-0002"] },
      }),
    );
    expect(out.action).toBe("updated");
    expect(out.record).toBe(REL);
    const json = recordJson();
    expect(json.name).toBe("Acme Radar Two");
    expect(json.status).toBe("paused");
    expect(json.aliases).toEqual(["acme", "radar"]);
    expect(json.schedules).toEqual(["sched-0002"]);
    expect(json.links).toEqual({ site: "https://acme2.example.test" });
    const content = String(getFile(REL)!.content);
    expect(content).toContain("New synthetic lead.");
    expect(content).not.toContain("Synthetic lead paragraph.");
    expect(content).toContain("## Runtime\n\nhand-written notes stay");
    expect(content.startsWith("# Acme Radar\n\n```json")).toBe(true);
    const row = rowView("acme-radar");
    expect(row.name).toBe("Acme Radar Two");
    expect(row.status).toBe("paused");
    expect(row.description).toBe("New synthetic lead.");
    expect(row.urls).toEqual({ site: "https://acme2.example.test" });
    expect(row.config.aliases).toEqual(["acme", "radar"]);
    expect(row.config.schedules).toEqual(["sched-0002"]);
  });

  it("the row is NOT written directly for record-owned fields (only through the record)", async () => {
    seedRecord();
    // A record that will not parse after the change → nothing is written anywhere.
    const before = String(getFile(REL)!.content);
    const rowBefore = rowView("acme-radar");
    const out = JSON.parse(
      await projectUpdateTool.execute({ slug: "acme-radar", config: { repos: [{ path: "relative", role: "primary" }] } }),
    );
    expect(out.error).toMatch(/inválido/);
    expect(String(getFile(REL)!.content)).toBe(before);
    expect(rowView("acme-radar")).toEqual(rowBefore);
  });

  it("credentials, commit_goal_id and non-owned config/urls keys go straight to the row, never into the record", async () => {
    seedRecord();
    const pw = "pw-" + "z".repeat(14);
    const out = JSON.parse(
      await projectUpdateTool.execute({
        slug: "acme-radar",
        credentials: { app_password: pw },
        commit_goal_id: "goal-synthetic-2",
        config: { audience: "synthetic" },
        urls: { admin: "https://acme.example.test/admin" },
      }),
    );
    expect(out.action).toBe("updated");
    const row = rowView("acme-radar");
    expect(row.credentials).toEqual({ app_password: pw });
    expect(row.commit_goal_id).toBe("goal-synthetic-2");
    expect(row.config.audience).toBe("synthetic");
    expect(row.urls.admin).toBe("https://acme.example.test/admin");
    const content = String(getFile(REL)!.content);
    expect(content).toBe(RECORD); // record untouched
    expect(content).not.toContain(pw);
  });

  it("a credential-shaped value for a record-owned field is refused; nothing is written", async () => {
    seedRecord();
    const secret = "sk-" + "a".repeat(40);
    const out = JSON.parse(
      await projectUpdateTool.execute({ slug: "acme-radar", urls: { site: secret } }),
    );
    expect(out.error).toMatch(/credencial/);
    expect(String(getFile(REL)!.content)).toBe(RECORD);
  });

  it("a credential-shaped name or description is refused; nothing is written (R1 W2)", async () => {
    seedRecord();
    const secret = "sk-" + "d".repeat(40);
    for (const args of [{ description: `Usa la llave ${secret} para entrar.` }, { name: secret }]) {
      const out = JSON.parse(await projectUpdateTool.execute({ slug: "acme-radar", ...args }));
      expect(out.error).toMatch(/credencial/);
    }
    expect(String(getFile(REL)!.content)).toBe(RECORD);
    expect(String(getFile(REL)!.content)).not.toContain(secret);
  });

  it("ordinary prose with 'clave:' / 'token:' / 'Contraseña:' is not a credential (R2 W3); token shapes are", async () => {
    for (const description of [
      "Punto clave: expansión regional del radar.",
      "Mide el token: consumo semanal por corrida.",
      "Contraseña: pendiente de definir con el equipo.",
    ]) {
      seedRecord();
      const out = JSON.parse(await projectUpdateTool.execute({ slug: "acme-radar", description }));
      expect(out.error, description).toBeUndefined();
      expect(rowView("acme-radar").description).toBe(description);
    }
    const jwt = ["eyJ" + "a".repeat(12), "b".repeat(12), "c".repeat(12)].join(".");
    for (const description of [
      `Sesión ${jwt} activa.`,
      `Llave sk-${"f".repeat(32)} vieja.`,
      // R2b W1: an assignment, or a keyword with a single-token value, is not prose
      "password=" + "hunter2".repeat(2),
      "token: " + "abcd1234efgh5678ijkl",
    ]) {
      seedRecord();
      const out = JSON.parse(await projectUpdateTool.execute({ slug: "acme-radar", description }));
      expect(out.error).toMatch(/credencial/);
      expect(String(getFile(REL)!.content)).toBe(RECORD);
    }
  });

  it("a description the record cannot read back whole is refused; nothing is written (R2 W2)", async () => {
    for (const description of [
      "#1 prioridad del trimestre.",
      "Linea uno\n## Contexto\nmas",
      "Linea uno\n```\ncodigo\n```",
      "Linea uno\n#2 tarea siguiente",
    ]) {
      seedRecord();
      const out = JSON.parse(await projectUpdateTool.execute({ slug: "acme-radar", description }));
      expect(out.error, description).toMatch(/descripci[oó]n/);
      expect(String(getFile(REL)!.content)).toBe(RECORD);
    }
  });

  it("an odd fence line in a description is refused before the write (R2b W2)", async () => {
    for (const description of ["a\n```\nb", "a\n  ~~~\nb"]) {
      seedRecord();
      const out = JSON.parse(await projectUpdateTool.execute({ slug: "acme-radar", description }));
      expect(out.error, description).toMatch(/```/);
      expect(String(getFile(REL)!.content)).toBe(RECORD);
    }
  });

  it("clearing the description when the lead has a second paragraph is refused with its own message (R2b W3)", async () => {
    seedRecord();
    const two = JSON.parse(
      await projectUpdateTool.execute({ slug: "acme-radar", description: "Primer párrafo.\n\nSegundo párrafo." }),
    );
    expect(two.error).toBeUndefined(); // folded into one paragraph
    const md = String(getFile(REL)!.content).replace("Primer párrafo.\nSegundo párrafo.", "Primer párrafo.\n\nSegundo párrafo.");
    upsertFromDiskWrite(REL, md);
    const out = JSON.parse(await projectUpdateTool.execute({ slug: "acme-radar", description: "" }));
    expect(out.error).toMatch(/siguiente párrafo/);
    expect(String(getFile(REL)!.content)).toBe(md);
  });

  it("a call by row id routes through the record like the slug does (R1 W3)", async () => {
    seedRecord();
    const id = getProject("acme-radar")!.id;
    const out = JSON.parse(
      await projectUpdateTool.execute({ slug: id, status: "paused", config: { aliases: ["by-id"] } }),
    );
    expect(out.record).toBe(REL);
    expect(recordJson().status).toBe("paused");
    expect(recordJson().aliases).toEqual(["by-id"]);
    expect(rowView("acme-radar").status).toBe("paused");
  });

  it("null deletes an owned key from the record and the row", async () => {
    seedRecord();
    await projectUpdateTool.execute({ slug: "acme-radar", config: { aliases: null }, urls: { site: null } });
    const json = recordJson();
    expect(json.aliases).toBeUndefined();
    expect(json.links).toBeUndefined();
    const row = rowView("acme-radar");
    expect(row.config.aliases).toBeUndefined();
    expect(row.urls.site).toBeUndefined();
  });

  it("an invalid record on disk refuses the change instead of overwriting it", async () => {
    upsertFile(REL, "rec", "no json block here");
    const out = JSON.parse(await projectUpdateTool.execute({ slug: "acme-radar", name: "X" }));
    expect(out.error).toMatch(/no_json_block/);
    expect(String(getFile(REL)!.content)).toBe("no json block here");
    expect(getProject("acme-radar")).toBeNull();
  });

  it("a record without a row yet: the row is created from the record", async () => {
    upsertFile(REL, "rec", RECORD); // registry only, no projection
    expect(getProject("acme-radar")).toBeNull();
    const out = JSON.parse(
      await projectUpdateTool.execute({ slug: "acme-radar", commit_goal_id: "goal-synthetic-3" }),
    );
    expect(out.action).toBe("created");
    expect(rowView("acme-radar").commit_goal_id).toBe("goal-synthetic-3");
    expect(rowView("acme-radar").name).toBe("Acme Radar");
  });
});

describe("project_update — an operator-only key is refused only when its value CHANGES (audit R2 W1)", () => {
  it("record row: an echoed unchanged kb_readme passes (not written); a changed one is refused", async () => {
    seedRecord();
    const kb = getProject("acme-radar")!.config.kb_readme;
    const ok = JSON.parse(
      await projectUpdateTool.execute({ slug: "acme-radar", name: "Acme Radar Two", config: { kb_readme: kb } }),
    );
    expect(ok.error).toBeUndefined();
    expect(getProject("acme-radar")!.name).toBe("Acme Radar Two");
    expect(getProject("acme-radar")!.config.kb_readme).toBe(kb);
    const before = String(getFile(REL)!.content);
    const bad = JSON.parse(
      await projectUpdateTool.execute({ slug: "acme-radar", config: { kb_readme: "projects/elsewhere/README.md" } }),
    );
    expect(bad.error).toContain("config.kb_readme");
    expect(String(getFile(REL)!.content)).toBe(before);
  });

  it("S6 WS3: a record row carrying capabilities/secrets/routing/trusted — echo passes, a change is refused", async () => {
    const caps = { mcp: [{ command: "node", args: ["dist/mcp.js"], env: ["ACME_RADAR_TOKEN"], trust: "B" }] };
    const json = {
      ...parseProjectRecord(RECORD, { folderSlug: "acme-radar" }).json,
      trusted: true,
      secrets: ["SECRET_ACME_RADAR_TOKEN"],
      capabilities: caps,
      routing: { summary: "Acme radar runs" },
    };
    upsertFromDiskWrite(REL, block(json) + "\nSynthetic lead paragraph.\n");
    const row = getProject("acme-radar")!;
    expect(row.config.capabilities).toEqual(caps);
    const echo = JSON.parse(
      await projectUpdateTool.execute({
        slug: "acme-radar",
        name: "Acme Radar Three",
        config: {
          capabilities: row.config.capabilities,
          secrets: row.config.secrets,
          routing: row.config.routing,
          trusted: row.config.trusted,
        },
      }),
    );
    expect(echo.error).toBeUndefined();
    expect(getProject("acme-radar")!.name).toBe("Acme Radar Three");
    const before = String(getFile(REL)!.content);
    for (const config of [
      { capabilities: { mcp: [{ command: "sh", args: ["-c", "id"] }] } },
      { secrets: ["SECRET_ACME_RADAR_OTHER"] },
      { trusted: false },
      { routing: { summary: "something else" } },
    ]) {
      const bad = JSON.parse(await projectUpdateTool.execute({ slug: "acme-radar", config }));
      expect(bad.error, Object.keys(config)[0]).toContain(`config.${Object.keys(config)[0]}`);
    }
    expect(String(getFile(REL)!.content)).toBe(before);
  });

  it("legacy row: echo passes, change refused, adding to a row that lacks it refused", async () => {
    createProject("legacy-delta", "Legacy Delta", { config: { kb_readme: "projects/legacy-delta/README.md", phase: "one" } });
    const echo = JSON.parse(
      await projectUpdateTool.execute({ slug: "legacy-delta", config: { kb_readme: "projects/legacy-delta/README.md", phase: "two" } }),
    );
    expect(echo.error).toBeUndefined();
    expect(rowView("legacy-delta").config).toEqual({ kb_readme: "projects/legacy-delta/README.md", phase: "two" });
    const changed = JSON.parse(
      await projectUpdateTool.execute({ slug: "legacy-delta", config: { kb_readme: "projects/other/README.md" } }),
    );
    expect(changed.error).toContain("config.kb_readme");
    createProject("legacy-eps", "Legacy Eps", { config: { phase: "one" } });
    const added = JSON.parse(
      await projectUpdateTool.execute({ slug: "legacy-eps", config: { kb_readme: "projects/legacy-eps/README.md" } }),
    );
    expect(added.error).toContain("config.kb_readme");
    expect(rowView("legacy-eps").config).toEqual({ phase: "one" });
  });
});

describe("project_update — the operator-only config keys are refused", () => {
  const KEYS = ["capabilities", "deny_paths", "egress", "inbound", "kb_readme", "mcp", "routing", "secrets", "stall_exempt", "trusted"];
  it("lists exactly the WS1 keys (audit R1 C1) plus the S6 WS3 capability keys and stall_exempt (queue 3b)", () => {
    expect([...OPERATOR_ONLY_CONFIG_KEYS].sort()).toEqual(KEYS);
  });

  for (const key of KEYS) {
    it(`config.${key}: refused with a record, nothing written`, async () => {
      seedRecord();
      const rowBefore = rowView("acme-radar");
      const out = JSON.parse(
        await projectUpdateTool.execute({ slug: "acme-radar", config: { [key]: ["x"] } }),
      );
      expect(out.error).toContain(`config.${key}`);
      expect(String(getFile(REL)!.content)).toBe(RECORD);
      expect(rowView("acme-radar")).toEqual(rowBefore);
    });

    it(`config.${key}: refused without a record too, no row created or changed`, async () => {
      createProject("legacy-gamma", "Legacy Gamma", { config: { phase: "one" } });
      const out = JSON.parse(
        await projectUpdateTool.execute({ slug: "legacy-gamma", config: { [key]: true } }),
      );
      expect(out.error).toContain(`config.${key}`);
      expect(rowView("legacy-gamma").config).toEqual({ phase: "one" });
      const out2 = JSON.parse(
        await projectUpdateTool.execute({ slug: "brand-new", name: "N", config: { [key]: true } }),
      );
      expect(out2.error).toContain(`config.${key}`);
      expect(getProject("brand-new")).toBeNull();
    });
  }
});

describe("S6 WS3 audit R1 rec b — a status change invalidates the record-server status cache", () => {
  it("project_update status (legacy row and record row) → the next read re-reads", async () => {
    createProject("legacy-gamma", "Legacy Gamma", { status: "active" });
    expect(cachedProjectStatus("legacy-gamma", () => "active")).toBe("active");
    expect(cachedProjectStatus("legacy-gamma", () => "stale-read")).toBe("active"); // cached
    await projectUpdateTool.execute({ slug: "legacy-gamma", status: "paused" });
    expect(cachedProjectStatus("legacy-gamma", () => "re-read")).toBe("re-read");

    seedRecord();
    expect(cachedProjectStatus("acme-radar", () => "active")).toBe("active");
    const out = JSON.parse(await projectUpdateTool.execute({ slug: "acme-radar", status: "paused" }));
    expect(out.error).toBeUndefined();
    expect(getProject("acme-radar")!.status).toBe("paused");
    expect(cachedProjectStatus("acme-radar", () => "re-read")).toBe("re-read");
  });
});

describe("S6 WS3 audit R3 — deleteProject invalidates the record-server status cache", () => {
  it("a deleted project is re-read, never served from the cache", () => {
    createProject("legacy-delta", "Legacy Delta", { status: "active" });
    expect(cachedProjectStatus("legacy-delta", () => "active")).toBe("active");
    expect(cachedProjectStatus("legacy-delta", () => "stale-read")).toBe("active"); // cached
    expect(deleteProject("legacy-delta")).toBe(true);
    expect(cachedProjectStatus("legacy-delta", () => "missing")).toBe("missing");
  });
});
