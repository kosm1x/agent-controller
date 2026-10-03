/**
 * Ruling 3b (2026-10-01, "same treatment now"): the `projects` store gets the
 * user-facts credential treatment — project_get masks credential-style
 * entries and no project output carries a credential value.
 * Ruling 3c (2026-10-01): project_update STORES credentials (the 3b refusal is
 * gone); each is shown by its by-name placeholder and used by that name.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
      config: { deploy: { notes: "api_key=" + FAKE_GOOGLE_KEY }, phase: "beta" },
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
      deploy: { notes: "api_key=" + FAKE_GOOGLE_KEY },
    });
    expect(after.urls.repo).toBe(FAKE_URL_WITH_USERINFO);
    const r = resolveSecretRefs("http_fetch", {
      url: "{{SECRET_LEGACY_URLS_REPO}}",
      body: "{{SECRET_LEGACY_CONFIG_DEPLOY_NOTES}}",
    });
    expect(r).toEqual({
      args: { url: FAKE_URL_WITH_USERINFO, body: "api_key=" + FAKE_GOOGLE_KEY },
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

  it("allows blanking an existing credential entry ('' or null)", async () => {
    seedLegacy();
    const out = await projectUpdateTool.execute({
      slug: "legacy",
      credentials: { wp_app_password: "", acme_api_key: null },
    });
    expect(JSON.parse(out).action).toBe("updated");
    expect(out).not.toContain("saved_secrets");
    const after = getProject("legacy")!;
    expect(after.credentials.wp_app_password).toBe("");
    expect(after.credentials.acme_api_key).toBeNull();
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
