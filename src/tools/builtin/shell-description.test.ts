import { describe, it, expect, vi } from "vitest";

// This file only reads the tool's strings. Every child_process entry point,
// under both specifiers, is replaced for the whole file by a stub that
// throws, so nothing here can start a program. No handler and no guard
// function is called.
const stubbed = vi.hoisted(() => (real: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(real))
    out[k] =
      typeof v === "function"
        ? vi.fn(() => {
            throw new Error(`child_process ${k} is a stub in this file`);
          })
        : v;
  out.default = out;
  return out;
});
vi.mock("child_process", async (importOriginal) =>
  stubbed(await importOriginal<Record<string, unknown>>()),
);
vi.mock("node:child_process", async (importOriginal) =>
  stubbed(await importOriginal<Record<string, unknown>>()),
);

import * as childProcess from "child_process";
import * as nodeChildProcess from "node:child_process";
import { shellTool } from "./shell.js";

const DESCRIPTION = `Execute a shell command and return its output. Use for running system queries, scripts, or CLI tools.

USE WHEN:
- Running build commands and scoped tests (npx tsc, python scripts, npx vitest run <path/to/file.test.ts>); an unscoped test run (npm test, a bare npx vitest run) is refused
- System queries (ls, df, cat, which, dpkg)
- Project-specific CLI tools

DO NOT USE for:
- Git operations → use git_status, git_commit, git_push instead
- Reading files → use file_read instead
- Writing KB files → use jarvis_file_write instead
- Modifying /root/claude/mission-control/ → BLOCKED (your own source)

RESTRICTIONS:
- Destructive commands blocked (rm, mkfs, dd, kill, shutdown, systemctl)
- File writes restricted to project dirs (/root/claude/, /tmp/, /workspace/)
- System directories blocked (/etc, /boot, /usr, /proc, /sys, /dev)
- Timeout: 60s max for general commands; 5 min max for database commands
  (psql, pg_dump/restore, mysql/mysqldump; via docker only \`docker exec supabase-db psql …\`), since
  TRUNCATE/COPY/migrations on large tables run long. Max 10,000 chars output.`;

describe("shell_exec — description text", () => {
  it("every child_process entry point is a throwing stub in this file", () => {
    const names = ["exec", "execFile", "execSync", "execFileSync", "spawn", "spawnSync", "fork"] as const;
    for (const mod of [childProcess, nodeChildProcess])
      for (const name of names) {
        expect(vi.isMockFunction(mod[name])).toBe(true);
        expect(() => (mod[name] as () => unknown)()).toThrow(/is a stub/);
      }
  });

  it("every function export of both specifiers is a mock (checked without calling one)", () => {
    for (const mod of [childProcess, nodeChildProcess]) {
      const fns = Object.entries(mod).filter(([, v]) => typeof v === "function");
      expect(fns.length).toBeGreaterThan(0);
      for (const [name, fn] of fns) expect(vi.isMockFunction(fn), name).toBe(true);
    }
  });

  it("the whole description, with the scoped-test build line", () => {
    expect(shellTool.definition.function.description).toBe(DESCRIPTION);
  });

  it("each parameter text", () => {
    const params = shellTool.definition.function.parameters as {
      properties: Record<string, { description: string }>;
      required: string[];
    };
    expect(Object.keys(params.properties)).toEqual(["command", "timeout_ms"]);
    expect(params.properties.command.description).toBe(
      "The shell command to execute",
    );
    expect(params.properties.timeout_ms.description).toBe(
      "Timeout in milliseconds. General commands: default 30000, max 60000. Database commands (psql/pg_dump/pg_restore/mysql/mysqldump, incl. `docker exec supabase-db psql`): default 120000, max 300000 — set this higher for a long TRUNCATE/COPY/migration on big tables.",
    );
    expect(params.required).toEqual(["command"]);
  });
});
