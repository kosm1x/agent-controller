/**
 * Ruling 3c: stored credentials are used BY NAME. Real in-memory SQLite with
 * the project schema for the two stores; synthetic values assembled at
 * runtime (public repo — no key-shaped literal in source).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { resolve } from "path";

let db: Database.Database;
vi.mock("../db/index.js", () => ({ getDatabase: () => db }));

const logWarn = vi.fn();
vi.mock("./logger.js", () => {
  const child = {
    warn: (...a: unknown[]) => logWarn(...a),
    info: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    child: () => child,
  };
  return { createLogger: () => child, logger: child };
});

import {
  TEMPLATE_TOOLS,
  invalidateSecretRefs,
  secretPlaceholder,
  secretRefName,
  factIdentity,
  projectIdentity,
  factSecretDisplay,
  projectSecretDisplay,
  scrubSecrets,
  resolveSecretRefs,
  secretEnvForCommand,
} from "./secret-refs.js";
import { deleteUserFact, formatUserFactsBlock } from "../db/user-facts.js";
import { deleteProject, updateProject } from "../db/projects.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Tool } from "../tools/types.js";
import { confirmationGate } from "../tools/task-executor.js";
import { httpTool } from "../tools/builtin/http.js";

// Synthetic secrets and names. A cookie with characters URL-encoding changes.
const COOKIE = "AE" + "Q".repeat(30) + "/+=" + "r".repeat(12);
const SESSION_ID = "{" + "A".repeat(8) + "-" + "B".repeat(4) + "}";
const FTP_PASS = "pw-" + "z".repeat(14);
const API_TOKEN = "d".repeat(8) + "-" + "e".repeat(4) + "-" + "f".repeat(12);
const PORTAL_PASS = "dp-" + "y".repeat(16);
const BLOG_PASS = "sp-" + "w".repeat(16);
const SHORT = "ab" + "12"; // < 8 chars: resolvable, not scrubbed
const EMAIL = ["demo", "example.invalid"].join("@");
const GA_ID = "G-" + "T".repeat(10);

const STORE_DDL = (() => {
  const schema = readFileSync(resolve(__dirname, "../db/schema.sql"), "utf8");
  const from = schema.indexOf("CREATE TABLE IF NOT EXISTS user_facts");
  const endMarker =
    "CREATE INDEX IF NOT EXISTS idx_project_log_project ON project_log(project_id);";
  return schema.slice(from, schema.indexOf(endMarker) + endMarker.length);
})();

function fact(category: string, key: string, value: string) {
  db.prepare(
    "INSERT INTO user_facts (category, key, value) VALUES (?, ?, ?)",
  ).run(category, key, value);
}
function project(slug: string, fields: Record<string, unknown>) {
  db.prepare(
    "INSERT INTO projects (id, slug, name, urls, credentials, config) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    `proj-${slug}`,
    slug,
    slug,
    JSON.stringify(fields.urls ?? {}),
    JSON.stringify(fields.credentials ?? {}),
    JSON.stringify(fields.config ?? {}),
  );
}

function seed() {
  db = new Database(":memory:");
  db.exec(STORE_DDL);
  fact("projects", "acme_session_cookie", COOKIE);
  fact("projects", "acme_session_id", SESSION_ID);
  fact("projects", "acme_ftp_password", FTP_PASS);
  fact("projects", "acme_api_token", API_TOKEN);
  fact("projects", "acme_router_pin", SHORT);
  fact("personal", "age", "30");
  fact("projects", "acme_ga4_id", GA_ID);
  project("acme-portal", {
    credentials: { user: EMAIL, password: PORTAL_PASS },
    urls: { site: "https://portal.example.test" },
  });
  project("demo-blog", { credentials: { password: BLOG_PASS } });
  invalidateSecretRefs();
}

const N = {
  cookie: "SECRET_PROJECTS_ACME_SESSION_COOKIE",
  sid: "SECRET_PROJECTS_ACME_SESSION_ID",
  ftp: "SECRET_PROJECTS_ACME_FTP_PASSWORD",
  tok: "SECRET_PROJECTS_ACME_API_TOKEN",
  pin: "SECRET_PROJECTS_ACME_ROUTER_PIN",
  doc: "SECRET_ACME_PORTAL_PASSWORD",
  sub: "SECRET_DEMO_BLOG_PASSWORD",
};

beforeEach(seed);
afterEach(() => {
  vi.restoreAllMocks();
  logWarn.mockClear();
});

describe("reference names", () => {
  it("names every credential-style entry of both stores, and nothing else", () => {
    expect(secretRefName(factIdentity("projects", "acme_session_cookie"))).toBe(
      N.cookie,
    );
    expect(secretRefName(factIdentity("projects", "acme_session_id"))).toBe(
      N.sid,
    );
    expect(secretRefName(factIdentity("projects", "acme_ftp_password"))).toBe(
      N.ftp,
    );
    expect(secretRefName(factIdentity("projects", "acme_api_token"))).toBe(
      N.tok,
    );
    expect(
      secretRefName(projectIdentity("acme-portal", "credentials", ["password"])),
    ).toBe(N.doc);
    expect(
      secretRefName(projectIdentity("demo-blog", "credentials", ["password"])),
    ).toBe(N.sub);
    expect(secretRefName(factIdentity("personal", "age"))).toBeUndefined();
    expect(
      secretRefName(factIdentity("projects", "acme_ga4_id")),
    ).toBeUndefined();
    // Everything under a project's `credentials` is a secret, whatever its
    // key; `urls` / `config` entries only by the classifier.
    expect(
      secretRefName(projectIdentity("acme-portal", "credentials", ["user"])),
    ).toBe("SECRET_ACME_PORTAL_USER");
    expect(
      secretRefName(projectIdentity("acme-portal", "urls", ["site"])),
    ).toBeUndefined();
    for (const n of Object.values(N)) expect(n).toMatch(/^SECRET_[A-Z0-9_]+$/);
  });

  it("collision rule: every member of a same-base group gets its own identity suffix, independent of row order (facts and projects alike)", () => {
    const build = (order: "ab" | "ba") => {
      db = new Database(":memory:");
      db.exec(STORE_DDL);
      const rows: Array<() => void> = [
        () => fact("projects", "session-token", "c1-" + "k".repeat(12)),
        () => fact("projects", "session_token", "c2-" + "k".repeat(12)),
      ];
      if (order === "ba") rows.reverse();
      rows.forEach((r) => r());
      fact("acme-portal", "password", "c3-" + "k".repeat(12));
      project("acme-portal", { credentials: { password: PORTAL_PASS } });
      invalidateSecretRefs();
      return [
        secretRefName(factIdentity("projects", "session-token")),
        secretRefName(factIdentity("projects", "session_token")),
        secretRefName(factIdentity("acme-portal", "password")),
        secretRefName(
          projectIdentity("acme-portal", "credentials", ["password"]),
        ),
      ];
    };
    const a = build("ab");
    const b = build("ba");
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(4);
    expect(a[0]).toMatch(/^SECRET_PROJECTS_SESSION_TOKEN_[0-9A-F]{6}$/);
    expect(a[1]).toMatch(/^SECRET_PROJECTS_SESSION_TOKEN_[0-9A-F]{6}$/);
    expect(a[2]).toMatch(/^SECRET_ACME_PORTAL_PASSWORD_[0-9A-F]{6}$/);
    expect(a[3]).toMatch(/^SECRET_ACME_PORTAL_PASSWORD_[0-9A-F]{6}$/);
  });
});

describe("display", () => {
  it("one compact Spanish placeholder carrying the name and both usage forms", () => {
    expect(secretPlaceholder(N.cookie)).toBe(
      `[oculto · úsalo por nombre: $${N.cookie} en shell_exec, {{${N.cookie}}} en http_fetch/navegador]`,
    );
  });

  it("the placeholder is JSON-safe: a scrubbed shell_exec-style result still parses", () => {
    expect(secretPlaceholder(N.cookie)).not.toMatch(/["\\]/);
    const raw = JSON.stringify({
      stdout: `token=${FTP_PASS}\n`,
      stderr: "",
      exit_code: 0,
    });
    const parsed = JSON.parse(scrubSecrets(raw));
    expect(parsed.stdout).toBe(`token=${secretPlaceholder(N.ftp)}\n`);
    expect(parsed.exit_code).toBe(0);
  });

  it("facts and project entries show the placeholder; others are byte-identical", () => {
    expect(factSecretDisplay("projects", "acme_session_cookie", COOKIE)).toBe(
      secretPlaceholder(N.cookie),
    );
    expect(factSecretDisplay("personal", "age", "30")).toBe("30");
    expect(
      projectSecretDisplay(
        "acme-portal",
        "credentials",
        "password",
        PORTAL_PASS,
      ),
    ).toBe(secretPlaceholder(N.doc));
    expect(
      projectSecretDisplay(
        "acme-portal",
        "credentials",
        "user",
        EMAIL,
      ),
    ).toBe(secretPlaceholder("SECRET_ACME_PORTAL_USER"));
    expect(
      projectSecretDisplay(
        "acme-portal",
        "urls",
        "site",
        "https://portal.example.test",
      ),
    ).toBe("https://portal.example.test");
  });

  it("formatUserFactsBlock shows the by-name placeholder, never the value", () => {
    const block = formatUserFactsBlock();
    expect(block).toContain(
      `- **acme_session_cookie**: ${secretPlaceholder(N.cookie)}`,
    );
    expect(block).toContain("- **age**: 30");
    expect(block).not.toContain(COOKIE);
    expect(block).not.toContain(FTP_PASS);
  });
});

describe("resolveSecretRefs", () => {
  it("http_fetch: {{SECRET_X}} in nested header strings resolves on a COPY; the caller's args keep the reference", () => {
    const args = {
      url: "https://api.example.test/v1/items",
      headers: { Cookie: `sess={{${N.cookie}}}; sid={{${N.sid}}}` },
    };
    const snapshot = structuredClone(args);
    const r = resolveSecretRefs("http_fetch", args);
    if (!("args" in r)) throw new Error("expected args");
    expect(r.args).not.toBe(args);
    expect((r.args.headers as Record<string, string>).Cookie).toBe(
      `sess=${COOKIE}; sid=${SESSION_ID}`,
    );
    expect(args).toEqual(snapshot);
  });

  it("browser type/fill/navigate: strings in arrays and objects resolve", () => {
    const r = resolveSecretRefs("playwright__browser_fill_form", {
      fields: [
        { name: "Email", value: EMAIL },
        { name: "Password", value: `{{${N.doc}}}` },
      ],
    });
    if (!("args" in r)) throw new Error("expected args");
    expect(JSON.stringify(r.args)).toContain(PORTAL_PASS);
    const t = resolveSecretRefs("playwright__browser_type", {
      ref: "e12",
      text: `{{${N.sub}}}`,
    });
    if (!("args" in t)) throw new Error("expected args");
    expect(t.args.text).toBe(BLOG_PASS);
    const short = resolveSecretRefs("browser__fill", {
      value: `{{${N.pin}}}`,
    });
    if (!("args" in short)) throw new Error("expected args");
    expect(short.args.value).toBe(SHORT);
  });

  it("an unknown name refuses the call with an {error} naming it", () => {
    const r = resolveSecretRefs("http_fetch", {
      url: "https://x.example.com/?k={{SECRET_NOPE}}",
      headers: { Cookie: `a={{${N.cookie}}}` },
    });
    expect("error" in r).toBe(true);
    const { error } = JSON.parse((r as { error: string }).error);
    expect(error).toContain("SECRET_NOPE");
    expect(error).toContain("http_fetch");
    expect(error).not.toContain(COOKIE);
  });

  it.each(["gmail_send", "tweet_post", "file_write", "shell_exec", "jarvis_file_write"])(
    "%s: references stay literal (same object back)",
    (tool) => {
      const args = { body: `x {{${N.cookie}}} y`, command: `echo {{${N.ftp}}}` };
      const r = resolveSecretRefs(tool, args);
      expect(r).toEqual({ args });
      expect((r as { args: unknown }).args).toBe(args);
    },
  );

  it("the allow-list is exactly http_fetch + browser navigate/type/fill", () => {
    expect([...TEMPLATE_TOOLS].sort()).toEqual([
      "browser__fill",
      "browser__goto",
      "http_fetch",
      "playwright__browser_fill_form",
      "playwright__browser_navigate",
      "playwright__browser_type",
    ]);
  });
});

describe("secretEnvForCommand (shell_exec)", () => {
  it("exports exactly the referenced names, both spellings; unknown and unreferenced absent", () => {
    const env = secretEnvForCommand(
      `curl -u "demo:$${N.ftp}" ftp://ftp.example.test/ && curl "https://api.example.test/x/\${${N.tok}}" && echo $SECRET_UNKNOWN`,
    );
    expect(env).toEqual({ [N.ftp]: FTP_PASS, [N.tok]: API_TOKEN });
    expect(secretEnvForCommand("ls -la")).toEqual({});
    expect(secretEnvForCommand(`echo {{${N.cookie}}}`)).toEqual({});
  });

  it("an unknown $SECRET_X / ${SECRET_X} refuses the call, naming it; a stored one passes the same args object", () => {
    for (const command of [
      `curl -u "demo:$${N.ftp}" x && echo $SECRET_NOPE`,
      "echo ${SECRET_NOPE}",
    ]) {
      const r = resolveSecretRefs("shell_exec", { command });
      expect("error" in r).toBe(true);
      const { error } = JSON.parse((r as { error: string }).error);
      expect(error).toContain("SECRET_NOPE");
      expect(error).toContain("shell_exec");
      expect(error).not.toContain(FTP_PASS);
    }
    const args = { command: `printf %s "$${N.ftp}"` };
    expect((resolveSecretRefs("shell_exec", args) as { args: unknown }).args).toBe(args);
  });

  it("a mention without $, or $SECRET_ with nothing after the underscore, still runs", () => {
    for (const command of ["grep -rn SECRET_NOPE .", "echo '$SECRET_'", "echo $SECRET_ done"]) {
      const args = { command };
      expect((resolveSecretRefs("shell_exec", args) as { args: unknown }).args).toBe(args);
    }
  });
});

describe("scrubSecrets", () => {
  it("replaces exact and URL-encoded values with the placeholder; short values and non-secrets stay", () => {
    const out = scrubSecrets(
      `a=${COOKIE} b=${encodeURIComponent(COOKIE)} c=${SESSION_ID} d=${encodeURIComponent(SESSION_ID)} e=${SHORT} f=${GA_ID} g=${PORTAL_PASS}`,
    );
    expect(out).not.toContain(COOKIE);
    expect(out).not.toContain(encodeURIComponent(COOKIE));
    expect(out).not.toContain(SESSION_ID);
    expect(out).not.toContain(encodeURIComponent(SESSION_ID));
    expect(out).not.toContain(PORTAL_PASS);
    expect(out.split(secretPlaceholder(N.cookie))).toHaveLength(3);
    expect(out).toContain(`e=${SHORT}`);
    expect(out).toContain(`f=${GA_ID}`);
  });

  it("catches the JSON-escaped forms (once and twice) of a value with a quote, a backslash and a newline", () => {
    const quoted = 'qv-"' + "m".repeat(10) + "\\" + "\n" + "n".repeat(4);
    fact("projects", "acme_quoted_password", quoted);
    invalidateSecretRefs();
    const ph = secretPlaceholder("SECRET_PROJECTS_ACME_QUOTED_PASSWORD");
    const once = JSON.stringify({ stdout: `a ${quoted} b` });
    const outOnce = scrubSecrets(once);
    expect(outOnce).not.toContain(JSON.stringify(quoted).slice(1, -1));
    expect(JSON.parse(outOnce).stdout).toBe(`a ${ph} b`);
    const twice = JSON.stringify({ result: once });
    const outTwice = scrubSecrets(twice);
    expect(outTwice).not.toContain("m".repeat(10));
    expect(JSON.parse(JSON.parse(outTwice).result).stdout).toBe(`a ${ph} b`);
  });

  it("replaces the longest value first: a value containing a shorter stored value is replaced whole", () => {
    const short = "kk-" + "j".repeat(12);
    const long = short + "-" + "h".repeat(6);
    fact("projects", "acme_short_token", short); // inserted first
    fact("projects", "acme_long_token", long);
    invalidateSecretRefs();
    expect(scrubSecrets(`x ${long} y`)).toBe(
      `x ${secretPlaceholder("SECRET_PROJECTS_ACME_LONG_TOKEN")} y`,
    );
  });

  it("deleteProject drops the project's secrets from the index at once", () => {
    expect(scrubSecrets(BLOG_PASS)).toBe(secretPlaceholder(N.sub)); // index built
    expect(deleteProject("demo-blog")).toBe(true);
    expect(scrubSecrets(BLOG_PASS)).toBe(BLOG_PASS);
  });

  it("is invalidated by store writers; external writes show up after the TTL", () => {
    expect(scrubSecrets(BLOG_PASS)).toBe(secretPlaceholder(N.sub)); // index built
    updateProject("demo-blog", { credentials: { password: "np-" + "v".repeat(16) } });
    expect(scrubSecrets("np-" + "v".repeat(16))).toBe(
      secretPlaceholder(N.sub),
    );
    expect(scrubSecrets(BLOG_PASS)).toBe(BLOG_PASS);
    deleteUserFact("projects", "acme_ftp_password");
    expect(secretRefName(factIdentity("projects", "acme_ftp_password"))).toBeUndefined();

    fact("projects", "late_token", "lt-" + "u".repeat(16)); // bypasses writers
    expect(scrubSecrets("lt-" + "u".repeat(16))).toBe("lt-" + "u".repeat(16));
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    expect(scrubSecrets("lt-" + "u".repeat(16))).toBe(
      secretPlaceholder("SECRET_PROJECTS_LATE_TOKEN"),
    );
  });

  it("1 MB output with 40 secrets stays fast (linear, no value-built regex)", () => {
    for (let i = 0; i < 34; i++) {
      fact("projects", `bulk_token_${i}`, `bt${i}-` + "q".repeat(20));
    }
    invalidateSecretRefs();
    const chunk = "lorem ipsum dolor sit amet ".repeat(40);
    let big = "";
    while (big.length < 1_000_000) big += chunk + COOKIE + " ";
    scrubSecrets("warm-up");
    const t0 = performance.now();
    const out = scrubSecrets(big);
    const ms = performance.now() - t0;
    expect(out).not.toContain(COOKIE);
    console.log(`[secret-refs perf] 1MB / 40 secrets: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(500);
  });
});

describe("the tool seam (ToolRegistry.executeDirect)", () => {
  function echoTool(name: string, riskTier?: "high"): Tool {
    return {
      name,
      ...(riskTier && { riskTier }),
      definition: {
        type: "function",
        function: {
          name,
          description: "echo",
          parameters: { type: "object", properties: {} },
        },
      },
      execute: vi.fn(async (a: Record<string, unknown>) =>
        JSON.stringify({ got: a }),
      ),
    };
  }

  it("resolves for an allow-listed tool, scrubs the echo, and leaves the caller's args (what recorders hold) untouched", async () => {
    const reg = new ToolRegistry();
    const tool = echoTool("http_fetch", "high");
    reg.register(tool);
    const args = {
      url: "https://api.example.test/x",
      headers: { Cookie: `sess={{${N.cookie}}}` },
    };
    const snapshot = structuredClone(args);
    const out = await reg.execute("http_fetch", args);
    // The tool saw the value…
    expect(JSON.stringify(vi.mocked(tool.execute).mock.calls[0][0])).toContain(
      COOKIE,
    );
    // …the model gets the placeholder back, the caller's object keeps the reference.
    expect(out).not.toContain(COOKIE);
    expect(out).toContain(secretPlaceholder(N.cookie));
    expect(args).toEqual(snapshot);
    // The risk-tier audit log line records the reference form.
    const logged = JSON.stringify(logWarn.mock.calls);
    expect(logged).toContain(`{{${N.cookie}}}`);
    expect(logged).not.toContain(COOKIE);
  });

  it("a non-allow-listed tool receives the literal reference", async () => {
    const reg = new ToolRegistry();
    const tool = echoTool("gmail_send");
    reg.register(tool);
    await reg.execute("gmail_send", { body: `{{${N.cookie}}}` });
    expect(vi.mocked(tool.execute).mock.calls[0][0]).toEqual({
      body: `{{${N.cookie}}}`,
    });
  });

  it("scrubs ANY tool's result (e.g. printenv in a shell child, a file read back)", async () => {
    const reg = new ToolRegistry();
    const t: Tool = {
      ...echoTool("shell_exec"),
      execute: async () =>
        JSON.stringify({ stdout: `${N.ftp}=${FTP_PASS}\n`, exit_code: 0 }),
    };
    reg.register(t);
    const out = await reg.execute("shell_exec", { command: `printenv ${N.ftp}` });
    expect(out).not.toContain(FTP_PASS);
    expect(out).toContain(secretPlaceholder(N.ftp));
  });

  it("scrubs a thrown error's message", async () => {
    const reg = new ToolRegistry();
    const t: Tool = {
      ...echoTool("browser__goto"),
      execute: async (a) => {
        throw new Error(`navigation failed for ${String(a.url)}`);
      },
    };
    reg.register(t);
    await expect(
      reg.execute("browser__goto", {
        url: `https://x.example.com/?t={{${N.tok}}}`,
      }),
    ).rejects.toThrow(/^(?![\s\S]*dddddddd-eeee)[\s\S]*SECRET_PROJECTS_ACME_API_TOKEN/);
  });

  it("scrubs a thrown string", async () => {
    const reg = new ToolRegistry();
    reg.register({
      ...echoTool("browser__goto"),
      execute: async () => {
        throw `fallo con ${API_TOKEN}`;
      },
    });
    await expect(reg.execute("browser__goto", {})).rejects.toBe(
      `fallo con ${secretPlaceholder(N.tok)}`,
    );
  });

  it("an error carrying no secret is rethrown untouched (same object)", async () => {
    const reg = new ToolRegistry();
    const original = new TypeError("sin datos sensibles");
    reg.register({
      ...echoTool("browser__goto"),
      execute: async () => {
        throw original;
      },
    });
    await expect(reg.execute("browser__goto", {})).rejects.toBe(original);
  });

  it("an error with a read-only message (DOMException) is replaced by a scrubbed Error keeping its name", async () => {
    const reg = new ToolRegistry();
    reg.register({
      ...echoTool("browser__goto"),
      execute: async () => {
        throw new DOMException(`bad selector ${API_TOKEN}`, "SyntaxError");
      },
    });
    const err = await reg.execute("browser__goto", {}).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.name).toBe("SyntaxError");
    expect(err!.message).toBe(`bad selector ${secretPlaceholder(N.tok)}`);
    expect(String(err!.stack)).not.toContain(API_TOKEN);
  });

  it("shell_exec with an unknown $SECRET_X is refused before the tool runs", async () => {
    const reg = new ToolRegistry();
    const tool = echoTool("shell_exec");
    reg.register(tool);
    const out = await reg.execute("shell_exec", { command: "echo $SECRET_MISSING" });
    expect(JSON.parse(out).error).toContain("SECRET_MISSING");
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("an unknown name is refused before the tool runs", async () => {
    const reg = new ToolRegistry();
    const tool = echoTool("http_fetch");
    reg.register(tool);
    const out = await reg.execute("http_fetch", {
      url: "https://x.example.com/{{SECRET_MISSING}}",
    });
    expect(JSON.parse(out).error).toContain("SECRET_MISSING");
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("a reference changes no gate decision (the gate runs on the reference form, before resolution)", () => {
    const reg = new ToolRegistry();
    reg.register(httpTool);
    reg.register(echoTool("playwright__browser_type", "high"));
    for (const interactive of [true, false]) {
      for (const canAskOperator of [true, false]) {
        const ctx = {
          interactive,
          canAskOperator,
          chatOrigin: true,
          isDestructiveUnlocked: () => false,
        };
        for (const [tool, plain, ref] of [
          ["http_fetch", { url: "https://x.example.com/?k=v" }, { url: `https://x.example.com/?k={{${N.cookie}}}` }],
          ["playwright__browser_type", { text: "hola" }, { text: `{{${N.doc}}}` }],
        ] as const) {
          expect(confirmationGate(reg, ctx, tool, { ...ref })).toEqual(
            confirmationGate(reg, ctx, tool, { ...plain }),
          );
        }
      }
    }
  });
});
