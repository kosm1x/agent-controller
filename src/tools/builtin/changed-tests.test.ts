import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  changedFiles,
  MAX_RELATED_FILES,
  relatedScopeSummary,
  relatedTestArgv,
  relatedTestCommand,
  relatedTestFileCount,
  resolveTestScope,
} from "./changed-tests.js";

// Ruling 4: "changed" = commits ahead of origin/main + uncommitted + untracked.
// Real repos (origin + clone), like jarvis-dev.test.ts's action=branch fixture.
describe("changed-tests — the one 'changed files' definition (ruling 4)", () => {
  let root: string;
  let repo: string;
  // The pre-commit hook exports GIT_DIR/GIT_INDEX_FILE for the commit being
  // made; inherited, they would point every fixture call at the REAL repo.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
  );
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      env,
      encoding: "utf-8",
      stdio: "pipe",
    });
  // changedFiles/resolveTestScope take an async reader (their own runs git
  // through promisify(execFile)); the fixture's sync git answers it.
  const gitAsync = async (args: string[]) => git(args);
  const write = (f: string, s = f) => {
    mkdirSync(join(repo, f, ".."), { recursive: true });
    writeFileSync(join(repo, f), s);
  };
  const commitAll = (msg: string) => {
    git(["add", "-A"]);
    git(["commit", "-q", "-m", msg]);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "changed-tests-"));
    const origin = join(root, "origin.git");
    repo = join(root, "repo");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], {
      env,
    });
    execFileSync("git", ["clone", "-q", origin, repo], { env, stdio: "pipe" });
    git(["config", "user.email", "t@t"]);
    git(["config", "user.name", "t"]);
    git(["checkout", "-q", "-b", "main"]);
    for (const f of [
      "src/base.ts",
      "src/gone.ts",
      "src/edited.ts",
      "README.md",
    ])
      write(f);
    commitAll("base");
    git(["push", "-q", "origin", "main"]);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("unions commits ahead of origin/main, staged, unstaged and untracked files", async () => {
    git(["checkout", "-q", "-b", "jarvis/fix/x"]);
    write("src/committed.ts");
    commitAll("ahead");
    write("src/staged.ts");
    git(["add", "src/staged.ts"]);
    write("src/edited.ts", "changed");
    write("src/untracked.ts");
    rmSync(join(repo, "src/gone.ts"));
    write("docs/notes.md");
    expect(await changedFiles(repo, gitAsync)).toEqual([
      "docs/notes.md",
      "src/committed.ts",
      "src/edited.ts",
      "src/gone.ts",
      "src/staged.ts",
      "src/untracked.ts",
    ]);
    // Only existing .ts paths reach vitest: no deleted file, no markdown.
    expect(await resolveTestScope(repo, gitAsync)).toEqual({
      kind: "related",
      changed: 6,
      files: [
        "src/committed.ts",
        "src/edited.ts",
        "src/staged.ts",
        "src/untracked.ts",
      ],
      note: "the full suite runs in pre-commit/CI",
    });
  });

  it("does not count commits that exist only on origin/main", async () => {
    git(["checkout", "-q", "-b", "jarvis/fix/x"]);
    git(["checkout", "-q", "main"]);
    write("src/upstream.ts");
    commitAll("upstream");
    git(["push", "-q", "origin", "main"]);
    git(["checkout", "-q", "jarvis/fix/x"]);
    git(["fetch", "-q", "origin"]);
    expect(await changedFiles(repo, gitAsync)).toEqual([]);
  });

  it("clean tree at origin/main → skip with the explicit full-suite note", async () => {
    expect(await resolveTestScope(repo, gitAsync)).toEqual({
      kind: "skip",
      changed: 0,
      reason: "no changed files; the full suite runs in pre-commit/CI",
    });
  });

  it("only non-TS changes → skip whose reason states the count (audit W1)", async () => {
    write("README.md", "edited");
    write("src/tools/builtin/pm-shim/npm.sh");
    expect(await resolveTestScope(repo, gitAsync)).toEqual({
      kind: "skip",
      changed: 2,
      reason:
        "2 changed file(s), none a .ts file vitest can scope — typecheck only; the full suite runs in pre-commit/CI",
    });
  });

  it("the trailing note names where the full suite runs for that path (jarvis_dev: CI)", async () => {
    expect(await resolveTestScope(repo, gitAsync, "CI")).toMatchObject({
      reason: "no changed files; the full suite runs in CI",
    });
    write("src/real.ts");
    expect(await resolveTestScope(repo, gitAsync, "CI")).toMatchObject({
      kind: "related",
      note: "the full suite runs in CI",
    });
  });

  it("drops paths under a package.json / vite(st).config.* segment — vitest reruns EVERY test for them (audit N1)", async () => {
    write("src/package.json/z.ts");
    write("src/vitest.config.d/y.ts");
    write("src/vite.config.x/w.ts");
    write("vitest.config.ts");
    write("src/package.json.ts");
    write("src/my-vitest.config.ts");
    write("src/real.ts");
    expect(await resolveTestScope(repo, gitAsync)).toEqual({
      kind: "related",
      changed: 7,
      files: ["src/my-vitest.config.ts", "src/package.json.ts", "src/real.ts"],
      note: "the full suite runs in pre-commit/CI",
    });
  });

  it("an untracked file named HEAD does not make the diff ambiguous (audit N2)", async () => {
    write("HEAD", "x");
    write("src/real.ts");
    expect(await changedFiles(repo, gitAsync)).toEqual(["HEAD", "src/real.ts"]);
    expect((await resolveTestScope(repo, gitAsync)).kind).toBe("related");
  });

  it(`more than ${MAX_RELATED_FILES} changed .ts files → skip (typecheck only), never the full suite`, async () => {
    for (let i = 0; i <= MAX_RELATED_FILES; i++) write(`src/m${i}.ts`);
    const scope = await resolveTestScope(repo, gitAsync);
    expect(scope.kind).toBe("skip");
    expect(scope).toMatchObject({
      reason: `${MAX_RELATED_FILES + 1} changed source files exceed the ${MAX_RELATED_FILES}-file cap for a scoped run, typecheck only; the full suite runs in pre-commit/CI`,
    });
  });

  it("exactly the cap still runs scoped", async () => {
    for (let i = 0; i < MAX_RELATED_FILES; i++) write(`src/m${i}.ts`);
    const scope = await resolveTestScope(repo, gitAsync);
    expect(scope.kind).toBe("related");
  });

  it("an unresolvable base is an error, not an empty (passing) scope", async () => {
    git(["remote", "remove", "origin"]);
    const scope = await resolveTestScope(repo, gitAsync);
    expect(scope.kind).toBe("error");
    expect(scope).toMatchObject({
      reason: expect.stringContaining("could not determine changed files"),
    });
  });

  it("reads names NUL-separated, so unusual names arrive unquoted", async () => {
    write("src/a b.ts");
    write("src/é.ts");
    expect(await changedFiles(repo, gitAsync)).toEqual(["src/a b.ts", "src/é.ts"]);
  });
});

describe("changed-tests — the related-mode command", () => {
  it("argv: related mode, run once, dot reporter, ./-prefixed paths", () => {
    expect(relatedTestArgv(["src/a.ts", "-x.ts"])).toEqual([
      "npx",
      "vitest",
      "related",
      "--run",
      "--reporter=dot",
      "--passWithNoTests",
      "./src/a.ts",
      "./-x.ts",
    ]);
  });

  it("never puts a bare `--` before the paths (vitest then finds no test files, exit 0 = silent green)", () => {
    expect(relatedTestArgv(["src/a.ts"])).not.toContain("--");
    expect(relatedTestCommand(["src/a.ts"]).split(" ")).not.toContain("--");
  });

  it("shell string quotes every unsafe word (paths come from the worktree)", () => {
    expect(
      relatedTestCommand(["src/a.ts", "src/a b.ts", "src/$(id)'.ts"]),
    ).toBe(
      "npx vitest related --run --reporter=dot --passWithNoTests ./src/a.ts './src/a b.ts' './src/$(id)'\\''.ts'",
    );
    // Substitutions with no quote character in the name (audit Q2).
    expect(relatedTestCommand(["src/$(id).ts", "src/`id`.ts"])).toBe(
      "npx vitest related --run --reporter=dot --passWithNoTests './src/$(id).ts' './src/`id`.ts'",
    );
  });

  it("counts the test files vitest selected", () => {
    expect(
      relatedTestFileCount(" Test Files  3 passed (3)\n Tests  42 passed"),
    ).toBe(3);
    expect(relatedTestFileCount(" Test Files  1 failed | 2 passed (3)\n")).toBe(
      3,
    );
    expect(
      relatedTestFileCount("No test files found, exiting with code 0"),
    ).toBe(0);
    expect(relatedTestFileCount("garbage")).toBeUndefined();
  });

  it("summary names both counts and where the full suite runs", () => {
    const scope = {
      kind: "related" as const,
      changed: 4,
      files: ["a.ts", "b.ts"],
      note: "the full suite runs in pre-commit/CI",
    };
    expect(relatedScopeSummary(scope, "Test Files  5 passed (5)")).toBe(
      "related tests only: 2 changed source file(s) → 5 test file(s) (changed = commits ahead of origin/main + uncommitted + untracked); the full suite runs in pre-commit/CI",
    );
    expect(relatedScopeSummary(scope)).toContain("→ ? test file(s)");
  });
});
