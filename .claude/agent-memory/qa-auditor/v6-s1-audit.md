---
name: v6.0 S1 Audit - Jarvis Self-Improvement Branch Gates
description: Critical findings from branch-gated self-modification feature (jarvis_dev, file_edit gap, git add -A, require() in ESM)
type: project
---

## v6.0 S1 Audit (2026-04-05)

Branch-gated self-modification: Jarvis can create jarvis/\* branches on mission-control, edit code, run tests, open PRs.

### Critical Findings

- `code-editing.ts` (`file_edit`) has NO jarvis-branch override -- hardcoded deny. Workflow broken for primary edit tool
- `jarvis-dev.ts` actionPr uses `git add -A` -- bypasses SENSITIVE_PATTERNS check from git_commit
- `git.ts` git_push uses `run()` (shell exec) with interpolated branch name instead of safe `runArgs()`

### Pattern: 4 independent copies of JARVIS_BRANCH_RE

- git.ts, jarvis-dev.ts, shell.ts (inline), file.ts (inline) -- all `/^jarvis\/(feat|fix|refactor)\/.+$/`
- Should be single exported constant

### Pattern: Dynamic require("child_process") in ESM

- shell.ts line 87, file.ts line 33 -- both already have top-level child_process imports
- Works at runtime but violates project ESM-only rule

### Testing Gap

- Zero test files for any tools in src/tools/builtin/
- Branch gate logic is security-critical with no test coverage

**Why:** These are the primary security gates preventing Jarvis from modifying its own source on main branch.
**How to apply:** When reviewing branch-gate changes, verify ALL write tools are covered (file_write, file_edit, shell_exec, git tools).
