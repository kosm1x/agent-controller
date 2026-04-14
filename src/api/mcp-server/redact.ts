/**
 * Secret redaction for MCP tool output (v7.7.1 hardening).
 *
 * jarvis_task_detail and similar read-only tools return raw task rows
 * that can contain API keys, OAuth tokens, bearer credentials, and
 * passwords pasted into Jarvis by the user or pulled from tool output.
 * The read_only scope label is not a confidentiality guarantee — a
 * stolen bearer token should NOT hand back the full credential corpus.
 *
 * This module runs mechanical pattern substitution over JSON-serialized
 * task columns before they leave the MCP boundary. Patterns cover the
 * common secret shapes we've seen in events/tasks:
 *   - Authorization: Bearer <token>
 *   - API keys prefixed sk-, pk-, xoxb-, ghp_, gho_, glpat-, jrvs_
 *   - OAuth tokens (access_token, refresh_token, id_token JSON fields)
 *   - 32+ char hex blobs that look like SHA/HMAC material
 *   - password / passphrase / secret fields in JSON
 *
 * Not a substitute for per-field allow-listing, but closes the "dump
 * everything" blast radius.
 */

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Authorization headers (Bearer, Basic, Token)
  [
    /\b(Authorization)\s*:\s*(Bearer|Basic|Token)\s+[^\s"'\\]+/gi,
    "$1: $2 [REDACTED]",
  ],
  // API-key-shaped prefixes
  [
    /\b(sk-[A-Za-z0-9_-]{16,}|pk-[A-Za-z0-9_-]{16,}|xoxb-[A-Za-z0-9-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{16,}|jrvs_[A-Fa-f0-9]{32,})\b/g,
    "[REDACTED_KEY]",
  ],
  // JSON fields with obvious secret names
  [
    /"(password|passphrase|secret|api_?key|apikey|client_secret|access_token|refresh_token|id_token|bearer_token|private_key|token_hash)"\s*:\s*"[^"]+"/gi,
    '"$1":"[REDACTED]"',
  ],
  // Loose 32+ char hex blobs (SHA/HMAC/long random)
  [/\b[A-Fa-f0-9]{40,}\b/g, "[REDACTED_HEX]"],
];

/** Apply redaction patterns to a string. Returns a new string. */
export function redactSecrets(input: string | null | undefined): string {
  if (input == null) return "";
  let out = input;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
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
