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

// Loose 32+ char hex blobs (SHA/HMAC/long random). Named so
// redactCredentials can skip it by identity, not by array position.
const HEX_BLOB_RULE: [RegExp, string] = [
  /\b[A-Fa-f0-9]{40,}\b/g,
  "[REDACTED_HEX]",
];

const SECRET_NAME_RE =
  /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|JWT|AUTH)(?:[_\d]|$)/i;

/** A regex rule, or a function for a rule one replace() cannot express. */
type Rule = [RegExp, string] | ((s: string) => string);

function applyRule(s: string, rule: Rule): string {
  return typeof rule === "function" ? rule(s) : s.replace(rule[0], rule[1]);
}

/**
 * Redact the value of every NAME=value whose NAME is secret-shaped. Names are
 * scanned WITHOUT consuming values, so a secret inside a non-secret value is
 * still found (`?a=1&access_token=…`, `PATH=/bin:GITHUB_TOKEN=…` — audit
 * 2026-09-22 R2 C1). The value runs to the next whitespace. Linear: a
 * pattern with the keyword in the middle backtracked quadratically on long
 * snake_case runs (R1 W3).
 */
function redactSecretAssignments(s: string): string {
  const name = /\b([A-Za-z_]\w*)=(?=\S)/g;
  const value = /\S*/y;
  let out = "";
  let last = 0;
  for (let m = name.exec(s); m; m = name.exec(s)) {
    if (!SECRET_NAME_RE.test(m[1]!)) continue;
    const start = m.index + m[0].length;
    value.lastIndex = start;
    value.exec(s);
    out += `${s.slice(last, start)}[REDACTED]`;
    last = value.lastIndex;
    name.lastIndex = last;
  }
  return out + s.slice(last);
}

const SECRET_PATTERNS: Rule[] = [
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
  // Google / Gemini API keys (AIza + 35 chars). Added 2026-07-05 hardening
  // sweep — the shell-guard journal-leak (H6) was exactly this shape, and the
  // prefix set above did NOT cover it.
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED_KEY]"],
  // Telegram bot tokens (<bot_id digits>:<35-char secret>). Same sweep.
  [/\b\d{6,10}:[A-Za-z0-9_-]{35}\b/g, "[REDACTED_KEY]"],
  // Secret-named shell/env assignments: NAME=value where NAME ends in a secret
  // keyword (GEMINI_API_KEY="AIza…", BRAVE_API_KEY=…, X_AUTH_TOKEN__acct=…).
  // Catches keys with no recognizable value prefix — the common `export KEY=val`
  // shape in shell_exec logs. Value redacted, name kept. Over-redaction here is
  // safe (this runs on logs + MCP output, never on executed commands).
  // The keyword may carry an `_`/digit suffix (X_AUTH_TOKEN__acct,
  // DB_PASSWORD_2) or be the whole name (PASSWORD=); a letter after it
  // (AUTHOR=, KEYBOARD=) is not a secret name (audit 2026-09-22 residual).
  // Encoded values (base64 of an env dump) are out of reach of any name rule.
  redactSecretAssignments,
  // JSON fields with obvious secret names
  [
    /"(password|passphrase|secret|api_?key|apikey|client_secret|access_token|refresh_token|id_token|bearer_token|private_key|token_hash)"\s*:\s*"[^"]+"/gi,
    '"$1":"[REDACTED]"',
  ],
  HEX_BLOB_RULE,
];

/** Apply redaction patterns to a string. Returns a new string. */
export function redactSecrets(input: string | null | undefined): string {
  if (input == null) return "";
  let out = input;
  for (const rule of SECRET_PATTERNS) out = applyRule(out, rule);
  return out;
}

/**
 * Credential shapes only — every pattern above except the loose hex-blob rule.
 * For output the agent must keep working with (shell stdout, where 40-char git
 * SHAs are ordinary data), so the hex rule would break it.
 */
export function redactCredentials(input: string | null | undefined): string {
  if (input == null) return "";
  let out = input;
  for (const rule of SECRET_PATTERNS) {
    if (rule !== HEX_BLOB_RULE) out = applyRule(out, rule);
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
