/**
 * S6 WS3 — the manager against REAL stdio children (not the mocked SDK of
 * manager.test.ts): a synthetic server script under TMPDIR reports its own
 * env KEYS and cwd, so the names-only env and the cwd are observed from the
 * child. Synthetic values only; no server from mcp-servers.json is spawned.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { closeDatabase, initDatabase } from "../db/index.js";
import { createProject, updateProject } from "../db/projects.js";
import { getDatabase } from "../db/index.js";
import { cachedProjectStatus, invalidateProjectStatus } from "../lib/project-status-cache.js";
import { getToolAnnotations } from "../tools/types.js";
import { resetSecretRefsForTest } from "../lib/secret-refs.js";
import { ToolRegistry } from "../tools/registry.js";
import { McpManager, buildSpawnEnv } from "./manager.js";
import type { McpServerConfig } from "./types.js";

/** A newline-delimited JSON-RPC MCP server with no dependencies. */
const SERVER = String.raw`
const readline = require("node:readline");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const text = (t) => ({ content: [{ type: "text", text: t }] });
const TOOLS = [
  { name: "env_keys", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "where", inputSchema: { type: "object", properties: {} } },
  { name: "env_eq", inputSchema: { type: "object", properties: { name: { type: "string" }, expected: { type: "string" } } } },
  { name: "goto", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: false, destructiveHint: true } },
];
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const req = JSON.parse(line);
  if (req.id === undefined) return;
  if (req.method === "initialize") {
    return send({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: req.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "synthetic", version: "1.0.0" } } });
  }
  if (req.method === "tools/list") return send({ jsonrpc: "2.0", id: req.id, result: { tools: TOOLS } });
  if (req.method === "tools/call") {
    const a = req.params.arguments || {};
    const t = req.params.name === "env_keys" ? JSON.stringify(Object.keys(process.env).sort())
      : req.params.name === "where" ? process.cwd()
      : req.params.name === "goto" ? "went"
      : String(process.env[a.name] === a.expected);
    return send({ jsonrpc: "2.0", id: req.id, result: text(t) });
  }
  send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "no such method" } });
});
`;

let dir: string;
let script: string;
let manager: McpManager | null = null;
const SYNTHETIC_TOKEN = "syn-" + "q".repeat(24);

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mc-mcp-env-")));
  script = join(dir, "server.cjs");
  writeFileSync(script, SERVER);
  mkdirSync(join(dir, "repo", "srv"), { recursive: true });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  process.env.MC_CANARY_SECRET = "x";
  process.env.SYN_DECLARED_NAME = "declared";
  initDatabase(":memory:");
  resetSecretRefsForTest();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  await manager?.shutdown();
  manager = null;
  delete process.env.MC_CANARY_SECRET;
  delete process.env.SYN_DECLARED_NAME;
  delete process.env.ACME_API_TOKEN;
  for (const slug of ["acme", "other", "beta-proj"]) invalidateProjectStatus(slug);
  closeDatabase();
  resetSecretRefsForTest();
  vi.restoreAllMocks();
});

async function boot(id: string, config: McpServerConfig): Promise<ToolRegistry> {
  const registry = new ToolRegistry();
  manager = new McpManager();
  await manager.init({ [id]: config }, registry);
  return registry;
}

/** Bare "NAME" record entries as the loader normalises them. */
const refs = (...names: string[]) => names.map((name) => ({ name, secret: `SECRET_${name}` }));

const call = (r: ToolRegistry, name: string, args: Record<string, unknown> = {}) =>
  r.get(name)!.execute(args);

describe("spawn env is the SDK default env + declared names only", () => {
  it("service server: env object applied, envNames passed through, the service env is NOT inherited", async () => {
    const r = await boot("svc", {
      command: process.execPath,
      args: [script],
      env: { FIXED_SETTING: "1" },
      envNames: ["SYN_DECLARED_NAME"],
      source: { kind: "service" },
    });
    const keys = JSON.parse(await call(r, "svc__env_keys")) as string[];
    expect(keys).not.toContain("MC_CANARY_SECRET");
    expect(keys).toContain("SYN_DECLARED_NAME");
    expect(keys).toContain("FIXED_SETTING");
    const allowed = new Set([...Object.keys(getDefaultEnvironment()), "SYN_DECLARED_NAME", "FIXED_SETTING"]);
    // Node/the OS may add a few of its own at exec; none is a parent-only name.
    expect(keys.filter((k) => !allowed.has(k) && k in process.env && k !== "PWD" && k !== "SHLVL" && k !== "_")).toEqual([]);
    expect(await call(r, "svc__env_eq", { name: "SYN_DECLARED_NAME", expected: "declared" })).toBe("true");
  });

  it("a service server with no env declarations still gets no service env", async () => {
    const r = await boot("bare", { command: process.execPath, args: [script], source: { kind: "service" } });
    expect(JSON.parse(await call(r, "bare__env_keys"))).not.toContain("MC_CANARY_SECRET");
  });

  it("record server: cwd honoured; a name resolves from the row's own credentials via SECRET_<NAME>; any other name is omitted (secrets only)", async () => {
    createProject("acme", "Acme", { status: "active", credentials: { api_token: SYNTHETIC_TOKEN } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await boot("acme", {
      command: process.execPath,
      args: [script],
      cwd: join(dir, "repo", "srv"),
      envSpec: refs("ACME_API_TOKEN", "SYN_DECLARED_NAME", "ACME_MISSING"),
      env: { IGNORED_FOR_RECORDS: "1" },
      source: { kind: "record", slug: "acme", trusted: true, secrets: ["SECRET_ACME_API_TOKEN"] },
    });
    expect(await call(r, "acme__where")).toBe(join(dir, "repo", "srv"));
    expect(await call(r, "acme__env_eq", { name: "ACME_API_TOKEN", expected: SYNTHETIC_TOKEN })).toBe("true");
    const keys = JSON.parse(await call(r, "acme__env_keys")) as string[];
    // in the service env but not in the record's secrets → never reaches the child (audit R2 W2)
    expect(keys).not.toContain("SYN_DECLARED_NAME");
    expect(keys).not.toContain("ACME_MISSING");
    expect(keys).not.toContain("IGNORED_FOR_RECORDS");
    expect(keys).not.toContain("MC_CANARY_SECRET");
    const msgs = warn.mock.calls.map((c) => String(c[0]));
    expect(msgs).toContain("[mcp] acme: env SYN_DECLARED_NAME is not in project acme's secrets (SECRET_SYN_DECLARED_NAME); omitted");
    expect(msgs).toContain("[mcp] acme: env ACME_MISSING is not in project acme's secrets (SECRET_ACME_MISSING); omitted");
    expect(msgs.join("\n")).not.toContain(SYNTHETIC_TOKEN);
  });

  it("a credential is used only when the record lists its SECRET_ name, and only from its own project", async () => {
    createProject("acme", "Acme", { status: "active", credentials: { api_token: SYNTHETIC_TOKEN } });
    createProject("other", "Other", { status: "active" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await boot("other", {
      command: process.execPath,
      args: [script],
      envSpec: refs("ACME_API_TOKEN"),
      // names the other project's credential: not its own → not resolved
      source: { kind: "record", slug: "other", trusted: true, secrets: ["SECRET_ACME_API_TOKEN"] },
    });
    expect(JSON.parse(await call(r, "other__env_keys"))).not.toContain("ACME_API_TOKEN");
  });
});

describe("record trust, status and the deferred-head rule", () => {
  it("an untrusted record server is not spawned (one warn naming slug + id)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await boot("beta", {
      command: process.execPath,
      args: [script],
      source: { kind: "record", slug: "beta-proj", trusted: false },
    });
    expect(manager!.getServerIds()).toEqual([]);
    expect(r.list().filter((n) => n.startsWith("beta__"))).toEqual([]);
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      "[mcp] beta: not loaded — record beta-proj is not trusted",
    ]);
  });

  it("a project that leaves `active` is refused at call time (status cached ≤ 60 s)", async () => {
    createProject("acme", "Acme", { status: "active" });
    const r = await boot("acme", {
      command: process.execPath,
      args: [script],
      source: { kind: "record", slug: "acme", trusted: true },
    });
    expect(await call(r, "acme__where")).not.toContain("error");
    // a write that bypasses updateProject: only the TTL brings the change in
    getDatabase().prepare("UPDATE projects SET status = 'paused' WHERE slug = 'acme'").run();
    expect(await call(r, "acme__where")).not.toContain("error");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    expect(JSON.parse(await call(r, "acme__where"))).toEqual({
      error: "project acme is paused; its server is unloaded at the next restart",
    });
  });

  it("updateProject on a status change invalidates the cache: the next call is refused at once", async () => {
    createProject("acme", "Acme", { status: "active" });
    const r = await boot("acme", {
      command: process.execPath,
      args: [script],
      source: { kind: "record", slug: "acme", trusted: true },
    });
    expect(await call(r, "acme__where")).not.toContain("error");
    updateProject("acme", { status: "archived" });
    expect(JSON.parse(await call(r, "acme__where"))).toEqual({
      error: "project acme is archived; its server is unloaded at the next restart",
    });
  });

  it("the reconnect loop does not respawn a record server whose project left active (one warn)", async () => {
    createProject("acme", "Acme", { status: "active" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await boot("acme", {
      command: join(dir, "no-such-binary"),
      source: { kind: "record", slug: "acme", trusted: true },
    });
    expect(manager!.getFailedServerIds()).toEqual(["acme"]);
    updateProject("acme", { status: "paused" });
    warn.mockClear();
    await (manager as unknown as { reconnectTick(r: ToolRegistry): Promise<void> }).reconnectTick(r);
    expect(manager!.getFailedServerIds()).toEqual([]);
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      "[mcp] acme: not reconnected — project acme is paused; unloaded until restart",
    ]);
  });

  it("an unreadable status keeps the server in the failed set; it respawns on the next tick (audit R2 W3)", async () => {
    createProject("acme", "Acme", { status: "active" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const late = join(dir, "late-server.cjs");
    const r = await boot("acme", {
      command: process.execPath,
      args: [late], // missing at boot → the connect fails
      source: { kind: "record", slug: "acme", trusted: true },
    });
    expect(manager!.getFailedServerIds()).toEqual(["acme"]);
    copyFileSync(script, late);
    const m = manager as unknown as {
      reconnectTick(r: ToolRegistry): Promise<void>;
      currentProjectStatus(slug: string): string;
    };
    let reads = 0;
    m.currentProjectStatus = () => {
      if (reads++ === 0) throw new Error("SQLITE_BUSY: database is locked");
      return "active";
    };
    warn.mockClear();
    await m.reconnectTick(r);
    expect(manager!.getFailedServerIds()).toEqual(["acme"]);
    expect(r.get("acme__where")).toBeUndefined();
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      "[mcp] acme: project acme status unreadable (SQLITE_BUSY: database is locked); retrying next tick",
    ]);
    await m.reconnectTick(r);
    expect(manager!.getFailedServerIds()).toEqual([]);
    expect(await call(r, "acme__where")).not.toContain("error");
  });

  it("server annotations reach the registered tool; a record that defers every tool keeps the first eager", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await boot("acme", {
      command: process.execPath,
      args: [script],
      deferredTools: ["env_keys", "where", "env_eq", "goto"],
      source: { kind: "record", slug: "acme", trusted: true },
    });
    expect(r.get("acme__env_keys")!.deferred).toBe(false);
    expect(r.get("acme__where")!.deferred).toBe(true);
    expect(r.get("acme__env_keys")!.readOnlyHint).toBe(true);
    expect(r.get("acme__env_keys")!.destructiveHint).toBe(false);
    // a service server keeps its deferral list as written
    await manager!.shutdown();
    const r2 = await boot("svc", {
      command: process.execPath,
      args: [script],
      deferredTools: ["env_keys", "where", "env_eq", "goto"],
      source: { kind: "service" },
    });
    expect(r2.get("svc__env_keys")!.deferred).toBe(true);
  });
});

describe("audit R3 — boot summary line", () => {
  const summary = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("tools registered"));

  it("no record servers → the line is unchanged", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await boot("svc", { command: process.execPath, args: [script], source: { kind: "service" } });
    expect(summary(log)).toEqual(["[mcp] 1/1 servers, 4 tools registered"]);
  });

  it("record servers → `<n> from records` is added", async () => {
    createProject("acme", "Acme", { status: "active" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await boot("acme", {
      command: process.execPath,
      args: [script],
      source: { kind: "record", slug: "acme", trusted: true },
    });
    expect(summary(log)).toEqual(["[mcp] 1/1 servers, 1 from records, 4 tools registered"]);
  });
});

describe("audit R1 W1 — server annotations apply to RECORD servers only", () => {
  it("service: curated/pattern hints win (annotations ignored); record: annotations win", async () => {
    const svc = await boot("svc", { command: process.execPath, args: [script], source: { kind: "service" } });
    // `goto` is READ_ONLY in the curated table; the server says rw + destructive
    expect(getToolAnnotations(svc.get("svc__goto")!)).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    // `env_keys` is unknown to the table: the server's readOnly is NOT taken → conservative default
    expect(getToolAnnotations(svc.get("svc__env_keys")!)).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    await manager!.shutdown();
    const rec = await boot("acme", {
      command: process.execPath,
      args: [script],
      source: { kind: "record", slug: "acme", trusted: true },
    });
    expect(getToolAnnotations(rec.get("acme__goto")!)).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(getToolAnnotations(rec.get("acme__env_keys")!)).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it("service lazy proxy and the activated tool agree on hints", async () => {
    const names = ["goto", "env_keys", "where"];
    const r = await boot("svc", {
      command: process.execPath,
      args: [script],
      lazy: true,
      tools: names.map((name) => ({ name, description: name })),
      source: { kind: "service" },
    });
    const before = names.map((n) => getToolAnnotations(r.get(`svc__${n}`)!));
    expect(await call(r, "svc__goto")).toBe("went"); // activates
    const after = names.map((n) => getToolAnnotations(r.get(`svc__${n}`)!));
    expect(after).toEqual(before);
  });
});

describe("WS3a — record env entries reach a real child under the server's own names", () => {
  it("{name, secret} delivers PG_PASSWORD from credential pg_password; {name, value} a literal; a missing ref is never filled from the parent env", async () => {
    createProject("acme", "Acme", {
      status: "active",
      credentials: { pg_password: SYNTHETIC_TOKEN, pg_host: "db.example.test" },
    });
    process.env.PG_SSL = "parent-canary";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await boot("acme", {
        command: process.execPath,
        args: [script],
        envSpec: [
          { name: "PG_PASSWORD", secret: "SECRET_ACME_PG_PASSWORD" },
          { name: "PG_HOST", value: "db.example.test" },
          { name: "PG_SSL", secret: "SECRET_ACME_PG_SSL" }, // listed, no credential
          ...refs("ACME_API_TOKEN"), // string form: unlisted → omitted
        ],
        source: {
          kind: "record",
          slug: "acme",
          trusted: true,
          secrets: ["SECRET_ACME_PG_PASSWORD", "SECRET_ACME_PG_SSL"],
        },
      });
      expect(await call(r, "acme__env_eq", { name: "PG_PASSWORD", expected: SYNTHETIC_TOKEN })).toBe("true");
      expect(await call(r, "acme__env_eq", { name: "PG_HOST", expected: "db.example.test" })).toBe("true");
      const keys = JSON.parse(await call(r, "acme__env_keys")) as string[];
      expect(keys).not.toContain("PG_SSL");
      expect(keys).not.toContain("ACME_API_TOKEN");
      const msgs = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(msgs).toContain("[mcp] acme: env PG_SSL — SECRET_ACME_PG_SSL has no credential in project acme; omitted");
      expect(msgs).not.toContain(SYNTHETIC_TOKEN);
      expect(msgs).not.toContain("parent-canary");
    } finally {
      delete process.env.PG_SSL;
    }
  });

  it("string entries still resolve through SECRET_<NAME> when listed", async () => {
    createProject("acme", "Acme", { status: "active", credentials: { api_token: SYNTHETIC_TOKEN } });
    const r = await boot("acme", {
      command: process.execPath,
      args: [script],
      envSpec: refs("ACME_API_TOKEN"),
      source: { kind: "record", slug: "acme", trusted: true, secrets: ["SECRET_ACME_API_TOKEN"] },
    });
    expect(await call(r, "acme__env_eq", { name: "ACME_API_TOKEN", expected: SYNTHETIC_TOKEN })).toBe("true");
  });

  it("WS3a R1 W1: a resolved value with a newline or NUL is omitted, warned by name only", () => {
    createProject("acme", "Acme", { status: "active", credentials: { pg_password: "line-one\nline-two" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = buildSpawnEnv("acme-w1", {
      command: "node",
      envSpec: [
        { name: "PG_PASSWORD", secret: "SECRET_ACME_PG_PASSWORD" },
        { name: "SYN_NUL", value: "a\0b" },
        { name: "SYN_OK", value: "fine" },
      ],
      source: { kind: "record", slug: "acme", trusted: true, secrets: ["SECRET_ACME_PG_PASSWORD"] },
    });
    expect(env.PG_PASSWORD).toBeUndefined();
    expect(env.SYN_NUL).toBeUndefined();
    expect(env.SYN_OK).toBe("fine");
    const msgs = warn.mock.calls.map((c) => String(c[0]));
    expect(msgs).toEqual([
      "[mcp] acme-w1: env PG_PASSWORD has a newline or NUL; omitted",
      "[mcp] acme-w1: env SYN_NUL has a newline or NUL; omitted",
    ]);
    expect(msgs.join("\n")).not.toContain("line-one");
  });

  it("a record server ignores envNames and the env object", () => {
    process.env.ACME_API_TOKEN = "service-side-value";
    const env = buildSpawnEnv("acme-ign", {
      command: "node",
      envNames: ["ACME_API_TOKEN"],
      env: { FIXED: "1" },
      source: { kind: "record", slug: "acme", trusted: true },
    });
    expect(Object.keys(env).sort()).toEqual(Object.keys(getDefaultEnvironment()).sort());
  });
});

describe("WS3a R2 W1 — behavioural value pin: no env value reaches any console call", () => {
  it("success and every omit path through the real manager boot; neither canary appears in any captured string", async () => {
    // Runtime-assembled canaries (never a literal in the source).
    const CRED = ["syn", "cred", "canary", "k".repeat(16)].join("-");
    const LIT = ["syn", "lit", "canary", "m".repeat(16)].join("-");
    createProject("acme", "Acme", {
      status: "active",
      credentials: { pg_password: CRED, crlf_password: CRED + "\r\n" + CRED },
    });
    process.env.ACME_API_TOKEN = CRED; // an unlisted bare name must not pull it from the parent
    process.env.PG_SSL = LIT;
    const captured: string[] = [];
    for (const m of ["log", "warn", "error", "info", "debug", "trace"] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a) ?? String(a))).join(" "));
      });
    }
    const r = await boot("canary", {
      command: process.execPath,
      args: [script],
      envSpec: [
        { name: "PG_PASSWORD", secret: "SECRET_ACME_PG_PASSWORD" }, // success (credential)
        { name: "PG_HOST", value: LIT }, // success (literal)
        { name: "PG_CRLF", secret: "SECRET_ACME_CRLF_PASSWORD" }, // credential with \r\n → omitted
        { name: "PG_SSL", secret: "SECRET_ACME_PG_SSL" }, // listed, no credential → omitted
        { name: "SYN_NUL", value: LIT + "\0" }, // literal with NUL → omitted
        ...refs("ACME_API_TOKEN"), // unlisted bare name → omitted
      ],
      source: {
        kind: "record",
        slug: "acme",
        trusted: true,
        secrets: ["SECRET_ACME_PG_PASSWORD", "SECRET_ACME_CRLF_PASSWORD", "SECRET_ACME_PG_SSL"],
      },
    });
    try {
      // The success paths really ran (the child holds both canaries) …
      expect(await call(r, "canary__env_eq", { name: "PG_PASSWORD", expected: CRED })).toBe("true");
      expect(await call(r, "canary__env_eq", { name: "PG_HOST", expected: LIT })).toBe("true");
      const keys = JSON.parse(await call(r, "canary__env_keys")) as string[];
      for (const k of ["PG_CRLF", "PG_SSL", "SYN_NUL", "ACME_API_TOKEN"]) expect(keys).not.toContain(k);
      // … and each omit path warned (by name), each on its own branch.
      const all = captured.join("\n");
      expect(all).toContain("[mcp] canary: env PG_CRLF has a newline or NUL; omitted");
      expect(all).toContain("[mcp] canary: env PG_SSL — SECRET_ACME_PG_SSL has no credential in project acme; omitted");
      expect(all).toContain("[mcp] canary: env SYN_NUL has a newline or NUL; omitted");
      expect(all).toContain("[mcp] canary: env ACME_API_TOKEN is not in project acme's secrets (SECRET_ACME_API_TOKEN); omitted");
      expect(all).not.toContain(CRED);
      expect(all).not.toContain(LIT);
    } finally {
      delete process.env.PG_SSL;
    }
  });
});

describe("audit R1 W3/W4 — record env names (buildSpawnEnv)", () => {
  const rec = (envNames: string[], secrets: string[] = []): McpServerConfig => ({
    command: "node",
    envSpec: refs(...envNames),
    source: { kind: "record", slug: "acme", trusted: true, secrets },
  });

  it("a reserved name never reaches a record child, even when the service env has it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = buildSpawnEnv("acme-w3", rec(["MC_CANARY_SECRET", "NODE_OPTIONS", "lower_case"]));
    expect(Object.keys(env)).not.toContain("MC_CANARY_SECRET");
    expect(Object.keys(env)).not.toContain("NODE_OPTIONS");
    expect(Object.keys(env)).not.toContain("lower_case");
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      "[mcp] acme-w3: env MC_CANARY_SECRET is reserved — omitted",
      "[mcp] acme-w3: env NODE_OPTIONS is reserved — omitted",
      "[mcp] acme-w3: an env name does not match ^[A-Z][A-Z0-9_]*$ — omitted",
    ]);
    // a service server may still name one (operator-owned config)
    expect(buildSpawnEnv("svc", { command: "node", envNames: ["MC_CANARY_SECRET"], source: { kind: "service" } }).MC_CANARY_SECRET).toBe("x");
  });

  it("a listed SECRET_<NAME> with no credential is omitted — never filled from the service env; warned once", () => {
    createProject("acme", "Acme", { status: "active" });
    process.env.ACME_API_TOKEN = "service-side-value";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cfg = rec(["ACME_API_TOKEN"], ["SECRET_ACME_API_TOKEN"]);
    expect(buildSpawnEnv("acme-w4", cfg).ACME_API_TOKEN).toBeUndefined();
    expect(buildSpawnEnv("acme-w4", cfg).ACME_API_TOKEN).toBeUndefined();
    const msgs = warn.mock.calls.map((c) => String(c[0]));
    expect(msgs).toEqual([
      "[mcp] acme-w4: env ACME_API_TOKEN — SECRET_ACME_API_TOKEN has no credential in project acme; omitted",
    ]);
    expect(msgs.join("\n")).not.toContain("service-side-value");
  });

  it("secrets only: a declared name in the service env but not in the record's secrets is absent (audit R2 W2)", () => {
    createProject("acme", "Acme", { status: "active" });
    process.env.ACME_API_TOKEN = "service-side-value";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = buildSpawnEnv("acme-r2", rec(["ACME_API_TOKEN", "SYN_DECLARED_NAME"]));
    expect(env.ACME_API_TOKEN).toBeUndefined();
    expect(env.SYN_DECLARED_NAME).toBeUndefined();
    expect(Object.keys(env).sort()).toEqual(Object.keys(getDefaultEnvironment()).sort());
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      "[mcp] acme-r2: env ACME_API_TOKEN is not in project acme's secrets (SECRET_ACME_API_TOKEN); omitted",
      "[mcp] acme-r2: env SYN_DECLARED_NAME is not in project acme's secrets (SECRET_SYN_DECLARED_NAME); omitted",
    ]);
    // the same names still pass through for a service server (operator-owned config)
    expect(buildSpawnEnv("svc-r2", { command: "node", envNames: ["ACME_API_TOKEN"], source: { kind: "service" } }).ACME_API_TOKEN).toBe(
      "service-side-value",
    );
  });
});

describe("lock: names-only env has one spawn site", () => {
  const files = (root: string): string[] =>
    readdirSync(root).flatMap((f) => {
      const p = join(root, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
    });

  it("no whole-env spread in src/mcp; StdioClientTransport constructed in exactly one place", () => {
    const spread = "..." + "process.env";
    const mcp = files(join(process.cwd(), "src", "mcp"));
    expect(mcp.filter((f) => readFileSync(f, "utf-8").includes(spread))).toEqual([]);
    const ctor = "new Stdio" + "ClientTransport(";
    const sites = files(join(process.cwd(), "src"))
      .filter((f) => !f.endsWith(".test.ts"))
      .flatMap((f) => readFileSync(f, "utf-8").split(ctor).length - 1 > 0 ? [[f, readFileSync(f, "utf-8").split(ctor).length - 1] as const] : []);
    expect(sites).toEqual([[join(process.cwd(), "src", "mcp", "manager.ts"), 1]]);
  });
  it("WS3a: no log/stringify call and no template literal in the env path touches a value (a literal is never logged)", () => {
    // `secret` = buildSpawnEnv's resolved-credential local (a bare identifier;
    // `entry.secret` is the reference NAME). An alias (`const lit = …`) is not
    // scannable — the behavioural pin above is the real lock (audit WS3a R2 W1).
    const interp = /\$\{[^}]*(?:\.value\b|(?<![.\w])secret\b)/;
    const valueRef = /\.value\b|\[\s*["']value["']\s*\]|envSpec|(?<![.\w])secret\b/;
    const callStart = /\b(?:console\.\w+|log\.\w+|JSON\.stringify)\s*\(/g;
    for (const f of ["manager.ts", "config.ts", "record-env.ts"]) {
      const src = readFileSync(join(process.cwd(), "src", "mcp", f), "utf-8");
      expect(interp.test(src), f).toBe(false);
      for (const m of src.matchAll(callStart)) {
        // the call's argument text, by paren depth
        let depth = 0;
        let i = m.index! + m[0].length - 1;
        const start = i;
        for (; i < src.length; i++) {
          if (src[i] === "(") depth++;
          else if (src[i] === ")" && --depth === 0) break;
        }
        const args = src.slice(start, i + 1);
        expect(valueRef.test(args), `${f}: ${args.slice(0, 80)}`).toBe(false);
      }
    }
  });
});
