/**
 * Operator ruling 4 (2026-10-01) — "changed files only". jarvis_test_run,
 * vps_deploy and jarvis_dev's test gate (action=test, and action=pr through
 * it) run typecheck plus ONLY the tests related to the files that changed.
 * The full suite runs where it already runs: the pre-commit hook and CI.
 * The related run still starts from the live service (jarvis_test_run and
 * vps_deploy children sit in its cgroup; jarvis_dev's in the jarvis-gate
 * slice). What bounds it: one run at a time (withSuiteRunLock), the existing
 * timeouts with process-group kill, and vitest.config's maxWorkers. It is NOT
 * bounded in size: a hub file (src/db/index.ts, src/tools/registry.ts)
 * selects 312 of 494 test files (measured 2026-10-01).
 *
 * "Changed" — one definition for all three, in the cwd the tool runs in:
 *   commits on HEAD not on origin/main   git diff --name-only origin/main...HEAD
 *   + staged and unstaged edits          git diff --name-only HEAD
 *   + untracked files                    git ls-files --others --exclude-standard
 * origin/main is the last FETCHED ref; nothing here fetches.
 */

import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

export const CHANGED_BASE_REF = "origin/main";
/** Above this many changed .ts files a scoped run is refused — typecheck only. */
export const MAX_RELATED_FILES = 60;
export const CHANGED_DEFINITION = `changed = commits ahead of ${CHANGED_BASE_REF} + uncommitted + untracked`;
/** Where the full suite runs. jarvis_dev commits with --no-verify, so for it
 * the pre-commit hook never fires — only CI. */
export const FULL_SUITE_PRECOMMIT_CI = "pre-commit/CI";
export const FULL_SUITE_CI = "CI";

// vitest 3.2.4 runs EVERY test file when a related path matches its default
// forceRerunTriggers `**/package.json/**` and `**/{vitest,vite}.config.*/**`
// — i.e. any path UNDER a directory segment of that name (measured:
// src/package.json/z.ts ran every test; a root vitest.config.ts does not).
// Such a path would turn the scoped run back into the full suite.
const FORCE_RERUN_RE =
  /(^|\/)(package\.json|(vite|vitest)\.config\.[^/]*)(\/|$)/;

export type TestScope =
  | { kind: "related"; changed: number; files: string[]; note: string }
  | { kind: "skip"; changed: number; reason: string }
  | { kind: "error"; reason: string };

function gitIn(cwd: string): (args: string[]) => string {
  return (args) =>
    execFileSync("git", args, {
      cwd,
      timeout: 30_000,
      encoding: "utf-8",
      maxBuffer: 8 * 1024 * 1024,
      // stderr is captured into the error, never the service journal.
      stdio: ["ignore", "pipe", "pipe"],
    });
}

/** Every changed path (repo-relative, sorted, deduped; deleted files included). */
export function changedFiles(
  cwd: string,
  git: (args: string[]) => string = gitIn(cwd),
): string[] {
  // `--` ends the revisions: an untracked file named HEAD is otherwise an
  // ambiguous argument and fails all three gates.
  const out = [
    git(["diff", "--name-only", "-z", `${CHANGED_BASE_REF}...HEAD`, "--"]),
    git(["diff", "--name-only", "-z", "HEAD", "--"]),
    git(["ls-files", "-z", "--others", "--exclude-standard"]),
  ].join("\0");
  return [...new Set(out.split("\0").filter(Boolean))].sort();
}

/** Which tests to run: the existing changed .ts files, or why none run. */
export function resolveTestScope(
  cwd: string,
  git?: (args: string[]) => string,
  fullSuiteIn: string = FULL_SUITE_PRECOMMIT_CI,
): TestScope {
  const note = `the full suite runs in ${fullSuiteIn}`;
  let changed: string[];
  try {
    changed = changedFiles(cwd, git);
  } catch (err) {
    return {
      kind: "error",
      reason: `could not determine changed files (${CHANGED_DEFINITION}): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const files = changed.filter(
    (f) =>
      f.endsWith(".ts") && !FORCE_RERUN_RE.test(f) && existsSync(join(cwd, f)),
  );
  if (files.length === 0) {
    return {
      kind: "skip",
      changed: changed.length,
      reason:
        changed.length === 0
          ? `no changed files; ${note}`
          : `${changed.length} changed file(s), none a .ts file vitest can scope — typecheck only; ${note}`,
    };
  }
  if (files.length > MAX_RELATED_FILES) {
    return {
      kind: "skip",
      changed: changed.length,
      reason: `${files.length} changed source files exceed the ${MAX_RELATED_FILES}-file cap for a scoped run, typecheck only; ${note}`,
    };
  }
  return { kind: "related", changed: changed.length, files, note };
}

/** argv for vitest's related-files mode. `./` keeps a leading-dash name a path.
 * No `--` before the paths: vitest then finds "No test files found", exit 0. */
export function relatedTestArgv(files: readonly string[]): string[] {
  return [
    "npx",
    "vitest",
    "related",
    "--run",
    "--reporter=dot",
    "--passWithNoTests",
    ...files.map((f) => `./${f}`),
  ];
}

/** The same command as one /bin/sh string (execGroupKill), every word quoted. */
export function relatedTestCommand(files: readonly string[]): string {
  return relatedTestArgv(files)
    .map((w) => (/^[\w./=-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`))
    .join(" ");
}

/** Test files vitest selected, from its summary; undefined when absent. */
export function relatedTestFileCount(output: string): number | undefined {
  if (/No test files found/.test(output)) return 0;
  const m = output.match(/Test Files\s+[^\n]*\((\d+)\)/);
  return m ? Number(m[1]) : undefined;
}

/** "related tests only: N changed source files → M test files; …" */
export function relatedScopeSummary(
  scope: Extract<TestScope, { kind: "related" }>,
  output?: string,
): string {
  const m = output === undefined ? undefined : relatedTestFileCount(output);
  return `related tests only: ${scope.files.length} changed source file(s) → ${m ?? "?"} test file(s) (${CHANGED_DEFINITION}); ${scope.note}`;
}
