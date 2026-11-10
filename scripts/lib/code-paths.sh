#!/usr/bin/env bash
# The paths whose working-tree state becomes the build or the deploy itself:
# src/ (compiled), scripts/ (build, deploy and their helpers), the manifest,
# the lockfile and the tsconfig files. One list, so the dirty flag recorded in
# dist/build-info.json and the deploy's dirty-tree refusal never disagree.
# Documentation paths are left out on purpose: a docs-only change does not
# change what runs.
# Sourced by scripts/build-info.sh and scripts/lib/deploy-checks.sh.

# Prints each code file that differs from HEAD, one per line (modified or
# staged tracked files, plus untracked non-ignored files under src/ and
# scripts/, which tsc and the deploy would pick up); prints nothing when clean.
# Run from the repository root. Returns non-zero when git fails.
code_dirty_files() {
  local git="${GIT:-git}" status untracked
  status=$("$git" status --porcelain=v1 --untracked-files=no -- \
    src/ scripts/ package.json package-lock.json 'tsconfig*.json') || return 1
  untracked=$("$git" ls-files --others --exclude-standard -- src/ scripts/) || return 1
  if [[ -n "$status" ]]; then cut -c4- <<<"$status"; fi
  if [[ -n "$untracked" ]]; then printf '%s\n' "$untracked"; fi
  return 0
}
