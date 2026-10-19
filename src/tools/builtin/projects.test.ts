/**
 * Ruling 3b (2026-10-01, "same treatment now"): the `projects` store gets the
 * user-facts credential treatment — project_get masks credential-style
 * entries and no project output carries a credential value.
 * Ruling 3c (2026-10-01): project_update STORES credentials (the 3b refusal is
 * gone); each is shown by its by-name placeholder and used by that name.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import {
  createProject,
  formatProjectsBlock,
  getProject,
  getProjectLog,
} from "../../db/projects.js";
import { CREDENTIAL_FACT_PLACEHOLDER } from "../../db/user-facts.js";
import {
  resolveSecretRefs,
  scrubSecrets,
  secretEnvForCommand,
  secretPlaceholder,
} from "../../lib/secret-refs.js";
import { projectGetTool, projectListTool, projectUpdateTool } from "./projects.js";
import { ToolRegistry } from "../registry.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFile } from "../../db/jarvis-fs.js";
import { upsertFromDiskWrite } from "../../db/jarvis-reindex.js";
import { parseProjectRecord, projectRecordRelPath } from "../../projects/record.js";
import { MIN_ALIAS_CHARS } from "../../projects/scope-groups.js";

// Synthetic credential values, assembled at runtime (never a key-shaped
// literal in source — the repo is public).
const FAKE_GOOGLE_KEY = "AIza" + "b".repeat(35);
const FAKE_APP_PASSWORD = "pw" + "-" + "q".repeat(14);
const FAKE_URL_SECRET = "s3" + "x".repeat(10);
const FAKE_URL_WITH_USERINFO =
  "https://" + "deploy" + ":" + FAKE_URL_SECRET + "@" + "git.example.com/r.git";
const SECRETS = [FAKE_GOOGLE_KEY, FAKE_APP_PASSWORD, FAKE_URL_SECRET];

function expectNoSecret(out: string): void {
  for (const s of SECRETS) expect(out).not.toContain(s);
}

function clearLog(): void {
  getDatabase().prepare("DELETE FROM project_log").run();
}

/** A legacy row that already holds credential entries (seeded below the tool). */
function seedLegacy(): void {
  createProject("legacy", "Legacy Site", {
    urls: { site: "https://legacy.example.com" },
    credentials: {
      wp_user: "editor",
      wp_app_password: FAKE_APP_PASSWORD,
      ftp_host: "ftp.example.com",
      acme_api_key: FAKE_GOOGLE_KEY,
    },
    config: { phase: "live" },
  });
}

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

describe("project_get — credential masking", () => {
  it("masks only the real credentials (classifier) by name; user and host show in clear; the URL stays verbatim (rulings 3c + 3d)", async () => {
    seedLegacy();
    clearLog();
    const out = await projectGetTool.execute({ slug: "legacy" });
    expect(out).toBe(
      [
        "📁 **Legacy Site** (`legacy`)",
        "Status: active",
        "URL: https://legacy.example.com",
        "\n**Credentials:** wp_user, wp_app_password, ftp_host, acme_api_key",
        "  wp_user: editor",
        `  wp_app_password: ${secretPlaceholder("SECRET_LEGACY_WP_APP_PASSWORD")}`,
        "  ftp_host: ftp.example.com",
        `  acme_api_key: ${secretPlaceholder("SECRET_LEGACY_ACME_API_KEY")}`,
      ].join("\n"),
    );
    expect(out).not.toContain(".env");
    expectNoSecret(out);
  });

  it("is byte-identical to the pre-ruling output when nothing is a secret (no credentials entries)", async () => {
    createProject("plain", "Plain", {
      description: "Sitio de prueba",
      urls: {
        site: "https://plain.example.com",
        repo: "https://github.com/acme/plain",
        repo_ui: "https://github.com/acme/plain-ui",
      },
      config: { phase: "live" },
      commit_goal_id: "goal-1",
    });
    clearLog();
    const out = await projectGetTool.execute({ slug: "plain" });
    expect(out).toBe(
      [
        "📁 **Plain** (`plain`)",
        "Status: active",
        "Sitio de prueba",
        "URL: https://plain.example.com",
        "Repo: https://github.com/acme/plain",
        "Repo (ui): https://github.com/acme/plain-ui",
        "NorthStar goal: goal-1",
      ].join("\n"),
    );
    expect(out).not.toContain(CREDENTIAL_FACT_PLACEHOLDER);
    expect(out).not.toContain("[oculto");
  });

  it("masks a URL that carries user:pass@ (site, repo and repo_* keys)", async () => {
    createProject("urlsec", "Url Secret", {
      urls: {
        site: FAKE_URL_WITH_USERINFO,
        repo: FAKE_URL_WITH_USERINFO,
        repo_ui: FAKE_URL_WITH_USERINFO,
      },
    });
    clearLog();
    const out = await projectGetTool.execute({ slug: "urlsec" });
    expect(out).toBe(
      [
        "📁 **Url Secret** (`urlsec`)",
        "Status: active",
        `URL: ${secretPlaceholder("SECRET_URLSEC_URLS_SITE")}`,
        `Repo: ${secretPlaceholder("SECRET_URLSEC_URLS_REPO")}`,
        `Repo (ui): ${secretPlaceholder("SECRET_URLSEC_URLS_REPO_UI")}`,
      ].join("\n"),
    );
    expectNoSecret(out);
  });
});

describe("other project outputs never carry a credential value", () => {
  it("project_list, formatProjectsBlock and the project_update result print names only", async () => {
    seedLegacy();
    createProject("urlsec", "Url Secret", {
      urls: { site: "https://ok.example.com", repo: FAKE_URL_WITH_USERINFO },
      config: { notes: "ok" },
    });
    createProject("sitesec", "Site Secret", {
      urls: { site: FAKE_URL_WITH_USERINFO },
    });
    const list = await projectListTool.execute({});
    expect(list).toContain("wp_app_password");
    expect(list).toContain(
      `| sitesec | Site Secret | active | ${secretPlaceholder("SECRET_SITESEC_URLS_SITE")} | — |`,
    );
    expect(list).toContain("| urlsec | Url Secret | active | https://ok.example.com |");
    expectNoSecret(list);
    const block = formatProjectsBlock();
    expect(block).toContain("acme_api_key");
    expect(block).toContain(
      `  URL: ${secretPlaceholder("SECRET_SITESEC_URLS_SITE")}`,
    );
    expectNoSecret(block);
    const upd = await projectUpdateTool.execute({ slug: "legacy", status: "paused" });
    expect(JSON.parse(upd).project.credential_keys).toContain("acme_api_key");
    expectNoSecret(upd);
    for (const slug of ["legacy", "urlsec"]) {
      expectNoSecret(await projectGetTool.execute({ slug }));
    }
  });
});

describe("project_update — credentials are stored hidden (ruling 3c)", () => {
  it("a create with a credential stores it; the result names it by placeholder, never the value", async () => {
    const out = await projectUpdateTool.execute({
      slug: "nuevo",
      name: "Nuevo",
      credentials: { wp_user: "editor", wp_app_password: FAKE_APP_PASSWORD },
    });
    expect(JSON.parse(out)).toEqual({
      action: "created",
      project: {
        slug: "nuevo",
        name: "Nuevo",
        status: "active",
        credential_keys: ["wp_user", "wp_app_password"],
      },
      saved_secrets: {
        "credentials.wp_app_password": secretPlaceholder(
          "SECRET_NUEVO_WP_APP_PASSWORD",
        ),
      },
    });
    expectNoSecret(out);
    expect(getProject("nuevo")!.credentials).toEqual({
      wp_user: "editor",
      wp_app_password: FAKE_APP_PASSWORD,
    });
    // Usable by name at the execution seam.
    expect(
      secretEnvForCommand('curl -u "editor:$SECRET_NUEVO_WP_APP_PASSWORD" x'),
    ).toEqual({ SECRET_NUEVO_WP_APP_PASSWORD: FAKE_APP_PASSWORD });
  });

  it("an update with credentials applies WHOLE (incl. a credential by VALUE under a neutral name)", async () => {
    seedLegacy();
    const before = getProject("legacy")!;
    const logBefore = getProjectLog(before.id, 50).length;
    const out = await projectUpdateTool.execute({
      slug: "legacy",
      name: "Renamed",
      status: "paused",
      credentials: {
        wp_user: "editor2",
        api_key: FAKE_GOOGLE_KEY,
        notes: FAKE_GOOGLE_KEY,
      },
    });
    const parsed = JSON.parse(out) as {
      action: string;
      saved_secrets: Record<string, string>;
    };
    expect(parsed.action).toBe("updated");
    expect(parsed.saved_secrets).toEqual({
      "credentials.api_key": secretPlaceholder("SECRET_LEGACY_API_KEY"),
      "credentials.notes": secretPlaceholder("SECRET_LEGACY_NOTES"),
    });
    expectNoSecret(out);
    const after = getProject("legacy")!;
    expect(after.name).toBe("Renamed");
    expect(after.status).toBe("paused");
    expect(after.credentials).toEqual({
      ...before.credentials,
      wp_user: "editor2",
      api_key: FAKE_GOOGLE_KEY,
      notes: FAKE_GOOGLE_KEY,
    });
    expect(getProjectLog(before.id, 50).length).toBeGreaterThan(logBefore);
    // project_get shows it masked by name.
    const got = await projectGetTool.execute({ slug: "legacy" });
    expect(got).toContain(
      `  api_key: ${secretPlaceholder("SECRET_LEGACY_API_KEY")}`,
    );
    expectNoSecret(got);
  });

  it("stores credential-style values under config (nested) and urls; each resolves by name", async () => {
    seedLegacy();
    const out = await projectUpdateTool.execute({
      slug: "legacy",
      // Queue 3l ruling A: a `NAME=value` literal is refused (see below); a
      // secret-shaped value with no name beside it is still stored hidden.
      config: { deploy: { notes: FAKE_GOOGLE_KEY }, phase: "beta" },
      urls: { repo: FAKE_URL_WITH_USERINFO },
    });
    expect(JSON.parse(out).saved_secrets).toEqual({
      "config.deploy.notes": secretPlaceholder(
        "SECRET_LEGACY_CONFIG_DEPLOY_NOTES",
      ),
      "urls.repo": secretPlaceholder("SECRET_LEGACY_URLS_REPO"),
    });
    expectNoSecret(out);
    const after = getProject("legacy")!;
    expect(after.config).toEqual({
      phase: "beta",
      deploy: { notes: FAKE_GOOGLE_KEY },
    });
    expect(after.urls.repo).toBe(FAKE_URL_WITH_USERINFO);
    const r = resolveSecretRefs("http_fetch", {
      url: "{{SECRET_LEGACY_URLS_REPO}}",
      body: "{{SECRET_LEGACY_CONFIG_DEPLOY_NOTES}}",
    });
    expect(r).toEqual({
      args: { url: FAKE_URL_WITH_USERINFO, body: FAKE_GOOGLE_KEY },
    });
  });

  it("audit R3 S4: nested credentials show each value's own name in saved_secrets and project_get (no generic placeholder)", async () => {
    const out = await projectUpdateTool.execute({
      slug: "nested",
      name: "Nested",
      credentials: {
        ftp: { host: "ftp.example.test", pass: FAKE_APP_PASSWORD },
        keys: [FAKE_GOOGLE_KEY],
      },
    });
    expect(JSON.parse(out).saved_secrets).toEqual({
      "credentials.ftp.pass": secretPlaceholder("SECRET_NESTED_FTP_PASS"),
      "credentials.keys.0": secretPlaceholder("SECRET_NESTED_KEYS_0"),
    });
    expectNoSecret(out);
    const got = await projectGetTool.execute({ slug: "nested" });
    expect(got).toContain("\n**Credentials:** ftp, keys");
    expect(got).toContain("  ftp.host: ftp.example.test"); // ruling 3d
    expect(got).toContain(
      `  ftp.pass: ${secretPlaceholder("SECRET_NESTED_FTP_PASS")}`,
    );
    expect(got).toContain(
      `  keys.0: ${secretPlaceholder("SECRET_NESTED_KEYS_0")}`,
    );
    expect(got).not.toContain(CREDENTIAL_FACT_PLACEHOLDER);
    expectNoSecret(got);
    // Each shown name resolves at the execution seam.
    expect(secretEnvForCommand("echo $SECRET_NESTED_FTP_PASS")).toEqual({
      SECRET_NESTED_FTP_PASS: FAKE_APP_PASSWORD,
    });
  });

  it("allows blanking an existing credential entry (''), and null DELETES it (audit R5 B2b)", async () => {
    seedLegacy();
    const out = await projectUpdateTool.execute({
      slug: "legacy",
      credentials: { wp_app_password: "", acme_api_key: null },
    });
    expect(JSON.parse(out).action).toBe("updated");
    expect(out).not.toContain("saved_secrets");
    const after = getProject("legacy")!;
    expect(after.credentials.wp_app_password).toBe("");
    expect("acme_api_key" in after.credentials).toBe(false);
    expect(after.credentials.wp_user).toBe("editor");
  });

  it("a call without credentials returns the pre-ruling result (no saved_secrets)", async () => {
    const created = await projectUpdateTool.execute({
      slug: "nuevo",
      name: "Nuevo",
      urls: { site: "https://nuevo.example.com" },
      config: { phase: "alpha", aliases: ["nuevito"] },
    });
    expect(created).toBe(
      JSON.stringify({
        action: "created",
        project: {
          slug: "nuevo",
          name: "Nuevo",
          status: "active",
          credential_keys: [],
        },
      }),
    );
    const updated = await projectUpdateTool.execute({
      slug: "nuevo",
      config: { phase: "beta" },
    });
    expect(JSON.parse(updated).action).toBe("updated");
    expect(updated).not.toContain("saved_secrets");
    const p = getProject("nuevo")!;
    expect(p.credentials).toEqual({});
    expect(p.config).toEqual({ phase: "beta", aliases: ["nuevito"] });
  });
});

describe("audit R5 B2 — edits never destroy a stored credential", () => {
  const FTP_PASS = "fp-" + "k".repeat(14);
  function seedFtp() {
    createProject("acme-ftp", "Acme FTP", {
      credentials: {
        ftp: { host: "ftp.old.example.com", user: "deploy", password: FTP_PASS },
        wp_app_password: FAKE_APP_PASSWORD,
      },
      urls: { site: "https://acme.example.com", extra: { docs: "https://docs.example.com" } },
      config: { build: { node: "20", flags: ["a"] } },
    });
  }

  it("changing ftp.host keeps ftp.user and ftp.password (nested objects are deep-merged)", async () => {
    seedFtp();
    const out = await projectUpdateTool.execute({
      slug: "acme-ftp",
      credentials: { ftp: { host: "ftp.new.example.com" } },
    });
    expect(JSON.parse(out).action).toBe("updated");
    const p = getProject("acme-ftp")!;
    expect(p.credentials.ftp).toEqual({
      host: "ftp.new.example.com",
      user: "deploy",
      password: FTP_PASS,
    });
    expect(p.credentials.wp_app_password).toBe(FAKE_APP_PASSWORD);
  });

  it("urls and config merge the same way; arrays replace", async () => {
    seedFtp();
    await projectUpdateTool.execute({
      slug: "acme-ftp",
      urls: { extra: { status: "https://status.example.com" } },
      config: { build: { flags: ["b"] } },
    });
    const p = getProject("acme-ftp")!;
    expect(p.urls).toEqual({
      site: "https://acme.example.com",
      extra: { docs: "https://docs.example.com", status: "https://status.example.com" },
    });
    expect(p.config).toEqual({ build: { node: "20", flags: ["b"] } });
  });

  it("null deletes a nested key (`{ftp: {password: null}}`) or a whole entry (`{ftp: null}`)", async () => {
    seedFtp();
    await projectUpdateTool.execute({
      slug: "acme-ftp",
      credentials: { ftp: { password: null } },
    });
    expect(getProject("acme-ftp")!.credentials.ftp).toEqual({
      host: "ftp.old.example.com",
      user: "deploy",
    });
    await projectUpdateTool.execute({ slug: "acme-ftp", credentials: { ftp: null } });
    expect("ftp" in getProject("acme-ftp")!.credentials).toBe(false);
  });

  it("moving a credential by its placeholder (or {{X}} / $X) stores the VALUE at the new path", async () => {
    seedFtp();
    const ph = secretPlaceholder("SECRET_ACME_FTP_FTP_PASSWORD");
    const out = await projectUpdateTool.execute({
      slug: "acme-ftp",
      credentials: {
        sftp: { host: "sftp.example.com", password: ph },
        backup_password: "{{SECRET_ACME_FTP_WP_APP_PASSWORD}}",
        ftp: { password: null },
      },
    });
    expect(out).not.toContain(FTP_PASS);
    expect(JSON.parse(out).saved_secrets["credentials.sftp.password"]).toBe(
      secretPlaceholder("SECRET_ACME_FTP_SFTP_PASSWORD"),
    );
    const p = getProject("acme-ftp")!;
    expect((p.credentials.sftp as unknown as Record<string, string>).password).toBe(FTP_PASS);
    expect(p.credentials.backup_password).toBe(FAKE_APP_PASSWORD);
    expect(p.credentials.ftp).toEqual({ host: "ftp.old.example.com", user: "deploy" });
  });

  it("placeholder-ish garbage, an unknown name, or a move to a visible key is refused and nothing changes", async () => {
    seedFtp();
    const before = JSON.stringify(getProject("acme-ftp")!.credentials);
    const ph = secretPlaceholder("SECRET_ACME_FTP_FTP_PASSWORD");
    for (const [credentials, needle] of [
      [{ ftp: { password: `pw: ${ph}` } }, "{{SECRET_<NOMBRE>}}"],
      [{ ftp: { password: "{{SECRET_ACME_FTP_NOPE}}" } }, "SECRET_ACME_FTP_NOPE"],
      [{ ftp: { notes: ph } }, "credentials.ftp.notes"],
    ] as const) {
      const out = await projectUpdateTool.execute({ slug: "acme-ftp", credentials });
      expect(JSON.parse(out).error, JSON.stringify(credentials)).toContain(needle);
    }
    expect(JSON.stringify(getProject("acme-ftp")!.credentials)).toBe(before);
  });
});

describe("descriptions", () => {
  it("project_update is the pre-ruling text; project_get says values are hidden", () => {
    const get = projectGetTool.definition.function.description;
    const upd = projectUpdateTool.definition.function.description;
    const credParam = (
      projectUpdateTool.definition.function.parameters as {
        properties: Record<string, { description: string }>;
      }
    ).properties.credentials.description;
    expect(get.split("\n")[0]).toBe(
      "Get full details of a project including credential names (secret values hidden), config, and recent activity log.",
    );
    expect(upd.split("\n")[0]).toBe(
      "Create or update a project. Updates are merged (credentials, URLs, config are merged key by key, nested objects too, not replaced; a null value deletes that key).",
    );
    for (const d of [get, upd, credParam]) {
      expect(d).not.toContain(".env");
      expect(d).not.toContain("refused");
    }
    expect(upd).toContain(
      "- WordPress: credentials.wp_user, credentials.wp_app_password",
    );
    expect(credParam).toBe(
      "Project credentials. Keys: wp_user, wp_app_password, ftp_host, api_keys, etc. Merged with existing.",
    );
  });
});

describe('ruling 3d — "Just real credentials. Everything must be accessible"', () => {
  const HOST = ["acme-shop", "example", "test"].join(".");
  const SITE = "https://" + HOST;
  const LOGIN = ["admin", HOST].join("@");
  const MEASURE = "G-" + "K".repeat(10);
  const COMMON = [
    "pass", "password", "pwd", "passwd", "token", "api_key", "apikey",
    "secret", "client_secret", "private_key", "key", "cookie", "s2", "swid",
    "session", "auth", "bearer",
  ];
  const val = (k: string, n: boolean) =>
    (n ? "nv-" : "tv-") + k.replace(/_/g, "u") + "-" + "r".repeat(10);
  const name = (k: string, n: boolean) =>
    `SECRET_SHOP_${n ? "SVC_" : ""}${k.toUpperCase()}`;

  it("ftp_host equal to the site's domain, the username e-mail and the GA4 id show in clear and survive the tool seam's scrub; every common secret key is hidden by name (top-level and nested)", async () => {
    const out = await projectUpdateTool.execute({
      slug: "shop",
      name: "Shop",
      urls: { site: SITE },
      credentials: {
        ftp_host: HOST,
        ftp_user: LOGIN,
        ga4_measurement_id: MEASURE,
        ...Object.fromEntries(COMMON.map((k) => [k, val(k, false)])),
        svc: {
          host: HOST,
          ...Object.fromEntries(COMMON.map((k) => [k, val(k, true)])),
        },
      },
    });
    const expected: Record<string, string> = {};
    for (const k of COMMON) {
      expected[`credentials.${k}`] = secretPlaceholder(name(k, false));
    }
    for (const k of COMMON) {
      expected[`credentials.svc.${k}`] = secretPlaceholder(name(k, true));
    }
    expect(JSON.parse(out).saved_secrets).toEqual(expected);
    // Through the real tool seam (resolve + scrub), as the model receives it.
    const reg = new ToolRegistry();
    reg.register(projectGetTool);
    const got = await reg.execute("project_get", { slug: "shop" });
    expect(got).toContain(`URL: ${SITE}\n`);
    expect(got).toContain(`  ftp_host: ${HOST}\n`);
    expect(got).toContain(`  ftp_user: ${LOGIN}\n`);
    expect(got).toContain(`  ga4_measurement_id: ${MEASURE}\n`);
    expect(got).toContain(`  svc.host: ${HOST}\n`);
    for (const k of COMMON) {
      expect(got).toContain(`  ${k}: ${secretPlaceholder(name(k, false))}`);
      expect(got).toContain(`  svc.${k}: ${secretPlaceholder(name(k, true))}`);
      expect(got).not.toContain(val(k, false));
      expect(got).not.toContain(val(k, true));
    }
    // Neither the host nor the e-mail is a scrub target in other tool output.
    const echoed = `fetched ${SITE}/contacto for ${LOGIN} (${MEASURE})`;
    expect(scrubSecrets(echoed)).toBe(echoed);
    expect(
      secretEnvForCommand(`lftp -u "${LOGIN},$SECRET_SHOP_SVC_PASS" ${HOST}`),
    ).toEqual({ SECRET_SHOP_SVC_PASS: val("pass", true) });
  });
});

describe("audit R6 should-fix 4 — non-object fields and prototype keys are refused", () => {
  it.each([
    ["credentials", "ftp.example.com"],
    ["credentials", ["h", "p"]],
    ["urls", "https://example.com"],
    ["config", 5],
    ["credentials", null],
  ])("project_update %s = %j is refused with {error} (create and update), nothing stored", async (field, value) => {
    const created = JSON.parse(
      await projectUpdateTool.execute({ slug: "r6-new", [field]: value }),
    );
    expect(created.error).toMatch(/^No guardé: /);
    expect(getProject("r6-new")).toBeNull();
    createProject("r6-old", "Old", { credentials: { ftp_host: "ftp.example.com" } });
    const updated = JSON.parse(
      await projectUpdateTool.execute({ slug: "r6-old", [field]: value }),
    );
    expect(updated.error).toMatch(/^No guardé: /);
    expect(getProject("r6-old")!.credentials).toEqual({ ftp_host: "ftp.example.com" });
  });

  it("the db layer refuses a non-object field instead of storing {\"0\":\"h\",…}", () => {
    expect(() =>
      createProject("r6-db", "X", {
        credentials: "host" as unknown as Record<string, string>,
      }),
    ).toThrow(TypeError);
    expect(getProject("r6-db")).toBeNull();
  });

  it("__proto__ / constructor / prototype keys are refused at any depth and never listed in saved_secrets", async () => {
    for (const bad of ["__proto__", "constructor", "prototype"]) {
      const args = JSON.parse(
        `{"slug":"r6-proto","credentials":{"ftp":{"${bad}":{"password":"${FAKE_APP_PASSWORD}"}}}}`,
      );
      const out = await projectUpdateTool.execute(args);
      expect(JSON.parse(out).error, bad).toContain(bad);
      expect(out).not.toContain("saved_secrets");
      expect(getProject("r6-proto")).toBeNull();
    }
  });
});

describe("queue 3b — legacy rows: stall_exempt is operator-only, aliases follow the record's alias rule", () => {
  const update = async (args: Record<string, unknown>) =>
    JSON.parse(await projectUpdateTool.execute(args)) as Record<string, unknown>;

  it("(a) stall_exempt set where the row had none → refused as operator-only, row unchanged", async () => {
    createProject("legacy-s", "Legacy S", { config: { phase: "one" } });
    const out = await update({ slug: "legacy-s", config: { stall_exempt: true, phase: "two" } });
    expect(String(out.error)).toContain("config.stall_exempt");
    expect(String(out.error)).toContain("solo lo cambia el operador");
    expect(getProject("legacy-s")!.config).toEqual({ phase: "one" });
    // A change from true to false is refused the same way.
    createProject("legacy-t", "Legacy T", { config: { stall_exempt: true } });
    const off = await update({ slug: "legacy-t", config: { stall_exempt: false } });
    expect(String(off.error)).toContain("config.stall_exempt");
    expect(getProject("legacy-t")!.config).toEqual({ stall_exempt: true });
  });

  it("(b) stall_exempt echoed with the row's own value → passes, the rest is written", async () => {
    createProject("legacy-e", "Legacy E", { config: { stall_exempt: true, phase: "one" } });
    const out = await update({ slug: "legacy-e", config: { stall_exempt: true, phase: "two" } });
    expect(out.error).toBeUndefined();
    expect(out.action).toBe("updated");
    expect(getProject("legacy-e")!.config).toEqual({ stall_exempt: true, phase: "two" });
  });

  it("(c) an alias shorter than MIN_ALIAS_CHARS → refused naming the index and the minimum, nothing written", async () => {
    createProject("legacy-a", "Legacy A", { config: { phase: "one" } });
    const out = await update({ slug: "legacy-a", name: "Renamed", config: { aliases: ["ab"], phase: "two" } });
    expect(String(out.error)).toContain("config.aliases[0]");
    expect(String(out.error)).toContain(String(MIN_ALIAS_CHARS));
    const row = getProject("legacy-a")!;
    expect(row.name).toBe("Legacy A");
    expect(row.config).toEqual({ phase: "one" });
    // The offending element is named by its own index, past a valid one; the
    // measure is the scope regex's (trimmed): "  abc " is 3 characters.
    const second = await update({ slug: "legacy-a", config: { aliases: ["alpha-four", "  abc "] } });
    expect(String(second.error)).toContain("config.aliases[1]");
    expect(getProject("legacy-a")!.config).toEqual({ phase: "one" });
    // Exactly the minimum passes.
    const edge = await update({ slug: "legacy-a", config: { aliases: ["abcd"] } });
    expect(edge.error).toBeUndefined();
    expect(getProject("legacy-a")!.config).toEqual({ phase: "one", aliases: ["abcd"] });
    // A create is the same legacy path: refused, no row.
    const created = await update({ slug: "brand-new-a", name: "N", config: { aliases: ["ab"] } });
    expect(String(created.error)).toContain("config.aliases[0]");
    expect(getProject("brand-new-a")).toBeNull();
  });

  it("(d) valid aliases → accepted and stored", async () => {
    createProject("legacy-d", "Legacy D", { config: { phase: "one" } });
    const out = await update({ slug: "legacy-d", config: { aliases: ["alpha-four", "beta-four"] } });
    expect(out.error).toBeUndefined();
    expect(getProject("legacy-d")!.config).toEqual({ phase: "one", aliases: ["alpha-four", "beta-four"] });
    // null still deletes the entry (the merge rule for every config key).
    const cleared = await update({ slug: "legacy-d", config: { aliases: null } });
    expect(cleared.error).toBeUndefined();
    expect(getProject("legacy-d")!.config).toEqual({ phase: "one" });
  });

  it("(e) a non-array, or a non-string element → refused, nothing written", async () => {
    createProject("legacy-n", "Legacy N", { config: { aliases: ["keep-this"] } });
    const out = await update({ slug: "legacy-n", config: { aliases: "notalist" } });
    expect(String(out.error)).toContain("config.aliases");
    const elem = await update({ slug: "legacy-n", config: { aliases: ["alpha-four", 7] } });
    expect(String(elem.error)).toContain("config.aliases[1]");
    const obj = await update({ slug: "legacy-n", config: { aliases: { 0: "alpha-four" } } });
    expect(String(obj.error)).toContain("config.aliases");
    expect(getProject("legacy-n")!.config).toEqual({ aliases: ["keep-this"] });
  });
});

describe("queue 3b (f) — a record-backed row keeps the record's own alias validation", () => {
  let kbDir: string;
  let prevMirror: string | undefined;
  const REL = projectRecordRelPath("acme-radar");
  const RECORD =
    "# Acme Radar\n\n```json\n" +
    JSON.stringify({ slug: "acme-radar", name: "Acme Radar", status: "active", aliases: ["acme"] }, null, 2) +
    "\n```\n\nSynthetic lead paragraph.\n";
  const recordAliases = () =>
    parseProjectRecord(String(getFile(REL)!.content), { folderSlug: "acme-radar" }).json.aliases;

  beforeEach(() => {
    kbDir = mkdtempSync(join(tmpdir(), "mc-proj3b-"));
    prevMirror = process.env.JARVIS_KB_MIRROR_DIR;
    process.env.JARVIS_KB_MIRROR_DIR = kbDir;
    upsertFromDiskWrite(REL, RECORD);
  });
  afterEach(() => {
    rmSync(kbDir, { recursive: true, force: true });
    if (prevMirror === undefined) delete process.env.JARVIS_KB_MIRROR_DIR;
    else process.env.JARVIS_KB_MIRROR_DIR = prevMirror;
  });

  it("a short alias is the record schema's call (min 1): stored in the record, no legacy refusal", async () => {
    const out = JSON.parse(await projectUpdateTool.execute({ slug: "acme-radar", config: { aliases: ["ab"] } }));
    expect(out.error).toBeUndefined();
    expect(out.record).toBe(REL);
    expect(recordAliases()).toEqual(["ab"]);
  });

  it("valid aliases go into the record", async () => {
    const out = JSON.parse(
      await projectUpdateTool.execute({ slug: "acme-radar", config: { aliases: ["alpha-four", "beta-four"] } }),
    );
    expect(out.error).toBeUndefined();
    expect(recordAliases()).toEqual(["alpha-four", "beta-four"]);
    expect(getProject("acme-radar")!.config.aliases).toEqual(["alpha-four", "beta-four"]);
  });

  it("a non-array is refused by the record validation, never by the legacy rule; nothing written", async () => {
    const out = JSON.parse(await projectUpdateTool.execute({ slug: "acme-radar", config: { aliases: "notalist" } }));
    expect(String(out.error)).toContain("inválido (aliases)");
    expect(String(out.error)).not.toContain("config.aliases");
    expect(String(getFile(REL)!.content)).toBe(RECORD);
  });

  it("stall_exempt is operator-only on the record path too (the check runs before the routing)", async () => {
    const out = JSON.parse(await projectUpdateTool.execute({ slug: "acme-radar", config: { stall_exempt: true } }));
    expect(String(out.error)).toContain("config.stall_exempt");
    expect(String(getFile(REL)!.content)).toBe(RECORD);
  });
});

describe("queue 3b audit folds — stored aliases are exempt; cap, invisible characters, NFC; refusal wording", () => {
  const update = async (args: Record<string, unknown>) =>
    JSON.parse(await projectUpdateTool.execute(args)) as Record<string, unknown>;

  it("W1: a stored short alias does not block adding a new one; only NEW elements are judged", async () => {
    createProject("legacy-jme", "Legacy JME", { config: { aliases: ["jme", "journal"] } });
    const add = await update({ slug: "legacy-jme", config: { aliases: ["jme", "journal", "memoria-jme"] } });
    expect(add.error).toBeUndefined();
    expect(getProject("legacy-jme")!.config.aliases).toEqual(["jme", "journal", "memoria-jme"]);
    // R2 audit W2: the echo must be byte-exact; " jme " is a NEW element (length 3).
    const padded = await update({ slug: "legacy-jme", config: { aliases: [" jme ", "journal"] } });
    expect(String(padded.error)).toContain("config.aliases[0]");
    const bad = await update({ slug: "legacy-jme", config: { aliases: ["jme", "ab"] } });
    expect(String(bad.error)).toContain("config.aliases[1]");
    expect(String(bad.error)).not.toContain("config.aliases[0]");
    expect(getProject("legacy-jme")!.config.aliases).toEqual(["jme", "journal", "memoria-jme"]);
    // A create has no stored aliases: every element is judged.
    const created = await update({ slug: "brand-new-jme", name: "N", config: { aliases: ["jme"] } });
    expect(String(created.error)).toContain("config.aliases[0]");
    expect(getProject("brand-new-jme")).toBeNull();
  });

  it("W2: the length is counted after NFC — three decomposed é are 3 characters", async () => {
    createProject("legacy-nfc", "Legacy NFC", { config: { phase: "one" } });
    const decomposed = "ééé";
    expect(decomposed.length).toBe(6);
    const out = await update({ slug: "legacy-nfc", config: { aliases: [decomposed] } });
    expect(String(out.error)).toContain("config.aliases[0]");
    expect(getProject("legacy-nfc")!.config).toEqual({ phase: "one" });
  });

  it("R1: at most 20 aliases — 20 accepted, 21 refused naming the cap; stored elements never count", async () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => `alias-${String(i).padStart(2, "0")}`);
    const ok = await update({ slug: "cap-twenty", name: "N", config: { aliases: list(20) } });
    expect(ok.error).toBeUndefined();
    expect(getProject("cap-twenty")!.config.aliases).toEqual(list(20));
    const over = await update({ slug: "cap-twenty", config: { aliases: [...list(20), "alias-new"] } });
    expect(String(over.error)).toContain("config.aliases[20]");
    expect(String(over.error)).toContain("20");
    expect(getProject("cap-twenty")!.config.aliases).toEqual(list(20));
    // R2 audit W1: the cap bounds the resulting list; the reason names the FIRST new element.
    const created = await update({ slug: "cap-21", name: "N", config: { aliases: list(21) } });
    expect(String(created.error)).toContain("config.aliases[0]");
    expect(getProject("cap-21")).toBeNull();
    // An operator-stored list longer than the cap echoes back fine.
    createProject("cap-stored", "Cap Stored", { config: { aliases: list(25) } });
    const echo = await update({ slug: "cap-stored", config: { aliases: list(25) } });
    expect(echo.error).toBeUndefined();
  });

  it("R2: a NEW element with a control or invisible character is refused by index; real scripts and emoji pass", async () => {
    createProject("legacy-inv", "Legacy Inv", { config: { aliases: ["a\nstored"] } });
    for (const bad of ["ab\u0000cd", "a\nbcd", "​".repeat(4), "abcd\u007f", "ab‍cd", "﻿abcd"]) {
      const out = await update({ slug: "legacy-inv", config: { aliases: ["alpha-four", bad] } });
      expect(String(out.error), JSON.stringify(bad)).toContain("config.aliases[1]");
    }
    expect(getProject("legacy-inv")!.config.aliases).toEqual(["a\nstored"]);
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const good = await update({ slug: "legacy-inv", config: { aliases: ["a\nstored", "東京都庁", family] } });
    expect(good.error).toBeUndefined();
    expect(getProject("legacy-inv")!.config.aliases).toEqual(["a\nstored", "東京都庁", family]);
  });

  it("S2: a row without a record is pointed at the exporter; a new slug too", async () => {
    createProject("legacy-s2", "Legacy S2", { config: { phase: "one" } });
    const out = await update({ slug: "legacy-s2", config: { stall_exempt: true } });
    expect(String(out.error)).toContain("config.stall_exempt");
    expect(String(out.error)).toContain("scripts/project-record-export.ts");
    expect(String(out.error)).not.toContain("project.md");
    const fresh = await update({ slug: "brand-new-s2", name: "N", config: { trusted: true } });
    expect(String(fresh.error)).toContain("scripts/project-record-export.ts");
  });
});

describe("queue 3b audit S2 — a record row keeps the record wording", () => {
  let kbDir: string;
  let prevMirror: string | undefined;
  beforeEach(() => {
    kbDir = mkdtempSync(join(tmpdir(), "mc-proj3b-s2-"));
    prevMirror = process.env.JARVIS_KB_MIRROR_DIR;
    process.env.JARVIS_KB_MIRROR_DIR = kbDir;
    upsertFromDiskWrite(
      projectRecordRelPath("acme-radar"),
      "# Acme Radar\n\n```json\n" +
        JSON.stringify({ slug: "acme-radar", name: "Acme Radar", status: "active" }, null, 2) +
        "\n```\n\nSynthetic lead paragraph.\n",
    );
  });
  afterEach(() => {
    rmSync(kbDir, { recursive: true, force: true });
    if (prevMirror === undefined) delete process.env.JARVIS_KB_MIRROR_DIR;
    else process.env.JARVIS_KB_MIRROR_DIR = prevMirror;
  });

  it("names projects/<slug>/project.md, not the exporter", async () => {
    const out = JSON.parse(await projectUpdateTool.execute({ slug: "acme-radar", config: { stall_exempt: true } }));
    expect(String(out.error)).toContain("projects/<slug>/project.md");
    expect(String(out.error)).not.toContain("project-record-export");
  });
});

describe("queue 3b R2 audit folds — cap bounds the result, byte-exact echo, Unicode-class invisibles", () => {
  const update = async (args: Record<string, unknown>) =>
    JSON.parse(await projectUpdateTool.execute(args)) as Record<string, unknown>;
  const list = (n: number) => Array.from({ length: n }, (_, i) => `alias-${String(i).padStart(2, "0")}`);

  it("W1: the cap bounds the RESULTING list at max(20, stored count); a stored list above it is echoed or shrunk, never grown", async () => {
    createProject("cap-25", "Cap 25", { config: { aliases: list(25) } });
    const prepend = await update({ slug: "cap-25", config: { aliases: ["fresh-one", ...list(25)] } });
    expect(String(prepend.error)).toContain("config.aliases[0]");
    expect(String(prepend.error)).toContain("20");
    expect(getProject("cap-25")!.config.aliases).toEqual(list(25));
    expect((await update({ slug: "cap-25", config: { aliases: list(25) } })).error).toBeUndefined();
    // R3 audit W1: repeating a STORED alias grows the list too: refused at the first index past the bound.
    const repeat = await update({ slug: "cap-25", config: { aliases: [...list(25), "alias-03"] } });
    expect(String(repeat.error)).toContain("config.aliases[25]");
    expect(getProject("cap-25")!.config.aliases).toEqual(list(25));
    createProject("cap-one", "Cap One", { config: { aliases: ["only-one"] } });
    const many = await update({ slug: "cap-one", config: { aliases: Array(500).fill("only-one") } });
    expect(String(many.error)).toContain("config.aliases[20]");
    expect(getProject("cap-one")!.config.aliases).toEqual(["only-one"]);
    // 18 stored + two equal NEW elements: 20, within the cap (duplicates are not judged).
    createProject("cap-18", "Cap 18", { config: { aliases: list(18) } });
    const dup = await update({ slug: "cap-18", config: { aliases: [...list(18), "fresh-one", "fresh-one"] } });
    expect(dup.error).toBeUndefined();
    // Swapping one stored alias for a new one keeps the length (25): allowed, the list does not grow.
    const swap = [...list(24), "fresh-one"];
    expect((await update({ slug: "cap-25", config: { aliases: swap } })).error).toBeUndefined();
    expect(getProject("cap-25")!.config.aliases).toEqual(swap);
    expect((await update({ slug: "cap-25", config: { aliases: list(24) } })).error).toBeUndefined();
    expect(getProject("cap-25")!.config.aliases).toEqual(list(24));

    createProject("cap-19", "Cap 19", { config: { aliases: list(19) } });
    const first = await update({ slug: "cap-19", config: { aliases: ["fresh-one", ...list(19)] } });
    expect(first.error).toBeUndefined();
    expect(getProject("cap-19")!.config.aliases).toHaveLength(20);

    createProject("cap-20", "Cap 20", { config: { aliases: list(20) } });
    const grow = await update({ slug: "cap-20", config: { aliases: ["fresh-one", ...list(20)] } });
    expect(String(grow.error)).toContain("config.aliases[0]");
    const growEnd = await update({ slug: "cap-20", config: { aliases: [...list(20), "fresh-one"] } });
    expect(String(growEnd.error)).toContain("config.aliases[20]");
    expect(getProject("cap-20")!.config.aliases).toEqual(list(20));
  });

  it("W2: only a byte-exact echo of a stored alias is exempt (trim() would let U+FEFF / tab / space ride in)", async () => {
    createProject("legacy-exact", "Legacy Exact", { config: { aliases: ["jme"] } });
    const bom = await update({ slug: "legacy-exact", config: { aliases: ["jme\ufeff"] } });
    expect(String(bom.error)).toContain("config.aliases[0] tiene un carácter de control o invisible");
    const tab = await update({ slug: "legacy-exact", config: { aliases: ["\tjme"] } });
    expect(String(tab.error)).toContain("config.aliases[0] tiene un carácter de control o invisible");
    // A trailing space is no longer an echo: judged as new, refused by length.
    const space = await update({ slug: "legacy-exact", config: { aliases: ["jme "] } });
    expect(String(space.error)).toContain(`config.aliases[0] tiene menos de ${MIN_ALIAS_CHARS} caracteres`);
    expect(getProject("legacy-exact")!.config.aliases).toEqual(["jme"]);
    expect((await update({ slug: "legacy-exact", config: { aliases: ["jme"] } })).error).toBeUndefined();
  });

  const ACCEPTED: Array<[string, string]> = [
    ["family ZWJ emoji", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}"],
    ["heart on fire", "\u2764\uFE0F\u200D\u{1F525}"],
    ["England subdivision flag", "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}"],
    ["regional-indicator flag + letters", "\u{1F1F2}\u{1F1FD}abcd"],
    ["CJK", "東京都庁"],
    ["U+FE0F after a pictograph, no ZWJ (sun)", "sol \u2600\uFE0F"],
    ["U+FE0F after a pictograph, no ZWJ (heart)", "\u2764\uFE0F rojo"],
  ];
  const REFUSED: Array<[string, string]> = [
    ["soft hyphen", "ab\u00ADcd"],
    ["RLO", "ab\u202Ecd"],
    ["LRM", "ab\u200Ecd"],
    ["lone tag character after letters", "abcd\u{E0041}"],
    ["NEL U+0085", "ab\u0085cd"],
    ["Hangul filler U+3164", "ab\u3164cd"],
    ["U+FE0F after letters", "abcd\uFE0F"],
    ["lone ZWJ", "\u200D\u200D\u200D\u200D"],
    ["word joiner U+2060", "ab\u2060cd"],
    ["BOM U+FEFF", "ab\uFEFFcd"],
    ["tab", "ab\tcd"],
    ["ZWJ between letters", "ab\u200Dcd"],
    ["skin-tone emoji + ZWJ + letter", "\u{1F44D}\u{1F3FD}\u200Dxyzw"],
    ["interlinear annotation anchor U+FFF9 (Cf, not default-ignorable)", "ab\uFFF9cd"],
  ];
  for (const [label, alias] of ACCEPTED) {
    it(`W3 accepted: ${label}`, async () => {
      const out = await update({ slug: "w3-ok", name: "N", config: { aliases: [alias] } });
      expect(out.error).toBeUndefined();
      expect(getProject("w3-ok")!.config.aliases).toEqual([alias]);
    });
  }
  for (const [label, alias] of REFUSED) {
    it(`W3 refused: ${label}`, async () => {
      const out = await update({ slug: "w3-bad", name: "N", config: { aliases: ["alpha-four", alias] } });
      expect(String(out.error)).toContain("config.aliases[1] tiene un carácter de control o invisible");
      expect(getProject("w3-bad")).toBeNull();
    });
  }
});

describe("queue 3l ruling A — project_update refuses a credential literal next to its name in config", () => {
  // Synthetic literals, assembled at runtime.
  const LIT = "synthetic-" + "lit".repeat(3);
  const HEX40 = "ab12".repeat(10);
  const PATHLIT = "/opt/" + "q".repeat(9);
  const update = async (args: Record<string, unknown>) =>
    JSON.parse(await projectUpdateTool.execute(args)) as Record<string, unknown>;

  const REFUSED: Array<[string, Record<string, unknown>, string]> = [
    ["{name: pgpassword, value}", { db_env: [{ name: "pgpassword", value: LIT }] }, "config.db_env.0.value"],
    ["{label: DB_PASS, default}", { opts: { label: "DB_PASS", default: LIT } }, "config.opts.default"],
    ["tuple [PGPASSWORD, v] inside env:[...]", { env: [["PGPASSWORD", LIT]] }, "config.env.0.1"],
    ["flat tuple env: [PGPASSWORD, v]", { env: ["PGPASSWORD", LIT] }, "config.env.1"],
    ["{PGPASSWORD: {value}} (the key names its object)", { pg: { PGPASSWORD: { value: LIT } } }, "config.pg.PGPASSWORD.value"],
    ["{PGPASSWORD: {value}} at the config root", { PGPASSWORD: { value: LIT } }, "config.PGPASSWORD.value"],
    ["single DB_PASS=value string", { run: "DB_PASS=" + LIT }, "config.run"],
    ["DB_PASS=value inside a list", { env: ["DB_PASS = " + LIT] }, "config.env.0"],
    ["40-hex under a neutral key next to x_api_key", { hdr: { h: "x_api_key", data: HEX40 } }, "config.hdr.data"],
    ["path-shaped literal next to PGPASSWORD (no URL/path exemption)", { db_env: [{ name: "PGPASSWORD", value: PATHLIT }] }, "config.db_env.0.value"],
    ["URL-shaped literal next to a name", { db_env: [{ name: "PG_PASS", value: "https://example.invalid/x" }] }, "config.db_env.0.value"],
    ["8-digit number next to a name", { db_env: [{ name: "PIN_KEY", value: 12345678 }] }, "config.db_env.0.value"],
    ["a stored-reference placeholder as the value (the reference form is {name, secret})", { db_env: [{ name: "PGPASSWORD", value: "{{SECRET_ACME_X}}" }] }, "config.db_env.0.value"],
    ["{api_keys: [v]} (a secret-value key names its list)", { api_keys: [LIT] }, "config.api_keys.0"],
    // Audit C1: a SECRET_<NAME> spelling is a NAME unless held as a reference by position.
    ["{name: SECRET_KEY, value}", { env: [{ name: "SECRET_KEY", value: "synthetic-insecure-" + "q".repeat(10) }] }, "config.env.0.value"],
    ["tuple [SECRET_KEY_BASE, 64 chars]", { env: [["SECRET_KEY_BASE", "q".repeat(64)]] }, "config.env.0.1"],
    ["{SECRET_KEY: {value}}", { SECRET_KEY: { value: "q".repeat(14) } }, "config.SECRET_KEY.value"],
    ["SECRET_KEY=value string", { run: "SECRET_KEY=hunter2" + "hunter2" }, "config.run"],
    // Audit W1: a padded name is trimmed before the name test.
    ["leading-space name", { env: [{ name: " PGPASSWORD", value: LIT }] }, "config.env.0.value"],
    ["trailing-tab name", { env: [["PGPASSWORD\t", LIT]] }, "config.env.0.1"],
    // Audit W4: an env-shaped key that is not a secret-value name labels its list; the 8-char boundary.
    ["{PGAUTHX: [v]} (env-shaped key names its list)", { PGAUTHX: [LIT] }, "config.PGAUTHX.0"],
    ["exactly 8 chars next to a name", { db_env: [{ name: "PGPASSWORD", value: "q".repeat(8) }] }, "config.db_env.0.value"],
    // Audit R2 C2: the reference form exempts only the non-value members from a member name.
    ["{name, secret: SECRET_X, value}", { e: [{ name: "PGPASSWORD", secret: "SECRET_ACME_X", value: LIT }] }, "config.e.0.value"],
    ["{name, Secret: SECRET_X, value}", { e: [{ name: "PGPASSWORD", Secret: "SECRET_ACME_X", value: LIT }] }, "config.e.0.value"],
    ["{name: SECRET_KEY, secret: SECRET_X, value}", { e: [{ name: "SECRET_KEY", secret: "SECRET_ACME_X", value: LIT }] }, "config.e.0.value"],
    ["{name, secret: SECRET_X, \" value\"} (padded value key)", { e: [{ name: "PGPASSWORD", secret: "SECRET_ACME_X", " value": LIT }] }, "config.e.0. value"],
    ["{name, secret: SECRET_X, pw} (secret-value key)", { e: [{ name: "PGPASSWORD", secret: "SECRET_ACME_X", pw: LIT }] }, "config.e.0.pw"],
    ["{name, secret: SECRET_X, auth_header} (fragment key)", { e: [{ name: "PGPASSWORD", secret: "SECRET_ACME_X", auth_header: LIT }] }, "config.e.0.auth_header"],
    ["{PGPASSWORD: {secret: SECRET_X, v}} (parent label kept)", { PGPASSWORD: { secret: "SECRET_ACME_X", v: LIT } }, "config.PGPASSWORD.v"],
    // Audit R2 W1: only a 2-element tuple holds a reference; in a 3-element one SECRET_X is a name,
    // so PGPASSWORD itself is the first literal judged (env.0.0), before the literal at env.0.2.
    ["3-element tuple [PGPASSWORD, SECRET_X, v]", { env: [["PGPASSWORD", "SECRET_ACME_X", LIT]] }, "config.env.0.0"],
  ];

  it("refuses each known shape on UPDATE, names path + {name, secret}, never echoes the literal, row unchanged", async () => {
    createProject("lit-up", "Lit Up", { config: { phase: "live" } });
    for (const [what, config, where] of REFUSED) {
      const out = await update({ slug: "lit-up", config });
      const err = String(out.error);
      expect(err, what).toContain(`No guardé: ${where} `);
      expect(err, what).toContain("{name, secret}");
      expect(err, what).not.toContain(LIT);
      expect(err, what).not.toContain(HEX40);
      expect(err, what).not.toContain(PATHLIT);
      expect(getProject("lit-up")!.config, what).toEqual({ phase: "live" });
    }
  });

  it("refuses on CREATE too: no row is written", async () => {
    for (const [what, config] of REFUSED) {
      const out = await update({ slug: "lit-new", name: "Lit New", config });
      expect(String(out.error), what).toContain("{name, secret}");
      expect(getProject("lit-new"), what).toBeNull();
    }
  });

  it("judges the MERGED config: a name and a literal sent in two calls are refused; an unchanged stored pair does not block other edits", async () => {
    createProject("lit-split", "Lit Split", { config: { db: { name: "PGPASSWORD" }, root_name: "x" } });
    const split = await update({ slug: "lit-split", config: { db: { value: LIT } } });
    expect(String(split.error)).toContain("No guardé: config.db.value ");
    const rootSplit = await update({ slug: "lit-split", config: { value: LIT, name: "PG_PASS" } });
    expect(String(rootSplit.error)).toContain("No guardé: config.value ");
    expect(getProject("lit-split")!.config).toEqual({ db: { name: "PGPASSWORD" }, root_name: "x" });
    // A legacy row that already holds a pair: an unrelated edit passes, a NEW literal at the same path does not.
    createProject("lit-legacy", "Lit Legacy", { config: { db: { name: "PGPASSWORD", value: LIT } } });
    expect((await update({ slug: "lit-legacy", config: { phase: "beta" } })).error).toBeUndefined();
    expect((await update({ slug: "lit-legacy", config: { db: { note: "x" } } })).error).toBeUndefined();
    const changed = await update({ slug: "lit-legacy", config: { db: { value: LIT + "2" } } });
    expect(String(changed.error)).toContain("No guardé: config.db.value ");
    expect((getProject("lit-legacy")!.config.db as Record<string, unknown>).value).toBe(LIT);
  });

  it("queue 4p ruling (c): a spaced title next to a date is stored, not refused", async () => {
    const out = await update({ slug: "lit-4p", name: "Lit 4p", config: { title: "Passport renewal", date: "2026-10-18" } });
    expect(String(out.error ?? "")).not.toContain("No guardé");
    expect(getProject("lit-4p")!.config).toEqual({ title: "Passport renewal", date: "2026-10-18" });
  });

  it("queue 4p ruling (a): a refusal logs path, fragment and slug only, never the value", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await update({ slug: "lit-log", config: { opts: { label: "DB_PASS", default: LIT } } });
      const lines = warn.mock.calls.map((c) => c.map(String).join(" "));
      expect(lines).toContain("[projects] 3l write gate refused config.opts.default (fragment PASS) for lit-log");
      expect(lines.join("\n")).not.toContain(LIT);
    } finally {
      warn.mockRestore();
    }
  });

  it("names the matched fragment in the reason", async () => {
    const out = await update({ slug: "lit-frag", config: { opts: { label: "DB_PASS", default: LIT } } });
    expect(out.error).toBe(
      'No guardé: config.opts.default es un valor literal junto a un nombre con "PASS" (forma de credencial); guarda el valor en credentials y usa la referencia {name, secret}, no un valor literal.',
    );
  });

  it("accepts the reference form, a name with no gated sibling, short values, and ordinary prose pairs", async () => {
    const ACCEPTED: Array<[string, Record<string, unknown>]> = [
      ["{name, secret: ref-id}", { db_env: [{ name: "PGPASSWORD", secret: "ref-id" }] }],
      ["{name, secret: SECRET_<NAME>}", { db_env: [{ name: "PGPASSWORD", secret: "SECRET_ACME_PG_PASSWORD" }] }],
      ["names with no gated sibling", { db_env: [{ name: "PGPASSWORD" }], meta: { label: "DB_PASS", n: "short" } }],
      ["7-char string", { db_env: [{ name: "PGPASSWORD", value: "1234567" }] }],
      ["7-char string (q×7)", { db_env: [{ name: "PGPASSWORD", value: "q".repeat(7) }] }],
      // Audit W3: an object holding a `secret` reference is the reference form; its host is not judged.
      ["{name, secret: SECRET_X, host}", { e: [{ name: "DB_PASSWORD", secret: "SECRET_DB", host: "db.example.invalid" }] }],
      ["{name, Secret: SECRET_X} (any case)", { e: [{ name: "DB_PASSWORD", Secret: "SECRET_ACME_DB_PASSWORD" }] }],
      ["bare tuple [NAME, SECRET_X]", { env: [["PGPASSWORD", "SECRET_ACME_PG_PASSWORD"]] }],
      ["7-digit number", { db_env: [{ name: "PGPASSWORD", value: 1234567 }] }],
      ["author/description pair", { author: "Persona Ejemplo", description: "Notas largas del proyecto de ejemplo" }],
      ["a data list under an ordinary key", { keywords: ["cafeteria centro", "tostador artesanal"] }],
      ["a neutral pair", { db_env: [{ name: "PG_HOST", value: "db.example.invalid" }] }],
    ];
    for (const [what, config] of ACCEPTED) {
      const out = await update({ slug: "lit-ok", name: "Lit Ok", config });
      expect(out.error, what).toBeUndefined();
    }
    expect(getProject("lit-ok")!.config.db_env).toEqual([{ name: "PG_HOST", value: "db.example.invalid" }]);
  });
});
