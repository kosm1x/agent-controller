/**
 * The check on a caller-given output file, shared by diagram_generate,
 * infographic_generate and file_convert so a fix reaches all three.
 * Each tool supplies its own default path for a missing output.
 */

import { resolve } from "node:path";
import { realResolve } from "./write-guard.js";

const OUTPUT_ALLOW_PREFIXES = ["/tmp/", "/workspace/"];

/** Must be UNDER an allowed folder: the bare folder is not a file to write
 *  (writing to it fails with EISDIR). */
function isUnderOutputPrefix(abs: string): boolean {
  return OUTPUT_ALLOW_PREFIXES.some((p) => abs.startsWith(p));
}

export function checkOutputPath(
  output: string | undefined,
  defaultPath: string,
): { ok: true; abs: string } | { ok: false; error: string } {
  if (!output) {
    return { ok: true, abs: defaultPath };
  }
  if (!output.startsWith("/")) {
    return { ok: false, error: "output_path must be absolute" };
  }
  const abs = resolve(output);
  if (abs !== output) {
    return { ok: false, error: "output_path must be canonical" };
  }
  if (!isUnderOutputPrefix(abs)) {
    return {
      ok: false,
      error: `output_path must be under one of: ${OUTPUT_ALLOW_PREFIXES.join(", ")}`,
    };
  }
  // The spelling can pass while a symlink under an allowed folder sends the
  // write elsewhere.
  if (!isUnderOutputPrefix(realResolve(abs))) {
    return { ok: false, error: "output_path resolves outside the allow-list" };
  }
  return { ok: true, abs };
}
