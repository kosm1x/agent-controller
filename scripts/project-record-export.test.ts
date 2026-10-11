/**
 * S6 WS1 — operator exporter: projects row → projects/<slug>/project.md.
 * Real in-memory db + scratch KB mirror. Synthetic rows only.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "../src/db/index.js";
import { ensureScheduledTasksTable } from "../src/rituals/dynamic.js";
import { contractToRowPatch } from "../src/projects/projector.js";
import { createProject, getProject } from "../src/db/projects.js";
import type { Project } from "../src/db/projects.js";
import { getFile, upsertFile } from "../src/db/jarvis-fs.js";
import { parseProjectRecord, projectRecordRelPath } from "../src/projects/record.js";
import {
  WITHHELD,
  buildRecordFromRow,
  exportProjectRecord,
  parseArgs,
} from "./project-record-export.js";

let kbDir: string;

beforeEach(() => {
  kbDir = mkdtempSync(join(tmpdir(), "mc-recexport-test-"));
  process.env.JARVIS_KB_MIRROR_DIR = kbDir;
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
  rmSync(kbDir, { recursive: true, force: true });
  delete process.env.JARVIS_KB_MIRROR_DIR;
});

/** Every fenced json block after the contract, keyed by its `## ` heading. */
function legacyBlocks(md: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  const re = /^## (Legacy \w+)\n[\s\S]*?^```json\n([\s\S]*?)^```$/gm;
  for (const m of md.matchAll(re)) out[m[1]!] = JSON.parse(m[2]!) as Record<string, unknown>;
  return out;
}

/**
 * Round trip through the REAL projector mapping: export → parse →
 * contractToRowPatch (what the row receives), plus the legacy sections (the
 * keys the record does not own stay on the row and are copied as notes).
 */
function roundTrip(md: string, slug: string) {
  const { contract, description } = parseProjectRecord(md, { folderSlug: slug });
  const patch = contractToRowPatch(contract, description);
  const legacy = legacyBlocks(md);
  // projected owned keys → the row's legacy key names (the only renames)
  const config: Record<string, unknown> = { ...(legacy["Legacy config"] ?? {}) };
  const c = patch.config;
  if ("aliases" in c) config.aliases = c.aliases;
  if ("stall_exempt" in c) config.stall_exempt = c.stall_exempt;
  if ("parent" in c) config.parent = c.parent;
  if ("kb_folder" in c && contract.kb_folder !== `projects/${slug}/`) config.kb_path = c.kb_folder;
  if (Array.isArray(c.schedules)) config.schedule_id = c.schedules[0];
  const urls: Record<string, unknown> = { ...(legacy["Legacy urls"] ?? {}) };
  if (patch.urls?.site) urls.site = patch.urls.site;
  return { patch, config, urls, repos: (c.repos ?? []) as Array<{ path: string; role: string }> };
}

const LONG_391 = ("Synthetic weekly radar over invented tickers. ".repeat(9)).slice(0, 391).trim();
const LONG_1200 = ("Synthetic portal notes for a made-up team. ".repeat(30)).slice(0, 1200).trim();

const ROWS: Array<Parameters<typeof createProject>[2] & { slug: string; name: string }> = [
  {
    slug: "acme-radar",
    name: "Acme Radar",
    description: LONG_391,
    status: "active",
    urls: { site: "https://acme.example.test", repo: "https://git.example.test/acme" },
    config: {
      aliases: ["acme", "radar acme"],
      tickers: ["AAA", "BBB"],
      phase: 3,
      nested: { window: "weekly", sectors: { x: 1 } },
      timezone: "UTC",
    },
  },
  {
    slug: "beta-portal",
    name: "Beta Portal",
    description: LONG_1200 + "\n\n\nSecond paragraph folded.",
    status: "paused",
    urls: { local: "/srv/work/beta-portal" },
    config: {
      parent_project: "beta-group",
      kb_path: "projects/beta/",
      schedule_id: "sched-beta-1",
      stall_exempt: true,
      local_path: "/srv/work/beta-portal-2",
      backend_path: "/srv/work/beta-portal/api",
      service: "beta.service",
    },
  },
  {
    slug: "gamma-lab",
    name: "Gamma Lab",
    description: "",
    status: "completed",
    urls: {},
    config: {
      parent: "Not A Slug",
      kb_path: "/abs/not/kb",
      aliases: [],
      repo: "https://git.example.test/gamma",
      list: [1, "two", { three: 3 }],
      flag: false,
    },
  },
];

function seed(r: (typeof ROWS)[number]): Project {
  const { slug, name, ...opts } = r;
  createProject(slug, name, opts);
  return getProject(slug)!;
}

describe("buildRecordFromRow — round-trip property", () => {
  it.each(ROWS.map((r) => [r.slug, r] as const))(
    "%s: contractToRowPatch(parse(export(row))) reproduces the row, description whole (R1 C2)",
    (_slug, r) => {
      const row = seed(r);
      const { markdown, counts } = buildRecordFromRow(row);
      const back = roundTrip(markdown, row.slug);
      expect(back.patch.name).toBe(row.name);
      expect(back.patch.status).toBe(row.status);
      expect(back.patch.description).toBe(row.description.replace(/\n\s*\n+/g, "\n"));
      expect(back.patch.description.length).toBe(row.description.replace(/\n\s*\n+/g, "\n").length);
      // repos go to the contract; everything else comes back key for key
      const repoPaths = new Set(back.repos.map((x) => x.path));
      const strip = (o: Record<string, unknown>) =>
        Object.fromEntries(Object.entries(o).filter(([, v]) => !(typeof v === "string" && repoPaths.has(v))));
      // the one lossy rename: both parent spellings map to the contract's `parent`
      const norm = (o: Record<string, unknown>) =>
        Object.fromEntries(
          Object.entries(o).map(([k, v]) =>
            k === "parent_project" && typeof v === "string" && /^[a-z0-9][a-z0-9-]{1,62}$/.test(v) ? ["parent", v] : [k, v],
          ),
        );
      expect(back.config).toEqual(norm(strip(row.config)));
      expect(back.urls).toEqual(strip(row.urls));
      expect(counts.withheld_values).toBe(0);
    },
  );

  it("the descriptions under test are longer than every consumer cap", () => {
    expect(LONG_391.length).toBeGreaterThan(300);
    expect(LONG_1200.length).toBeGreaterThan(1000);
  });

  it("maps the spec §2 classes: parent_project→parent, kb_path→kb_folder, schedule_id→schedules, local paths→repos (one primary)", () => {
    const row = seed(ROWS[1]!);
    const { markdown, counts } = buildRecordFromRow(row, { kbReadme: "projects/beta/README.md", schedules: ["sched-beta-2"] });
    const { contract } = parseProjectRecord(markdown, { folderSlug: "beta-portal" });
    expect(contract.parent).toBe("beta-group");
    expect(contract.kb_folder).toBe("projects/beta/");
    expect(contract.kb_readme).toBe("projects/beta/README.md");
    expect(contract.schedules).toEqual(["sched-beta-1", "sched-beta-2"]);
    expect(contract.stall_exempt).toBe(true);
    expect(contract.repos).toEqual([
      { path: "/srv/work/beta-portal", role: "primary" },
      { path: "/srv/work/beta-portal-2", role: "other" },
      { path: "/srv/work/beta-portal/api", role: "other" },
    ]);
    expect(counts).toMatchObject({ repos: 3, schedules: 2, parent: true, kb_folder: true, kb_readme: true });
  });

  it("invalid values stay in Legacy config instead of breaking the contract", () => {
    const row = seed(ROWS[2]!);
    const { markdown } = buildRecordFromRow(row);
    const { json } = parseProjectRecord(markdown, { folderSlug: "gamma-lab" });
    expect(json.parent).toBeUndefined();
    expect(json.kb_folder).toBeUndefined();
    expect(json.aliases).toBeUndefined();
    const legacy = legacyBlocks(markdown)["Legacy config"]!;
    expect(legacy.parent).toBe("Not A Slug");
    expect(legacy.kb_path).toBe("/abs/not/kb");
    expect(legacy.aliases).toEqual([]);
  });

  it("never carries credentials, commit_goal_id or a credential-style config/urls value into the record", () => {
    const pw = "pw-" + "q".repeat(16);
    const key = "sk-" + "b".repeat(40);
    createProject("delta-ops", "Delta Ops", {
      credentials: { app_password: pw },
      commit_goal_id: "goal-delta",
      config: { api_key: key, auth: { token: "t-" + "c".repeat(20), user: "synthetic" }, plain: "ok" },
      urls: { site: "https://delta.example.test" },
    });
    const { markdown, counts } = buildRecordFromRow(getProject("delta-ops")!);
    expect(markdown).not.toContain(pw);
    expect(markdown).not.toContain(key);
    expect(markdown).not.toContain("c".repeat(20));
    expect(markdown).not.toContain("goal-delta");
    expect(markdown).not.toContain("credentials");
    const legacy = legacyBlocks(markdown)["Legacy config"]!;
    expect(legacy.api_key).toBe(WITHHELD);
    expect(legacy.plain).toBe("ok");
    expect(counts.withheld_values).toBeGreaterThanOrEqual(2);
  });
});

describe("buildRecordFromRow — credential-shaped name/description (R1 W2)", () => {
  it("refuses the export instead of writing the value into the KB", () => {
    const key = "sk-" + "e".repeat(40);
    createProject("eps-desc", "Eps", { description: `Entra con ${key} cada lunes.` });
    expect(() => buildRecordFromRow(getProject("eps-desc")!)).toThrow(/description holds a credential-style value/);
    const r = exportProjectRecord("eps-desc");
    expect(r).toEqual({
      ok: false,
      error: "the row's description holds a credential-style value — clean it before exporting",
    });
    expect(getFile(projectRecordRelPath("eps-desc"))).toBeNull();
  });
});

describe("buildRecordFromRow — prose is not a credential (R2 W3)", () => {
  it("'clave:' / 'token:' / 'Contraseña:' prose exports; a JWT does not", () => {
    for (const [i, d] of [
      "Punto clave: expansión regional del radar.",
      "Mide el token: consumo semanal por corrida.",
      "Contraseña: pendiente de definir con el equipo.",
    ].entries()) {
      createProject(`eps-prose-${i}`, "Eps", { description: d });
      expect(buildRecordFromRow(getProject(`eps-prose-${i}`)!).markdown).toContain(d);
    }
    const jwt = ["eyJ" + "a".repeat(12), "b".repeat(12), "c".repeat(12)].join(".");
    createProject("eps-jwt", "Eps", { description: `Sesión ${jwt} activa.` });
    expect(() => buildRecordFromRow(getProject("eps-jwt")!)).toThrow(/credential-style/);
    // R2b W1: an assignment / a single-token keyword value is not prose
    for (const [i, d] of ["password=" + "hunter2".repeat(2), "token: " + "abcd1234efgh5678ijkl"].entries()) {
      createProject(`eps-kw-${i}`, "Eps", { description: d });
      expect(() => buildRecordFromRow(getProject(`eps-kw-${i}`)!), d).toThrow(/credential-style/);
    }
  });
});

describe("exportProjectRecord — write path", () => {
  it("writes through the registry upsert path (registry row + mirror + projection) and returns counts only", () => {
    seed(ROWS[0]!);
    const r = exportProjectRecord("acme-radar", { kbReadme: "projects/acme/README.md", schedules: ["sched-0001"] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rel).toBe("projects/acme-radar/project.md");
    expect(r.written).toBe(true);
    const reg = getFile(r.rel);
    expect(reg).not.toBeNull();
    expect(readFileSync(join(kbDir, r.rel), "utf-8")).toBe(String(reg!.content));
    // projection ran: the record's owned keys are on the row, foreign keys kept
    const p = getProject("acme-radar")!;
    expect(p.config.schedules).toEqual(["sched-0001"]);
    expect(p.config.kb_readme).toBe("projects/acme/README.md");
    expect(p.config.tickers).toEqual(["AAA", "BBB"]);
    expect(r.projection).toBe("updated");
    expect(JSON.stringify(r)).not.toContain("AAA"); // counts only, never values
  });

  it("--dry-run writes nothing (no registry row, no file, row untouched)", () => {
    const before = seed(ROWS[0]!);
    const r = exportProjectRecord("acme-radar", { dryRun: true });
    expect(r).toMatchObject({ ok: true, written: false });
    expect(getFile(projectRecordRelPath("acme-radar"))).toBeNull();
    expect(existsSync(join(kbDir, "projects/acme-radar/project.md"))).toBe(false);
    expect(getProject("acme-radar")!.config).toEqual(before.config);
  });

  it("refuses to overwrite an existing record without --force; --force overwrites", () => {
    seed(ROWS[0]!);
    const rel = projectRecordRelPath("acme-radar");
    upsertFile(rel, "existing", "hand-written record");
    const r = exportProjectRecord("acme-radar");
    expect(r).toEqual({ ok: false, error: `${rel} already exists — pass --force to overwrite` });
    expect(String(getFile(rel)!.content)).toBe("hand-written record");
    const forced = exportProjectRecord("acme-radar", { force: true });
    expect(forced.ok).toBe(true);
    expect(String(getFile(rel)!.content)).not.toBe("hand-written record");
  });

  it("--schedule with an id not in scheduled_tasks warns (dry run too); a known id does not", () => {
    seed(ROWS[0]!);
    const dry = exportProjectRecord("acme-radar", { schedules: ["sched-nope"], dryRun: true });
    expect(dry).toMatchObject({
      ok: true,
      warnings: ["--schedule sched-nope is not in scheduled_tasks (check ./mc-ctl schedules)"],
    });
    ensureScheduledTasksTable();
    getDatabase()
      .prepare("INSERT INTO scheduled_tasks (schedule_id, name, description, cron_expr) VALUES ('sched-ok','n','d','0 9 * * 1')")
      .run();
    expect(exportProjectRecord("acme-radar", { schedules: ["sched-ok"], dryRun: true })).toMatchObject({ ok: true, warnings: [] });
    const written = exportProjectRecord("acme-radar", { schedules: ["sched-ok", "sched-nope"] });
    expect(written).toMatchObject({ ok: true, written: true, warnings: [expect.stringContaining("sched-nope")] });
  });

  it("unknown slug, bad slug and bad --kb-readme are errors", () => {
    expect(exportProjectRecord("no-such-one")).toEqual({ ok: false, error: 'no projects row for "no-such-one"' });
    expect(exportProjectRecord("Bad Slug").ok).toBe(false);
    seed(ROWS[0]!);
    expect(exportProjectRecord("acme-radar", { kbReadme: "/abs/README.md" }).ok).toBe(false);
  });

  it("the script source never writes the KB with a bare fs write", () => {
    const src = readFileSync(new URL("./project-record-export.ts", import.meta.url), "utf-8");
    for (const re of [
      /\bwriteFile(Sync)?\b/,
      /\bappendFile(Sync)?\b/,
      /\bcreateWriteStream\b/,
      /\bcopyFile(Sync)?\b/,
      /\brename(Sync)?\(/,
      /\bfs\.promises\b/,
      /node:fs\/promises|"fs\/promises"/,
      /\bwriteFile\(/,
    ]) {
      expect(src, String(re)).not.toMatch(re);
    }
    expect(src).toMatch(/upsertFromDiskWrite\(rel, built\.markdown\)/);
  });
});

describe("parseArgs", () => {
  it("parses slug and flags; rejects unknowns", () => {
    expect(parseArgs(["acme-radar", "--kb-readme", "projects/x/README.md", "--schedule", "s1", "--schedule", "s2", "--dry-run"])).toEqual({
      slug: "acme-radar",
      kbReadme: "projects/x/README.md",
      schedules: ["s1", "s2"],
      dryRun: true,
      force: false,
    });
    expect(parseArgs([])).toHaveProperty("error");
    expect(parseArgs(["a1", "--bogus"])).toHaveProperty("error");
    expect(parseArgs(["a1", "--schedule"])).toHaveProperty("error");
    expect(parseArgs(["a1", "b2"])).toHaveProperty("error");
  });
});
