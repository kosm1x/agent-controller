/**
 * Operator script: DENUE directive psql rewrite. Real in-memory db + scratch
 * KB mirror (JARVIS_KB_MIRROR_DIR). All fixture text is synthetic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "../src/db/index.js";
import { getFile, upsertFile } from "../src/db/jarvis-fs.js";
import { validateShellCommand } from "../src/tools/builtin/shell.js";
import { gateCheck, isMainModule, main, rewriteDenuePsql, runRewrite } from "./kb-rewrite-denue-psql.js";

/** Main must never run on import: the operator gate is the first thing main calls, so it throws here. */
const gate = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../src/lib/operator-gate.js", () => ({
  requireOperatorContext: () => {
    gate.calls++;
    throw new Error("kb-rewrite main ran on import");
  },
}));

/** Seams for verify-failed: a forced mirror dir and a row corrupted after the write. */
const ctl = vi.hoisted(() => ({ mirrorDir: undefined as string | null | undefined, corruptRow: false }));
vi.mock("../src/db/jarvis-fs.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/db/jarvis-fs.js")>();
  const db = await import("../src/db/index.js");
  return {
    ...real,
    getKbMirrorWriteDir: () => (ctl.mirrorDir !== undefined ? ctl.mirrorDir : real.getKbMirrorWriteDir()),
    upsertFile: (...args: Parameters<typeof real.upsertFile>) => {
      real.upsertFile(...args);
      if (ctl.corruptRow) {
        db.getDatabase().prepare("UPDATE jarvis_files SET content = content || 'x' WHERE path = ?").run(args[0]);
      }
    },
  };
});

const SQL = "SELECT count(*) FROM establecimientos WHERE entidad = 09";
const OLD_CMD = `docker exec supabase-db psql -U postgres -d postgres -c "${SQL}"`;
const NEW_CMD = `docker exec supabase-db psql -U mcp_readonly -d postgres -c '${SQL}'`;
const DIRECTIVE = ["# Synthetic card", "", "Run:", "", `\`${OLD_CMD}\``, "", "Done."].join("\n");
const clean = (content: string) => ({ roleSwaps: 0, quoteSwaps: 0, refused: [], changes: [], content });

let kbDir: string;
const prevMirror = process.env.JARVIS_KB_MIRROR_DIR;

beforeEach(() => {
  kbDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "mc-kbrewrite-test-"));
  process.env.JARVIS_KB_MIRROR_DIR = kbDir;
  Object.assign(ctl, { mirrorDir: undefined, corruptRow: false });
  initDatabase(":memory:");
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
  rmSync(kbDir, { recursive: true, force: true });
  if (prevMirror === undefined) delete process.env.JARVIS_KB_MIRROR_DIR;
  else process.env.JARVIS_KB_MIRROR_DIR = prevMirror;
});

describe("module entry", () => {
  it("does not run main when imported", () => {
    expect(isMainModule()).toBe(false);
    expect(gate.calls).toBe(0);
  });

  const orderDeps = (order: string[], written = 0) => ({
    requireOperatorContext: vi.fn(() => void order.push("gate")),
    initDatabase: vi.fn(() => void order.push("init")),
    closeDatabase: vi.fn(() => void order.push("close")),
    runRewrite: vi.fn(() => {
      order.push("run");
      return { ok: true, written };
    }),
    drainKbWrites: vi.fn(async (): Promise<void> => void order.push("drain")),
  });
  const withArgv = async <T>(args: string[], fn: () => Promise<T>): Promise<T> => {
    const prev = process.argv;
    process.argv = [prev[0]!, prev[1]!, ...args];
    try {
      return await fn();
    } finally {
      process.argv = prev;
    }
  };

  it("main runs the operator gate before opening the database", async () => {
    const order: string[] = [];
    const deps = orderDeps(order);
    expect(await withArgv([], () => main(deps))).toBe(0);
    // Dry run: nothing written, nothing to drain.
    expect(order).toEqual(["gate", "init", "run", "close"]);
    deps.requireOperatorContext.mockImplementation(() => {
      throw new Error("refused");
    });
    deps.initDatabase.mockClear();
    await expect(main(deps)).rejects.toThrow("refused");
    expect(deps.initDatabase).not.toHaveBeenCalled();
  });

  it("--apply that wrote rows drains the syncs and INDEX.md before closing the database", async () => {
    const order: string[] = [];
    expect(await withArgv(["--apply"], () => main(orderDeps(order, 2)))).toBe(0);
    expect(order).toEqual(["gate", "init", "run", "drain", "close"]);
  });

  it("--apply that wrote nothing does not drain (no INDEX.md rewrite)", async () => {
    const order: string[] = [];
    expect(await withArgv(["--apply"], () => main(orderDeps(order, 0)))).toBe(0);
    expect(order).toEqual(["gate", "init", "run", "close"]);
  });

  it("--apply: a drain still in flight holds closeDatabase back", async () => {
    const order: string[] = [];
    const deps = orderDeps(order, 1);
    let release!: () => void;
    deps.drainKbWrites.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    const run = withArgv(["--apply"], () => main(deps));
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(deps.closeDatabase).not.toHaveBeenCalled();
    release();
    expect(await run).toBe(0);
    expect(order.at(-1)).toBe("close");
  });
});

describe("rewriteDenuePsql", () => {
  it("swaps role and quotes on a backticked psql line; the gate accepts the result", () => {
    const r = rewriteDenuePsql(DIRECTIVE);
    expect(r).toMatchObject({ roleSwaps: 1, quoteSwaps: 1, refused: [] });
    expect(r.content.split("\n")[4]).toBe(`\`${NEW_CMD}\``);
    expect(r.changes).toEqual([{ line: 5, before: [`\`${OLD_CMD}\``], after: `\`${NEW_CMD}\`` }]);
    expect(gateCheck(r.content)).toEqual([]);
    expect(validateShellCommand(OLD_CMD).allowed).toBe(false);
    expect(validateShellCommand(NEW_CMD).allowed).toBe(true);
  });

  it("refuses a span holding a single quote but still swaps the role", () => {
    const r = rewriteDenuePsql(`intro\ndocker exec supabase-db psql -U postgres -d postgres -c "SELECT 'x'"`);
    expect(r).toMatchObject({ roleSwaps: 1, quoteSwaps: 0 });
    expect(r.refused).toHaveLength(1);
    expect(r.refused[0]!.line).toBe(2);
    expect(r.refused[0]!.reason).not.toContain("SELECT");
    expect(r.content.split("\n")[1]).toContain(`-U mcp_readonly -d postgres -c "SELECT 'x'"`);
  });

  it("refuses a span holding a $", () => {
    const r = rewriteDenuePsql('docker exec supabase-db psql -U postgres -d postgres -c "SELECT $x"');
    expect(r.quoteSwaps).toBe(0);
    expect(r.refused).toEqual([{ line: 1, reason: expect.stringContaining("$") }]);
  });

  it("never touches lines without psql", () => {
    const text = 'bash -c "echo $HOME"\nConnect with -U postgres only from the console.';
    expect(rewriteDenuePsql(text)).toEqual(clean(text));
  });

  it("is idempotent", () => {
    const once = rewriteDenuePsql(DIRECTIVE).content;
    expect(rewriteDenuePsql(once)).toEqual(clean(once));
  });

  it("does not swap a role that only starts with postgres", () => {
    const r = rewriteDenuePsql('psql -U postgres_admin -d postgres -c "SELECT 1"');
    expect(r.roleSwaps).toBe(0);
    expect(r.content).toContain("-U postgres_admin");
    expect(r.content).not.toContain("mcp_readonly");
  });

  it("leaves a pg_dump -U postgres on a psql line untouched", () => {
    const line = 'pg_dump -U postgres -d src -c "x" | docker exec supabase-db psql -U postgres -d postgres -c "SELECT 1"';
    const r = rewriteDenuePsql(line);
    expect(r).toMatchObject({ roleSwaps: 1, quoteSwaps: 1, refused: [] });
    expect(r.content).toBe(
      "pg_dump -U postgres -d src -c \"x\" | docker exec supabase-db psql -U mcp_readonly -d postgres -c 'SELECT 1'",
    );
    const after = rewriteDenuePsql('psql -U postgres -c "SELECT 1" && pg_dump -U postgres -c "y"');
    expect(after).toMatchObject({ roleSwaps: 1, quoteSwaps: 1, refused: [] });
    expect(after.content).toBe("psql -U mcp_readonly -c 'SELECT 1' && pg_dump -U postgres -c \"y\"");
  });

  it("leaves a bash -c span before psql on the same line untouched", () => {
    const r = rewriteDenuePsql('bash -c "echo hi" && docker exec supabase-db psql -U postgres -d postgres -c "SELECT 1"');
    expect(r.content).toBe(
      "bash -c \"echo hi\" && docker exec supabase-db psql -U mcp_readonly -d postgres -c 'SELECT 1'",
    );
  });

  it("swaps -U postgres in a non-leading position; the gate accepts it", () => {
    const r = rewriteDenuePsql('`docker exec supabase-db psql -d postgres -U postgres -c "SELECT 1"`');
    expect(r).toMatchObject({ roleSwaps: 1, quoteSwaps: 1, refused: [] });
    expect(r.content).toBe("`docker exec supabase-db psql -d postgres -U mcp_readonly -c 'SELECT 1'`");
    expect(gateCheck(r.content)).toEqual([]);
  });

  it("refuses a psql command still running as postgres", () => {
    const r = rewriteDenuePsql('docker exec supabase-db psql --username=postgres -d postgres -c "SELECT 1"');
    expect(r.refused).toEqual([{ line: 1, reason: "psql still runs as postgres" }]);
  });

  it("joins a ` \\` continuation into one line the gate allows", () => {
    const text = 'intro\ndocker exec supabase-db psql -U postgres -d postgres -c "SELECT 1" \\\n    -A -t\nafter';
    const r = rewriteDenuePsql(text);
    expect(r.content).toBe("intro\ndocker exec supabase-db psql -U mcp_readonly -d postgres -c 'SELECT 1' -A -t\nafter");
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]!.before).toHaveLength(2);
    expect(gateCheck(r.content)).toEqual([]);
  });
});

describe("rewriteDenuePsql — continuations and roles", () => {
  it("joins a run where psql sits on a later line", () => {
    const text = 'docker exec supabase-db \\\n  psql -U postgres -d postgres -c "SELECT 1"\nafter';
    const r = rewriteDenuePsql(text);
    expect(r).toMatchObject({ roleSwaps: 1, quoteSwaps: 1, refused: [] });
    expect(r.content).toBe("docker exec supabase-db psql -U mcp_readonly -d postgres -c 'SELECT 1'\nafter");
    expect(gateCheck(r.content)).toEqual([]);
  });

  it("leaves a backslash run without psql untouched", () => {
    const text = "make all \\\n  install";
    expect(rewriteDenuePsql(text)).toEqual(clean(text));
  });

  it("stops a continuation at a blank line and refuses the dangling backslash", () => {
    const text = 'docker exec supabase-db psql -U postgres -d postgres -c "SELECT 1" \\\n\nnext';
    const r = rewriteDenuePsql(text);
    expect(r.refused).toEqual([{ line: 1, reason: expect.stringContaining("blank line") }]);
    expect(r.content.split("\n")).toHaveLength(3);
    expect(r.content.split("\n")[1]).toBe("");
  });

  it("refuses a continuation that runs into a code fence and keeps the fence", () => {
    const text = `${OLD_CMD} \\\n\`\`\`\nafter`;
    const r = rewriteDenuePsql(text);
    expect(r.refused).toEqual([{ line: 1, reason: "line continuation runs into a code fence" }]);
    expect(r.content.split("\n").slice(1)).toEqual(["```", "after"]);
  });

  it("refuses a quoted postgres role", () => {
    for (const role of ["'postgres'", '"postgres"']) {
      const r = rewriteDenuePsql(`docker exec supabase-db psql -U ${role} -d postgres -c "SELECT 1"`);
      expect(r.refused).toEqual([{ line: 1, reason: "psql still runs as postgres" }]);
    }
    expect(rewriteDenuePsql("psql --username 'postgres' -d postgres").refused).toHaveLength(1);
  });
});

describe("gateCheck", () => {
  it("judges a trigger outside backticks on a line that also has a code span", () => {
    const bad = "Run docker exec supabase-db psql -U mcp_readonly -d postgres -c 'SELECT 1' -o /tmp/x then `ls`";
    expect(gateCheck(bad)).toEqual([{ line: 1, reason: expect.stringMatching(/ruling 5a/) }]);
  });

  it("judges a fenced command line with a trailing backticked comment", () => {
    const bad = "docker exec supabase-db psql -U mcp_readonly -d postgres -c 'SELECT 1' -o /tmp/x # see `note`";
    expect(gateCheck(bad)).toEqual([{ line: 1, reason: expect.stringMatching(/ruling 5a/) }]);
  });

  it("skips a placeholder span and an unrelated docker exec span", () => {
    expect(gateCheck('Shape: `docker exec ...psql ... -c "<query>"`')).toEqual([]);
    expect(gateCheck(`Not this: \`docker exec foo ls\`, this: \`${NEW_CMD}\``)).toEqual([]);
  });

  it("judges the whole command, not just up to the -c span", () => {
    const issues = gateCheck("x\n`docker exec supabase-db psql -U mcp_readonly -d postgres -c 'SELECT 1' -o /tmp/f`");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.line).toBe(2);
    expect(issues[0]!.reason).toMatch(/ruling 5a/);
  });

  it("judges lines whatever the role literal", () => {
    expect(gateCheck("docker exec supabase-db psql -U postgres -d postgres -c 'SELECT 1'")).toHaveLength(1);
    expect(gateCheck('docker exec supabase-db psql --command "SELECT 1" -U mcp_readonly')).toHaveLength(1);
  });

  it("excludes the closing backtick and trailing prose of a code span", () => {
    expect(gateCheck("- `docker exec supabase-db psql -U mcp_readonly -d postgres -c 'SELECT 1'` counts rows.")).toEqual([]);
  });
});

describe("runRewrite", () => {
  const PATHS = ["directives/syn-a.md", "directives/syn-b.md", "directives/syn-clean.md"];
  const OLD_STAMP = "2000-01-01 00:00:00";

  function seed(): void {
    upsertFile(PATHS[0]!, "Syn A", DIRECTIVE, ["x"], "conditional", 55, "when synthetic", ["directives/syn-b.md"]);
    upsertFile(PATHS[1]!, "Syn B", `${DIRECTIVE}\nAgain: ${OLD_CMD}`, ["x"], "conditional", 55, "when synthetic");
    upsertFile(PATHS[2]!, "Syn Clean", `Use \`${NEW_CMD}\``, ["x"], "conditional", 55, "when synthetic");
    getDatabase().prepare("UPDATE jarvis_files SET updated_at = ?, user_edit_time = ?").run(OLD_STAMP, OLD_STAMP);
  }
  const untouched = (paths: string[]) => {
    for (const p of paths) expect(getFile(p)!.updated_at).toBe(OLD_STAMP);
  };

  it("rewrites through the registry, keeps metadata, mirrors to disk, then has nothing to do", () => {
    seed();
    const before = PATHS.map((p) => getFile(p)!);
    const run = runRewrite({ apply: true, paths: PATHS });
    expect(run.ok).toBe(true);
    expect(run.results.map((r) => r.status)).toEqual(["rewritten", "rewritten", "nothing-to-do"]);
    expect(run.written).toBe(2); // main drains only when this is > 0
    expect(run.results[1]).toMatchObject({ roleSwaps: 2, quoteSwaps: 2 });
    PATHS.forEach((p, i) => {
      const row = getFile(p)!;
      const was = before[i]!;
      expect(row).toMatchObject({
        title: was.title,
        tags: was.tags,
        qualifier: "conditional",
        priority: 55,
        condition: "when synthetic",
        related_to: was.related_to,
        user_edit_time: OLD_STAMP,
      });
      if (i < 2) {
        expect(row.updated_at).not.toBe(OLD_STAMP);
        expect(row.content).not.toContain("-U postgres");
        expect(readFileSync(join(kbDir, p), "utf-8")).toBe(row.content);
        expect(gateCheck(row.content)).toEqual([]);
      } else expect(row.updated_at).toBe(OLD_STAMP);
    });
    const again = runRewrite({ apply: true, paths: PATHS });
    expect(again.ok).toBe(true);
    expect(again.results.map((r) => r.status)).toEqual(["nothing-to-do", "nothing-to-do", "nothing-to-do"]);
    expect(again.written).toBe(0);
  });

  it("dry run writes nothing", () => {
    seed();
    expect(runRewrite({ apply: false, paths: PATHS }).ok).toBe(true);
    expect(getFile(PATHS[0]!)!.content).toBe(DIRECTIVE);
    untouched(PATHS);
  });

  it("reports a missing path, and writes none of the others", () => {
    seed();
    const run = runRewrite({ apply: true, paths: [...PATHS, "directives/syn-missing.md"] });
    expect(run.ok).toBe(false);
    expect(run.results[3]).toEqual({ path: "directives/syn-missing.md", status: "missing", roleSwaps: 0, quoteSwaps: 0 });
    expect(getFile("directives/syn-missing.md")).toBeNull();
    expect(existsSync(join(kbDir, "directives/syn-missing.md"))).toBe(false);
    untouched(PATHS);
  });

  it("two-pass: one refused path means the other two are not written", () => {
    seed();
    const text = `docker exec supabase-db psql -U postgres -d postgres -c "SELECT 'x'"`;
    upsertFile(PATHS[2]!, "Q", text, ["x"], "conditional", 55, "when synthetic");
    getDatabase().prepare("UPDATE jarvis_files SET updated_at = ?").run(OLD_STAMP);
    const run = runRewrite({ apply: true, paths: PATHS });
    expect(run.ok).toBe(false);
    expect(run.results.map((r) => r.status)).toEqual(["rewritten", "rewritten", "refused"]);
    expect(run.written).toBe(0);
    expect(getFile(PATHS[0]!)!.content).toBe(DIRECTIVE);
    expect(getFile(PATHS[2]!)!.content).toBe(text);
    untouched(PATHS);
  });

  it("gate-refused: a flag after the span blocks the run and writes nothing", () => {
    seed();
    const text = '`docker exec supabase-db psql -U postgres -d postgres -c "SELECT 1" -o /tmp/f`';
    upsertFile(PATHS[2]!, "G", text, ["x"], "conditional", 55, "when synthetic");
    getDatabase().prepare("UPDATE jarvis_files SET updated_at = ?").run(OLD_STAMP);
    const run = runRewrite({ apply: true, paths: PATHS });
    expect(run.ok).toBe(false);
    expect(run.results[2]).toMatchObject({ status: "gate-refused", roleSwaps: 1, quoteSwaps: 1 });
    expect(getFile(PATHS[2]!)!.content).toBe(text);
    untouched(PATHS);
  });

  it("a placeholder line and an unrelated span beside the real command do not block the rewrite", () => {
    const text = [
      'Shape: `docker exec ...psql ... -c "<query>"`',
      `Check \`docker exec foo ls\` then run \`${OLD_CMD}\``,
    ].join("\n");
    upsertFile("directives/syn-p.md", "P", text, ["x"], "conditional", 55, "when synthetic");
    const run = runRewrite({ apply: true, paths: ["directives/syn-p.md"] });
    expect(run.ok).toBe(true);
    expect(run.results[0]!.status).toBe("rewritten");
    const row = getFile("directives/syn-p.md")!.content;
    expect(row.split("\n")[1]).toBe(`Check \`docker exec foo ls\` then run \`${NEW_CMD}\``);
  });

  it("a continuation into a code fence is refused and the row stays unchanged", () => {
    const text = ["```", `${OLD_CMD} \\`, "```"].join("\n");
    upsertFile("directives/syn-f.md", "F", text, ["x"], "conditional", 55, "when synthetic");
    const run = runRewrite({ apply: true, paths: ["directives/syn-f.md"] });
    expect(run.results[0]!.status).toBe("refused");
    expect(getFile("directives/syn-f.md")!.content).toBe(text);
  });

  it("a trigger outside backticks with -o is gate-refused and nothing is written", () => {
    const text = `Run ${OLD_CMD} -o /tmp/x, then \`ls\``;
    upsertFile("directives/syn-o.md", "O", text, ["x"], "conditional", 55, "when synthetic");
    const run = runRewrite({ apply: true, paths: ["directives/syn-o.md"] });
    expect(run.results[0]!.status).toBe("gate-refused");
    expect(getFile("directives/syn-o.md")!.content).toBe(text);
  });

  it("a continuation join with zero swaps is still a rewrite", () => {
    const text = `${NEW_CMD} \\\n  -A -t`;
    upsertFile("directives/syn-j.md", "J", text, ["x"], "conditional", 55, "when synthetic");
    const run = runRewrite({ apply: true, paths: ["directives/syn-j.md"] });
    expect(run.results[0]).toMatchObject({ status: "rewritten", roleSwaps: 0, quoteSwaps: 0 });
    expect(getFile("directives/syn-j.md")!.content).toBe(`${NEW_CMD} -A -t`);
  });

  it("reports a gate refusal by its ORIGINAL line number", () => {
    const text = ["# t", `${OLD_CMD} \\`, "  -A", "", "`docker exec supabase-db psql -U mcp_readonly -d postgres -o /tmp/f`"].join("\n");
    upsertFile("directives/syn-n.md", "N", text, ["x"], "conditional", 55, "when synthetic");
    const run = runRewrite({ apply: true, paths: ["directives/syn-n.md"] });
    expect(run.results[0]!.status).toBe("gate-refused");
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^ {2}directives\/syn-n\.md:5 .*ruling 5a/));
    expect(getFile("directives/syn-n.md")!.content).toBe(text);
  });

  it("verify-failed when the mirror does not hold the new content", () => {
    seed();
    const other = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "mc-kbrewrite-other-"));
    ctl.mirrorDir = other;
    try {
      const run = runRewrite({ apply: true, paths: [PATHS[0]!] });
      expect(run.ok).toBe(false);
      expect(run.results[0]!.status).toBe("verify-failed");
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("mirror differs"));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("verify-failed when the row does not hold the new content", () => {
    seed();
    ctl.corruptRow = true;
    const run = runRewrite({ apply: true, paths: [PATHS[0]!] });
    expect(run.ok).toBe(false);
    expect(run.results[0]!.status).toBe("verify-failed");
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("row differs"));
  });

  it("verify-failed with no mirror for this db, and nothing written", () => {
    seed();
    ctl.mirrorDir = null;
    const run = runRewrite({ apply: true, paths: PATHS });
    expect(run.ok).toBe(false);
    expect(run.results.map((r) => r.status)).toEqual(["verify-failed", "verify-failed", "nothing-to-do"]);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("no mirror for this db"));
    untouched(PATHS);
  });
});
