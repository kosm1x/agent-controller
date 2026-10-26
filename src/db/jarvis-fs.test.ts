import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Spy on the Drive hand-off only; everything else in drive-sync stays real
// (syncToDrive is a no-op here anyway: DRIVE_KB_FOLDER_ID is unset). The
// enabled flag drives jarvis-fs's own gate on the updated_at read.
const driveSync = vi.hoisted(() => ({
  syncToDrive: vi.fn(),
  syncDeleteToDrive: vi.fn(),
  syncMoveToDrive: vi.fn(),
  enabled: true,
}));
vi.mock("./drive-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./drive-sync.js")>()),
  syncToDrive: driveSync.syncToDrive,
  syncDeleteToDrive: driveSync.syncDeleteToDrive,
  syncMoveToDrive: driveSync.syncMoveToDrive,
  isDriveSyncEnabled: () => driveSync.enabled,
}));
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase, closeDatabase, getDatabase } from "./index.js";
import {
  upsertFile,
  searchFiles,
  locateMatch,
  getFile,
  getFilesByQualifier,
  appendToFile,
  updateMetadata,
  moveFile,
  deleteFile,
  syncDeleteFromKbMirror,
  listFiles,
  listFilePaths,
  getJarvisKbRoot,
  mirrorToDisk,
} from "./jarvis-fs.js";
import { existsSync, writeFileSync } from "node:fs";
import { invalidateSecretRefs, scrubSecrets } from "../lib/secret-refs.js";

let testKbDir: string;

beforeEach(() => {
  testKbDir = mkdtempSync(join(tmpdir(), "mc-jarvis-fs-test-"));
  process.env.JARVIS_KB_MIRROR_DIR = testKbDir;
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
  rmSync(testKbDir, { recursive: true, force: true });
  delete process.env.JARVIS_KB_MIRROR_DIR;
});

describe("getJarvisKbRoot — vitest never resolves to the live KB (2026-09-18)", () => {
  it("falls back to a throwaway dir when JARVIS_KB_MIRROR_DIR is unset under vitest", () => {
    delete process.env.JARVIS_KB_MIRROR_DIR;
    const root = getJarvisKbRoot();
    expect(root).not.toBe("/root/claude/jarvis-kb");
    expect(root.startsWith(tmpdir())).toBe(true);
    // vitest.global-setup.ts hands every worker the same run-scoped dir.
    if (process.env.JARVIS_KB_VITEST_FALLBACK) {
      expect(root).toBe(process.env.JARVIS_KB_VITEST_FALLBACK);
    }
    mirrorToDisk("logs/day-logs/1999-01-01.md", "# fake\n");
    expect(existsSync(join(root, "logs/day-logs/1999-01-01.md"))).toBe(true);
    expect(existsSync("/root/claude/jarvis-kb/logs/day-logs/1999-01-01.md")).toBe(
      false,
    );
    rmSync(join(root, "logs/day-logs/1999-01-01.md"), { force: true });
  });
});

describe("searchFiles — FTS5 tokenized search", () => {
  it("finds 'uncharted OOH' in title with em-dash separator (algebra-day incident 2026-05-07)", () => {
    // Real failure: searching "uncharted OOH" with the LIKE-substring impl
    // missed "México Uncharted — OOH Intelligence" because of the em-dash.
    upsertFile(
      "projects/data-intelligence/ooh/README.md",
      "México Uncharted — OOH Intelligence",
      "# México Uncharted — OOH Intelligence\n\nRepo: https://github.com/EurekaMD-net/mexico-uncharted-ooh\n\nOut-of-home advertising data layer.",
      ["ooh", "uncharted"],
    );
    const results = searchFiles("uncharted OOH", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe("projects/data-intelligence/ooh/README.md");
  });

  it("matches multiple tokens in any order (AND semantics)", () => {
    upsertFile(
      "knowledge/farmacia-scoring.md",
      "Farmacia Scoring Playbook",
      "Detailed playbook for scoring pharmacy locations using DENUE and demographic data.",
    );
    upsertFile(
      "knowledge/retail-scoring.md",
      "Retail Scoring Playbook",
      "Retail playbook unrelated to pharmacy.",
    );
    const a = searchFiles("playbook DENUE", 10);
    const b = searchFiles("DENUE playbook", 10);
    expect(a[0].path).toBe("knowledge/farmacia-scoring.md");
    expect(b[0].path).toBe("knowledge/farmacia-scoring.md");
  });

  it("is diacritic-insensitive (México matches mexico)", () => {
    upsertFile(
      "knowledge/mexico-uncharted.md",
      "México Uncharted",
      "México Uncharted — OOH program details",
    );
    const results = searchFiles("mexico uncharted", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe("knowledge/mexico-uncharted.md");
  });

  it("supports prefix matching (uncharted matches Uncharted_v2)", () => {
    upsertFile(
      "projects/uncharted-v2.md",
      "Uncharted_v2",
      "Next-generation uncharted_v2 data plane.",
    );
    const results = searchFiles("uncharted", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe("projects/uncharted-v2.md");
  });

  it("returns empty when no token matches", () => {
    upsertFile(
      "knowledge/foo.md",
      "Foo",
      "Bar baz qux content with no match for the search term.",
    );
    const results = searchFiles("zzznoexist", 10);
    expect(results).toEqual([]);
  });

  it("returns a snippet that highlights the match terms with «»", () => {
    upsertFile(
      "knowledge/snippet-test.md",
      "Snippet Test",
      "First paragraph mentions the keyword photometry briefly.\n\nSecond paragraph repeats photometry once more.",
    );
    const results = searchFiles("photometry", 10);
    expect(results.length).toBe(1);
    expect(results[0].snippet).toMatch(/«photometry»/i);
  });

  it("falls back to LIKE for short/punctuation-only queries", () => {
    upsertFile(
      "projects/x.md",
      "Title with X",
      "Short token x in content body.",
    );
    // "x" is below the 2-char minimum token length, so FTS5 path is skipped
    // and LIKE substring runs instead. Should still return at least the file.
    const results = searchFiles("x", 10);
    expect(results.length).toBeGreaterThan(0);
  });

  it("handles operator-style queries safely (parens, AND, OR are not interpreted)", () => {
    upsertFile(
      "knowledge/operators.md",
      "AND OR NOT",
      "Files containing AND, OR, NOT and parens (like this) work fine.",
    );
    // These tokens used to crash the unprotected FTS5 MATCH; we wrap each
    // token in double-quotes so they are literal.
    const results = searchFiles("(AND OR NOT)", 10);
    expect(results.length).toBeGreaterThan(0);
  });

  // 2026-05-12 orphan-resurrection incident — DB delete must clear FS mirror
  it("deleteFile() removes the FS mirror file (symmetric delete)", () => {
    upsertFile("knowledge/del-target.md", "Title", "body text");
    const fullPath = join(testKbDir, "knowledge/del-target.md");
    expect(existsSync(fullPath)).toBe(true);
    expect(deleteFile("knowledge/del-target.md")).toBe(true);
    expect(existsSync(fullPath)).toBe(false);
  });

  // qa-auditor C1 (2026-05-12): empty / "." / "/" must not wipe the mirror root
  it("syncDeleteFromKbMirror refuses to delete the mirror root itself", () => {
    // Seed a file so we can prove the root still exists after.
    upsertFile("knowledge/witness.md", "Witness", "still here");
    expect(existsSync(testKbDir)).toBe(true);
    for (const evil of ["", ".", "/", "//", "./"]) {
      syncDeleteFromKbMirror(evil);
    }
    expect(existsSync(testKbDir)).toBe(true);
    expect(existsSync(join(testKbDir, "knowledge/witness.md"))).toBe(true);
  });

  // Path-traversal guard: refuses to delete outside the mirror root
  it("syncDeleteFromKbMirror refuses path traversal attempts", () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "mc-fs-outside-"));
    const outsideFile = join(outsideDir, "victim.md");
    writeFileSync(outsideFile, "should survive", "utf-8");
    try {
      // Build a path that, if naively joined, would resolve outside testKbDir.
      syncDeleteFromKbMirror(`../${outsideDir.split("/").pop()}/victim.md`);
      expect(existsSync(outsideFile)).toBe(true);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  // Audit Rec 9 — FTS trigger contract regression
  it("AFTER UPDATE trigger: stale content stops matching after upsert", () => {
    upsertFile("knowledge/trigger-test.md", "Initial", "alpha bravo charlie");
    expect(searchFiles("bravo", 10).length).toBe(1);
    // Overwrite content — old tokens should disappear from the FTS index.
    upsertFile("knowledge/trigger-test.md", "Updated", "delta echo foxtrot");
    expect(searchFiles("bravo", 10)).toEqual([]);
    expect(searchFiles("foxtrot", 10).length).toBe(1);
  });
});

// 2026-06-09→11 kb-backup abort incident: an unguarded JSON.parse(tags) in
// listFiles threw on a single corrupt row (same binary/NUL-paste class that
// produced a BLOB-content row) and aborted EVERY caller, including the nightly
// backup. listFiles must degrade a corrupt-tags row to [] rather than throw.
describe("listFiles — corrupt tags resilience", () => {
  it("degrades a row with non-JSON tags to [] instead of aborting the whole listing", () => {
    upsertFile("knowledge/good.md", "Good", "body", ["a", "b"]);
    upsertFile("knowledge/bad.md", "Bad", "body", ["c"]);
    // Simulate the corruption directly: a row whose tags column is not valid
    // JSON (upsertFile always writes valid JSON, so we mutate post-write).
    getDatabase()
      .prepare("UPDATE jarvis_files SET tags = ? WHERE path = ?")
      .run("not-json{", "knowledge/bad.md");

    let files: ReturnType<typeof listFiles>;
    expect(() => {
      files = listFiles({});
    }).not.toThrow();

    const bad = files!.find((f) => f.path === "knowledge/bad.md");
    const good = files!.find((f) => f.path === "knowledge/good.md");
    expect(bad?.tags).toEqual([]); // corrupt → empty, not fatal
    expect(good?.tags).toEqual(["a", "b"]); // healthy row unaffected
  });

  it("a corrupt-tags row no longer blocks a tag-filtered query from returning healthy matches", () => {
    upsertFile("knowledge/match.md", "Match", "body", ["target"]);
    upsertFile("knowledge/corrupt.md", "Corrupt", "body", ["target"]);
    getDatabase()
      .prepare("UPDATE jarvis_files SET tags = ? WHERE path = ?")
      .run("\x01binary", "knowledge/corrupt.md");

    const filtered = listFiles({ tags: ["target"] });
    // logic audit F19: the prefix filter escapes `_`/`%` but had no ESCAPE
    // clause, so SQLite read the backslash literally and matched nothing.
    upsertFile("feedback_session/a.md", "A", "content a");
    upsertFile("feedbackXsession/b.md", "B", "content b");
    const byPrefix = listFiles({ prefix: "feedback_session/" });
    expect(byPrefix.map((f) => f.path)).toEqual(["feedback_session/a.md"]);
    // qa C1: a literal backslash in the query must stay literal under ESCAPE.
    upsertFile("notes/regex.md", "R", "the pattern \\d+ matches digits");
    expect(searchFiles("\\d+").map((r) => r.path)).toContain("notes/regex.md");
    expect(filtered.map((f) => f.path)).toContain("knowledge/match.md");
  });
});

// 2026-10-26: kb-backup's listFiles({}) ran length(content) over every row; on a
// cold page cache that one synchronous read blocked the event loop 8-12 s.
// listFilePaths must stay a covering scan of the path index (no content pages).
describe("listFilePaths — index-only path listing", () => {
  it("returns every path ascending via a covering index scan", () => {
    upsertFile("zeta/z.md", "Z", "body z", [], "reference", 1);
    upsertFile("alpha/a.md", "A", "body a", [], "reference", 90);
    upsertFile("mid/m.md", "M", "body m");

    // Capture the SQL listFilePaths actually runs, then plan THAT statement, so
    // adding length(content) (or any table column) to it fails here.
    const db = getDatabase();
    const prepareSpy = vi.spyOn(db, "prepare");
    const paths = listFilePaths();
    const sql = prepareSpy.mock.calls.at(-1)![0] as string;
    prepareSpy.mockRestore();

    // initDatabase seeds directive rows: assert the whole list is complete and
    // sorted, and that ours (priorities inverted vs path order, so ORDER BY
    // priority fails here) come back in path order.
    const ours = ["alpha/a.md", "mid/m.md", "zeta/z.md"];
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM jarvis_files").get() as {
      n: number;
    };
    expect(paths).toHaveLength(n);
    expect(paths).toEqual([...paths].sort());
    expect(paths.filter((p) => ours.includes(p))).toEqual(ours);

    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{
      detail: string;
    }>;
    expect(plan.some((r) => r.detail.includes("COVERING INDEX"))).toBe(true);
  });
});

describe("searchFiles — citation (line + section) per hit (paper plan A.2, 2026-09-09)", () => {
  it("locateMatch returns the first matching line and its nearest heading, diacritic-folded", () => {
    const content = [
      "# Título",
      "intro sin match",
      "## Sección Farmacias",
      "texto",
      "Las farmacias de Oaxaca crecieron.",
      "## Otra",
      "farmacias otra vez",
    ].join("\n");
    expect(locateMatch(content, ["farmacias"])).toEqual({ line: 3, section: "Sección Farmacias" });
    expect(locateMatch(content, ["oaxaca"])).toEqual({ line: 5, section: "Sección Farmacias" });
    // Query without accent still hits the accented body (FTS5 unicode61 parity).
    expect(locateMatch(content, ["seccion"])).toEqual({ line: 3, section: "Sección Farmacias" });
    expect(locateMatch(content, ["nomatch"])).toEqual({ line: null, section: null });
    expect(locateMatch(content, [])).toEqual({ line: null, section: null });
  });

  it("FTS path: hit carries line + section; title-only hit carries line=null", () => {
    upsertFile(
      "knowledge/denue.md",
      "DENUE notes",
      "# DENUE notes\n\nfiller\n\n## Densidad\n\nEl JOIN con censo_iter usa area_geo.\n",
    );
    upsertFile("knowledge/other.md", "censo_iter overview", "Body without the term.");
    const hits = searchFiles("censo_iter", 10);
    const denue = hits.find((h) => h.path === "knowledge/denue.md");
    const other = hits.find((h) => h.path === "knowledge/other.md");
    expect(denue).toMatchObject({ line: 7, section: "Densidad" });
    expect(other).toMatchObject({ line: null, section: null });
  });

  it("multi-token query cites the first line holding ALL tokens, not the first partial hit (audit W3)", () => {
    const content = "# Doc\n\ndocker kill on deploy\n\n## Firewall\n\nDocker published ports bypass UFW.\n";
    expect(locateMatch(content, ["docker", "ufw", "bypass"])).toEqual({ line: 7, section: "Firewall" });
    // No line has every token → first partial hit is still better than nothing.
    expect(locateMatch(content, ["docker", "zzz"])).toEqual({ line: 3, section: "Doc" });
  });

  it("BLOB content rows (2 live rows, audit C1) are coerced — the FTS result set is NOT muted", () => {
    upsertFile("knowledge/blob.md", "Blob row", "# Blob\n\nprotocolo de publicacion aqui\n");
    upsertFile("knowledge/text.md", "Text row", "protocolo normal\n");
    // Simulate the affinity gap: TEXT column holding a BLOB value.
    getDatabase()
      .prepare("UPDATE jarvis_files SET content = ? WHERE path = ?")
      .run(Buffer.from("# Blob\n\nprotocolo de publicacion aqui\n", "utf8"), "knowledge/blob.md");
    const hits = searchFiles("protocolo", 10);
    expect(hits.map((h) => h.path).sort()).toEqual(["knowledge/blob.md", "knowledge/text.md"]);
    expect(hits.find((h) => h.path === "knowledge/blob.md")).toMatchObject({ line: 3, section: "Blob" });
  });

  it("getFile / getFilesByQualifier / appendToFile coerce a BLOB content row to string (task 9493)", () => {
    upsertFile("directives/blobby.md", "Blobby", "# Blobby\n\nline two\n", [], "always-read");
    getDatabase()
      .prepare("UPDATE jarvis_files SET content = ? WHERE path = ?")
      .run(Buffer.from("# Blobby\n\nline two\n", "utf8"), "directives/blobby.md");
    expect(getFile("directives/nope.md")).toBeNull();
    expect(typeof getFile("directives/blobby.md")!.content).toBe("string");
    expect(getFile("directives/blobby.md")!.content).toContain("line two");
    const inj = getFilesByQualifier("always-read").find((f) => f.path === "directives/blobby.md")!;
    expect(typeof inj.content).toBe("string");
    expect(appendToFile("directives/blobby.md", "line three")).toBe(true);
    expect(getFile("directives/blobby.md")!.content).toMatch(/line two\n\n\nline three$/);
    // Write-side guard: a Buffer handed to upsertFile is stored as TEXT.
    upsertFile("directives/buf.md", "Buf", Buffer.from("# Buf\n", "utf8") as unknown as string);
    expect(getDatabase().prepare("SELECT typeof(content) t FROM jarvis_files WHERE path='directives/buf.md'").get()).toEqual({ t: "text" });
  });

  it("LIKE fallback path (single-char query) cites the substring hit", () => {
    upsertFile("knowledge/sym.md", "Symbols", "line one\n## Ops\n a & b\n");
    const hits = searchFiles("&", 10);
    expect(hits[0]).toMatchObject({ path: "knowledge/sym.md", line: 3, section: "Ops" });
  });
});

describe("searchFiles — stored-value limit-before-filter oracle (audit R8 B-3)", () => {
  // A row whose only query hit is inside a stored credential value is dropped
  // AFTER the SQL LIMIT would have been applied. Ruling 3c R8: fetch without a
  // visible SQL LIMIT, filter, then slice — so the dropped row never consumes
  // a visible slot (pre-fix, limit=1 returned "no files found").
  const SEC = "swordfish Ab12Cd34Ef56Gh78"; // secret-shaped, > 8 chars
  beforeEach(() => {
    getDatabase()
      .prepare("INSERT INTO user_facts (category,key,value) VALUES (?,?,?)")
      .run("projects", "acme_ftp_password", SEC);
    invalidateSecretRefs();
    // Value-holding row sorts first by path; its only "swordfish" is in SEC.
    upsertFile("a-secret.md", "Secret row", `cred: ${SEC}\n`);
    upsertFile("b-note.md", "Note", "swordfish recipe for dinner\n");
  });
  afterEach(() => invalidateSecretRefs());

  it("limit=1 still returns a real row; the dropped value row does not steal the slot", () => {
    const hits = searchFiles("swordfish", 1);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.path).toBe("b-note.md");
    expect(hits.some((h) => h.path === "a-secret.md")).toBe(false);
  });

  it("the value row never leaks the stored value in any field", () => {
    const hits = searchFiles("swordfish", 10);
    expect(hits.some((h) => h.path === "a-secret.md")).toBe(false);
    for (const h of hits) {
      expect(h.snippet).not.toContain("Ab12Cd34Ef56");
    }
  });
});

describe("searchFiles — value-holding rows (audit R9 should-fix 2/3)", () => {
  const SEC = "Zq9-" + "Wx7".repeat(4); // synthetic, secret-shaped
  beforeEach(() => {
    getDatabase()
      .prepare("INSERT INTO user_facts (category,key,value) VALUES (?,?,?)")
      .run("projects", "acme_ftp_password", SEC);
    invalidateSecretRefs();
    upsertFile("z-secret.md", "Deploy", `deploy deploy deploy\ncred: ${SEC}\n`);
    upsertFile("a-clean.md", "Notes", "deploy notes\n");
  });
  afterEach(() => invalidateSecretRefs());

  it("a value-holding row is ranked by its scrubbed score, not appended after clean rows", () => {
    const hits = searchFiles("deploy", 10).map((h) => h.path);
    expect(hits).toEqual(["z-secret.md", "a-clean.md"]);
  });

  it("a value-holding row reports its scrubbed size (FTS and LIKE paths)", () => {
    const raw = `deploy deploy deploy\ncred: ${SEC}\n`;
    const fts = searchFiles("deploy", 10).find((h) => h.path === "z-secret.md")!;
    expect(fts.size).toBe(scrubSecrets(raw).length);
    expect(fts.size).not.toBe(raw.length);
    const like = searchFiles(":", 10).find((h) => h.path === "z-secret.md")!;
    expect(like.size).toBe(scrubSecrets(raw).length);
  });
});

describe("getFilesByQualifier — tags for the external KB policy", () => {
  it("returns each row's stored tags (JSON array string)", () => {
    upsertFile("knowledge/shared.md", "Shared", "body", ["crm", "external"], "always-read");
    upsertFile("knowledge/private.md", "Private", "body", [], "always-read");
    const rows = getFilesByQualifier("always-read");
    const tagsOf = (p: string) => rows.find((r) => r.path === p)?.tags;
    expect(JSON.parse(tagsOf("knowledge/shared.md")!)).toEqual(["crm", "external"]);
    expect(JSON.parse(tagsOf("knowledge/private.md")!)).toEqual([]);
  });
});

describe("upsertFile — Drive hand-off carries the row's updated_at", () => {
  it("passes updatedAt in SQLite datetime shape, equal to the stored row", () => {
    driveSync.syncToDrive.mockClear();
    upsertFile("knowledge/drive/stamp.md", "Stamp", "x", ["t"], "reference", 50, null, [], {
      skipUserEdit: true,
    });
    const row = getDatabase()
      .prepare("SELECT updated_at FROM jarvis_files WHERE path = ?")
      .get("knowledge/drive/stamp.md") as { updated_at: string };
    expect(driveSync.syncToDrive).toHaveBeenCalledTimes(1);
    const [path, title, content, meta] = driveSync.syncToDrive.mock.calls[0];
    expect([path, title, content]).toEqual(["knowledge/drive/stamp.md", "Stamp", "x"]);
    expect(meta.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(meta.updatedAt).toBe(row.updated_at);
    expect(meta.tags).toEqual(["t"]);
  });

  it("skips the updated_at read when Drive sync is disabled", () => {
    driveSync.syncToDrive.mockClear();
    driveSync.enabled = false;
    try {
      upsertFile("knowledge/drive/off.md", "Off", "x");
    } finally {
      driveSync.enabled = true;
    }
    expect(driveSync.syncToDrive).toHaveBeenCalledTimes(1);
    expect(driveSync.syncToDrive.mock.calls[0][3].updatedAt).toBeUndefined();
  });
  it("appendToFile hands Drive the appended content and the row's metadata (queue 4a c)", () => {
    upsertFile("knowledge/drive/app.md", "App", "first", ["t"], "workspace", 20);
    driveSync.syncToDrive.mockClear();
    expect(appendToFile("knowledge/drive/app.md", "second")).toBe(true);
    expect(driveSync.syncToDrive).toHaveBeenCalledTimes(1);
    const [path, title, content, meta] = driveSync.syncToDrive.mock.calls[0];
    expect([path, title, content]).toEqual(["knowledge/drive/app.md", "App", "first\n\nsecond"]);
    expect(meta).toMatchObject({ tags: ["t"], qualifier: "workspace", priority: 20 });
    expect(meta.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("updateMetadata hands Drive the unchanged content with the NEW metadata (queue 4a c)", () => {
    upsertFile("knowledge/drive/meta.md", "Meta", "body", ["old"], "reference", 50, null, ["knowledge/x.md"]);
    driveSync.syncToDrive.mockClear();
    expect(updateMetadata("knowledge/drive/meta.md", { tags: ["new"], priority: 5 })).toBe(true);
    expect(driveSync.syncToDrive).toHaveBeenCalledTimes(1);
    const [path, title, content, meta] = driveSync.syncToDrive.mock.calls[0];
    expect([path, title, content]).toEqual(["knowledge/drive/meta.md", "Meta", "body"]);
    expect(meta).toMatchObject({ tags: ["new"], qualifier: "reference", priority: 5, relatedTo: ["knowledge/x.md"] });
  });

  it("updateMetadata with Drive sync off reads no row back and hands Drive nothing (queue 4a R1 W2)", () => {
    upsertFile("knowledge/drive/off-meta.md", "OffMeta", "body", ["a"]);
    driveSync.syncToDrive.mockClear();
    const db = getDatabase();
    const prepare = vi.spyOn(db, "prepare");
    driveSync.enabled = false;
    try {
      expect(updateMetadata("knowledge/drive/off-meta.md", { tags: ["b"] })).toBe(true);
    } finally {
      driveSync.enabled = true;
    }
    const sql = prepare.mock.calls.map((c) => String(c[0]));
    prepare.mockRestore();
    expect(sql.filter((q) => q.startsWith("SELECT *"))).toEqual([]);
    expect(sql).toHaveLength(2); // the existing-row SELECT and the UPDATE
    expect(driveSync.syncToDrive).not.toHaveBeenCalled();
  });

  it("moveFile onto its own path keeps the row and makes no Drive call (queue 4a R1 W1)", () => {
    upsertFile("knowledge/drive/self.md", "Self", "keep me");
    driveSync.syncToDrive.mockClear();
    driveSync.syncDeleteToDrive.mockClear();
    driveSync.syncMoveToDrive.mockClear();
    expect(moveFile("knowledge/drive/self.md", "knowledge/drive/self.md")).toBe(true);
    expect(getFile("knowledge/drive/self.md")?.content).toBe("keep me");
    expect(driveSync.syncToDrive).not.toHaveBeenCalled();
    expect(driveSync.syncDeleteToDrive).not.toHaveBeenCalled();
    expect(driveSync.syncMoveToDrive).not.toHaveBeenCalled();
  });

  it("moveFile onto its own path of a nonexistent file returns false, no Drive call (queue 4a R2)", () => {
    driveSync.syncToDrive.mockClear();
    driveSync.syncDeleteToDrive.mockClear();
    driveSync.syncMoveToDrive.mockClear();
    expect(moveFile("knowledge/drive/nope.md", "knowledge/drive/nope.md")).toBe(false);
    expect(driveSync.syncToDrive).not.toHaveBeenCalled();
    expect(driveSync.syncDeleteToDrive).not.toHaveBeenCalled();
    expect(driveSync.syncMoveToDrive).not.toHaveBeenCalled();
  });
});
