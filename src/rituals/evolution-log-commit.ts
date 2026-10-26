/**
 * Evolution-log durability commit — weekly, MECHANICAL (no LLM).
 *
 * The daily `evolution-log` ritual APPENDS a day entry to docs/EVOLUTION-LOG.md
 * but deliberately never commits it (committing is blocked for that ritual). So
 * entries accumulate uncommitted in the working tree — which is exactly why the
 * 2026-06-17 truncation lost five days that had never been committed and had no
 * git recovery path.
 *
 * This is the sanctioned committer: once a week it commits the log so the entries
 * become recoverable (a later truncation can be restored from the commit). It is
 * deliberately NOT an LLM ritual:
 *   - the git TOOLS (git_commit/git_status) throw on `main` — they only permit mc
 *     writes on a jarvis/* branch — so an LLM-tool ritual is inert here; and
 *   - this is deterministic durability infra, not a judgment task.
 * So it runs as a direct cron (see scheduler.ts `scheduleEvolutionLogCommit`),
 * doing its own git via async execFile, bypassing the tool-level branch gate.
 *
 * The commit is PATHSPEC-SCOPED (`git commit -- docs/EVOLUTION-LOG.md`): it
 * commits ONLY that file regardless of what else is staged in the shared
 * operator/Jarvis worktree, so it can never sweep a dirty index (or a staged
 * secret) into the commit. See memory feedback_evolution_log_truncation.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { nowMexIsoDate } from "../lib/timezone.js";

const MC_DIR = "/root/claude/mission-control";
const LOG_REL = "docs/EVOLUTION-LOG.md";

// Async on purpose (2026-10-26): execFileSync blocked the event loop for each
// git child's whole run, so a slow status/commit on the shared worktree froze
// every other task and could cross the 5 s MCEventLoopBlock alert. Promisified
// children keep stdin open; each site closes it right after spawn so a child
// that reads stdin (a hook, an editor) fails fast instead of hanging.
const execFileAsync = promisify(execFile);

export interface EvolutionLogCommitResult {
  committed: boolean;
  /** "clean" (nothing to commit) | "committed" */
  reason: "clean" | "committed";
  /** short hash of the new commit, when committed */
  hash?: string;
}

/**
 * Commit docs/EVOLUTION-LOG.md if (and only if) it has uncommitted changes.
 * Pathspec-scoped — never touches any other path. Throws on git failure so the
 * caller can record the ritual failure; the clean (no-op) case returns normally.
 */
export async function commitEvolutionLogIfDirty(): Promise<EvolutionLogCommitResult> {
  // Porcelain status scoped to the one file: empty output ⇒ nothing to commit.
  const statusP = execFileAsync(
    "git",
    ["status", "--porcelain", "--", LOG_REL],
    { cwd: MC_DIR, timeout: 10_000, encoding: "utf-8" },
  );
  statusP.child.stdin?.end();
  const status = (await statusP).stdout.trim();

  if (!status) {
    return { committed: false, reason: "clean" };
  }

  const date = nowMexIsoDate();
  const message = `docs(evolution-log): weekly durability commit (${date})`;

  // Stage the one file (pathspec-scoped). Redundant for the normal modified case
  // but it also TRACKS the file if it was ever deleted-and-recreated as untracked
  // — without which the pathspec commit below would error "did not match".
  const addP = execFileAsync("git", ["add", "--", LOG_REL], {
    cwd: MC_DIR,
    timeout: 10_000,
    encoding: "utf-8",
  });
  addP.child.stdin?.end();
  await addP;

  // PATHSPEC-SCOPED commit. `-m` MUST precede `--`; everything after `--` is a
  // pathspec. Commits only docs/EVOLUTION-LOG.md and leaves the rest of the index
  // untouched — no dirty-index sweep, ever. `--no-verify` skips the repo's
  // pre-commit hook: this is mechanical durability infra committing a single
  // markdown file (the hook skips it anyway — no staged .ts), and it must not be
  // blocked for weeks by an unrelated red test suite on main.
  const commitP = execFileAsync(
    "git",
    ["commit", "--no-verify", "-m", message, "--", LOG_REL],
    { cwd: MC_DIR, timeout: 15_000, encoding: "utf-8" },
  );
  commitP.child.stdin?.end();
  await commitP;

  const hashP = execFileAsync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: MC_DIR,
    timeout: 5_000,
    encoding: "utf-8",
  });
  hashP.child.stdin?.end();
  const hash = (await hashP).stdout.trim();

  return { committed: true, reason: "committed", hash };
}
