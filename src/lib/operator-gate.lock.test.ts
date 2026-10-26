/**
 * S6 queue item 3c — LOCK: every db/KB-writing script and every mc-ctl RW
 * subcommand is behind the operator-context gate (src/lib/operator-gate.ts,
 * scripts/lib/operator-gate.sh). A new unguarded script, a new unclassified
 * mc-ctl subcommand or a dropped GATED_SUBCOMMANDS entry turns this red.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateShellCommand } from "../tools/builtin/shell.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const LIB = join(ROOT, "scripts/lib/operator-gate.sh");
const MC_CTL = readFileSync(join(ROOT, "mc-ctl"), "utf8");

/** Source without comments (a doc comment naming initDatabase is not a call). */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .map((l) => l.replace(/\s\/\/.*$/, ""))
    .join("\n");
}

const WRITE_MARKERS =
  /initDatabase|getDatabase|upsertFromDiskWrite|upsertFile\(|writeFileSync|fs\.writeFile|appendFileSync|createWriteStream|renameSync|copyFileSync|openSync\([^)]*["'][wa]|execSync\([^\n]*sqlite3|import\(\s*["'][^"']*\/db\/index\.js["']\s*\)/;
/** fs/promises (any import shape) plus one of its writers. */
const FS_PROMISES = /from\s+["'](?:node:)?fs\/promises["']|\bfs\.promises\b|\bpromises\b[^;\n]*from\s+["'](?:node:)?fs["']/;
const ASYNC_FS_WRITE = /\b(?:writeFile|appendFile|rename|copyFile)\s*\(/;
/** better-sqlite3 bindings: the module import is the marker, whatever the local name. */
const SQLITE_IMPORT = [
  /import\s+(?!type\s)([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\}\s*)?from\s+["']better-sqlite3["']/g,
  /import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["']better-sqlite3["']/g,
  /import\s+\{[^}]*\bdefault\s+as\s+([A-Za-z_$][\w$]*)[^}]*\}\s+from\s+["']better-sqlite3["']/g,
  /([A-Za-z_$][\w$]*)\s*=\s*require\(\s*["']better-sqlite3["']\s*\)/g,
];

/** String literal bodies blanked (a `"readonly: true"` string is not an option). */
const noStrings = (src: string): string =>
  src.replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g, '""');

/** Text between the `(` at `open` and its matching `)` (unbalanced → the rest of the file). */
function parenArgs(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

/** Does this script (comments stripped) write the db, the KB or data/? */
function writes(src: string): boolean {
  if (WRITE_MARKERS.test(src) || (FS_PROMISES.test(src) && ASYNC_FS_WRITE.test(src))) return true;
  if (/import\(\s*["']better-sqlite3["']\s*\)/.test(src)) return true;
  const aliases = new Set<string>(["Database"]);
  let imported = false;
  for (const re of SQLITE_IMPORT) for (const m of src.matchAll(re)) (aliases.add(m[1]), (imported = true));
  const bare = noStrings(src);
  let opens = 0;
  for (const alias of aliases) {
    for (const m of bare.matchAll(new RegExp(`(?<![\\w$.])${alias.replace(/\$/g, "\\$")}\\s*\\(`, "g"))) {
      opens++;
      if (!/(?:^|[{,\s])readonly\s*:\s*true\b/.test(parenArgs(bare, m.index + m[0].length - 1))) return true;
    }
  }
  return imported && opens === 0; // imported but opened some other way: judged a writer
}

describe("scripts/*.{ts,mjs} — db/KB writers are operator-context gated", () => {
  const scripts = readdirSync(join(ROOT, "scripts")).filter((f) => /\.(?:ts|mjs)$/.test(f) && !f.endsWith(".test.ts"));

  it("finds the scripts", () => {
    expect(scripts.length).toBeGreaterThan(50);
    expect(scripts).toContain("kb-preview-directive.mjs");
  });

  it.each(scripts)("%s", (file) => {
    const src = code(readFileSync(join(ROOT, "scripts", file), "utf8"));
    if (!writes(src)) return; // read-only (or no db/KB at all)
    expect(src, `${file} writes db/KB/data but has no operator gate`).toMatch(
      /requireOperatorContext\(\s*"[\w-]+",\s*\{\s*tty:\s*false\s*\}\s*\)|requireOperatorTerminal\(/,
    );
  });

  it.each([
    ["aliased import", 'import Sqlite from "better-sqlite3";\nconst db = new Sqlite("data/mc.db");', true],
    ["factory call without new", 'import Database from "better-sqlite3";\nconst db = Database("data/mc.db");', true],
    ["read-only open then a read-write one", 'import Database from "better-sqlite3";\nconst a = new Database(p, { readonly: true });\nconst b = new Database(p);', true],
    ["no semicolons", 'import Database from "better-sqlite3"\nconst b = new Database(p)\nconst a = new Database(q, { readonly: true });', true],
    ["readonly only inside a string", 'import Database from "better-sqlite3";\nconst b = new Database(p, { fileMustExist: true, x: "readonly: true" });', true],
    ["imported, opened indirectly", 'import Database from "better-sqlite3";\nconst open = Reflect.construct;\nopen(Database, [p]);', true],
    ["namespace import", 'import * as S from "better-sqlite3";\nnew S.default(p);', true],
    ["require", 'const D = require("better-sqlite3");\nnew D(p);', true],
    ["fs.promises named import", 'import { promises as fs } from "node:fs";\nawait fs.writeFile(p, s);', true],
    ["fs/promises default import", 'import fsp from "node:fs/promises";\nawait fsp.writeFile(p, s);', true],
    ["fs/promises named writeFile", 'import { writeFile } from "node:fs/promises";\nawait writeFile(p, s);', true],
    ["fs/promises appendFile", 'import { appendFile } from "fs/promises";\nawait appendFile(p, s);', true],
    ["fs/promises rename", 'import { rename } from "node:fs/promises";\nawait rename(a, b);', true],
    ["fs/promises copyFile", 'import { copyFile } from "node:fs/promises";\nawait copyFile(a, b);', true],
    ["createWriteStream", 'import { createWriteStream } from "node:fs";\ncreateWriteStream(p).write(s);', true],
    ["renameSync", 'import { renameSync } from "node:fs";\nrenameSync(a, b);', true],
    ["copyFileSync", 'import { copyFileSync } from "node:fs";\ncopyFileSync(a, "data/mc.db");', true],
    ["openSync for write", 'import { openSync, writeSync } from "node:fs";\nwriteSync(openSync(p, "w"), s);', true],
    ["openSync for append", "import { openSync } from 'node:fs';\nopenSync(p, 'a');", true],
    ["execSync sqlite3", 'import { execSync } from "node:child_process";\nexecSync(`sqlite3 data/mc.db "DELETE FROM t"`);', true],
    ["dynamic import of the db module", 'const m = await import("../src/db/index.js");\nm.x();', true],
    ["dist db import in an .mjs one-shot", 'import { initDatabase } from "../dist/db/index.js";\ninitDatabase(p);', true],
    ["read-only better-sqlite3", 'import Database from "better-sqlite3";\nconst db = new Database(p, { readonly: true, fileMustExist: true });', false],
    ["type-only import", 'import type Database from "better-sqlite3";\nlet db: Database.Database;', false],
    ["fs/promises read only", 'import { readFile } from "node:fs/promises";\nawait readFile(p, "utf8");', false],
    ["openSync for read", 'import { openSync } from "node:fs";\nopenSync(p, "r");', false],
  ])("marker: %s → writer=%s", (_n, src, expected) => {
    expect(writes(code(src as string))).toBe(expected);
  });

  it("{ tty: true } stays only on the two 5a record scripts", () => {
    const tty = scripts.filter((f) => /requireOperatorTerminal\(|tty:\s*true/.test(code(readFileSync(join(ROOT, "scripts", f), "utf8"))));
    expect(tty.sort()).toEqual(["project-record-create.ts", "project-record-export.ts"]);
  });
});

// ---------------------------------------------------------------------------
// mc-ctl: every routed command is classified; RW ones are in GATED_SUBCOMMANDS.
// ---------------------------------------------------------------------------
const RW_COMMANDS = [
  "start", "stop", "restart", "cancel", "schedule-delete", "schedule-resume", "hindsight-restart",
  "audit-claim", "jme-dedup", "briefing-gate", "v83-gate", "v83-promote", "rule-of-two",
  "project-create", "judgments", "close-phase", "resume", "task-resume", "audit-closure", "smoke", "eval",
];
/** RW for the operator, read-only elsewhere (V8.4 gate checks run `mc-ctl db "SELECT …"` from tasks). */
const SPLIT_COMMANDS = ["db"];
const RO_COMMANDS = [
  "status", "logs", "follow", "tasks", "task", "outcomes", "reactions", "schedules", "tools", "tool-health",
  "conversations", "memory", "hindsight-status", "hindsight-logs", "recall-utility", "outcome-distribution",
  "recall-compare", "drift", "skill-health", "recall-modes", "verdict-rate", "trace", "sandboxes", "usability",
  "project", "budget", "tuning", "intel", "tool-chains", "stats", "jme-stats", "kb-health", "memory-checklist",
  "validation", "help", "--help", "-h", "*",
];
/** command → [handler, RW subs, RO subs ("" = no sub; "*" = unknown)]. */
const MIXED: Record<string, [string, string[], string[]]> = {
  skills: ["cmd_skills", ["backfill-embeddings", "retrieve", "certify", "archive", "revert"], ["list", "show", "", "help", "--help", "-h", "*"]],
  "jme-preferences": ["cmd_jme_preferences", ["--confirm", "--reject"], ["", "*"]],
  events: ["cmd_events", ["retrieve", "aggregate", "seed"], ["list", "show", "", "help", "--help", "-h", "*"]],
  cohort: ["cmd_cohort", ["rollup"], ["list", "show", "", "help", "--help", "-h", "*"]],
  gates: ["cmd_gates", ["set-ritual"], ["", "summary", "graded", "status-sources", "*"]],
  "mcp-token": ["cmd_mcp_token", ["create", "revoke"], ["list", "", "help", "--help", "-h", "*"]],
  monitoring: ["cmd_monitoring", ["up", "down"], ["status", "*"]],
};
const GATED_EXPECTED = [...RW_COMMANDS, ...Object.entries(MIXED).flatMap(([c, [, rw]]) => rw.map((s) => `${c} ${s}`))];

const LABEL = /^((?:"[^"]*"|[A-Za-z0-9*_-]+)(?:\s*\|\s*(?:"[^"]*"|[A-Za-z0-9*_-]+))*)\)/;
const labels = (line: string): string[] =>
  line.split("|").map((l) => l.trim().replace(/^"(.*)"$/, "$1"));

function routerLabels(): string[] {
  const start = MC_CTL.lastIndexOf('\ncase "$cmd" in\n');
  const body = MC_CTL.slice(start, MC_CTL.indexOf("\nesac", start));
  return body
    .split("\n")
    .filter((l) => /^ {2}\S/.test(l))
    .flatMap((l) => {
      const m = LABEL.exec(l.slice(2));
      return m ? labels(m[1]) : [];
    });
}

function handlerSubLabels(fn: string): string[] {
  const start = MC_CTL.indexOf(`\n${fn}() {`);
  expect(start, fn).toBeGreaterThan(0);
  const rest = MC_CTL.slice(start + 1);
  const end = rest.slice(1).search(/\n[A-Za-z_][A-Za-z0-9_]*\(\) \{/);
  return rest
    .slice(0, end + 1)
    .split("\n")
    .filter((l) => /^ {4}\S/.test(l))
    .flatMap((l) => {
      const m = LABEL.exec(l.slice(4));
      return m ? labels(m[1]) : [];
    });
}

function bash(script: string, ...args: string[]): string {
  const r = spawnSync("bash", ["-c", `source "$1"; shift; ${script}`, "_", LIB, ...args], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

describe("mc-ctl — RW subcommands are operator-context gated", () => {
  it("every routed command is classified RW, RO or mixed (a new subcommand must be classified here)", () => {
    const routed = routerLabels();
    expect(routed.length).toBeGreaterThan(60);
    const known = new Set([...RW_COMMANDS, ...RO_COMMANDS, ...SPLIT_COMMANDS, ...Object.keys(MIXED)]);
    expect(routed.filter((l) => !known.has(l)), "unclassified mc-ctl command").toEqual([]);
    expect([...known].filter((k) => !routed.includes(k)), "classified but not routed").toEqual([]);
  });

  it.each(Object.entries(MIXED))("%s: every sub-case is classified", (_c, [fn, rw, ro]) => {
    expect(handlerSubLabels(fn).sort()).toEqual([...rw, ...ro].sort());
  });

  it("GATED_SUBCOMMANDS (the list mc-ctl's router reads) is exactly the RW classification", () => {
    const gated = bash('printf "%s\\n" "${GATED_SUBCOMMANDS[@]}"').trim().split("\n");
    expect(gated.sort()).toEqual([...GATED_EXPECTED].sort());
  });

  it("_mc_ctl_gated: RW → gated; RO commands and RO subs → not", () => {
    const probe = (cmd: string, sub: string) => bash('_mc_ctl_gated "$1" "$2" && echo y || echo n', cmd, sub).trim();
    for (const c of RW_COMMANDS) expect(probe(c, ""), c).toBe("y");
    for (const c of RW_COMMANDS) expect(probe(c, "anything"), c).toBe("y");
    for (const [c, [, rw, ro]] of Object.entries(MIXED)) {
      for (const s of rw) expect(probe(c, s), `${c} ${s}`).toBe("y");
      for (const s of ro) expect(probe(c, s), `${c} ${s}`).toBe("n");
    }
    for (const c of RO_COMMANDS) expect(probe(c, ""), c).toBe("n");
  });

  it("the router sources the gate and calls it before dispatch", () => {
    const start = MC_CTL.lastIndexOf('\ncase "$cmd" in\n');
    const head = MC_CTL.slice(MC_CTL.lastIndexOf('\ncmd="${1:-help}"\n'), start);
    expect(head).toMatch(/\nsource "\$\{PROJECT_DIR\}\/scripts\/lib\/operator-gate\.sh"\n/);
    expect(head).toMatch(/\nif _mc_ctl_gated "\$cmd" "\$\{1:-\}"; then require_operator_context; SQLITE_RO=\(\); fi\n/);
  });

  it("db: the shell is operator-only; SQL runs RW only in an operator context, read-only elsewhere", () => {
    const fn = MC_CTL.slice(MC_CTL.indexOf("\ncmd_db() {"), MC_CTL.indexOf("\n}\n", MC_CTL.indexOf("\ncmd_db() {")));
    expect(fn).toMatch(/if \[ \$# -eq 0 \]; then\n\s+require_operator_context/);
    expect(fn).toMatch(/elif \[ -z "\$\(_operator_context_reason "\$\(cat \/proc\/self\/cgroup[^\n]*\)" 0 0\)" \]; then\n\s+sqlite3 -header -column "\$DB_PATH" "\$\*"\n\s+else\n(?:\s+#[^\n]*\n)*(\s+_db_readonly_sql_ok "\$\*" \|\| \{ echo "db: read-only context accepts SELECT\/WITH\/EXPLAIN only" >&2; exit 2; \}\n\s+sqlite3 -readonly -safe -header -column "\$DB_PATH" "\$\*")\n\s+fi$/);
    expect(validateShellCommand(`./mc-ctl db "SELECT COUNT(*) FROM tasks"`)).toEqual({ allowed: true });
  });

  it("db, read-only branch (mc-ctl's own lines on a scratch db): SELECT/WITH/EXPLAIN run; dot-commands, PRAGMA, VACUUM exit 2", () => {
    const fn = MC_CTL.slice(MC_CTL.indexOf("\ncmd_db() {"), MC_CTL.indexOf("\n}\n", MC_CTL.indexOf("\ncmd_db() {")));
    const branch = /\n\s+(_db_readonly_sql_ok "\$\*" [^\n]*\n\s+sqlite3 -readonly -safe [^\n]*)\n\s+fi$/.exec(fn)![1];
    const dir = mkdtempSync(join(tmpdir(), "mc-db-ro-"));
    try {
      const db = join(dir, "t.db");
      spawnSync("sqlite3", [db, "CREATE TABLE tasks(task_id, status, created_at); INSERT INTO tasks VALUES('a','completed',datetime('now'));"]);
      const run = (sql: string) =>
        spawnSync("bash", ["-c", `source "$1"; DB_PATH="$2"; shift 2; ${branch}`, "_", LIB, db, sql], { encoding: "utf8", cwd: dir });
      // the V8.4 gate-check shape: a count over a recent window
      const ok = run("SELECT COUNT(*) AS n FROM tasks WHERE status = 'completed' AND created_at >= datetime('now', '-1 day')");
      expect(ok.status, ok.stderr).toBe(0);
      expect(ok.stdout).toMatch(/^n\s*\n-+\s*\n1\s*$/);
      for (const sql of ["  with x AS (SELECT 1) SELECT * FROM x", "explain query plan SELECT * FROM tasks", "Select(1)"]) {
        expect(run(sql).status, sql).toBe(0);
      }
      for (const sql of [`.trace ${join(dir, "tr.txt")}`, ".shell echo PWNED", "PRAGMA journal_mode=WAL", "pragma journal_mode", "VACUUM", "SELECTX 1", "-- c\nSELECT 1", "DELETE FROM tasks"]) {
        const r = run(sql);
        expect(r.status, sql).toBe(2);
        expect(r.stderr, sql).toBe("db: read-only context accepts SELECT/WITH/EXPLAIN only\n");
      }
      expect(readdirSync(dir).sort()).toEqual(["t.db"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("every sqlite3 call outside a gated handler is -readonly; sql/sql_raw are read-only unless the gate passed", () => {
    // Function boundaries: the next `name() {` line (a body may hold a column-0 `}` in an embedded script).
    const lines = MC_CTL.split("\n");
    const fnAt: string[] = [];
    let fn = "";
    for (const l of lines) fnAt.push((fn = /^([A-Za-z_][A-Za-z0-9_]*)\(\) \{/.exec(l)?.[1] ?? fn));
    const caseStart = MC_CTL.lastIndexOf('\ncase "$cmd" in\n');
    // A handler is gated only when every reference to it is a router entry for a whole-RW command.
    const gatedHandler = (f: string): boolean => {
      const refs = lines.flatMap((l, i) => (new RegExp(`\\b${f}\\b`).test(l) && !l.startsWith(`${f}() {`) && !/^\s*#/.test(l) ? [i] : []));
      const router = MC_CTL.slice(0, caseStart).split("\n").length;
      return refs.length > 0 && refs.every((i) => {
        const m = i >= router ? LABEL.exec(lines[i].replace(/^ {2}/, "")) : null;
        return !!m && labels(m[1]).every((c) => RW_COMMANDS.includes(c));
      });
    };
    const calls = lines.flatMap((l, i) => (/\bsqlite3 /.test(l) && !/^\s*#/.test(l) ? [[i, l, fnAt[i]] as const] : []));
    expect(calls.length).toBeGreaterThan(10);
    const exempt = (l: string, f: string): boolean =>
      ((f === "sql" || f === "sql_raw") && l.includes('sqlite3 "${SQLITE_RO[@]}" ')) ||
      (f === "cmd_db" && /^\s+sqlite3 -header -column "\$DB_PATH"( "\$\*")?$/.test(l)) ||
      gatedHandler(f);
    const bad = calls.filter(([i, l, f]) => !exempt(l, f) && !/\bsqlite3 -readonly /.test(l));
    expect(bad.map(([i, l, f]) => `${i + 1} ${f}: ${l.trim()}`), "RW sqlite3 outside a gated handler").toEqual([]);
    // The helpers default read-only; only the router clears it, right after the gate.
    expect(MC_CTL.match(/\bSQLITE_RO=/g)).toHaveLength(2);
    expect(MC_CTL).toMatch(/\nSQLITE_RO=\(-readonly\)\n/);
  });

  it("mc-ctl refuses to be sourced and still runs when executed", () => {
    const src = spawnSync("bash", ["-c", 'source "$1"; echo "after:$?"', "_", join(ROOT, "mc-ctl")], { encoding: "utf8" });
    expect(src.stderr).toContain("mc-ctl must be executed, not sourced");
    expect(src.stdout).toBe("after:2\n");
    expect(spawnSync("bash", ["-c", '. "$1"; typeset -f sql_raw cmd_cancel', "_", join(ROOT, "mc-ctl")]).stdout.toString()).toBe("");
    const run = spawnSync("bash", [join(ROOT, "mc-ctl"), "help"], { encoding: "utf8", input: "" });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("Mission Control Admin CLI");
  });

  it("mc-ctl and its sourced libs carry no host path (CI runners cannot read /root)", () => {
    // A hardcoded PROJECT_DIR made `source ${PROJECT_DIR}/scripts/lib/operator-gate.sh` read the
    // VPS checkout: green here, "Permission denied" on every GitHub run (red since 2026-10-11).
    const libDir = join(ROOT, "scripts/lib");
    const files = ["mc-ctl", ...readdirSync(libDir).filter((f) => f.endsWith(".sh")).map((f) => `scripts/lib/${f}`)];
    expect(files.length).toBeGreaterThan(1);
    const hits = files.flatMap((f) =>
      readFileSync(join(ROOT, f), "utf8")
        .split("\n")
        .flatMap((l, i) => (l.includes("/root/") ? [`${f}:${i + 1}: ${l.trim()}`] : [])),
    );
    expect(hits, "host path in mc-ctl or scripts/lib/*.sh").toEqual([]);
    // Self-locating, symlink-resolved: the operator runs it as /usr/local/bin/mc-ctl -> <checkout>/mc-ctl.
    // Two lines, so an unset BASH_SOURCE aborts under `set -u` instead of `dirname ""` → $PWD.
    expect(MC_CTL).toMatch(/^_self="\$\(readlink -f "\$\{BASH_SOURCE\[0\]\}"\)"\nPROJECT_DIR="\$\(cd "\$\(dirname "\$_self"\)" && pwd\)"$/m);
    // One assignment: a later `PROJECT_DIR=~/claude/…` override would dodge the `/root/` scan.
    expect(MC_CTL.match(/^PROJECT_DIR=/gm)).toHaveLength(1);
  });

  it("scripts/deploy.sh is gated before it does anything", () => {
    const deploy = readFileSync(join(ROOT, "scripts/deploy.sh"), "utf8");
    const cmds = deploy.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
    expect(cmds.slice(0, 4)).toEqual([
      "set -e",
      "cd /root/claude/mission-control",
      "source scripts/lib/operator-gate.sh",
      "require_operator_context",
    ]);
  });

  it("shell_exec denies every RW entry and allows every RO one (string layer twin)", () => {
    for (const e of GATED_EXPECTED) expect(validateShellCommand(`./mc-ctl ${e}`).allowed, e).toBe(false);
    for (const c of RO_COMMANDS.filter((c) => !/^[-*]|help/.test(c))) {
      expect(validateShellCommand(`./mc-ctl ${c}`), c).toEqual({ allowed: true });
    }
    for (const [c, [, , ro]] of Object.entries(MIXED)) {
      for (const s of ro.filter((s) => s && s !== "*" && !/help|^-h$/.test(s))) {
        expect(validateShellCommand(`./mc-ctl ${c} ${s}`), `${c} ${s}`).toEqual({ allowed: true });
      }
    }
  });
});
