/**
 * file_delete against the real filesystem (file.test.ts mocks node:fs).
 */

import { describe, it, expect } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { fileDeleteTool } from "./file.js";

// audit 2026-09-22: file_delete checked the unresolved path, so a symlinked
// parent under /tmp/ could delete a file outside every allowed prefix.
describe("file_delete — symlinked parent", () => {
  it("checks the allow-list against the resolved parent", async () => {
    const outside = mkdtempSync("/var/tmp/fd-out-");
    const inside = mkdtempSync("/tmp/fd-in-");
    try {
      writeFileSync(`${outside}/victim.txt`, "x");
      symlinkSync(outside, `${inside}/lnk`);
      const r = JSON.parse(
        await fileDeleteTool.execute({ path: `${inside}/lnk/victim.txt` }),
      );
      expect(String(r.error)).toMatch(/outside allowed paths/);
      expect(existsSync(`${outside}/victim.txt`)).toBe(true);
      // R2 C2: `lnk/..` is the parent of the link's TARGET, not of the link.
      mkdirSync(`${outside}/deep`);
      symlinkSync(`${outside}/deep`, `${inside}/deep`);
      const up = JSON.parse(
        await fileDeleteTool.execute({ path: `${inside}/deep/../victim.txt` }),
      );
      expect(String(up.error)).toMatch(/outside allowed paths/);
      expect(existsSync(`${outside}/victim.txt`)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(inside, { recursive: true, force: true });
    }
  });
});
