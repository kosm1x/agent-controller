/**
 * The one positional write boundary: which paths Jarvis may write, edit or
 * delete at all. file_write, file_edit, file_delete and shell_exec's captured
 * write targets all decide position here, so a rule added once applies to
 * every tool (pinned by write-boundary-parity.test.ts). Each tool keeps its
 * own tool-specific checks (path-safety pipeline, read denylist, delete depth
 * and confirmation, shell redirect handling).
 *
 * Callers pass an already symlink-resolved path (`realResolve`, or
 * `realResolveParent` for delete) and the KB root (`getJarvisKbRoot()`): the
 * module stays free of db imports so it never joins the db/tool import cycle.
 */

import { relative, resolve } from "path";
import {
  MC_PRIMARY_ROOT,
  MC_WORKTREE_ROOT,
  NORTHSTAR_DISK_REASON,
  holdsImmutableCorePath,
  isImmutableCorePath,
  isNorthStarDiskPath,
  isProjectRecordDiskPath,
  isSkillFileDiskPath,
  isStandingOrdersDiskPath,
} from "./immutable-core.js";
import { isOperatorConfigPath } from "./write-guard.js";

/** What the caller is about to do; rules whose blast radius differs by operation key on it. */
export type WriteOp = "write" | "edit" | "delete";

export type BoundaryRule =
  | "immutable"
  | "operator-config"
  | "standing-orders"
  | "northstar"
  | "project-record"
  | "skill-file"
  | "day-log"
  | "kb-root"
  | "primary-checkout"
  | "operator-home"
  | "system-dir"
  | "outside-allow-list";

export type BoundaryVerdict =
  /** `prefix` is the allow-list entry that admitted the path. */
  | { allowed: true; prefix: string }
  | { allowed: false; rule: BoundaryRule; reason: string };

/** The refusal sentence for a model write under `logs/day-logs/` (all writers share it). */
export const DAY_LOG_MANAGED =
  "logs/day-logs/ is mechanically managed (verbatim interaction log). Write the narrative companion to logs/day-narratives/ instead.";

/**
 * The path list (relative to the checkout root) quoted in the
 * self-improvement instructions (jarvis-self-repair.ts,
 * rituals/autonomous-improvement.ts). Kept in this protected file so the
 * instructions have one source.
 */
export const SELF_IMPROVEMENT_ALLOWED: readonly string[] = [
  "src/tools/",
  "src/intel/",
  "src/messaging/scope.ts",
  "src/messaging/prompt-sections.ts",
  "src/video/",
];

/**
 * Operational logs in the primary checkout that rituals append to. Only a
 * plain write may reach them (shell_exec additionally requires an append);
 * edit and delete stay refused like the rest of the primary checkout.
 */
export const RITUAL_WRITABLE_DOCS: readonly string[] = ["docs/EVOLUTION-LOG.md"];

/** Never project content, whatever the allow-list says. */
const DENY_PREFIXES: ReadonlyArray<{ prefix: string; rule: BoundaryRule }> = [
  { prefix: "/root/.claude/", rule: "operator-home" },
  { prefix: "/etc/", rule: "system-dir" },
  { prefix: "/usr/", rule: "system-dir" },
  { prefix: "/var/", rule: "system-dir" },
];

/**
 * Where Jarvis may write, edit or delete at all: the KB root, every project
 * repo (`/root/claude/`), scratch (`/tmp/`) and the container worker's clone
 * (`/workspace/`). The allow-list is checked LAST, after every deny rule, so
 * `/root/claude/` does not weaken the protected checkouts or the operator
 * config inside it.
 */
export function getAllowWritePrefixes(kbRoot: string): string[] {
  return [
    `${kbRoot}/`, // may resolve outside /root/claude via JARVIS_KB_MIRROR_DIR
    "/root/claude/",
    "/tmp/",
    "/workspace/",
  ];
}

const refuse = (rule: BoundaryRule, reason: string): BoundaryVerdict => ({
  allowed: false,
  rule,
  reason,
});

/**
 * Decide whether `resolved` may be written / edited / deleted.
 * Order: protected files, operator config, KB-managed trees, deny prefixes,
 * the primary checkout, then the allow-list. In Jarvis's worktree only the
 * protected files and prefixes are refused.
 */
export function checkWriteBoundary(
  input: string,
  op: WriteOp,
  kbRootInput: string,
): BoundaryVerdict {
  // Every rule below sees the normalized path and KB root, so `..` segments,
  // `//`, `./` or a trailing slash in either value cannot change the verdict.
  const resolved = resolve(input);
  const kbRoot = resolve(kbRootInput);
  const imm =
    op === "delete"
      ? (() => {
          const file = isImmutableCorePath(resolved);
          return file.immutable ? file : holdsImmutableCorePath(resolved);
        })()
      : isImmutableCorePath(resolved);
  if (imm.immutable) {
    return refuse("immutable", `${imm.reason}. This file cannot be modified by Jarvis.`);
  }
  // The operator's own config (.claude/ settings+hooks, .mcp.json, umbrella
  // CLAUDE.md) sits under /root/claude/ but is not project content —
  // rewriting it is a guardrail/command-execution vector.
  if (isOperatorConfigPath(resolved)) {
    return refuse(
      "operator-config",
      `${resolved} is operator config (Claude Code settings/hooks, MCP config, or umbrella CLAUDE.md), not project content.`,
    );
  }
  // Standing orders on disk: the disk copy is operator-facing and the hourly
  // kb-reindex would import it as a live row.
  if (isStandingOrdersDiskPath(resolved, kbRoot)) {
    return refuse(
      "standing-orders",
      `${resolved} is a standing order (jarvis-kb/directives/) — changes go through jarvis_propose_directive`,
    );
  }
  if (isNorthStarDiskPath(resolved, kbRoot)) {
    return refuse("northstar", NORTHSTAR_DISK_REASON);
  }
  // A project record is changed only through project_update.
  if (isProjectRecordDiskPath(resolved, kbRoot)) {
    return refuse(
      "project-record",
      `${resolved} is a project record (jarvis-kb/projects/<slug>/project.md) — PROJECT_RECORD_PROTECTED: change the project with project_update`,
    );
  }
  // A recursive delete of skills/ or skills/<name>/ takes SKILL.md with it;
  // a write or edit targets the file itself.
  const kbRel = relative(kbRoot, resolved).toLowerCase();
  if (
    isSkillFileDiskPath(resolved, kbRoot) ||
    (op === "delete" && /^skills(?:\/[^/]+)?$/.test(kbRel))
  ) {
    return refuse(
      "skill-file",
      `${resolved} is a skill definition — write skills/<name>/SKILL.md with jarvis_file_write, which runs the skill critic and registers the version`,
    );
  }
  // The day-log is registry-managed: a write or edit reaches it through the
  // registry path (same KB-relative .md form as kbRegistryPath); a delete of
  // the tree or a directory above it would erase the record of work.
  const root = `${kbRoot}/`;
  const isDayLog =
    op === "delete"
      ? kbRel === "logs" || kbRel === "logs/day-logs" || kbRel.startsWith("logs/day-logs/")
      : resolved.startsWith(root) &&
        /\.md$/i.test(resolved) &&
        resolved.slice(root.length).startsWith("logs/day-logs/");
  if (isDayLog) return refuse("day-log", DAY_LOG_MANAGED);
  // A recursive delete of the KB root (or a directory above it) takes the
  // day-log and skills trees with it.
  if (op === "delete" && (resolved === kbRoot || kbRoot.startsWith(`${resolved.replace(/\/+$/, "")}/`))) {
    return refuse(
      "kb-root",
      `${resolved} is or contains the KB root (${kbRoot}), which holds the managed logs/day-logs/ and skills/ trees`,
    );
  }

  for (const { prefix, rule } of DENY_PREFIXES) {
    if (resolved.startsWith(prefix)) {
      return refuse(
        rule,
        `${prefix} is protected. Jarvis cannot modify its own source code or system files.`,
      );
    }
  }
  // The primary checkout is operator-session territory whatever branch it is
  // on; Jarvis's mission-control work happens in the worktree.
  if (resolved === MC_PRIMARY_ROOT.slice(0, -1) || resolved.startsWith(MC_PRIMARY_ROOT)) {
    const rel = resolved.slice(MC_PRIMARY_ROOT.length);
    if (!(op === "write" && RITUAL_WRITABLE_DOCS.includes(rel))) {
      return refuse(
        "primary-checkout",
        `${MC_PRIMARY_ROOT} is protected: it is the operator's checkout. Jarvis's mission-control changes go in ${MC_WORKTREE_ROOT} (jarvis_dev).`,
      );
    }
  }
  const allow = getAllowWritePrefixes(kbRoot);
  const prefix = allow.find((p) => resolved.startsWith(p));
  if (prefix !== undefined) return { allowed: true, prefix };
  return refuse(
    "outside-allow-list",
    `${resolved} is outside allowed paths (${allow.join(", ")})`,
  );
}
