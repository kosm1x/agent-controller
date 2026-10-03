/**
 * Tests for grep, glob, and list_dir tools.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, symlinkSync } from "fs";
import { grepTool, globTool, listDirTool } from "./code-search.js";
import { initDatabase, closeDatabase, getDatabase } from "../../db/index.js";
import { invalidateSecretRefs } from "../../lib/secret-refs.js";

const TEST_DIR = "/tmp/mc-test-code-search";

describe("grep", () => {
  beforeEach(() => {
    mkdirSync(`${TEST_DIR}/sub`, { recursive: true });
    writeFileSync(`${TEST_DIR}/a.ts`, "const foo = 1;\nconst bar = 2;\n");
    writeFileSync(`${TEST_DIR}/b.ts`, "export function foo() {}\n");
    writeFileSync(`${TEST_DIR}/sub/c.py`, "def baz():\n    pass\n");
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("should find files containing pattern", async () => {
    const result = JSON.parse(
      await grepTool.execute({ pattern: "foo", path: TEST_DIR }),
    );

    expect(result.total).toBeGreaterThanOrEqual(2);
    expect(result.matches).toContain("a.ts");
    expect(result.matches).toContain("b.ts");
  });

  it("audit R9 should-fix 5: reports truncated when a file reaches the internal per-file cap", async () => {
    writeFileSync(`${TEST_DIR}/many.txt`, "needle\n".repeat(2100));
    writeFileSync(`${TEST_DIR}/few.txt`, "needle\n".repeat(3));
    const big = JSON.parse(
      await grepTool.execute({ pattern: "needle", path: `${TEST_DIR}/many.txt` }),
    );
    expect(big.total).toBe(1);
    expect(big.truncated).toBe(true);
    const small = JSON.parse(
      await grepTool.execute({ pattern: "needle", path: `${TEST_DIR}/few.txt` }),
    );
    expect(small.truncated).toBe(false);
  });

  it("should return content mode with line numbers", async () => {
    const result = JSON.parse(
      await grepTool.execute({
        pattern: "bar",
        path: TEST_DIR,
        output_mode: "content",
      }),
    );

    expect(result.matches).toContain("bar");
    expect(result.total).toBe(1);
  });

  it("should filter by include_glob", async () => {
    const result = JSON.parse(
      await grepTool.execute({
        pattern: "def",
        path: TEST_DIR,
        include_glob: "*.py",
      }),
    );

    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.matches).toContain("c.py");
  });

  it("a glob with a directory part narrows to that directory (logic audit F25 / qa W1)", async () => {
    mkdirSync(`${TEST_DIR}/src/inner`, { recursive: true });
    mkdirSync(`${TEST_DIR}/other`, { recursive: true });
    writeFileSync(`${TEST_DIR}/src/inner/a.txt`, "needle here");
    writeFileSync(`${TEST_DIR}/other/b.txt`, "needle here");
    const result = JSON.parse(
      await grepTool.execute({ pattern: "needle", path: TEST_DIR, include_glob: "src/**/*.txt", output_mode: "files" }),
    );
    // files mode returns the matched paths as a newline-joined string
    const files = String(result.matches);
    expect(files).toContain("src/inner/a.txt");
    expect(files).not.toContain("other/b.txt");
  });

  it("should return empty for no matches", async () => {
    const result = JSON.parse(
      await grepTool.execute({ pattern: "zzzznonexistent", path: TEST_DIR }),
    );

    expect(result.total).toBe(0);
  });

  it("should support case-insensitive search", async () => {
    const result = JSON.parse(
      await grepTool.execute({
        pattern: "FOO",
        path: TEST_DIR,
        case_insensitive: true,
      }),
    );

    expect(result.total).toBeGreaterThanOrEqual(2);
  });

  it("count mode lists only files with matches (grep -c prints zeros)", async () => {
    const result = JSON.parse(
      await grepTool.execute({ pattern: "bar", path: TEST_DIR, output_mode: "count" }),
    );
    expect(result.total).toBe(1);
    expect(result.matches).toBe(`${TEST_DIR}/a.ts:1`);
  });

  // Ruling 3c (audit round 8, B-2): grep is not a per-character oracle on a
  // stored value. A pattern that cuts into a stored-value span never matches
  // (match / no-match / count would otherwise recover the value), while a
  // pattern entirely outside the value still finds the line, scrubbed.
  describe("stored-value oracle (B-2)", () => {
    const SEC = "pw-" + "Q7z".repeat(6); // secret-shaped, > 8 chars
    beforeEach(() => {
      initDatabase(":memory:");
      getDatabase()
        .prepare("INSERT INTO user_facts (category,key,value) VALUES (?,?,?)")
        .run("projects", "acme_ftp_password", SEC);
      invalidateSecretRefs();
      writeFileSync(`${TEST_DIR}/conf.txt`, `FTP_PASSWORD=${SEC}\n`);
    });
    afterEach(() => {
      invalidateSecretRefs();
      closeDatabase();
    });

    it("a partial-value pattern matches nothing, right guess or wrong", async () => {
      for (const g of [SEC.slice(0, 7), "pw-Q8z", SEC.slice(0, 12)]) {
        for (const mode of ["files", "content", "count"]) {
          const r = JSON.parse(
            await grepTool.execute({
              pattern: "FTP_PASSWORD=" + g,
              path: TEST_DIR,
              output_mode: mode,
            }),
          );
          expect(r.total, `${mode} ${g}`).toBe(0);
        }
      }
    });

    it("the key before the value still matches; the value is scrubbed out", async () => {
      const r = JSON.parse(
        await grepTool.execute({
          pattern: "FTP_PASSWORD=",
          path: TEST_DIR,
          output_mode: "content",
        }),
      );
      expect(r.total).toBe(1);
      expect(String(r.matches)).toContain("FTP_PASSWORD=");
      expect(String(r.matches)).not.toContain(SEC);
      expect(String(r.matches)).not.toContain(SEC.slice(0, 7));
    });
  });

  // audit 2026-09-22: grep read credential files the file_read denylist blocks.
  it("refuses read-blocked paths", async () => {
    for (const p of ["/root/.claude.json", "/proc/self/environ", "/root/.docker/config.json"]) {
      const result = JSON.parse(await grepTool.execute({ pattern: "a", path: p, output_mode: "count" }));
      expect(String(result.error), p).toMatch(/path blocked/);
    }
  });

  // Root only, like the service: as non-root (CI) /etc/shadow is unreadable anyway, and
  // grep -r exits 2 on /etc's unreadable dirs, which the tool reports as an error.
  it.skipIf(process.getuid?.() !== 0)("drops records from denylisted files inside an allowed directory (R2)", async () => {
    // /etc passes the path check; /etc/shadow inside it must not come back.
    const ctl = JSON.parse(
      await grepTool.execute({ pattern: "root", path: "/etc", include_glob: "passwd", output_mode: "files" }),
    );
    expect(ctl.matches).toContain("/etc/passwd");
    // include_glob still narrows (GNU grep: --include must precede --exclude).
    for (const f of String(ctl.matches).split("\n")) expect(f.split("/").at(-1)).toBe("passwd");
    for (const mode of ["files", "content", "count"]) {
      const r = JSON.parse(
        await grepTool.execute({ pattern: "root", path: "/etc", include_glob: "shadow", output_mode: mode }),
      );
      expect(JSON.stringify(r), mode).not.toContain("/etc/shadow");
      expect(r.total, mode).toBe(0);
    }
  });

  it("a newline inside a file name cannot re-attribute a record (R3)", async () => {
    const odd = `${TEST_DIR}/sub/nl\nx.txt`;
    writeFileSync(odd, "hello-nl\n");
    const r = JSON.parse(await grepTool.execute({ pattern: "hello-nl", path: TEST_DIR, output_mode: "content" }));
    expect(r.total).toBe(1);
    expect(r.matches).toBe(`${odd}:1:hello-nl`);
  });

  it("content mode keeps file:line:text shape through the NUL parse", async () => {
    const r = JSON.parse(await grepTool.execute({ pattern: "bar", path: TEST_DIR, output_mode: "content" }));
    expect(r.matches).toBe(`${TEST_DIR}/a.ts:2:const bar = 2;`);
  });

  it("redacts credential shapes in matched lines", async () => {
    writeFileSync(`${TEST_DIR}/cfg.ts`, "const k = \"" + "sk-" + "ant" + "A1b2C3d4E5f6G7h8J9k0" + "\";\n");
    const result = JSON.parse(
      await grepTool.execute({ pattern: "const k", path: TEST_DIR, output_mode: "content" }),
    );
    expect(result.matches).toContain("cfg.ts");
    expect(result.matches).not.toContain("A1b2C3d4E5f6G7h8J9k0");
  });
});

describe("glob", () => {
  beforeEach(() => {
    mkdirSync(`${TEST_DIR}/src/components`, { recursive: true });
    writeFileSync(`${TEST_DIR}/src/index.ts`, "");
    writeFileSync(`${TEST_DIR}/src/components/App.tsx`, "");
    writeFileSync(`${TEST_DIR}/src/components/Button.tsx`, "");
    writeFileSync(`${TEST_DIR}/package.json`, "{}");
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // audit 2026-09-22: names are output too — same read denylist as grep.
  it("hides read-blocked names and refuses a blocked base path", async () => {
    writeFileSync(`${TEST_DIR}/src/id_rsa`, "");
    const r = JSON.parse(await globTool.execute({ pattern: "*", path: TEST_DIR }));
    expect(r.files.some((f: string) => f.endsWith("index.ts"))).toBe(true);
    expect(r.files.some((f: string) => f.endsWith("id_rsa"))).toBe(false);
    expect(r.total).toBe(4);
    // R1 W4: only the denylist hides a name — `$` is an ordinary character.
    writeFileSync(`${TEST_DIR}/src/$id.tsx`, "");
    const routes = JSON.parse(
      await globTool.execute({ pattern: "*.tsx", path: TEST_DIR }),
    );
    expect(routes.files.some((f: string) => f.endsWith("$id.tsx"))).toBe(true);
    writeFileSync(`${TEST_DIR}/.env`, "");
    const env = JSON.parse(
      await globTool.execute({ pattern: "*", path: `${TEST_DIR}/.env` }),
    );
    expect(String(env.error)).toMatch(/path blocked/);
  });

  it("should find files by extension", async () => {
    const result = JSON.parse(
      await globTool.execute({ pattern: "*.tsx", path: TEST_DIR }),
    );

    expect(result.total).toBe(2);
    expect(result.files.some((f: string) => f.includes("App.tsx"))).toBe(true);
    expect(result.files.some((f: string) => f.includes("Button.tsx"))).toBe(
      true,
    );
  });

  it("honours max_results and reports truncated only when something was cut (logic audit F4)", async () => {
    const result = JSON.parse(
      await globTool.execute({ pattern: "*.tsx", path: TEST_DIR, max_results: 1 }),
    );
    expect(result.files).toHaveLength(1);
    expect(result.total).toBe(2);
    expect(result.truncated).toBe(true);
    const exact = JSON.parse(
      await globTool.execute({ pattern: "*.tsx", path: TEST_DIR, max_results: 2 }),
    );
    expect(exact.truncated).toBe(false);
  });

  it("keeps the glob's directory part and prunes node_modules (logic audit F4)", async () => {
    mkdirSync(`${TEST_DIR}/node_modules/dep`, { recursive: true });
    writeFileSync(`${TEST_DIR}/node_modules/dep/x.tsx`, "");
    mkdirSync(`${TEST_DIR}/other`, { recursive: true });
    writeFileSync(`${TEST_DIR}/other/y.tsx`, "");
    const result = JSON.parse(
      await globTool.execute({ pattern: "src/**/*.tsx", path: TEST_DIR }),
    );
    expect(result.files.every((f: string) => f.includes("/src/"))).toBe(true);
    expect(result.files.some((f: string) => f.includes("node_modules"))).toBe(false);
    expect(result.total).toBe(2);
  });

  it("should find specific filenames", async () => {
    const result = JSON.parse(
      await globTool.execute({ pattern: "package.json", path: TEST_DIR }),
    );

    expect(result.total).toBeGreaterThanOrEqual(1);
  });

  it("should return empty for no matches", async () => {
    const result = JSON.parse(
      await globTool.execute({ pattern: "*.rb", path: TEST_DIR }),
    );

    expect(result.total).toBe(0);
  });
});

describe("list_dir", () => {
  beforeEach(() => {
    mkdirSync(`${TEST_DIR}/subdir`, { recursive: true });
    writeFileSync(`${TEST_DIR}/file1.ts`, "");
    writeFileSync(`${TEST_DIR}/file2.ts`, "");
    writeFileSync(`${TEST_DIR}/subdir/nested.ts`, "");
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("should list directory contents", async () => {
    const result = JSON.parse(await listDirTool.execute({ path: TEST_DIR }));

    expect(result.entries).toContain("file1.ts");
    expect(result.entries).toContain("file2.ts");
    expect(result.entries.some((e: string) => e.includes("subdir"))).toBe(true);
  });

  it("should list recursively", async () => {
    const result = JSON.parse(
      await listDirTool.execute({ path: TEST_DIR, recursive: true }),
    );

    expect(result.entries.some((e: string) => e.includes("nested.ts"))).toBe(
      true,
    );
  });

  // audit 2026-09-22: names are output too — same read denylist as grep.
  it("hides read-blocked entries and refuses a blocked path", async () => {
    writeFileSync(`${TEST_DIR}/id_rsa`, "");
    writeFileSync(`${TEST_DIR}/subdir/.env`, "");
    const flat = JSON.parse(await listDirTool.execute({ path: TEST_DIR }));
    expect(flat.entries).toContain("file1.ts");
    expect(flat.entries).not.toContain("id_rsa");
    writeFileSync(`${TEST_DIR}/$id.tsx`, "");
    const again = JSON.parse(await listDirTool.execute({ path: TEST_DIR }));
    expect(again.entries).toContain("$id.tsx");
    const deep = JSON.parse(
      await listDirTool.execute({ path: TEST_DIR, recursive: true }),
    );
    expect(deep.entries.some((e: string) => e.includes("nested.ts"))).toBe(true);
    expect(deep.entries.some((e: string) => /id_rsa|\.env$/.test(e))).toBe(false);
    const env = JSON.parse(
      await listDirTool.execute({ path: `${TEST_DIR}/subdir/.env` }),
    );
    expect(String(env.error)).toMatch(/path blocked/);
  });

  // audit 2026-10-01 C1: `ls` lists the tree the kernel walked to, so the
  // entry filter must judge that tree, not the lexical spelling.
  it("hides entries reached through `link/..` (kernel path, not text)", async () => {
    symlinkSync("/proc/self/fd", `${TEST_DIR}/lnk`);
    const r = JSON.parse(
      await listDirTool.execute({ path: `${TEST_DIR}/lnk/..` }),
    );
    expect(r.entries).toContain("status");
    expect(r.entries).not.toContain("environ");
    // C1-R2: magic links are not listed through (another process's view).
    expect(r.entries).not.toContain("root/");
    expect(r.entries).not.toContain("cwd/");
    expect(r.entries).not.toContain("root");
    expect(r.entries).not.toContain("cwd");
  });

  it("refuses listing a /proc magic link or a symlink to one (C1-R2)", async () => {
    symlinkSync("/proc/self/root", `${TEST_DIR}/hostroot`);
    for (const path of ["/proc/self/root", "/proc/1/root/etc", `${TEST_DIR}/hostroot/etc`]) {
      const r = JSON.parse(await listDirTool.execute({ path }));
      expect(String(r.error), path).toMatch(/path blocked/);
    }
    // A listing of a tree holding such a link does not enumerate through it.
    const deep = JSON.parse(
      await listDirTool.execute({ path: TEST_DIR, recursive: true }),
    );
    expect(deep.entries.some((e: string) => e.includes("hostroot/"))).toBe(false);
  });

  it("refuses a blocked directory itself instead of listing it empty (I1)", async () => {
    for (const path of ["/root/.ssh", "/root/backups", "/proc/self/cwd/../../backups"]) {
      const r = JSON.parse(await listDirTool.execute({ path }));
      expect(String(r.error), path).toMatch(/path blocked/);
    }
  });

  it("should handle non-existent directory", async () => {
    const result = JSON.parse(
      await listDirTool.execute({ path: "/tmp/mc-test-nonexistent-dir" }),
    );

    // Either empty entries or error
    expect(result.entries?.length === 0 || result.error).toBeTruthy();
  });
});
