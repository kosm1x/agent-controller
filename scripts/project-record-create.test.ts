/**
 * S6 ruling 5a — operator record creation for a project with no row.
 * Real in-memory db + scratch KB mirror. Synthetic values only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const reindex = vi.hoisted(() => ({ fail: false }));
vi.mock("../src/db/jarvis-reindex.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/jarvis-reindex.js")>();
  return {
    ...actual,
    upsertFromDiskWrite: (rel: string, content: string) =>
      reindex.fail
        ? { slug: "acme-analyzer", action: "skipped", error: { reason: "apply_failed", message: "synthetic" } }
        : actual.upsertFromDiskWrite(rel, content),
  };
});

import { closeDatabase, getDatabase, initDatabase } from "../src/db/index.js";
import { createProject, getProject } from "../src/db/projects.js";
import { getFile, upsertFile } from "../src/db/jarvis-fs.js";
import { parseProjectRecord, projectRecordRelPath } from "../src/projects/record.js";
import {
  buildRecordFromFlags,
  createProjectRecord,
  parseArgs,
} from "./project-record-create.js";

let kbDir: string;
let repoDir: string;
let OPTS: {
  name: string;
  repos: Array<{ path: string; role?: "primary" | "other" }>;
  aliases: string[];
  description: string;
};

beforeEach(() => {
  kbDir = mkdtempSync(join(tmpdir(), "mc-reccreate-test-"));
  repoDir = mkdtempSync(join(tmpdir(), "mc-reccreate-repos-"));
  for (const d of ["analyzer", "web"]) mkdirSync(join(repoDir, d));
  writeFileSync(join(repoDir, "a-file"), "x");
  process.env.JARVIS_KB_MIRROR_DIR = kbDir;
  initDatabase(":memory:");
  OPTS = {
    name: "Acme Analyzer",
    repos: [{ path: join(repoDir, "analyzer") }, { path: join(repoDir, "web") + "/" }],
    aliases: ["acme", "analyzer"],
    description: "Synthetic analyzer over invented census tables.",
  };
});

afterEach(() => {
  closeDatabase();
  rmSync(kbDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
  delete process.env.JARVIS_KB_MIRROR_DIR;
  reindex.fail = false;
  vi.restoreAllMocks();
});

const registryRows = () =>
  (getDatabase().prepare("SELECT COUNT(*) AS n FROM jarvis_files WHERE path LIKE 'projects/%'").get() as { n: number }).n;

describe("createProjectRecord", () => {
  it("creates the record through the registry path and the row from the record; counts only", () => {
    const r = createProjectRecord("acme-analyzer", { ...OPTS, parent: "acme-hub" });
    expect(r).toEqual({
      ok: true,
      rel: "projects/acme-analyzer/project.md",
      written: true,
      counts: { aliases: 2, repos: 2, parent: true, kb_readme: false, description: true },
      projection: "created",
    });
    const reg = getFile(projectRecordRelPath("acme-analyzer"));
    expect(reg).not.toBeNull();
    expect(readFileSync(join(kbDir, "projects/acme-analyzer/project.md"), "utf-8")).toBe(String(reg!.content));
    const { contract, description } = parseProjectRecord(String(reg!.content), { folderSlug: "acme-analyzer" });
    expect(contract).toMatchObject({
      slug: "acme-analyzer",
      name: "Acme Analyzer",
      status: "active",
      aliases: ["acme", "analyzer"],
      parent: "acme-hub",
      repos: [
        { path: join(repoDir, "analyzer"), role: "primary" },
        { path: join(repoDir, "web"), role: "other" }, // trailing "/" stripped
      ],
    });
    expect(description).toBe(OPTS.description);
    const row = getProject("acme-analyzer")!;
    expect(row.name).toBe("Acme Analyzer");
    expect(row.status).toBe("active");
    expect(row.description).toBe(OPTS.description);
    expect(row.config).toMatchObject({ aliases: ["acme", "analyzer"], parent: "acme-hub" });
    expect(JSON.stringify(r)).not.toContain(repoDir); // counts, never values
  });

  it("the rendered record parses, written as the schema normalises it (shared renderer)", () => {
    const { markdown } = buildRecordFromFlags("acme-analyzer", {
      ...OPTS,
      name: " Padded ",
      status: "paused",
      repos: [{ path: "/srv/a" }, { path: "/srv/b", role: "primary" }],
      kbReadme: "projects/acme-analyzer/README.md",
    });
    const { contract, json } = parseProjectRecord(markdown, { folderSlug: "acme-analyzer" });
    expect(contract.name).toBe("Padded");
    expect(contract.status).toBe("paused");
    expect(contract.repos).toEqual([
      { path: "/srv/a", role: "other" },
      { path: "/srv/b", role: "primary" },
    ]);
    expect(json.kb_readme).toBeUndefined(); // the derived default stays implicit
    expect(Object.keys(json)).toEqual(["slug", "name", "status", "aliases", "repos"]);
  });

  it("refuses when a record already exists for the slug", () => {
    const rel = projectRecordRelPath("acme-analyzer");
    upsertFile(rel, "existing", "hand-written record");
    expect(createProjectRecord("acme-analyzer", OPTS)).toEqual({ ok: false, error: `${rel} already exists` });
    expect(String(getFile(rel)!.content)).toBe("hand-written record");
    expect(getProject("acme-analyzer")).toBeNull();
  });

  it("refuses when a row already exists for the slug (the exporter's job), writing nothing", () => {
    createProject("acme-analyzer", "Kept");
    expect(createProjectRecord("acme-analyzer", OPTS)).toEqual({
      ok: false,
      error: 'a projects row for "acme-analyzer" already exists — use project-record-export.ts',
    });
    expect(getFile(projectRecordRelPath("acme-analyzer"))).toBeNull();
    expect(getProject("acme-analyzer")!.name).toBe("Kept");
  });

  it("refuses a credential-shaped name or description, naming the field, never the value", () => {
    const key = "sk-" + "e".repeat(40);
    for (const field of ["name", "description"] as const) {
      const r = createProjectRecord("acme-analyzer", { ...OPTS, [field]: `Usa ${key}` });
      expect(r).toEqual({ ok: false, error: `--${field} holds a credential-style value` });
      expect(JSON.stringify(r)).not.toContain(key);
    }
    expect(registryRows()).toBe(0);
    expect(getProject("acme-analyzer")).toBeNull();
  });

  it("--dry-run writes nothing: registry, mirror and projects untouched", () => {
    const before = registryRows();
    const r = createProjectRecord("acme-analyzer", { ...OPTS, dryRun: true });
    expect(r).toMatchObject({ ok: true, written: false, counts: { repos: 2 } });
    expect(registryRows()).toBe(before);
    expect(readdirSync(kbDir)).not.toContain("projects");
    expect(existsSync(join(kbDir, "projects/acme-analyzer/project.md"))).toBe(false);
    expect(getProject("acme-analyzer")).toBeNull();
  });

  it("invalid inputs are errors: slug, parent, kb-readme, two primaries, relative repo", () => {
    expect(createProjectRecord("Bad Slug", OPTS).ok).toBe(false);
    expect(createProjectRecord("acme-analyzer", { ...OPTS, parent: "Bad" })).toEqual({
      ok: false,
      error: "--parent must be a project slug",
    });
    expect(createProjectRecord("acme-analyzer", { ...OPTS, kbReadme: "knowledge/x.md" })).toEqual({
      ok: false,
      error: "--kb-readme must be projects/<folder>/<file>.md",
    });
    const two = createProjectRecord("acme-analyzer", {
      ...OPTS,
      repos: [{ path: join(repoDir, "analyzer"), role: "primary" }, { path: join(repoDir, "web"), role: "primary" }],
    });
    expect(two).toEqual({ ok: false, error: "the record would not parse (contract fails the schema at: repos)" });
    expect(createProjectRecord("acme-analyzer", { ...OPTS, repos: [{ path: "rel/x" }] }).ok).toBe(false);
    expect(registryRows()).toBe(0);
  });

  it("audit R1 W1: --repo must be an existing directory with no .. segment (dry run too); errors never print the path", () => {
    const cases: Array<[string, string]> = [
      [join(repoDir, "missing"), "--repo must be an existing directory"],
      [join(repoDir, "a-file"), "--repo must be an existing directory"],
      [`${repoDir}/analyzer/../web`, "--repo must not contain a .. segment"],
      ["/", "--repo must be an absolute path"],
    ];
    for (const [path, error] of cases) {
      const r = createProjectRecord("acme-analyzer", { ...OPTS, repos: [{ path }], dryRun: true });
      expect(r, path).toEqual({ ok: false, error });
    }
    expect(registryRows()).toBe(0);
  });

  it("audit R1 W1: the schema refuses a .. segment in a repo path", () => {
    expect(() =>
      buildRecordFromFlags("acme-analyzer", { ...OPTS, repos: [{ path: "/srv/a/../b" }] }),
    ).toThrow(/repos/);
  });

  it("audit R1 W2: aliases must be ≥ 3 chars, plain, not a credential, and not another project's slug or live alias", () => {
    createProject("other-lab", "Other", { config: { aliases: ["Lab Two"] } });
    createProject("old-lab", "Old", { status: "archived", config: { aliases: ["retired cue"] } });
    const bad: Array<[string, string]> = [
      [" ab ", "--alias must be at least 3 characters"],
      ["acme/../x", "--alias may hold only letters, digits, spaces and -"],
      ["-lead", "--alias may hold only letters, digits, spaces and -"],
      ["eyJ" + "a".repeat(12) + "." + "b".repeat(12) + "." + "c".repeat(12), "--alias may hold only letters, digits, spaces and -"],
      ["Other-Lab", '--alias "Other-Lab" collides with project other-lab'],
      [" lab two ", '--alias "lab two" collides with project other-lab'],
    ];
    for (const [alias, error] of bad) {
      expect(createProjectRecord("acme-analyzer", { ...OPTS, aliases: [alias], dryRun: true }), alias).toEqual({ ok: false, error });
    }
    const key = "sk-" + "f".repeat(40);
    expect(createProjectRecord("acme-analyzer", { ...OPTS, aliases: [key], dryRun: true })).toEqual({
      ok: false,
      error: "--alias holds a credential-style value",
    });
    // audit R2 W1: another row's name, slug with spaces, or one word of a live slug
    createProject("delta-signal-desk", "Delta Board", { status: "paused" });
    createProject("old-quarry-site", "Quarry Archive", { status: "archived" });
    for (const [alias, owner] of [
      ["delta board", "delta-signal-desk"],
      ["Quarry Archive", "old-quarry-site"], // a name blocks at any status
      ["delta signal desk", "delta-signal-desk"],
      ["old quarry site", "old-quarry-site"],
      ["signal", "delta-signal-desk"],
      ["Desk", "delta-signal-desk"],
    ] as const) {
      expect(createProjectRecord("acme-analyzer", { ...OPTS, aliases: [alias], dryRun: true }), alias).toEqual({
        ok: false,
        error: `--alias "${alias}" collides with project ${owner}`,
      });
    }
    // a word of an ARCHIVED row's slug does not block
    expect(createProjectRecord("acme-analyzer", { ...OPTS, aliases: ["quarry"], dryRun: true }).ok).toBe(true);
    // an archived row's alias does not block; mixed case passes the charset
    expect(createProjectRecord("acme-analyzer", { ...OPTS, aliases: ["retired cue", "Acme Lab"], dryRun: true }).ok).toBe(true);
  });

  it("audit R1 W3: --parent equal to the slug, or closing a cycle through the rows, is refused", () => {
    expect(createProjectRecord("acme-analyzer", { ...OPTS, parent: "acme-analyzer", dryRun: true })).toEqual({
      ok: false,
      error: "--parent refused: parent must not be the project itself",
    });
    // kid-b → kid-a → acme-analyzer (a dangling parent written before the parent exists)
    createProject("kid-a", "A", { config: { parent: "acme-analyzer" } });
    createProject("kid-b", "B", { config: { parent: "kid-a" } });
    expect(createProjectRecord("acme-analyzer", { ...OPTS, parent: "kid-b", dryRun: true })).toEqual({
      ok: false,
      error: "--parent refused: parent kid-b makes a cycle back to acme-analyzer",
    });
    expect(createProjectRecord("acme-analyzer", { ...OPTS, parent: "unrelated", dryRun: true }).ok).toBe(true);
  });

  it("audit R1 W5: written but not projected → an error that says the record exists and how it is re-projected", () => {
    reindex.fail = true;
    const r = createProjectRecord("acme-analyzer", OPTS);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/was written but the row was not created \(projection: error apply_failed\)/);
    expect(!r.ok && r.error).toMatch(/projectAllRecords.*--force.*Do not re-run project-create/);
  });

  it("audit R1 Rec: a record on disk but not in the registry is refused (reindex first)", () => {
    mkdirSync(join(kbDir, "projects/acme-analyzer"), { recursive: true });
    writeFileSync(join(kbDir, "projects/acme-analyzer/project.md"), "hand-written, unregistered");
    expect(createProjectRecord("acme-analyzer", { ...OPTS, dryRun: true })).toEqual({
      ok: false,
      error: "projects/acme-analyzer/project.md exists on disk but not in the registry — run the reindex first",
    });
  });

  it("the script source never writes the KB with a bare fs write", () => {
    const src = readFileSync(new URL("./project-record-create.ts", import.meta.url), "utf-8");
    for (const re of [
      /\bwriteFile(Sync)?\b/,
      /\bappendFile(Sync)?\b/,
      /\bcreateWriteStream\b/,
      /\bcopyFile(Sync)?\b/,
      /\brename(Sync)?\(/,
      /\bmkdir(Sync)?\(/,
      /\bfs\.promises\b/,
      /node:fs\/promises|"fs\/promises"/,
    ]) {
      expect(src, String(re)).not.toMatch(re);
    }
    expect(src).toMatch(/upsertFromDiskWrite\(rel, built\.markdown\)/);
    expect(src).toMatch(/renderProjectRecord\(normaliseRecordJson\(json\)/);
  });
});

describe("CLI entry — operator terminal only (audit R1 C1)", () => {
  it("refuses with exit 2 under </dev/null (no TTY) before opening any db", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const db = join(kbDir, "never-created.db");
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", join(here, "project-record-create.ts"), "acme-analyzer", "--name", "Acme", "--repo", repoDir, "--dry-run"],
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
  it("parses slug and flags, repo roles, repeats; rejects unknowns and missing required flags", () => {
    expect(
      parseArgs([
        "acme-analyzer",
        "--name", "Acme",
        "--repo", "/srv/a",
        "--repo", "/srv/b:primary",
        "--alias", "a1",
        "--alias", "a2",
        "--parent", "acme-hub",
        "--status", "paused",
        "--description", "Synthetic.",
        "--kb-readme", "projects/acme/README.md",
        "--dry-run",
      ]),
    ).toEqual({
      slug: "acme-analyzer",
      name: "Acme",
      repos: [{ path: "/srv/a" }, { path: "/srv/b", role: "primary" }],
      aliases: ["a1", "a2"],
      parent: "acme-hub",
      status: "paused",
      description: "Synthetic.",
      kbReadme: "projects/acme/README.md",
      dryRun: true,
    });
    expect(parseArgs(["a1", "--repo", "/srv/a"])).toHaveProperty("error"); // no --name
    expect(parseArgs(["a1", "--name", "A"])).toHaveProperty("error"); // no --repo
    expect(parseArgs(["a1", "--name", "A", "--repo", "rel/a"])).toHaveProperty("error");
    expect(parseArgs(["a1", "--name", "A", "--repo", "/a", "--status", "archived"])).toHaveProperty("error");
    expect(parseArgs(["a1", "--name", "A", "--repo", "/a", "--bogus", "x"])).toHaveProperty("error");
    expect(parseArgs(["a1", "--name"])).toHaveProperty("error");
    expect(parseArgs(["a1", "b2", "--name", "A", "--repo", "/a"])).toHaveProperty("error");
  });
});
