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

// Ruling 3c, audit round 7 (B-1): the KB readers scrub the WHOLE content
// before any cut (preview, outline, LIKE snippet), and a LIKE hit that lies
// only inside a stored value is not a hit (no substring oracle).
describe("audit R7 B-1 — KB readers scrub before the cut", () => {
  const PASS = "pw-" + "Q7z".repeat(6); // synthetic, runtime-assembled
  async function storeSecret() {
    const { invalidateSecretRefs } = await import("../../lib/secret-refs.js");
    getDatabase()
      .prepare("INSERT INTO user_facts (category, key, value) VALUES (?, ?, ?)")
      .run("projects", "acme_ftp_password", PASS);
    invalidateSecretRefs();
  }

  it("jarvis_file_read: a value at the preview edge leaks no prefix (preview, outline, slice)", async () => {
    await storeSecret();
    const body =
      "a".repeat(1500 - (PASS.length - 1)) + PASS + "\n" +
      "- [12:00:00] **J**: " + "k".repeat(60 - (PASS.length - 1)) + PASS + "\n" +
      "b".repeat(9000);
    upsertFile("projects/x/env.md", "Env", body);
    const read = JSON.parse((await jarvisFileReadTool.execute({ path: "projects/x/env.md" })) as string);
    expect(read.truncated).toBe(true);
    expect(JSON.stringify(read)).not.toContain(PASS.slice(0, 4));
    const slice = JSON.parse(
      (await jarvisFileReadTool.execute({ path: "projects/x/env.md", lines: "1-2" })) as string,
    );
    expect(slice.content).toContain("[oculto · ");
    expect(slice.content).not.toContain(PASS.slice(0, 4));
  });

  it("jarvis_file_search (LIKE fallback): a hit only inside a stored value is not reported", async () => {
    await storeSecret();
    upsertFile("projects/x/creds.md", "Creds", `FTP_PASSWORD=${PASS}\n`);
    const probe = (await jarvisFileSearchTool.execute({ query: "SSWORD=" + PASS.slice(0, 6) })) as string;
    expect(probe).toMatch(/^No files found/);
    // FTS5 prefix match over the value's own tokens is not a hit either.
    const fts = (await jarvisFileSearchTool.execute({ query: PASS.slice(3, 8) })) as string;
    expect(fts).toMatch(/^No files found/);
    // A hit in visible text still reports, with a scrubbed snippet.
    const ok = (await jarvisFileSearchTool.execute({ query: "FTP_PASSWORD=" })) as string;
    expect(ok).toContain("projects/x/creds.md");
    expect(ok).not.toContain(PASS.slice(0, 4));
  });
});
