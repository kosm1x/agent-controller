/**
 * scripts/predeploy-rulings-1-5.ts — READ-ONLY helper of `predeploy-rulings-1-5.sh`
 * (sections B, C and D of the rulings 1–5 pre-deploy check). Run by the .sh;
 * standalone:
 *
 *   npx tsx scripts/predeploy-rulings-1-5.ts --db data/mc.db --queries "cliente|factura|deploy"
 *
 * B. Credential census (ruling 3d): every `user_facts` row and every leaf
 *    (nested ones included) of `projects.credentials`, plus the hidden leaves
 *    of `projects.urls` / `projects.config`, with the verdict of the NEW code:
 *    HIDDEN (kept from the model, used by name `SECRET_…`) or CLEAR.
 * C. KB search cost: the `searchFiles` path (src/db/jarvis-fs.ts) per query.
 * D. Tool-less schedules: `scheduled_tasks` with `tools='[]' AND active=1`.
 *
 * DATABASE: opened ONLY with better-sqlite3 `{ readonly: true, fileMustExist:
 * true }` + `pragma query_only = ON` (as scripts/validate-shell-gate-diff.ts
 * and scripts/rule-of-two-audit.ts). `initDatabase()` is never called (it
 * runs schema migrations = writes), so the `getDatabase()` singleton stays
 * unset in this process, and `src/` has no hook to hand it a read-only
 * handle. Consequences, both stated in the output:
 *   - The secret verdict comes from the repo's real classifiers
 *     (`isCredentialFact`, `isProjectSecret`, `isSecretAncestorName`,
 *     `projectEntryLeaves`); the REFERENCE NAME is reproduced from the same
 *     rule `buildIndex` in src/lib/secret-refs.ts applies (base name from
 *     category/key or slug/field/path, 6-hex suffix on a collision).
 *     scripts/predeploy-rulings-1-5.test.ts checks this reproduction against
 *     the real `secretRefName` on a synthetic temp DB.
 *   - The KB timing runs the same SQL `searchFiles` runs (FTS5, LIKE
 *     fallback, FTS_FETCH_CAP = 5000) and the same per-row scrub work over the
 *     stored values' raw / URL / JSON / JSON2 forms. The scrub's overlap rule
 *     is simplified (no older-wins ranking) and the snippet text is not built,
 *     so the timing is a slight UNDER-estimate, mostly for rows with many
 *     value occurrences. The test checks the returned paths against the real
 *     `searchFiles` on a synthetic temp DB, and pins FTS_FETCH_CAP to the
 *     source.
 *
 * NEVER PRINTED: any stored value, or a prefix / suffix / hash / length of
 * one. Output is counts, key names, slugs, ids, schedule names, booleans and
 * ms. A key name or slug that itself looks like a credential VALUE is
 * withheld (and so is its reference name). KB timing prints no title,
 * snippet or path. Error messages are reduced to an error code / class name.
 *
 * The last stdout line is machine-readable for the .sh:
 *   @@status census=ok|error collisions=N display_disagree=N kb=ok|error kb_slow=N toolless=N|error
 * Exit: 0 = ran (step errors are in the status line), 2 = could not run
 * (bad arguments, database not openable read-only).
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isCredentialFact, isCredentialName } from "../src/db/user-facts.js";
import {
  factIdentity,
  projectIdentity,
  isProjectSecret,
  isSecretAncestorName,
  projectEntryLeaves,
  secretPlaceholder,
  encodeSecretForm,
  MIN_SCRUB_LENGTH,
} from "../src/lib/secret-refs.js";
import { tokenizeQuery, locateMatch } from "../src/db/jarvis-fs.js";

// ------------------------------------------------------------------ census

export type Field = "credentials" | "urls" | "config";
const FIELDS: readonly Field[] = ["credentials", "urls", "config"];

export interface FactRow {
  category: string;
  key: string;
  value: unknown;
}
export interface ProjectRow {
  slug: unknown;
  urls: unknown;
  credentials: unknown;
  config: unknown;
}

/** One census line. Carries NO value — only names, booleans and the reference name. */
export interface CensusRow {
  store: "fact" | "project";
  /** Fact category, or project slug. */
  scope: string;
  field?: Field;
  /** Fact: [key]. Project: key path from the field root (array indices as numbers). */
  path: string[];
  secret: boolean;
  /** Hidden because of the VALUE's shape, not a key / category / ancestor name. */
  byShape: boolean;
  /** Reference name the model uses (`SECRET_…`); null when not hidden. */
  ref: string | null;
  /** Project leaves: the display path (`projectEntryLeaves`) agrees with the index walk. */
  displayAgrees: boolean;
}

export interface Census {
  rows: CensusRow[];
  /**
   * Base names shared by more than one hidden entry (production suffixes them).
   * `withheld`: a member's scope or key name is withheld by `safeLabel`, so the
   * base (built from those names) is withheld too — `normName` uppercases, which
   * defeats the shape check on the base itself.
   */
  collisions: Array<{ base: string; members: number; withheld: boolean }>;
  /** Final reference names that still occur twice after suffixing. */
  duplicateNames: number;
  /** IN-PROCESS ONLY (holds values): the scrub forms, for the KB timing. Never printed. */
  scrub: Array<[string, string]>;
}

/** `norm` of src/lib/secret-refs.ts (not exported there). */
export function normName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw === "") return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

interface Leaf {
  path: string[];
  key: string;
  value: string;
  secret: boolean;
  byShape: boolean;
}

/**
 * Every string/number leaf of one project field — the walk of `projectEntries`
 * in src/lib/secret-refs.ts (same skip rules, same ancestor rule), but keeping
 * the non-secret leaves too so the census can list them.
 */
export function walkProjectField(obj: Record<string, unknown>): Leaf[] {
  const out: Leaf[] = [];
  const walk = (v: unknown, path: string[], key: string, underSecret: boolean): void => {
    if (v === null || v === undefined || v === "") return;
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, [...path, String(i)], key, underSecret));
      return;
    }
    if (typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        walk(x, [...path, k], k, underSecret || isSecretAncestorName(k));
      }
      return;
    }
    if (typeof v !== "string" && typeof v !== "number") return;
    const str = String(v);
    const secret = underSecret || isProjectSecret(key, str);
    out.push({
      path,
      key,
      value: str,
      secret,
      byShape: secret && !underSecret && !isCredentialName(key, str),
    });
  };
  walk(obj, [], "", false);
  return out;
}

interface Entry {
  row: CensusRow;
  identity: string;
  base: string;
  value: string;
}

export function buildCensus(facts: FactRow[], projects: ProjectRow[]): Census {
  const rows: CensusRow[] = [];
  const entries: Entry[] = [];

  // Facts: same order and rule as buildIndex (ORDER BY id; non-string skipped).
  for (const f of facts) {
    const value = typeof f.value === "string" ? f.value : null;
    const secret = value !== null && isCredentialFact(f.category, f.key, value);
    const row: CensusRow = {
      store: "fact",
      scope: String(f.category),
      path: [String(f.key)],
      secret,
      byShape:
        secret &&
        !isCredentialName(f.key, value!) &&
        !isCredentialName(f.category, value!),
      ref: null,
      displayAgrees: true,
    };
    rows.push(row);
    if (secret) {
      entries.push({
        row,
        identity: factIdentity(f.category, f.key),
        base: `SECRET_${normName(`${f.category}_${f.key}`)}`,
        value: value!,
      });
    }
  }

  // Projects: same order (ORDER BY rowid) and fields as buildIndex.
  for (const p of projects) {
    if (typeof p.slug !== "string") continue;
    for (const field of FIELDS) {
      const obj = parseObject(p[field]);
      // The display path the tools use, per top-level entry (real function).
      const display = new Map<string, boolean>();
      for (const [k, v] of Object.entries(obj)) {
        for (const leaf of projectEntryLeaves(p.slug, field, k, v)) {
          display.set(leaf.path.join("\0"), leaf.secret);
        }
      }
      for (const leaf of walkProjectField(obj)) {
        // urls / config: only hidden leaves are listed (credentials: all).
        if (field !== "credentials" && !leaf.secret) continue;
        const row: CensusRow = {
          store: "project",
          scope: p.slug,
          field,
          path: leaf.path,
          secret: leaf.secret,
          byShape: leaf.byShape,
          ref: null,
          displayAgrees: display.get(leaf.path.join("\0")) === leaf.secret,
        };
        rows.push(row);
        if (leaf.secret) {
          const prefix = field === "credentials" ? [p.slug] : [p.slug, field];
          entries.push({
            row,
            identity: projectIdentity(p.slug, field, leaf.path),
            base: `SECRET_${normName([...prefix, ...leaf.path].join("_"))}`,
            value: leaf.value,
          });
        }
      }
    }
  }

  // Collision rule of buildIndex: every member of a shared base gets a suffix.
  const count = new Map<string, number>();
  for (const e of entries) count.set(e.base, (count.get(e.base) ?? 0) + 1);
  const names = new Map<string, number>();
  const scrub: Array<[string, string]> = [];
  for (const e of entries) {
    const name =
      (count.get(e.base) ?? 0) > 1
        ? `${e.base}_${createHash("sha256").update(e.identity).digest("hex").slice(0, 6).toUpperCase()}`
        : e.base;
    e.row.ref = name;
    names.set(name, (names.get(name) ?? 0) + 1);
    if (e.value.length < MIN_SCRUB_LENGTH) continue;
    const seen = new Set<string>();
    for (const form of ["raw", "url", "json", "json2"] as const) {
      const text = encodeSecretForm(e.value, form);
      if (seen.has(text)) continue;
      seen.add(text);
      scrub.push([text, secretPlaceholder(name, form)]);
    }
  }
  scrub.sort((a, b) => b[0].length - a[0].length);
  // Audit R1 W1: a base built from a withheld name is withheld as well.
  const withheldBase = new Set<string>();
  for (const e of entries) if (rowWithheld(e.row)) withheldBase.add(e.base);
  const collisions = [...count.entries()]
    .filter(([, n]) => n > 1)
    .map(([base, members]) => ({ base, members, withheld: withheldBase.has(base) }));
  const duplicateNames = [...names.values()].filter((n) => n > 1).length;
  return { rows, collisions, duplicateNames, scrub };
}

/**
 * A key name / slug / category as printed. One that itself has the shape of
 * a credential VALUE (a token stored as a key) is withheld; control
 * characters are replaced; long names are cut at 80 characters.
 */
export function safeLabel(name: string): string | null {
  if (isCredentialFact("x", "x", name)) return null;
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, "?");
  return clean.length > 80 ? `${clean.slice(0, 77)}...` : clean;
}

/** Whether any name in a row (scope or a key on its path) is withheld by `safeLabel`. */
export function rowWithheld(r: Pick<CensusRow, "scope" | "path">): boolean {
  return [r.scope, ...r.path].some((n) => safeLabel(n) === null);
}

/** Project leaves whose display verdict (projectEntryLeaves) differs from the index walk. */
export function displayDisagreements(rows: CensusRow[]): number {
  return rows.filter((r) => r.store === "project" && !r.displayAgrees).length;
}

const WITHHELD = "[name withheld: shaped like a credential]";

/** The census as printed. Reads only names, booleans and reference names from `c`. */
export function formatCensus(c: Pick<Census, "rows" | "collisions" | "duplicateNames">): string {
  const L: string[] = [];
  const line = (r: CensusRow): string => {
    const labels = [r.scope, ...r.path].map(safeLabel);
    const withheld = rowWithheld(r);
    const scope = labels[0] ?? WITHHELD;
    const path = labels
      .slice(1)
      .map((l) => l ?? WITHHELD)
      .join(".");
    const where = r.store === "fact" ? `${scope} / ${path}` : `${scope} : ${path}`;
    const verdict = r.secret ? "HIDDEN" : "CLEAR ";
    const ref = r.secret ? `  ref=${withheld ? "(withheld)" : r.ref}` : "";
    const shape = r.secret ? `  by-shape=${r.byShape ? "yes" : "no"}` : "";
    const agree = r.store === "project" && !r.displayAgrees ? "  display-disagrees=yes" : "";
    return `    ${verdict}  ${where}${ref}${shape}${agree}`;
  };
  const facts = c.rows.filter((r) => r.store === "fact");
  const creds = c.rows.filter((r) => r.store === "project" && r.field === "credentials");
  const other = c.rows.filter((r) => r.store === "project" && r.field !== "credentials");
  L.push("  HIDDEN = hidden from the model, used by name (ref); CLEAR = shown in clear.");
  L.push("  by-shape=yes: hidden because of the value's shape, not a key/category/ancestor name.");
  L.push("");
  L.push(`  user_facts (${facts.length} rows):`);
  for (const r of facts) L.push(line(r));
  L.push("");
  L.push(`  projects.credentials (${creds.length} leaves, nested included):`);
  for (const r of creds) L.push(line(r));
  L.push("");
  L.push(`  projects.urls / projects.config — hidden leaves only (${other.length}):`);
  for (const r of other) L.push(line(r).replace(/^ {4}/, `    [${r.field}] `));
  L.push("");
  const hid = (rs: CensusRow[]) => rs.filter((r) => r.secret).length;
  const shp = (rs: CensusRow[]) => rs.filter((r) => r.secret && r.byShape).length;
  L.push(`  totals: user_facts ${facts.length} (hidden ${hid(facts)}, by shape ${shp(facts)}, clear ${facts.length - hid(facts)})`);
  L.push(`          projects.credentials ${creds.length} leaves (hidden ${hid(creds)}, by shape ${shp(creds)}, clear ${creds.length - hid(creds)})`);
  L.push(`          projects.urls/config hidden ${other.length} (by shape ${shp(other)})`);
  L.push(`  display/index disagreements (projectEntryLeaves vs the index walk): ${displayDisagreements(c.rows)}`);
  L.push(`  reference-name collisions: ${c.collisions.length} base name(s) shared${c.duplicateNames ? `; ${c.duplicateNames} final name(s) still duplicated` : ""}`);
  for (const col of c.collisions) {
    const label = col.withheld ? WITHHELD : (safeLabel(col.base) ?? WITHHELD);
    L.push(`    ${label} — ${col.members} entries (each gets a 6-hex suffix; the model's name changes)`);
  }
  L.push("  (reference names reproduced from buildIndex's rule — getDatabase() is not initialised in this read-only process)");
  return L.join("\n");
}

// ---------------------------------------------------------------- KB timing

/** FTS_FETCH_CAP of src/db/jarvis-fs.ts (not exported there). */
export const FTS_FETCH_CAP = 5000;
/** `jarvis_file_search` default limit (src/tools/builtin/jarvis-files.ts). */
export const KB_TOOL_LIMIT = 15;
export const MAX_QUERIES = 5;
export const SLOW_MS = 500;

const FTS_SQL = `SELECT f.path, f.title, f.content, LENGTH(f.content) AS size,
                  snippet(jarvis_files_fts, 1, '«', '»', '…', 16) AS snip
             FROM jarvis_files_fts
             JOIN jarvis_files f ON f.rowid = jarvis_files_fts.rowid
            WHERE jarvis_files_fts MATCH ?
            ORDER BY bm25(jarvis_files_fts), f.path ASC
            LIMIT ?`;
const LIKE_SQL = `SELECT path, title, content, LENGTH(content) AS size
       FROM jarvis_files
       WHERE content LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\'
       ORDER BY
         CASE WHEN path LIKE ? ESCAPE '\\' THEN 0
              WHEN title LIKE ? ESCAPE '\\' THEN 1
              ELSE 2 END,
         path ASC
       LIMIT ?`;

const asText = (v: unknown): string =>
  typeof v === "string" ? v : Buffer.isBuffer(v) ? v.toString("utf8") : v == null ? "" : String(v);
const fold = (s: string): string => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

/** The scrub's work: every occurrence of every form (indexOf loop), non-overlapping replace. */
export function scrubWithForms(text: string, scrub: Array<[string, string]>): string {
  const occ: Array<{ start: number; end: number; ph: string }> = [];
  for (const [form, ph] of scrub) {
    if (form.length === 0) continue;
    for (let i = text.indexOf(form); i !== -1; i = text.indexOf(form, i + 1)) {
      occ.push({ start: i, end: i + form.length, ph });
    }
  }
  if (occ.length === 0) return text;
  occ.sort((a, b) => a.start - b.start || b.end - a.end);
  let out = "";
  let at = 0;
  for (const o of occ) {
    if (o.start < at) continue;
    out += text.slice(at, o.start) + o.ph;
    at = o.end;
  }
  return out + text.slice(at);
}

export interface SearchRun {
  via: "fts" | "like";
  fetched: number;
  /** Result paths, in order — IN-PROCESS ONLY (the test compares them); never printed. */
  paths: string[];
}

/** `searchFiles(query, limit)` reproduced on a read-only handle (same SQL, same filter/merge). */
export function reproduceSearch(
  db: Database.Database,
  query: string,
  limit: number,
  scrub: Array<[string, string]>,
): SearchRun {
  const tokens = tokenizeQuery(query);
  const match = tokens.length ? tokens.map((t) => `"${t}"*`).join(" ") : null;
  type Row = { path: string; title: string; content: unknown; size: number; snip?: string };
  if (match) {
    let rows: Row[] | null = null;
    try {
      const r = db.prepare(FTS_SQL).all(match, FTS_FETCH_CAP) as Row[];
      if (r.length > 0) rows = r;
    } catch {
      /* falls through to LIKE, as searchFiles does */
    }
    if (rows) {
      const score = (text: string, title: string): number => {
        const hay = fold(`${text}\n${title}`.toLowerCase());
        let n = 0;
        for (const t of tokens) {
          const needle = fold(t);
          for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
        }
        return n;
      };
      const clean: Array<{ path: string; score: number }> = [];
      const secret: Array<{ path: string; score: number }> = [];
      for (const r of rows) {
        const raw = asText(r.content);
        const scrubbed = scrubWithForms(raw, scrub);
        if (scrubbed === raw) {
          locateMatch(r.content, tokens);
          clean.push({ path: r.path, score: score(raw, String(r.title ?? "")) });
          continue;
        }
        const visible = fold(`${scrubbed}\n${r.title ?? ""}\n${r.path ?? ""}`.toLowerCase());
        if (!tokens.every((t) => visible.includes(fold(t)))) continue;
        locateMatch(scrubbed, tokens);
        secret.push({ path: r.path, score: score(scrubbed, String(r.title ?? "")) });
      }
      secret.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
      const paths: string[] = [];
      let i = 0;
      let j = 0;
      while (paths.length < limit && (i < clean.length || j < secret.length)) {
        const take =
          j < secret.length && (i >= clean.length || secret[j]!.score > clean[i]!.score)
            ? secret[j++]!
            : clean[i++]!;
        paths.push(take.path);
      }
      return { via: "fts", fetched: rows.length, paths };
    }
  }
  const escaped = query.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
  const like = `%${escaped}%`;
  const rows = db.prepare(LIKE_SQL).all(like, like, like, like, like, FTS_FETCH_CAP) as Row[];
  const q = query.toLowerCase();
  const paths: string[] = [];
  for (const r of rows) {
    const content = scrubWithForms(asText(r.content), scrub);
    const idx = content.toLowerCase().indexOf(q);
    if (idx < 0 && !String(r.title ?? "").toLowerCase().includes(q) && !String(r.path ?? "").toLowerCase().includes(q)) continue;
    paths.push(r.path);
  }
  // searchFiles slices the LIKE results to `limit` after the filter.
  return { via: "like", fetched: rows.length, paths: paths.slice(0, limit) };
}

export interface KbTiming {
  query: string;
  via: "fts" | "like";
  fetched: number;
  returned: number;
  ms: number;
}

export function timeKbQuery(
  db: Database.Database,
  query: string,
  scrub: Array<[string, string]>,
  runs = 3,
): KbTiming {
  const times: number[] = [];
  let last: SearchRun | null = null;
  for (let n = 0; n < runs; n++) {
    const t0 = process.hrtime.bigint();
    last = reproduceSearch(db, query, KB_TOOL_LIMIT, scrub);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  return {
    query,
    via: last!.via,
    fetched: last!.fetched,
    returned: last!.paths.length,
    ms: Math.round(times[Math.floor(times.length / 2)]! * 10) / 10,
  };
}

/** Pipe-separated KB queries; throws on none or more than MAX_QUERIES. */
export function parseQueries(raw: string): string[] {
  const qs = raw
    .split("|")
    .map((q) => q.trim())
    .filter(Boolean);
  if (qs.length === 0) throw new Error("KB_QUERIES has no query");
  if (qs.length > MAX_QUERIES) throw new Error(`KB_QUERIES has ${qs.length} queries; maximum ${MAX_QUERIES}`);
  if (qs.some((q) => q.length > 200)) throw new Error("a KB query is longer than 200 characters");
  return qs;
}

// ------------------------------------------------------------- schedules

export interface Schedule {
  schedule_id: string;
  name: string;
  delivery: string | null;
}

export function toolLessSchedules(db: Database.Database): Schedule[] {
  return db
    .prepare("SELECT schedule_id, name, delivery FROM scheduled_tasks WHERE tools='[]' AND active=1 ORDER BY id")
    .all() as Schedule[];
}

// ------------------------------------------------------------------- CLI

/** An error as printed: SQLite code + message, otherwise only its class name (a message could quote data). */
export function errLabel(err: unknown): string {
  if (err && typeof err === "object" && (err as Error).name === "SqliteError") {
    const e = err as Error & { code?: string };
    return `${e.code ?? "SQLITE"}: ${e.message}`;
  }
  return err instanceof Error ? err.name : "unknown error";
}

/** The read-only handle — the ONLY way this script opens a database. */
export function openReadOnly(path: string): Database.Database {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  return db;
}

function parseArgs(argv: string[]): { db: string; queries: string[] } {
  let db: string | null = null;
  let raw = "cliente|factura|deploy";
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${t} needs a value`);
      return v;
    };
    if (t === "--db") db = resolve(value());
    else if (t === "--queries") raw = value();
    else throw new Error(`unknown argument: ${t}`);
  }
  if (!db) throw new Error("--db <path> is required");
  return { db, queries: parseQueries(raw) };
}

function main(): number {
  let args: { db: string; queries: string[] };
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    return 2;
  }
  let db: Database.Database;
  try {
    db = openReadOnly(args.db);
  } catch (err) {
    console.error(`error: cannot open the database read-only (${errLabel(err)})`);
    return 2;
  }
  const status = { census: "ok", collisions: 0, display_disagree: 0, kb: "ok", kb_slow: 0, toolless: "0" };
  try {
    // B
    console.log("B. Credential census (ruling 3d) — verdict of the NEW code");
    let scrub: Array<[string, string]> = [];
    try {
      const facts = db.prepare("SELECT category, key, value FROM user_facts ORDER BY id").all() as FactRow[];
      const projects = db
        .prepare("SELECT slug, urls, credentials, config FROM projects ORDER BY rowid")
        .all() as ProjectRow[];
      const census = buildCensus(facts, projects);
      scrub = census.scrub;
      console.log(formatCensus(census));
      status.collisions = census.collisions.length + census.duplicateNames;
      status.display_disagree = displayDisagreements(census.rows);
    } catch (err) {
      status.census = "error";
      console.log(`  ERROR: census failed (${errLabel(err)})`);
    }
    console.log("");

    // C
    console.log(`C. KB search cost — searchFiles path (FTS_FETCH_CAP=${FTS_FETCH_CAP}, limit ${KB_TOOL_LIMIT}), median of 3`);
    console.log("  (same SQL and per-row scrub work as searchFiles, on the read-only handle; titles/snippets/paths not printed)");
    console.log("  (slight UNDER-estimate: simplified scrub overlap rule, snippet text not built — most visible on rows with many value occurrences)");
    if (status.census === "error") {
      console.log("  note: census failed, so the timing runs WITHOUT the scrub work (lower bound)");
    }
    for (const q of args.queries) {
      try {
        const t = timeKbQuery(db, q, scrub);
        const slow = t.ms > SLOW_MS;
        if (slow) status.kb_slow++;
        console.log(
          `  ${JSON.stringify(q)}: via ${t.via}, fetched ${t.fetched}, returned ${t.returned}, ${t.ms} ms${slow ? `  SLOW (> ${SLOW_MS} ms)` : ""}`,
        );
      } catch (err) {
        status.kb = "error";
        console.log(`  ${JSON.stringify(q)}: ERROR (${errLabel(err)})`);
      }
    }
    console.log("");

    // D
    console.log("D. Tool-less schedules (scheduled_tasks tools='[]' AND active=1)");
    console.log("  Matters ONLY when INFERENCE_PRIMARY_PROVIDER=openai: there such a schedule now runs with NO tools");
    console.log("  (before, it got the full registry). Re-save it with its real tool list if it needs tools.");
    try {
      const rows = toolLessSchedules(db);
      status.toolless = String(rows.length);
      console.log(`  count: ${rows.length}`);
      for (const r of rows) {
        console.log(
          `    ${safeLabel(String(r.schedule_id)) ?? WITHHELD}  ${safeLabel(String(r.name)) ?? WITHHELD}  delivery=${safeLabel(String(r.delivery ?? "")) ?? WITHHELD}`,
        );
      }
    } catch (err) {
      status.toolless = "error";
      console.log(`  ERROR (${errLabel(err)})`);
    }
  } finally {
    db.close();
  }
  console.log(
    `@@status census=${status.census} collisions=${status.collisions} display_disagree=${status.display_disagree} kb=${status.kb} kb_slow=${status.kb_slow} toolless=${status.toolless}`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let code = 2;
  try {
    code = main();
  } catch (err) {
    console.error(`error: ${errLabel(err)}`);
  }
  process.exit(code);
}
