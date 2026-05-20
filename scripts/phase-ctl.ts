/**
 * v7.7 Spine 7 — phase-closure continuity CLI.
 *
 * Backs `mc-ctl close-phase | resume | audit-closure`. The pure logic lives
 * in `src/lib/phase-closure.ts`; this file is the thin side-effecting shell
 * (file I/O + git). Per the Spine 7 constraint it NEVER runs a git mutation
 * — `close-phase` writes `*.draft` files the operator reviews and promotes;
 * `audit-closure` only reads (`git cat-file`).
 *
 * Env: MODE=close-phase|resume|audit-closure (required).
 *   close-phase    — PHASE (e.g. v7.7). Drafts CLOSURE.md + watchlist + tag.
 *   resume         — PHASE. Prints open queue + watchlist + recent commits.
 *   audit-closure  — DOC (path to a closure doc). Verifies commits + refs.
 *
 * Exit codes: 0 ok | 1 audit found issues | 2 bad MODE / missing input.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditClosureDoc,
  draftClosureDoc,
  draftTagMessage,
  draftWatchlist,
  extractOpenQueueItems,
  parseSpineTable,
} from "../src/lib/phase-closure.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Open queue-item rows from next-sessions-queue.md (logic in the lib). */
function openQueueItems(): string[] {
  const queuePath = join(REPO_ROOT, "docs/planning/next-sessions-queue.md");
  if (!existsSync(queuePath)) return [];
  return extractOpenQueueItems(readFileSync(queuePath, "utf8"));
}

function cmdClosePhase(phase: string): number {
  const guidePath = join(REPO_ROOT, "docs", `${phase.toUpperCase()}-GUIDE.md`);
  if (!existsSync(guidePath)) {
    console.error(`[phase-ctl] guide not found: ${guidePath}`);
    return 2;
  }
  const rows = parseSpineTable(readFileSync(guidePath, "utf8"));
  if (rows.length === 0) {
    console.error(
      `[phase-ctl] no spine rows parsed from ${guidePath} — is there a "## Spine progress" table?`,
    );
    return 2;
  }

  const closureDraft = join(REPO_ROOT, "docs", `${phase}-CLOSURE.md.draft`);
  const watchlistDraft = join(
    REPO_ROOT,
    "docs/planning",
    `${phase}-leftovers-queue.md.draft`,
  );
  // Drafts are regenerable, but warn so a hand-edited draft isn't silently
  // clobbered by a re-run (R1-W2).
  for (const p of [closureDraft, watchlistDraft]) {
    if (existsSync(p))
      console.log(`[phase-ctl] overwriting existing draft: ${p}`);
  }
  writeFileSync(closureDraft, draftClosureDoc(phase, rows));
  writeFileSync(watchlistDraft, draftWatchlist(phase, openQueueItems()));

  console.log(`[phase-ctl] close-phase ${phase} — ${rows.length} spines`);
  console.log(`  drafted: ${closureDraft}`);
  console.log(`  drafted: ${watchlistDraft}`);
  console.log(
    "\n  NO git operation was performed. Review the drafts, edit them,\n" +
      "  rename off the .draft suffix, then tag by hand.\n",
  );
  console.log("--- annotated tag message draft ---");
  console.log(draftTagMessage(phase, rows));
  return 0;
}

function cmdResume(phase: string): number {
  console.log(`[phase-ctl] resume ${phase}\n`);

  const watchlist = join(
    REPO_ROOT,
    "docs/planning",
    `${phase}-leftovers-queue.md`,
  );
  console.log(
    `Watchlist: ${existsSync(watchlist) ? watchlist : "(none — phase not yet closed)"}`,
  );

  const items = openQueueItems();
  console.log(`\nOpen queue items (${items.length}):`);
  for (const i of items.slice(0, 25)) console.log(`  ${i.slice(0, 160)}`);
  if (items.length > 25) console.log(`  … and ${items.length - 25} more`);

  console.log("\nRecent commits:");
  try {
    const log = execSync("git log --oneline -12", {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    for (const l of log.trimEnd().split("\n")) console.log(`  ${l}`);
  } catch {
    console.log("  (git log unavailable)");
  }
  return 0;
}

function cmdAuditClosure(docPath: string): number {
  const full = resolve(REPO_ROOT, docPath);
  if (!existsSync(full)) {
    console.error(`[phase-ctl] closure doc not found: ${full}`);
    return 2;
  }
  const result = auditClosureDoc(readFileSync(full, "utf8"), {
    commitExists: (hash) => {
      try {
        execSync(`git cat-file -e ${hash}^{commit}`, {
          cwd: REPO_ROOT,
          stdio: "ignore",
        });
        return true;
      } catch {
        return false;
      }
    },
    fileExists: (p) => existsSync(join(REPO_ROOT, p)),
  });

  console.log(`[phase-ctl] audit-closure ${docPath}\n`);
  console.log(
    `  commits: ${result.commitChecks.length} cited, ${result.missingCommits} missing`,
  );
  for (const c of result.commitChecks.filter((x) => !x.exists)) {
    console.log(`    MISSING commit: ${c.hash}`);
  }
  console.log(
    `  doc refs: ${result.refChecks.length} cited, ${result.missingRefs} missing`,
  );
  for (const r of result.refChecks.filter((x) => !x.exists)) {
    console.log(`    MISSING ref: ${r.path}`);
  }
  console.log(`\n  verdict: ${result.verdict.toUpperCase()}`);
  return result.verdict === "pass" ? 0 : 1;
}

function main(): number {
  const mode = (process.env.MODE ?? "").toLowerCase();
  switch (mode) {
    case "close-phase": {
      const phase = (process.env.PHASE ?? "").trim();
      if (!phase) {
        console.error("[phase-ctl] PHASE is required for close-phase");
        return 2;
      }
      return cmdClosePhase(phase);
    }
    case "resume": {
      const phase = (process.env.PHASE ?? "").trim();
      if (!phase) {
        console.error("[phase-ctl] PHASE is required for resume");
        return 2;
      }
      return cmdResume(phase);
    }
    case "audit-closure": {
      const doc = (process.env.DOC ?? "").trim();
      if (!doc) {
        console.error("[phase-ctl] DOC is required for audit-closure");
        return 2;
      }
      return cmdAuditClosure(doc);
    }
    default:
      console.error(
        `[phase-ctl] MODE must be close-phase|resume|audit-closure (got "${mode}")`,
      );
      return 2;
  }
}

process.exit(main());
