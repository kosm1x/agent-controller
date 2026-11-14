// 2026-10-30: a pre-commit run from a linked worktree exported GIT_DIR/GIT_INDEX_FILE to the
// suite; a fixture's `git init` inherited them and reinitialized the real repo as bare.
// Every worker drops inherited GIT_* keys before any test file runs.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}

// The vector-store client switches on when its key is merely present, and every
// in-memory database seeds directives that it syncs: no worker keeps an inherited
// key, so no test can write to the live store. A test that needs the client on
// sets its own dummy key after this file runs (pinned by src/lib/test-env.guard.test.ts).
delete process.env.COMMIT_DB_KEY;
