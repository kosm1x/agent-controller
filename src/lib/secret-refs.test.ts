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
let dbThrows = false;
vi.mock("../db/index.js", () => ({
  getDatabase: () => {
    if (dbThrows) throw new Error("no database in this process");
    return db;
  },
}));

const logWarn = vi.fn();
const logInfo = vi.fn();
vi.mock("./logger.js", () => {
  const child = {
    warn: (...a: unknown[]) => logWarn(...a),
    info: (...a: unknown[]) => logInfo(...a),
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
  resetSecretRefsForTest,
  secretPlaceholder,
  secretRefName,
  factIdentity,
  projectIdentity,
  factSecretDisplay,
  projectSecretDisplay,
  projectEntryLeaves,
  scrubSecrets,
  resolveSecretRefs,
  secretEnvForCommand,
  expireSecretRefsForTest,
  scrubStructured,
  scrubJsonText,
  resolveStoredReference,
  PLACEHOLDER_MARKERS,
  resolveRenderedPlaceholders,
  encodeSecretForm,
} from "./secret-refs.js";
import { CREDENTIAL_FACT_PLACEHOLDER } from "../db/user-facts.js";
import { deleteUserFact, formatUserFactsBlock } from "../db/user-facts.js";
import { deleteProject, updateProject } from "../db/projects.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Tool } from "../tools/types.js";
import { confirmationGate } from "../tools/task-executor.js";
import { httpTool } from "../tools/builtin/http.js";
import { fileReadTool, fileWriteTool } from "../tools/builtin/file.js";
import { fileEditTool } from "../tools/builtin/code-editing.js";
import { dataSummarizeTool } from "../tools/builtin/data-summarize.js";
import { mkdtempSync, readFileSync as readFs, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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
  dbThrows = false;
  vi.restoreAllMocks();
  logWarn.mockClear();
  logInfo.mockClear();
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
    // Ruling 3d: a `credentials` entry is a secret only by the classifier,
    // like `urls` / `config` — a username/e-mail gets no name.
    expect(
      secretRefName(projectIdentity("acme-portal", "credentials", ["user"])),
    ).toBeUndefined();
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
    ).toBe(EMAIL);
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

describe('ruling 3d — "Just real credentials. Everything must be accessible"', () => {
  // Synthetic project; every value assembled at runtime, neutral in shape so
  // only the KEY NAME can make it a secret.
  const SITE_HOST = ["acme-site", "example", "test"].join(".");
  const SITE_URL = "https://" + SITE_HOST;
  const LOGIN_EMAIL = ["webmaster", SITE_HOST].join("@");
  const MEASUREMENT_ID = "G-" + "M".repeat(10);
  const CLIENT_ID = "cid-" + "4".repeat(12);
  const SECRET_KEYS = [
    "pass", "password", "pwd", "passwd", "token", "api_key", "apikey",
    "secret", "client_secret", "private_key", "key", "cookie", "s2", "swid",
    "session", "auth", "bearer",
  ];
  const valueFor = (k: string, nested: boolean) =>
    (nested ? "nv-" : "tv-") + k.replace(/_/g, "u") + "-" + "c".repeat(10);

  function seed3d() {
    project("acme-site", {
      urls: { site: SITE_URL },
      credentials: {
        ftp_host: SITE_HOST,
        username: LOGIN_EMAIL,
        ga4_measurement_id: MEASUREMENT_ID,
        client_id: CLIENT_ID,
        port: 2121,
        ...Object.fromEntries(SECRET_KEYS.map((k) => [k, valueFor(k, false)])),
        svc: {
          host: SITE_HOST,
          user: LOGIN_EMAIL,
          ...Object.fromEntries(SECRET_KEYS.map((k) => [k, valueFor(k, true)])),
        },
      },
    });
    invalidateSecretRefs();
  }

  it("usernames, e-mails, hosts, ports and IDs under credentials (top-level and nested) get no name, show in clear and are not scrubbed", () => {
    seed3d();
    const visible: Array<[string[], string]> = [
      [["ftp_host"], SITE_HOST],
      [["username"], LOGIN_EMAIL],
      [["ga4_measurement_id"], MEASUREMENT_ID],
      [["client_id"], CLIENT_ID],
      [["svc", "host"], SITE_HOST],
      [["svc", "user"], LOGIN_EMAIL],
    ];
    for (const [path, value] of visible) {
      expect(
        secretRefName(projectIdentity("acme-site", "credentials", path)),
      ).toBeUndefined();
    }
    for (const k of ["ftp_host", "username", "ga4_measurement_id", "client_id"]) {
      const v = visible.find(([p]) => p[0] === k)![1];
      expect(projectSecretDisplay("acme-site", "credentials", k, v)).toBe(v);
    }
    expect(projectSecretDisplay("acme-site", "credentials", "port", 2121)).toBe(
      "2121",
    );
    // ftp_host equals the site's domain: the site URL, the e-mail and the IDs
    // come through tool output intact.
    const text = `site ${SITE_URL}/blog mail ${LOGIN_EMAIL} ga ${MEASUREMENT_ID} id ${CLIENT_ID}`;
    expect(scrubSecrets(text)).toBe(text);
    expect(scrubSecrets(JSON.stringify({ url: SITE_URL }))).toBe(
      JSON.stringify({ url: SITE_URL }),
    );
  });

  it.each(SECRET_KEYS)(
    "a %s entry, top-level and nested, is hidden, named and scrubbed",
    (k) => {
      seed3d();
      const top = valueFor(k, false);
      const nested = valueFor(k, true);
      const topName = secretRefName(
        projectIdentity("acme-site", "credentials", [k]),
      );
      const nestedName = secretRefName(
        projectIdentity("acme-site", "credentials", ["svc", k]),
      );
      expect(topName).toBe(`SECRET_ACME_SITE_${k.toUpperCase()}`);
      expect(nestedName).toBe(`SECRET_ACME_SITE_SVC_${k.toUpperCase()}`);
      expect(projectSecretDisplay("acme-site", "credentials", k, top)).toBe(
        secretPlaceholder(topName!),
      );
      expect(scrubSecrets(`a ${top} b ${nested} c`)).toBe(
        `a ${secretPlaceholder(topName!)} b ${secretPlaceholder(nestedName!)} c`,
      );
      expect(secretEnvForCommand(`echo $${nestedName}`)).toEqual({
        [nestedName!]: nested,
      });
    },
  );

  it("a credential-SHAPED value under a neutral key is still hidden", () => {
    project("acme-site", {
      credentials: { notes: "https://deploy:" + PORTAL_PASS + "@" + SITE_HOST },
    });
    invalidateSecretRefs();
    expect(
      secretRefName(projectIdentity("acme-site", "credentials", ["notes"])),
    ).toBe("SECRET_ACME_SITE_NOTES");
  });
});

describe("audit R4 3d-a — a leaf below a credential-named key is secret", () => {
  const v = (tag: string) => "av-" + tag + "-" + "k".repeat(10);
  const HOST = ["ftp", "acme-nest", "example", "test"].join(".");
  const CID = "cid-" + "7".repeat(12);
  function seedNested() {
    project("acme-nest", {
      credentials: {
        password: { prod: v("prod"), staging: v("staging") },
        github_token: { value: v("ghval"), scope: "repo" },
        api_keys: [v("k0"), v("k1")],
        svc: { tokens: [{ label: v("lbl") }] },
        oauth: { client_id: CID, client_secret: v("cs") },
        ftp: { host: HOST, user: "deploy" },
      },
    });
    invalidateSecretRefs();
  }
  const hidden: Array<[string[], string]> = [
    [["password", "prod"], v("prod")],
    [["password", "staging"], v("staging")],
    [["github_token", "value"], v("ghval")],
    [["github_token", "scope"], "repo"],
    [["api_keys", "0"], v("k0")],
    [["api_keys", "1"], v("k1")],
    [["svc", "tokens", "0", "label"], v("lbl")],
    [["oauth", "client_secret"], v("cs")],
  ];
  const visible: Array<[string[], string]> = [
    [["oauth", "client_id"], CID],
    [["ftp", "host"], HOST],
    [["ftp", "user"], "deploy"],
  ];

  it("object and array children of a secret-named parent are named in the index and scrubbed", () => {
    seedNested();
    for (const [path, value] of hidden) {
      const name = secretRefName(projectIdentity("acme-nest", "credentials", path));
      expect(name, path.join(".")).toBe(
        "SECRET_ACME_NEST_" + path.join("_").toUpperCase(),
      );
      if (value.length >= 8) {
        expect(scrubSecrets(`x ${value} y`)).toBe(
          `x ${secretPlaceholder(name!)} y`,
        );
      }
    }
  });

  it("projectEntryLeaves (project_get / saved_secrets) hides the same leaves", () => {
    seedNested();
    const creds: Record<string, unknown> = {
      password: { prod: v("prod"), staging: v("staging") },
      github_token: { value: v("ghval"), scope: "repo" },
      api_keys: [v("k0"), v("k1")],
      svc: { tokens: [{ label: v("lbl") }] },
      oauth: { client_id: CID, client_secret: v("cs") },
      ftp: { host: HOST, user: "deploy" },
    };
    const leaves = Object.entries(creds).flatMap(([k, val]) =>
      projectEntryLeaves("acme-nest", "credentials", k, val),
    );
    const byPath = new Map(leaves.map((l) => [l.path.join("."), l]));
    for (const [path, value] of hidden) {
      const leaf = byPath.get(path.join("."))!;
      expect(leaf.secret, path.join(".")).toBe(true);
      expect(leaf.display).not.toContain(value);
      expect(leaf.display).toBe(
        secretPlaceholder("SECRET_ACME_NEST_" + path.join("_").toUpperCase()),
      );
    }
    for (const [path, value] of visible) {
      const leaf = byPath.get(path.join("."))!;
      expect(leaf.secret, path.join(".")).toBe(false);
      expect(leaf.display).toBe(value);
    }
  });

  it("oauth.client_id, ftp.host and ftp.user stay visible: no name, not scrubbed", () => {
    seedNested();
    for (const [path, value] of visible) {
      expect(
        secretRefName(projectIdentity("acme-nest", "credentials", path)),
      ).toBeUndefined();
      expect(scrubSecrets(`x ${value} y`)).toBe(`x ${value} y`);
    }
  });
});

describe("audit R5 B1 — compound containers are not secret ancestors", () => {
  const v = (tag: string) => "cv-" + tag + "-" + "m".repeat(10);
  const CONTAINERS = [
    "db_credentials",
    "basic_auth",
    "google_oauth",
    "smtp_auth",
    "oauth_config",
    "credenciales_ftp",
  ];
  const visibleChildren = (c: string): Record<string, string> => ({
    host: `${c.replace(/_/g, "-")}.example.test`,
    user: "deploy",
    username: "deploy-" + c,
    client_id: "cid-" + c + "-0001",
    project_id: "pid-" + c,
    port: "5432",
  });
  function seedContainers() {
    const credentials: Record<string, unknown> = {};
    for (const c of CONTAINERS) {
      credentials[c] = {
        ...visibleChildren(c),
        password: v(c + "-pw"),
        client_secret: v(c + "-cs"),
      };
    }
    credentials.password = { prod: v("prod") };
    credentials.api_keys = [v("k0")];
    project("acme-box", { credentials });
    invalidateSecretRefs();
    return credentials;
  }

  it("children host/user/username/client_id/project_id/port stay visible (index and display); password and client_secret hidden", () => {
    const credentials = seedContainers();
    const leaves = Object.entries(credentials).flatMap(([k, val]) =>
      projectEntryLeaves("acme-box", "credentials", k, val),
    );
    const byPath = new Map(leaves.map((l) => [l.path.join("."), l]));
    for (const c of CONTAINERS) {
      for (const [k, value] of Object.entries(visibleChildren(c))) {
        const leaf = byPath.get(`${c}.${k}`)!;
        expect(leaf.secret, `${c}.${k}`).toBe(false);
        expect(leaf.display).toBe(value);
        expect(
          secretRefName(projectIdentity("acme-box", "credentials", [c, k])),
          `${c}.${k}`,
        ).toBeUndefined();
        if (value.length >= 8) {
          expect(scrubSecrets(`x ${value} y`)).toBe(`x ${value} y`);
        }
      }
      for (const k of ["password", "client_secret"]) {
        const leaf = byPath.get(`${c}.${k}`)!;
        const name = secretRefName(projectIdentity("acme-box", "credentials", [c, k]));
        expect(leaf.secret, `${c}.${k}`).toBe(true);
        expect(name, `${c}.${k}`).toBeDefined();
        expect(leaf.display).toBe(secretPlaceholder(name!));
        const value = (credentials[c] as Record<string, string>)[k]!;
        expect(scrubSecrets(`x ${value} y`)).toBe(`x ${secretPlaceholder(name!)} y`);
      }
    }
  });

  it("`password: {prod}` and `api_keys: [v]` are still hidden (index and display identical)", () => {
    const credentials = seedContainers();
    for (const [key, path, value] of [
      ["password", ["password", "prod"], v("prod")],
      ["api_keys", ["api_keys", "0"], v("k0")],
    ] as const) {
      const leaf = projectEntryLeaves("acme-box", "credentials", key, credentials[key])
        .find((l) => l.path.join(".") === path.join("."))!;
      const name = secretRefName(projectIdentity("acme-box", "credentials", [...path]));
      expect(leaf.secret).toBe(true);
      expect(name).toBe("SECRET_ACME_BOX_" + path.join("_").toUpperCase());
      expect(leaf.display).toBe(secretPlaceholder(name!));
      expect(scrubSecrets(value)).toBe(secretPlaceholder(name!));
    }
  });
});

describe("audit R5 — structured scrub (tool-call arguments, container payloads)", () => {
  it("string leaves are scrubbed; a NUMBER leaf equal to a stored value becomes its placeholder; keys and other numbers kept", () => {
    const NUM = "73519046"; // 8 digits: scrubbed length
    fact("projects", "bank_nip_long", NUM);
    invalidateSecretRefs();
    const ph = secretPlaceholder("SECRET_PROJECTS_BANK_NIP_LONG");
    const args = { pin: Number(NUM), note: `ftp ${FTP_PASS}`, n: 42, list: [Number(NUM)] };
    expect(scrubStructured(args)).toEqual({
      pin: ph,
      note: `ftp ${secretPlaceholder(N.ftp)}`,
      n: 42,
      list: [ph],
    });
    // The text scrub alone misses nothing here only by luck — JSON-aware:
    const text = JSON.stringify(args);
    const out = scrubJsonText(text);
    expect(out).not.toContain(NUM);
    expect(JSON.parse(out).pin).toBe(ph);
    // Unchanged → the same text (prompt-cache prefix stays byte-identical).
    const clean = '{ "a": 1,  "b": "x" }';
    expect(scrubJsonText(clean)).toBe(clean);
    // Not JSON → the text scrub.
    expect(scrubJsonText(`{bad ${FTP_PASS}`)).toBe(`{bad ${secretPlaceholder(N.ftp)}`);
  });
});

describe("audit R5 B2 — resolveStoredReference", () => {
  it("both rendered displays start with a marker", () => {
    expect(secretPlaceholder(N.ftp).startsWith(PLACEHOLDER_MARKERS[0]!)).toBe(true);
    expect(CREDENTIAL_FACT_PLACEHOLDER.startsWith(PLACEHOLDER_MARKERS[1]!)).toBe(true);
  });

  it("placeholder, {{X}}, ${X} and $X resolve to the stored value; unknown names and embedded placeholders are refused; plain values pass", () => {
    for (const ref of [
      secretPlaceholder(N.ftp),
      ` ${secretPlaceholder(N.ftp)} `,
      `{{${N.ftp}}}`,
      `\${${N.ftp}}`,
      `$${N.ftp}`,
    ]) {
      expect(resolveStoredReference(ref), ref).toEqual({
        kind: "resolved",
        value: FTP_PASS,
        name: N.ftp,
      });
    }
    for (const ref of [`{{SECRET_NOPE}}`, `$SECRET_NOPE`, secretPlaceholder("SECRET_NOPE")]) {
      const r = resolveStoredReference(ref);
      expect(r.kind, ref).toBe("error");
      expect((r as { error: string }).error).toContain("SECRET_NOPE");
    }
    for (const junk of [
      `ftp:${secretPlaceholder(N.ftp)}`,
      secretPlaceholder(N.ftp).slice(0, 30),
      CREDENTIAL_FACT_PLACEHOLDER,
    ]) {
      const r = resolveStoredReference(junk);
      expect(r.kind, junk).toBe("error");
      expect((r as { error: string }).error).toContain("{{SECRET_<NOMBRE>}}");
    }
    expect(resolveStoredReference("hola $SECRET_X mundo")).toEqual({ kind: "plain" });
    expect(resolveStoredReference(FTP_PASS)).toEqual({ kind: "plain" });
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

  it("audit R3 N2: any ${…SECRET_…} form but the bare ${SECRET_X} is refused, even for a stored name", () => {
    for (const command of [
      `echo \${${N.ftp}:-d}`,
      `echo \${${N.ftp}:0:4} $${N.ftp}`,
      `echo \${${N.ftp}#p}`,
      `echo \${${N.ftp}%x}`,
      `echo \${#${N.ftp}}`,
      `echo \${!${N.ftp}}`,
      "echo ${!SECRET_*}",
      `echo \${${N.ftp}/a/b}`,
      `echo \${${N.ftp}`,
    ]) {
      const r = resolveSecretRefs("shell_exec", { command });
      expect("error" in r, command).toBe(true);
      const { error } = JSON.parse((r as { error: string }).error);
      expect(error).toContain("shell_exec");
      expect(error).not.toContain(FTP_PASS);
    }
    const args = { command: `echo "\${${N.ftp}}" $${N.ftp}` };
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
    // Audit R7 B-4: the URL-encoded form gets the placeholder tagged with its form.
    expect(out.split(secretPlaceholder(N.cookie))).toHaveLength(2);
    expect(out.split(secretPlaceholder(N.cookie, "url"))).toHaveLength(2);
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
    // Audit R7 B-4: the substring scrub tags what it matched (the
    // JSON-escaped form of the serialized text) …
    const name = "SECRET_PROJECTS_ACME_QUOTED_PASSWORD";
    expect(JSON.parse(outOnce).stdout).toBe(`a ${secretPlaceholder(name, "json")} b`);
    const twice = JSON.stringify({ result: once });
    const outTwice = scrubSecrets(twice);
    expect(outTwice).not.toContain("m".repeat(10));
    expect(JSON.parse(JSON.parse(outTwice).result).stdout).toBe(
      `a ${secretPlaceholder(name, "json2")} b`,
    );
    // … while the JSON-aware scrub (what the tool seam uses for a JSON
    // result) sees the decoded leaf, where the value is raw.
    expect(JSON.parse(scrubJsonText(once)).stdout).toBe(`a ${ph} b`);
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

describe("index build (buildIndex)", () => {
  it("a database without the store tables holds no secrets: empty index, no throw", () => {
    db = new Database(":memory:");
    invalidateSecretRefs();
    const text = `x ${COOKIE} y`;
    expect(scrubSecrets(text)).toBe(text);
    expect(secretRefName(factIdentity("projects", "acme_session_cookie"))).toBeUndefined();
    expect(secretEnvForCommand('echo "$' + N.cookie + '"')).toEqual({});
    // Unknown references are still refused (nothing is stored under any name).
    const out = resolveSecretRefs("shell_exec", { command: "echo $" + N.cookie });
    expect("error" in out && JSON.parse(out.error).error).toContain(N.cookie);
  });

  it("audit R4 failure policy: a build error after the TTL (no write since) falls back to the last-good index, warns once per episode, and recovers", () => {
    const warned = () =>
      logWarn.mock.calls.filter((c) =>
        String(c[1]).includes("last good index"),
      ).length;
    expect(scrubSecrets(`x ${COOKIE}`)).toBe(`x ${secretPlaceholder(N.cookie)}`);
    db.close(); // "The database connection is not open"
    expireSecretRefsForTest();
    expect(scrubSecrets(`x ${COOKIE}`)).toBe(`x ${secretPlaceholder(N.cookie)}`);
    expect(scrubSecrets(`y ${FTP_PASS}`)).toBe(`y ${secretPlaceholder(N.ftp)}`);
    expect(warned()).toBe(1);
    // Recovery: a fresh database builds again and ends the episode…
    seed();
    expect(scrubSecrets(`x ${COOKIE}`)).toBe(`x ${secretPlaceholder(N.cookie)}`);
    // …so the next failure warns again.
    db.close();
    expireSecretRefsForTest();
    expect(scrubSecrets(`x ${COOKIE}`)).toBe(`x ${secretPlaceholder(N.cookie)}`);
    expect(warned()).toBe(2);
  });

  it("audit R5 S5: a build error after a store WRITE (dirty since the last good index) fails closed; the recovery is logged once", () => {
    expect(scrubSecrets(`x ${COOKIE}`)).toBe(`x ${secretPlaceholder(N.cookie)}`);
    logInfo.mockClear(); // a previous test's episode may have just recovered
    logWarn.mockClear();
    db.close(); // "The database connection is not open"
    invalidateSecretRefs(); // a writer ran: the last good index is stale
    expect(() => scrubSecrets(`x ${COOKIE}`)).toThrow(/not open/);
    expect(() => scrubSecrets(`x ${COOKIE}`)).toThrow(/not open/);
    expect(
      logWarn.mock.calls.filter((c) => String(c[1]).includes("failing closed")),
    ).toHaveLength(1);
    // A good build clears the flag and logs the recovery once.
    seed();
    expect(scrubSecrets(`x ${COOKIE}`)).toBe(`x ${secretPlaceholder(N.cookie)}`);
    expireSecretRefsForTest(); // a second good build must not log again
    expect(scrubSecrets(`y ${COOKIE}`)).toBe(`y ${secretPlaceholder(N.cookie)}`);
    expect(
      logInfo.mock.calls.filter((c) => String(c[0]).includes("recovered")),
    ).toHaveLength(1);
    // After that good build, a TTL-only failure may use it again.
    db.close();
    expireSecretRefsForTest();
    expect(scrubSecrets(`x ${COOKIE}`)).toBe(`x ${secretPlaceholder(N.cookie)}`);
  });

  it("any other database error with NO last-good index is rethrown, so the scrub and the tool seam fail closed", async () => {
    db.close(); // "The database connection is not open"
    resetSecretRefsForTest();
    expect(() => scrubSecrets(`x ${COOKIE}`)).toThrow(/not open/);
    const reg = new ToolRegistry();
    const execute = vi.fn(async () => `out ${COOKIE}`);
    const tool: Tool = {
      name: "browser__goto",
      definition: {
        type: "function",
        function: {
          name: "browser__goto",
          description: "echo",
          parameters: { type: "object", properties: {} },
        },
      },
      execute,
    };
    reg.register(tool);
    await expect(reg.execute("browser__goto", {})).rejects.toThrow(/not open/);
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

  it("audit R3 N1: a non-string result does not throw; an object's strings are scrubbed, its shape kept", async () => {
    const reg = new ToolRegistry();
    const results: unknown[] = [
      undefined,
      null,
      42,
      { out: `pw=${FTP_PASS}`, rows: [{ k: API_TOKEN }], n: 1 },
    ];
    const t: Tool = {
      ...echoTool("mcp__demo__thing"),
      execute: (async () => results.shift()) as unknown as Tool["execute"],
    };
    reg.register(t);
    await expect(reg.execute("mcp__demo__thing", {})).resolves.toBeUndefined();
    await expect(reg.execute("mcp__demo__thing", {})).resolves.toBeNull();
    await expect(reg.execute("mcp__demo__thing", {})).resolves.toBe(42);
    const obj = (await reg.execute("mcp__demo__thing", {})) as unknown;
    expect(JSON.stringify(obj)).not.toContain(FTP_PASS);
    expect(JSON.stringify(obj)).not.toContain(API_TOKEN);
    expect(obj).toEqual({
      out: `pw=${secretPlaceholder(N.ftp)}`,
      rows: [{ k: secretPlaceholder(N.tok) }],
      n: 1,
    });
  });

  it("audit R4 S4: when the scrubbed JSON no longer parses, the model gets the scrubbed TEXT, never the original object", async () => {
    // A stored value that is itself a JSON fragment: its raw form spans the
    // serialization's punctuation, so replacing it breaks the JSON.
    const FRAG = '1,"' + "q".repeat(8);
    fact("projects", "acme_frag_password", FRAG);
    invalidateSecretRefs();
    const reg = new ToolRegistry();
    const t: Tool = {
      ...echoTool("mcp__demo__frag"),
      execute: (async () => ({
        a: 1,
        ["q".repeat(8)]: 2,
      })) as unknown as Tool["execute"],
    };
    reg.register(t);
    const out = (await reg.execute("mcp__demo__frag", {})) as unknown;
    expect(typeof out).toBe("string");
    expect(out as string).not.toContain(FRAG);
    expect(out as string).toContain(
      secretPlaceholder("SECRET_PROJECTS_ACME_FRAG_PASSWORD"),
    );
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

  it("an error with a read-only message (DOMException) carrying no secret is rethrown untouched (same object, same type)", async () => {
    // Pins the early return: without it the read-only message assignment
    // fails and a clean DOMException is swapped for a plain Error.
    const reg = new ToolRegistry();
    const original = new DOMException("selector sin datos sensibles", "SyntaxError");
    reg.register({
      ...echoTool("browser__goto"),
      execute: async () => {
        throw original;
      },
    });
    const err = await reg.execute("browser__goto", {}).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBe(original);
    expect(err).toBeInstanceOf(DOMException);
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

describe("audit R6 B1 — credenciales_de_acceso is a container (index and display)", () => {
  it("usuario and host stay visible and unscrubbed; contrasena is hidden", () => {
    const EMAIL6 = ["operador", "example.com"].join("@");
    const HOST6 = "ftp.example.com";
    const PASS6 = "ca-" + "k".repeat(14);
    const credentials = {
      credenciales_de_acceso: { usuario: EMAIL6, host: HOST6, contrasena: PASS6 },
    };
    project("acme-acc", { credentials });
    invalidateSecretRefs();
    const leaves = projectEntryLeaves(
      "acme-acc",
      "credentials",
      "credenciales_de_acceso",
      credentials.credenciales_de_acceso,
    );
    const byPath = new Map(leaves.map((l) => [l.path.join("."), l]));
    for (const [k, v] of [["usuario", EMAIL6], ["host", HOST6]] as const) {
      const leaf = byPath.get(`credenciales_de_acceso.${k}`)!;
      expect(leaf.secret, k).toBe(false);
      expect(leaf.display).toBe(v);
      expect(scrubSecrets(`x ${v} y`)).toBe(`x ${v} y`);
    }
    const pw = byPath.get("credenciales_de_acceso.contrasena")!;
    expect(pw.secret).toBe(true);
    expect(scrubSecrets(PASS6)).toBe(
      secretPlaceholder("SECRET_ACME_ACC_CREDENCIALES_DE_ACCESO_CONTRASENA"),
    );
  });
});

describe("audit R6 B3 — scrubJsonText scrubs object KEYS", () => {
  it('{"map":{"<S>":"v"},"note":"<S>"} → no <S> anywhere', () => {
    const text = JSON.stringify({ map: { [FTP_PASS]: "v" }, note: FTP_PASS });
    const out = scrubJsonText(text);
    expect(out).not.toContain(FTP_PASS);
    expect(JSON.parse(out)).toEqual({
      map: { [secretPlaceholder(N.ftp)]: "v" },
      note: secretPlaceholder(N.ftp),
    });
    // A secret only in a key changes the object too.
    const onlyKey = { [API_TOKEN]: 1 };
    const clean = scrubStructured(onlyKey) as Record<string, unknown>;
    expect(clean).not.toBe(onlyKey);
    expect(Object.keys(clean)).toEqual([secretPlaceholder(N.tok)]);
  });
});

describe("audit R6 should-fix 5 — a null build keeps the dirty flag", () => {
  it("after a store write, a build with no database does not license a later fallback to the stale last-good index", () => {
    expect(scrubSecrets(`x ${COOKIE}`)).toBe(`x ${secretPlaceholder(N.cookie)}`); // lastGood
    invalidateSecretRefs(); // a writer ran
    dbThrows = true; // getDatabase throws → buildIndex returns null
    expect(scrubSecrets("nada")).toBe("nada");
    dbThrows = false;
    db.close(); // the next build errors
    expireSecretRefsForTest();
    expect(() => scrubSecrets(`x ${COOKIE}`)).toThrow(/not open/);
  });
});

describe("audit R6 B2 — a rendered placeholder written back through a tool", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "r6-b2-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  function seam() {
    const reg = new ToolRegistry();
    reg.register(fileReadTool);
    reg.register(fileWriteTool);
    reg.register(fileEditTool);
    return reg;
  }
  function echo(name: string, readOnlyHint?: boolean): Tool {
    return {
      name,
      ...(readOnlyHint !== undefined && { readOnlyHint }),
      definition: {
        type: "function",
        function: {
          name,
          description: "echo",
          parameters: { type: "object", properties: {} },
        },
      },
      execute: vi.fn(async (a: Record<string, unknown>) => JSON.stringify({ got: a })),
    };
  }

  it("read (scrubbed) → file_write round trip keeps the real value on disk", async () => {
    const reg = seam();
    const path = join(dir, "app.env");
    const original = `HOST=ftp.example.com\nFTP_PASSWORD=${FTP_PASS}\nTOKEN=${API_TOKEN}\n`;
    writeFileSync(path, original);
    const read = JSON.parse(await reg.execute("file_read", { path }));
    expect(read.content).not.toContain(FTP_PASS);
    expect(read.content).toContain(secretPlaceholder(N.ftp));
    // The model edits one visible line and writes the whole file back.
    const edited = (read.content as string).replace("ftp.example.com", "ftp2.example.com");
    const args = { path, content: edited };
    const out = JSON.parse(await reg.execute("file_write", args));
    expect(out.error).toBeUndefined();
    expect(readFs(path, "utf8")).toBe(original.replace("ftp.example.com", "ftp2.example.com"));
    // The caller's args (what recorders hold) keep the placeholder.
    expect(args.content).toContain(secretPlaceholder(N.ftp));
  });

  it("file_edit with old_string spanning a placeholder line matches the real file", async () => {
    const reg = seam();
    const path = join(dir, "app.env");
    writeFileSync(path, `A=1\nFTP_PASSWORD=${FTP_PASS}\nB=2\n`);
    const read = JSON.parse(await reg.execute("file_read", { path }));
    const line = (read.content as string).split("\n")[1]!;
    expect(line).toBe(`FTP_PASSWORD=${secretPlaceholder(N.ftp)}`);
    const out = JSON.parse(
      await reg.execute("file_edit", {
        path,
        old_string: `A=1\n${line}`,
        new_string: `A=9\n${line}`,
      }),
    );
    expect(out.error).toBeUndefined();
    expect(readFs(path, "utf8")).toBe(`A=9\nFTP_PASSWORD=${FTP_PASS}\nB=2\n`);
  });

  it("an unknown name, the generic placeholder, a mangled one, or one outside a content field refuses the file write", async () => {
    const reg = seam();
    const path = join(dir, "x.txt");
    for (const content of [
      `k=${secretPlaceholder("SECRET_NOT_STORED")}`,
      `k=${CREDENTIAL_FACT_PLACEHOLDER}`,
      `k=${secretPlaceholder(N.ftp).slice(0, 30)}`,
    ]) {
      const out = JSON.parse(await reg.execute("file_write", { path, content }));
      expect(out.error, content).toMatch(/^No ejecuté file_write/);
    }
    const tool = echo("jarvis_files_batch_write");
    reg.register(tool);
    const out = JSON.parse(
      await reg.execute("jarvis_files_batch_write", {
        files: [{ path: `notes/${secretPlaceholder(N.ftp)}.md`, content: "x" }],
      }),
    );
    expect(out.error).toMatch(/^No ejecuté/);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("jarvis_files_batch_write resolves files[].content", async () => {
    const reg = new ToolRegistry();
    const tool = echo("jarvis_files_batch_write");
    reg.register(tool);
    await reg.execute("jarvis_files_batch_write", {
      files: [{ path: "notes/a.md", content: `pw: ${secretPlaceholder(N.ftp)}` }],
    });
    expect(vi.mocked(tool.execute).mock.calls[0]![0]).toEqual({
      files: [{ path: "notes/a.md", content: `pw: ${FTP_PASS}` }],
    });
  });

  it("shell_exec / http_fetch / any other write tool with a rendered placeholder is refused before running", async () => {
    const reg = new ToolRegistry();
    for (const [name, args] of [
      ["shell_exec", { command: `curl -u me:${secretPlaceholder(N.ftp)} ftp://ftp.example.com` }],
      ["http_fetch", { url: "https://api.example.com", headers: { Authorization: secretPlaceholder(N.tok) } }],
      ["gmail_send", { body: `clave: ${CREDENTIAL_FACT_PLACEHOLDER}` }],
    ] as const) {
      const tool = echo(name);
      reg.register(tool);
      const out = JSON.parse(await reg.execute(name, { ...args }));
      expect(out.error, name).toMatch(/^No ejecuté/);
      expect(out.error).toContain("$SECRET_<NOMBRE>");
      expect(out.error).toContain("{{SECRET_<NOMBRE>}}");
      expect(tool.execute, name).not.toHaveBeenCalled();
    }
  });

  it("a read-only tool and the store tools (own resolution) pass a placeholder through", async () => {
    const reg = new ToolRegistry();
    for (const [name, ro] of [["memory_search", true], ["user_fact_set", false], ["project_update", false]] as const) {
      const tool = echo(name, ro);
      reg.register(tool);
      const args = { value: secretPlaceholder(N.ftp) };
      await reg.execute(name, args);
      expect(vi.mocked(tool.execute).mock.calls[0]![0], name).toEqual(args);
    }
  });
});

// Audit round 7 — probes ported from the auditor's probe-r7.test.ts.
describe("audit R7 B-1 — no value prefix through a file reader's cut; no file_edit oracle", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "r7-b1-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  function seam() {
    const reg = new ToolRegistry();
    reg.register(fileReadTool);
    reg.register(fileWriteTool);
    reg.register(fileEditTool);
    return reg;
  }
  const PREFIX3 = FTP_PASS.slice(0, 4); // "pw-z"

  it("P1: a placeholder written at the preview edge shows no prefix of the value in file_read's preview", async () => {
    const reg = seam();
    const path = join(dir, "x.md");
    const pad = "a".repeat(1500 - (FTP_PASS.length - 1));
    const content = pad + secretPlaceholder(N.ftp) + "\n" + "b".repeat(9000);
    const w = JSON.parse(await reg.execute("file_write", { path, content }));
    expect(w.error).toBeUndefined();
    expect(readFs(path, "utf8")).toContain(FTP_PASS); // the write-back works
    const read = JSON.parse(await reg.execute("file_read", { path }));
    expect(read.truncated).toBe(true);
    expect(read.preview).not.toContain(PREFIX3);
    expect(JSON.stringify(read)).not.toContain(PREFIX3);
  });

  it("P3: a value at the outline snippet edge is not cut into the outline", async () => {
    const reg = seam();
    const path = join(dir, "z.md");
    const line =
      "- [12:00:00] **J**: c " + "k".repeat(60 - 2 - (FTP_PASS.length - 1)) + secretPlaceholder(N.ftp);
    await reg.execute("file_write", { path, content: line + "\n" + "q".repeat(9000) });
    expect(readFs(path, "utf8")).toContain(FTP_PASS);
    const read = JSON.parse(await reg.execute("file_read", { path }));
    expect(JSON.stringify(read.outline)).not.toContain(PREFIX3);
  });

  it("the MAX_READ cap of a lines slice does not cut a value", async () => {
    const reg = seam();
    const path = join(dir, "big.txt");
    writeFileSync(path, "c".repeat(50_000 - 5) + FTP_PASS + "\n");
    const read = JSON.parse(await reg.execute("file_read", { path, lines: "1" }));
    expect(read.slice_capped).toBe(true);
    expect(read.content).not.toContain(PREFIX3);
  });

  it("P2: file_edit gives the same answer for every prefix guess as for a wrong guess (no oracle)", async () => {
    const reg = seam();
    const path = join(dir, "y.env");
    await reg.execute("file_write", { path, content: `FTP_PASSWORD=${secretPlaceholder(N.ftp)}\n` });
    expect(readFs(path, "utf8")).toBe(`FTP_PASSWORD=${FTP_PASS}\n`);
    const wrong = await reg.execute("file_edit", {
      path,
      old_string: "FTP_PASSWORD=#",
      new_string: "FTP_PASSWORD=#!",
    });
    expect(JSON.parse(wrong).error).toMatch(/not found/);
    for (let k = 1; k < FTP_PASS.length; k++) {
      const out = await reg.execute("file_edit", {
        path,
        old_string: "FTP_PASSWORD=" + FTP_PASS.slice(0, k),
        new_string: "X",
      });
      expect(out, `prefix ${k}`).toBe(wrong);
    }
    // A guess inside the value (no visible context) is not a match either.
    const inner = await reg.execute("file_edit", {
      path,
      old_string: FTP_PASS.slice(2, 9),
      new_string: "X",
    });
    expect(JSON.parse(inner).error).toMatch(/not found/);
    expect(readFs(path, "utf8")).toBe(`FTP_PASSWORD=${FTP_PASS}\n`);
    // The whole value (by its placeholder) still edits.
    const ok = JSON.parse(
      await reg.execute("file_edit", {
        path,
        old_string: `FTP_PASSWORD=${secretPlaceholder(N.ftp)}`,
        new_string: `FTP_PASS=${secretPlaceholder(N.ftp)}`,
      }),
    );
    expect(ok.error).toBeUndefined();
    expect(readFs(path, "utf8")).toBe(`FTP_PASS=${FTP_PASS}\n`);
  });

  it("file_edit replace_all skips matches that cut into a value and keeps the others", async () => {
    const reg = seam();
    const path = join(dir, "r.txt");
    writeFileSync(path, `pw-z here; ${FTP_PASS}; pw-z there\n`);
    const out = JSON.parse(
      await reg.execute("file_edit", { path, old_string: "pw-z", new_string: "PW", replace_all: true }),
    );
    expect(out.replacements).toBe(2);
    expect(readFs(path, "utf8")).toBe(`PW here; ${FTP_PASS}; PW there\n`);
  });
});

describe("audit R7 B-4 — an encoded value round-trips in its own form", () => {
  let dir: string;
  const URL_PASS = "p@ss/" + "w".repeat(10);
  const JSON_PASS = 'jv-"' + "k".repeat(10) + "\\x";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "r7-b4-"));
    fact("projects", "acme_db_password", URL_PASS);
    fact("projects", "acme_json_password", JSON_PASS);
    invalidateSecretRefs();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  function seam() {
    const reg = new ToolRegistry();
    reg.register(fileReadTool);
    reg.register(fileWriteTool);
    reg.register(fileEditTool);
    return reg;
  }
  const DB = "SECRET_PROJECTS_ACME_DB_PASSWORD";
  const JS = "SECRET_PROJECTS_ACME_JSON_PASSWORD";

  it("P4: a URL-encoded value is shown with a URL-form placeholder and written back URL-encoded", async () => {
    const reg = seam();
    const path = join(dir, "app.conf");
    const orig = `DATABASE_URL=postgres://app:${encodeURIComponent(URL_PASS)}@db.example.com/x\nRAW=${URL_PASS}\n`;
    writeFileSync(path, orig);
    const read = JSON.parse(await reg.execute("file_read", { path }));
    expect(read.content).not.toContain(encodeURIComponent(URL_PASS));
    expect(read.content).not.toContain(URL_PASS);
    expect(read.content).toContain(secretPlaceholder(DB, "url"));
    expect(read.content).toContain(`RAW=${secretPlaceholder(DB)}`);
    const out = JSON.parse(
      await reg.execute("file_write", { path, content: (read.content as string) + "X=1\n" }),
    );
    expect(out.error).toBeUndefined();
    expect(readFs(path, "utf8")).toBe(orig + "X=1\n");
  });

  it("a JSON-escaped value is shown with a JSON-form placeholder and written back escaped", async () => {
    const reg = seam();
    const path = join(dir, "app.json");
    const orig = JSON.stringify({ password: JSON_PASS, n: 1 }, null, 2) + "\n";
    expect(orig).toContain(encodeSecretForm(JSON_PASS, "json"));
    writeFileSync(path, orig);
    const read = JSON.parse(await reg.execute("file_read", { path }));
    expect(read.content).toContain(secretPlaceholder(JS, "json"));
    const edited = (read.content as string).replace('"n": 1', '"n": 2');
    const out = JSON.parse(await reg.execute("file_write", { path, content: edited }));
    expect(out.error).toBeUndefined();
    expect(readFs(path, "utf8")).toBe(orig.replace('"n": 1', '"n": 2'));
    expect(JSON.parse(readFs(path, "utf8")).password).toBe(JSON_PASS);
  });

  it("a raw value with a quote in a plain file is shown with the RAW placeholder (the JSON result is scrubbed structurally)", async () => {
    const reg = seam();
    const path = join(dir, "plain.env");
    const orig = `PW=${JSON_PASS}\n`;
    writeFileSync(path, orig);
    const read = JSON.parse(await reg.execute("file_read", { path }));
    expect(read.content).toBe(`PW=${secretPlaceholder(JS)}\n`);
    await reg.execute("file_write", { path, content: read.content });
    expect(readFs(path, "utf8")).toBe(orig);
  });

  it("the seam's JSON-aware scrub tags a leaf by its decoded form", () => {
    const tool: Tool = {
      name: "echo_raw",
      readOnlyHint: true,
      definition: { type: "function", function: { name: "echo_raw", description: "e", parameters: { type: "object", properties: {} } } },
      execute: async () => JSON.stringify({ a: `x ${JSON_PASS} y` }),
    };
    const reg = new ToolRegistry();
    reg.register(tool);
    return reg.execute("echo_raw", {}).then((out) => {
      expect(JSON.parse(out).a).toBe(`x ${secretPlaceholder(JS)} y`);
    });
  });
});

describe("audit R7 should-fix — placeholder in object keys; scrubStructured key collisions", () => {
  it("a placeholder in an object KEY refuses a write tool and a file tool", () => {
    const ph = secretPlaceholder(N.ftp);
    const a = resolveRenderedPlaceholders("gmail_send", { [ph]: "x" }, false);
    expect("error" in a && a.error).toMatch(/^\{"error":"No ejecuté gmail_send/);
    const b = resolveRenderedPlaceholders("file_write", { path: "/tmp/a", content: { [ph]: "x" } }, false);
    expect("error" in b && b.error).toMatch(/nombre de un campo/);
    // A read-only tool still passes (it sends nothing anywhere).
    const c = resolveRenderedPlaceholders("memory_search", { [ph]: "x" }, true);
    expect("args" in c).toBe(true);
  });

  it("two keys that scrub to the same placeholder are both kept", () => {
    const ph = secretPlaceholder(N.ftp);
    const out = scrubStructured({ [ph]: 1, [FTP_PASS]: 2 }) as Record<string, unknown>;
    expect(Object.values(out).sort()).toEqual([1, 2]);
    expect(Object.keys(out)).toEqual([ph, `${ph} (2)`]);
    expect(JSON.stringify(out)).not.toContain(FTP_PASS);
  });
});

describe("audit R7 B-1 — data_summarize scrubs the whole text before splitting it", () => {
  it("a stored value containing the delimiter is not split into visible pieces", async () => {
    const COMMA_PASS = "cv-" + "h".repeat(8) + "," + "j".repeat(8);
    fact("projects", "acme_csv_password", COMMA_PASS);
    invalidateSecretRefs();
    const reg = new ToolRegistry();
    reg.register(dataSummarizeTool);
    const out = await reg.execute("data_summarize", {
      text: `name,pw,extra\nacme,${COMMA_PASS}\nbeta,x,y\n`,
    });
    expect(out).not.toContain("h".repeat(8));
    expect(out).not.toContain("j".repeat(8));
  });
});
