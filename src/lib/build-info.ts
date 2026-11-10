/**
 * Names the build this process runs, for one boot log line. The record is
 * dist/build-info.json, written by scripts/build-info.sh during a deploy; a
 * build made another way (manual `npm run build`, `tsx` in dev) may have no
 * record or a stale one, so absence and garbage are reported, never thrown.
 */

import { readFileSync } from "node:fs";

/** Pure: one-line description of a build-info.json body (null = file absent). */
export function describeBuildInfo(raw: string | null): string {
  if (raw === null) return "no build-info.json (not built by the deploy)";
  let info: unknown;
  try {
    info = JSON.parse(raw);
  } catch {
    return "build-info.json unreadable";
  }
  if (typeof info !== "object" || info === null) return "build-info.json unreadable";
  const b = info as Record<string, unknown>;
  const commit = typeof b.commitShort === "string" ? b.commitShort : typeof b.commit === "string" ? b.commit.slice(0, 8) : "";
  if (!commit) return "build-info.json has no commit";
  const branch = typeof b.branch === "string" ? ` (${b.branch})` : "";
  const builtAt = typeof b.builtAt === "string" ? ` built ${b.builtAt}` : "";
  const dirty =
    b.dirty === true
      ? ` +dirty (${Array.isArray(b.dirtyFiles) ? b.dirtyFiles.length : "?"} file(s))`
      : "";
  return `${commit}${dirty}${branch}${builtAt}`;
}

/** Reads the record next to the running entry point; never throws. */
export function readBuildInfo(url: URL): string {
  let raw: string | null;
  try {
    raw = readFileSync(url, "utf8");
  } catch {
    raw = null;
  }
  return describeBuildInfo(raw);
}
