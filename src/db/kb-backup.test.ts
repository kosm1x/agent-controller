import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";

// syncKbToRemote reads jarvis_files via these — mock them so the backup logic
// is exercisable without a live DB. vi.hoisted per project testing convention.
const { mockListFiles, mockGetFile } = vi.hoisted(() => ({
  mockListFiles: vi.fn(),
  mockGetFile: vi.fn(),
}));
vi.mock("./jarvis-fs.js", () => ({
  listFiles: mockListFiles,
  getFile: mockGetFile,
}));

import { stripNulBytes, syncKbToRemote } from "./kb-backup.js";

// Regression coverage for the 2026-06-09→11 nightly kb-backup failure: a single
// jarvis_files row stored with SQLite storage-class BLOB hydrated as a Buffer
// (no .replace), and the old `(s ?? "").replace()` threw, aborting the entire
// backup. stripNulBytes must coerce ANY storage class better-sqlite3 can return
// (string / Buffer / number / null / undefined) before stripping NULs.
describe("stripNulBytes", () => {
  const NUL = String.fromCharCode(0);

  it("strips NUL bytes from a plain string", () => {
    expect(stripNulBytes(`a${NUL}b${NUL}c`)).toBe("abc");
  });

  it("returns empty string for null / undefined (the original guard)", () => {
    expect(stripNulBytes(null)).toBe("");
    expect(stripNulBytes(undefined)).toBe("");
  });

  it("utf8-decodes a Buffer instead of throwing — the prod regression", () => {
    // better-sqlite3 returns a BLOB column as a Buffer; .replace does not exist
    // on Buffer, which is exactly what aborted the nightly backup.
    const buf = Buffer.from(`héllo${NUL}world`, "utf8");
    expect(stripNulBytes(buf)).toBe("hélloworld");
  });

  it("coerces a numeric column value to its string form", () => {
    expect(stripNulBytes(123)).toBe("123");
  });

  it("preserves multibyte content losslessly when no NUL is present", () => {
    expect(stripNulBytes("café ☕ 日本語")).toBe("café ☕ 日本語");
  });

  it("strips a NUL embedded inside a Buffer's multibyte content", () => {
    const buf = Buffer.from(`日本${NUL}語`, "utf8");
    expect(stripNulBytes(buf)).toBe("日本語");
  });

  it("returns empty string for an empty Buffer", () => {
    expect(stripNulBytes(Buffer.alloc(0))).toBe("");
  });

  it("decodes invalid UTF-8 to U+FFFD rather than throwing (accepted lossy edge)", () => {
    // A genuinely-binary BLOB is mangled to replacement chars — acceptable for
    // a TEXT KB backup (PostgREST would reject raw bytes anyway). Pinned so the
    // lossy behavior is intentional, not accidental.
    expect(stripNulBytes(Buffer.from([0x80]))).toBe("�");
  });
});

describe("syncKbToRemote — per-row blast-radius containment", () => {
  const OLD_KEY = process.env.COMMIT_DB_KEY;
  let fetchSpy: MockInstance;

  function row(path: string, tags: string[] = []) {
    return {
      path,
      title: `t-${path}`,
      tags,
      qualifier: "default",
      priority: 5,
      updated_at: "2026-06-11T00:00:00Z",
    };
  }

  beforeEach(() => {
    process.env.COMMIT_DB_KEY = "test-key";
    mockListFiles.mockReset();
    mockGetFile.mockReset();
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
  });

  afterEach(() => {
    if (OLD_KEY === undefined) delete process.env.COMMIT_DB_KEY;
    else process.env.COMMIT_DB_KEY = OLD_KEY;
    vi.restoreAllMocks();
  });

  function pushedPaths(): string[] {
    return fetchSpy.mock.calls.flatMap((call) => {
      const body = JSON.parse(
        (call[1] as RequestInit).body as string,
      ) as Array<{
        path: string;
      }>;
      return body.map((r) => r.path);
    });
  }

  it("backs up a BLOB-content row (Buffer) instead of aborting — the actual regression", async () => {
    mockListFiles.mockReturnValue([row("blob/x.md")]);
    mockGetFile.mockReturnValue({
      path: "blob/x.md",
      title: "x",
      // BLOB column hydrates as a Buffer (the row that broke the backup).
      content: Buffer.from(`héllo${String.fromCharCode(0)}world`, "utf8"),
      tags: [],
      qualifier: "default",
      priority: 5,
      updated_at: "2026-06-11T00:00:00Z",
    });

    const result = await syncKbToRemote();

    expect(result.errors).toBe(0);
    expect(result.pushed).toBe(1);
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
    ) as Array<{ content: string }>;
    expect(body[0].content).toBe("hélloworld"); // utf8-decoded + NUL stripped
  });

  it("skips a row whose getFile throws, counts it, and still pushes the healthy rows", async () => {
    mockListFiles.mockReturnValue([
      row("good/1.md"),
      row("bad/2.md"),
      row("good/3.md"),
    ]);
    mockGetFile.mockImplementation((path: string) => {
      if (path === "bad/2.md") throw new Error("simulated corrupt row");
      return {
        path,
        title: "x",
        content: "body",
        tags: [],
        qualifier: "default",
        priority: 5,
        updated_at: "2026-06-11T00:00:00Z",
      };
    });

    const result = await syncKbToRemote();

    expect(result.errors).toBe(1); // bad row counted, not fatal
    expect(result.pushed).toBe(2); // the two healthy rows survived
    expect(pushedPaths().sort()).toEqual(["good/1.md", "good/3.md"]);
  });

  it("skips files that vanished between listing and read (getFile null)", async () => {
    mockListFiles.mockReturnValue([row("gone.md"), row("here.md")]);
    mockGetFile.mockImplementation((path: string) =>
      path === "gone.md"
        ? null
        : {
            path,
            title: "x",
            content: "body",
            tags: [],
            qualifier: "default",
            priority: 5,
            updated_at: "2026-06-11T00:00:00Z",
          },
    );

    const result = await syncKbToRemote();

    expect(result.pushed).toBe(1);
    expect(pushedPaths()).toEqual(["here.md"]);
  });

  it("no-ops cleanly when COMMIT_DB_KEY is unset (no fetch)", async () => {
    delete process.env.COMMIT_DB_KEY;
    const result = await syncKbToRemote();
    expect(result).toMatchObject({ pushed: 0, errors: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
