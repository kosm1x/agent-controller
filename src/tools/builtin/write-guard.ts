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

import { resolve, dirname, join } from "path";
import { lstatSync, readlinkSync } from "fs";

const CLAUDE_HOME = "/root/claude/";

/**
 * Resolve to the real on-disk path, following symlinks, BEFORE any allow/deny
 * check — so a symlink inside an allowed dir that points elsewhere can't smuggle
 * a write past the gates. Walks the path one component at a time as the kernel
 * does: a symlink (dangling too — a write creates its target) is replaced by
 * its target, and `..` steps up from the REAL directory reached so far, never
 * from the spelling. path.resolve() and realpathSync both collapse `evil/..`
 * as text, which named a different file than the one the write lands in when
 * `evil` is a directory symlink (audit 2026-09-22 R1 C1, R2 C2). From the
 * first component that does not exist (or when lstat fails, e.g. a mocked fs)
 * the rest is joined as text: the write creates it, and a `..` below a
 * missing directory fails with ENOENT anyway. After 40 symlink hops the
 * kernel refuses with ELOOP; the literal path is returned.
 */
export function realResolve(p: string): string {
  const pending = (p.startsWith("/") ? p : `${process.cwd()}/${p}`).split("/");
  let cur = "/";
  let hops = 0;
  while (pending.length > 0) {
    const part = pending.shift()!;
    if (part === "" || part === ".") continue;
    if (part === "..") {
      cur = dirname(cur); // `cur` is real, so this is the kernel's parent
      continue;
    }
    const next = join(cur, part);
    let target: string;
    try {
      if (!lstatSync(next).isSymbolicLink()) {
        cur = next;
        continue;
      }
      target = readlinkSync(next);
    } catch {
      return resolve(next, ...pending);
    }
    if (++hops > 40) return resolve(p);
    if (target.startsWith("/")) cur = "/";
    pending.unshift(...target.split("/"));
  }
  return cur;
}

/**
 * The path unlink/rm acts on: the parent directory resolved as the kernel
 * does, the final component NOT followed (rm removes a symlink itself).
 */
export function realResolveParent(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  const base = trimmed.slice(i + 1);
  if (base === "" || base === "." || base === "..") return realResolve(p);
  return join(realResolve(i < 0 ? "." : trimmed.slice(0, i) || "/"), base);
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
