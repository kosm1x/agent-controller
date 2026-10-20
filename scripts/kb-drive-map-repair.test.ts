/**
 * Operator script: map an existing Drive file to an unmapped KB path.
 * Real in-memory db + scratch KB mirror; googleFetch and the live-db predicate are
 * mocked (no Drive API call, no live db). Synthetic fixtures only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const drive = vi.hoisted(() => {
  // drive-sync reads the KB folder id at import time.
  process.env.DRIVE_KB_FOLDER_ID = "kb-root-test";
  return {
    googleFetch: vi.fn(),
    isLive: true,
    folders: {} as Record<string, string>,
    files: [] as Array<{ id: string; name: string; createdTime: string }>,
  };
});
vi.mock("../src/google/client.js", () => ({ googleFetch: drive.googleFetch }));
vi.mock("../src/db/live-db.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/db/live-db.js")>();
  return { ...real, isLiveDatabaseFile: vi.fn(() => drive.isLive) };
});
/** Seams: recordDriveId silently writes nothing (read-back check); Drive sync reported off. */
const ctl = vi.hoisted(() => ({ dropRecord: false, driveOff: false }));
vi.mock("../src/db/drive-sync.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/db/drive-sync.js")>();
  return {
    ...real,
    isDriveSyncEnabled: () => !ctl.driveOff && real.isDriveSyncEnabled(),
    recordDriveId: (...args: Parameters<typeof real.recordDriveId>) => {
      if (!ctl.dropRecord) real.recordDriveId(...args);
    },
  };
});
/** Main must never run on import: the operator gate is the first thing main calls, so it throws here. */
const gate = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../src/lib/operator-gate.js", () => ({
  requireOperatorContext: () => {
    gate.calls++;
    throw new Error("kb-drive-map-repair main ran on import");
  },
}));

import { closeDatabase, getDatabase, initDatabase } from "../src/db/index.js";
import { upsertFile } from "../src/db/jarvis-fs.js";
import { getDriveMapEntry, recordDriveId, settleDriveSyncs } from "../src/db/drive-sync.js";
import { isMainModule, main, parseArgs, runRepair } from "./kb-drive-map-repair.js";

const P = "directives/syn-card.md";
let kbDir: string;
const prevMirror = process.env.JARVIS_KB_MIRROR_DIR;
const lines = () => (console.log as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => c[0]!);
const mapRows = () =>
  (getDatabase().prepare("SELECT 1 FROM sqlite_master WHERE name = 'drive_file_map'").get()
    ? getDatabase().prepare("SELECT path FROM drive_file_map").all()
    : []) as Array<{ path: string }>;

/** Fake Drive: folder search by (name, parent) in `drive.folders`; file search returns `drive.files`. */
function fakeDrive(url: string, init?: unknown): Promise<unknown> {
  if (init !== undefined) throw new Error(`write call to Drive: ${url}`);
  const q = decodeURIComponent(url);
  if (q.includes("mimeType='application/vnd.google-apps.folder'")) {
    const m = /name='([^']*)' and '([^']*)' in parents/.exec(q)!;
    const id = drive.folders[`${m[2]}/${m[1]}`];
    return Promise.resolve({ files: id ? [{ id }] : [] });
  }
  return Promise.resolve({ files: drive.files });
}

beforeEach(async () => {
  kbDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "mc-kbdrivemap-test-"));
  process.env.JARVIS_KB_MIRROR_DIR = kbDir;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  drive.isLive = false; // seeding: no Drive writes from upsertFile
  drive.googleFetch.mockReset();
  drive.googleFetch.mockImplementation(fakeDrive);
  initDatabase(":memory:");
  upsertFile(P, "Syn card", "synthetic body\n", ["x"], "conditional", 55, "when synthetic", []);
  await settleDriveSyncs();
  drive.googleFetch.mockClear();
  drive.isLive = true;
  Object.assign(ctl, { dropRecord: false, driveOff: false });
  drive.folders = { "kb-root-test/directives": "fold-directives" };
  drive.files = [{ id: "file-1", name: "syn-card.md", createdTime: "2026-10-20T00:27:01.000Z" }];
});

afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
  rmSync(kbDir, { recursive: true, force: true });
  if (prevMirror === undefined) delete process.env.JARVIS_KB_MIRROR_DIR;
  else process.env.JARVIS_KB_MIRROR_DIR = prevMirror;
});

describe("runRepair refusals", () => {
  it("refuses a path with no jarvis_files row, without calling Drive", async () => {
    expect((await runRepair({ path: "directives/none.md", apply: true })).ok).toBe(false);
    expect(lines()).toContain("FAIL directives/none.md no registry row in jarvis_files");
    expect(drive.googleFetch).not.toHaveBeenCalled();
    expect(mapRows()).toEqual([]);
  });

  it("refuses a path already mapped and prints only its updated_at", async () => {
    recordDriveId(P, "secret-existing-id");
    expect((await runRepair({ path: P, apply: true })).ok).toBe(false);
    const out = lines().join("\n");
    expect(out).toMatch(/^FAIL directives\/syn-card\.md already in drive_file_map \(updated_at=\d{4}-\d{2}-\d{2} [\d:]+\)$/m);
    expect(out).not.toContain("secret-existing-id");
    expect(drive.googleFetch).not.toHaveBeenCalled();
    expect(getDriveMapEntry(P)?.driveId).toBe("secret-existing-id");
  });

  it("refuses when the open db is not the live one", async () => {
    drive.isLive = false;
    expect((await runRepair({ path: P, apply: true })).ok).toBe(false);
    expect(lines().at(-1)).toMatch(/^FAIL directives\/syn-card\.md open db is not the live /);
    expect(drive.googleFetch).not.toHaveBeenCalled();
    expect(mapRows()).toEqual([]);
  });

  it("refuses when Drive sync is not enabled", async () => {
    ctl.driveOff = true;
    expect((await runRepair({ path: P, apply: true })).ok).toBe(false);
    expect(lines()).toContain(`FAIL ${P} Drive sync not enabled (DRIVE_KB_FOLDER_ID unset)`);
    expect(drive.googleFetch).not.toHaveBeenCalled();
  });
});

describe("runRepair candidates", () => {
  it("dry run, 1 candidate: prints it and what --apply would do, writes nothing", async () => {
    expect((await runRepair({ path: P, apply: false })).ok).toBe(true);
    expect(lines()).toEqual(
      expect.arrayContaining([
        "  candidates=1",
        "  candidate id=file-1 createdTime=2026-10-20T00:27:01.000Z",
        `PASS ${P} --apply would map it to id=file-1 (dry run)`,
      ]),
    );
    expect(mapRows()).toEqual([]);
    const fileQuery = decodeURIComponent(String(drive.googleFetch.mock.calls.at(-1)![0]));
    expect(fileQuery).toContain(
      "name='syn-card.md' and 'fold-directives' in parents and mimeType='text/markdown' and trashed=false",
    );
    expect(fileQuery).toContain("fields=files(id,name,createdTime)");
  });

  it("--apply, 1 candidate: writes the map row and verifies it", async () => {
    expect((await runRepair({ path: P, apply: true })).ok).toBe(true);
    expect(getDriveMapEntry(P)?.driveId).toBe("file-1");
    expect(lines()).toContain(`PASS ${P} mapped to id=file-1`);
  });

  it("--apply fails when the map row does not read back", async () => {
    ctl.dropRecord = true;
    expect((await runRepair({ path: P, apply: true })).ok).toBe(false);
    expect(lines().at(-1)).toBe(`FAIL ${P} (map row differs after write)`);
  });

  it("0 candidates: says so, writes nothing, never uploads", async () => {
    drive.files = [];
    expect((await runRepair({ path: P, apply: true })).ok).toBe(false);
    expect(lines()).toContain("  candidates=0");
    expect(lines().at(-1)).toMatch(/^FAIL directives\/syn-card\.md no Drive file to map; nothing written/);
    expect(lines().at(-1)).toContain("mimeType='text/markdown' and trashed=false");
    expect(mapRows()).toEqual([]);
  });

  it("missing parent folder: 0 candidates, no folder is created", async () => {
    drive.folders = {};
    expect((await runRepair({ path: P, apply: true })).ok).toBe(false);
    expect(lines()).toEqual(expect.arrayContaining(['  folder "directives" not found on Drive', "  candidates=0"]));
    expect(drive.googleFetch).toHaveBeenCalledTimes(1); // the folder search only
    expect(mapRows()).toEqual([]);
  });

  it("2 candidates: prints both ids + createdTimes and stops, even with --apply", async () => {
    drive.files.push({ id: "file-2", name: "syn-card.md", createdTime: "2026-10-20T00:40:00.000Z" });
    expect((await runRepair({ path: P, apply: true })).ok).toBe(false);
    expect(lines()).toEqual(
      expect.arrayContaining([
        "  candidates=2",
        "  candidate id=file-1 createdTime=2026-10-20T00:27:01.000Z",
        "  candidate id=file-2 createdTime=2026-10-20T00:40:00.000Z",
      ]),
    );
    expect(lines().at(-1)).toMatch(/2 Drive files match; nothing written/);
    expect(mapRows()).toEqual([]);
  });

  it("a top-level path searches the KB root folder; quotes in the name are escaped", async () => {
    upsertFile("it's.md", "Q", "q\n", [], "reference", 50, null, []);
    await settleDriveSyncs();
    drive.googleFetch.mockClear();
    expect((await runRepair({ path: "it's.md", apply: false })).ok).toBe(true);
    expect(drive.googleFetch).toHaveBeenCalledTimes(1);
    expect(decodeURIComponent(String(drive.googleFetch.mock.calls[0]![0]))).toContain(
      "name='it\\'s.md' and 'kb-root-test' in parents",
    );
  });

  it("a Drive error fails without writing", async () => {
    drive.googleFetch.mockRejectedValue(new Error("401 unauthorized"));
    expect((await runRepair({ path: P, apply: true })).ok).toBe(false);
    expect(lines().at(-1)).toBe(`FAIL ${P} Drive search failed: 401 unauthorized`);
    expect(mapRows()).toEqual([]);
  });

  it("every Drive call is a read (no method/body)", async () => {
    await runRepair({ path: P, apply: true });
    expect(drive.googleFetch.mock.calls.length).toBeGreaterThan(0);
    for (const call of drive.googleFetch.mock.calls) expect(call[1]).toBeUndefined();
  });
});

describe("module entry", () => {
  it("does not run main when imported", () => {
    expect(isMainModule()).toBe(false);
    expect(gate.calls).toBe(0);
  });

  it("parses --path once and --apply, refuses anything else", () => {
    expect(parseArgs(["--path", P, "--apply"])).toEqual({ path: P, apply: true });
    expect(parseArgs(["--path", P])).toEqual({ path: P, apply: false });
    expect(parseArgs([])).toHaveProperty("error");
    expect(parseArgs(["--path"])).toHaveProperty("error");
    expect(parseArgs(["--path", "--apply"])).toHaveProperty("error");
    expect(parseArgs(["--path", P, "--path", P])).toHaveProperty("error");
    expect(parseArgs(["--bogus"])).toHaveProperty("error");
  });

  const orderDeps = (order: string[], ok = true) => ({
    requireOperatorContext: vi.fn(() => void order.push("gate")),
    initDatabase: vi.fn(() => void order.push("init")),
    closeDatabase: vi.fn(() => void order.push("close")),
    runRepair: vi.fn(async () => {
      order.push("run");
      return { ok };
    }),
  });

  it("main: gate, then args, then db; exit code follows runRepair", async () => {
    const order: string[] = [];
    const deps = orderDeps(order);
    expect(await main(["--path", P], deps)).toBe(0);
    expect(order).toEqual(["gate", "init", "run", "close"]);
    expect(deps.runRepair).toHaveBeenCalledWith({ path: P, apply: false });
    expect(await main(["--path", P, "--apply"], orderDeps([], false))).toBe(1);
    const bad = orderDeps([]);
    expect(await main(["--bogus"], bad)).toBe(1);
    expect(bad.initDatabase).not.toHaveBeenCalled();
    deps.requireOperatorContext.mockImplementation(() => {
      throw new Error("refused");
    });
    deps.initDatabase.mockClear();
    await expect(main(["--path", P], deps)).rejects.toThrow("refused");
    expect(deps.initDatabase).not.toHaveBeenCalled();
  });

  it("main closes the db even when runRepair throws", async () => {
    const deps = orderDeps([]);
    deps.runRepair.mockRejectedValue(new Error("boom"));
    await expect(main(["--path", P], deps)).rejects.toThrow("boom");
    expect(deps.closeDatabase).toHaveBeenCalledOnce();
  });
});
