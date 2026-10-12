/**
 * S6 WS3 — the merging MCP loader: `mcp-servers.json` (service) + active
 * records' `capabilities.mcp[]`. Synthetic repos under TMPDIR, `:memory:` db.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cfg = vi.hoisted(() => ({ path: "" }));
vi.mock("../config.js", () => ({ getConfig: () => ({ mcpConfigPath: cfg.path }) }));

import { closeDatabase, initDatabase } from "../db/index.js";
import { createProject } from "../db/projects.js";
import {
  loadMcpConfig,
  mergeRecordServers,
  recordToServerConfig,
  type RecordRepo,
} from "./config.js";
import type { McpConfig } from "./types.js";

let dir: string;
let repo: string;
let other: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mc-mcp-config-")));
  repo = join(dir, "acme-radar");
  other = join(dir, "outside");
  mkdirSync(join(repo, "server"), { recursive: true });
  mkdirSync(other, { recursive: true });
  cfg.path = join(dir, "mcp-servers.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const primary = (): RecordRepo[] => [{ path: repo, role: "primary" }];

describe("recordToServerConfig", () => {
  it("id defaults to the slug; cwd defaults to the repo root; fields map", () => {
    const r = recordToServerConfig(
      {
        command: "node",
        args: ["dist/mcp.js"],
        env: ["ACME_RADAR_TOKEN"],
        trust: "AB",
        tools: { acme_trigger_run: { trust: "B", destructive: true } },
        deferred: ["acme_history"],
      },
      "acme-radar",
      primary(),
      true,
      ["SECRET_ACME_RADAR_TOKEN"],
    );
    expect(r).toEqual({
      id: "acme-radar",
      config: {
        command: "node",
        args: ["dist/mcp.js"],
        cwd: repo,
        envSpec: [{ name: "ACME_RADAR_TOKEN", secret: "SECRET_ACME_RADAR_TOKEN" }],
        source: { kind: "record", slug: "acme-radar", trusted: true, secrets: ["SECRET_ACME_RADAR_TOKEN"] },
        trust: "AB",
        toolTrust: { acme_trigger_run: { trust: "B", destructive: true } },
        deferredTools: ["acme_history"],
      },
    });
    // record entries never carry `lazy` (no tool stubs: it would be inert)
    expect("lazy" in (r as { config: object }).config).toBe(false);
  });

  it("explicit id and a cwd inside the repo", () => {
    const r = recordToServerConfig({ id: "acme", command: "node", cwd: "server" }, "acme-radar", primary(), false);
    expect(r).toMatchObject({ id: "acme", config: { cwd: join(repo, "server"), source: { trusted: false } } });
  });

  it("a cwd that leaves the repo is refused: `..`, an absolute-looking escape, a symlink out", () => {
    symlinkSync(other, join(repo, "escape"));
    for (const cwd of ["..", "../outside", "server/../..", "escape"]) {
      const r = recordToServerConfig({ command: "node", cwd }, "acme-radar", primary(), true);
      expect(r, cwd).toEqual({ error: "acme-radar/acme-radar: cwd resolves outside its repo" });
    }
    expect(recordToServerConfig({ command: "node", cwd: "missing" }, "acme-radar", primary(), true)).toEqual({
      error: "acme-radar/acme-radar: repo or cwd does not exist",
    });
  });

  it("a repo that is itself a symlink resolves to its target; cwd is judged against that", () => {
    const link = join(dir, "repo-link");
    symlinkSync(repo, link);
    const r = recordToServerConfig({ command: "node", cwd: "server" }, "s", [{ path: link, role: "primary" }], true);
    expect(r).toMatchObject({ config: { cwd: join(repo, "server") } });
  });

  it("repo selection: primary, else the single repo, else refused; `repo` by path or unique role", () => {
    const two: RecordRepo[] = [
      { path: other, role: "other" },
      { path: repo, role: "other" },
    ];
    expect(recordToServerConfig({ command: "node" }, "s", two, true)).toEqual({
      error: "s/s: no repo (the record needs a primary repo or exactly one)",
    });
    expect(recordToServerConfig({ command: "node" }, "s", [{ path: other, role: "other" }], true)).toMatchObject({
      config: { cwd: other },
    });
    expect(recordToServerConfig({ command: "node", repo: repo }, "s", two, true)).toMatchObject({
      config: { cwd: repo },
    });
    expect(recordToServerConfig({ command: "node", repo: "other" }, "s", two, true)).toEqual({
      error: 's/s: repo "other" names no single repos[] entry',
    });
    expect(
      recordToServerConfig({ command: "node", repo: "primary" }, "s", [...two.slice(0, 1), { path: repo, role: "primary" }], true),
    ).toMatchObject({ config: { cwd: repo } });
    expect(recordToServerConfig({ command: "node" }, "s", [], true)).toMatchObject({ error: expect.stringContaining("no repo") });
  });
});

describe("recordToServerConfig — audit R1 refusals", () => {
  it("an id containing `__` is refused (loader layer, behind the schema)", () => {
    expect(recordToServerConfig({ id: "browser__evil", command: "node" }, "acme-radar", primary(), true)).toEqual({
      error: "acme-radar/browser__evil: id must not contain __",
    });
  });

  it("an env name not matching ENV_NAME_RE is refused (count only, no name echoed)", () => {
    expect(recordToServerConfig({ command: "node", env: ["ACME_TOKEN", "lower_case", "1BAD"] }, "acme-radar", primary(), true)).toEqual({
      error: "acme-radar/acme-radar: 2 env entry(ies) malformed or not matching ^[A-Z][A-Z0-9_]*$",
    });
  });

  it("WS3a: the three env shapes normalise; each loader refusal names the env NAME only", () => {
    const cfg = (env: unknown[], secrets: string[] = []) =>
      recordToServerConfig({ command: "node", env: env as never }, "acme-radar", primary(), true, secrets);
    const ok = cfg(
      ["SYN_A", { name: "PG_PASSWORD", secret: "SECRET_ACME_RADAR_PG_PASSWORD" }, { name: "PG_HOST", value: "db.example.test" }],
      ["SECRET_ACME_RADAR_PG_PASSWORD"],
    );
    expect("config" in ok && ok.config.envSpec).toEqual([
      { name: "SYN_A", secret: "SECRET_SYN_A" },
      { name: "PG_PASSWORD", secret: "SECRET_ACME_RADAR_PG_PASSWORD" },
      { name: "PG_HOST", value: "db.example.test" },
    ]);
    const err = (r: ReturnType<typeof cfg>) => ("error" in r ? r.error : "accepted");
    expect(err(cfg([{ name: "PG_PASSWORD", value: "hunter2-synthetic" }]))).toBe(
      'acme-radar/acme-radar: env PG_PASSWORD: literal name contains "PASS" (secret-shaped; store it in credentials and use {name, secret})',
    );
    expect(err(cfg([{ name: "CLIENTSECRET", value: "x" }]))).toBe(
      'acme-radar/acme-radar: env CLIENTSECRET: literal name contains "SECRET" (secret-shaped; store it in credentials and use {name, secret})',
    );
    expect(err(cfg([{ name: "SYN_SETTING", value: "" }]))).toBe("acme-radar/acme-radar: env SYN_SETTING: literal is empty");
    expect(err(cfg([{ name: "SYN_SETTING", value: "sk-ant-api03-" + "a".repeat(40) }]))).toMatch(
      /^acme-radar\/acme-radar: env SYN_SETTING: literal is secret-shaped/,
    );
    expect(err(cfg([{ name: "SYN_SETTING", value: "a\nb" }]))).toBe("acme-radar/acme-radar: env SYN_SETTING: literal contains a newline or NUL");
    expect(err(cfg([{ name: "SYN_SETTING", value: "a\0b" }]))).toBe("acme-radar/acme-radar: env SYN_SETTING: literal contains a newline or NUL");
    expect(err(cfg([{ name: "SYN_SETTING", value: "x".repeat(512) }]))).toBe("accepted"); // boundary
    expect(err(cfg([{ name: "SYN_SETTING", value: "x".repeat(513) }]))).toBe(
      "acme-radar/acme-radar: env SYN_SETTING: literal exceeds 512 characters",
    );
    expect(err(cfg(["SYN_A", { name: "SYN_A", value: "1" }]))).toBe("acme-radar/acme-radar: env SYN_A declared twice");
    expect(err(cfg([{ name: "PG_PASSWORD", secret: "SECRET_UNLISTED" }]))).toBe(
      "acme-radar/acme-radar: env PG_PASSWORD: secret SECRET_UNLISTED is not in the record's secrets",
    );
    expect(err(cfg([{ name: "NODE_OPTIONS", value: "--x" }]))).toBe("acme-radar/acme-radar: env name(s) reserved: NODE_OPTIONS");
    expect(err(cfg([{ name: "lower", value: "1" }, { name: "SYN_A", secret: "SECRET_X", extra: 1 }]))).toBe(
      "acme-radar/acme-radar: 2 env entry(ies) malformed or not matching ^[A-Z][A-Z0-9_]*$",
    );
    for (const r of [cfg([{ name: "PG_PASSWORD", value: "hunter2-synthetic" }])]) {
      expect(JSON.stringify(r)).not.toContain("hunter2-synthetic");
    }
  });

  it("WS3a R1 C2: a literal whose name CONTAINS a secret fragment, or a hex-blob value, is refused; real setting names pass", () => {
    const lit = (name: string, value = "plain") =>
      recordToServerConfig({ command: "node", env: [{ name, value }] }, "acme-radar", primary(), true);
    for (const name of [
      "PGPASSWORD", "PGPASS", "DBPASS", "CLIENTSECRET", "DB_PWD", "SLACKTOKEN", "APIKEY", "BASICAUTH",
      "DBCRED", "MICLAVE", "CONTRASENA", "PRIVATEPEM", "TLSCERT",
    ]) {
      expect("error" in lit(name), name).toBe(true);
    }
    // the only entropy-style rule that exists: a 40+ hex blob (redactSecrets)
    expect(lit("PG_OPTS", "ab12".repeat(10))).toEqual({
      error: "acme-radar/acme-radar: env PG_OPTS: literal is secret-shaped (store it in credentials and use {name, secret})",
    });
    for (const name of [
      "IOMCP_DIALECT", "PG_HOST", "PG_PORT", "PG_DATABASE", "PG_USER", "PG_SSL", "MAX_RESULT_ROWS", "AUDIT_DB_PATH", "STUDIO_DB_PATH",
    ]) {
      expect("error" in lit(name, "postgres"), name).toBe(false);
    }
  });

  it("a reserved env name is refused, naming the names only", () => {
    expect(
      recordToServerConfig({ command: "node", env: ["ACME_TOKEN", "NODE_OPTIONS", "TELEGRAM_BOT_TOKEN"] }, "acme-radar", primary(), true),
    ).toEqual({ error: "acme-radar/acme-radar: env name(s) reserved: NODE_OPTIONS, TELEGRAM_BOT_TOKEN" });
  });
});

describe("mergeRecordServers", () => {
  const service: McpConfig = {
    browser: { command: "./bin/lightpanda", source: { kind: "service" } },
    xpoz: { command: "node", source: { kind: "service" } },
  };
  const row = (slug: string, status: string, mcp: unknown[], extra: Record<string, unknown> = {}) => ({
    slug,
    status,
    config: { repos: [{ path: repo, role: "primary" }], capabilities: { mcp }, trusted: true, ...extra },
  });

  it("service entries first, then records in row order; untrusted kept with trusted=false", () => {
    const out = mergeRecordServers(service, [
      row("acme-radar", "active", [{ command: "node" }]),
      row("beta-proj", "active", [{ id: "beta", command: "node" }], { trusted: false }),
    ]);
    expect(Object.keys(out)).toEqual(["browser", "xpoz", "acme-radar", "beta"]);
    expect(out.beta!.source).toEqual({ kind: "record", slug: "beta-proj", trusted: false });
    expect(out.browser).toBe(service.browser);
  });

  it("a duplicate id is refused: the service (or earlier record) wins, one error + one alert each", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const alerts: string[] = [];
    const out = mergeRecordServers(
      service,
      [
        row("acme-radar", "active", [{ id: "xpoz", command: "sh", args: ["-c", "true"] }, { command: "node" }]),
        row("beta-proj", "active", [{ id: "acme-radar", command: "node" }]),
      ],
      (m) => alerts.push(m),
    );
    expect(out.xpoz).toBe(service.xpoz);
    expect(out["acme-radar"]!.source).toMatchObject({ slug: "acme-radar" });
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toContain('id "xpoz" is already declared (by mcp-servers.json)');
    expect(alerts[1]).toContain('id "acme-radar" is already declared (by another record)');
    expect(err).toHaveBeenCalledTimes(2);
  });

  it("a record id whose `<id>__` overlaps a service prefix or the static Rule-of-Two table is refused + alerted", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const alerts: string[] = [];
    const out = mergeRecordServers(
      { "svc__x": { command: "node", source: { kind: "service" } } },
      [
        row("aa-proj", "active", [{ id: "svc", command: "node" }]),
        // `playwright` is in the static table even with no service entry here
        row("bb-proj", "active", [{ id: "playwright", command: "node" }]),
        row("cc-proj", "active", [{ id: "fine", command: "node" }]),
      ],
      (m) => alerts.push(m),
    );
    expect(Object.keys(out)).toEqual(["svc__x", "fine"]);
    expect(alerts).toEqual([
      '[mcp] ⚠️ record server aa-proj/svc refused: prefix "svc__" overlaps service prefix "svc__x__"',
      '[mcp] ⚠️ record server bb-proj/playwright refused: prefix "playwright__" overlaps service prefix "playwright__"',
    ]);
  });

  it("service id + `_` is refused in the prefix.startsWith direction; near-misses are accepted (R2 pin M2)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const alerts: string[] = [];
    const out = mergeRecordServers(
      { browser: { command: "node", source: { kind: "service" } } },
      [
        row("aa-proj", "active", [{ id: "browser_", command: "node" }]),
        row("bb-proj", "active", [{ id: "brow", command: "node" }]),
        row("cc-proj", "active", [{ id: "browserx", command: "node" }]),
        row("dd-proj", "active", [{ id: "browser-", command: "node" }]),
      ],
      (m) => alerts.push(m),
    );
    expect(Object.keys(out)).toEqual(["browser", "brow", "browserx", "browser-"]);
    expect(alerts).toEqual([
      '[mcp] ⚠️ record server aa-proj/browser_ refused: prefix "browser___" overlaps service prefix "browser__"',
    ]);
  });

  it("a record prefix overlapping an EARLIER record's prefix is refused, both directions (audit R2 W1)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [first, second] of [
      ["foo", "foo_"],
      ["foo_", "foo"],
    ] as const) {
      const alerts: string[] = [];
      const out = mergeRecordServers(
        {},
        [
          // the earlier slug is untrusted: still declared, still owns its prefix
          row("aa", "active", [{ id: first, command: "node", trust: "NONE" }], { trusted: false }),
          row("bb", "active", [{ id: second, command: "node", trust: "AB" }]),
        ],
        (m) => alerts.push(m),
      );
      expect(Object.keys(out), first).toEqual([first]);
      expect(alerts, first).toEqual([
        `[mcp] ⚠️ record server bb/${second} refused: prefix "${second}__" overlaps record aa prefix "${first}__"`,
      ]);
    }
  });

  it("the duplicate-id winner is the earlier SLUG, whatever the row order (audit R1 W5)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const a = row("aa-proj", "active", [{ id: "shared", command: "node" }]);
    const z = row("zz-proj", "active", [{ id: "shared", command: "node" }]);
    for (const rows of [[a, z], [z, a]]) {
      expect(mergeRecordServers({}, rows).shared!.source).toMatchObject({ slug: "aa-proj" });
    }
  });

  it("inactive rows and rows without capabilities.mcp contribute nothing", () => {
    const out = mergeRecordServers(service, [
      row("paused-proj", "paused", [{ command: "node" }]),
      row("archived-proj", "archived", [{ command: "node" }]),
      { slug: "plain", status: "active", config: { aliases: ["p"] } },
    ]);
    expect(Object.keys(out)).toEqual(["browser", "xpoz"]);
  });

  it("a refused entry (cwd outside) alerts and the rest of the record still loads", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const alerts: string[] = [];
    const out = mergeRecordServers(
      {},
      [row("acme-radar", "active", [{ id: "bad", command: "node", cwd: ".." }, { id: "good", command: "node" }])],
      (m) => alerts.push(m),
    );
    expect(Object.keys(out)).toEqual(["good"]);
    expect(alerts).toEqual(["[mcp] ⚠️ record server refused: acme-radar/bad: cwd resolves outside its repo"]);
  });
});

describe("loadMcpConfig (json + db)", () => {
  beforeEach(() => initDatabase(":memory:"));
  afterEach(() => closeDatabase());

  it("merges the active rows' servers; service entries tagged; envNames validated", () => {
    writeFileSync(cfg.path, JSON.stringify({ svc: { command: "node", envNames: ["SVC_TOKEN"] } }));
    createProject("acme-radar", "Acme Radar", {
      status: "active",
      config: { repos: [{ path: repo, role: "primary" }], trusted: true, capabilities: { mcp: [{ command: "node", env: ["ACME_RADAR_TOKEN"] }] } },
    });
    createProject("paused-proj", "Paused", {
      status: "paused",
      config: { repos: [{ path: repo, role: "primary" }], trusted: true, capabilities: { mcp: [{ id: "paused", command: "node" }] } },
    });
    const out = loadMcpConfig()!;
    expect(Object.keys(out)).toEqual(["svc", "acme-radar"]);
    expect(out.svc).toEqual({ command: "node", envNames: ["SVC_TOKEN"], source: { kind: "service" } });
    expect(out["acme-radar"]).toMatchObject({
      cwd: repo,
      envSpec: [{ name: "ACME_RADAR_TOKEN", secret: "SECRET_ACME_RADAR_TOKEN" }],
    });
    expect(out["acme-radar"]!.envNames).toBeUndefined();

    writeFileSync(cfg.path, JSON.stringify({ svc: { command: "node", envNames: ["lower_case"] } }));
    expect(() => loadMcpConfig()).toThrow(/envNames/);
  });

  it("no json and no declaring row → null; records alone still load", () => {
    expect(loadMcpConfig()).toBeNull();
    createProject("acme-radar", "Acme Radar", {
      status: "active",
      config: { repos: [{ path: repo, role: "primary" }], capabilities: { mcp: [{ command: "node" }] } },
    });
    expect(Object.keys(loadMcpConfig()!)).toEqual(["acme-radar"]);
  });
});
