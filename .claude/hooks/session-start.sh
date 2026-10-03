#!/bin/bash
# SessionStart hook for Claude Code CLOUD sessions only (S1, 2026-10-03).
#
# A fresh cloud container has the repo but no node_modules. This installs the
# locked dependencies and typechecks, so the session can run `npm run typecheck`
# and scoped vitest without reconstructing anything.
#
# - Cloud-only: exits at once unless CLAUDE_CODE_REMOTE=true. On the VPS the
#   primary checkout's node_modules belongs to the live service; `npm ci` there
#   would delete and rebuild it under a running process. Never remove this gate.
# - Idempotent: `npm ci` runs only when node_modules is missing or
#   package-lock.json changed since the last install (sha stamp). Safe on
#   resume / clear / compact. A node_modules without the stamp is left alone.
# - Network: only what `npm ci` already fetches in CI (the npm registry, plus
#   better-sqlite3's prebuilt binary). No dependency is added or upgraded.
# - Output: stdout becomes session context, so install noise goes to stderr and
#   stdout carries one status line (or the typecheck errors).
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

# Cloud clones have no pre-commit hook: point git at the versioned one
# (typecheck + `vitest related` on staged .ts; CI stays the full gate). Only when
# core.hooksPath is unset, so an existing setting is never overwritten. Behind
# the env gate above, so never on the VPS.
if ! git config --get core.hooksPath >/dev/null 2>&1; then
  git config core.hooksPath scripts/git-hooks || true
fi

stamp="node_modules/.session-start-lock.sha256"
want="$(sha256sum package-lock.json | cut -d' ' -f1)"

if [ -d node_modules ] && [ ! -f "$stamp" ]; then
  # Second guard behind the env gate: never delete a node_modules this hook did
  # not create (e.g. the VPS checkout if CLAUDE_CODE_REMOTE ever leaked there).
  installed="unmanaged (node_modules exists without this hook's stamp; npm ci skipped)"
elif [ ! -d node_modules ] || [ "$(cat "$stamp")" != "$want" ]; then
  if ! npm ci --no-audit --no-fund >&2; then
    echo "session-start: npm ci FAILED (details on stderr); dependencies are missing. Run \`npm ci\` before typecheck or tests."
    exit 0
  fi
  echo "$want" > "$stamp"
  installed="installed"
else
  installed="unchanged"
fi

if out="$(npm run --silent typecheck 2>&1)"; then
  echo "session-start: dependencies ${installed}; npm run typecheck: 0 errors."
else
  echo "session-start: dependencies ${installed}; npm run typecheck FAILED:"
  echo "$out" | tail -n 40
  if [ "$installed" = "unchanged" ]; then
    echo "(If these errors point at missing modules, node_modules may be damaged: delete $stamp and rerun this hook, or run npm ci.)"
  fi
  # exit 0 on purpose: a SessionStart hook's stdout reaches the session only on
  # success, and the session needs to see these errors, not lose them.
fi
