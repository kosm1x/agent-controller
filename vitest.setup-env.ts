// 2026-10-30: a pre-commit run from a linked worktree exported GIT_DIR/GIT_INDEX_FILE to the
// suite; a fixture's `git init` inherited them and reinitialized the real repo as bare.
// Every worker drops inherited GIT_* keys before any test file runs.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}
