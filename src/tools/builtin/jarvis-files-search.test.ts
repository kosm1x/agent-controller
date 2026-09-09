import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase, closeDatabase, getDatabase } from "../../db/index.js";
import { upsertFile } from "../../db/jarvis-fs.js";
import { jarvisFileSearchTool, jarvisFileReadTool } from "./jarvis-files.js";

let kbDir: string;
beforeEach(() => {
  kbDir = mkdtempSync(join(tmpdir(), "mc-jfs-search-"));
  process.env.JARVIS_KB_MIRROR_DIR = kbDir;
  initDatabase(":memory:");
});
afterEach(() => {
  closeDatabase();
  rmSync(kbDir, { recursive: true, force: true });
  delete process.env.JARVIS_KB_MIRROR_DIR;
});

describe("jarvis_file_search — cited line + section in the envelope (paper plan A.2)", () => {
  it("prints L<line> · § <heading> · a ready lines= range (clamped to 1) after the path", async () => {
    upsertFile(
      "projects/x/README.md",
      "X",
      "# X\n\n## Deploy\n\nRun the deploy script after build.\n",
    );
    // "deploy" (no dot) takes the FTS5 path; "deploy.sh" tokenizes to
    // "deploysh" and would silently exercise the LIKE fallback instead.
    const out = await jarvisFileSearchTool.execute({ query: "deploy" });
    expect(out).toMatch(
      /\[projects\/x\/README\.md\] \(\d+ bytes\) — L3 · § Deploy · lines='1-43'/,
    );
  });

  it("omits the citation when only the title matched", async () => {
    upsertFile("projects/y/README.md", "zebra title", "body text only");
    const out = await jarvisFileSearchTool.execute({ query: "zebra" });
    expect(out).toContain("[projects/y/README.md]");
    expect(out).not.toContain("— L");
  });
});

describe("jarvis_file_read — BLOB content row (task 9493: `content.split is not a function`)", () => {
  it("reads a Buffer-backed row, whole and by line range, without throwing", async () => {
    upsertFile("projects/z/proto.md", "Proto", "# Proto\n\nuno\ndos\ntres\n");
    getDatabase()
      .prepare("UPDATE jarvis_files SET content = ? WHERE path = ?")
      .run(Buffer.from("# Proto\n\nuno\ndos\ntres\n", "utf8"), "projects/z/proto.md");
    const whole = await jarvisFileReadTool.execute({ path: "projects/z/proto.md" });
    expect(whole).toContain("tres");
    expect(whole).not.toMatch(/error/i);
    const slice = await jarvisFileReadTool.execute({ path: "projects/z/proto.md", lines: "3-4" });
    expect(slice).toContain("uno");
    expect(slice).toContain("dos");
    expect(slice).not.toContain("tres");
  });
});
