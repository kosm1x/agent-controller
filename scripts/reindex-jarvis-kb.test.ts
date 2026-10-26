/**
 * Operator script: reindex jarvis_files from the disk mirror.
 * Every dependency is injected (no real db, no KB mirror, no Drive/pgvector).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReindexResult } from "../src/db/jarvis-reindex.js";

/** Main must never run on import: the operator gate is the first thing main calls, so it throws here. */
const gate = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../src/lib/operator-gate.js", () => ({
  requireOperatorContext: () => {
    gate.calls++;
    throw new Error("reindex-jarvis-kb main ran on import");
  },
}));

import { isMainModule, main, runReindex, type ReindexDeps } from "./reindex-jarvis-kb.js";

const result = (upserted: number, refreshed: number): ReindexResult => ({
  fsCount: 3,
  dbCount: 2,
  drift: 1,
  upserted,
  refreshed,
  errored: 0,
  durationMs: 7,
} as ReindexResult);

function fakeDeps(order: string[], r: ReindexResult = result(0, 0)) {
  const lines: string[] = [];
  const deps = {
    initDatabase: vi.fn(() => void order.push("init")),
    closeDatabase: vi.fn(() => void order.push("close")),
    getDatabase: vi.fn(() => ({
      prepare: () => ({ all: () => [{ path: "knowledge/a.md" }] }),
    })),
    reindexJarvisKb: vi.fn(() => {
      order.push("reindex");
      return r;
    }),
    walkKbDir: vi.fn(() => {
      order.push("walk");
      return ["/kb/knowledge/a.md", "/kb/projects/x/b.md", "/kb/projects/y/c.md"];
    }),
    drainKbWrites: vi.fn(async (): Promise<void> => void order.push("drain")),
    log: vi.fn((line: string) => void lines.push(line)),
  } satisfies ReindexDeps;
  return { deps, lines };
}

const prevKb = process.env.JARVIS_KB_MIRROR_DIR;
const prevDb = process.env.MC_DB_PATH;
afterEach(() => {
  vi.restoreAllMocks();
  if (prevKb === undefined) delete process.env.JARVIS_KB_MIRROR_DIR;
  else process.env.JARVIS_KB_MIRROR_DIR = prevKb;
  if (prevDb === undefined) delete process.env.MC_DB_PATH;
  else process.env.MC_DB_PATH = prevDb;
});

describe("module entry", () => {
  it("does not run main when imported", () => {
    expect(isMainModule()).toBe(false);
    expect(gate.calls).toBe(0);
  });

  it("main runs the operator gate before any db access, and a refusal stops it", async () => {
    const order: string[] = [];
    const { deps } = fakeDeps(order);
    const requireOperatorContext = vi.fn(() => void order.push("gate"));
    await main([], { requireOperatorContext, reindex: deps });
    expect(requireOperatorContext).toHaveBeenCalledWith("reindex-jarvis-kb", { tty: false });
    expect(order[0]).toBe("gate");

    const refused = vi.fn(() => {
      throw new Error("refused");
    });
    deps.initDatabase.mockClear();
    await expect(main(["--apply"], { requireOperatorContext: refused, reindex: deps })).rejects.toThrow("refused");
    expect(deps.initDatabase).not.toHaveBeenCalled();
  });

  it("main: --apply selects apply, anything else is a dry run", async () => {
    const order: string[] = [];
    const { deps } = fakeDeps(order, result(1, 0));
    await main(["--apply"], { requireOperatorContext: vi.fn(), reindex: deps });
    expect(deps.reindexJarvisKb).toHaveBeenCalledOnce();
    deps.reindexJarvisKb.mockClear();
    await main(["--bogus"], { requireOperatorContext: vi.fn(), reindex: deps });
    expect(deps.reindexJarvisKb).not.toHaveBeenCalled();
    expect(deps.walkKbDir).toHaveBeenCalledOnce();
  });
});

describe("runReindex --apply drain gate", () => {
  it("upserted > 0: drains once, then closes the db", async () => {
    const order: string[] = [];
    const { deps } = fakeDeps(order, result(2, 0));
    await runReindex({ apply: true, deps });
    expect(deps.drainKbWrites).toHaveBeenCalledOnce();
    expect(order).toEqual(["init", "reindex", "drain", "close"]);
  });

  it("only refreshed > 0: drains once, then closes the db", async () => {
    const order: string[] = [];
    const { deps } = fakeDeps(order, result(0, 3));
    await runReindex({ apply: true, deps });
    expect(deps.drainKbWrites).toHaveBeenCalledOnce();
    expect(order).toEqual(["init", "reindex", "drain", "close"]);
  });

  it("upserted = refreshed = 0: no drain (no INDEX.md rewrite), db still closed", async () => {
    const order: string[] = [];
    const { deps } = fakeDeps(order, result(0, 0));
    await runReindex({ apply: true, deps });
    expect(deps.drainKbWrites).not.toHaveBeenCalled();
    expect(order).toEqual(["init", "reindex", "close"]);
  });

  it("a drain still in flight holds closeDatabase back", async () => {
    const order: string[] = [];
    const { deps } = fakeDeps(order, result(1, 0));
    let release!: () => void;
    deps.drainKbWrites.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    const run = runReindex({ apply: true, deps });
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(deps.closeDatabase).not.toHaveBeenCalled();
    release();
    await run;
    expect(order.at(-1)).toBe("close");
  });

  it("apply reads MC_DB_PATH / JARVIS_KB_MIRROR_DIR at call time and prints the APPLY line", async () => {
    process.env.MC_DB_PATH = "/scratch/x.db";
    process.env.JARVIS_KB_MIRROR_DIR = "/scratch/kb";
    const order: string[] = [];
    const { deps, lines } = fakeDeps(order, result(1, 2));
    await runReindex({ apply: true, deps });
    expect(deps.initDatabase).toHaveBeenCalledWith("/scratch/x.db");
    expect(deps.reindexJarvisKb).toHaveBeenCalledWith({ kbRoot: "/scratch/kb" });
    expect(lines).toEqual(["[reindex] FS=3 DB=2 drift=1 upserted=1 errored=0 (7ms) mode=APPLY"]);
  });
});

describe("runReindex dry run", () => {
  it("never drains or reindexes; prints the FS/DB counts and fs-only dirs, then closes", async () => {
    process.env.JARVIS_KB_MIRROR_DIR = "/kb";
    const order: string[] = [];
    const { deps, lines } = fakeDeps(order, result(5, 5));
    await runReindex({ apply: false, deps });
    expect(deps.drainKbWrites).not.toHaveBeenCalled();
    expect(deps.reindexJarvisKb).not.toHaveBeenCalled();
    expect(order).toEqual(["init", "walk", "close"]);
    expect(lines).toEqual([
      "[reindex] FS=3 DB=1 fs-only=2 mode=DRY-RUN",
      `  ${"projects".padEnd(15)} 2`,
      "\n[reindex] dry run — pass --apply to upsert",
    ]);
  });

  it("no drift: says so and never drains", async () => {
    process.env.JARVIS_KB_MIRROR_DIR = "/kb";
    const order: string[] = [];
    const { deps, lines } = fakeDeps(order);
    deps.walkKbDir.mockImplementation(() => ["/kb/knowledge/a.md"]);
    await runReindex({ apply: false, deps });
    expect(deps.drainKbWrites).not.toHaveBeenCalled();
    expect(lines).toEqual([
      "[reindex] FS=1 DB=1 fs-only=0 mode=DRY-RUN",
      "[reindex] no drift — DB and FS in sync",
    ]);
  });
});
