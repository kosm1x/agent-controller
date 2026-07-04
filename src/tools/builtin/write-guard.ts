/**
 * Shared write-guard helpers for the git / shell / file tools.
 *
 * Two concerns the per-tool allow-lists don't cover on their own:
 *  1. symlink escape — an allow-list that checks the LITERAL path lets a symlink
 *     living inside an allowed dir but pointing OUTSIDE it smuggle a write past
 *     the deny/immutable/allow gates. `realResolve` follows symlinks first.
 *  2. operator config — a broad `/root/claude/` allow-list (every project repo
 *     lives there) also exposes the operator's OWN Claude Code config that sits
 *     directly under /root/claude/. `isOperatorConfigPath` re-denies that surface.
 */

import { resolve, dirname, join, basename } from "path";
import { realpathSync } from "fs";

const CLAUDE_HOME = "/root/claude/";

/**
 * Resolve to the real on-disk path, following symlinks, BEFORE any allow/deny
 * check — so a symlink inside an allowed dir that points elsewhere can't smuggle
 * a write past the gates. For a not-yet-existing leaf (realpathSync throws),
 * realpath the nearest existing ancestor and re-attach the missing tail. On any
 * failure, fall back to the literal absolute path — no worse than the previous
 * resolve()-only behavior, so mocked-fs tests degrade gracefully.
 */
export function realResolve(p: string): string {
  const abs = resolve(p);
  const tail: string[] = [];
  let head = abs;
  for (let i = 0; i < 64; i++) {
    try {
      const real = realpathSync(head);
      return tail.length ? join(real, ...tail.slice().reverse()) : real;
    } catch {
      const parent = dirname(head);
      if (parent === head) break;
      tail.push(basename(head));
      head = parent;
    }
  }
  return abs;
}

/**
 * The operator's own governance/config surface directly under /root/claude/:
 * the Claude Code config + hooks (.claude/), MCP server config (.mcp.json), env,
 * and the umbrella CLAUDE.md. These are NOT project content (which lives under a
 * named repo directory at depth >= 2, e.g. /root/claude/vlcrm/…) and they govern
 * the operator's OWN sessions — a settings/hook rewrite is command execution on
 * the operator's next tool call. Any TOP-LEVEL dotfile/dotdir qualifies, so a
 * future one is protected without editing a list. A repo's own CLAUDE.md (depth
 * >= 2) is project content and stays writable; only the umbrella one is blocked.
 */
export function isOperatorConfigPath(resolved: string): boolean {
  if (resolved === "/root/claude/CLAUDE.md") return true;
  if (!resolved.startsWith(CLAUDE_HOME)) return false;
  const firstSegment = resolved.slice(CLAUDE_HOME.length).split("/")[0];
  return firstSegment.startsWith(".");
}
