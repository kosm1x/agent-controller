/**
 * Unit tests for the multi-mailbox config parser and adapter identity.
 * No network — parseEmailAccounts() is pure over process.env, and the
 * EmailAdapter constructor only assigns fields.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmailAdapter, parseEmailAccounts } from "./email.js";

/** Env keys this suite touches — cleared around every test for isolation. */
const EMAIL_KEYS = [
  "EMAIL_ACCOUNTS",
  "EMAIL_COMUNIDADES_IMAP_HOST",
  "EMAIL_COMUNIDADES_IMAP_PORT",
  "EMAIL_COMUNIDADES_SMTP_HOST",
  "EMAIL_COMUNIDADES_SMTP_PORT",
  "EMAIL_COMUNIDADES_USERNAME",
  "EMAIL_COMUNIDADES_PASSWORD",
  "EMAIL_COMUNIDADES_ADDRESS",
  "EMAIL_COMUNIDADES_OWNER_ADDRESS",
  "EMAIL_COMUNIDADES_POLL_INTERVAL_MS",
  "EMAIL_PROYECTO2_IMAP_HOST",
  "EMAIL_PROYECTO2_SMTP_HOST",
  "EMAIL_PROYECTO2_USERNAME",
  "EMAIL_PROYECTO2_PASSWORD",
  "EMAIL_PROYECTO2_OWNER_ADDRESS",
];

function clearEmailEnv(): void {
  for (const k of EMAIL_KEYS) delete process.env[k];
}

/** Set a full, valid block for the `comunidades` account. */
function setComunidades(overrides: Record<string, string> = {}): void {
  process.env.EMAIL_COMUNIDADES_IMAP_HOST = "imap.hostinger.com";
  process.env.EMAIL_COMUNIDADES_SMTP_HOST = "smtp.hostinger.com";
  process.env.EMAIL_COMUNIDADES_USERNAME = "comunidades@mexiconecesario.org.mx";
  process.env.EMAIL_COMUNIDADES_PASSWORD = "app-password";
  process.env.EMAIL_COMUNIDADES_OWNER_ADDRESS = "Owner@Example.com";
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
}

beforeEach(clearEmailEnv);
afterEach(clearEmailEnv);

describe("parseEmailAccounts", () => {
  it("throws when EMAIL_ACCOUNTS is missing", () => {
    expect(() => parseEmailAccounts()).toThrow(/EMAIL_ACCOUNTS is required/);
  });

  it("throws when EMAIL_ACCOUNTS is only whitespace/commas", () => {
    process.env.EMAIL_ACCOUNTS = " , ,";
    expect(() => parseEmailAccounts()).toThrow(/no usable account ids/);
  });

  it("throws on an account id with invalid characters", () => {
    process.env.EMAIL_ACCOUNTS = "bad-id";
    expect(() => parseEmailAccounts()).toThrow(/invalid.*\[a-z0-9_\]/);
  });

  it("throws on a duplicate account id", () => {
    process.env.EMAIL_ACCOUNTS = "comunidades,comunidades";
    setComunidades();
    expect(() => parseEmailAccounts()).toThrow(/listed twice/);
  });

  it("throws listing every missing required var for an account", () => {
    process.env.EMAIL_ACCOUNTS = "comunidades";
    // nothing else set
    expect(() => parseEmailAccounts()).toThrow(
      /missing required env vars.*IMAP_HOST.*SMTP_HOST.*USERNAME.*PASSWORD.*OWNER_ADDRESS/s,
    );
  });

  it("throws naming the one var that is missing (partial config)", () => {
    process.env.EMAIL_ACCOUNTS = "comunidades";
    setComunidades();
    delete process.env.EMAIL_COMUNIDADES_PASSWORD;
    expect(() => parseEmailAccounts()).toThrow(
      /missing required env vars: EMAIL_COMUNIDADES_PASSWORD$/,
    );
  });

  it("treats a whitespace-only required var as absent", () => {
    process.env.EMAIL_ACCOUNTS = "comunidades";
    setComunidades({ EMAIL_COMUNIDADES_USERNAME: "   " });
    expect(() => parseEmailAccounts()).toThrow(
      /missing required env vars: EMAIL_COMUNIDADES_USERNAME/,
    );
  });

  it("parses a valid single account and applies defaults", () => {
    process.env.EMAIL_ACCOUNTS = "comunidades";
    setComunidades();
    const [acct, ...rest] = parseEmailAccounts();
    expect(rest).toHaveLength(0);
    expect(acct).toEqual({
      id: "comunidades",
      imapHost: "imap.hostinger.com",
      imapPort: 993,
      smtpHost: "smtp.hostinger.com",
      smtpPort: 465,
      username: "comunidades@mexiconecesario.org.mx",
      password: "app-password",
      // fromAddress defaults to username
      fromAddress: "comunidades@mexiconecesario.org.mx",
      // owner address is lowercased
      ownerAddress: "owner@example.com",
      pollIntervalMs: 60_000,
    });
  });

  it("honours per-account overrides for ports, address and poll interval", () => {
    process.env.EMAIL_ACCOUNTS = "comunidades";
    setComunidades({
      EMAIL_COMUNIDADES_IMAP_PORT: "1993",
      EMAIL_COMUNIDADES_SMTP_PORT: "2465",
      EMAIL_COMUNIDADES_ADDRESS: "no-reply@mexiconecesario.org.mx",
      EMAIL_COMUNIDADES_POLL_INTERVAL_MS: "30000",
    });
    const [acct] = parseEmailAccounts();
    expect(acct?.imapPort).toBe(1993);
    expect(acct?.smtpPort).toBe(2465);
    expect(acct?.fromAddress).toBe("no-reply@mexiconecesario.org.mx");
    expect(acct?.pollIntervalMs).toBe(30_000);
  });

  it("parses multiple accounts and trims/lowercases the id list", () => {
    process.env.EMAIL_ACCOUNTS = " Comunidades , proyecto2 ";
    setComunidades();
    process.env.EMAIL_PROYECTO2_IMAP_HOST = "imap.hostinger.com";
    process.env.EMAIL_PROYECTO2_SMTP_HOST = "smtp.hostinger.com";
    process.env.EMAIL_PROYECTO2_USERNAME = "proyecto2@example.com";
    process.env.EMAIL_PROYECTO2_PASSWORD = "pw2";
    process.env.EMAIL_PROYECTO2_OWNER_ADDRESS = "owner@example.com";
    const accts = parseEmailAccounts();
    expect(accts.map((a) => a.id)).toEqual(["comunidades", "proyecto2"]);
  });

  it("throws on a present-but-non-numeric port (fail-fast on a typo)", () => {
    process.env.EMAIL_ACCOUNTS = "comunidades";
    setComunidades({ EMAIL_COMUNIDADES_IMAP_PORT: "not-a-number" });
    expect(() => parseEmailAccounts()).toThrow(
      /invalid EMAIL_COMUNIDADES_IMAP_PORT="not-a-number"/,
    );
  });

  it("throws on an out-of-range port", () => {
    process.env.EMAIL_ACCOUNTS = "comunidades";
    setComunidades({ EMAIL_COMUNIDADES_SMTP_PORT: "70000" });
    expect(() => parseEmailAccounts()).toThrow(
      /invalid EMAIL_COMUNIDADES_SMTP_PORT="70000"/,
    );
  });

  it("throws on a zero / negative poll interval", () => {
    process.env.EMAIL_ACCOUNTS = "comunidades";
    setComunidades({ EMAIL_COMUNIDADES_POLL_INTERVAL_MS: "0" });
    expect(() => parseEmailAccounts()).toThrow(
      /invalid EMAIL_COMUNIDADES_POLL_INTERVAL_MS="0"/,
    );
  });
});

describe("EmailAdapter identity", () => {
  it("registers under the `email:<id>` channel name and exposes its owner", () => {
    const adapter = new EmailAdapter({
      id: "comunidades",
      imapHost: "imap.hostinger.com",
      imapPort: 993,
      smtpHost: "smtp.hostinger.com",
      smtpPort: 465,
      username: "comunidades@mexiconecesario.org.mx",
      password: "pw",
      fromAddress: "comunidades@mexiconecesario.org.mx",
      ownerAddress: "owner@example.com",
      pollIntervalMs: 60_000,
    });
    expect(adapter.name).toBe("email:comunidades");
    expect(adapter.ownerAddress).toBe("owner@example.com");
    // Not yet polled — isConnected is false until the first successful poll.
    expect(adapter.isConnected()).toBe(false);
  });
});
