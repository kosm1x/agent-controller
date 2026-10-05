#!/bin/bash
# Record which commit dist/ was built from (queue items 9 + 15, 2026-10-05).
# deploy.sh builds the WORKING TREE, so uncommitted code can go live with no
# record of it. Run from the repo root right after `npm run build`; writes
# dist/build-info.json and warns loudly when code paths are dirty.
# Only code paths count (docs/, .claude/ do not). Untracked, non-ignored files
# under src/ and scripts/ count too (tsc compiles them); a detached HEAD
# reports branch "HEAD". Any git failure aborts (set -e): no JSON is written.
# Usage: bash scripts/build-info.sh [--check]
#   (default)  write dist/build-info.json; exit 0 even when dirty
#   --check    print the same report, write nothing; exit 3 when dirty
set -euo pipefail

CHECK="no"
case "${1:-}" in
  "") ;;
  --check) CHECK="yes" ;;
  *) echo "[deploy] build-info: unknown arg: $1"; exit 2 ;;
esac

if ! COMMIT=$(git rev-parse --verify -q HEAD 2>/dev/null); then
  echo "[deploy] build-info FAILED — not a git repository (or no commits) at $(pwd)."
  exit 1
fi
cd "$(git rev-parse --show-toplevel)"
COMMIT_SHORT=$(git rev-parse --short HEAD)
BRANCH=$(git rev-parse --abbrev-ref HEAD)
BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

STATUS=$(git status --porcelain=v1 --untracked-files=no -- \
  src/ scripts/ package.json package-lock.json 'tsconfig*.json')
UNTRACKED=$(git ls-files --others --exclude-standard -- src/ scripts/)
DIRTY_FILES=()
while IFS= read -r f; do
  if [[ -n "$f" ]]; then DIRTY_FILES+=("$f"); fi
done < <(cut -c4- <<<"$STATUS"; printf '%s\n' "$UNTRACKED")

echo "[deploy] Built ${COMMIT_SHORT} (${BRANCH})"
if [[ ${#DIRTY_FILES[@]} -gt 0 ]]; then
  echo "[deploy] ⚠ WARNING — ${#DIRTY_FILES[@]} code file(s) differ from ${COMMIT_SHORT} (modified or untracked):"
  printf '[deploy]     %s\n' "${DIRTY_FILES[@]}"
  echo "[deploy] ⚠ The running service will contain UNCOMMITTED changes not recorded in any commit."
fi

if [[ "$CHECK" == "yes" ]]; then
  [[ ${#DIRTY_FILES[@]} -gt 0 ]] && exit 3
  exit 0
fi

if [[ ! -d dist ]]; then
  echo "[deploy] build-info FAILED — dist/ missing; run after npm run build."
  exit 1
fi
node -e '
  const [commit, commitShort, branch, builtAt, ...dirtyFiles] = process.argv.slice(1);
  const info = { commit, commitShort, branch, builtAt, dirty: dirtyFiles.length > 0, dirtyFiles };
  require("fs").writeFileSync("dist/build-info.json", JSON.stringify(info, null, 2) + "\n");
' -- "$COMMIT" "$COMMIT_SHORT" "$BRANCH" "$BUILT_AT" ${DIRTY_FILES[@]+"${DIRTY_FILES[@]}"}
