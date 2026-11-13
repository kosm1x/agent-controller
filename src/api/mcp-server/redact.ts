/**
 * Secret redaction for MCP tool output (v7.7.1 hardening).
 *
 * jarvis_task_detail and similar read-only tools return raw task rows
 * that can contain API keys, OAuth tokens, bearer credentials, and
 * passwords pasted into Jarvis by the user or pulled from tool output.
 * The read_only scope label is not a confidentiality guarantee — a
 * stolen bearer token should NOT hand back the full credential corpus.
 *
 * This module applies the shared secret list (`src/lib/redact-secrets.ts`,
 * the one list every redaction path uses) to task columns and tool output
 * before they leave the MCP boundary or reach a durable column, with the
 * `[REDACTED…]` placeholder style. The full variant also removes 40+ char
 * hex blobs (SHA/HMAC material).
 *
 * Not a substitute for per-field allow-listing, but closes the "dump
 * everything" blast radius.
 */

import { redactSecretText } from "../../lib/redact-secrets.js";
import {
  storeReplacer,
  withholdForStore,
} from "../../lib/v8-4/store-withhold.js";

/** Apply redaction patterns to a string. Returns a new string. */
export function redactSecrets(input: string | null | undefined): string {
  if (input == null) return "";
  return redactSecretText(input, { style: "generic", hexBlobs: true });
}

/**
 * Credential shapes only — the shared list without the loose hex-blob rule.
 * For output the agent must keep working with (shell stdout, where 40-char git
 * SHAs are ordinary data), so the hex rule would break it.
 */
export function redactCredentials(input: string | null | undefined): string {
  if (input == null) return "";
  return redactSecretText(input, { style: "generic" });
}

let persistRedactWarned = false;

function persistRedactFailed(err: unknown): void {
  if (persistRedactWarned) return;
  persistRedactWarned = true;
  console.warn(
    `[redact] credential redaction failed — writing raw (further failures not logged): ${err instanceof Error ? err.message : String(err)}`,
  );
}

/**
 * redactCredentials for a string bound for a durable column (tasks.error,
 * runs.error), plus the mailbox-password store rule (store-withhold.ts).
 * null/undefined stay null. Fail-open: a redactor bug must never lose the
 * write it guards, so a throw returns the raw string (warned once).
 */
export function redactCredentialsForPersist(
  input: string | null | undefined,
): string | null {
  if (input == null) return null;
  try {
    return withholdForStore(redactCredentials(input));
  } catch (err) {
    persistRedactFailed(err);
    // The store rule never throws: it still applies to the raw string.
    return withholdForStore(input);
  }
}

const redactStringValue = (key: string, v: unknown): unknown =>
  typeof v === "string" ? storeReplacer(key, redactCredentials(v)) : v;

/**
 * JSON.stringify for a durable column (events.data, runs.output, runs.trace,
 * trace attrs, SSE frames) with redactCredentials applied to every string
 * VALUE at any depth, inside the serialization pass — never a regex over JSON
 * text, and the mailbox-password store rule on the same string values
 * (store-withhold.ts). Keys are not touched; the input is never mutated.
 * `keepRaw` names top-level keys of a plain-object root that are serialized
 * verbatim, without the store rule either (by key,
 * not by object identity, so a reference shared with another field stays
 * redacted there). Fail-open like redactCredentialsForPersist; a genuine
 * serialization error (cycle, BigInt) still throws as JSON.stringify would.
 */
export function stringifyRedacted(
  value: unknown,
  keepRaw: readonly string[] = [],
): string {
  try {
    return stringifyKeeping(value, keepRaw, redactStringValue);
  } catch (err) {
    // The store rule still applies here (storeReplacer never throws), and
    // keepRaw fields stay verbatim on this branch too.
    const plain = stringifyKeeping(value, keepRaw, storeReplacer);
    persistRedactFailed(err);
    return plain;
  }
}

/** JSON.stringify with `replacer`, except keepRaw top-level keys of a plain-object root. */
function stringifyKeeping(
  value: unknown,
  keepRaw: readonly string[],
  replacer: (key: string, v: unknown) => unknown,
): string {
  if (
    keepRaw.length === 0 ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as { toJSON?: unknown }).toJSON === "function"
  ) {
    return JSON.stringify(value, replacer);
  }
  // One field at a time, wrapped so toJSON(key), undefined-skipping and key
  // order match a single JSON.stringify of the whole object.
  const fields: string[] = [];
  for (const key of Object.keys(value)) {
    const one = JSON.stringify(
      { [key]: (value as Record<string, unknown>)[key] },
      keepRaw.includes(key) ? undefined : replacer,
    );
    if (one !== "{}") fields.push(one.slice(1, -1));
  }
  return `{${fields.join(",")}}`;
}

/**
 * Deep-redact a JSON-serializable value. Strings are pattern-replaced;
 * objects/arrays are walked. Returns a new value of the same shape.
 */
export function redactDeep(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v);
    }
    return out;
  }
  return value;
}

/**
 * A record env literal (`capabilities.mcp[].env[]` `{name, value}`) whose
 * UPPERCASED name contains any of these is refused outright (substring, no
 * tokenising: `PGPASSWORD`, `DBPASS`, `CLIENTSECRET`; audit WS3a R1 C2).
 * Over-refusal is the safe side: the entry moves to `{secret}`. Lives here
 * (its only import is the import-free shared list) so the record schema
 * (src/mcp/record-env.ts) and the project leaf walkers
 * (src/lib/secret-refs.ts) share it without an import cycle.
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
  // WS3b R1 W4 sweep: per-account X API bearer (`X_API_BEARER__<handle>`)
  "BEARER",
];

/** The first SECRET_NAME_FRAGMENTS entry the uppercased name contains, or undefined. */
export function secretNameFragment(name: string): string | undefined {
  const upper = name.toUpperCase();
  return SECRET_NAME_FRAGMENTS.find((f) => upper.includes(f));
}
