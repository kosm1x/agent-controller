/**
 * Lock test: no source or script text file under src/ or scripts/ may contain
 * a literal NUL byte. grep, diff and review tools classify such a file as
 * binary and skip or elide it, so its contents drop out of searches and
 * reviews without any warning. A NUL the code needs is written as an escape
 * (`\u0000`), which compiles to the same value.
 */
import { afterAll, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCAN_DIRS = ["src", "scripts"];
/** Text extensions present under src/ and scripts/; none of them is binary. */
const TEXT_EXTENSIONS = [
  ".ts",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".sh",
  ".json",
  ".md",
  ".sql",
  ".yml",
  ".yaml",
];

/** Text files under `dir`, skipping node_modules and symlinks. */
function textFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...textFiles(abs));
    else if (
      entry.isFile() &&
      TEXT_EXTENSIONS.some((ext) => entry.name.endsWith(ext))
    )
      out.push(abs);
  }
  return out;
}

/**
 * Scans `roots`; returns how many files were read in total and per root, and
 * which hold a 0x00 byte.
 */
export function scanForNulBytes(roots: string[]): {
  scanned: number;
  perRoot: Record<string, number>;
  offenders: string[];
} {
  const perRoot: Record<string, number> = {};
  const files: string[] = [];
  for (const root of roots) {
    const found = textFiles(root);
    perRoot[root] = found.length;
    files.push(...found);
  }
  return {
    scanned: files.length,
    perRoot,
    offenders: files.filter((f) => readFileSync(f).includes(0)),
  };
}

describe("source files carry no literal NUL byte", () => {
  it("no text file under src/ or scripts/ contains a 0x00 byte", () => {
    const { scanned, perRoot, offenders } = scanForNulBytes(
      SCAN_DIRS.map((d) => join(REPO, d)),
    );
    // Guards against a scan that silently reads nothing, or drops a root.
    expect(scanned).toBeGreaterThan(1000);
    for (const d of ["src", "scripts"]) {
      expect(perRoot[join(REPO, d)] ?? 0, `files scanned under ${d}/`).toBeGreaterThan(0);
    }
    expect(offenders.map((f) => relative(REPO, f))).toEqual([]);
  });

  describe("detector on a fixture tree", () => {
    const fixture = mkdtempSync(join(tmpdir(), "source-nul-bytes-"));
    afterAll(() => rmSync(fixture, { recursive: true, force: true }));

    it("reports a NUL-bearing text file and nothing else", () => {
      mkdirSync(join(fixture, "nested", "node_modules"), { recursive: true });
      writeFileSync(join(fixture, "clean.ts"), "export const a = 1;\n");
      writeFileSync(join(fixture, "nested", "dirty.sh"), "echo a\u0000b\n");
      // Out of scope: an unlisted extension, node_modules, and a symlink.
      writeFileSync(join(fixture, "blob.bin"), "a\u0000b");
      writeFileSync(join(fixture, "nested", "node_modules", "dep.js"), "\u0000");
      symlinkSync(join(fixture, "nested", "dirty.sh"), join(fixture, "link.sh"));

      const { scanned, offenders } = scanForNulBytes([fixture]);
      expect(scanned).toBe(2);
      expect(offenders.map((f) => relative(fixture, f))).toEqual([
        join("nested", "dirty.sh"),
      ]);
    });
  });
});
