/**
 * `mc-ctl eval` entry point: args, the operator gate BEFORE any db open, the
 * read-only open mode, the db path default, the archive dir next to the db,
 * the labels doc default, exit codes, and no seeded free text in the printed
 * report. The db and labels file are synthetic fixtures under a scratch
 * tmpdir; the live db is never named to an opener.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NOTE, SECRET, buildEvalFixture, writeEvalArchive, writeEvalLabels } from "../src/test-utils/w3-eval-fixture.js";
import { DEFAULT_DAYS, defaultDeps, liveDaysSource, main, parseArgs, type MainDeps } from "./w3-eval-report.js";

let dir: string;
let dbPath: string;
let labelsPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "w3-eval-s-"));
  dbPath = buildEvalFixture(dir);
  writeEvalArchive(dir);
  labelsPath = writeEvalLabels(dir);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function deps(over: Partial<MainDeps> = {}): MainDeps & { printed: string[]; calls: string[]; opened: string[] } {
  const printed: string[] = [];
  const calls: string[] = [];
  const opened: string[] = [];
  return {
    printed,
    calls,
    opened,
    requireOperatorContext: vi.fn(() => void calls.push("gate")),
    openDb: vi.fn((p: string) => {
      calls.push("open");
      opened.push(p);
      return new Database(dbPath, { readonly: true, fileMustExist: true });
    }),
    now: () => new Date(),
    print: (s: string) => void printed.push(s),
    env: {},
    labelsPath,
    ...over,
  };
}

describe("parseArgs", () => {
  it("defaults to 90 days, markdown, no --db", () => {
    expect(DEFAULT_DAYS).toBe(90);
    expect(parseArgs([])).toEqual({ days: 90, json: false, db: null });
  });

  it("accepts mc-ctl's positional days, --days N, --days=N, --json, --db", () => {
    expect(parseArgs(["30", "--json"])).toEqual({ days: 30, json: true, db: null });
    expect(parseArgs(["--days", "200"])).toMatchObject({ days: 200 });
    expect(parseArgs(["--days=7", "--db", "/x/y.db"])).toEqual({ days: 7, json: false, db: "/x/y.db" });
  });

  it("refuses bad input", () => {
    for (const a of [["0"], ["-3"], ["abc"], ["--days"], ["30", "40"], ["--days", "1e3"], ["--db"], ["--db", "--json"], ["--write"]]) {
      expect(parseArgs(a), a.join(" ")).toHaveProperty("error");
    }
  });
});

describe("main", () => {
  it("runs the operator gate before the db opens", () => {
    const d = deps();
    expect(main(["--db", dbPath], d)).toBe(0);
    expect(d.calls).toEqual(["gate", "open"]);
    expect(d.requireOperatorContext).toHaveBeenCalledWith("w3-eval-report", { tty: false });
  });

  it("a refusing gate means no open (the real gate exits the process)", () => {
    const d = deps({
      requireOperatorContext: vi.fn(() => {
        throw new Error("refused");
      }),
    });
    expect(() => main(["--db", dbPath], d)).toThrow("refused");
    expect(d.openDb).not.toHaveBeenCalled();
  });

  it("bad args exit 1 without opening", () => {
    const d = deps();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(main(["--nope"], d)).toBe(1);
    expect(d.openDb).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("db path: --db, else MC_DB_PATH, else ./data/mc.db (the opener here is the fixture)", () => {
    const a = deps();
    main(["--db", "/scratch/a.db"], a);
    const b = deps({ env: { MC_DB_PATH: "/scratch/b.db" } });
    main([], b);
    const c = deps();
    main([], c);
    expect([a.opened, b.opened, c.opened]).toEqual([["/scratch/a.db"], ["/scratch/b.db"], ["./data/mc.db"]]);
  });

  it("prints markdown by default and JSON with --json; no seeded free text", () => {
    const md = deps();
    main(["--db", dbPath], md);
    expect(md.printed.join("")).toContain("# V9 W3 internal eval (read-only)");
    expect(md.printed.join("")).toContain("window: 90 d");
    const js = deps();
    main(["--db", dbPath, "--json"], js);
    const parsed = JSON.parse(js.printed.join("")) as { window: { days: number } };
    expect(parsed.window.days).toBe(90);
    for (const out of [md.printed.join(""), js.printed.join("")]) {
      expect(out).not.toContain(SECRET);
      expect(out).not.toContain(NOTE);
    }
    expect(md.printed.join("")).toContain(`operator W1 labels: ${labelsPath} — 5 labelled task ids`);
  });

  it("labels default to <repo>/docs/planning/v9-w1-labels.md; a missing labels file is reported, not fatal", () => {
    expect(defaultDeps.labelsPath).toBe(resolve(dirname(fileURLToPath(import.meta.url)), "..", "docs", "planning", "v9-w1-labels.md"));
    expect(existsSync(defaultDeps.labelsPath)).toBe(true);
    const d = deps({ labelsPath: join(dir, "absent.md") });
    expect(main(["--db", dbPath], d)).toBe(0);
    expect(d.printed.join("")).toContain("file not found at");
  });

  it("TASKS_RETENTION_DAYS moves the archive threshold", () => {
    const d = deps({ env: { TASKS_RETENTION_DAYS: "300" } });
    main(["200", "--db", dbPath], d);
    expect(d.printed.join("")).toContain("live retention 300 d (shell env), TASKS_RETENTION_DAYS); archive not read (window ≤ 300 d)");
  });

  it("reports where live retention came from (mc-ctl sets W3_LIVE_DAYS_SOURCE)", () => {
    expect(liveDaysSource({ W3_LIVE_DAYS_SOURCE: "service", TASKS_RETENTION_DAYS: "60" })).toBe("service env");
    expect(liveDaysSource({ W3_LIVE_DAYS_SOURCE: "default" })).toBe("default");
    expect(liveDaysSource({ TASKS_RETENTION_DAYS: "60" })).toBe("shell env");
    expect(liveDaysSource({})).toBe("default");
    const svc = deps({ env: { W3_LIVE_DAYS_SOURCE: "service", TASKS_RETENTION_DAYS: "60" } });
    main(["60", "--db", dbPath], svc);
    expect(svc.printed.join("")).toContain("live retention 60 d (service env), TASKS_RETENTION_DAYS); archive not read (window ≤ 60 d)");
    const svcLow = deps({ env: { W3_LIVE_DAYS_SOURCE: "service", TASKS_RETENTION_DAYS: "30" } });
    main(["60", "--db", dbPath], svcLow);
    expect(svcLow.printed.join("")).toContain("live retention 30 d (service env), TASKS_RETENTION_DAYS); archive read (window > 30 d)");
    const def = deps({ env: { W3_LIVE_DAYS_SOURCE: "default" } });
    main(["--db", dbPath], def);
    expect(def.printed.join("")).toContain("live retention 90 d (default), TASKS_RETENTION_DAYS)");
  });

  it("a missing db exits 3 with one stderr line and prints no report", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = deps({ openDb: defaultDeps.openDb });
    expect(main(["--db", join(dir, "missing.db")], d)).toBe(3);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]![0])).toMatch(/^\[w3-eval-report\] .*missing\.db: /);
    expect(d.printed).toEqual([]);
    err.mockRestore();
  });

  it("a query error exits 3", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = deps({
      openDb: () => {
        const bad = new Database(":memory:");
        bad.exec("CREATE TABLE tasks (task_id TEXT)"); // no metadata / status columns
        return bad;
      },
    });
    expect(main(["--db", dbPath], d)).toBe(3);
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it("past 90 d reads <db dir>/archive", () => {
    const d = deps();
    main(["200", "--db", dbPath], d);
    expect(d.printed.join("")).toContain(
      "archive read (window > 90 d): 2 files read, 1 skipped, 2 bad lines; 5 archived rows in window, 3 merged after dedupe by task_id",
    );
  });

  it("the default opener is read-only and refuses a missing file", () => {
    const db = defaultDeps.openDb(dbPath);
    try {
      expect(db.readonly).toBe(true);
      expect(() => db.prepare("DELETE FROM tasks").run()).toThrow(/readonly/);
    } finally {
      db.close();
    }
    expect(() => defaultDeps.openDb(join(dir, "missing.db"))).toThrow();
  });
});
