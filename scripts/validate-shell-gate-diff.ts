/**
 * scripts/validate-shell-gate-diff.ts — differential of the shell gate over real traffic (ruling 5e).
 *
 * READ-ONLY operator script, run on the VPS. It reads the `shell_exec` command
 * strings logged in mc.db over a window, classifies each distinct command with
 * the CURRENT `validateShellCommand` and with the one at `--ref` (default
 * `main`), and prints every command whose allowed/refused verdict differs,
 * grouped as:
 *
 *   docker-refused-per-ruling  refused now by the docker gate (ruling 5), allowed at the ref
 *   docker-newly-allowed       allowed now, refused at the ref, the command names docker
 *   non-docker                 every other verdict difference
 *
 * Exit: 0 = no unexplained difference (no non-docker, no docker-newly-allowed);
 *       1 = unexplained differences; 2 = no `shell_exec` command found in the
 *       window (nothing was compared); 3 = error (DB not openable, bad ref).
 *
 * Usage (from the repo root):
 *   npx tsx scripts/validate-shell-gate-diff.ts                    # dry: prints what --run would do
 *   npx tsx scripts/validate-shell-gate-diff.ts --run              # 30 days vs main, redacted
 *   npx tsx scripts/validate-shell-gate-diff.ts --run --days 7 --ref b402df9
 *   npx tsx scripts/validate-shell-gate-diff.ts --run --db /path/to/copy.db --no-redact
 *
 * DB access: `getDatabase()` needs `initDatabase()`, which runs the schema
 * migrations (writes), so this script opens the file the way the other
 * read-only scripts do (`scripts/rule-of-two-audit.ts`, `scripts/replay-gate-expects.ts`):
 * better-sqlite3 `{ readonly: true, fileMustExist: true }`, plus `query_only`.
 *
 * Where the commands come from: mc.db has no dedicated tool-call-arguments
 * table (`task_trace_events` and `runs.tool_calls` keep tool NAMES only). The
 * script therefore walks the JSON text columns that can carry a tool call
 * with its input — `runs.output/trace/goal_graph`, `tasks.output/metadata`,
 * `prometheus_snapshots.goal_results/execution_state`, `events.data` — for any
 * object naming `shell_exec` with a `command` argument, plus
 * `tool_approvals.args_json` rows whose tool is `shell_exec`. Missing tables or
 * columns are skipped. The per-source counts are printed so the operator sees
 * where the population came from; a count of 0 everywhere exits 2.
 *
 * The ref's validator: `git archive <ref> src package.json tsconfig.json` into
 * a temp dir with a `node_modules` symlink, imported from there (shell.ts
 * imports siblings, so it cannot be loaded alone). No worktree, no checkout,
 * nothing written to the repo or its `.git`; the temp dir is removed at exit.
 *
 * Output: only command text (redacted by default — see redactCommand: credential shapes via
 * `redactSecrets`, client `-p` passwords, `curl -u`, `PASS`/`TOKEN`/`SECRET`-named assignment values, URL userinfo,
 * long mixed tokens) and verdict reasons. No
 * environment variable or stored secret is read or printed.
 */
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { redactSecrets } from "../src/api/mcp-server/redact.js";
import { scrubSecrets } from "../src/lib/secret-refs.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface Verdict {
  allowed: boolean;
  reason?: string;
}
export type Validator = (command: string) => Verdict;
export type Group = "docker-refused-per-ruling" | "docker-newly-allowed" | "non-docker";
export interface Difference {
  command: string;
  group: Group;
  current: Verdict;
  ref: Verdict;
}

// ---------------------------------------------------------------- extraction

const SHELL_TOOL_NAMES = new Set(["shell_exec", "mcp__jarvis__shell_exec"]);
const MAX_DEPTH = 64;

function commandFromArgs(args: unknown): string | null {
  let a = args;
  if (typeof a === "string") {
    try {
      a = JSON.parse(a);
    } catch {
      return null;
    }
  }
  if (a && typeof a === "object" && !Array.isArray(a)) {
    const c = (a as Record<string, unknown>).command;
    return typeof c === "string" && c.trim() ? c : null;
  }
  return null;
}

function walk(v: unknown, out: string[], depth: number): void {
  if (depth > MAX_DEPTH || v == null) return;
  if (typeof v === "string") {
    // A JSON document stored as a string inside JSON (e.g. `arguments`, a stringified output).
    const s = v.trimStart();
    if ((s.startsWith("{") || s.startsWith("[")) && v.includes("shell_exec")) {
      try {
        walk(JSON.parse(v), out, depth + 1);
      } catch {
        /* not JSON */
      }
    }
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) walk(x, out, depth + 1);
    return;
  }
  if (typeof v !== "object") return;
  const o = v as Record<string, unknown>;
  // OpenAI shape `{ function: { name, arguments } }` is matched at the inner object, once.
  const name = o.name ?? o.tool ?? o.toolName ?? o.tool_name;
  if (typeof name === "string" && SHELL_TOOL_NAMES.has(name)) {
    for (const args of [o.input, o.args, o.arguments, o.params]) {
      const c = commandFromArgs(args);
      if (c !== null) {
        out.push(c);
        break;
      }
    }
  }
  for (const x of Object.values(o)) walk(x, out, depth + 1);
}

/** Every `shell_exec` command named in one stored JSON text (any nesting, JSON-in-string included). */
export function extractShellCommands(text: string | null | undefined): string[] {
  if (!text || !text.includes("shell_exec")) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const out: string[] = [];
  walk(parsed, out, 0);
  return out;
}

/** JSON text columns that can carry a tool call with its input. Missing tables/columns are skipped. */
export const SOURCES: ReadonlyArray<{ table: string; columns: string[] }> = [
  { table: "runs", columns: ["output", "trace", "goal_graph"] },
  { table: "tasks", columns: ["output", "metadata"] },
  { table: "prometheus_snapshots", columns: ["goal_results", "execution_state"] },
  { table: "events", columns: ["data"] },
];
const TIME_COLUMNS = ["created_at", "requested_at", "timestamp", "ts"];

function columnsOf(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

export interface Population {
  /** Occurrences found (one per logged call). */
  total: number;
  /** Distinct command strings, first-seen order. */
  commands: string[];
  /** Occurrences per `table.column`. */
  perSource: Record<string, number>;
}

/** Reads `shell_exec` commands logged in the last `days` days. Read-only: SELECTs only. */
export function readShellCommands(db: Database.Database, days: number): Population {
  const since = `-${days} days`;
  const seen = new Set<string>();
  const perSource: Record<string, number> = {};
  let total = 0;
  const add = (key: string, cmds: string[]) => {
    for (const c of cmds) {
      total++;
      perSource[key] = (perSource[key] ?? 0) + 1;
      seen.add(c);
    }
  };
  for (const { table, columns } of SOURCES) {
    const have = columnsOf(db, table);
    if (have.size === 0) continue;
    const timeCol = TIME_COLUMNS.find((c) => have.has(c));
    for (const col of columns) {
      if (!have.has(col)) continue;
      const where = timeCol ? `AND datetime(${timeCol}) >= datetime('now', ?)` : "";
      const stmt = db.prepare(`SELECT ${col} AS t FROM ${table} WHERE ${col} LIKE '%shell_exec%' ${where}`);
      const key = `${table}.${col}`;
      perSource[key] = 0;
      for (const row of (timeCol ? stmt.iterate(since) : stmt.iterate()) as Iterable<{ t: unknown }>) {
        if (typeof row.t === "string") add(key, extractShellCommands(row.t));
      }
    }
  }
  const ta = columnsOf(db, "tool_approvals");
  if (ta.has("tool") && ta.has("args_json")) {
    const timeCol = TIME_COLUMNS.find((c) => ta.has(c));
    const where = timeCol ? `AND datetime(${timeCol}) >= datetime('now', ?)` : "";
    const stmt = db.prepare(`SELECT args_json AS t FROM tool_approvals WHERE tool IN ('shell_exec', 'mcp__jarvis__shell_exec') ${where}`);
    perSource["tool_approvals.args_json"] = 0;
    for (const row of (timeCol ? stmt.iterate(since) : stmt.iterate()) as Iterable<{ t: unknown }>) {
      const c = commandFromArgs(row.t);
      if (c !== null) add("tool_approvals.args_json", [c]);
    }
  }
  return { total, commands: [...seen], perSource };
}

// ------------------------------------------------------------------ verdicts

/** The docker gate's refusal texts (dockerRefusal in shell.ts, and the API-socket path rule). */
const DOCKER_REASON_RE = /container file access and new containers are operator-only|Docker API socket/;
/** A docker word anywhere (the CLI or a plugin binary, bare or by path). */
const DOCKER_WORD_RE = /(?:^|[^\w-])docker(?:-compose|-buildx|-model)?(?![\w-])/;

function safely(validate: Validator, command: string): Verdict {
  try {
    const v = validate(command);
    return { allowed: v.allowed === true, ...(v.reason ? { reason: v.reason } : {}) };
  } catch (err) {
    return { allowed: false, reason: `validator threw: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Every command whose allowed/refused verdict differs between the two validators, grouped. */
export function diffCommands(commands: string[], current: Validator, ref: Validator): Difference[] {
  const out: Difference[] = [];
  for (const command of commands) {
    const cur = safely(current, command);
    const old = safely(ref, command);
    if (cur.allowed === old.allowed) continue;
    let group: Group = "non-docker";
    if (!cur.allowed && DOCKER_REASON_RE.test(cur.reason ?? "")) group = "docker-refused-per-ruling";
    else if (cur.allowed && DOCKER_WORD_RE.test(command)) group = "docker-newly-allowed";
    out.push({ command, group, current: cur, ref: old });
  }
  return out;
}

/** 0 = nothing unexplained, 1 = a non-docker or docker-newly-allowed difference, 2 = nothing compared. */
export function exitCodeFor(pop: Pick<Population, "commands">, diffs: Difference[]): number {
  if (pop.commands.length === 0) return 2;
  return diffs.some((d) => d.group !== "docker-refused-per-ruling") ? 1 : 0;
}

// ------------------------------------------------------------------- output

/** Clients whose `-p` carries a password (`mysql -pX`, `sshpass -p X`); for psql it is the port — masked anyway. */
const PW_FLAG_CLIENT_RE =
  /(\b(?:mysql\w*|mariadb\w*|psql|pg_\w+|sshpass|mongo\w*|redis-cli)\b[^;&|\n]*?\s)-p(?:\s+|=)?(?!\[REDACTED\])[^\s;&|]+/gi;

/**
 * Masks credentials in logged command text (audit B4). Applied to commands AND reasons:
 * stored secret values (scrubSecrets — only effective when a database is open in-process; this script
 * opens mc.db through its own read-only handle, so on the VPS the shape rules below are what apply),
 * credential shapes (redactSecrets), URL userinfo, `-p<pw>`/`-p <pw>` after a mysql/psql-like client or
 * sshpass, `curl -u user:pw`, `--password <pw>`, any `*PASS*=` / `*TOKEN*=` / `*SECRET*=` value
 * (`PGPASSWORD=x`), and long mixed letter+digit tokens.
 */
export function redactCommand(text: string): string {
  let out = text;
  try {
    out = scrubSecrets(out);
  } catch {
    /* the shape rules below still apply */
  }
  return redactSecrets(out)
    .replace(/(\b[a-z][\w+.-]*:\/\/)[^/\s@]+@/gi, "$1[REDACTED]@")
    .replace(/\b(\w*(?:PASS|TOKEN|SECRET)\w*)=(?!\[REDACTED\])("[^"]*"|'[^']*'|[^\s;&|]+)/gi, "$1=[REDACTED]")
    .replace(/(--?\w*pass(?:word|wd)?)(\s+)(?!-|\[REDACTED\])[^\s;&|]+/gi, "$1$2[REDACTED]")
    .replace(PW_FLAG_CLIENT_RE, "$1-p [REDACTED]")
    .replace(/((?:^|\s)(?:-u|--user)(?:\s+|=)?)([^\s:;&|]+):(?!\[REDACTED\])[^\s;&|]+/g, "$1$2:[REDACTED]")
    .replace(/[A-Za-z0-9_+=-]{24,}/g, (tok) =>
      /[A-Za-z]/.test(tok) && /\d/.test(tok) ? `[redacted:${tok.length}]` : tok,
    );
}

export function formatReport(
  pop: Population,
  diffs: Difference[],
  opts: { days: number; ref: string; redact: boolean },
): string {
  const show = (s: string) => (opts.redact ? redactCommand(s) : s);
  const verdict = (v: Verdict) => (v.allowed ? "ALLOWED" : `REFUSED — ${show(v.reason ?? "(no reason)")}`);
  const L: string[] = [];
  L.push(`# Shell gate differential — current vs ${opts.ref}, last ${opts.days} days${opts.redact ? " (redacted)" : " (NOT redacted)"}`);
  L.push("");
  L.push("Sources (occurrences):");
  for (const [k, n] of Object.entries(pop.perSource)) L.push(`  ${k}: ${n}`);
  L.push("");
  L.push(`total: ${pop.total}`);
  L.push(`distinct: ${pop.commands.length}`);
  L.push(`differing: ${diffs.length}`);
  const groups: Group[] = ["docker-refused-per-ruling", "docker-newly-allowed", "non-docker"];
  for (const g of groups) {
    const items = diffs.filter((d) => d.group === g);
    L.push("");
    L.push(`## ${g} (${items.length})`);
    for (const d of items) {
      L.push(`- ${show(d.command).replace(/\n/g, "\\n")}`);
      L.push(`    current: ${verdict(d.current)}`);
      L.push(`    ${opts.ref}: ${verdict(d.ref)}`);
    }
  }
  return L.join("\n");
}

// --------------------------------------------------------- the ref's validator

/** Loads `validateShellCommand` as of `ref` from a temp export of the tree; `cleanup` removes it. */
export async function loadValidatorAtRef(ref: string, root: string = ROOT): Promise<{ validate: Validator; cleanup: () => void }> {
  execFileSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { stdio: ["ignore", "ignore", "pipe"] });
  const dir = mkdtempSync(join(tmpdir(), "shell-gate-diff-"));
  const link = join(dir, "node_modules");
  const cleanup = () => {
    try {
      if (existsSync(link)) unlinkSync(link); // the symlink only, never its target
    } catch {
      /* best effort */
    }
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const tar = execFileSync("git", ["-C", root, "archive", "--format=tar", ref, "src", "package.json", "tsconfig.json"], {
      maxBuffer: 512 * 1024 * 1024,
    });
    execFileSync("tar", ["-x", "-C", dir], { input: tar });
    symlinkSync(join(root, "node_modules"), link, "dir");
    const mod = (await import(pathToFileURL(join(dir, "src/tools/builtin/shell.ts")).href)) as {
      validateShellCommand?: Validator;
    };
    if (typeof mod.validateShellCommand !== "function") throw new Error(`no validateShellCommand at ${ref}`);
    return { validate: mod.validateShellCommand, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

// ---------------------------------------------------------------------- CLI

export interface Args {
  run: boolean;
  days: number;
  ref: string;
  redact: boolean;
  db: string;
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { run: false, days: 30, ref: "main", redact: true, db: join(ROOT, "data", "mc.db") };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${t} needs a value`);
      return v;
    };
    if (t === "--run") a.run = true;
    else if (t === "--redact") a.redact = true;
    else if (t === "--no-redact") a.redact = false;
    else if (t === "--days") {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1 || n > 3650) throw new Error("--days must be an integer from 1 to 3650");
      a.days = n;
    } else if (t === "--ref") a.ref = value();
    else if (t === "--db") a.db = resolve(value());
    else throw new Error(`unknown argument: ${t}`);
  }
  return a;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    return 3;
  }
  if (!args.run) {
    console.log(
      [
        "DRY RUN — nothing opened. With --run this script would:",
        `  1. open ${args.db} READ-ONLY (better-sqlite3 readonly + query_only);`,
        `  2. collect shell_exec commands logged in the last ${args.days} days from: ${SOURCES.map((s) => s.columns.map((c) => `${s.table}.${c}`).join(", ")).join(", ")}, tool_approvals.args_json; dedupe;`,
        `  3. export ${args.ref}:src into a temp dir (git archive) and import its validateShellCommand;`,
        "  4. classify every distinct command with the current and the ref validator;",
        `  5. print total / distinct / differing and each difference by group, ${args.redact ? "redacted" : "NOT redacted"};`,
        "  6. exit 0 (no unexplained difference), 1 (non-docker or docker-newly-allowed), 2 (no commands), 3 (error).",
      ].join("\n"),
    );
    return 0;
  }
  let db: Database.Database;
  try {
    db = new Database(args.db, { readonly: true, fileMustExist: true });
    db.pragma("query_only = ON");
  } catch (err) {
    console.error(`error: cannot open ${args.db} read-only: ${(err as Error).message}`);
    return 3;
  }
  let pop: Population;
  try {
    pop = readShellCommands(db, args.days);
  } finally {
    db.close();
  }
  if (pop.commands.length === 0) {
    console.log(formatReport(pop, [], args));
    console.log("\nNo shell_exec command found in the window — nothing compared (exit 2).");
    return 2;
  }
  let loaded: Awaited<ReturnType<typeof loadValidatorAtRef>>;
  try {
    loaded = await loadValidatorAtRef(args.ref);
  } catch (err) {
    console.error(`error: cannot load validateShellCommand at ${args.ref}: ${(err as Error).message}`);
    return 3;
  }
  try {
    const { validateShellCommand } = await import("../src/tools/builtin/shell.js");
    const diffs = diffCommands(pop.commands, (c) => validateShellCommand(c), loaded.validate);
    console.log(formatReport(pop, diffs, args));
    const code = exitCodeFor(pop, diffs);
    console.log(`\nexit ${code}: ${code === 0 ? "no unexplained difference" : "unexplained differences (non-docker or docker-newly-allowed)"}`);
    return code;
  } finally {
    loaded.cleanup();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(3);
    },
  );
}
