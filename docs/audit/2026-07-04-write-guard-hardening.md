# 2026-07-04 — Write-Guard Hardening

Jarvis's builtin `git_commit`/`git_push`/`shell_exec`/`file_write` tools gate the
working directory + write targets against a path allow-list. It was a hardcoded
per-repo enumeration that had drifted stale — it omitted every top-level EurekaMD
repo (`vlcrm`, `intelligence-ops-mcp`, `eurekams-intelligence-ui`,
`Pulso-Aura-Upfront`, `salon-voice-outreach`), so operations there failed with
"must be under an allowed project path", surfaced to Jarvis as "git_commit no
soporta este path". This stranded landing-page work in a repo Jarvis could not
commit from. Fixed by broadening to a single `/root/claude/` prefix — then a
qa-audit of that broadening caught two holes the parent prefix opened, fixed in a
follow-up.

- **Commits**: `11e0c44` (allow-list: per-repo enumeration → `/root/claude/` prefix) · `d367371` (C1+W1 hardening)
- **Tests**: 163 passing across `git/shell/file/write-guard` · typecheck clean
- **Deploy**: `./scripts/deploy.sh` — PID 1292566 → 3088771 (11e0c44) → 3152141 (d367371)
- **Post-deploy verification**: live security matrix run against compiled `dist/` (see below) — all cases as intended.

## Audit findings (qa-auditor + a compiled-guard matrix)

| #   | Severity         | Finding                                                                                                                                                                                                                                                                                                                                                                     | Resolution         |
| --- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| C1  | Critical         | Bare `/root/claude/` also exposed the operator's OWN config sitting directly under it — `/root/claude/.claude/` (Claude Code settings + **hooks**), `/root/claude/.mcp.json`, umbrella `/root/claude/CLAUDE.md`. None were deny-listed (the deny entry `/root/.claude/` is a **different path**). A settings/hook rewrite is a guardrail-tamper / command-execution vector. | Fixed `d367371`    |
| W1  | Warning (latent) | The guards resolved only the LITERAL path (`resolve()` does not follow symlinks), so a symlink inside an allowed dir pointing outside it (`ln -s /root/.claude /root/claude/x`) could smuggle a write past the deny/immutable/allow gates — incl. to mission-control source or `/root/.claude`. No such symlink existed; the broadening widened the latent gap.             | Fixed `d367371`    |
| S1  | Low              | `src/tools/builtin/file-convert.ts` still carries the old narrow enumeration (`/root/claude/projects/`). It fails **closed** (too narrow) and realpaths its inputs, output restricted to `/tmp`+`/workspace` — not a hole, just inconsistent.                                                                                                                               | Left as-is (noted) |

Change 2 of the same session (a direct-SQL correction of two stale `jarvis_files`
KB rows) was audited independently and came back clean on every probe — content
stored as TEXT (not blob), byte-identical to the FS mirror, UTF-8 intact, metadata
preserved. No code change.

## Fixes

New `src/tools/builtin/write-guard.ts`, wired into `git.ts`, `shell.ts`, `file.ts`:

- **`isOperatorConfigPath(resolved)`** — denies any TOP-LEVEL dotfile/dotdir under
  `/root/claude/` plus the umbrella `CLAUDE.md`, at the deny-first layer (before the
  allow-list). Pattern-based, so a future top-level config file is covered without a
  new enumeration. A repo's OWN `CLAUDE.md` (depth ≥ 2) stays writable.
- **`realResolve(p)`** — follows symlinks (nearest existing ancestor for a
  not-yet-existing leaf) before the deny/immutable/allow checks, matching the
  read-path hardening. `shell.ts` keeps the RAW redirect target for the ritual-doc
  append regex (which also fixes relative-path appends).

mission-control _source_ protection was and remains in the deny-first pipeline
(`DENY_WRITE_*` / `isImmutableCorePath` / jarvis-branch override), independent of the
allow-list.

## Live verification (compiled `dist/`)

| Case                                                                                | Expect | Got   |
| ----------------------------------------------------------------------------------- | ------ | ----- |
| write `/root/claude/.claude/settings.local.json`, `.mcp.json`, umbrella `CLAUDE.md` | BLOCK  | BLOCK |
| write via symlink → `/root/.claude` / → `mission-control`                           | BLOCK  | BLOCK |
| write `vlcrm`, `projects/EurekaMS-Landing`, `jarvis-kb`, a repo's own `CLAUDE.md`   | allow  | allow |
| write `/root/claude-backups`, `/etc`                                                | BLOCK  | BLOCK |
| git_commit cwd `/root/claude/vlcrm` (was blocked by the stale enumeration)          | allow  | allow |
| git ops on mission-control on `main` (non-jarvis branch)                            | BLOCK  | BLOCK |

## Lesson

Broadening a security allow-list to a PARENT prefix silently grants everything else
under that parent. When you widen one: enumerate what else lives under the parent
(operator config, dotfiles), and realpath the target before the allow/deny checks.
