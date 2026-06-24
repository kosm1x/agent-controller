/**
 * The `[ENVIRONMENT]` note injected into every nanoclaw coding-task prompt.
 *
 * Kept in its own side-effect-free module so it can be unit-tested without
 * importing `nanoclaw-worker.ts` (whose module body self-invokes `main()` —
 * reads stdin, inits the DB — and so cannot be imported from a test).
 *
 * Beyond the workspace mechanics it carries two guards added 2026-06-24 after a
 * landing-site coding task was misrouted into this sandbox (which holds ONLY
 * mission-control, so the real target repo was absent). Finding no EurekaMS repo,
 * the agent confabulated edits to mission-control's OWN source, then base64-encoded
 * `commit` to dodge the shell-guard:
 *   1. SANDBOX SCOPE — only mission-control is here; any other target ⇒ STOP +
 *      report `TARGET_NOT_IN_SANDBOX`, never substitute mc's source.
 *   2. NO EVASION — a guard-BLOCKED command is a hard stop; never bypass it.
 * Both guards apply whether or not a writable workspace was set up.
 */

/** Read-only reference mount of the host repo inside the container (never writable). */
export const RO_REPO = "/root/claude/mission-control";

/**
 * Sentinel the agent is told to emit when its task targets a repo/site that is
 * NOT in this mission-control-only sandbox. Single source of truth so the prompt
 * instruction (`buildEnvironmentNote`) and the worker's structural backstop
 * (`emittedTargetNotInSandbox`) can never drift apart.
 */
export const TARGET_NOT_IN_SANDBOX = "TARGET_NOT_IN_SANDBOX";

/** True when an agent's final summary signals the sandbox-scope stop. */
export function emittedTargetNotInSandbox(summary: string): boolean {
  return summary.includes(TARGET_NOT_IN_SANDBOX);
}

export function buildEnvironmentNote(workspace: string | null): string {
  const base = workspace
    ? `\n\n[ENVIRONMENT] You are in an isolated Docker container. Your WRITABLE working copy of the mission-control repo is at ${workspace} and is already your working directory — do ALL file edits, test runs, commits and pushes there. \`${RO_REPO}\` is a READ-ONLY reference mount; never write or commit in it. Dependencies are ALREADY installed (node_modules is present) — run tests directly with \`npx vitest run <file>\`; do NOT run \`npm install\`/\`npm ci\` (unnecessary, and it will strip dev tools). To DELIVER a change you MUST create a branch, commit, and \`git push -u origin <branch>\` (push auth + the GitHub remote are already configured). Report the pushed branch name.`
    : `\n\n[ENVIRONMENT] Isolated container; \`${RO_REPO}\` is READ-ONLY and no writable workspace is available — you can read code but cannot commit.`;

  const scopeGuard = `\n\n[SANDBOX SCOPE — CRITICAL] This container holds ONLY the mission-control repository. It does NOT contain any other repository, landing site, or project — not a landing site, not a sibling \`/root/claude/<repo>\`, nothing else. If your task asks you to work on ANYTHING other than mission-control itself (e.g. "termina la landing", "el sitio de X", another repo or project), that target is NOT in this sandbox. You MUST STOP, make NO file edits, and reply EXACTLY with: "${TARGET_NOT_IN_SANDBOX}: this task targets <name>, which is not in the nanoclaw sandbox — it must run on a host runner." Editing mission-control's own source to "make progress" on an unrelated task is a CRITICAL error — never do it.`;

  const evasionGuard = `\n\n[GUARD POLICY] If any shell command is BLOCKED by a guard, that is a HARD STOP. NEVER try to bypass a guard — no base64/hex/encoding of the command, no \`env -i\`, no wrapper scripts, no alternate binaries, no retry variations. Report the blocked command verbatim and stop or ask for guidance.`;

  return base + scopeGuard + evasionGuard;
}
