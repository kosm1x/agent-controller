import { describe, it, expect, beforeEach, vi , afterEach } from "vitest";
import {
  setUserFact,
  getUserFacts,
  deleteUserFact,
  formatUserFactsBlock,
  isCredentialFact,
  CREDENTIAL_FACT_PLACEHOLDER,
} from "./user-facts.js";
import {
  invalidateSecretRefs,
  secretEnvForCommand,
  secretPlaceholder,
} from "../lib/secret-refs.js";

// Synthetic credential shapes, assembled at runtime (never a key-shaped
// literal in source — the repo is public and a commit hook scans for them).
const FAKE_GOOGLE_KEY = "AIza" + "b".repeat(35);
const FAKE_GH_TOKEN = "gh" + "p_" + "c".repeat(36);
const SYN_EMAIL = ["demo", "example.invalid"].join("@");
const SYN_PASS = "syn-" + "p".repeat(10);
const SYN_WIFI = "syn-" + "w".repeat(12);

// Mock getDatabase to return an in-memory SQLite instance
const mockDb = {
  prepare: vi.fn(),
};

vi.mock("./index.js", () => ({
  getDatabase: () => mockDb,
}));

describe("user-facts", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("setUserFact", () => {
    it("should upsert a fact with correct params", () => {
      const runMock = vi.fn();
      mockDb.prepare.mockReturnValue({ run: runMock });

      setUserFact("personal", "age", "30", "conversation");

      expect(mockDb.prepare).toHaveBeenCalledOnce();
      const sql = mockDb.prepare.mock.calls[0][0] as string;
      expect(sql).toContain("INSERT INTO user_facts");
      expect(sql).toContain("ON CONFLICT");
      expect(runMock).toHaveBeenCalledWith(
        "personal",
        "age",
        "30",
        "conversation",
      );
    });
  });

  describe("Ruling 3c: credential facts are stored (refusal removed)", () => {
    function dbRecording() {
      const rows: Array<{ category: string; key: string; value: string }> =
        [];
      const run = vi.fn((category: string, key: string, value: string) => {
        rows.push({ category, key, value });
      });
      mockDb.prepare.mockImplementation(() => ({
        run,
        all: () => rows,
      }));
      return run;
    }

    it.each([
      ["a credential-named fact", "projects", "acme_portal_password", SYN_PASS],
      ["a credential-shaped value under a neutral name", "projects", "gemini_setup", FAKE_GOOGLE_KEY],
      ["a credential inside prose", "work", "notes", `el repo usa ${FAKE_GH_TOKEN} para CI`],
    ])("writes %s like any other fact, without a warning", (_l, category, key, value) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const run = dbRecording();
      setUserFact(category, key, value);
      expect(run).toHaveBeenCalledWith(category, key, value, "conversation");
      expect(warn).not.toHaveBeenCalled();
    });

    it("once stored, it is shown by name and resolvable by that name", () => {
      dbRecording();
      setUserFact("projects", "gemini_setup", FAKE_GOOGLE_KEY, "auto-detected");
      const block = formatUserFactsBlock();
      expect(block).toContain(
        `- **gemini_setup**: ${secretPlaceholder("SECRET_PROJECTS_GEMINI_SETUP")}`,
      );
      expect(block).not.toContain(FAKE_GOOGLE_KEY);
      expect(
        secretEnvForCommand("curl -H \"x-goog-api-key: $SECRET_PROJECTS_GEMINI_SETUP\" x"),
      ).toEqual({ SECRET_PROJECTS_GEMINI_SETUP: FAKE_GOOGLE_KEY });
    });
  });

  describe("isCredentialFact", () => {
    it.each([
      ["projects", "maps_api_key"],
      ["projects", "quotes_api_key"],
      ["projects", "apiKey"],
      ["projects", "census_api_token"],
      ["projects", "x_auth_token__acct"],
      ["projects", "acme_auth_token"],
      ["projects", "acme_portal_password"],
      ["projects", "blog_wp_app_password_new"],
      ["projects", "db_passwd"],
      ["projects", "router_pwd"],
      ["projects", "stripe_client_secret"],
      ["projects", "deploy_private_key"],
      ["projects", "session_cookie"],
      ["projects", "github_oauth"],
      ["projects", "bearer"],
      ["projects", "service_api_credential"],
      ["projects", "contraseña_wp"],
      ["projects", "clave_api"],
      ["projects", "credenciales_ftp"],
      ["projects", "acme_espn_s2"],
      ["projects", "acme_swid"],
      ["projects", "x_ct0__acct"],
      ["secrets", "anything"],
      // Fold 1 (audit W2/W4)
      ["projects", "wpPassword"],
      ["projects", "wp_pass"],
      ["projects", "app_pw"],
      ["projects", "db_service_key"],
      ["projects", "signing_key"],
      ["projects", "master_key"],
      ["projects", "encryption_key"],
      ["projects", "license_key"],
      ["projects", "admin_key"],
      ["projects", "stripe_key"],
      ["projects", "openai_key"],
      ["projects", "gemini_key"],
      ["projects", "sessionid"],
      ["projects", "session_id"],
      ["projects", "sid"],
      ["projects", "connect_sid"],
      ["projects", "phpsessid"],
      ["projects", "li_at"],
      ["projects", "llave_api"],
      ["projects", "pin"],
      ["projects", "clave"],
      ["projects", "clave_acceso_sat"],
      ["projects", "clave_wifi"],
      // Ruling 3d: cookie names stored bare under a project's credentials
      ["projects", "s2"],
      ["projects", "session"],
      ["projects", "pass"],
      ["projects", "passwd"],
      ["projects", "apikey"],
      ["projects", "secret"],
      ["projects", "token"],
      ["projects", "key"],
      ["projects", "cookie"],
      ["projects", "auth"],
    ])("marks %s/%s by name", (category, key) => {
      expect(isCredentialFact(category, key, "plain value")).toBe(true);
    });

    it.each([
      ["personal", "author"],
      ["projects", "token_budget"],
      ["projects", "max_tokens"],
      ["projects", "keyboard_layout"],
      ["projects", "monkey_name"],
      ["projects", "palabras_clave"],
      ["projects", "local_brain_context_budget"],
      ["projects", "login"],
      ["personal", "CURP"],
      ["projects", "blog_ga4_id"],
      ["projects", "acme_espn_league_id"],
      ["projects", "signal_digest_2026-09-30"],
      // Fold 1: a neutral name ending in a vocabulary word (W4)
      ["projects", "bypass"],
      ["projects", "compass"],
      ["projects", "turkey"],
      ["projects", "whiskey"],
      // Fold 1: excluded `key` / `sid` positions (W2)
      ["projects", "public_key"],
      ["projects", "primary_key"],
      ["projects", "foreign_key"],
      ["projects", "sort_key"],
      ["projects", "partition_key"],
      ["projects", "cache_key"],
      ["projects", "hot_key"],
      ["projects", "short_key"],
      ["projects", "key_results"],
      ["projects", "license_key_count"],
      ["projects", "sid_meier"],
      ["projects", "session_notes"],
      // Fold 1: `clave` only last or before api/acceso/secreta/privada/wifi (W3)
      ["projects", "clave_interbancaria"],
      ["projects", "clave_elector"],
      ["projects", "clave_catastral"],
      ["projects", "clave_producto"],
      ["projects", "clave_unica"],
      // Fold 1: last token is metadata about a credential (W3); the value
      // must have that metadata's type since audit R5 S4 (see below)
      ["projects", "auth_method"],
      ["projects", "oauth_provider"],
      ["projects", "jwt_issuer"],
      ["projects", "credential_rotation_date"],
      ["projects", "token_type"],
      ["projects", "password_expiry"],
      ["projects", "cookie_expires"],
      // Ruling 3d: the whole-name `s2` / `session` rule stays narrow, and
      // what a project's credentials usually hold besides secrets is visible
      ["projects", "sessions"],
      ["projects", "session_timeout"],
      ["projects", "last_session"],
      ["projects", "s2_region"],
      ["projects", "username"],
      ["projects", "email"],
      ["projects", "ftp_host"],
      ["projects", "ftp_user"],
      ["projects", "wp_user"],
      ["projects", "port"],
      ["projects", "ga4_measurement_id"],
      ["projects", "client_id"],
      ["projects", "site_url"],
    ])("does not mark %s/%s by name", (category, key) => {
      expect(isCredentialFact(category, key, "plain value")).toBe(false);
    });

    // Fold 1 (audit C1): shapes redactCredentials misses, under a neutral
    // name. Every key-shaped literal is assembled at runtime.
    const rnd = (n: number) => "Qx7Lm2Vb9Zt4Rk8Np3Wd".repeat(10).slice(0, n);
    it.each([
      ["JWT", "ey" + "J" + rnd(20) + ".ey" + "J" + rnd(40) + "." + rnd(43)],
      ["Stripe sk_live", "sk" + "_live_" + rnd(30)],
      ["Stripe rk_test", "rk" + "_test_" + rnd(30)],
      ["Stripe pk_live", "pk" + "_live_" + rnd(30)],
      ["GitHub fine-grained", "github" + "_pat_" + rnd(60)],
      ["GitHub gho", "gh" + "o_" + rnd(36)],
      ["GitHub ghs", "gh" + "s_" + rnd(36)],
      ["Slack xoxp", "xo" + "xp-" + rnd(40)],
      ["AWS AKIA", "AK" + "IA" + "ABCDEFGHIJKLMNOP"],
      ["Fireworks", "fw" + "_" + rnd(30)],
      ["URL userinfo ftp", "ftp://demo:" + rnd(14) + "@ftp.example.com/"],
      ["URL userinfo https", "https://user:" + rnd(14) + "@example.com"],
      ["bare Bearer", "Bearer " + rnd(40)],
      ["api key label", "api key: " + rnd(32)],
      ["token label", "token: " + rnd(32)],
      ["password label", "password: " + rnd(14)],
      ["contraseña label", "contraseña: " + rnd(14)],
      ["clave label", "clave: " + rnd(14)],
      ["JSON token", JSON.stringify({ token: rnd(32) })],
      ["JSON auth_token", JSON.stringify({ auth_token: rnd(40) })],
      ["JSON password", JSON.stringify({ password: rnd(14) })],
      ["inside prose", "mi config usa " + "sk" + "_live_" + rnd(30) + " ok"],
    ])("marks a %s value under a neutral name", (_label, value) => {
      expect(isCredentialFact("projects", "site_config", value)).toBe(true);
    });

    it.each([
      ["plain prose", "hola mundo, la clave del éxito es la constancia"],
      ["URL without userinfo", "https://example.com/a:b/c"],
      ["short label value", "token: abc"],
      ["email", SYN_EMAIL],
      ["bearer prose", "bearer bonds are instruments"],
    ])("does not mark a %s value", (_label, value) => {
      expect(isCredentialFact("projects", "site_config", value)).toBe(false);
    });

    it("a metadata-named fact is still judged by value", () => {
      expect(
        isCredentialFact("projects", "auth_method", "Bearer " + rnd(40)),
      ).toBe(true);
    });

    it("marks a credential-shaped value, not a git SHA", () => {
      expect(isCredentialFact("projects", "setup", FAKE_GOOGLE_KEY)).toBe(true);
      expect(isCredentialFact("projects", "last_commit", "a".repeat(40))).toBe(
        false,
      );
    });

    // Audit round 4 (3d-b): whole-token names the classifier missed.
    describe("audit R4 3d-b", () => {
      it.each([
        "api_keys", "access_keys", "apiKeys", "github_api_keys", "tokens",
        "github_tokens", "authorization", "authorization_header", "privkey",
        "appkey", "nip", "bank_nip", "otp", "totp", "totp_secret_code", "mfa",
        "mfa_code", "2fa", "2fa_code", "seed", "wallet_seed", "mnemonic",
        "recovery_codes", "backup_codes", "github_backup_code", "dsn",
        "sentry_dsn",
      ])("marks projects/%s by name", (key) => {
        expect(isCredentialFact("projects", key, "plain value")).toBe(true);
      });

      it.each([
        "keyword", "keywords", "monkeys", "seed_url", "seeds_file",
        "otp_enabled", "key_id", "public_key",
        "ssh_public_key", "public_keys", "max_tokens", "input_tokens",
        "random_seed", "turkey", "snippet", "dsnap",
      ])("does not mark the neighbour projects/%s by name", (key) => {
        expect(isCredentialFact("projects", key, "plain value")).toBe(false);
      });

      it("meta-suffix convention: a credential name ending in a metadata token (enabled/region/host/url/file) is visible by name when its value has that type, still judged by value", () => {
        for (const [k, v] of [
          ["mfa_enabled", "true"],
          ["token_url", "https://oauth2.example.com/token"],
          ["password_file", "/etc/app/secret.txt"],
          ["dsn_region", "us-east-1"],
          ["nip_region", "mx-central-1"],
          ["dsn_host", "db.example.com:5432"],
          ["alphavantage_api_key_path", "~/.config/av/key.txt"],
        ]) {
          expect(isCredentialFact("projects", k!, v!), k).toBe(false);
        }
        expect(
          isCredentialFact("projects", "token_url", "Bearer " + rnd(40)),
        ).toBe(true);
      });

      const pem = (label: string) =>
        "-----" + "BEGIN " + label + "-----\n" + rnd(64) + "\n-----" + "END " + label + "-----";
      it.each([
        "PRIVATE KEY",
        "RSA PRIVATE KEY",
        "EC PRIVATE KEY",
        "OPENSSH PRIVATE KEY",
        "ENCRYPTED PRIVATE KEY",
      ])("marks a PEM %s value under a neutral name", (label) => {
        expect(isCredentialFact("projects", "site_config", pem(label))).toBe(true);
      });

      it.each(["PUBLIC KEY", "RSA PUBLIC KEY", "CERTIFICATE"])(
        "does not mark a PEM %s value",
        (label) => {
          expect(isCredentialFact("projects", "site_config", pem(label))).toBe(
            false,
          );
        },
      );
    });

    // Audit round 5: fewer false positives (the global scrub blanks a
    // false positive's value everywhere — ruling 3d "everything accessible")
    // and fewer false negatives.
    describe("audit R5 S2 — position-bound words and exclusions", () => {
      it.each([
        "otp", "mfa", "2fa", "seed", "authorization", "bank_otp", "wallet_seed",
        "mfa_code", "2fa_codes", "otp_secret", "seed_phrase", "mfa_backup",
        "authorization_header", "authorization_token", "2fa_key", "seed_seed",
      ])("marks projects/%s by name", (key) => {
        expect(isCredentialFact("projects", key, "plain value")).toBe(true);
      });

      it.each([
        "design_tokens", "context_tokens", "css_tokens", "color_tokens",
        "translation_keys", "required_keys", "shortcut_keys", "object_keys",
        "index_keys", "mfa_device", "mfa_app", "2fa_phone", "otp_phone",
        "authorization_status", "prior_authorization", "seed_command",
        "seed_data", "otp_provider_name", "mfa_methods",
      ])("does not mark projects/%s by name (false-positive replay)", (key) => {
        expect(isCredentialFact("projects", key, "plain value")).toBe(false);
      });
    });

    describe("audit R5 S3 — names and value shapes the classifier missed", () => {
      it.each([
        "accesstoken", "authtoken", "secretkey", "apitoken", "privatekey",
        "refreshtoken", "sessiontoken", "passcode", "pincode", "pregunta_secreta",
        "respuesta_secreta", "frase_semilla", "codigos_respaldo", "codigo_acceso",
        "recovery_phrase", "cvv", "cvc", "card_cvv", "github_accesstoken",
      ])("marks projects/%s by name", (key) => {
        expect(isCredentialFact("projects", key, "plain value")).toBe(true);
      });

      it.each([
        "codigo_postal", "codigo_producto", "pregunta_frecuente", "frase_favorita",
        "recovery_email", "passenger", "tokenizer", "keystone",
      ])(
        "does not mark the neighbour projects/%s by name",
        (key) => {
          expect(isCredentialFact("projects", key, "plain value")).toBe(false);
        },
      );

      const b64 = (n: number) => "Ab3dE5gH7jK9mN1pQ2sT4vW6yZ8".repeat(8).slice(0, n);
      const hex = (n: number) => "0a1b2c3d4e5f6789".repeat(8).slice(0, n);
      const label = (l: string) => "-----" + "BEGIN " + l + "-----";
      it.each([
        ["PGP private key block", label("PGP PRIVATE KEY BLOCK") + "\n" + b64(64)],
        ["PuTTY private key", "PuTTY-User-Key-File-" + "3: ssh-ed25519\nPrivate-Lines: 1\n" + b64(40)],
        ["Google ya29 token", "ya" + "29." + b64(60)],
        ["Google 1// refresh token", "1/" + "/0" + b64(40)],
        ["Hugging Face", "hf" + "_" + b64(34)],
        ["npm", "np" + "m_" + b64(36)],
        ["SendGrid", "S" + "G." + b64(22) + "." + b64(43)],
        ["Shopify shpat", "shp" + "at_" + hex(32)],
        ["Shopify shpss", "shp" + "ss_" + hex(32)],
        ["URL userinfo with an empty user", "redis://" + ":" + b64(16) + "@cache.example.com:6379"],
      ])("marks a %s value under a neutral name", (_l, value) => {
        expect(isCredentialFact("projects", "site_config", value)).toBe(true);
      });

      it.each([
        ["PGP public key block", label("PGP PUBLIC KEY BLOCK") + "\n" + b64(64)],
        ["prose about PuTTY", "use PuTTY to connect to the host"],
        ["ya29 prose", "ya29 is a token prefix"],
        ["a URL path with 1//", "https://example.com/v1//0abc"],
        ["short hf_", "hf_model"],
        ["npm prose", "run npm_install later"],
        ["SG. abbreviation", "SG.com is a site; SG.x"],
        ["shpat_ too short", "shp" + "at_" + hex(10)],
        ["redis URL without password", "redis://cache.example.com:6379"],
        ["a time with colons", "10:30:00@office"],
      ])("does not mark a %s value", (_l, value) => {
        expect(isCredentialFact("projects", "site_config", value)).toBe(false);
      });
    });

    describe("audit R5 S4 — a meta suffix exempts only a value of its type", () => {
      it.each([
        ["token_url", "https://oauth2.example.com/token"],
        ["auth_url", "https://login.example.com/authorize?client=web"],
        ["password_file", "/run/secrets/db_password"],
        ["api_key_path", "C:\\keys\\maps.txt"],
        ["db_password_host", "db.internal.example.com"],
        ["secret_host", "127.0.0.1:8200"],
        ["otp_secret_enabled", "false"],
        ["mfa_code_enabled", "sí"],
        ["api_key_region", "europe-west4"],
        ["token_type", "Bearer"],
        ["password_expiry", "2026-12-31"],
      ])("%s = %s stays visible", (key, value) => {
        expect(isCredentialFact("projects", key, value)).toBe(false);
      });

      const run = "Zq8" + "x7Lm2Vb9Zt4Rk8Np3Wd";
      it.each([
        ["token_url", run],
        ["token_url", "https://api.example.com/cb?token=" + run],
        ["password_file", "hunter-" + "two-pass"],
        ["api_key_path", "/keys/" + run + ".txt"],
        ["db_password_host", "not a host name"],
        ["otp_secret_enabled", run],
        ["api_key_region", "Pa55word99"],
        ["token_type", run],
        ["password_expiry", run],
      ])("%s = %s is a secret", (key, value) => {
        expect(isCredentialFact("projects", key, value)).toBe(true);
      });

      it("a container key (no scalar value) with a meta suffix is not an ancestor", () => {
        expect(isCredentialFact("projects", "api_key_path", "")).toBe(false);
      });
    });
  });

  describe("getUserFacts", () => {
    it("should query all facts when no category", () => {
      const allMock = vi.fn().mockReturnValue([
        {
          category: "personal",
          key: "age",
          value: "30",
          source: "conversation",
          updated_at: "2026-03-18",
        },
      ]);
      mockDb.prepare.mockReturnValue({ all: allMock });

      const facts = getUserFacts();

      expect(facts).toHaveLength(1);
      expect(facts[0].key).toBe("age");
      const sql = mockDb.prepare.mock.calls[0][0] as string;
      expect(sql).not.toContain("WHERE category");
    });

    it("should filter by category when provided", () => {
      const allMock = vi.fn().mockReturnValue([]);
      mockDb.prepare.mockReturnValue({ all: allMock });

      getUserFacts("health");

      expect(allMock).toHaveBeenCalledWith("health");
      const sql = mockDb.prepare.mock.calls[0][0] as string;
      expect(sql).toContain("WHERE category = ?");
    });
  });

  describe("deleteUserFact", () => {
    it("should return true when a fact was deleted", () => {
      const runMock = vi.fn().mockReturnValue({ changes: 1 });
      mockDb.prepare.mockReturnValue({ run: runMock });

      const result = deleteUserFact("personal", "age");

      expect(result).toBe(true);
      expect(runMock).toHaveBeenCalledWith("personal", "age");
    });

    it("should return false when no fact matched", () => {
      const runMock = vi.fn().mockReturnValue({ changes: 0 });
      mockDb.prepare.mockReturnValue({ run: runMock });

      const result = deleteUserFact("personal", "nonexistent");

      expect(result).toBe(false);
    });
  });

  describe("formatUserFactsBlock", () => {
    it("should return empty string when no facts", () => {
      mockDb.prepare.mockReturnValue({ all: vi.fn().mockReturnValue([]) });

      expect(formatUserFactsBlock()).toBe("");
    });

    it("should format facts grouped by category", () => {
      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue([
          {
            category: "personal",
            key: "age",
            value: "30",
            source: "conversation",
            updated_at: "2026-03-18",
          },
          {
            category: "personal",
            key: "name",
            value: "Fede",
            source: "conversation",
            updated_at: "2026-03-18",
          },
          {
            category: "health",
            key: "diet",
            value: "high protein",
            source: "conversation",
            updated_at: "2026-03-18",
          },
        ]),
      });

      const block = formatUserFactsBlock();

      expect(block).toContain("Perfil del usuario");
      expect(block).toContain("NUNCA los olvides");
      expect(block).toContain("### personal");
      expect(block).toContain("**age**: 30");
      expect(block).toContain("**name**: Fede");
      expect(block).toContain("### health");
      expect(block).toContain("**diet**: high protein");
    });

    it("Ruling 3: non-credential block format is byte-identical (pinned)", () => {
      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue([
          {
            category: "personal",
            key: "age",
            value: "30",
            source: "conversation",
            updated_at: "2026-03-18",
          },
          {
            category: "personal",
            key: "name",
            value: "Ana",
            source: "conversation",
            updated_at: "2026-03-18",
          },
          {
            category: "health",
            key: "diet",
            value: "high protein",
            source: "conversation",
            updated_at: "2026-03-18",
          },
        ]),
      });

      expect(formatUserFactsBlock()).toBe(
        "\n\n## Perfil del usuario (hechos confirmados)\n" +
          "Estos datos los proporcionó Fede directamente. NUNCA los olvides ni los contradigas.\n\n" +
          "### personal\n- **age**: 30\n- **name**: Ana\n\n" +
          "### health\n- **diet**: high protein",
      );
    });

    it("Ruling 3: a credential fact keeps category and key, its value is masked", () => {
      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue([
          {
            category: "personal",
            key: "wifi_password",
            value: SYN_WIFI,
            source: "conversation",
            updated_at: "2026-03-18",
          },
          {
            category: "projects",
            key: "acme_api_key",
            value: FAKE_GOOGLE_KEY,
            source: "conversation",
            updated_at: "2026-03-18",
          },
          {
            category: "projects",
            key: "acme_notes",
            value: `usa ${FAKE_GOOGLE_KEY}`,
            source: "conversation",
            updated_at: "2026-03-18",
          },
        ]),
      });

      invalidateSecretRefs(); // the reference index reads these rows
      const block = formatUserFactsBlock("acme");

      // Ruling 3c: the mask carries the reference name and how to use it.
      expect(block).toContain(
        `### personal\n- **wifi_password**: ${secretPlaceholder("SECRET_PERSONAL_WIFI_PASSWORD")}`,
      );
      expect(block).toContain(
        `- **acme_api_key**: ${secretPlaceholder("SECRET_PROJECTS_ACME_API_KEY")}`,
      );
      expect(block).toContain(
        `- **acme_notes**: ${secretPlaceholder("SECRET_PROJECTS_ACME_NOTES")}`,
      );
      expect(block).not.toContain(CREDENTIAL_FACT_PLACEHOLDER);
      expect(block).not.toContain(SYN_WIFI);
      expect(block).not.toContain(FAKE_GOOGLE_KEY);
    });

    it("2026-09-06: always-inject facts do not consume the scored budget", () => {
      // Live regression: `personal` alone was 3,726 chars, so every scored
      // fact (all 197 `projects` rows) was skipped on every turn since 05-24.
      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue([
          {
            category: "personal",
            key: "bio",
            value: "x".repeat(3_100),
            source: "conversation",
            updated_at: "2026-05-24",
          },
          {
            category: "projects",
            key: "fantasy_espn_s2",
            value: "cookie-value",
            source: "conversation",
            updated_at: "2026-09-05",
          },
        ]),
      });

      const block = formatUserFactsBlock(
        "Revisa que puedes entrar al Fantasy de Espn vía API",
      );

      expect(block).toContain("**bio**:");
      // Ruling 3: the scored credential fact is injected by name, value masked.
      expect(block).toContain(
        `**fantasy_espn_s2**: ${CREDENTIAL_FACT_PLACEHOLDER}`,
      );
      expect(block).not.toContain("cookie-value");
    });

    it("2026-09-06 qa-audit C1: a fact with no keyword overlap is never injected on an unrelated message", () => {
      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue([
          {
            category: "projects",
            key: "fantasy_espn_s2",
            value: "cookie-value",
            source: "conversation",
            updated_at: "2026-09-05",
          },
          {
            category: "projects",
            key: "doctoralia_password",
            value: "secret-value",
            source: "conversation",
            updated_at: "2026-09-04",
          },
        ]),
      });

      const block = formatUserFactsBlock("Cómo está la ofensiva de SEA?");

      expect(block).toContain("Perfil del usuario");
      expect(block).not.toContain("cookie-value");
      expect(block).not.toContain("secret-value");
    });

    it("qa-audit R2: a message with no scorable word injects no scored fact (no recency fallback)", () => {
      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue([
          {
            category: "projects",
            key: "fantasy_espn_s2",
            value: "cookie-value",
            source: "conversation",
            updated_at: "2026-09-05",
          },
        ]),
      });

      expect(formatUserFactsBlock("?")).not.toContain("cookie-value");
    });

    it("scored facts still respect their own budget (newest relevant first)", () => {
      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue([
          {
            category: "projects",
            key: "fantasy_one",
            value: "a".repeat(2_000),
            source: "conversation",
            updated_at: "2026-09-05",
          },
          {
            category: "projects",
            key: "fantasy_two",
            value: "b".repeat(2_000),
            source: "conversation",
            updated_at: "2026-09-04",
          },
        ]),
      });

      const block = formatUserFactsBlock("fantasy");

      expect(block).toContain("**fantasy_one**:");
      expect(block).not.toContain("**fantasy_two**:");
    });
  });
});
