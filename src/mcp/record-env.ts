/**
 * S6 WS3a: the env entries of a record-declared MCP server. A record names
 * what its child reads, in one of three shapes:
 *   - `"NAME"` — from the credential whose reference name is `SECRET_<NAME>`;
 *   - `{ name, secret }` — from the credential `secret` (a `SECRET_…` name the
 *     record lists in `secrets`; a project credential keyed `pg_password` in
 *     slug `acme` is `SECRET_ACME_PG_PASSWORD`), delivered to the child as NAME;
 *   - `{ name, value }` — a literal NON-secret setting (host, port, flags).
 * Secrets never live in a record: a literal whose name or value looks like a
 * credential is refused. One rule set, used by the record schema and the
 * loader; `buildSpawnEnv` resolves the normalised spec.
 */

import { redactSecrets } from "../api/mcp-server/redact.js";
import { isSecretValueName } from "../db/user-facts.js";
import { isProjectSecret } from "../lib/secret-refs.js";
import { ENV_NAME_RE, isDeniedEnvName } from "./env-deny.js";

/** A `capabilities.mcp[].env` entry as written in a record. */
export type RecordEnvEntry = string | { name: string; secret: string } | { name: string; value: string };

/** The normalised form a record server config carries (`envSpec`). */
export type EnvSpecEntry = { name: string; secret: string } | { name: string; value: string };

export const SECRET_REF_RE = /^SECRET_[A-Z0-9_]+$/;
export const ENV_LITERAL_MAX_CHARS = 512;
/**
 * A literal whose UPPERCASED name contains any of these is refused outright
 * (substring, no tokenising: `PGPASSWORD`, `DBPASS`, `CLIENTSECRET`; audit
 * WS3a R1 C2). Over-refusal is the safe side: the entry moves to `{secret}`.
 */
export const SECRET_NAME_FRAGMENTS: readonly string[] = [
  "PASS",
  "PWD",
  "SECRET",
  "TOKEN",
  "KEY",
  "AUTH",
  "CRED",
  "CLAVE",
  "CONTRASENA",
  "PRIVATE",
  "CERT",
];
/** Characters a child env value never carries (Node's spawn echoes the value on `\0`). */
export const ENV_VALUE_FORBIDDEN_RE = /[\r\n\0]/;

/** Why a literal env value may not live in a record, or undefined. Never echoes the value. */
export function literalEnvValueError(name: string, value: string): string | undefined {
  if (value.length === 0) return `env ${name}: literal is empty`;
  if (value.length > ENV_LITERAL_MAX_CHARS) return `env ${name}: literal exceeds ${ENV_LITERAL_MAX_CHARS} characters`;
  if (ENV_VALUE_FORBIDDEN_RE.test(value)) return `env ${name}: literal contains a newline or NUL`;
  const upper = name.toUpperCase();
  const fragment = SECRET_NAME_FRAGMENTS.find((f) => upper.includes(f));
  if (fragment) {
    return `env ${name}: literal name contains "${fragment}" (secret-shaped; store it in credentials and use {name, secret})`;
  }
  if (
    isSecretValueName(name) ||
    isProjectSecret(name, value) ||
    // Every credential shape plus the loose 40+ hex blob (the only
    // entropy-style rule that exists; nothing general is invented here).
    redactSecrets(value) !== value
  ) {
    return `env ${name}: literal is secret-shaped (store it in credentials and use {name, secret})`;
  }
  return undefined;
}

/**
 * Loader re-check + normalisation (defence in depth behind the schema).
 * Errors carry env NAMES only (a malformed name is counted, not echoed).
 */
export function resolveRecordEnv(
  entries: unknown,
  secrets: readonly string[],
): { spec: EnvSpecEntry[] } | { error: string } {
  if (entries === undefined) return { spec: [] };
  if (!Array.isArray(entries)) return { error: "env must be an array" };
  const spec: EnvSpecEntry[] = [];
  let malformed = 0;
  for (const e of entries as unknown[]) {
    if (typeof e === "string") {
      spec.push({ name: e, secret: `SECRET_${e}` });
      continue;
    }
    const o = e as Record<string, unknown> | null;
    const keys = o && typeof o === "object" ? Object.keys(o).sort().join(",") : "";
    if (keys === "name,secret" && typeof o!.name === "string" && typeof o!.secret === "string") {
      spec.push({ name: o!.name, secret: o!.secret });
    } else if (keys === "name,value" && typeof o!.name === "string" && typeof o!.value === "string") {
      spec.push({ name: o!.name, value: o!.value });
    } else {
      malformed++;
    }
  }
  malformed += spec.filter((s) => !ENV_NAME_RE.test(s.name)).length;
  if (malformed > 0) return { error: `${malformed} env entry(ies) malformed or not matching ${ENV_NAME_RE.source}` };
  const denied = spec.filter((s) => isDeniedEnvName(s.name)).map((s) => s.name);
  if (denied.length > 0) return { error: `env name(s) reserved: ${denied.join(", ")}` };
  const seen = new Set<string>();
  for (const s of spec) {
    if (seen.has(s.name)) return { error: `env ${s.name} declared twice` };
    seen.add(s.name);
  }
  for (const [i, s] of spec.entries()) {
    if ("value" in s) {
      const err = literalEnvValueError(s.name, s.value);
      if (err) return { error: err };
    } else if (typeof entries[i] !== "string") {
      // An explicit reference must be a listed secret; a bare "NAME" keeps its
      // spawn-time rule (omitted with a warn when `SECRET_<NAME>` is unlisted).
      if (!SECRET_REF_RE.test(s.secret) || !secrets.includes(s.secret)) {
        return { error: `env ${s.name}: secret ${SECRET_REF_RE.test(s.secret) ? s.secret : "(malformed)"} is not in the record's secrets` };
      }
    }
  }
  return { spec };
}
