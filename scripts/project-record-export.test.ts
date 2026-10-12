/**
 * S6 WS1 — operator exporter: projects row → projects/<slug>/project.md.
 * Real in-memory db + scratch KB mirror. Synthetic rows only.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabase, getDatabase, initDatabase } from "../src/db/index.js";
import { ensureScheduledTasksTable } from "../src/rituals/dynamic.js";
import { applyProjectRecord, contractToRowPatch } from "../src/projects/projector.js";
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

describe("buildRecordFromRow — idempotent over its own projection (S6, 2nd --force export)", () => {
  const OWNED_AND_LEGACY = {
    slug: "zeta-desk",
    name: "Zeta Desk",
    description: "Synthetic desk for an invented team.",
    status: "active",
    urls: { site: "https://zeta.example.test", local: "/srv/work/zeta" },
    config: {
      aliases: ["zeta"],
      parent: "zeta-hub",
      parent_project: "zeta-group",
      kb_folder: "projects/zeta-new/",
      kb_path: "projects/zeta-docs/",
      local_path: "/srv/work/zeta-old",
      schedule_id: "sched-z1",
      match_priority: 3,
      success: { gates: true },
      kb_readme: "projects/zeta-docs/OVERVIEW.md",
      links: { site: "https://zeta.example.test" },
      repos: [{ path: "/srv/work/zeta", role: "primary" }],
      schedules: ["sched-z2"],
      tickers: ["ZZ"],
      nested: { a: 1 },
    },
  };

  /** export → parse → contractToRowPatch → merge onto the row (the real projector) → export. */
  const reexport = (slug: string, md: string) => {
    expect(applyProjectRecord(projectRecordRelPath(slug), md).error).toBeUndefined();
    return buildRecordFromRow(getProject(slug)!).markdown;
  };

  it.each([
    ["legacy spellings + owned keys", OWNED_AND_LEGACY, ["sched-z3"]],
    ["legacy spellings only", ROWS[1]!, []],
    ["foreign keys only", ROWS[0]!, []],
    // audit R1 W1: values the schema normalises are written normalised
    ["padded alias", { slug: "pad-alias", name: "Pad", status: "active", config: { aliases: [" zz "] } }, []],
    ["padded name", { slug: "pad-name", name: " Zed ", status: "active", config: {} }, []],
    ["padded site", { slug: "pad-site", name: "Pad", status: "active", urls: { site: " https://z.example.test " }, config: {} }, []],
  ] as const)("%s: the second export is byte-identical (contract AND notes)", (_n, r, schedules) => {
    const row = seed(r as (typeof ROWS)[number]);
    const md1 = buildRecordFromRow(row, { schedules: [...schedules] }).markdown;
    const md2 = reexport(row.slug, md1);
    expect(md2).toBe(md1);
    expect(reexport(row.slug, md2)).toBe(md1);
  });

  it("S6 WS3: a row carrying the 7 capability keys (capabilities.mcp included) exports idempotently; credentials never leave the row", () => {
    const CRED = "cv-" + "j".repeat(18);
    createProject("acme-radar", "Acme Radar", {
      description: "Synthetic radar for an invented team.",
      status: "active",
      credentials: { api_token: CRED },
      config: {
        aliases: ["acme"],
        repos: [{ path: "/srv/work/acme-radar", role: "primary" }],
        trusted: true,
        egress: ["api.acme.example.test:443"],
        deny_paths: ["/srv/work/acme-radar/private"],
        secrets: ["SECRET_ACME_RADAR_API_TOKEN"],
        capabilities: {
          mcp: [
            {
              command: "node",
              args: ["dist/mcp.js"],
              env: ["ACME_RADAR_API_TOKEN"],
              trust: "AB",
              tools: { acme_trigger_run: { trust: "B", destructive: true } },
              deferred: ["acme_history"],
            },
          ],
        },
        routing: { summary: "Acme radar: widget sightings and weekly runs" },
        inbound: { route: "/api/acme-pull", token_secret: "ACME_INBOUND_TOKEN" },
      },
    });
    const md1 = buildRecordFromRow(getProject("acme-radar")!).markdown;
    expect(md1).not.toContain(CRED);
    expect(md1).not.toContain("credentials");
    const json = parseProjectRecord(md1, { folderSlug: "acme-radar" }).json as Record<string, unknown>;
    expect(json.capabilities).toEqual(getProject("acme-radar")!.config.capabilities);
    expect(json.trusted).toBe(true);
    expect(json.secrets).toEqual(["SECRET_ACME_RADAR_API_TOKEN"]);
    expect(json.inbound).toEqual({ route: "/api/acme-pull", token_secret: "ACME_INBOUND_TOKEN" });
    expect(Object.keys(json)).toEqual([
      "slug", "name", "status", "aliases", "repos", "trusted", "egress", "deny_paths", "secrets", "capabilities", "routing", "inbound",
    ]);
    const md2 = reexport("acme-radar", md1);
    expect(md2).toBe(md1);
    expect(reexport("acme-radar", md2)).toBe(md1);
    // the projection never wrote the credential column either way
    expect(getProject("acme-radar")!.credentials).toEqual({ api_token: CRED });
    expect(JSON.stringify(getProject("acme-radar")!.config)).not.toContain(CRED);
  });

  it("the record's (owned) value beats a differing legacy spelling; the legacy one stays in the notes on every run", () => {
    const row = seed(OWNED_AND_LEGACY as (typeof ROWS)[number]);
    const { markdown: md1, differs } = buildRecordFromRow(row, { schedules: ["sched-z3"] });
    const { contract } = parseProjectRecord(md1, { folderSlug: "zeta-desk" });
    expect(contract).toMatchObject({
      match_priority: 3,
      success: { daylog: true, gates: true },
      kb_folder: "projects/zeta-new/",
      kb_readme: "projects/zeta-docs/OVERVIEW.md",
      parent: "zeta-hub",
      schedules: ["sched-z2", "sched-z3"],
      repos: [{ path: "/srv/work/zeta", role: "primary" }],
      links: { site: "https://zeta.example.test" },
    });
    expect(differs.sort()).toEqual(
      ["kb_path", "local_path", "parent_project", "schedule_id"].map((k) => `legacy ${k}: differs from record, kept in notes`),
    );
    const kept = {
      parent_project: "zeta-group",
      kb_path: "projects/zeta-docs/",
      local_path: "/srv/work/zeta-old",
      schedule_id: "sched-z1",
      tickers: ["ZZ"],
      nested: { a: 1 },
    };
    expect(legacyBlocks(md1)["Legacy config"]).toEqual(kept);
    expect(legacyBlocks(md1)["Legacy urls"]).toBeUndefined(); // equal site + local consumed
    const md2 = reexport("zeta-desk", md1);
    expect(md2).toBe(md1);
    expect(legacyBlocks(md2)["Legacy config"]).toEqual(kept);
  });

  it.each([
    ["match_priority", { match_priority: "high" }],
    ["kb_readme", { kb_readme: "../../etc/x.md" }],
    ["parent", { parent: "Bad Slug", parent_project: "good-one" }],
  ] as const)("audit R1 W1: an invalid owned %s is never lost silently: kept in notes + warned", (key, config) => {
    const slug = `bad-${key.replace(/_/g, "-")}`;
    createProject(slug, "Bad", { config: { ...config } });
    const built = buildRecordFromRow(getProject(slug)!);
    expect(built.differs).toContain(`owned ${key}: invalid, kept in notes, apply will overwrite the row`);
    expect(legacyBlocks(built.markdown)["Legacy config"]![key]).toEqual((config as Record<string, unknown>)[key]);
    const r = exportProjectRecord(slug, { dryRun: true });
    expect(r.ok && r.warnings).toContain(`owned ${key}: invalid, kept in notes, apply will overwrite the row`);
  });

  it("an equal legacy spelling is consumed; a differing one is reported by the write path", () => {
    seed(OWNED_AND_LEGACY as (typeof ROWS)[number]);
    const r = exportProjectRecord("zeta-desk", { dryRun: true });
    expect(r.ok && r.warnings).toEqual(
      expect.arrayContaining(["legacy kb_path: differs from record, kept in notes"]),
    );
    const equal = { ...OWNED_AND_LEGACY, slug: "zeta-eq", config: { kb_folder: "projects/zeta-docs/", kb_path: "projects/zeta-docs/", parent: "zeta-hub", parent_project: "zeta-hub" } };
    const built = buildRecordFromRow(seed(equal as (typeof ROWS)[number]));
    expect(built.differs).toEqual([]);
    expect(legacyBlocks(built.markdown)["Legacy config"]).toBeUndefined();
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

  it("audit R2 W2: --kb-readme outside KB_README_RE is refused naming the rule, never the value; the live shape passes", () => {
    seed(ROWS[0]!);
    for (const bad of ["projects/x/README.MD", "knowledge/x.md", "projects/x/sub/README.md", "projects/x/a\nb.md"]) {
      expect(exportProjectRecord("acme-radar", { kbReadme: bad, dryRun: true }), JSON.stringify(bad)).toEqual({
        ok: false,
        error: "--kb-readme must be projects/<folder>/<file>.md",
      });
    }
    expect(exportProjectRecord("acme-radar", { kbReadme: "projects/williams-entry-radar/README.md", dryRun: true }).ok).toBe(true);
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

describe("S6 ruling 5a — shared renderer extraction", () => {
  // Rendered by the exporter at HEAD 98968f8, BEFORE normaliseRecordJson moved
  // into record.ts; the extraction must not change one byte.
  const HEAD_98968F8 = "```json\n{\n  \"slug\": \"zeta-desk\",\n  \"name\": \"Zeta Desk\",\n  \"status\": \"active\",\n  \"aliases\": [\n    \"zeta\",\n    \"zed\"\n  ],\n  \"match_priority\": 2,\n  \"stall_exempt\": true,\n  \"parent\": \"zeta-group\",\n  \"kb_folder\": \"projects/zeta-docs/\",\n  \"kb_readme\": \"projects/zeta-docs/OVERVIEW.md\",\n  \"schedules\": [\n    \"sched-z1\",\n    \"sched-z2\"\n  ],\n  \"repos\": [\n    {\n      \"path\": \"/srv/work/zeta\",\n      \"role\": \"primary\"\n    },\n    {\n      \"path\": \"/srv/work/zeta-two\",\n      \"role\": \"other\"\n    }\n  ],\n  \"links\": {\n    \"site\": \"https://zeta.example.test\"\n  }\n}\n```\n\nSynthetic desk for an invented team.\nSecond line.\n\n## Legacy config\n\nCopied from `projects.config` by the exporter; not part of the contract.\n\n```json\n{\n  \"tickers\": [\n    \"ZZ\"\n  ],\n  \"nested\": {\n    \"a\": 1\n  },\n  \"api_key\": \"[withheld: credential-style value — stays in the projects row]\"\n}\n```\n\n## Legacy urls\n\nCopied from `projects.urls` by the exporter; not part of the contract.\n\n```json\n{\n  \"repo\": \"https://git.example.test/zeta\"\n}\n```\n";

  it("the exporter output is byte-identical to its pre-extraction rendering", () => {
    createProject("zeta-desk", "Zeta Desk", {
      description: "Synthetic desk for an invented team.\n\n\nSecond line.",
      status: "active",
      urls: { site: "https://zeta.example.test", local: "/srv/work/zeta", repo: "https://git.example.test/zeta" },
      config: {
        aliases: ["zeta", " zed "], parent_project: "zeta-group", kb_path: "projects/zeta-docs/",
        local_path: "/srv/work/zeta-two", schedule_id: "sched-z1", stall_exempt: true, match_priority: 2,
        tickers: ["ZZ"], nested: { a: 1 }, api_key: "sk-" + "b".repeat(40),
      },
    });
    const md = buildRecordFromRow(getProject("zeta-desk")!, {
      kbReadme: "projects/zeta-docs/OVERVIEW.md",
      schedules: ["sched-z2"],
    }).markdown;
    expect(md).toBe(HEAD_98968F8);
  });
});

describe("S6 ruling 5a — --parent override", () => {
  /** The live shape: parent_project names an umbrella folder, not a project; parent_repo is a URL. */
  const CHILD = {
    slug: "kid-lite",
    name: "Kid Lite",
    description: "Synthetic child project.",
    status: "active",
    config: { parent_project: "umbrella-folder", parent_repo: "https://git.example.test/umbrella" },
  };
  const reexport = (slug: string, md: string, opts = {}) => {
    expect(applyProjectRecord(projectRecordRelPath(slug), md).error).toBeUndefined();
    return buildRecordFromRow(getProject(slug)!, opts);
  };

  it("the flag wins over parent_project; the legacy value stays in Legacy config and is reported", () => {
    seed(CHILD as (typeof ROWS)[number]);
    const without = buildRecordFromRow(getProject("kid-lite")!);
    expect(parseProjectRecord(without.markdown, { folderSlug: "kid-lite" }).contract.parent).toBe("umbrella-folder");
    const built = buildRecordFromRow(getProject("kid-lite")!, { parent: "real-parent" });
    expect(parseProjectRecord(built.markdown, { folderSlug: "kid-lite" }).contract.parent).toBe("real-parent");
    expect(legacyBlocks(built.markdown)["Legacy config"]).toEqual(CHILD.config);
    expect(built.differs).toEqual(["parent: overridden (legacy value kept in notes)"]);
    expect(built.counts.parent).toBe(true);
    const r = exportProjectRecord("kid-lite", { parent: "real-parent", dryRun: true });
    expect(r.ok && r.warnings).toContain("parent: overridden (legacy value kept in notes)");
  });

  it("idempotent: a second --force run WITHOUT --parent keeps the record's parent and the legacy notes byte for byte", () => {
    seed(CHILD as (typeof ROWS)[number]);
    const first = exportProjectRecord("kid-lite", { parent: "real-parent" });
    expect(first).toMatchObject({ ok: true, written: true });
    const md1 = String(getFile(projectRecordRelPath("kid-lite"))!.content);
    expect(getProject("kid-lite")!.config.parent).toBe("real-parent");
    const second = exportProjectRecord("kid-lite", { force: true });
    expect(second.ok).toBe(true);
    const md2 = String(getFile(projectRecordRelPath("kid-lite"))!.content);
    expect(md2).toBe(md1);
    expect(parseProjectRecord(md2, { folderSlug: "kid-lite" }).contract.parent).toBe("real-parent");
    expect(legacyBlocks(md2)["Legacy config"]).toEqual(CHILD.config);
    expect(reexport("kid-lite", md2).markdown).toBe(md1);
  });

  it("an equal legacy spelling is consumed silently; the row's previous parent is replaced and reported; a non-slug flag is refused", () => {
    createProject("kid-eq", "Kid", { config: { parent_project: "real-parent" } });
    const eq = buildRecordFromRow(getProject("kid-eq")!, { parent: "real-parent" });
    expect(eq.differs).toEqual([]);
    expect(legacyBlocks(eq.markdown)["Legacy config"]).toBeUndefined();
    createProject("kid-old", "Kid", { config: { parent: "old-parent" } });
    const old = buildRecordFromRow(getProject("kid-old")!, { parent: "real-parent" });
    expect(old.differs).toEqual(["parent: overridden (the row's previous parent old-parent is replaced by real-parent on apply)"]);
    expect(parseProjectRecord(old.markdown, { folderSlug: "kid-old" }).contract.parent).toBe("real-parent");
    expect(exportProjectRecord("kid-eq", { parent: "Bad Slug", dryRun: true })).toEqual({
      ok: false,
      error: "--parent must be a project slug",
    });
  });
});

describe("S6 ruling 5a audit R1 W3 — parent chain", () => {
  it("refuses a parent equal to the slug (flag or legacy) and a parent that closes a cycle; writes nothing", () => {
    createProject("kid-a", "A", { config: { parent_project: "kid-a" } });
    expect(exportProjectRecord("kid-a")).toEqual({ ok: false, error: "parent refused: parent must not be the project itself" });
    expect(exportProjectRecord("kid-a", { parent: "kid-a" })).toEqual({ ok: false, error: "parent refused: parent must not be the project itself" });
    createProject("kid-b", "B", { config: { parent: "kid-a" } });
    expect(exportProjectRecord("kid-a", { parent: "kid-b", dryRun: true })).toEqual({
      ok: false,
      error: "parent refused: parent kid-b makes a cycle back to kid-a",
    });
    expect(getFile(projectRecordRelPath("kid-a"))).toBeNull();
    expect(exportProjectRecord("kid-a", { parent: "elsewhere", dryRun: true }).ok).toBe(true);
  });
});

describe("CLI entry — operator terminal only (audit R1 C1)", () => {
  it("refuses with exit 2 under </dev/null (no TTY) before opening any db", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const db = join(kbDir, "never-created.db");
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", join(here, "project-record-export.ts"), "acme-radar", "--force", "--parent", "other-lab"],
      {
        cwd: join(here, ".."),
        stdio: ["ignore", "pipe", "pipe"], // stdin </dev/null
        encoding: "utf-8",
        env: { ...process.env, MC_DB_PATH: db, JARVIS_KB_MIRROR_DIR: kbDir },
        timeout: 60_000,
      },
    );
    expect(r.status).toBe(2);
    // from a login shell the TTY check refuses; from a service/CI cgroup the session check does
    expect(r.stderr).toMatch(/(not an operator login session|operator terminal required|running inside mission-control\.service \(a task\)); this script is not callable from a task/);
    expect(existsSync(db)).toBe(false);
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
    expect(parseArgs(["a1", "--parent", "p1"])).toMatchObject({ slug: "a1", parent: "p1" });
    expect(parseArgs(["a1", "--parent"])).toHaveProperty("error");
  });
});
