import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, relative, resolve } from "path";
import type { Server } from "net";
import { acquireSingleInstance } from "./single-instance.js";

// Fail-open injection: when set, listen() emits an error with this code.
const h = vi.hoisted(() => ({ failCode: null as string | null }));
vi.mock("net", async (importOriginal) => {
  const real = await importOriginal<typeof import("net")>();
  return {
    ...real,
    createServer: ((...args: Parameters<typeof real.createServer>) => {
      const server = real.createServer(...args);
      if (h.failCode) {
        const code = h.failCode;
        server.listen = (() => {
          process.nextTick(() =>
            server.emit("error", Object.assign(new Error(code), { code })),
          );
          return server;
        }) as typeof server.listen;
      }
      return server;
    }) as typeof real.createServer,
  };
});

const held: Server[] = [];
let seq = 0;
const tmpRoot = realpathSync(
  mkdtempSync(join(tmpdir(), "mc-single-instance-")),
);

/** A unique DB path per test — the file never needs to exist. */
function fakeDbPath(): string {
  return resolve(
    `/tmp/mc-single-instance-${process.pid}-${Date.now()}-${seq++}/mc.db`,
  );
}

/** A real directory plus a symlinked alias of it, unique per test. */
function realAndLinkDirs(): { real: string; link: string } {
  const real = join(tmpRoot, `real-${seq}`);
  const link = join(tmpRoot, `link-${seq++}`);
  mkdirSync(real);
  symlinkSync(real, link);
  return { real, link };
}

async function acquire(dbPath: string): Promise<Server> {
  const server = await acquireSingleInstance(dbPath);
  expect(server).not.toBeNull();
  held.push(server!);
  return server!;
}

function close(server: Server): Promise<void> {
  return new Promise((done) => server.close(() => done()));
}

afterEach(async () => {
  h.failCode = null;
  vi.restoreAllMocks();
  await Promise.all(held.splice(0).map(close));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("acquireSingleInstance", () => {
  it("rejects a second acquire of the same DB path", async () => {
    const dbPath = fakeDbPath();
    await acquire(dbPath);
    await expect(acquireSingleInstance(dbPath)).rejects.toThrow(
      `Another mission-control instance already holds database ${dbPath}`,
    );
  });

  it("lets a different DB path acquire while the first is held", async () => {
    await acquire(fakeDbPath());
    await acquire(fakeDbPath());
  });

  it("frees the path when the holder closes (no stale state)", async () => {
    const dbPath = fakeDbPath();
    const first = await acquireSingleInstance(dbPath);
    expect(first).not.toBeNull();
    await close(first!);
    await acquire(dbPath);
  });

  it("collides on relative and absolute spellings of the same path", async () => {
    const dbPath = fakeDbPath();
    await acquire(dbPath);
    await expect(
      acquireSingleInstance(relative(process.cwd(), dbPath)),
    ).rejects.toThrow("already holds database");
  });

  it("collides through a symlinked directory alias", async () => {
    const { real, link } = realAndLinkDirs();
    writeFileSync(join(real, "mc.db"), "");
    await acquire(join(real, "mc.db"));
    await expect(acquireSingleInstance(join(link, "mc.db"))).rejects.toThrow(
      `already holds database ${join(real, "mc.db")}`,
    );
  });

  it("collides through a symlinked file alias", async () => {
    const { real } = realAndLinkDirs();
    const file = join(real, "mc.db");
    const alias = join(real, "alias.db");
    writeFileSync(file, "");
    symlinkSync(file, alias);
    await acquire(file);
    await expect(acquireSingleInstance(alias)).rejects.toThrow(
      `already holds database ${file}`,
    );
  });

  it("maps a not-yet-created file under a symlinked dir to the real dir's key", async () => {
    const { real, link } = realAndLinkDirs();
    await acquire(join(link, "first-boot.db"));
    await expect(
      acquireSingleInstance(join(real, "first-boot.db")),
    ).rejects.toThrow(`already holds database ${join(real, "first-boot.db")}`);
  });

  it("fails open on a non-EADDRINUSE listen error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.failCode = "EAFNOSUPPORT";
    await expect(acquireSingleInstance(fakeDbPath())).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[boot] single-instance guard unavailable: EAFNOSUPPORT",
    );
  });
});

describe("src/index.ts boot order", () => {
  it("runs checkPort, then acquireSingleInstance, before the DB is opened or reconciled", () => {
    const src = readFileSync(resolve(__dirname, "../index.ts"), "utf8")
      // Strip comments so a commented-out call cannot satisfy the pin.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const start = src.indexOf("async function main(");
    const end = src.indexOf("\nmain().catch(");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const main = src.slice(start, end);
    const at = (needle: string): number => {
      const i = main.indexOf(needle);
      expect(i, needle).toBeGreaterThanOrEqual(0);
      return i;
    };
    const port = at("await checkPort(config.port)");
    const guard = at("await acquireSingleInstance(config.dbPath)");
    const db = at("initDatabase(");
    const reconcile = at("reconcileOrphanedTasks(");
    expect(port).toBeLessThan(guard);
    expect(guard).toBeLessThan(db);
    expect(db).toBeLessThan(reconcile);
  });
});

describe("src/index.ts stop sequence", () => {
  /** The stop closure's body, comments stripped. */
  function stopSequence(): string {
    const src = readFileSync(resolve(__dirname, "../index.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const start = src.indexOf("const shutdown = async () => {");
    const end = src.indexOf('process.on("SIGTERM", shutdown)');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  }

  it("starts no dynamic import it does not await (process.exit would win the race)", () => {
    const seq = stopSequence();
    const imports = [...seq.matchAll(/(\bawait\s+)?\bimport\(/g)];
    for (const m of imports) expect(m[1], m[0]).toBeDefined();
    expect(seq).not.toContain('import("./db/jarvis-index.js")');
  });

  it("cancels pending index regeneration before the database is closed", () => {
    const seq = stopSequence();
    const cancel = seq.indexOf("cancelPendingRegeneration(");
    const close = seq.indexOf("closeDatabase(");
    expect(cancel).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(cancel);
  });

  it("stops the triggers along with the other schedulers", () => {
    const seq = stopSequence();
    expect(seq).toContain("stopTriggers()");
    expect(seq.indexOf("stopTriggers()")).toBeLessThan(
      seq.indexOf("readShutdownGraceMs("),
    );
  });

  it("runs every stop call of the scheduler step through safeStop", () => {
    const seq = stopSequence();
    const from = seq.indexOf("httpServer.close();");
    const to = seq.indexOf('await import("./lib/s3/scheduler.js")');
    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThan(from);
    const step = seq.slice(from + "httpServer.close();".length, to);
    const wrapped = /safeStop\(\s*"[^"]+",\s*\(\)\s*=>\s*[\w.]+\(\)\s*,?\s*\);/g;
    const calls = step.match(wrapped) ?? [];
    expect(calls.length).toBe(6);
    const rest = step.replace(wrapped, "");
    expect(rest).not.toMatch(/\bstop\w*\s*\(/i);
  });

  it("runs the scheduler step's stop calls unconditionally", () => {
    const seq = stopSequence();
    const last = seq.lastIndexOf("safeStop(", seq.indexOf("readShutdownGraceMs("));
    const step = seq.slice(seq.indexOf("safeStop("), seq.indexOf(";", last) + 1);
    expect(step).toContain("stopTriggers()");
    expect(step).not.toMatch(/\bif\s*\(/);
    expect(step).not.toContain("?");
  });

  it("cancels index regeneration unconditionally, right before the close", () => {
    const seq = stopSequence();
    const cancel = seq.indexOf("cancelPendingRegeneration(");
    const tail = seq.slice(
      seq.lastIndexOf("}", cancel),
      seq.indexOf("closeDatabase("),
    );
    expect(tail).toContain("cancelPendingRegeneration(");
    expect(tail).not.toMatch(/\bif\s*\(/);
    expect(tail).not.toContain("?");
  });
});
