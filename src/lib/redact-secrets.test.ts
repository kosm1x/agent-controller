/**
 * One secret-shape table run through every redaction entry point (operator
 * ruling 14): a shape the shared list recognises is removed by each of them,
 * and ordinary content is left byte-identical by each of them.
 *
 * Every key-shaped fixture is assembled at runtime from fragments, so no file
 * in the repo holds a key-shaped literal (the commit guard refuses one).
 */

import { describe, expect, it, vi } from "vitest";

// The executor module pulls in the inference stack and the tool registry;
// only its argument redaction is under test here.
vi.mock("../inference/adapter.js", () => ({ infer: vi.fn(), inferWithTools: vi.fn() }));
vi.mock("../tools/registry.js", () => ({ toolRegistry: { get: vi.fn(), getDefinitions: vi.fn(() => []) } }));

import {
  redactCredentials,
  redactSecrets as redactMcp,
} from "../api/mcp-server/redact.js";
import { redactSecrets as redactMemory } from "../memory/recall-utility.js";
import { redactSecretsInArgs } from "../prometheus/executor.js";
import { redactSecretText } from "./redact-secrets.js";
import { literalEnvValueError } from "../mcp/record-env.js";
import { isCredentialFact } from "../db/user-facts.js";

/** Entry points. Each takes plain text and returns what it would store/show. */
const ENTRY_POINTS: Array<[string, (text: string) => string]> = [
  ["mcp redactSecrets", (t) => redactMcp(t)],
  ["mcp redactCredentials", (t) => redactCredentials(t)],
  ["memory redactSecrets", (t) => redactMemory(t)],
  // Self-assessment quotes tool args as JSON text; the text sits under an
  // ordinary key, so only the value rules can remove it.
  ["executor redactSecretsInArgs", (t) => redactSecretsInArgs(JSON.stringify({ note: t }))],
];

const A = (n: number) => "Ab3".repeat(Math.ceil(n / 3)).slice(0, n);
const telegram = "123456789" + ":" + "AAH" + "x".repeat(31) + "-";
const opaque = "opaque" + "Tok3n".repeat(4);
const plainValue = "zq" + "8Lm2Rt5Wx9Kp3Vn7";

/** [shape, text containing it, the secret part that must not survive]. */
const SHAPES: Array<[string, string, string]> = [
  ["openai key whose body has _ and -", "", "s" + "k-proj-" + "aB3dE_fG7hI-" + "J".repeat(24)],
  ["anthropic key", "", "s" + "k-ant-api03-" + "Zx9_" + "Q".repeat(40) + "-AA"],
  ["pk- provider key", "", "p" + "k-live-" + A(20)],
  ["stripe secret key", "", "s" + "k_live_" + A(24)],
  ["stripe restricted key", "", "r" + "k_test_" + A(24)],
  ["github classic PAT", "", "gh" + "p_" + A(36)],
  ["github oauth token", "", "gh" + "o_" + A(36)],
  ["github user-to-server token", "", "gh" + "u_" + A(36)],
  ["github server-to-server token", "", "gh" + "s_" + A(36)],
  ["github refresh token", "", "gh" + "r_" + A(36)],
  ["github fine-grained PAT", "", "github" + "_pat_" + A(22) + "_" + A(59)],
  ["gitlab PAT", "", "gl" + "pat-" + "Ab_c-".repeat(4)],
  ["slack bot token", "", "xo" + "xb-" + "1234567890-" + "abcDEF123"],
  ["slack user token", "", "xo" + "xp-" + "1234567890-" + "abcDEF123"],
  ["slack app token", "", "xo" + "xa-" + "2-A1B2C3-" + "abcDEF123"],
  ["slack refresh token", "", "xo" + "xr-" + "1234567890-" + "abcDEF123"],
  ["slack session token", "", "xo" + "xs-" + "1234567890-" + "abcDEF123"],
  ["aws long-term access key id", "", "AK" + "IA" + "Z".repeat(10) + "234567"],
  ["aws temporary access key id", "", "AS" + "IA" + "Q".repeat(10) + "765432"],
  ["three-segment JWT", "", "ey" + "J" + "hbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiIxMjM0In0" + "." + "abc_DEF-ghi123XYZ"],
  ["google api key", "", "AI" + "za" + "Sy" + "A-b_".repeat(8) + "x"],
  ["telegram bot token", "", telegram],
  ["telegram bot token inside a Bot API URL", `GET https://api.telegram.org/bot${telegram}/getMe`, telegram],
  ["jarvis bearer token", "", "jr" + "vs_" + "a1".repeat(16)],
  ["Authorization: Bearer value", `curl -H "Authorization: Bearer ${opaque}" x`, opaque],
  ["Authorization: Basic value", `Authorization: Basic ${opaque}`, opaque],
  ["Authorization: Token value", `authorization: token ${opaque}`, opaque],
  ["secret-named assignment", `export MY_SERVICE_API_KEY=${plainValue}`, plainValue],
  ["secret-named assignment in a query string", `https://x.io/cb?a=1&access_token=${plainValue}`, plainValue],
  ["password assignment", `DB_PASSWORD=${plainValue} next`, plainValue],
  ["JSON client_secret field", JSON.stringify({ client_secret: plainValue }), plainValue],
  ["JSON password field with spacing", `{"password": "${plainValue}"}`, plainValue],
  ["JSON authorization field", JSON.stringify({ authorization: opaque }), opaque],
];

for (const row of SHAPES) if (row[1] === "") row[1] = `the value ${row[2]} was pasted`;

/** [what, text]: ordinary content no entry point may change. */
const ORDINARY: Array<[string, string]> = [
  ["short commit hash", "fixed in abc1234 yesterday"],
  ["uuid", "task 0d5e9a4c-1b2c-4d3e-8f9a-0b1c2d3e4f5a done"],
  ["base64 image", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="],
  ["unix path", "/root/claude/mission-control/src/lib/redact-secrets.ts"],
  ["windows path", "C:\\Users\\ops\\Documents\\report-final-v2.txt"],
  ["url without credentials", "https://example.com/path/to/page?page=2&sort=asc#frag"],
  ["kebab slug starting like a prefix", "see risk-assessment-for-deploy-pipeline and task-management-overview-document"],
  ["prose naming a header", "the Authorization header must be set on every call"],
  ["names that end in a letter after a keyword", "AUTHOR=jane KEYBOARD=us MAX_TOKENS=4096"],
  ["bare prefixes", "sk- ghp_ github_pat_ glpat- xoxb- AKIA eyJ jrvs_"],
  ["short prefixed words", "sk-learn ghp_short AKIAXYZ"],
  ["timestamps and ratios", "2026-11-10T12:34:56Z at 12:34:56, ratio 123456:789"],
  ["version strings", "node v22.11.0 and pkg 1.2.3-beta.4"],
  ["stripe publishable key (public by design)", "publishable " + "pk" + "_live_" + A(24)],
  ["spanish prose", "Mañana revisamos la clave del proyecto con el equipo"],
  ["json without secret fields", JSON.stringify({ name: "deploy", count: 3, tags: ["a", "b"] })],
];

/** Hex rows: ordinary for every entry point except the MCP full variant. */
const HEX_ROWS: Array<[string, string]> = [
  ["full commit hash", "commit " + "3f2a9c1d".repeat(5) + " merged"],
  ["sha256 id", "sha256 " + "0123456789abcdef".repeat(4)],
];

describe("shared secret list — every entry point removes every shape", () => {
  for (const [entry, fn] of ENTRY_POINTS) {
    it.each(SHAPES)(`${entry}: %s`, (_shape, text, secret) => {
      expect(fn(text)).not.toContain(secret);
    });
  }
});

describe("shared secret list — ordinary content stays byte-identical", () => {
  for (const [entry, fn] of ENTRY_POINTS) {
    it.each(ORDINARY)(`${entry}: %s`, (_what, text) => {
      const expected = entry.startsWith("executor") ? JSON.stringify({ note: text }) : text;
      expect(fn(text)).toBe(expected);
    });
  }

  // The generic 40+ hex rule is opt-in: only the MCP full variant applies it.
  // Memory text, shell output and tool args keep commit hashes and ids.
  for (const [entry, fn] of ENTRY_POINTS) {
    it.each(HEX_ROWS)(`${entry}: %s`, (_what, text) => {
      if (entry === "mcp redactSecrets") {
        expect(fn(text)).toContain("[REDACTED_HEX]");
      } else {
        const expected = entry.startsWith("executor") ? JSON.stringify({ note: text }) : text;
        expect(fn(text)).toBe(expected);
      }
    });
  }
});

describe("placeholders keep each caller's style", () => {
  const key = "gh" + "p_" + A(36);
  it("mcp: [REDACTED_KEY] for a token, [REDACTED] for a value", () => {
    expect(redactMcp(`k ${key}`)).toBe("k [REDACTED_KEY]");
    expect(redactMcp(`Authorization: Bearer ${opaque}`)).toBe("Authorization: Bearer [REDACTED]");
  });
  it("memory: [REDACTED-<KIND>]", () => {
    expect(redactMemory(`k ${key}`)).toBe("k [REDACTED-GITHUB-PAT]");
    expect(redactMemory(`Authorization: Bearer ${opaque}`)).toBe("Authorization: Bearer [REDACTED-AUTH]");
  });
  it("executor: the key-name rule still writes <redacted>; values get the generic style", () => {
    expect(redactSecretsInArgs(JSON.stringify({ api_key: "x" }))).toBe('{"api_key":"<redacted>"}');
    expect(redactSecretsInArgs(JSON.stringify({ note: `k ${key}` }))).toBe('{"note":"k [REDACTED_KEY]"}');
  });
});

// CPU-time measurement. Process CPU time, not elapsed time: a fixed bound on elapsed time fails
// on a busy machine although nothing is wrong, while CPU time leaves out the time spent waiting
// for a processor.

/** CPU ms per call of `fn`: one warm-up call, then the minimum of 3 runs of `reps` calls each. */
function cpuMsPerCall(fn: () => unknown, reps = 1): number {
  fn();
  let best = Infinity;
  for (let r = 0; r < 3; r++) {
    const c0 = process.cpuUsage();
    for (let i = 0; i < reps; i++) fn();
    const d = process.cpuUsage(c0);
    best = Math.min(best, (d.user + d.system) / 1000);
  }
  return best / reps;
}

/** Bound on `growth4x().ratio`: linear work measures about 4, quadratic work about 16. */
const GROWTH_BOUND = 8;

/**
 * How the CPU time of `fn` grows from input `make(n)` to input `make(4 * n)`. Both sizes repeat
 * the call the same number of times, doubled until one run of the smaller size takes 40 ms, so
 * the figure is not lost in timer noise. Linear work grows about 4x and quadratic work about 16x,
 * whatever the machine's speed or load. The ratio is measured up to three times and the smallest
 * is kept, stopping at the first one under GROWTH_BOUND: on a busy machine one noisy measurement
 * can push a single ratio over the bound, but the noise does not repeat three times, while a real
 * super-linear change measures about 16x on every attempt and still fails. `largeMs` is the larger
 * size's CPU ms per call from the first attempt.
 */
function growth4x<T>(
  make: (size: number) => T,
  n: number,
  fn: (input: T) => unknown,
): { ratio: number; largeMs: number; label: string } {
  const small = make(n);
  const large = make(4 * n);
  let reps = 1;
  fn(small);
  for (;;) {
    const c0 = process.cpuUsage();
    for (let i = 0; i < reps; i++) fn(small);
    const d = process.cpuUsage(c0);
    if ((d.user + d.system) / 1000 >= 40 || reps >= 1_000_000) break;
    reps *= 2;
  }
  let ratio = Infinity;
  let largeMs = NaN;
  let label = "";
  for (let attempt = 1; attempt <= 3 && ratio >= GROWTH_BOUND; attempt++) {
    const a = cpuMsPerCall(() => fn(small), reps);
    const b = cpuMsPerCall(() => fn(large), reps);
    if (attempt === 1) largeMs = b;
    if (b / a < ratio) {
      ratio = b / a;
      label = `${b.toFixed(3)} ms / ${a.toFixed(3)} ms per call, ${reps} calls per run, attempt ${attempt}`;
    }
  }
  return { ratio, largeMs, label };
}

/** The first `len` characters of `unit` repeated. */
const repeatTo = (unit: string, len: number) => unit.repeat(Math.ceil(len / unit.length)).slice(0, len);

describe("linear time on large input", () => {
  it("each entry point stays linear, and under 1 s on 1 MB of mixed text", () => {
    const unit = `line ${"gh" + "p_" + A(36)} and ${"-eyJ" + A(20)} sk-sk-sk- KEY_KEY_KEY ${"a=".repeat(8)} `;
    for (const [entry, fn] of ENTRY_POINTS) {
      // 25 KB to 100 KB: about 4x for linear work, about 16x for quadratic (both sizes under
      // 128 KB, where the growth measures closer to linear); the original 1 s ceiling at 1 MB.
      const g = growth4x((len) => repeatTo(unit, len), 25_000, fn);
      expect(g.ratio, `${entry}: ${g.label}`).toBeLessThan(GROWTH_BOUND);
      const big = repeatTo(unit, 1_000_000);
      expect(cpuMsPerCall(() => fn(big)), entry).toBeLessThan(1000);
    }
  });

  const hostile = [
    "-eyJ" + "a".repeat(30), // JWT start with no dots
    "sk-".repeat(5),
    "KEY_".repeat(5),
    "a=".repeat(5),
    '"password":"' + "x".repeat(30), // unterminated JSON field
    "f".repeat(60) + "g", // hex run ending in a word char
    "jrvs_" + "a".repeat(40) + "z",
    "Authorization" + " ".repeat(30),
    "a_token=" + "1".repeat(40) + " ", // secret-like: digits-only value skipped
    "x_TOKEN_2=" + "disabled&", // secret-like: settings word skipped
    "\\n" + "%3D", // leading-anchor alternatives back to back
  ];
  // One case per input and mode, so each stays well inside the runner's test timeout. Both modes
  // run the same patterns, and `secret-like` only adds a check on each match, so the growth is
  // measured in that mode; both modes keep the 1 s ceiling at 1 MB.
  it.each(
    (["any", "secret-like"] as const).flatMap((namedValues) => hostile.map((unit) => [namedValues, unit] as const)),
  )("the shared function stays linear on inputs built to make a pattern backtrack (%s: %j)", (namedValues, unit) => {
    const redact = (text: string) => redactSecretText(text, { style: "generic", hexBlobs: true, namedValues });
    if (namedValues === "secret-like") {
      const g = growth4x((len) => repeatTo(unit, len), 25_000, redact);
      expect(g.ratio, g.label).toBeLessThan(GROWTH_BOUND);
    }
    const big = repeatTo(unit, 1_000_000);
    expect(cpuMsPerCall(() => redact(big))).toBeLessThan(1000);
  });
});

/** One sample per prefix family, for the leading-anchor rows. */
const FAMILIES: Array<[string, string]> = [
  ["sk- provider key", "s" + "k-proj-" + A(24)],
  ["pk- provider key", "p" + "k-live-" + A(20)],
  ["stripe secret key", "s" + "k_live_" + A(24)],
  ["github classic PAT", "gh" + "p_" + A(36)],
  ["github oauth token", "gh" + "o_" + A(36)],
  ["github fine-grained PAT", "github" + "_pat_" + A(22) + "_" + A(59)],
  ["gitlab PAT", "gl" + "pat-" + A(20)],
  ["slack token", "xo" + "xb-" + "1234567890-" + "abcDEF123"],
  ["aws access key id", "AK" + "IA" + "Z".repeat(10) + "234567"],
  ["google api key", "AI" + "za" + "Sy" + A(33)],
  ["three-segment JWT", "ey" + "J" + "hbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiIxMjM0In0" + "." + "abc_DEF-ghi123XYZ"],
  ["telegram bot token", telegram],
  ["jarvis bearer token", "jr" + "vs_" + "a1".repeat(16)],
];

/** Text a token is glued to that still marks its start: a JSON-escaped
 * control sequence (backslash + n/t/r) or a percent-encoded byte. */
const WRAPPERS: Array<[string, string]> = [
  ["escaped newline", "\\n"],
  ["escaped tab", "\\t"],
  ["escaped CR", "\\r"],
  ["percent-encoded =", "%3D"],
  ["percent-encoded quote", "%22"],
];

const WRAPPED: Array<[string, string, string]> = FAMILIES.flatMap(([family, secret]) =>
  WRAPPERS.map(([wrapper, w]): [string, string, string] => [`${family} after ${wrapper}`, `v${w}${secret} end`, secret]),
);

describe("leading anchor — a token after an escaped control sequence or a percent-encoded byte", () => {
  for (const [entry, fn] of ENTRY_POINTS) {
    it.each(WRAPPED)(`${entry}: %s`, (_row, text, secret) => {
      expect(fn(text)).not.toContain(secret);
    });
  }
});

describe("google key — prefix plus fixed-length body, whatever follows", () => {
  const key = "AI" + "za" + "Sy" + A(33);
  const rows: Array<[string, string]> = [
    ["followed by -x", `${key}-x`],
    ["followed by _x", `${key}_x`],
    ["followed by a letter", `${key}Q`],
    ["at end of text", `k ${key}`],
    ["before a space", `${key} next`],
  ];
  for (const [entry, fn] of ENTRY_POINTS) {
    it.each(rows)(`${entry}: %s`, (_row, text) => {
      expect(fn(text)).not.toContain(key);
    });
  }
});

describe("cloud access-key ids — body alphabet [A-Z2-7], both ends anchored", () => {
  const id = "AK" + "IA" + "Z".repeat(10) + "234567";
  /** An upper-case code with 0/1/8/9 in it is not a key id. */
  const regionCode = "AK" + "IA" + "MEX0CDMX1980ZONE";
  it.each<[string, string]>([
    ["an ordinary 20-char code with 0/1/8/9", `region ${regionCode} ok`],
    ["glued to a preceding letter", `x${id} ok`],
    ["glued to a preceding digit", `9${id} ok`],
    ["followed by a letter", `${id}x ok`],
    ["followed by a digit", `${id}9 ok`],
    ["followed by _", `${id}_ ok`],
  ])("mcp entry points leave it unchanged: %s", (_row, text) => {
    expect(redactMcp(text)).toBe(text);
    expect(redactCredentials(text)).toBe(text);
    expect(redactMemory(text)).toBe(text);
  });
  it("the verdict callers do not class the ordinary code as a secret", () => {
    expect(literalEnvValueError("REGION", regionCode)).toBeUndefined();
    expect(isCredentialFact("infra", "region_code", regionCode)).toBe(false);
    // Control: a real-shaped id IS classed secret by both.
    expect(literalEnvValueError("REGION", id)).toBeDefined();
    expect(isCredentialFact("infra", "region_code", id)).toBe(true);
  });
});

describe("stripe-style key followed by _", () => {
  it("the alphanumeric body is removed and the _-suffix stays (the body class has no _)", () => {
    const key = "s" + "k_live_" + A(24);
    expect(redactMcp(`${key}_tail`)).toBe("[REDACTED_KEY]_tail");
    expect(redactMemory(`${key}_tail`)).toBe("[REDACTED-STRIPE-KEY]_tail");
  });
});

describe("executor — a literal the list leaves alone keeps its original bytes", () => {
  it("escapes and non-ASCII survive byte-for-byte next to a redacted literal", () => {
    const key = "gh" + "p_" + A(36);
    const args = String.raw`{"a":"café \/ café","b":"key ` + key + `"}`;
    expect(redactSecretsInArgs(args)).toBe(String.raw`{"a":"café \/ café","b":"key [REDACTED_KEY]"}`);
  });
});

describe("memory text — name-led rules fire only on secret-like values", () => {
  it.each<[string]>([
    ["token_budget=5000"],
    ["TOKEN_LIMIT=200000"],
    ["password_min_length=12, password_expiry_days=90"],
    ["auth_mode=oauth"],
    ["primary_key=id"],
    ["cache_key=user:42:profile"],
    ["hotkey=ctrl+shift+k"],
    ["monkey=banana"],
    ["if(key===null) return;"],
    ["?key=foo&q=cdmx"],
    ['{"password": "Debe tener al menos 12 caracteres"}'],
    ['{"api_key": "pídela al operador"}'],
    ["Authorization: Bearer token requerido para el endpoint"],
    ["API_TOKEN=disabled"],
    ["DB_PASSWORD=123456789012"],
  ])("unchanged: %s", (text) => {
    expect(redactMemory(text)).toBe(text);
  });

  const v16 = "Qw3rTy7UiOp9AsDf";
  const v10 = "Pw9xLm2Qz7";
  const v20 = "Tk4mN8bV2cX6zL0pQ9wE";
  const v12 = "Hn7Jk2Lm9Pq4";
  const v30 = "Br3aR8kT2mN6vC9xZ1qW5eY7uI4oP0";
  it.each<[string, string, string]>([
    ["secret-named assignment", `GEMINI_API_KEY=${v16}`, "GEMINI_API_KEY=[REDACTED-SECRET]"],
    ["password assignment", `DB_PASSWORD=${v10}`, "DB_PASSWORD=[REDACTED-SECRET]"],
    ["query-string token, rest kept", `?access_token=${v20}&q=x`, "?access_token=[REDACTED-SECRET]&q=x"],
    ["quoted assignment, quote kept", `apiKey="${v16}"`, 'apiKey="[REDACTED-SECRET]"'],
    ["JSON password field", `{"password":"${v12}"}`, '{"password":"[REDACTED-SECRET]"}'],
    ["Authorization header", `Authorization: Bearer ${v30}`, "Authorization: Bearer [REDACTED-AUTH]"],
  ])("removed: %s", (_row, text, expected) => {
    expect(redactMemory(text)).toBe(expected);
  });

  it("the default mode (MCP, credentials, executor, verdicts) still redacts by name alone", () => {
    expect(redactCredentials("auth_mode=oauth")).toBe("auth_mode=[REDACTED]");
    expect(redactCredentials('{"password": "Debe tener al menos 12 caracteres"}')).toBe(
      '{"password": "[REDACTED]"}',
    );
  });
});

/** Punctuation a token commonly follows in plain text. Only the token rule
 * can remove these rows: the name before them is not a secret name. */
const PUNCTUATION: Array<[string, string]> = [
  ["a double quote", '"'],
  ["an opening paren", "("],
  ["an equals sign", "="],
  ["a colon", ":"],
  ["a slash", "/"],
];

const AFTER_PUNCTUATION: Array<[string, string, string]> = FAMILIES.flatMap(([family, secret]) =>
  PUNCTUATION.map(([p, c]): [string, string, string] => [`${family} after ${p}`, `v${c}${secret} end`, secret]),
);

describe("leading anchor — a token directly after punctuation", () => {
  for (const [entry, fn] of ENTRY_POINTS) {
    it.each(AFTER_PUNCTUATION)(`${entry}: %s`, (_row, text, secret) => {
      expect(fn(text)).not.toContain(secret);
    });
  }
});

describe("memory text — the secret-name test reads the last name token", () => {
  it.each<[string]>([["TOKEN_LIMIT=unlimited"], ["KEY_ID=user-profile-cache"]])(
    "a keyword in the middle, or a bare KEY, is not a secret name: %s",
    (text) => {
      expect(redactMemory(text)).toBe(text);
    },
  );

  it.each<[string, string]>([
    ["csrfToken=abc12345", "csrfToken=[REDACTED-SECRET]"],
    ["sessionSecret=" + "Xk4pQ9" + "wLm2", "sessionSecret=[REDACTED-SECRET]"],
  ])("a camelCase name is split into tokens: %s", (text, expected) => {
    expect(redactMemory(text)).toBe(expected);
  });
});

describe("memory text — a reference or a placeholder is not a secret", () => {
  it.each<[string]>([
    ["TOKEN=${GITHUB_TOKEN}"],
    ["token=process.env.TOKEN"],
    ["apiKey=config.apiKey"],
    ["API_KEY=YOUR_API_KEY_HERE"],
    ["password=********"],
    ["password=<tu-contraseña>"],
    ["--token=$GH_TOKEN"],
    ["_authToken=${NPM_TOKEN}"],
  ])("unchanged: %s", (text) => {
    expect(redactMemory(text)).toBe(text);
  });

  const mixed16 = "Qw3rTy7UiOp9AsDf";
  const mixed10 = "Pw9xLm2Qz7";
  const hex20 = "a3f9e7c1b0" + "4d8f2a6c9e";
  // Dotted, but each segment mixes letters and digits: token-shaped, not an
  // identifier path.
  const dottedToken = "Zx9qLm2" + "." + "Rt4pWv7" + "." + "Kd8sNb3";
  // Three letter-only segments read as an identifier path, but the JWT shape
  // rule runs before any name rule. Under a secret name the JWT placeholder
  // then ends as the one value placeholder (rule order).
  const letterJwt = "ey" + "J" + "abcdefghij" + "." + "klmnopqrstu" + "." + "vwxyzabcdef";
  it.each<[string, string, string]>([
    ["mixed-case key", `API_KEY=${mixed16}`, "API_KEY=[REDACTED-SECRET]"],
    ["mixed password", `DB_PASSWORD=${mixed10}`, "DB_PASSWORD=[REDACTED-SECRET]"],
    ["lower-case hex token", `token=${hex20}`, "token=[REDACTED-SECRET]"],
    ["token-shaped dotted value", `token=${dottedToken}`, "token=[REDACTED-SECRET]"],
    // The placeholder-word test covers the whole value, not a run inside it.
    ["upper-case underscore run inside a mixed value", "token=Ab3_" + "SECRET_VALUE" + "_9z", "token=[REDACTED-SECRET]"],
    ["letter-only JWT under a secret name", `token=${letterJwt}`, "token=[REDACTED-SECRET]"],
    ["letter-only JWT in plain text, by its own shape rule", `see ${letterJwt} here`, "see [REDACTED-JWT] here"],
  ])("removed: %s", (_row, text, expected) => {
    expect(redactMemory(text)).toBe(expected);
  });

  it("the default mode (MCP, credentials) still redacts a reference by name", () => {
    expect(redactMcp("TOKEN=${GITHUB_TOKEN}")).toBe("TOKEN=[REDACTED]");
    expect(redactCredentials("TOKEN=${GITHUB_TOKEN}")).toBe("TOKEN=[REDACTED]");
  });
});
