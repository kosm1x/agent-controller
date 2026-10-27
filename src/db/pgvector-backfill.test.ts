/**
 * Queue 4y(i): the pgvector backfill entry. Every side effect is mocked: no
 * SQLite file, no pgvector, no embeddings; /proc/self/cgroup is faked so the
 * REAL operator gate (src/lib/operator-gate.ts) decides.
 */

import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  cgroup: "",
  initDatabase: vi.fn(),
  getDatabase: vi.fn(() => ({ prepare: () => ({ all: () => [] }) })),
  pgBatchUpsert: vi.fn(async () => ({ success: 0, failed: 0, rejected: 0 })),
  generateEmbeddings: vi.fn(async () => []),
}));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((p: unknown, ...rest: unknown[]) =>
    p === "/proc/self/cgroup" ? m.cgroup : (fs.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)) as typeof fs.readFileSync;
  return { ...fs, default: { ...fs, readFileSync }, readFileSync };
});
vi.mock("./index.js", () => ({ initDatabase: m.initDatabase, getDatabase: m.getDatabase }));
vi.mock("./pgvector.js", () => ({
  pgBatchUpsert: m.pgBatchUpsert,
  contentHash: () => "h",
  coerceKbQualifier: (q: string) => q,
}));
vi.mock("./pgvector-sync.js", () => ({ qualifierToSalience: () => 0.5 }));
vi.mock("../inference/embeddings.js", () => ({ generateEmbeddings: m.generateEmbeddings }));

const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), "../.."));
const MODULE = join(ROOT, "src/db/pgvector-backfill");

describe("pgvector-backfill entry (queue 4y(i))", () => {
  let argv1: string | undefined;
  let exitCode: typeof process.exitCode;

  beforeEach(() => {
    argv1 = process.argv[1];
    exitCode = process.exitCode;
    vi.spyOn(process, "cwd").mockReturnValue(ROOT);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
    vi.resetModules();
  });

  afterEach(() => {
    process.argv[1] = argv1 as string;
    process.exitCode = exitCode;
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("`npx tsx src/db/pgvector-backfill` (no extension) → no run, one stderr line naming src/db/…, exit code 2", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    m.cgroup = "0::/user.slice/user-0.slice/session-1.scope\n"; // gate would pass: only the entry check stops it
    process.argv[1] = MODULE;
    await import("./pgvector-backfill.js");
    expect(err.mock.calls).toEqual([
      ["[pgvector-backfill] entry skipped: run it as src/db/pgvector-backfill.ts (argv[1] was pgvector-backfill)"],
    ]);
    expect(process.exitCode).toBe(2);
    expect(m.initDatabase).not.toHaveBeenCalled();
  });

  it("imported by another entry point → no run, no output, exit code untouched", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await import("./pgvector-backfill.js");
    expect(err).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(exitCode);
    expect(m.initDatabase).not.toHaveBeenCalled();
  });

  it.each([
    ["a task (mission-control.service)", "0::/system.slice/mission-control.service\n", "running inside mission-control.service (a task)"],
    ["no login session", "0::/system.slice/some-other.service\n", "not an operator login session or operator unit"],
  ])("main refuses in %s: exit 2 before initDatabase or any pgvector write", async (_n, cgroup, reason) => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    m.cgroup = cgroup;
    const { main } = await import("./pgvector-backfill.js");
    await expect(main()).rejects.toThrow("exit 2");
    expect(err.mock.calls).toEqual([[`[pgvector-backfill] ${reason}; this script is not callable from a task`]]);
    expect(m.initDatabase).not.toHaveBeenCalled();
    expect(m.getDatabase).not.toHaveBeenCalled();
    expect(m.pgBatchUpsert).not.toHaveBeenCalled();
  });

  it("main in an operator login session passes the gate and runs (mocked db, nothing written)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    m.cgroup = "0::/user.slice/user-0.slice/session-1.scope\n";
    const { main } = await import("./pgvector-backfill.js");
    await expect(main()).rejects.toThrow("exit 0");
    expect(m.initDatabase).toHaveBeenCalledOnce();
    expect(m.getDatabase).toHaveBeenCalledOnce();
  });
});
