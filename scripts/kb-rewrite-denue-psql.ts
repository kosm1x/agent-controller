/**
 * Rewrite the three DENUE directive rows that still teach `psql -U postgres … -c "…"`
 * into the ruling-5a form the shell gate accepts: `psql -U mcp_readonly … -c '…'`.
 *
 * `directives/` is a managed namespace (MANAGED_NAMESPACES in src/db/jarvis-reindex.ts):
 * the hourly disk walk never refreshes it, so the rows change through upsertFile here
 * (registry + disk mirror), keeping each row's own metadata, with skipUserEdit.
 * Two passes: every path is rewritten and judged by the live shell gate first; one
 * missing/refused path means nothing is written.
 * The pgvector/Drive copies refresh only when the run has the service env
 * (COMMIT_DB_KEY, DRIVE_KB_FOLDER_ID): run it from a subshell that sources that env.
 *
 * Usage:
 *   npx tsx scripts/kb-rewrite-denue-psql.ts            # dry run (default): counts + -/+ lines
 *   npx tsx scripts/kb-rewrite-denue-psql.ts --apply    # write, then verify row + mirror
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initDatabase, closeDatabase } from "../src/db/index.js";
import { getFile, getKbMirrorWriteDir, upsertFile } from "../src/db/jarvis-fs.js";
import { requireOperatorContext } from "../src/lib/operator-gate.js";
import { isMainModule as isEntryModule } from "../src/lib/is-main-module.js";
import { drainKbWrites } from "../src/db/kb-write-drain.js";
import { validateShellCommand } from "../src/tools/builtin/shell.js";

export const TARGET_PATHS = [
  "directives/denue-access-card.md",
  "directives/denue-analyzer-granularities.md",
  "directives/data-doc-authoring.md",
];

type LineIssue = { line: number; reason: string };
type Change = { line: number; before: string[]; after: string };
type Status = "rewritten" | "nothing-to-do" | "missing" | "refused" | "gate-refused" | "verify-failed";

const ROLE = /(^|\s)-U\s*postgres(?![\w-])/g;
const STILL_POSTGRES = /-U\s*['"]?postgres(?![\w-])|--username(?:=|\s+)['"]?postgres(?![\w-])/;

/** End of the shell command starting at `from`: first unquoted | ; & or backtick. */
function commandEnd(line: string, from: number): number {
  let quote = "";
  for (let i = from; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === "'" || ch === '"') quote = ch;
    else if ("|;&`".includes(ch)) return i;
  }
  return line.length;
}

/** Role + quote swap inside each psql command of one line; other commands are untouched. */
function rewriteLine(line: string, lineNo: number, refused: LineIssue[]): { text: string; roles: number; quotes: number } {
  let roles = 0;
  let quotes = 0;
  let out = "";
  let pos = 0;
  for (const m of line.matchAll(/\bpsql\b/g)) {
    if (m.index < pos) continue;
    const end = commandEnd(line, m.index);
    const seg = line.slice(m.index, end).replace(ROLE, (_all, pre: string) => {
      roles++;
      return `${pre}-U mcp_readonly`;
    });
    let cmd = "";
    let i = 0;
    const span = /(?<=^|\s)-c "/g;
    for (let s = span.exec(seg); s; s = span.exec(seg)) {
      const close = seg.indexOf('"', s.index + 4);
      if (close < 0) {
        refused.push({ line: lineNo, reason: "-c span does not close on this line" });
        break;
      }
      const inner = seg.slice(s.index + 4, close);
      if (/['\\$]/.test(inner)) refused.push({ line: lineNo, reason: "-c span holds a single quote, backslash or $" });
      else {
        cmd += `${seg.slice(i, s.index)}-c '${inner}'`;
        i = close + 1;
        quotes++;
      }
      span.lastIndex = close + 1;
    }
    cmd += seg.slice(i);
    if (STILL_POSTGRES.test(cmd)) refused.push({ line: lineNo, reason: "psql still runs as postgres" });
    out += line.slice(pos, m.index) + cmd;
    pos = end;
  }
  return { text: out + line.slice(pos), roles, quotes };
}

/** Pure: joins ` \` continuation runs that hold psql, then swaps; refusals carry line numbers, never text. */
export function rewriteDenuePsql(content: string): {
  content: string;
  roleSwaps: number;
  quoteSwaps: number;
  refused: LineIssue[];
  changes: Change[];
} {
  const src = content.split("\n");
  const refused: LineIssue[] = [];
  const changes: Change[] = [];
  const out: string[] = [];
  let roleSwaps = 0;
  let quoteSwaps = 0;
  for (let k = 0; k < src.length; k++) {
    const first = k;
    let text = src[k]!;
    let last = k;
    let dangling = "";
    // Join first, then decide: psql may sit on any line of the run. A blank line or fence ends it.
    while (/\s\\$/.test(text)) {
      const next = src[last + 1];
      if (next === undefined || next.trim() === "") {
        dangling = "line continuation runs into a blank line or end of text";
        break;
      }
      if (next.trimStart().startsWith("```")) {
        dangling = "line continuation runs into a code fence";
        break;
      }
      text = `${text.replace(/\s*\\$/, "")} ${next.trimStart()}`;
      last++;
    }
    if (!text.includes("psql")) {
      out.push(src[k]!);
      continue;
    }
    k = last;
    if (dangling) refused.push({ line: first + 1, reason: dangling });
    const r = rewriteLine(text, first + 1, refused);
    roleSwaps += r.roles;
    quoteSwaps += r.quotes;
    text = r.text;
    const before = src.slice(first, k + 1);
    if (before.length > 1 || before[0] !== text) changes.push({ line: first + 1, before, after: text });
    out.push(text);
  }
  return { content: out.join("\n"), roleSwaps, quoteSwaps, refused, changes };
}

/**
 * Every command span holding the gate's own trigger `supabase-db psql`, judged WHOLE by the
 * live shell gate: each backtick-delimited part of a line (in or out of a code span, closing
 * backtick excluded), from its last `docker exec` before the trigger. Other spans are skipped.
 */
export function gateCheck(content: string): LineIssue[] {
  const issues: LineIssue[] = [];
  content.split("\n").forEach((text, idx) => {
    // Every backtick-delimited part, inside a code span or outside one.
    for (const span of text.split("`")) {
      const trigger = span.indexOf("supabase-db psql");
      if (trigger < 0) continue;
      const verdict = validateShellCommand(span.slice(Math.max(0, span.lastIndexOf("docker exec", trigger))).trim());
      if (!verdict.allowed) issues.push({ line: idx + 1, reason: verdict.reason ?? "refused" });
    }
  });
  return issues;
}

/** Original line number of a line of the rewritten content (joins shift the numbering). */
function originalLine(changes: Change[], outLine: number): number {
  let line = outLine;
  for (const c of changes) {
    if (c.line >= line) break;
    line += c.before.length - 1;
  }
  return line;
}

function readMirror(dir: string, path: string): string | null {
  try {
    return readFileSync(join(dir, path), "utf-8");
  } catch {
    return null;
  }
}

export function runRewrite(opts: { apply: boolean; paths?: string[] }): {
  results: Array<{ path: string; status: Status; roleSwaps: number; quoteSwaps: number }>;
  ok: boolean;
  /** Rows passed to upsertFile (each one leaves syncs + an INDEX.md mark to drain). */
  written: number;
} {
  // Pass 1: plan + judge every path; nothing is written here.
  const plans = (opts.paths ?? TARGET_PATHS).map((path) => {
    const row = getFile(path);
    const r = rewriteDenuePsql(row?.content ?? "");
    const gate = gateCheck(r.content);
    let status: Status = "rewritten";
    if (!row) status = "missing";
    else if (r.refused.length > 0) status = "refused";
    else if (gate.length > 0) status = "gate-refused";
    else if (r.content === row.content) status = "nothing-to-do";
    for (const i of r.refused) console.log(`  ${path}:${i.line} ${i.reason}`);
    for (const i of status === "gate-refused" ? gate : []) {
      console.log(`  ${path}:${originalLine(r.changes, i.line)} ${i.reason}`);
    }
    return { path, row, r, status };
  });
  const mirrorDir = getKbMirrorWriteDir();
  const blocked = plans.some((p) => p.status !== "rewritten" && p.status !== "nothing-to-do");
  if (opts.apply && blocked) console.log("[kb-rewrite] nothing written: a path is missing or refused");
  // Pass 2: apply only when no path is blocked.
  let written = 0;
  const results = plans.map(({ path, row, r, status: planned }) => {
    let status: Status = planned;
    let tag = "";
    if (status === "rewritten" && !opts.apply) {
      tag = " (dry run)";
      for (const c of r.changes) console.log(`  ${path}:${c.line}\n${c.before.map((b) => `  - ${b}`).join("\n")}\n  + ${c.after}`);
    } else if (status === "rewritten" && blocked) tag = " (not written: another path is blocked)";
    else if (status === "rewritten" && mirrorDir === null) {
      status = "verify-failed";
      tag = " (no mirror for this db; nothing written)";
    } else if (row && status === "rewritten" && mirrorDir !== null) {
      const tags = JSON.parse(row.tags) as string[];
      const related = JSON.parse(row.related_to) as string[];
      upsertFile(path, row.title, r.content, tags, row.qualifier, row.priority, row.condition, related, {
        skipUserEdit: true,
      });
      written++;
      if (getFile(path)?.content !== r.content) [status, tag] = ["verify-failed", " (row differs)"];
      else if (readMirror(mirrorDir, path) !== r.content) [status, tag] = ["verify-failed", " (mirror differs)"];
    }
    const pass = (status === "rewritten" || status === "nothing-to-do") && !(blocked && opts.apply);
    console.log(
      `${pass ? "PASS" : "FAIL"} ${path} status=${status} roleSwaps=${r.roleSwaps} quoteSwaps=${r.quoteSwaps}${tag}`,
    );
    return { path, status, roleSwaps: r.roleSwaps, quoteSwaps: r.quoteSwaps };
  });
  return { results, written, ok: !blocked && results.every((x) => x.status === "rewritten" || x.status === "nothing-to-do") };
}

/** True only when this file is the process entry point (never when a test imports it). */
export function isMainModule(): boolean {
  return isEntryModule(import.meta.url);
}

type MainDeps = {
  requireOperatorContext: (tag: string, opts: { tty: boolean }) => void;
  initDatabase: (path: string) => unknown;
  closeDatabase: () => void;
  runRewrite: (opts: { apply: boolean }) => { ok: boolean; written: number };
  drainKbWrites: () => Promise<void>;
};

/** Operator entry: the gate runs before any db/KB side effect. Returns the exit code. */
export async function main(
  deps: MainDeps = {
    requireOperatorContext,
    initDatabase,
    closeDatabase,
    runRewrite,
    drainKbWrites,
  },
): Promise<number> {
  // S6 item 3c: operator context only, before any db/KB side effect.
  deps.requireOperatorContext("kb-rewrite-denue-psql", { tty: false });
  const apply = process.argv.includes("--apply");
  deps.initDatabase(process.env.MC_DB_PATH ?? "./data/mc.db");
  const { ok, written } = deps.runRewrite({ apply });
  // upsertFile's syncs + INDEX.md outlive the call: drain while the db is open.
  if (written > 0) await deps.drainKbWrites();
  deps.closeDatabase();
  if (!apply) console.log("[kb-rewrite] dry run — pass --apply to write");
  return ok ? 0 : 1;
}

// No process.exit: main drains the fire-and-forget pgvector/Drive syncs and INDEX.md (drainKbWrites) before closing the db.
if (isMainModule()) process.exitCode = await main();
