# git/shell/file allow-list broadened to bare /root/claude/ (commit 11e0c44, 2026-07-04)

VERDICT: FAIL. User's stated invariant (MC source protection unchanged) VERIFIED true, but it
was the wrong invariant to check alone — the broadening grants NET-NEW write/delete to the
operator's own Claude Code config living directly under /root/claude/.

## What changed
Three files replaced a per-repo enumeration (cuatro-flor/, projects/, williams-entry-radar/,
mission-control/, …) with a single bare prefix `/root/claude/`:
- git.ts:23 ALLOWED_CWD_PREFIXES = ["/root/claude/", "/tmp/"]
- shell.ts:199 getAllowWritePrefixes → "/root/claude/"
- file.ts:36 getAllowWritePrefixes → "/root/claude/" (also gates file_delete: getAllowDeletePrefixes = getAllowWritePrefixes)

## VERIFIED SAFE (the user's claim)
MC source stays blocked on main in all three: deny/immutable checks are independent AND-gates.
- file.ts/shell.ts: isImmutableCorePath + DENY_WRITE_* run BEFORE the allow check → block.
- git.ts: allow-check runs FIRST, THEN checkMissionControlAccess (MC_DIR trailing-slash startsWith)
  throws on non-jarvis branch. Order is reversed vs file/shell but still an AND-gate → still blocks.
Prefix-confusion (/root/claude-backups) correctly rejected (trailing slash). Tests 157/157 pass.

## THE HOLE (net-new, DOCTRINE)
Broadening an allow-list from enumerated project subdirs to the PARENT prefix silently grants the
parent's NON-project children. `/root/claude/` is not just repos — it holds operator config:
- /root/claude/.claude/settings.local.json (46KB, LIVE Claude Code project settings — permissions
  + hooks for every session under the tree) → file_write/shell/file_delete ALL allow it (proven via
  validateShellCommand). Rewriting it = tamper operator permission guardrails / inject a hook =
  arbitrary command execution on the operator's next tool call.
- /root/claude/CLAUDE.md (loaded into agent context — prompt injection)
- /root/claude/.mcp.json (MCP server command+env — command injection on session start)
- executable operator scripts (aura-*.sh key-rotation/bringup), data/, node_modules/, references/.
None are in DENY_WRITE_PREFIXES (which only shields mission-control/, /root/.claude/, /etc|usr|var).
NOTE the near-miss: DENY has `/root/.claude/` but the exposed dir is `/root/claude/.claude/` — a
different path; the deny does NOT cover it.

FIX: don't allow the bare parent. Either (a) add deny prefixes for operator config
(/root/claude/.claude/, /root/claude/.mcp.json, /root/claude/CLAUDE.md), or (b) enumerate-by-git-repo
dynamically (a dir is allowed iff it contains .git) — satisfies "can't drift" without granting the
whole tree.

## Symlink escape (PRE-EXISTING, all 3 tools — write path never realpaths)
file.ts:87 resolve(path), shell.ts write target, git.ts:85 resolve(cwd) — none realpath-resolve.
validatePathSafety realpaths ONLY on read mode (immutable-core.ts:248); file-convert.ts DOES
realpath its inputs. So writes follow symlinks at the OS layer: `ln -s /root/.claude
/root/claude/x` (ln not shell-blocked) then file_write /root/claude/x/settings.json escapes the
deny-list; symlink→mission-control even bypasses immutable-core. Pre-existed (symlink could live
in any old enumerated dir); the broadening only makes placement easier. Fix: realpath the path
(or dirname for new files) before deny/immutable/allow, matching the read path.

## Probe 5 — file-convert.ts still narrow (incomplete, but fails-closed)
file-convert.ts:45 getSourceAllowPrefixes still has "/root/claude/projects/" (old enumeration) —
can't read source from top-level EurekaMD repos. Safe direction (too narrow), outputs → /tmp only.
Other ALLOWED_PATHS hits (jarvis-self-repair.ts, autonomous-improvement.ts, code-editing.ts
SELF_IMPROVEMENT_ALLOWED) are the intentional self-improvement scope, not the same anti-pattern.
ASIDE: code-editing.ts (file_edit) DENY_EDIT_PREFIXES only lists mission-control + /root/.claude —
no /etc|usr|var and no positive allow-list → deny-only design, out of scope of this commit.

## Change 2 (KB DB UPDATE) — CLEAN
Both jarvis_files rows (projects/eurekaMS/{landing-estado,README}.md) byte-identical to FS mirror
(content = CAST(readfile) → 1), typeof=text, trailing \n, UTF-8 (✅⚠️/accents) intact, metadata
(title/qualifier=reference/priority=50/related_to=[]) preserved, tags flipped deploy-pendiente→
deploy-live. dac21f3 STILL in landing-estado.md but it's the commit-history table row (#3),
legit — HEAD correctly = f80d676. No stale status in target rows (the "Deploy pendiente" hits
elsewhere are historical day-logs or vlcrm-deploy, not the landing).
