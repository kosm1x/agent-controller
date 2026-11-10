/**
 * The ONE list of secret shapes removed from text before it is stored or
 * shown (operator ruling 14). Every redaction entry point delegates here —
 * `src/api/mcp-server/redact.ts` (MCP output, durable columns, shell
 * output), `src/memory/recall-utility.ts` (recall logging, JME, precedents)
 * and the Prometheus self-assessment argument quoting — so a shape added once
 * is removed on every path.
 *
 * Leaf module: no imports. `api/mcp-server/redact.ts` sits in an import cycle
 * the memory layer must not join, so both import this file instead of each
 * other.
 *
 * Every pattern is linear-time: no nested quantifiers over one class; a
 * shape of known length uses bounded repetition; an open-ended body is
 * either the end of the pattern (greedy, cannot fail after the scan) or, for
 * the multi-segment JWT, anchored with a look-behind that excludes the body
 * class, so one body run has at most one candidate start. These run on whole
 * tool outputs.
 *
 * A prefix-shaped token starts at a word boundary, or right after a
 * JSON-escaped control sequence (backslash + n/t/r) or a percent-encoded byte
 * (`%3D`), where text glued to the token is an encoding artefact, not a word.
 * A token glued to ordinary letters (`risk-…`, `task-scheduler-…`) is not a
 * token.
 *
 * Precision: the list holds credential shapes only, recognised by a known
 * prefix, a known structure (JWT, header, secret-named field) or a known
 * length. The one generic rule (40+ hex chars) is opt-in (`hexBlobs`),
 * because commit hashes and sha256 ids are ordinary content in memory text,
 * shell output and tool arguments.
 */

/** What a removed span was; the placeholder style decides how it renders. */
export type SecretKind =
  | "OPENAI-LIKE"
  | "PROVIDER-KEY"
  | "STRIPE-KEY"
  | "GITHUB-PAT"
  | "GITHUB-TOKEN"
  | "GITLAB-PAT"
  | "SLACK-TOKEN"
  | "AWS-AKID"
  | "GOOGLE-API"
  | "BOT-TOKEN"
  | "JARVIS-TOKEN"
  | "JWT"
  | "AUTH"
  | "SECRET"
  | "HEX";

/**
 * Placeholder style, kept per caller because stored data and tests depend on
 * it:
 * - `generic` — `[REDACTED_KEY]` for a token, `[REDACTED]` for the value
 *   after a secret name or header scheme, `[REDACTED_HEX]` for a hex blob
 *   (MCP output, durable columns, shell output, self-assessment args).
 * - `kind` — `[REDACTED-<KIND>]` (memory text: recall rows, JME, precedents).
 */
export type PlaceholderStyle = "generic" | "kind";

export interface RedactOptions {
  style: PlaceholderStyle;
  /** Also remove 40+ char hex blobs (SHA/HMAC-shaped). Off unless asked. */
  hexBlobs?: boolean;
  /**
   * How the name-led rules (secret-named NAME=value, JSON secret field,
   * `Authorization:` header) decide. Token-shape rules are not affected.
   * - `any` (default): the name alone decides; NAME=value runs to the next
   *   whitespace. Over-redaction is the safe side for logs, MCP output and
   *   the "is this a secret" verdicts.
   * - `secret-like` (memory text, where silently losing an ordinary fact is
   *   the costly side): the NAME must end in a secret keyword as a whole
   *   `_`-separated (or camelCase) token, optionally with a digit suffix, and
   *   the VALUE must look like a secret (see looksLikeSecretValue). NAME=value
   *   ends at whitespace or `& , ; ) " '`, so the rest of a query string or
   *   list survives.
   */
  namedValues?: "any" | "secret-like";
}

/**
 * Matches every placeholder `redactSecretText` can emit, in either style
 * (`[REDACTED]`, `[REDACTED_KEY]`, `[REDACTED_HEX]`, `[REDACTED-<KIND>]`).
 * Source only, so a caller composes it into its own regex.
 */
export const REDACTION_PLACEHOLDER_SOURCE = String.raw`\[REDACTED(?:_[A-Z]+|-[A-Z]+(?:-[A-Z]+)*)?\]`;

/** Kinds whose span is the token itself (the rest replace a value only). */
const TOKEN_KINDS: ReadonlySet<SecretKind> = new Set<SecretKind>([
  "OPENAI-LIKE",
  "PROVIDER-KEY",
  "STRIPE-KEY",
  "GITHUB-PAT",
  "GITHUB-TOKEN",
  "GITLAB-PAT",
  "SLACK-TOKEN",
  "AWS-AKID",
  "GOOGLE-API",
  "BOT-TOKEN",
  "JARVIS-TOKEN",
  "JWT",
]);

function placeholder(kind: SecretKind, style: PlaceholderStyle): string {
  if (style === "kind") return `[REDACTED-${kind}]`;
  if (kind === "HEX") return "[REDACTED_HEX]";
  return TOKEN_KINDS.has(kind) ? "[REDACTED_KEY]" : "[REDACTED]";
}

/**
 * A rule: a regex whose whole match is a token (`token`), a regex whose
 * `pre` group is kept and the rest replaced (`value`), or a function for a
 * rule one replace() cannot express.
 */
export type SecretRule =
  | { kind: SecretKind; re: RegExp; keep?: "pre" }
  | { kind: SecretKind; fn: (s: string, ph: string, secretLike: boolean) => string };

/**
 * A NAME is secret-shaped when it ends in (or is) a secret keyword, the
 * keyword optionally followed by `_`/digits (X_AUTH_TOKEN__acct,
 * DB_PASSWORD_2). A letter after it (AUTHOR, KEYBOARD) is not a secret name.
 */
const SECRET_NAME_RE =
  /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|JWT|AUTH|BEARER)(?:[_\d]|$)/i;

/**
 * `secret-like` names: the LAST `_`-separated token is a secret keyword (a
 * digit suffix allowed). Bare KEY / AUTH and a keyword in the middle
 * (TOKEN_LIMIT, KEY_ID, password_min_length) do not count. Tested on the
 * upper-cased name with camelCase humps split by `_` (apiKey → API_KEY).
 */
const STRICT_SECRET_NAME_RE =
  /(?:^|_)(?:(?:API|ACCESS|PRIVATE|SECRET)_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?|JWT)_?\d*$/;

function isStrictSecretName(name: string): boolean {
  return STRICT_SECRET_NAME_RE.test(name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase());
}

/** Values that are settings, not secrets, whatever name they sit under. */
const NOT_SECRET_VALUES: ReadonlySet<string> = new Set([
  "none",
  "null",
  "true",
  "false",
  "enabled",
  "disabled",
  "required",
  "optional",
]);

/**
 * Values that name or stand in for a secret instead of holding one.
 */
const REFERENCE_OR_PLACEHOLDER: readonly RegExp[] = [
  // Variable reference: $NAME, ${NAME}, ${NAME:-default} and the other
  // default/assign/error/alternate forms.
  /^\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*(?::?[-=?+][^{}]*)?\})$/,
  // Dotted identifier path (process.env.TOKEN, config.apiKey). Each segment
  // is letters then optional digits, so a dotted value whose segments mix
  // letters and digits (token-shaped) is not one.
  /^[A-Za-z_$][A-Za-z_$]*\d*(?:\.[A-Za-z_$][A-Za-z_$]*\d*)+$/,
  // Upper-case placeholder word: YOUR_API_KEY_HERE.
  /^[A-Z]+(?:_[A-Z]+)+$/,
  // Mask: ******** or xxxxxxxx.
  /^(?:\*+|[xX]+)$/,
  // Angle-bracket placeholder: <tu-contraseña>.
  /^<[^<>]+>$/,
];

function isReferenceOrPlaceholder(v: string): boolean {
  return REFERENCE_OR_PLACEHOLDER.some((re) => re.test(v));
}

/**
 * A value looks like a secret: at least 8 characters, no whitespace, not
 * purely digits (limits, ids, counts), not a settings word, and not a
 * reference or a placeholder.
 */
function looksLikeSecretValue(v: string): boolean {
  return (
    v.length >= 8 &&
    !/\s/.test(v) &&
    !/^\d+$/.test(v) &&
    !NOT_SECRET_VALUES.has(v.toLowerCase()) &&
    !isReferenceOrPlaceholder(v)
  );
}

/**
 * Redact the value of every NAME=value whose NAME is secret-shaped. Names are
 * scanned WITHOUT consuming values, so a secret inside a non-secret value is
 * still found (`?a=1&access_token=…`, `PATH=/bin:GITHUB_TOKEN=…`). Default:
 * the value runs to the next whitespace. `secretLike`: the strict name test,
 * an opening quote is kept, the value ends at whitespace or `& , ; ) " '`
 * and must look like a secret. Linear: one forward scan; a pattern with the
 * keyword in the middle would backtrack quadratically on long snake_case runs.
 */
function redactSecretAssignments(s: string, ph: string, secretLike: boolean): string {
  const name = /\b([A-Za-z_]\w*)=(?=\S)/g;
  const value = secretLike ? /(["']?)([^\s&,;)"']*)/y : /()(\S*)/y;
  let out = "";
  let last = 0;
  for (let m = name.exec(s); m; m = name.exec(s)) {
    const secretName = secretLike ? isStrictSecretName(m[1]!) : SECRET_NAME_RE.test(m[1]!);
    if (!secretName) continue;
    const start = m.index + m[0].length;
    value.lastIndex = start;
    const v = value.exec(s)!;
    if (secretLike && !looksLikeSecretValue(v[2]!)) continue;
    out += `${s.slice(last, start + v[1]!.length)}${ph}`;
    last = value.lastIndex;
    name.lastIndex = last;
  }
  return out + s.slice(last);
}

/** What may precede a prefix-shaped token (see the module comment): start of
 * text, a non-word character (a word boundary, since every prefix starts with
 * a word character), an escaped control sequence or a percent-encoded byte. */
const LEAD = String.raw`(?:^|[^\w]|\\[nrt]|%[0-9A-Fa-f]{2})`;

/**
 * `prefix` then `body`, anchored by LEAD. The literal prefix comes FIRST and
 * the anchor is checked by a look-behind that re-reads it, so the engine can
 * scan for the literal instead of testing the anchor at every position.
 */
function tokenRe(prefix: string, body: string, lead: string = LEAD): RegExp {
  return new RegExp(`${prefix}(?<=${lead}${prefix})${body}`, "g");
}

/**
 * The shared list, applied in order. Order matters only where shapes nest:
 * the header rule runs first so `Authorization: Bearer <token>` keeps its
 * scheme; token rules run before the NAME=value rule so a token under a
 * secret name ends as one value placeholder.
 */
export const SECRET_RULES: readonly SecretRule[] = [
  // Authorization header values (Bearer, Basic, Token, Bot): scheme kept.
  {
    kind: "AUTH",
    re: /(?<pre>\bAuthorization\s*:\s*(?:Bearer|Basic|Token|Bot)\s+)[^\s"'\\]+/gi,
    keep: "pre",
  },
  // Three-segment JWT (base64url header that starts `eyJ`). The look-behind
  // excludes `-` too (the body class), so one body run has one start.
  {
    kind: "JWT",
    re: tokenRe(
      "eyJ",
      String.raw`[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}`,
      String.raw`(?:^|[^\w-]|\\[nrt]|%[0-9A-Fa-f]{2})`,
    ),
  },
  // OpenAI / Anthropic style `sk-…` (body may contain `_` and `-`:
  // sk-proj-…, sk-ant-api03-…).
  { kind: "OPENAI-LIKE", re: tokenRe("sk-", String.raw`[\w-]{16,}`) },
  // Other provider keys with a `pk-` prefix.
  { kind: "PROVIDER-KEY", re: tokenRe("pk-", String.raw`[\w-]{16,}`) },
  // Stripe-style secret and restricted live/test keys. Publishable `pk_` keys
  // are public by design (they ship in web pages), so they are not removed.
  // The body is alphanumeric, so a trailing `_suffix` stays.
  { kind: "STRIPE-KEY", re: tokenRe("[sr]k_(?:live|test)_", "[A-Za-z0-9]{16,}") },
  // GitHub fine-grained PAT: github_pat_<22>_<59> (lengths allowed some slack).
  {
    kind: "GITHUB-PAT",
    re: tokenRe("github_pat_", "[A-Za-z0-9]{20,30}_[A-Za-z0-9]{50,70}(?![A-Za-z0-9])"),
  },
  // GitHub classic PAT.
  { kind: "GITHUB-PAT", re: tokenRe("ghp_", "[A-Za-z0-9]{20,}") },
  // GitHub OAuth / user-to-server / server-to-server / refresh tokens.
  { kind: "GITHUB-TOKEN", re: tokenRe("gh[ousr]_", "[A-Za-z0-9]{20,}") },
  // GitLab personal access token.
  { kind: "GITLAB-PAT", re: tokenRe("glpat-", String.raw`[\w-]{16,}`) },
  // Slack bot / app / user / refresh / session tokens.
  { kind: "SLACK-TOKEN", re: tokenRe("xox[baprs]-", "[A-Za-z0-9-]{10,}") },
  // AWS access key id (long-term AKIA, temporary ASIA): exactly 20 chars, the
  // body in AWS's base32 alphabet [A-Z2-7], so an ordinary upper-case code
  // with 0/1/8/9 is not one. Not glued to a word character on either side.
  { kind: "AWS-AKID", re: tokenRe("(?:AKIA|ASIA)", String.raw`[A-Z2-7]{16}\b`) },
  // Google / Gemini API key: AIza + 35, whatever follows.
  { kind: "GOOGLE-API", re: tokenRe("AIza", String.raw`[\w-]{35}`) },
  // Telegram bot token <id>:<35>, also inside a Bot API URL (`/bot<id>:…`,
  // where `\b` cannot fire between "bot" and the id) and when the secret ends
  // in `-`.
  {
    kind: "BOT-TOKEN",
    re: new RegExp(
      String.raw`(?:(?<=bot)|\b|(?<=\\[nrt])|(?<=%[0-9A-Fa-f]{2}))\d{6,10}:[\w-]{35}(?![\w-])`,
      "g",
    ),
  },
  // Jarvis MCP bearer tokens.
  { kind: "JARVIS-TOKEN", re: tokenRe("jrvs_", "[A-Fa-f0-9]{32,}(?![A-Za-z0-9_])") },
  // Secret-named NAME=value assignments (export GEMINI_API_KEY=…,
  // X_AUTH_TOKEN__acct=…, ?access_token=…): name kept, value replaced. Runs
  // on logs and stored text, never on executed commands, so over-redaction
  // is the safe side. Encoded values (base64 of an env dump) are out of
  // reach of any name rule.
  { kind: "SECRET", fn: redactSecretAssignments },
  // JSON fields with secret names: name kept, value replaced.
  {
    kind: "SECRET",
    re: /(?<pre>"(?:password|passphrase|secret|api_?key|apikey|client_secret|access_token|refresh_token|id_token|bearer_token|private_key|token_hash|authorization)"\s*:\s*")[^"]+(?=")/gi,
    keep: "pre",
  },
];

/** The opt-in generic rule: 40+ hex chars (SHA/HMAC/long random). */
export const HEX_BLOB_RULE: SecretRule = {
  kind: "HEX",
  re: /\b[A-Fa-f0-9]{40,}\b/g,
};

function applyRule(s: string, rule: SecretRule, opts: RedactOptions): string {
  const ph = placeholder(rule.kind, opts.style);
  const secretLike = opts.namedValues === "secret-like";
  if ("fn" in rule) return rule.fn(s, ph, secretLike);
  if (rule.keep === "pre") {
    // Name-led rule: `pre` (name or header scheme) kept, the value replaced.
    return s.replace(rule.re, (match: string, ...args: unknown[]) => {
      const groups = args[args.length - 1] as { pre: string };
      if (secretLike && !looksLikeSecretValue(match.slice(groups.pre.length))) return match;
      return `${groups.pre}${ph}`;
    });
  }
  return s.replace(rule.re, ph);
}

/**
 * Remove every secret shape in SECRET_RULES (plus 40+ hex blobs when
 * `hexBlobs`) from `input`, rendering each placeholder in `style`; the
 * name-led rules follow `namedValues`.
 */
export function redactSecretText(input: string, opts: RedactOptions): string {
  let out = input;
  for (const rule of SECRET_RULES) out = applyRule(out, rule, opts);
  if (opts.hexBlobs) out = applyRule(out, HEX_BLOB_RULE, opts);
  return out;
}
