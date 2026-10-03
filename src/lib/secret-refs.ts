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
 * - An unknown `{{SECRET_X}}` in a template tool, or `$SECRET_X` in
 *   shell_exec, refuses the call (no value involved); so does any
 *   `${…SECRET_…}` expansion other than the bare `${SECRET_X}`.
 *
 * Internal consumers that read the stores for their own API calls (Gemini key
 * fallback, scripts) read the raw rows directly and are unaffected.
 */

import { createHash } from "node:crypto";
import { getDatabase } from "../db/index.js";
import {
  isCredentialFact,
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
}

let cache: SecretIndex | null = null;

/** Drop the cached index; every writer to either store calls this. */
export function invalidateSecretRefs(): void {
  cache = null;
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
): void {
  if (value === null || value === undefined || value === "") return;
  if (Array.isArray(value)) {
    value.forEach((v, i) =>
      projectEntries(slug, field, v, [...path, String(i)], key, out),
    );
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      projectEntries(slug, field, v, [...path, k], k, out);
    }
    return;
  }
  if (typeof value !== "string" && typeof value !== "number") return;
  const str = String(value);
  if (!isProjectSecret(key, str)) return;
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
  for (const e of entries) {
    const name =
      (count.get(e.base) ?? 0) > 1
        ? `${e.base}_${createHash("sha256").update(e.identity).digest("hex").slice(0, 6).toUpperCase()}`
        : e.base;
    nameOf.set(e.identity, name);
    valueOf.set(name, e.value);
    if (e.value.length < MIN_SCRUB_LENGTH) continue;
    const ph = secretPlaceholder(name);
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
  return { at: Date.now(), nameOf, valueOf, scrub };
}

const EMPTY: SecretIndex = {
  at: 0,
  nameOf: new Map(),
  valueOf: new Map(),
  scrub: [],
};

function index(): SecretIndex {
  if (!cache || Date.now() - cache.at > INDEX_TTL_MS) cache = buildIndex();
  return cache ?? EMPTY;
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
  const walk = (v: unknown, path: string[], leafKey: string): void => {
    if (v === null || v === undefined || v === "") return;
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, [...path, String(i)], leafKey));
      return;
    }
    if (typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        walk(x, [...path, k], k);
      }
      return;
    }
    if (typeof v !== "string" && typeof v !== "number") return;
    const str = String(v);
    const secret = isProjectSecret(leafKey, str);
    out.push({
      path,
      secret,
      display: displayFor(projectIdentity(slug, field, path), secret, str),
    });
  };
  walk(value, [key], key);
  return out;
}

/**
 * Replace every stored credential value (and its URL-encoded and JSON-escaped
 * forms) with its placeholder. Plain substring replacement, longest value first.
 */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const [value, ph] of index().scrub) {
    if (out.includes(value)) out = out.replaceAll(value, () => ph);
  }
  return out;
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
