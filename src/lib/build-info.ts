/**
 * Names the build this process runs, for one boot log line and for the
 * completion-facts row each task gets when it starts running. The record is
 * dist/build-info.json, written by scripts/build-info.sh during a deploy; a
 * build made another way (manual `npm run build`, `tsx` in dev) may have no
 * record or a stale one, so absence and garbage are reported, never thrown.
 */

import { readFileSync } from "node:fs";

/** The short commit of a parsed record: `commitShort`, else the first 8 of `commit`, else "". */
function commitOf(b: Record<string, unknown>): string {
  return typeof b.commitShort === "string" ? b.commitShort : typeof b.commit === "string" ? b.commit.slice(0, 8) : "";
}

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
  const commit = commitOf(b);
  if (!commit) return "build-info.json has no commit";
  const branch = typeof b.branch === "string" ? ` (${b.branch})` : "";
  const builtAt = typeof b.builtAt === "string" ? ` built ${b.builtAt}` : "";
  const dirty =
    b.dirty === true
      ? ` +dirty (${Array.isArray(b.dirtyFiles) ? b.dirtyFiles.length : "?"} file(s))`
      : "";
  return `${commit}${dirty}${branch}${builtAt}`;
}

/**
 * Pure: the short commit a build-info.json body names, by the same rule as
 * describeBuildInfo; null when the body is absent, unreadable or has none.
 */
export function buildCommit(raw: string | null): string | null {
  if (raw === null) return null;
  let info: unknown;
  try {
    info = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof info !== "object" || info === null) return null;
  const b = info as Record<string, unknown>;
  return commitOf(b) || null;
}

/**
 * Pure: the record's URL for this module at `moduleUrl` — one folder above
 * it (dist/lib/build-info.js → dist/build-info.json).
 */
export function buildInfoUrl(moduleUrl: string | URL): URL {
  return new URL("../build-info.json", moduleUrl);
}

let runningCommit: string | null | undefined;

/**
 * The short commit of the build this process runs, read once from the record
 * buildInfoUrl names; a source run has none (null).
 */
export function runningBuild(): string | null {
  if (runningCommit === undefined) {
    let raw: string | null;
    try {
      raw = readFileSync(buildInfoUrl(import.meta.url), "utf8");
    } catch {
      raw = null;
    }
    runningCommit = buildCommit(raw);
  }
  return runningCommit;
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
