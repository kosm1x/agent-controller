import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  userFactSetTool,
  userFactListTool,
  userFactDeleteTool,
} from "./user-facts.js";
import {
  invalidateSecretRefs,
  secretEnvForCommand,
  secretPlaceholder,
} from "../../lib/secret-refs.js";
import { passwordFingerprint } from "../../lib/v8-4/password-gate.js";
import {
  _resetStoreWithhold,
  setStoreSeenCheck,
} from "../../lib/v8-4/store-withhold.js";

// Real db/user-facts module, mocked database.
const mockDb = { prepare: vi.fn() };
vi.mock("../../db/index.js", () => ({ getDatabase: () => mockDb }));

// Synthetic, assembled at runtime (public repo; commit hook scans literals).
const FAKE_GOOGLE_KEY = "AIza" + "d".repeat(35);
const SYN = (tag: string) => `syn-${tag}-` + "v".repeat(8);
const GA_ID = "G-" + "T".repeat(10);

// Ruling 3c: user_fact_set STORES a credential (the ruling-3 refusal is
// gone) and confirms it by its by-name placeholder, never the value.
describe("user_fact_set (ruling 3c)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // A tiny fake user_facts table: INSERT appends, SELECT returns the rows.
  function fakeStore() {
    const rows: Array<Record<string, string>> = [];
    const run = vi.fn((category: string, key: string, value: string) => {
      rows.push({
        category,
        key,
        value,
        source: "conversation",
        updated_at: "2026-10-01 12:00:00",
      });
    });
    mockDb.prepare.mockImplementation(() => ({ run, all: () => rows }));
    return run;
  }

  it.each([
    ["a cookie by name", "acme_espn_s2", "AE" + "Q".repeat(40), "SECRET_PROJECTS_ACME_ESPN_S2"],
    ["a password by name", "blog_password", SYN("pass"), "SECRET_PROJECTS_BLOG_PASSWORD"],
    ["a key-shaped value under a neutral name", "gemini_setup", FAKE_GOOGLE_KEY, "SECRET_PROJECTS_GEMINI_SETUP"],
  ])("stores %s and confirms it by its placeholder, never the value", async (_l, key, value, name) => {
    const run = fakeStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await userFactSetTool.execute({ category: "projects", key, value });
    expect(out).toBe(
      `Fact stored: [projects] ${key} = ${secretPlaceholder(name)}. This will be included in all future conversations.`,
    );
    expect(out).not.toContain(value);
    expect(run).toHaveBeenCalledWith("projects", key, value, "conversation");
    expect(warn).not.toHaveBeenCalled();
    // Listed masked, usable by name.
    const list = await userFactListTool.execute({});
    expect(list).toContain(`[projects] ${key}: ${secretPlaceholder(name)}`);
    expect(list).not.toContain(value);
    expect(secretEnvForCommand(`echo "$${name}"`)).toEqual({ [name]: value });
  });

  it("overwriting a stored credential stores the new value, echoes neither", async () => {
    const run = fakeStore();
    await userFactSetTool.execute({
      category: "projects",
      key: "blog_password",
      value: SYN("old"),
    });
    const out = await userFactSetTool.execute({
      category: "projects",
      key: "blog_password",
      value: SYN("new"),
    });
    expect(out).not.toContain(SYN("old"));
    expect(out).not.toContain(SYN("new"));
    expect(run).toHaveBeenLastCalledWith(
      "projects",
      "blog_password",
      SYN("new"),
      "conversation",
    );
  });

  it("stores a non-credential fact exactly as before", async () => {
    const run = vi.fn();
    mockDb.prepare.mockReturnValue({ run, all: () => [] });
    const out = await userFactSetTool.execute({
      category: "projects",
      key: "blog_ga4_id",
      value: GA_ID,
    });
    expect(out).toBe(
      `Fact stored: [projects] blog_ga4_id = ${GA_ID}. This will be included in all future conversations.`,
    );
    expect(run).toHaveBeenCalledWith(
      "projects",
      "blog_ga4_id",
      GA_ID,
      "conversation",
    );
  });

  // Audit round 5 (B2): a stored credential written back BY NAME keeps its value.
  describe("audit R5 B2 — by-name write-back", () => {
    const OLD = "SECRET_PROJECTS_ACME_FTP_PASSWORD";
    async function seedOld(run: ReturnType<typeof fakeStore>) {
      await userFactSetTool.execute({
        category: "projects",
        key: "acme_ftp_password",
        value: SYN("ftp"),
      });
      invalidateSecretRefs();
      run.mockClear();
    }

    it.each([
      ["its placeholder", () => secretPlaceholder(OLD)],
      ["{{SECRET_X}}", () => `{{${OLD}}}`],
      ["$SECRET_X", () => `$${OLD}`],
    ])("moving a fact by %s stores the VALUE under the new key", async (_l, ref) => {
      const run = fakeStore();
      await seedOld(run);
      const out = await userFactSetTool.execute({
        category: "projects",
        key: "acme_sftp_password",
        value: ref(),
      });
      expect(run).toHaveBeenCalledWith(
        "projects",
        "acme_sftp_password",
        SYN("ftp"),
        "conversation",
      );
      expect(out).not.toContain(SYN("ftp"));
      expect(out).toContain("[oculto ·");
    });

    it("an unknown name is refused; nothing is stored", async () => {
      const run = fakeStore();
      await seedOld(run);
      const out = await userFactSetTool.execute({
        category: "projects",
        key: "acme_sftp_password",
        value: "{{SECRET_PROJECTS_NOPE}}",
      });
      expect(JSON.parse(out).error).toContain("SECRET_PROJECTS_NOPE");
      expect(run).not.toHaveBeenCalled();
    });

    it("placeholder-ish garbage (a placeholder inside other text, a cut placeholder) is refused; nothing is stored", async () => {
      const run = fakeStore();
      await seedOld(run);
      for (const value of [
        `user=demo pass=${secretPlaceholder(OLD)}`,
        secretPlaceholder(OLD).slice(0, 25),
      ]) {
        const out = await userFactSetTool.execute({
          category: "projects",
          key: "acme_sftp_password",
          value,
        });
        expect(JSON.parse(out).error, value).toContain("{{SECRET_<NOMBRE>}}");
      }
      expect(run).not.toHaveBeenCalled();
    });

    it("a move to a key that would show the value is refused (no laundering into a visible fact)", async () => {
      const run = fakeStore();
      await seedOld(run);
      const out = await userFactSetTool.execute({
        category: "projects",
        key: "acme_notes",
        value: `{{${OLD}}}`,
      });
      expect(JSON.parse(out).error).toContain("[projects] acme_notes");
      expect(run).not.toHaveBeenCalled();
    });
  });

  it("the description again invites credentials (no refusal, no .env)", () => {
    const d = userFactSetTool.definition.function.description;
    expect(d).toContain(
      "- The user provides technical data: API keys, measurement IDs, credentials, configuration values, URLs, access tokens",
    );
    expect(d).not.toContain(".env");
    expect(d).not.toContain("refuses");
  });
});

describe("user_fact_list (Ruling 3)", () => {
  beforeEach(() => vi.clearAllMocks());

  const row = (key: string, value: string) => ({
    category: "projects",
    key,
    value,
    source: "conversation",
    updated_at: "2026-09-30 12:00:00",
  });

  it("masks a credential fact with its by-name placeholder; no .env hint (ruling 3c)", async () => {
    mockDb.prepare.mockReturnValue({
      all: vi
        .fn()
        .mockReturnValue([
          row("acme_api_key", FAKE_GOOGLE_KEY),
          row("acme_espn_s2", SYN("cookie")),
          row("blog_url", "https://blog.example.test"),
        ]),
    });
    invalidateSecretRefs();
    const out = await userFactListTool.execute({});
    expect(out).toContain(
      `[projects] acme_api_key: ${secretPlaceholder("SECRET_PROJECTS_ACME_API_KEY")}`,
    );
    expect(out).toContain(
      `[projects] acme_espn_s2: ${secretPlaceholder("SECRET_PROJECTS_ACME_ESPN_S2")}`,
    );
    expect(out).toContain(
      "[projects] blog_url: https://blog.example.test",
    );
    expect(out).not.toContain(FAKE_GOOGLE_KEY);
    expect(out).not.toContain(SYN("cookie"));
    expect(out).not.toContain(".env");
    expect(out.split("\n")).toHaveLength(3);
  });

  it("W4: masks a neutral-named fact whose VALUE is credential-shaped", async () => {
    mockDb.prepare.mockReturnValue({
      all: vi
        .fn()
        .mockReturnValue([row("site_config", `usa ${FAKE_GOOGLE_KEY}`)]),
    });
    invalidateSecretRefs();
    const out = await userFactListTool.execute({});
    expect(out).toContain(
      `[projects] site_config: ${secretPlaceholder("SECRET_PROJECTS_SITE_CONFIG")}`,
    );
    expect(out).not.toContain(FAKE_GOOGLE_KEY);
  });

  it("adds no hint when nothing is masked", async () => {
    mockDb.prepare.mockReturnValue({
      all: vi
        .fn()
        .mockReturnValue([row("blog_url", "https://blog.example.test")]),
    });
    const out = await userFactListTool.execute({});
    expect(out).not.toContain(".env");
    expect(out.split("\n")).toHaveLength(1);
  });
});

// Store rule: a value the mailbox tool printed is not a user fact. The
// tool refuses it, writes nothing and leaves an existing row as it was, so
// the secret-reference index never learns the value.
describe("user_fact_set — mailbox password", () => {
  afterEach(() => {
    _resetStoreWithhold();
    invalidateSecretRefs();
    vi.restoreAllMocks();
  });

  it("refuses a value the mailbox tool printed: nothing written, the existing row kept, no index entry", async () => {
    const pw = "FakeTestPassWordXYZ2345";
    const fp = passwordFingerprint(pw);
    setStoreSeenCheck({ size: () => 1, has: (f) => f === fp });
    const prior = SYN("prior");
    const rows = [
      {
        category: "projects",
        key: "buzon_password",
        value: prior,
        source: "conversation",
        updated_at: "2026-10-01 12:00:00",
      },
    ];
    const run = vi.fn();
    mockDb.prepare.mockImplementation(() => ({ run, all: () => rows }));
    invalidateSecretRefs();

    const out = await userFactSetTool.execute({
      category: "projects",
      key: "buzon_password",
      value: pw,
    });
    expect(JSON.parse(out)).toEqual({
      error:
        "No guardo contraseñas de buzón como dato del usuario: la contraseña vigente sale solo de la herramienta del buzón (stalwart-inbox vía shell_exec). Ejecútala para obtenerla.",
    });
    expect(out).not.toContain(pw);
    expect(run).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe(prior);
    invalidateSecretRefs();
    const name = "SECRET_PROJECTS_BUZON_PASSWORD";
    const env = secretEnvForCommand(`echo "$${name}"`);
    expect(env).toEqual({ [name]: prior });
    expect(JSON.stringify(env)).not.toContain(pw);
  });
});

// Whole-text pins: these descriptions are what the model reads when it
// chooses a tool. No handler is called.
describe("user_fact_list and user_fact_delete — description text", () => {
  it("user_fact_list: the whole description, with its not-for block", () => {
    expect(userFactListTool.definition.function.description).toBe(`List all stored personal facts about the user, optionally filtered by category.

USE WHEN:
- The user asks "what do you know about me?"
- You need to verify what facts are already stored before saving new ones
- The user wants to review or audit their stored profile

DO NOT USE WHEN:
- You need the value of a stored credential: this tool shows a fact it detects as a credential only as a placeholder, never the value itself.
- You want the user's projects or their status: this tool lists stored facts, not the project records — use project_list when it is among your tools.
- You want something from an earlier conversation or a stored memory: this tool reads only the stored facts — use memory_search when it is among your tools.`);
  });

  it("user_fact_delete: the whole description, with its not-for block", () => {
    expect(userFactDeleteTool.definition.function.description).toBe(`Delete a stored personal fact. Use when the user explicitly asks to remove a fact or when a fact is no longer accurate and should be removed rather than updated.

DO NOT USE WHEN:
- The fact only changed (a new value, a correction): this tool removes the fact rather than updating it — use user_fact_set when it is among your tools (same category and key).
- The thing to forget is a knowledge-graph fact or a stored correction, not a stored user fact: this tool deletes only the fact with this exact category and key — use memory_forget when it is among your tools.
- You are not sure of the exact key: this tool deletes only an exact category and key match and nothing otherwise — use user_fact_list when it is among your tools to check them first.`);
  });
});
