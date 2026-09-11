import { describe, it, expect, afterEach } from "vitest";
import * as os from "node:os";
import { ProbeError, ownInterfaceAddresses, probeMailbox, resolveMxTargets, smtpReplyEnd, type ProbeOptions } from "./smtp-client.js";
import { startFakeSmtp, type FakeSmtpScript, type FakeSmtpServer } from "../test-utils/fake-smtp-server.js";

const servers: FakeSmtpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function server(script: FakeSmtpScript): Promise<FakeSmtpServer> {
  const s = await startFakeSmtp(script);
  servers.push(s);
  return s;
}

function opts(port: number, extra: Partial<ProbeOptions> = {}): ProbeOptions {
  return {
    host: "127.0.0.1",
    port,
    heloName: "test.eurekams.net",
    fromEmail: "postmaster@eurekams.net",
    toEmail: "ana@clinic.mx",
    domain: "clinic.mx",
    skipCatchAll: true,
    timeoutMs: 1500,
    allowPrivateAddresses: true,
    ...extra,
  };
}

describe("smtpReplyEnd", () => {
  it("frames single and multi-line replies and reports incomplete buffers", () => {
    expect(smtpReplyEnd("220 hi\r\n")).toBe(8);
    expect(smtpReplyEnd("250-a\r\n250-b\r\n250 c\r\n")).toBe(21);
    expect(smtpReplyEnd("250-a\r\n250-b\r\n")).toBe(-1);
    expect(smtpReplyEnd("250 partial")).toBe(-1);
    expect(smtpReplyEnd("250\r\n")).toBe(5);
  });
});

describe("probeMailbox — guards", () => {
  it("refuses CRLF / angle-bracket injection in any envelope token", async () => {
    for (const bad of [
      { toEmail: "ana@clinic.mx\r\nRCPT TO:<x@y.z>" },
      { fromEmail: "a@b.c>\r\nDATA" },
      { heloName: "x y" },
    ]) {
      await expect(probeMailbox(opts(1, bad))).rejects.toMatchObject({ name: "ProbeError", stage: "connect" });
    }
  });

  it("refuses private/loopback MX targets unless allowPrivateAddresses is set", async () => {
    await expect(probeMailbox(opts(1, { allowPrivateAddresses: false }))).rejects.toThrow(/only resolves to private, loopback or own-host/);
    await expect(probeMailbox(opts(1, { host: "10.0.0.5", allowPrivateAddresses: false }))).rejects.toThrow(/own-host/);
  });

  it("refuses this box's own public interface addresses", async () => {
    const own = [...ownInterfaceAddresses()].find((a) => !a.startsWith("127.") && !a.startsWith("::1") && !a.includes("%"));
    if (!own) return; // no non-loopback interface in this environment
    expect(Object.values(os.networkInterfaces()).flat().some((i) => i?.address.toLowerCase() === own)).toBe(true);
    await expect(probeMailbox(opts(25, { host: own, allowPrivateAddresses: false }))).rejects.toThrow(/own-host/);
  });
});

describe("probeMailbox — address handling", () => {
  it("connects through the pre-filtered address list, never re-resolving the hostname", async () => {
    // "mx.fake.test" does not exist in DNS: if the socket resolved the name itself this would fail.
    const s = await server({ rcpt: { "ana@clinic.mx": "250 Ok" } });
    const r = await probeMailbox(opts(s.port, { host: "mx.fake.test", addresses: [{ address: "127.0.0.1", family: 4 }] }));
    expect(r.rcpt?.code).toBe(250);
    expect(r.address).toBe("127.0.0.1");
  });

  it("resolveMxTargets orders IPv4 before IPv6 and filters private/own addresses", async () => {
    const own = await resolveMxTargets("localhost", true);
    expect(own.length).toBeGreaterThan(0);
    await expect(resolveMxTargets("localhost", false)).rejects.toThrow(/own-host/);
    await expect(resolveMxTargets("mx.does-not-exist.invalid", true)).rejects.toThrow(/cannot resolve/);
  });

  it("bounds the whole conversation by totalBudgetMs, not per step", async () => {
    const s = await server({ delayMs: 250, rcpt: { default: "250 Ok" } });
    const t0 = Date.now();
    const err = await probeMailbox(opts(s.port, { timeoutMs: 400, totalBudgetMs: 500, skipCatchAll: false })).catch((e: unknown) => e);
    const wall = Date.now() - t0;
    expect(err).toBeInstanceOf(ProbeError);
    expect((err as ProbeError).message).toMatch(/probe budget exhausted/);
    expect(wall).toBeLessThan(900);
  });
});

describe("probeMailbox — conversation", () => {
  it("runs the full conversation with a multi-line banner, fragmented replies and a HELO fallback", async () => {
    const s = await server({
      banner: "220-mx.clinic.mx ESMTP\r\n220 ready",
      ehlo: "502 5.5.1 EHLO not implemented",
      fragment: true,
      rcpt: { "ana@clinic.mx": "250 2.1.5 Ok" },
    });
    const r = await probeMailbox(opts(s.port, { skipCatchAll: false }));
    expect(r.envelopeFailure).toBeNull();
    expect(r.rcpt?.code).toBe(250);
    expect(r.catchAll?.code).toBe(550);
    expect(s.commands.slice(0, 3)).toEqual(["EHLO test.eurekams.net", "HELO test.eurekams.net", "MAIL FROM:<postmaster@eurekams.net>"]);
    expect(s.commands.filter((c) => c.startsWith("RCPT TO"))).toHaveLength(2);
    expect(s.commands[3]).toMatch(/^RCPT TO:<[a-z0-9]{1,12}@clinic\.mx>$/);
  });

  it("uses the null reverse path when fromEmail is empty", async () => {
    const s = await server({ rcpt: { "ana@clinic.mx": "250 Ok" } });
    const r = await probeMailbox(opts(s.port, { fromEmail: "" }));
    expect(r.rcpt?.code).toBe(250);
    expect(s.commands[1]).toBe("MAIL FROM:<>");
  });

  it("returns the envelope failure without any RCPT when MAIL FROM is refused", async () => {
    const s = await server({ mailFrom: "554 5.7.1 Client host blocked using Spamhaus", rcpt: {} });
    const r = await probeMailbox(opts(s.port));
    expect(r.envelopeFailure?.stage).toBe("mail_from");
    expect(r.envelopeFailure?.reply.enhanced).toBe("5.7.1");
    expect(r.rcpt).toBeNull();
    expect(s.commands.some((c) => c.startsWith("RCPT"))).toBe(false);
  });

  it("surfaces a mid-conversation close as a ProbeError at the right stage", async () => {
    const s = await server({ closeAfter: "MAIL FROM", rcpt: {} });
    const err = await probeMailbox(opts(s.port)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProbeError);
    expect((err as ProbeError).stage).toBe("mail_from");
    expect((err as ProbeError).message).toMatch(/closed/);
  });

  it("aborts when a reply grows past 64 KiB without terminating", async () => {
    const s = await server({ banner: `220-${"x".repeat(70_000)}`, rcpt: {} });
    const err = await probeMailbox(opts(s.port, { timeoutMs: 5_000 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProbeError);
    expect((err as ProbeError).message).toMatch(/exceeded 65536 bytes/);
  });

  it("times out a silent server at the step deadline", async () => {
    const s = await server({ delayMs: 2000, rcpt: {} });
    const err = await probeMailbox(opts(s.port, { timeoutMs: 150 })).catch((e: unknown) => e);
    expect((err as ProbeError).stage).toBe("banner");
    expect((err as ProbeError).message).toMatch(/timeout after 150ms/);
  });
});
