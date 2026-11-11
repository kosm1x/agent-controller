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

import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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
  // Where gh and git find their config, and so a stored login.
  "XDG_CONFIG_HOME",
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
  // gh's settings (GH_TOKEN, GH_CONFIG_DIR, GH_HOST, ...) and git's env config:
  // the no-stored-login settings a child gets are not declarable.
  "GH_",
  "GIT_CONFIG",
];

/** True when a record-declared server must not get env `name`. */
export function isDeniedEnvName(name: string): boolean {
  return DENIED_ENV_NAMES.has(name) || DENIED_ENV_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Queue 3h: the env a builtin tool's child process may inherit — the MCP SDK's
 * default set (HOME LOGNAME PATH SHELL TERM USER) plus locale/time/temp/node
 * knobs. Same WS3 rule as `buildSpawnEnv`: an allow-list, never the service
 * env (which carries every key the service loads from `.env`).
 */
export const CHILD_ENV_BASE: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  "NODE_ENV",
  "NODE_OPTIONS",
  "CI",
];

/**
 * git config for a child env (`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` /
 * `GIT_CONFIG_VALUE_n`, git ≥ 2.31): command scope, read after every config
 * file, so an entry here wins over the host user's global config.
 */
export function gitConfigEnv(
  entries: readonly (readonly [string, string])[],
): Record<string, string> {
  const env: Record<string, string> = {
    GIT_CONFIG_COUNT: String(entries.length),
  };
  entries.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/** An empty `credential.helper` clears every helper configured before it. */
export const CREDENTIAL_HELPER_RESET = ["credential.helper", ""] as const;

let ghConfigDir: string | undefined;

/**
 * An empty directory this process created (mode 0700, unpredictable name) for
 * `GH_CONFIG_DIR`: the `gh` program reads its stored login from there, so it
 * finds none. Created once, on first use.
 */
export function emptyGhConfigDir(): string {
  ghConfigDir ??= mkdtempSync(join(tmpdir(), "mc-gh-config-"));
  return ghConfigDir;
}

/**
 * GitHub children run under the agent's own account: children get no stored
 * login by default. Every child env built here carries `GH_CONFIG_DIR` (an
 * empty directory) for `gh` and a reset of `credential.helper` for `git`. A
 * child that talks to GitHub adds the agent's token on top
 * (src/lib/github-authority.ts). This env layer is one layer; a host setting
 * the operator applies to the service completes it.
 */
export function noStoredLoginEnv(): Record<string, string> {
  return {
    GH_CONFIG_DIR: emptyGhConfigDir(),
    ...gitConfigEnv([CREDENTIAL_HELPER_RESET]),
  };
}

/** Names noStoredLoginEnv sets on every child env. */
export const NO_STORED_LOGIN_NAMES: readonly string[] = [
  "GH_CONFIG_DIR",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
];

/**
 * The base names read from the service env, the no-stored-login settings
 * (noStoredLoginEnv), plus `extra` set explicitly by the caller. `extra` may
 * not carry a `GIT_CONFIG_*` name: it would replace the credential-helper
 * reset, so such a call throws. The agent's GitHub env, whose git config
 * starts with that reset, is added on top by githubAuthority().
 */
export function buildChildEnv(
  extra: Record<string, string> = {},
): Record<string, string> {
  const gitConfig = Object.keys(extra).filter((k) => k.startsWith("GIT_CONFIG"));
  if (gitConfig.length > 0) {
    throw new Error(
      `buildChildEnv: extra may not set ${gitConfig.join(", ")} — it would replace the credential-helper reset every child carries.`,
    );
  }
  const env: Record<string, string> = {};
  for (const name of CHILD_ENV_BASE) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...noStoredLoginEnv(), ...extra };
}
