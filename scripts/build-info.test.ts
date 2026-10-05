/**
 * build-info.sh — records which commit dist/ was built from and whether code
 * paths had uncommitted changes. Every case runs the script inside a throwaway
 * git repo under the OS temp dir (the real repo and dist/ are never touched).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// BUILD_INFO_SCRIPT lets a mutation run point the suite at a mutated copy.
const SCRIPT =
  process.env.BUILD_INFO_SCRIPT ??
  resolve(dirname(fileURLToPath(import.meta.url)), "build-info.sh");

let root: string;
let repo: string;
let env: NodeJS.ProcessEnv;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, env, encoding: "utf8" }).trim();
}

function write(rel: string, body: string): void {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), body);
}

function run(...args: string[]): { status: number | null; out: string } {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    cwd: repo,
    env,
    encoding: "utf8",
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

type BuildInfo = {
  commit: string;
  commitShort: string;
  branch: string;
  builtAt: string;
  dirty: boolean;
  dirtyFiles: string[];
};

const info = (): BuildInfo =>
  JSON.parse(
    readFileSync(join(repo, "dist/build-info.json"), "utf8"),
  ) as BuildInfo;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "build-info-"));
  repo = join(root, "repo");
  mkdirSync(repo);
  env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: root,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
  git("init", "-q", "-b", "main");
  write("src/x.ts", "export const x = 1;\n");
  write("scripts/s.sh", "echo s\n");
  write("package.json", "{}\n");
  write("package-lock.json", "{}\n");
  write("tsconfig.json", "{}\n");
  write("docs/x.md", "# doc\n");
  write(".gitignore", "dist/\nsrc/ignored.ts\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  mkdirSync(join(repo, "dist"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("build-info.sh", () => {
  it("clean tree: writes dist/build-info.json with the HEAD commit and dirty=false", () => {
    const before = Date.now();
    const r = run();
    expect(r.status).toBe(0);
    const bi = info();
    expect(bi.commit).toBe(git("rev-parse", "HEAD"));
    expect(bi.commitShort).toBe(git("rev-parse", "--short", "HEAD"));
    expect(bi.branch).toBe("main");
    expect(bi.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Date.parse(bi.builtAt)).toBeGreaterThanOrEqual(
      Math.floor(before / 1000) * 1000,
    );
    expect(bi.dirty).toBe(false);
    expect(bi.dirtyFiles).toEqual([]);
    expect(r.out).toContain(`[deploy] Built ${bi.commitShort} (main)`);
    expect(r.out).not.toMatch(/WARNING/);
  });

  it("modified src/x.ts: dirty=true, file listed, loud warning, still exit 0", () => {
    write("src/x.ts", "export const x = 2;\n");
    const r = run();
    expect(r.status).toBe(0);
    const bi = info();
    expect(bi.dirty).toBe(true);
    expect(bi.dirtyFiles).toEqual(["src/x.ts"]);
    expect(r.out).toMatch(/WARNING/);
    expect(r.out).toContain("src/x.ts");
  });

  it("staged add and tracked deletion under code paths are both listed", () => {
    write("src/y.ts", "export const y = 1;\n");
    git("add", "src/y.ts");
    unlinkSync(join(repo, "package.json"));
    run();
    const bi = info();
    expect(bi.dirty).toBe(true);
    expect([...bi.dirtyFiles].sort()).toEqual(["package.json", "src/y.ts"]);
  });

  it("modified docs/x.md only: not counted, dirty=false", () => {
    write("docs/x.md", "# changed\n");
    expect(run().status).toBe(0);
    expect(info().dirty).toBe(false);
    expect(info().dirtyFiles).toEqual([]);
  });

  it("untracked src/new.ts: listed (tsc compiles it into dist/)", () => {
    write("src/new.ts", "export const n = 1;\n");
    expect(run().status).toBe(0);
    expect(info().dirty).toBe(true);
    expect(info().dirtyFiles).toEqual(["src/new.ts"]);
  });

  it("untracked but git-ignored src/ignored.ts: not listed", () => {
    write("src/ignored.ts", "export const i = 1;\n");
    expect(run().status).toBe(0);
    expect(info().dirty).toBe(false);
    expect(info().dirtyFiles).toEqual([]);
  });

  it("dirty tsconfig.json and package-lock.json are listed", () => {
    write("tsconfig.json", '{ "x": 1 }\n');
    write("package-lock.json", '{ "x": 1 }\n');
    run();
    expect([...info().dirtyFiles].sort()).toEqual([
      "package-lock.json",
      "tsconfig.json",
    ]);
  });

  it("reports a branch other than main", () => {
    git("checkout", "-q", "-b", "feat");
    const r = run();
    expect(info().branch).toBe("feat");
    expect(r.out).toContain("(feat)");
  });

  it("unknown arg: exit 2, writes nothing", () => {
    expect(run("--bogus").status).toBe(2);
    expect(existsSync(join(repo, "dist/build-info.json"))).toBe(false);
  });

  it("missing dist/: exit 1 with the reason", () => {
    rmSync(join(repo, "dist"), { recursive: true, force: true });
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out).toContain("dist/ missing");
  });

  it("corrupt .git/index: exit non-zero, no JSON written", () => {
    writeFileSync(join(repo, ".git/index"), "garbage\n");
    expect(run().status).not.toBe(0);
    expect(existsSync(join(repo, "dist/build-info.json"))).toBe(false);
  });

  it("git status failing alone: exit non-zero, no JSON written", () => {
    const realGit = execFileSync("bash", ["-c", "command -v git"], {
      encoding: "utf8",
    }).trim();
    mkdirSync(join(root, "bin"));
    const shim = join(root, "bin/git");
    writeFileSync(
      shim,
      `#!/bin/bash\nif [ "$1" = status ]; then echo "fatal: simulated" >&2; exit 128; fi\nexec ${realGit} "$@"\n`,
    );
    chmodSync(shim, 0o755);
    env = { ...env, PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}` };
    expect(run().status).not.toBe(0);
    expect(existsSync(join(repo, "dist/build-info.json"))).toBe(false);
  });

  it("--check: exit 0 when clean, exit 3 when dirty, and writes nothing", () => {
    const clean = run("--check");
    expect(clean.status).toBe(0);
    expect(clean.out).toContain("[deploy] Built ");
    write("scripts/s.sh", "echo changed\n");
    const dirty = run("--check");
    expect(dirty.status).toBe(3);
    expect(dirty.out).toContain("scripts/s.sh");
    expect(existsSync(join(repo, "dist/build-info.json"))).toBe(false);
  });

  it("not a git repo: exit 1 with a one-line reason", () => {
    rmSync(join(repo, ".git"), { recursive: true, force: true });
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out.trim().split("\n")).toHaveLength(1);
    expect(r.out).toMatch(/git/);
    expect(existsSync(join(repo, "dist/build-info.json"))).toBe(false);
  });
});
