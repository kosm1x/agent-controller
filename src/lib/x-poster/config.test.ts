import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  listXAccounts,
  getAccountCreds,
  getDefaultAccount,
  resolveAccount,
  normalizeHandle,
  isCookieConfigured,
  anyXAccountConfigured,
  getProbeUrl,
  findConfiguredHandleInText,
  recordXAccounts,
  currentXAccountScope,
} from "./config.js";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import { enterRunToolContext } from "../../tools/rule-of-two.js";
import { _resetCapabilityTracesForTests, recordGatedToolScope, withAttributedTask } from "../../projects/capabilities.js";

const X_KEYS = Object.keys(process.env).filter((k) => k.startsWith("X_"));
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of X_KEYS) saved[k] = process.env[k];
  // Clear any ambient X_* so the host env can't leak into assertions.
  for (const k of Object.keys(process.env))
    if (k.startsWith("X_")) delete process.env[k];
});

afterEach(() => {
  for (const k of Object.keys(process.env))
    if (k.startsWith("X_")) delete process.env[k];
  for (const [k, v] of Object.entries(saved))
    if (v !== undefined) process.env[k] = v;
});

describe("normalizeHandle", () => {
  it("lowercases and strips a leading @", () => {
    expect(normalizeHandle("@LookIn4ward")).toBe("lookin4ward");
    expect(normalizeHandle("  MexicoNecesario ")).toBe("mexiconecesario");
  });
});

describe("listXAccounts", () => {
  it("discovers per-handle auth_token pairs (case-insensitive handle)", () => {
    process.env.X_AUTH_TOKEN__lookin4ward = "a";
    process.env.X_CT0__lookin4ward = "b";
    process.env.X_AUTH_TOKEN__mexiconecesario = "c";
    process.env.X_CT0__mexiconecesario = "d";
    expect(listXAccounts()).toEqual(["lookin4ward", "mexiconecesario"]);
  });

  it("ignores a handle whose auth_token is empty", () => {
    process.env.X_AUTH_TOKEN__ghost = "   ";
    expect(listXAccounts()).toEqual([]);
  });

  it("maps a bare X_AUTH_TOKEN to the default account", () => {
    process.env.X_AUTH_TOKEN = "a";
    process.env.X_CT0 = "b";
    process.env.X_DEFAULT_ACCOUNT = "lookin4ward";
    expect(listXAccounts()).toEqual(["lookin4ward"]);
  });

  it("a bare pair with NO X_DEFAULT_ACCOUNT is the synthetic 'default' account (not invisible)", () => {
    // W1 guard: this is the exact migration state (bare pair, no default) — it
    // must NOT silently read as "not configured" (the original-incident class).
    process.env.X_AUTH_TOKEN = "a";
    process.env.X_CT0 = "b";
    expect(listXAccounts()).toEqual(["default"]);
    expect(getDefaultAccount()).toBe("default");
    expect(anyXAccountConfigured()).toBe(true);
    expect(isCookieConfigured(getAccountCreds("default"))).toBe(true);
  });
});

describe("getDefaultAccount / resolveAccount", () => {
  it("uses X_DEFAULT_ACCOUNT when set", () => {
    process.env.X_AUTH_TOKEN__a = "1";
    process.env.X_AUTH_TOKEN__b = "1";
    process.env.X_DEFAULT_ACCOUNT = "@B";
    expect(getDefaultAccount()).toBe("b");
    expect(resolveAccount()).toBe("b");
    expect(resolveAccount("a")).toBe("a"); // explicit wins
  });

  it("falls back to the sole account when no default is set", () => {
    process.env.X_AUTH_TOKEN__only = "1";
    expect(getDefaultAccount()).toBe("only");
  });

  it("is undefined when multiple accounts and no explicit default", () => {
    process.env.X_AUTH_TOKEN__a = "1";
    process.env.X_AUTH_TOKEN__b = "1";
    expect(getDefaultAccount()).toBeUndefined();
    expect(resolveAccount()).toBeUndefined();
  });
});

describe("resolveAccount fuzzy match (iooking/looking l↔I typo class)", () => {
  beforeEach(() => {
    process.env.X_AUTH_TOKEN__iooking4ward = "a";
    process.env.X_CT0__iooking4ward = "b";
    process.env.X_AUTH_TOKEN__mexiconecesario = "c";
    process.env.X_CT0__mexiconecesario = "d";
  });

  it("maps a near-miss handle to the unique configured account", () => {
    expect(resolveAccount("looking4ward")).toBe("iooking4ward"); // l→i (dist 1)
    expect(resolveAccount("lookin4ward")).toBe("iooking4ward"); // l→i + missing g (dist 2)
    expect(resolveAccount("@Looking4ward")).toBe("iooking4ward"); // cased + @
    expect(resolveAccount("mexiconecesari")).toBe("mexiconecesario"); // dist 1
  });

  it("never overrides an EXACT configured handle", () => {
    expect(resolveAccount("iooking4ward")).toBe("iooking4ward");
    expect(resolveAccount("@MexicoNecesario")).toBe("mexiconecesario");
  });

  it("returns the input unchanged when too far / too short / ambiguous (lets noAccountError fire)", () => {
    expect(resolveAccount("garbage")).toBe("garbage"); // distance > 2 from both
    expect(resolveAccount("x")).toBe("x"); // length < 5 → no fuzzy attempt
  });

  it("does not fuzzy-bind when two configured accounts are equally near (ambiguous)", () => {
    // Wipe and seed two handles within dist 2 of the probe → must NOT pick one.
    for (const k of Object.keys(process.env))
      if (k.startsWith("X_")) delete process.env[k];
    process.env.X_AUTH_TOKEN__bcdef = "1";
    process.env.X_AUTH_TOKEN__abcde = "1";
    expect(resolveAccount("abcdef")).toBe("abcdef"); // dist 1 to both → ambiguous → unchanged
  });
});

describe("findConfiguredHandleInText (scope activation on a named account)", () => {
  beforeEach(() => {
    process.env.X_AUTH_TOKEN__iooking4ward = "a";
    process.env.X_CT0__iooking4ward = "b";
    process.env.X_AUTH_TOKEN__mexiconecesario = "c";
    process.env.X_CT0__mexiconecesario = "d";
  });

  it("finds an exact @handle / handle mention (no X keyword needed)", () => {
    expect(findConfiguredHandleInText("Verifica @iooking4ward")).toBe(
      "iooking4ward",
    );
    expect(findConfiguredHandleInText("postea en mexiconecesario hoy")).toBe(
      "mexiconecesario",
    );
  });

  it("finds a near-miss handle (l↔I typo class)", () => {
    expect(findConfiguredHandleInText("revisa @lookin4ward")).toBe(
      "iooking4ward",
    );
    expect(findConfiguredHandleInText("acceso a looking4ward")).toBe(
      "iooking4ward",
    );
  });

  it("does NOT match the project name 'México Necesario' (two tokens ≠ handle)", () => {
    expect(
      findConfiguredHandleInText("abre el proyecto México Necesario"),
    ).toBeUndefined();
    expect(
      findConfiguredHandleInText("reporte de mexico necesario"),
    ).toBeUndefined();
  });

  it("does NOT match unrelated text / short tokens / the 'x = variable' idiom", () => {
    expect(
      findConfiguredHandleInText("cuenta de ahorro para x meses"),
    ).toBeUndefined();
    expect(
      findConfiguredHandleInText("dame el status del crm"),
    ).toBeUndefined();
  });

  it("returns undefined when no accounts are configured", () => {
    for (const k of Object.keys(process.env))
      if (k.startsWith("X_")) delete process.env[k];
    expect(
      findConfiguredHandleInText("Verifica @iooking4ward"),
    ).toBeUndefined();
  });
});

describe("getProbeUrl", () => {
  it("defaults to the badge_count endpoint (v1.1 verify_credentials was retired by X)", () => {
    expect(getProbeUrl()).toContain("/2/badge_count/badge_count.json");
  });
  it("is overridable via X_PROBE_URL (survives X's next API move without a code change)", () => {
    process.env.X_PROBE_URL = "https://example.test/probe";
    expect(getProbeUrl()).toBe("https://example.test/probe");
  });
});

describe("getAccountCreds", () => {
  it("resolves a handle's tokens", () => {
    process.env.X_AUTH_TOKEN__lookin4ward = "tok";
    process.env.X_CT0__lookin4ward = "csrf";
    const creds = getAccountCreds("lookin4ward");
    expect(creds).toMatchObject({
      handle: "lookin4ward",
      authToken: "tok",
      ct0: "csrf",
    });
    expect(isCookieConfigured(creds)).toBe(true);
  });

  it("uses the bare-var fallback only for the default account", () => {
    process.env.X_AUTH_TOKEN = "tok";
    process.env.X_CT0 = "csrf";
    process.env.X_DEFAULT_ACCOUNT = "lookin4ward";
    expect(getAccountCreds("lookin4ward")).toMatchObject({
      authToken: "tok",
      ct0: "csrf",
    });
    expect(getAccountCreds("mexiconecesario")).toBeNull(); // bare does NOT leak to non-default
  });

  it("returns null for an unconfigured handle", () => {
    process.env.X_AUTH_TOKEN__a = "1";
    expect(getAccountCreds("nope")).toBeNull();
  });

  it("anyXAccountConfigured reflects presence", () => {
    expect(anyXAccountConfigured()).toBe(false);
    process.env.X_AUTH_TOKEN__a = "1";
    expect(anyXAccountConfigured()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// S6 ruling 5b — an X account is reached only through the task's project record
// ---------------------------------------------------------------------------

/** Synthetic values: every test asserts none of them reaches a log line. */
const VALUES = {
  newsTok: "tok-news-0123456789",
  newsCt0: "ct0-news-0123456789",
  deskTok: "tok-desk-0123456789",
  deskCt0: "ct0-desk-0123456789",
  brandTok: "tok-brand-0123456789",
  brandCt0: "ct0-brand-0123456789",
  strayTok: "tok-stray-0123456789",
  strayCt0: "ct0-stray-0123456789",
};
const xSecrets = (...handles: string[]) =>
  handles.flatMap((h) => [`SECRET_X_AUTH_TOKEN__${h}`, `SECRET_X_CT0__${h}`]);

function seedDb(projects: Array<{ slug: string; config: Record<string, unknown> }>): void {
  initDatabase(":memory:");
  const db = getDatabase();
  const p = db.prepare("INSERT INTO projects (id, slug, name, status, config) VALUES (?, ?, ?, 'active', ?)");
  for (const [i, pr] of projects.entries()) p.run(`p${i}`, pr.slug, pr.slug, JSON.stringify(pr.config));
  const t = db.prepare("INSERT INTO tasks (task_id, title, description, project_slug) VALUES (?, 't', 'd', ?)");
  t.run("t-news", "acme-news");
  t.run("t-brand", "acme-brand");
  t.run("t-plain", "acme-plain");
  t.run("t-null", null);
}

function seedEnv(): void {
  process.env.X_AUTH_TOKEN__acmenews = VALUES.newsTok;
  process.env.X_CT0__acmenews = VALUES.newsCt0;
  process.env.X_AUTH_TOKEN__AcmeDesk = VALUES.deskTok; // env suffix case differs from the record
  process.env.X_CT0__AcmeDesk = VALUES.deskCt0;
  process.env.X_AUTH_TOKEN__acmebrand = VALUES.brandTok;
  process.env.X_CT0__acmebrand = VALUES.brandCt0;
  process.env.X_AUTH_TOKEN__strayacct = VALUES.strayTok; // env-only: no record declares it
  process.env.X_CT0__strayacct = VALUES.strayCt0;
}

const inRun = <T>(taskId: string, fn: () => T): T => enterRunToolContext(taskId, fn);

describe("recordXAccounts (pure)", () => {
  it("derives handles from the __<HANDLE> suffix of SECRET_X_* names; ignores every other name", () => {
    const m = recordXAccounts([
      ...xSecrets("ACMENEWS"),
      "SECRET_X_API_BEARER__ACMENEWS",
      "SECRET_X_AUTH_TOKEN__ACME_DESK",
      "SECRET_ACME_NEWS_PG_PASSWORD",
      "SECRET_X_AUTH_TOKEN_ACMENEWS", // single underscore: not an account name
      42,
    ]);
    expect([...m.keys()].sort()).toEqual(["acme_desk", "acmenews"]);
    expect([...m.get("acmenews")!].sort()).toEqual(["API_BEARER", "AUTH_TOKEN", "CT0"]);
    expect([...m.get("acme_desk")!]).toEqual(["AUTH_TOKEN"]);
    expect(recordXAccounts(undefined).size).toBe(0);
  });
});

describe("S6 ruling 5b — record-declared X accounts", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    seedEnv();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    closeDatabase();
    vi.restoreAllMocks();
  });
  const logged = () => [...logSpy.mock.calls, ...warnSpy.mock.calls].map((c) => c.map(String).join(" "));
  const noValueLogged = () => {
    for (const line of logged()) for (const v of Object.values(VALUES)) expect(line).not.toContain(v);
  };

  describe("records declare accounts", () => {
    beforeEach(() =>
      seedDb([
        { slug: "acme-news", config: { secrets: [...xSecrets("ACMENEWS", "ACMEDESK"), "SECRET_ACME_NEWS_DB_PASSWORD"] } },
        { slug: "acme-brand", config: { secrets: xSecrets("ACMEBRAND") } },
        { slug: "acme-plain", config: { aliases: ["plain"] } },
      ]),
    );

    it("a record with two handles: exactly those two accounts, no env-only or other-project account", () => {
      expect(inRun("t-news", () => listXAccounts())).toEqual(["acmedesk", "acmenews"]);
      expect(inRun("t-news", () => getAccountCreds("acmenews"))).toMatchObject({
        authToken: VALUES.newsTok,
        ct0: VALUES.newsCt0,
      });
      expect(inRun("t-news", () => getAccountCreds("acmebrand"))).toBeNull();
      expect(inRun("t-news", () => getAccountCreds("strayacct"))).toBeNull();
      expect(inRun("t-news", () => anyXAccountConfigured())).toBe(true);
      expect(inRun("t-brand", () => listXAccounts())).toEqual(["acmebrand"]);
      expect(inRun("t-brand", () => getDefaultAccount())).toBe("acmebrand"); // the sole one
      noValueLogged();
    });

    it("a near-miss handle never fuzzes onto another project's account", () => {
      expect(inRun("t-news", () => resolveAccount("acmebrnd"))).toBe("acmebrnd"); // unresolved → caller errors
      expect(inRun("t-brand", () => resolveAccount("acmebrnd"))).toBe("acmebrand");
    });

    it("X_DEFAULT_ACCOUNT counts only when the run's project declares it", () => {
      process.env.X_DEFAULT_ACCOUNT = "acmebrand";
      expect(inRun("t-news", () => getDefaultAccount())).toBeUndefined(); // two own accounts, default not one
      expect(inRun("t-brand", () => getDefaultAccount())).toBe("acmebrand");
      process.env.X_DEFAULT_ACCOUNT = "acmenews";
      expect(inRun("t-news", () => getDefaultAccount())).toBe("acmenews");
    });

    it("a project without accounts, or an unattributed task, reaches none", () => {
      for (const t of ["t-plain", "t-null", "t-missing-row"]) {
        expect(inRun(t, () => listXAccounts())).toEqual([]);
        expect(inRun(t, () => getAccountCreds("acmenews"))).toBeNull();
        expect(inRun(t, () => getDefaultAccount())).toBeUndefined();
      }
      expect(inRun("t-plain", () => currentXAccountScope())).toMatchObject({ mode: "record", slug: "acme-plain" });
    });

    it("reads only the env names the record declares", () => {
      getDatabase()
        .prepare("UPDATE projects SET config = ? WHERE slug = 'acme-brand'")
        .run(JSON.stringify({ secrets: ["SECRET_X_AUTH_TOKEN__ACMEBRAND"] }));
      const creds = inRun("t-brand", () => getAccountCreds("acmebrand"));
      expect(creds?.authToken).toBe(VALUES.brandTok);
      expect(creds?.ct0).toBeUndefined(); // X_CT0__acmebrand is set but not declared
    });

    it("outside a run (probe cron, boot): every env-configured account, no trace", () => {
      expect(listXAccounts()).toEqual(["acmebrand", "acmedesk", "acmenews", "strayacct"]);
      expect(logged().filter((l) => l.includes("env-keyed fallback"))).toEqual([]);
    });

    it("no fallback trace while records declare accounts", () => {
      inRun("t-plain", () => listXAccounts());
      expect(logged().filter((l) => l.includes("env-keyed fallback"))).toEqual([]);
    });
  });

  describe("no record declares an X account (today): env-keyed fallback", () => {
    beforeEach(() =>
      seedDb([
        { slug: "acme-news", config: { secrets: ["SECRET_ACME_NEWS_DB_PASSWORD"] } },
        { slug: "acme-plain", config: {} },
      ]),
    );

    it("keeps every env account and logs ONE fallback line per task, names only", () => {
      const all = ["acmebrand", "acmedesk", "acmenews", "strayacct"];
      expect(inRun("t-plain", () => listXAccounts())).toEqual(all);
      expect(inRun("t-plain", () => getAccountCreds("strayacct"))?.authToken).toBe(VALUES.strayTok);
      inRun("t-plain", () => listXAccounts());
      expect(inRun("t-null", () => listXAccounts())).toEqual(all);
      const lines = logged().filter((l) => l.includes("env-keyed fallback"));
      expect(lines).toEqual([
        "[x-poster] no record-declared accounts for project acme-plain; env-keyed fallback",
        "[x-poster] no record-declared accounts for project none; env-keyed fallback",
      ]);
      noValueLogged();
    });
  });

  it("a db error inside a run fails closed (no account)", () => {
    seedDb([]);
    closeDatabase();
    expect(inRun("t-news", () => listXAccounts())).toEqual([]);
    expect(inRun("t-news", () => getAccountCreds("acmenews"))).toBeNull();
    noValueLogged();
  });
});

describe("WS3b R1 fold — attribution to no task, shared handles, corrupt records, trace events", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    seedEnv();
    _resetCapabilityTracesForTests();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    closeDatabase();
    vi.restoreAllMocks();
  });
  const logged = () => [...logSpy.mock.calls, ...warnSpy.mock.calls].map((c) => c.map(String).join(" "));
  const traces = (name: string) =>
    (
      getDatabase().prepare("SELECT task_id, tool, attrs FROM task_trace_events WHERE name = ? ORDER BY id").all(name) as Array<{
        task_id: string;
        tool: string | null;
        attrs: string;
      }>
    ).map((r) => ({ ...r, attrs: JSON.parse(r.attrs) as Record<string, unknown> }));
  const noValueAnywhere = () => {
    const rows = getDatabase().prepare("SELECT attrs FROM task_trace_events").all() as Array<{ attrs: string | null }>;
    for (const text of [...logged(), ...rows.map((r) => r.attrs ?? "")])
      for (const v of Object.values(VALUES)) expect(text).not.toContain(v);
  };

  it("W1: attribution to NO task never falls back to the ambient run's task; record mode = no account, env mode = fallback", () => {
    seedDb([
      { slug: "acme-news", config: { secrets: xSecrets("ACMENEWS") } },
      { slug: "acme-brand", config: { secrets: xSecrets("ACMEBRAND") } },
    ]);
    expect(inRun("t-news", () => withAttributedTask(null, () => listXAccounts()))).toEqual([]);
    expect(withAttributedTask(null, () => listXAccounts())).toEqual([]);
    expect(withAttributedTask("t-brand", () => listXAccounts())).toEqual(["acmebrand"]);
    expect(withAttributedTask(null, () => recordGatedToolScope("crm_query"))).toEqual({ mode: "fallback", offered: true, slug: null });
    closeDatabase();
    seedDb([{ slug: "acme-plain", config: {} }]);
    expect(withAttributedTask(null, () => listXAccounts())).toEqual(["acmebrand", "acmedesk", "acmenews", "strayacct"]);
    expect(traces("capability.scope").map((t) => [t.task_id, t.attrs.mode])).toEqual([["attribution:none", "fallback"]]);
    noValueAnywhere();
  });

  it("W3: a handle two records declare warns ONCE per process (slugs + handle only); both still reach it", () => {
    seedDb([
      { slug: "acme-news", config: { secrets: xSecrets("ACMENEWS", "ACMESHARED") } },
      { slug: "acme-brand", config: { secrets: xSecrets("ACMESHARED") } },
    ]);
    process.env.X_AUTH_TOKEN__acmeshared = "tok-shared-0123456789";
    process.env.X_CT0__acmeshared = "ct0-shared-0123456789";
    expect(inRun("t-news", () => listXAccounts())).toEqual(["acmenews", "acmeshared"]);
    expect(inRun("t-brand", () => listXAccounts())).toEqual(["acmeshared"]);
    const warned = logged().filter((l) => l.includes("acmeshared"));
    expect(warned).toEqual([
      "[x-poster] X account acmeshared is declared by 2 project records (acme-brand, acme-news); each of them reaches it",
    ]);
    expect(traces("capability.handle_shared")).toEqual([
      { task_id: "project-records", tool: null, attrs: { handle: "acmeshared", slugs: ["acme-brand", "acme-news"] } },
    ]);
    for (const l of logged()) expect(l).not.toMatch(/tok-shared|ct0-shared/);
    noValueAnywhere();
  });

  it("W5: an unparseable config row forces record mode (fail closed), contributes nothing, and is named once", () => {
    seedDb([{ slug: "acme-news", config: {} }]);
    getDatabase()
      .prepare("INSERT INTO projects (id, slug, name, status, config) VALUES ('pc', 'acme-corrupt', 'c', 'active', ?)")
      .run('{"secrets": ["SECRET_X_AUTH_TOKEN__ACMENEWS"');
    expect(inRun("t-news", () => listXAccounts())).toEqual([]);
    expect(inRun("t-news", () => currentXAccountScope())).toMatchObject({ mode: "record", slug: "acme-news" });
    expect(inRun("t-news", () => recordGatedToolScope("crm_query"))).toEqual({ mode: "record", offered: false, slug: "acme-news" });
    expect(logged().filter((l) => l.includes("acme-corrupt"))).toEqual([
      "[projects] project acme-corrupt: config is not valid JSON; record mode forced, nothing reachable through it",
    ]);
    expect(traces("capability.record_invalid")).toEqual([
      { task_id: "project-records", tool: null, attrs: { slug: "acme-corrupt" } },
    ]);
    noValueAnywhere();
  });

  it("S1: fallback, refusal and record-scope decisions each emit one capability.scope event per task (names only)", () => {
    seedDb([
      { slug: "acme-news", config: { secrets: xSecrets("ACMENEWS") } },
      { slug: "acme-plain", config: {} },
    ]);
    inRun("t-news", () => listXAccounts());
    inRun("t-news", () => listXAccounts());
    inRun("t-plain", () => listXAccounts());
    inRun("t-plain", () => recordGatedToolScope("crm_query"));
    inRun("t-plain", () => recordGatedToolScope("crm_query"));
    getDatabase()
      .prepare("UPDATE projects SET config = ? WHERE slug = 'acme-news'")
      .run(JSON.stringify({ capabilities: { tools: ["crm_query"] } }));
    inRun("t-plain", () => recordGatedToolScope("crm_query"));
    inRun("t-plain", () => recordGatedToolScope("crm_query"));
    expect(traces("capability.scope").map((t) => ({ task: t.task_id, tool: t.tool, attrs: t.attrs }))).toEqual([
      { task: "t-news", tool: null, attrs: { slug: "acme-news", mode: "record", handles: ["acmenews"] } },
      { task: "t-plain", tool: null, attrs: { slug: "acme-plain", mode: "record", handles: [] } },
      { task: "t-plain", tool: "crm_query", attrs: { slug: "acme-plain", mode: "fallback", tool: "crm_query" } },
      { task: "t-plain", tool: "crm_query", attrs: { slug: "acme-plain", mode: "record", tool: "crm_query" } },
    ]);
    noValueAnywhere();
  });
});
