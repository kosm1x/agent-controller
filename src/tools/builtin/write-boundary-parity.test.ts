/**
 * Write-boundary parity: file_write, file_edit, file_delete and shell_exec's
 * captured write targets must reach the SAME positional decision for every
 * path category — a rule added to the shared boundary lands in every tool.
 *
 * Safety of this file: every filesystem mutation the tools can reach (sync,
 * callback and promise APIs) is wrapped by a tripwire that performs NOTHING
 * and fails the test when the target is outside this test's own mkdtemp
 * directory under /tmp/. Forbidden targets use non-existent names wherever
 * the category allows it, every git call fails the test (the boundary reads no
 * branch, so no checkout is ever consulted) and the KB root points into the
 * test directory.
 * Nothing here depends on /root/claude/mission-control or the worktree
 * existing, so it runs on CI too.
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";

const trip = vi.hoisted(() => ({
  root: "",
  hits: [] as string[],
}));

const h = vi.hoisted(() => {
  /** Wrap a mutating fs function: pass through inside trip.root, refuse (and record) anywhere else. */
  function makeGuarded(
    name: string,
    real: (...a: unknown[]) => unknown,
    pathArgs: number[],
  ): (...a: unknown[]) => unknown {
    return (...args: unknown[]) => {
      for (const i of pathArgs) {
        const raw = args[i];
        if (raw === undefined) continue;
        const p = String(raw instanceof URL ? raw.pathname : raw);
        const inside =
          trip.root !== "" && (p === trip.root || p.startsWith(`${trip.root}/`)) && !p.includes("/../");
        if (!inside) {
          trip.hits.push(`${name} ${p}`);
          throw new Error(`TRIPWIRE: ${name} ${p}`);
        }
      }
      return real(...args);
    };
  }

  const SYNC_MUTATORS: Record<string, number[]> = {
    writeFileSync: [0],
    appendFileSync: [0],
    mkdirSync: [0],
    rmSync: [0],
    rmdirSync: [0],
    unlinkSync: [0],
    renameSync: [0, 1],
    copyFileSync: [1],
    cpSync: [1],
    symlinkSync: [1],
    linkSync: [1],
    truncateSync: [0],
    createWriteStream: [0],
    writeFile: [0],
    appendFile: [0],
    mkdir: [0],
    rm: [0],
    rmdir: [0],
    unlink: [0],
    rename: [0, 1],
    copyFile: [1],
    cp: [1],
    symlink: [1],
    truncate: [0],
  };
  const PROMISE_MUTATORS: Record<string, number[]> = {
    writeFile: [0],
    appendFile: [0],
    mkdir: [0],
    rm: [0],
    rmdir: [0],
    unlink: [0],
    rename: [0, 1],
    copyFile: [1],
    cp: [1],
    symlink: [1],
    link: [1],
    truncate: [0],
  };

  function guardModule(actual: Record<string, unknown>, table: Record<string, number[]>) {
    const out: Record<string, unknown> = {};
    for (const [name, idx] of Object.entries(table)) {
      const real = actual[name];
      if (typeof real === "function") out[name] = makeGuarded(name, real as (...a: unknown[]) => unknown, idx);
    }
    return out;
  }

  /** Every git call is refused and recorded: the write decision must not depend on git. */
  function fakeExecFileSync(real: (...a: unknown[]) => unknown) {
    return (...args: unknown[]) => {
      const [file, argv, opts] = args as [string, string[] | undefined, { cwd?: string } | undefined];
      if (file !== "git") return real(...args);
      trip.hits.push(`git ${(argv ?? []).join(" ")} (cwd ${String(opts?.cwd ?? "")})`);
      throw new Error("TRIPWIRE: unexpected git call");
    };
  }
  return { SYNC_MUTATORS, PROMISE_MUTATORS, guardModule, fakeExecFileSync };
});

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const guarded = h.guardModule(actual, h.SYNC_MUTATORS);
  const promises = h.guardModule(actual.promises as Record<string, unknown>, h.PROMISE_MUTATORS);
  const p = { ...(actual.promises as object), ...promises };
  return { ...actual, ...guarded, promises: p, default: { ...actual, ...guarded, promises: p } };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const guarded = h.guardModule(actual, h.SYNC_MUTATORS);
  const promises = h.guardModule(actual.promises as Record<string, unknown>, h.PROMISE_MUTATORS);
  const p = { ...(actual.promises as object), ...promises };
  return { ...actual, ...guarded, promises: p, default: { ...actual, ...guarded, promises: p } };
});
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const guarded = h.guardModule(actual, h.PROMISE_MUTATORS);
  return { ...actual, ...guarded, default: { ...actual, ...guarded } };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const guarded = h.guardModule(actual, h.PROMISE_MUTATORS);
  return { ...actual, ...guarded, default: { ...actual, ...guarded } };
});

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const execFileSync = h.fakeExecFileSync(actual.execFileSync as (...a: unknown[]) => unknown);
  return { ...actual, execFileSync, default: { ...actual, execFileSync } };
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const execFileSync = h.fakeExecFileSync(actual.execFileSync as (...a: unknown[]) => unknown);
  return { ...actual, execFileSync, default: { ...actual, execFileSync } };
});

// The registry/readback side effects of a KB write are out of scope here.
vi.mock("../../db/jarvis-reindex.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db/jarvis-reindex.js")>()),
  upsertFromDiskWrite: vi.fn(),
  registryNewerThanDisk: vi.fn(() => false),
}));
vi.mock("../../lib/v8-4/readback.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/v8-4/readback.js")>()),
  declareReadbackGate: vi.fn(),
}));
vi.mock("../../lib/secret-refs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/secret-refs.js")>()),
  scrubSecrets: (t: string) => t,
  secretSpans: () => [],
}));

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { fileWriteTool, fileDeleteTool } from "./file.js";
import { fileEditTool } from "./code-editing.js";
import { validateShellCommand } from "./shell.js";

const PRIMARY = "/root/claude/mission-control";
const WORKTREE = "/root/claude/mission-control-jarvis";
const CONTAINER = "/workspace";
const TAG = `zz-wbp-${process.pid}-${Date.now()}`;
/** Matches only an old_string that is never present, so an edit that slips through changes nothing. */
const SENTINEL = `${TAG}-old-string-not-present`;

type ToolName = "file_write" | "file_edit" | "file_delete" | "shell_redirect" | "shell_tee" | "shell_cp";
const TOOLS: ToolName[] = ["file_write", "file_edit", "file_delete", "shell_redirect", "shell_tee", "shell_cp"];

/** Run one tool on one path; returns "ALLOWED" (shell) or the tool's JSON error / success text. */
async function drive(tool: ToolName, path: string): Promise<string> {
  switch (tool) {
    case "file_write":
      return fileWriteTool.execute({ path, content: "parity\n" });
    case "file_edit":
      return fileEditTool.execute({ path, old_string: SENTINEL, new_string: "x" });
    case "file_delete":
      return fileDeleteTool.execute({ path });
    case "shell_redirect":
    case "shell_tee":
    case "shell_cp": {
      const cmd =
        tool === "shell_redirect"
          ? `echo parity > ${path}`
          : tool === "shell_tee"
            ? `echo parity | tee ${path}`
            : `cp /dev/null ${path}`;
      const v = validateShellCommand(cmd);
      return v.allowed ? "ALLOWED" : JSON.stringify({ error: v.reason });
    }
  }
}

function errorOf(out: string): string | null {
  if (out === "ALLOWED") return null;
  try {
    const j = JSON.parse(out) as { error?: unknown };
    return j.error === undefined ? null : String(j.error);
  } catch {
    return out;
  }
}

/** A refusal raised by a gate — never a tripwire, a missing file, or a thrown fs error. */
function expectRefused(out: string, reason: RegExp): void {
  const err = errorOf(out);
  expect(err, `expected a refusal, got: ${out}`).not.toBeNull();
  expect(err).not.toMatch(/TRIPWIRE|File not found|ENOENT|no such file|old_string not found/);
  expect(err).toMatch(reason);
}

/**
 * Passed every gate: shell allows, the file tools reach the filesystem
 * (tripwire / missing file). The filesystem's own answer depends on the host:
 * a non-root user is refused a stat under /root/ with EACCES. That still means
 * the boundary let the path through, so a permission error counts, as long as
 * it carries none of the refusal reasons (`R`, or a tool's "<Op> blocked:").
 */
function expectPastBoundary(out: string): void {
  const err = errorOf(out);
  if (err === null) return;
  expect(err).toMatch(/TRIPWIRE|File not found|ENOENT|no such file|EACCES|EPERM|permission denied/);
  expect(err).not.toMatch(/blocked/);
  for (const reason of Object.values(R)) expect(err).not.toMatch(reason);
}

const R = {
  // shell_exec's own text gate refuses a `>` into a system dir before the
  // write-target loop; that refusal counts (write-boundary.test.ts pins the
  // boundary's own verdict for these paths).
  system: /\/(?:etc|usr|var)\/ is protected|outside allowed paths|redirect to system directory/,
  outside: /outside allowed paths/,
  operatorConfig: /operator config/,
  primary: /\/root\/claude\/mission-control\/ is protected|own source code/,
  immutable: /[Ii]mmutable core/,
  skill: /skill definition/,
  dayLog: /logs\/day-logs\/ is mechanically managed/,
  standingOrders: /standing order/,
  northStar: /NORTHSTAR_RETIRED/,
  projectRecord: /PROJECT_RECORD_PROTECTED/,
  kbRoot: /is or contains the KB root/,
  topLevelProject: /cannot delete top-level project directory/,
  // Under /root/.claude/ the path-safety read denylist (file tools) and the
  // shell's secret-path text gate refuse first, outside the readable docs.
  claudeHomeSecret: /\/root\/\.claude\/ is protected|outside allowed paths|is read-blocked|is off-limits to the shell/,
  // The readable docs pass those gates, so the boundary itself must refuse.
  claudeHomeDocs: /\/root\/\.claude\/ is protected|outside allowed paths/,
};

interface Row {
  category: string;
  path: () => string;
  reason: RegExp;
}

let kb = "";
const ROWS: Row[] = [
  { category: "1 system dir /etc", path: () => `/etc/${TAG}.conf`, reason: R.system },
  { category: "1 system dir /usr", path: () => `/usr/local/${TAG}.sh`, reason: R.system },
  { category: "1 system dir /var", path: () => `/var/${TAG}/x.txt`, reason: R.system },
  { category: "2 outside allow-list /root", path: () => `/root/${TAG}.sh`, reason: R.outside },
  { category: "2 outside allow-list /opt", path: () => `/opt/${TAG}/x.yml`, reason: R.outside },
  { category: "3 operator config dot-entry", path: () => `/root/claude/.claude/${TAG}.json`, reason: R.operatorConfig },
  { category: "3 operator config umbrella CLAUDE.md", path: () => "/root/claude/CLAUDE.md", reason: R.operatorConfig },
  { category: "3 operator config .mcp.json", path: () => "/root/claude/.mcp.json", reason: R.operatorConfig },
  { category: "4 primary checkout source", path: () => `${PRIMARY}/src/${TAG}.ts`, reason: R.primary },
  { category: "5 immutable file, primary", path: () => `${PRIMARY}/src/tools/builtin/file.ts`, reason: R.immutable },
  { category: "5 immutable dir, primary", path: () => `${PRIMARY}/src/api/${TAG}.ts`, reason: R.immutable },
  { category: "5 immutable file, primary (mc-ctl)", path: () => `${PRIMARY}/mc-ctl`, reason: R.immutable },
  { category: "5 immutable dir, primary (.github/)", path: () => `${PRIMARY}/.github/${TAG}.yml`, reason: R.immutable },
  {
    category: "6 immutable file, worktree (file.ts)",
    path: () => `${WORKTREE}/src/tools/builtin/file.ts`,
    reason: R.immutable,
  },
  {
    category: "6 immutable file, worktree (write-guard.ts)",
    path: () => `${WORKTREE}/src/tools/builtin/write-guard.ts`,
    reason: R.immutable,
  },
  {
    category: "6 immutable file, worktree (write-boundary.ts)",
    path: () => `${WORKTREE}/src/tools/builtin/write-boundary.ts`,
    reason: R.immutable,
  },
  { category: "6 immutable dir, worktree", path: () => `${WORKTREE}/src/api/${TAG}.ts`, reason: R.immutable },
  { category: "6 immutable file, worktree (git.ts)", path: () => `${WORKTREE}/src/tools/builtin/git.ts`, reason: R.immutable },
  { category: "6 immutable file, worktree (scripts/deploy.sh)", path: () => `${WORKTREE}/scripts/deploy.sh`, reason: R.immutable },
  { category: "6 immutable dir, worktree (.github/)", path: () => `${WORKTREE}/.github/workflows/${TAG}.yml`, reason: R.immutable },
  { category: "6 immutable dir, worktree (scripts/git-hooks/)", path: () => `${WORKTREE}/scripts/git-hooks/${TAG}`, reason: R.immutable },
  { category: "7 immutable file, container clone (shell.ts)", path: () => `${CONTAINER}/src/tools/builtin/shell.ts`, reason: R.immutable },
  { category: "7 immutable dir, container clone (.github/)", path: () => `${CONTAINER}/.github/workflows/${TAG}.yml`, reason: R.immutable },
  { category: "8 skill definition (KB)", path: () => `${kb}/skills/${TAG}/SKILL.md`, reason: R.skill },
  { category: "8 standing order (KB)", path: () => `${kb}/directives/${TAG}.md`, reason: R.standingOrders },
  { category: "8 NorthStar (KB)", path: () => `${kb}/NorthStar/${TAG}.md`, reason: R.northStar },
  { category: "8 project record (KB)", path: () => `${kb}/projects/${TAG}/project.md`, reason: R.projectRecord },
  { category: "8 day-log (KB)", path: () => `${kb}/logs/day-logs/2099-01-01.md`, reason: R.dayLog },
  { category: "9 /root/.claude (default-deny area)", path: () => `/root/.claude/${TAG}.json`, reason: R.claudeHomeSecret },
  { category: "9 /root/.claude (readable docs)", path: () => `/root/.claude/rules/${TAG}.md`, reason: R.claudeHomeDocs },
];

const savedKb = process.env.JARVIS_KB_MIRROR_DIR;

beforeAll(() => {
  trip.root = mkdtempSync("/tmp/wb-parity-");
  kb = `${trip.root}/kb`;
  process.env.JARVIS_KB_MIRROR_DIR = kb;
});

afterAll(() => {
  if (savedKb === undefined) delete process.env.JARVIS_KB_MIRROR_DIR;
  else process.env.JARVIS_KB_MIRROR_DIR = savedKb;
  if (trip.root.startsWith("/tmp/wb-parity-")) rmSync(trip.root, { recursive: true, force: true });
});

afterEach(() => {
  const hits = trip.hits.splice(0);
  expect(hits, "a tool reached the filesystem outside the test directory").toEqual([]);
});

describe("write-boundary parity — tripwire self-check", () => {
  it("refuses a mutation outside the test directory without performing it", () => {
    const outside = `/tmp/${TAG}-tripwire-probe`;
    expect(() => writeFileSync(outside, "x")).toThrow(/TRIPWIRE/);
    expect(existsSync(outside)).toBe(false);
    expect(trip.hits.splice(0)).toEqual([`writeFileSync ${outside}`]);
  });
});

describe("write-boundary parity — every tool refuses every forbidden category", () => {
  for (const row of ROWS) {
    for (const tool of TOOLS) {
      it(`${row.category} × ${tool}`, async () => {
        expectRefused(await drive(tool, row.path()), row.reason);
      });
    }
  }
});

describe("write-boundary parity — a directory delete that holds protected files", () => {
  for (const dir of [
    `${WORKTREE}/.github`,
    `${WORKTREE}/scripts`,
    `${PRIMARY}/scripts`,
    `${CONTAINER}/scripts`,
  ]) {
    it(`file_delete refuses ${dir}`, async () => {
      expectRefused(await drive("file_delete", dir), R.immutable);
    });
  }

  // A top-level directory is refused by isDangerousRemovalPath before the
  // boundary; write-boundary.test.ts pins the boundary's own verdict.
  it(`file_delete refuses ${CONTAINER}`, async () => {
    expectRefused(await drive("file_delete", CONTAINER), /[Ii]mmutable core|Cannot delete top-level/);
  });

  const kbDirs: Array<[string, () => string, RegExp]> = [
    ["logs", () => `${kb}/logs`, R.dayLog],
    ["logs/day-logs", () => `${kb}/logs/day-logs`, R.dayLog],
    ["skills", () => `${kb}/skills`, R.skill],
    ["skills/<name>", () => `${kb}/skills/${TAG}`, R.skill],
    ["the KB root", () => kb, R.kbRoot],
  ];
  for (const [name, path, reason] of kbDirs) {
    it(`file_delete refuses KB ${name}`, async () => {
      expectRefused(await drive("file_delete", path()), reason);
    });
  }
});

describe("write-boundary parity — file_delete depth under /root/claude/", () => {
  // A project root is refused; a path inside one passes (it does not exist,
  // so the delete stops at the filesystem).
  it("refuses a top-level project directory", async () => {
    expectRefused(await drive("file_delete", `/root/claude/${TAG}`), R.topLevelProject);
  });

  it("lets a path inside a project directory past the boundary", async () => {
    expectPastBoundary(await drive("file_delete", `/root/claude/${TAG}/x`));
    trip.hits.splice(0);
  });
});

describe("write-boundary parity — the ritual-writable log in the primary checkout", () => {
  const LOG = `${PRIMARY}/docs/EVOLUTION-LOG.md`;

  it("file_write passes the boundary (the plain write is the exception)", async () => {
    expectPastBoundary(await drive("file_write", LOG));
    const hits = trip.hits.splice(0);
    expect(hits.length).toBeGreaterThan(0); // stopped by the tripwire, never written
  });

  it("file_write of any other primary docs file is refused", async () => {
    expectRefused(await drive("file_write", `${PRIMARY}/docs/${TAG}.md`), R.primary);
  });

  it("file_edit and file_delete are refused like the rest of the primary checkout", async () => {
    expectRefused(await drive("file_edit", LOG), R.primary);
    expectRefused(await drive("file_delete", LOG), R.primary);
  });

  it("shell_exec allows an append and refuses an overwrite", () => {
    expect(validateShellCommand(`echo parity >> ${LOG}`)).toEqual({ allowed: true });
    expect(validateShellCommand(`echo parity | tee -a ${LOG}`)).toEqual({ allowed: true });
    for (const cmd of [`echo parity > ${LOG}`, `echo parity | tee ${LOG}`, `cp /dev/null ${LOG}`]) {
      const v = validateShellCommand(cmd);
      expect(v.allowed, cmd).toBe(false);
      expect(v.reason).toMatch(/append-only via shell_exec/);
    }
  });
});

describe("write-boundary parity — allowed positions", () => {
  // A non-protected path in the worktree or the container clone is allowed.
  for (const [where, root] of [["worktree", WORKTREE], ["container clone", CONTAINER]] as const) {
    for (const rel of [`docs/${TAG}.md`, `src/tools/${TAG}.ts`, `scripts/${TAG}.sh`]) {
      for (const tool of TOOLS) {
        it(`${where} non-protected ${rel.split("/")[0]}/ path × ${tool}`, async () => {
          expectPastBoundary(await drive(tool, `${root}/${rel}`));
          // The write reached the (refused) filesystem: past the boundary. Only
          // fs tripwire hits are expected here, never a git call.
          const hits = trip.hits.splice(0);
          expect(hits.filter((x) => x.startsWith("git "))).toEqual([]);
        });
      }
    }
  }

  it("file_write writes under the test's /tmp directory", async () => {
    const p = `${trip.root}/w/out.txt`;
    const r = JSON.parse(await fileWriteTool.execute({ path: p, content: "ok\n" }));
    expect(r.error).toBeUndefined();
    expect(readFileSync(p, "utf-8")).toBe("ok\n");
  });

  it("file_edit edits under the test's /tmp directory", async () => {
    const p = `${trip.root}/e.txt`;
    writeFileSync(p, "alpha\n");
    const r = JSON.parse(await fileEditTool.execute({ path: p, old_string: "alpha", new_string: "beta" }));
    expect(r.error).toBeUndefined();
    expect(readFileSync(p, "utf-8")).toBe("beta\n");
  });

  it("file_delete deletes under the test's /tmp directory", async () => {
    const p = `${trip.root}/d.txt`;
    writeFileSync(p, "x");
    const r = JSON.parse(await fileDeleteTool.execute({ path: p }));
    expect(r.error).toBeUndefined();
    expect(existsSync(p)).toBe(false);
  });

  it("shell_exec allows redirect / tee / cp under the test's /tmp directory", () => {
    for (const cmd of [
      `echo x > ${trip.root}/s.txt`,
      `echo x | tee ${trip.root}/s.txt`,
      `cp /dev/null ${trip.root}/s.txt`,
    ]) {
      expect(validateShellCommand(cmd)).toEqual({ allowed: true });
    }
  });
});
