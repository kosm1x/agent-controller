/**
 * Ruling 3c (2026-10-01, "mask, keep in Jarvis, use by name"): stored
 * credentials (credential-style `user_facts` rows and `projects` entries,
 * judged by the ONE classifier `isCredentialFact`) are never shown to the
 * model. Each gets a reference name `SECRET_…`; the model writes the name and
 * the tool seam (`ToolRegistry.executeDirect`) fills the value in at
 * execution and scrubs every stored value out of what comes back.
 *
 * - `shell_exec`: `$SECRET_X` / `${SECRET_X}` → exported into that child's
 *   env only (`secretEnvForCommand`); the command text is never rewritten.
 * - `TEMPLATE_TOOLS` (http_fetch + browser navigate/type/fill):
 *   `{{SECRET_X}}` inside any string argument → the value, on a copy of the
 *   args (the caller's object — what gets recorded — keeps the reference).
 * - Every other tool: references stay literal text.
 * - A rendered placeholder sent back (audit R6 B2, `resolveRenderedPlaceholders`):
 *   file-content writes get the stored value again; any other write is refused.
 * - An unknown `{{SECRET_X}}` in a template tool, or `$SECRET_X` in
 *   shell_exec, refuses the call (no value involved); so does any
 *   `${…SECRET_…}` expansion other than the bare `${SECRET_X}`.
 *
 * Internal consumers that read the stores for their own API calls (Gemini key
 * fallback, scripts) read the raw rows directly and are unaffected.
 */

import { createHash } from "node:crypto";
import { getDatabase } from "../db/index.js";
import { createLogger } from "./logger.js";
import {
  isCredentialFact,
  isSecretValueName,
  CREDENTIAL_FACT_PLACEHOLDER,
} from "../db/user-facts.js";

/** Tools whose string arguments get `{{SECRET_X}}` substituted. */
export const TEMPLATE_TOOLS: ReadonlySet<string> = new Set([
  "http_fetch",
  "browser__goto",
  "browser__fill",
  "playwright__browser_navigate",
  "playwright__browser_type",
  "playwright__browser_fill_form",
]);

/** Values shorter than this are not scrubbed (too likely to hit prose). */
export const MIN_SCRUB_LENGTH = 8;

/** Index rebuilt at most this often even without a write (external sqlite edits). */
const INDEX_TTL_MS = 60_000;

const TEMPLATE_RE = /\{\{(SECRET_[A-Za-z0-9_]+)\}\}/g;
const SHELL_REF_RE = /\$\{(SECRET_[A-Za-z0-9_]+)\}|\$(SECRET_[A-Za-z0-9_]+)/g;
/**
 * Any `${…SECRET_…}` form other than the bare `${SECRET_X}`: an operator
 * (`${SECRET_X:-d}`, `${SECRET_X#p}`, `${SECRET_X:0:4}`), length
 * (`${#SECRET_X}`), indirection (`${!SECRET_X}`), or an unclosed brace. These
 * would hand the shell a transform of the value the scrub cannot recognise.
 */
const SHELL_EXPANSION_RE =
  /\$\{[#!]SECRET_|\$\{SECRET_[A-Za-z0-9_]*(?:[^A-Za-z0-9_}]|$)/;

interface SecretIndex {
  at: number;
  /** identity ("fact\0cat\0key" | "project\0slug\0field\0path") → name */
  nameOf: Map<string, string>;
  valueOf: Map<string, string>;
  /** [value, placeholder], longest value first; URL-encoded and JSON-escaped forms included. */
  scrub: Array<[string, string]>;
  /** raw scrubbed value (>= MIN_SCRUB_LENGTH) → placeholder; numeric JSON leaves are matched here. */
  exact: Map<string, string>;
}

let cache: SecretIndex | null = null;
/**
 * Audit round 5 (S5): set by every store write, cleared by the next good
 * build. While set, the last good index is known to be stale (a value was
 * written after it), so a failing build throws instead of falling back.
 */
let dirtySinceLastGood = false;

/** Drop the cached index; every writer to either store calls this. */
export function invalidateSecretRefs(): void {
  cache = null;
  dirtySinceLastGood = true;
}

function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function factIdentity(category: string, key: string): string {
  return `fact\0${category}\0${key}`;
}

export function projectIdentity(
  slug: string,
  field: string,
  path: string[],
): string {
  return `project\0${slug}\0${field}\0${path.join("\0")}`;
}

/**
 * The one display form of a hidden value: its name and how to use it. No `"`
 * and no backslash, so a JSON tool result stays valid JSON after scrubbing.
 */
export function secretPlaceholder(name: string): string {
  return `[oculto · úsalo por nombre: $${name} en shell_exec, {{${name}}} en http_fetch/navegador]`;
}

/**
 * Whether a project entry is a secret. Ruling 3d (2026-10-03, "Just real
 * credentials. Everything must be accessible"): every field — `credentials`
 * included — is judged by the ONE classifier on the entry's own key and
 * value, under the neutral category "projects" (the field name
 * "credentials" is not itself a reason). Usernames, e-mails, hosts, ports,
 * URLs and IDs stored under `credentials` stay visible and unscrubbed; a
 * key named like a credential or a value shaped like one is hidden.
 */
export function isProjectSecret(key: string, value: string): boolean {
  return isCredentialFact("projects", key, value);
}

/**
 * Audit round 4 (3d-a), narrowed in round 5 (B1): whether every leaf below a
 * key with this name is a secret — the name's LAST token names a secret
 * value (`password: {prod, staging}`, `github_token: {value, scope}`,
 * `api_keys: [v]`). A container — any name whose credential word is
 * auth / oauth / credential(s) / creds / credencial(es) (`db_credentials`,
 * `basic_auth`, `google_oauth`, `oauth_config`, `credenciales_ftp`) — is not:
 * its children are judged by their own keys and values (ruling 3d). The
 * meta-suffix exemption applies (`api_key_path: {…}` is not).
 */
export function isSecretAncestorName(key: string): boolean {
  return isSecretValueName(key.trim());
}

interface Entry {
  identity: string;
  base: string;
  value: string;
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

/** Secret string/number leaves of a project JSON field (isProjectSecret). */
function projectEntries(
  slug: string,
  field: string,
  value: unknown,
  path: string[],
  key: string,
  out: Entry[],
  underSecret = false,
): void {
  if (value === null || value === undefined || value === "") return;
  if (Array.isArray(value)) {
    value.forEach((v, i) =>
      projectEntries(slug, field, v, [...path, String(i)], key, out, underSecret),
    );
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      projectEntries(
        slug,
        field,
        v,
        [...path, k],
        k,
        out,
        underSecret || isSecretAncestorName(k),
      );
    }
    return;
  }
  if (typeof value !== "string" && typeof value !== "number") return;
  const str = String(value);
  // Same rule as projectEntryLeaves (index and display stay identical).
  if (!underSecret && !isProjectSecret(key, str)) return;
  const prefix = field === "credentials" ? [slug] : [slug, field];
  out.push({
    identity: projectIdentity(slug, field, path),
    base: `SECRET_${norm([...prefix, ...path].join("_"))}`,
    value: str,
  });
}

function buildIndex(): SecretIndex | null {
  let db: ReturnType<typeof getDatabase>;
  try {
    db = getDatabase();
  } catch {
    return null; // no database open in this process: no stored secrets
  }
  let facts: Array<{ category: string; key: string; value: string }>;
  let projects: Array<Record<string, unknown>>;
  try {
    facts = db
      .prepare("SELECT category, key, value FROM user_facts")
      .all() as typeof facts;
    projects = db
      .prepare("SELECT slug, urls, credentials, config FROM projects")
      .all() as typeof projects;
  } catch (err) {
    // A database without the two stores (a partial test schema) holds none.
    if (/no such table/.test(String(err))) return null;
    throw err;
  }
  const entries: Entry[] = [];
  for (const f of facts) {
    if (typeof f.value !== "string") continue;
    if (!isCredentialFact(f.category, f.key, f.value)) continue;
    entries.push({
      identity: factIdentity(f.category, f.key),
      base: `SECRET_${norm(`${f.category}_${f.key}`)}`,
      value: f.value,
    });
  }
  for (const p of projects) {
    if (typeof p.slug !== "string") continue;
    for (const field of ["credentials", "urls", "config"]) {
      projectEntries(p.slug, field, parseObject(p[field]), [], "", entries);
    }
  }

  // Collision rule: every member of a group sharing a base name gets a
  // suffix from its own identity — deterministic, independent of row order.
  const count = new Map<string, number>();
  for (const e of entries) count.set(e.base, (count.get(e.base) ?? 0) + 1);
  const nameOf = new Map<string, string>();
  const valueOf = new Map<string, string>();
  const scrub: Array<[string, string]> = [];
  const exact = new Map<string, string>();
  for (const e of entries) {
    const name =
      (count.get(e.base) ?? 0) > 1
        ? `${e.base}_${createHash("sha256").update(e.identity).digest("hex").slice(0, 6).toUpperCase()}`
        : e.base;
    nameOf.set(e.identity, name);
    valueOf.set(name, e.value);
    if (e.value.length < MIN_SCRUB_LENGTH) continue;
    const ph = secretPlaceholder(name);
    exact.set(e.value, ph);
    // The value as it appears raw, URL-encoded, and inside a JSON string
    // (escaped once, and twice for JSON nested in a JSON string).
    const escaped = JSON.stringify(e.value).slice(1, -1);
    for (const form of new Set([
      e.value,
      encodeURIComponent(e.value),
      escaped,
      JSON.stringify(escaped).slice(1, -1),
    ])) {
      scrub.push([form, ph]);
    }
  }
  scrub.sort((a, b) => b[0].length - a[0].length);
  return { at: Date.now(), nameOf, valueOf, scrub, exact };
}

const EMPTY: SecretIndex = {
  at: 0,
  nameOf: new Map(),
  valueOf: new Map(),
  scrub: [],
  exact: new Map(),
};

const log = createLogger("secret-refs");

/**
 * The last index built from the stores without an error. Survives `invalidateSecretRefs` on purpose —
 * it is the fallback while the database errors.
 */
let lastGood: SecretIndex | null = null;
/** True while builds are failing; the warn is logged once per failure episode. */
let failing = false;

/**
 * Failure policy (audit round 4, tightened in round 5 / S5): a build error
 * other than "no such table" falls back to the last successfully built index
 * only while that index is known current — no store write since it was built
 * (the TTL expired, nothing changed in-process). Logged once per failure
 * episode; the next call retries the build. With no last-good index, or with
 * a write since it (`dirtySinceLastGood`: a value stored after it would be
 * missed), the error is rethrown, so every consumer — the tool seam, the
 * inference seam, the writers — fails closed. The recovery is logged once.
 */
function index(): SecretIndex {
  if (cache && Date.now() - cache.at <= INDEX_TTL_MS) return cache;
  let built: SecretIndex | null;
  try {
    built = buildIndex();
  } catch (err) {
    if (!lastGood || dirtySinceLastGood) {
      if (!failing) {
        failing = true;
        log.warn(
          { err: String(err), stale: dirtySinceLastGood },
          "secret index build failed; failing closed (no current index)",
        );
      }
      throw err;
    }
    if (!failing) {
      failing = true;
      log.warn(
        { err: String(err) },
        "secret index build failed; scrubbing with the last good index",
      );
    }
    return lastGood;
  }
  if (failing) log.info("secret index build recovered");
  failing = false;
  // Audit R6 should-fix 5: a null build (no database open in this process,
  // or no store tables) read nothing, so it does not clear the dirty flag —
  // a later failing build must not fall back to a lastGood older than the
  // last store write.
  if (built) dirtySinceLastGood = false;
  // No database / no store tables: nothing cached (re-read next call, as
  // before), and not a fallback either — an index that read nothing must
  // never stand in for a database that errors.
  cache = built;
  if (built) lastGood = built;
  return built ?? EMPTY;
}

/** Test-only: forget the cached AND the last-good index. */
export function resetSecretRefsForTest(): void {
  cache = null;
  lastGood = null;
  failing = false;
  dirtySinceLastGood = false;
}

/** Test-only: age the cached index past its TTL WITHOUT a store write. */
export function expireSecretRefsForTest(): void {
  if (cache) cache = { ...cache, at: 0 };
}

/** Reference name of a stored credential, or undefined. */
export function secretRefName(identity: string): string | undefined {
  return index().nameOf.get(identity);
}

/** Display form of a stored item: the value, or its by-name placeholder. */
function displayFor(identity: string, isSecret: boolean, value: string) {
  if (!isSecret) return value;
  const name = secretRefName(identity);
  return name ? secretPlaceholder(name) : CREDENTIAL_FACT_PLACEHOLDER;
}

/** A user fact's value as the model may see it. */
export function factSecretDisplay(
  category: string,
  key: string,
  value: string,
): string {
  return displayFor(
    factIdentity(category, key),
    isCredentialFact(category, key, value),
    value,
  );
}

/** A top-level project entry (`credentials` / `urls` / `config` key) as the model may see it. */
export function projectSecretDisplay(
  slug: string,
  field: "credentials" | "urls" | "config",
  key: string,
  value: unknown,
): string {
  const str = String(value);
  return displayFor(
    projectIdentity(slug, field, [key]),
    isProjectSecret(key, str),
    str,
  );
}

/**
 * Every string/number leaf under one project entry (`credentials` / `urls` /
 * `config` key `key`), with its path from that key and its display form —
 * the same identity and name the index gives a nested value (audit R3 S4).
 * A scalar entry yields one leaf with path `[key]`.
 */
export function projectEntryLeaves(
  slug: string,
  field: "credentials" | "urls" | "config",
  key: string,
  value: unknown,
): Array<{ path: string[]; secret: boolean; display: string }> {
  const out: Array<{ path: string[]; secret: boolean; display: string }> = [];
  // Audit round 4 (3d-a): a leaf is secret when its own key/value says so OR
  // any ancestor key is a credential name (isSecretAncestorName) — the same
  // rule as the index's projectEntries.
  const walk = (
    v: unknown,
    path: string[],
    leafKey: string,
    underSecret: boolean,
  ): void => {
    if (v === null || v === undefined || v === "") return;
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, [...path, String(i)], leafKey, underSecret));
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
    const secret = underSecret || isProjectSecret(leafKey, str);
    out.push({
      path,
      secret,
      display: displayFor(projectIdentity(slug, field, path), secret, str),
    });
  };
  // The entry key itself is an ancestor of every leaf below an object/array.
  const nested = value !== null && typeof value === "object";
  walk(value, [key], key, nested && isSecretAncestorName(key));
  return out;
}

/**
 * Replace every stored credential value (and its URL-encoded and JSON-escaped
 * forms) with its placeholder. Plain substring replacement, longest value first.
 */
export function scrubSecrets(text: string): string {
  return scrubWith(index(), text);
}

/**
 * Audit round 5 (outbound tool-call arguments): scrub a JSON-able value
 * structurally — every string leaf through `scrubSecrets`, and every NUMBER
 * leaf whose decimal form equals a stored value replaced by that value's
 * placeholder string (a numeric PIN or account secret would otherwise pass
 * the substring scrub only by luck). Object keys are scrubbed too (audit R6
 * B3: `scrubJsonText` re-stringifies this result, so a key left alone would
 * put a stored value back in the text). Returns the same object when nothing
 * changed.
 */
export function scrubStructured(value: unknown): unknown {
  const idx = index();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return scrubWith(idx, v);
    if (typeof v === "number") return idx.exact.get(String(v)) ?? v;
    if (Array.isArray(v)) {
      const out = v.map(walk);
      return out.some((x, i) => x !== v[i]) ? out : v;
    }
    if (v && typeof v === "object") {
      let changed = false;
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        // Audit R6 B3: a key can carry a stored value too (`{"<value>": …}`).
        const key = scrubWith(idx, k);
        const val = walk(x);
        if (key !== k || val !== x) changed = true;
        out[key] = val;
      }
      return changed ? out : v;
    }
    return v;
  };
  return walk(value);
}

/**
 * JSON-aware scrub of a JSON text (tool-call arguments): parsed, scrubbed
 * with `scrubStructured`, re-stringified — the original text when nothing
 * changed (prompt-cache prefix stays byte-identical). Text that does not
 * parse falls back to the substring scrub.
 */
export function scrubJsonText(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return scrubSecrets(text);
  }
  const clean = scrubStructured(parsed);
  return clean === parsed ? scrubSecrets(text) : JSON.stringify(clean);
}

function scrubWith(idx: SecretIndex, text: string): string {
  let out = text;
  for (const [value, ph] of idx.scrub) {
    if (out.includes(value)) out = out.replaceAll(value, () => ph);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Audit round 5 (B2): a stored value written back BY NAME
// ---------------------------------------------------------------------------

/**
 * The rendered prefix of every hidden-value display: `secretPlaceholder` and
 * the generic `CREDENTIAL_FACT_PLACEHOLDER` (literals — the two modules import
 * each other; secret-refs.test.ts pins that both displays start with these).
 */
export const PLACEHOLDER_MARKERS: readonly string[] = ["[oculto ·", "[valor oculto"];
const BARE_REF_RE =
  /^(?:\{\{(SECRET_[A-Za-z0-9_]+)\}\}|\$\{(SECRET_[A-Za-z0-9_]+)\}|\$(SECRET_[A-Za-z0-9_]+))$/;
const PLACEHOLDER_NAME_RE = /\$(SECRET_[A-Za-z0-9_]+) /;

export type StoredRefResolution =
  | { kind: "plain" }
  | { kind: "resolved"; value: string; name: string }
  | { kind: "error"; error: string };

/**
 * A value a store-writing tool (`user_fact_set`, `project_update`) received:
 * - exactly a secret placeholder (as rendered), `{{SECRET_X}}`, `${SECRET_X}`
 *   or `$SECRET_X` → the stored value of that name (moving or renaming a
 *   credential keeps it); an unknown name → error;
 * - any other value containing a placeholder marker (`[oculto ·`, the
 *   generic `[valor oculto`) → error: the model must write the reference;
 * - anything else → plain (stored as given).
 */
export function resolveStoredReference(value: string): StoredRefResolution {
  const t = value.trim();
  let name: string | undefined;
  const bare = BARE_REF_RE.exec(t);
  if (bare) name = bare[1] ?? bare[2] ?? bare[3];
  else {
    const m = PLACEHOLDER_NAME_RE.exec(t);
    if (m && t === secretPlaceholder(m[1]!)) name = m[1];
  }
  if (name) {
    const stored = index().valueOf.get(name);
    if (stored === undefined) {
      return {
        kind: "error",
        error: `No guardé: no hay credencial guardada con el nombre ${name}. Usa el nombre exacto que muestra el dato oculto.`,
      };
    }
    return { kind: "resolved", value: stored, name };
  }
  if (PLACEHOLDER_MARKERS.some((m) => value.includes(m))) {
    return {
      kind: "error",
      error:
        "No guardé: el valor contiene un dato oculto. Para copiar o mover una credencial guardada, escribe como valor completo solo su referencia ({{SECRET_<NOMBRE>}} o $SECRET_<NOMBRE>); para un valor nuevo, escribe el valor real.",
    };
  }
  return { kind: "plain" };
}

/**
 * `resolveStoredReference` over every string leaf of a JSON-able value.
 * Returns a copy with references resolved plus the paths that were resolved
 * (the caller checks each still lands on a hidden key), or the first error.
 */
export function resolveStoredReferencesDeep(
  value: unknown,
):
  | { value: unknown; resolvedPaths: string[][] }
  | { error: string } {
  const resolvedPaths: string[][] = [];
  let error: string | undefined;
  const walk = (v: unknown, path: string[]): unknown => {
    if (error) return v;
    if (typeof v === "string") {
      const r = resolveStoredReference(v);
      if (r.kind === "error") {
        error = r.error;
        return v;
      }
      if (r.kind === "resolved") {
        resolvedPaths.push(path);
        return r.value;
      }
      return v;
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, [...path, String(i)]));
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [
          k,
          walk(x, [...path, k]),
        ]),
      );
    }
    return v;
  };
  const out = walk(value, []);
  return error ? { error } : { value: out, resolvedPaths };
}

/** The refusal when a credential written by name would land on a visible key. */
export function visibleDestinationError(where: string): string {
  return `No guardé: ${where} no es un nombre de credencial, así que el valor quedaría visible. Usa una clave que nombre la credencial (p. ej. …_password, …_token, …_api_key).`;
}

function unknownRefError(tool: string, names: string[]): string {
  const list = [...new Set(names)].join(", ");
  return JSON.stringify({
    error: `No ejecuté ${tool}: no hay credencial guardada con el nombre ${list}. Usa el nombre exacto que muestra el dato oculto.`,
  });
}

function shellExpansionError(): string {
  return JSON.stringify({
    error:
      "No ejecuté shell_exec: escribe la referencia tal cual, $SECRET_<NOMBRE> o ${SECRET_<NOMBRE>}, sin operadores de expansión (${SECRET_X:-…}, ${SECRET_X#…}, ${#SECRET_X}, ${!SECRET_X}).",
  });
}

function substitute(
  value: unknown,
  valueOf: Map<string, string>,
  unknown: string[],
): unknown {
  if (typeof value === "string") {
    return value.replace(TEMPLATE_RE, (m, name: string) => {
      const v = valueOf.get(name);
      if (v === undefined) {
        unknown.push(name);
        return m;
      }
      return v;
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => substitute(v, valueOf, unknown));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        substitute(v, valueOf, unknown),
      ]),
    );
  }
  return value;
}

/**
 * Resolve secret references for one tool call. Returns the args to execute
 * with (a COPY when anything was substituted — never the caller's object) or
 * an `{error}` JSON string naming unknown references. shell_exec gets its
 * args back unchanged (secretEnvForCommand fills the child env) unless a
 * `$SECRET_X` it names is not stored.
 */
export function resolveSecretRefs(
  tool: string,
  args: Record<string, unknown>,
): { args: Record<string, unknown> } | { error: string } {
  if (tool === "shell_exec" && typeof args.command === "string") {
    if (SHELL_EXPANSION_RE.test(args.command)) {
      return { error: shellExpansionError() };
    }
    const { valueOf } = index();
    const unknown = shellRefNames(args.command).filter((n) => !valueOf.has(n));
    return unknown.length > 0
      ? { error: unknownRefError(tool, unknown) }
      : { args };
  }
  if (!TEMPLATE_TOOLS.has(tool)) return { args };
  if (!JSON.stringify(args).includes("{{SECRET_")) return { args };
  const unknown: string[] = [];
  const resolved = substitute(args, index().valueOf, unknown) as Record<
    string,
    unknown
  >;
  return unknown.length > 0
    ? { error: unknownRefError(tool, unknown) }
    : { args: resolved };
}

function shellRefNames(command: string): string[] {
  return [...command.matchAll(SHELL_REF_RE)].map((m) => m[1] ?? m[2]!);
}

/**
 * Extra env for a shell_exec child: exactly the stored secrets its command
 * references as `$SECRET_X` / `${SECRET_X}`; nothing else.
 */
export function secretEnvForCommand(command: string): Record<string, string> {
  const env: Record<string, string> = {};
  const { valueOf } = index();
  for (const name of shellRefNames(command)) {
    const v = valueOf.get(name);
    if (v !== undefined) env[name] = v;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Audit round 6 (B2): a rendered placeholder written back through a tool
// ---------------------------------------------------------------------------

/**
 * Tools that write FILE CONTENT. A read of the file shows each stored value
 * as its rendered placeholder; a read-modify-write would otherwise put the
 * placeholder on disk and destroy the credential (ruling 3c: no loss of
 * functionality). In the content fields below each placeholder that names a
 * stored secret is turned back into that secret's value (on a copy).
 */
export const FILE_CONTENT_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "file_write",
  "file_edit",
  "jarvis_file_write",
  "jarvis_file_update",
  "jarvis_files_batch_write",
]);
/** Argument keys holding file content (file_edit's camelCase aliases too). */
const FILE_CONTENT_KEYS: ReadonlySet<string> = new Set([
  "content",
  "old_string",
  "new_string",
  "oldString",
  "newString",
  "append",
]);
/**
 * Tools that resolve a whole-value placeholder themselves and refuse any
 * other placeholder text (`resolveStoredReference`, audit R5 B2a).
 */
const STORE_REF_TOOLS: ReadonlySet<string> = new Set([
  "user_fact_set",
  "project_update",
]);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `secretPlaceholder(<name>)` as rendered, the name captured (both copies must agree). */
const RENDERED_PLACEHOLDER_RE: RegExp = (() => {
  const SLOT = "SECRET_\u0001";
  const parts = secretPlaceholder(SLOT).split(SLOT);
  if (parts.length !== 3) throw new Error("secretPlaceholder shape changed");
  return new RegExp(
    escapeRe(parts[0]!) +
      "(SECRET_[A-Za-z0-9_]+)" +
      escapeRe(parts[1]!) +
      "\\1" +
      escapeRe(parts[2]!),
    "g",
  );
})();

function hasPlaceholderMarker(s: string): boolean {
  return PLACEHOLDER_MARKERS.some((m) => s.includes(m));
}

function renderedPlaceholderError(tool: string, why: string): string {
  return JSON.stringify({
    error: `No ejecuté ${tool}: ${why}`,
  });
}

/**
 * Resolve / refuse rendered hidden-value placeholders in one tool call's
 * arguments, before `resolveSecretRefs` (registry seam):
 * - file-content write tools: in content fields, each rendered placeholder
 *   naming a stored secret becomes its value (file_edit `old_string` too, so
 *   it still matches the file on disk). A placeholder naming no stored
 *   secret, the generic one, a mangled one, or one outside a content field
 *   refuses the call.
 * - `user_fact_set` / `project_update`: untouched (their own resolution).
 * - every other non-read-only tool: any placeholder text refuses the call —
 *   the model must use `$SECRET_X` (shell_exec) or `{{SECRET_X}}`
 *   (http_fetch / browser) instead.
 * Returns the args to run with (a copy when something was resolved — the
 * caller's object keeps the placeholder) or an `{error}` JSON string.
 */
export function resolveRenderedPlaceholders(
  tool: string,
  args: Record<string, unknown>,
  readOnly: boolean,
): { args: Record<string, unknown> } | { error: string } {
  if (STORE_REF_TOOLS.has(tool)) return { args };
  const strings: string[] = [];
  const collect = (v: unknown): void => {
    if (typeof v === "string") strings.push(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === "object") Object.values(v).forEach(collect);
  };
  collect(args);
  if (!strings.some(hasPlaceholderMarker)) return { args };

  if (!FILE_CONTENT_WRITE_TOOLS.has(tool)) {
    // A read-only tool sends nothing anywhere; shell_exec and the template
    // tools are refused whatever their annotation says.
    if (readOnly && tool !== "shell_exec" && !TEMPLATE_TOOLS.has(tool)) {
      return { args };
    }
    return {
      error: renderedPlaceholderError(
        tool,
        "los argumentos contienen un dato oculto ([oculto · …]), que no es el valor real. Para usar una credencial guardada escribe su referencia: $SECRET_<NOMBRE> en shell_exec, {{SECRET_<NOMBRE>}} en http_fetch/navegador; si no necesitas el valor, quita el texto del dato oculto.",
      ),
    };
  }

  const { valueOf } = index();
  let error: string | undefined;
  const resolveText = (s: string): string => {
    if (!hasPlaceholderMarker(s)) return s;
    const unknown: string[] = [];
    const out = s.replace(RENDERED_PLACEHOLDER_RE, (m, name: string) => {
      const v = valueOf.get(name);
      if (v === undefined) {
        unknown.push(name);
        return m;
      }
      return v;
    });
    if (unknown.length > 0) {
      error = renderedPlaceholderError(
        tool,
        `no hay credencial guardada con el nombre ${[...new Set(unknown)].join(", ")}; no escribí el dato oculto en el archivo.`,
      );
      return s;
    }
    if (hasPlaceholderMarker(s.replace(RENDERED_PLACEHOLDER_RE, ""))) {
      error = renderedPlaceholderError(
        tool,
        "el contenido tiene un dato oculto incompleto o sin nombre, y no sé qué valor guardado es; no escribí el dato oculto en el archivo. Copia el dato oculto completo tal como se mostró, o escribe el valor real.",
      );
      return s;
    }
    return out;
  };
  const walk = (v: unknown, inContent: boolean): unknown => {
    if (error) return v;
    if (typeof v === "string") {
      if (inContent) return resolveText(v);
      if (hasPlaceholderMarker(v)) {
        error = renderedPlaceholderError(
          tool,
          "un dato oculto solo puede ir en el contenido del archivo, no en la ruta ni en otros campos.",
        );
      }
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, inContent));
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [
          k,
          walk(x, FILE_CONTENT_KEYS.has(k)),
        ]),
      );
    }
    return v;
  };
  const resolved = walk(args, false) as Record<string, unknown>;
  return error ? { error } : { args: resolved };
}
