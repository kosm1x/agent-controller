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
 *   3. HOST STATE (2026-08-20, task 8542): an attachment-ingestion chat landed
 *      here and burned its turn cap scripting SQLite writes into the then
 *      read-only-mounted `data/mc.db`. Since SEC-02 (4b353ac, 2026-09-10) mc.db
 *      is not mounted at all and the worker's DB is a container-local
 *      `/tmp/mc.db`, so the same attempt now SUCCEEDS silently into a throwaway
 *      copy — a false "done". Changing Jarvis's live data ⇒ same STOP + sentinel
 *      as guard 1 (the worker fails the task; messaging chats then fall back to
 *      the fast runner, which has the host write tools). Editing DB-touching
 *      source and running tests stays allowed.
 * All guards apply whether or not a writable workspace was set up.
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
    ? `\n\n[ENVIRONMENT] You are in an isolated Docker container. Your WRITABLE working copy of the mission-control repo is at ${workspace} and is already your working directory — do ALL file edits, test runs, commits and pushes there. \`${RO_REPO}\` holds only the read-only git history the workspace was cloned from — it is not a working tree; never write or commit in it. Dependencies are ALREADY installed (node_modules is present) — run tests directly with \`npx vitest run <file>\`; do NOT run \`npm install\`/\`npm ci\` (unnecessary, and it will strip dev tools). To DELIVER a change you MUST create a branch, commit, and \`git push -u origin <branch>\` (push auth + the GitHub remote are already configured). Report the pushed branch name.`
    : `\n\n[ENVIRONMENT] Isolated container; no writable workspace could be set up (\`${RO_REPO}\` holds only the read-only git history) — you cannot read source and cannot commit; report this and stop.`;

  const scopeGuard = `\n\n[SANDBOX SCOPE — CRITICAL] This container holds ONLY the mission-control repository. It does NOT contain any other repository, landing site, or project — not a landing site, not a sibling \`/root/claude/<repo>\`, nothing else. If your task asks you to work on ANYTHING other than mission-control itself (e.g. "termina la landing", "el sitio de X", another repo or project), that target is NOT in this sandbox. You MUST STOP, make NO file edits, and reply EXACTLY with: "${TARGET_NOT_IN_SANDBOX}: this task targets <name>, which is not in the nanoclaw sandbox — it must run on a host runner." Editing mission-control's own source to "make progress" on an unrelated task is a CRITICAL error — never do it.`;

  const evasionGuard = `\n\n[GUARD POLICY] If any shell command is BLOCKED by a guard, that is a HARD STOP. NEVER try to bypass a guard — no base64/hex/encoding of the command, no \`env -i\`, no wrapper scripts, no alternate binaries, no retry variations. Report the blocked command verbatim and stop or ask for guidance.`;

  const hostStateGuard = `\n\n[HOST STATE — NOT IN THIS SANDBOX] Jarvis's live database (\`data/mc.db\`), knowledge base and Gemini uploads are NOT in this container — only mission-control's git history is. Any SQLite file you find or create here (including \`$MC_DB_PATH\`, the worker's own scratch DB) is a throwaway container-local copy: writes to it SUCCEED but never reach Jarvis and are discarded when the container exits. The host tools that write Jarvis state (jarvis_file_write, gemini_upload, …) are not registered here. Editing mission-control SOURCE that touches the database (migrations, schema, queries) and running tests that open their own temp or in-memory SQLite is normal coding work — do it. But if the task's GOAL is to change Jarvis's live data (save or ingest a document/attachment into the KB, insert or update rows, upload a file to Gemini), you MUST STOP, make NO writes, and reply EXACTLY with: "${TARGET_NOT_IN_SANDBOX}: this task writes Jarvis's live state (mc.db / KB), which is not in the nanoclaw sandbox — it must run on a host runner."`;

  return base + scopeGuard + evasionGuard + hostStateGuard;
}
