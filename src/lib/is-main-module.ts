/**
 * True only when the calling module is the process entry point (never when a
 * test imports it). Pass `import.meta.url`. `npx tsx scripts/<name>` without
 * the extension (or as `<name>.js` for a `.ts` file) runs the file with an
 * argv[1] that is not its path: that spelling is refused LOUDLY (one stderr
 * line, exit code 2) instead of a silent exit 0.
 */

import { realpathSync } from "node:fs";
import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";

function real(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

export function isMainModule(importMetaUrl: string): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  const self = real(fileURLToPath(importMetaUrl));
  if (self === null) return false;
  if (real(arg) === self) return true;
  const spellings = [".ts", ".js", ".mjs"].map((ext) => arg + ext);
  if (arg.endsWith(".js")) spellings.push(`${arg.slice(0, -3)}.ts`);
  if (spellings.some((p) => real(p) === self)) {
    const file = basename(self);
    console.error(`[${basename(file, extname(file))}] entry skipped: run it as scripts/${file} (argv[1] was ${basename(arg)})`);
    process.exitCode = 2;
  }
  return false;
}
