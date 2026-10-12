/**
 * S6 WS3 (audit R1 W3, R2 W2): env names a RECORD-declared MCP server may
 * never declare. This is defence in depth against names that change how the
 * child (or its loader/interpreter) behaves — PATH, NODE_OPTIONS, LD_PRELOAD,
 * … — plus the obvious service-secret families. It is NOT the secret
 * boundary: a deny-list cannot enumerate a moving set of secret names. The
 * boundary is `buildSpawnEnv`: a record child gets only the SDK default env
 * plus names resolved from its own project's `secrets`; the service env never
 * reaches it. One list, used by the record schema, the loader and
 * `buildSpawnEnv`.
 */

/** A declarable env name: uppercase letters, digits, `_`; starts with a letter. */
export const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

export const DENIED_ENV_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "TERM",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONHOME",
  "BASH_ENV",
  "ENV",
  "PERL5OPT",
  "PERL5LIB",
  "RUBYOPT",
  "GIT_EXEC_PATH",
  "TMPDIR",
  "IFS",
]);

export const DENIED_ENV_PREFIXES: readonly string[] = [
  "LD_",
  "DYLD_",
  "NODE_",
  "PYTHON",
  "MC_",
  "JARVIS_",
  "DATABASE",
  "TELEGRAM_",
  "ANTHROPIC_",
  "OPENAI_",
  "FIREWORKS_",
  "GEMINI_",
  "GOOGLE_",
  "SMTP_",
  "IMAP_",
];

/** True when a record-declared server must not get env `name`. */
export function isDeniedEnvName(name: string): boolean {
  return DENIED_ENV_NAMES.has(name) || DENIED_ENV_PREFIXES.some((p) => name.startsWith(p));
}
