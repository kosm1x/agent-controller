import { describe, it, expect, afterEach } from "vitest";
import { EmailVerifier, deriveMailDomain, discoverFqdn, envelopeConfigError } from "./verify.js";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { DEFAULT_GOVERNANCE } from "./governance.js";
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

/** Verifier whose MX for every domain is the fake server(s), no pacing, no sleeps. */
function verifier(ports: number[], extra: Partial<ConstructorParameters<typeof EmailVerifier>[0]> = {}): EmailVerifier {
  return new EmailVerifier({
    heloName: "test.eurekams.net",
    fromEmail: "postmaster@eurekams.net",
    port: ports[0],
    timeoutMs: 1500,
    greylistRetryMs: 0,
    allowPrivateAddresses: true,
    governance: { ...DEFAULT_GOVERNANCE, hostGapMs: 0, breakerThreshold: 2 },
    sleep: async () => {},
    // One MX host per port: exchange "127.0.0.1" — the client connects to `port`, so
    // failover tests inject a probe that maps host→port instead.
    mxLookup: async () => ports.map((p, i) => ({ exchange: `mx${i}.127.0.0.1`, priority: (i + 1) * 10 })),
    resolveTargets: async () => [{ address: "127.0.0.1", family: 4 }],
    ...extra,
  });
}

/** Probe seam that routes mxN.127.0.0.1 → the Nth port (real sockets underneath). */
async function routed(ports: number[]) {
  const { probeMailbox } = await import("./smtp-client.js");
  return (opts: Parameters<typeof probeMailbox>[0]) => {
    const idx = Number.parseInt(/^mx(\d+)\./.exec(opts.host)?.[1] ?? "0", 10);
    return probeMailbox({ ...opts, host: "127.0.0.1", port: ports[idx] ?? ports[0] });
  };
}

async function make(script: FakeSmtpScript, extra: Partial<ConstructorParameters<typeof EmailVerifier>[0]> = {}) {
  const s = await server(script);
  const v = verifier([s.port], { probe: await routed([s.port]), ...extra });
  return { s, v };
}

describe("EmailVerifier — SMTP verdicts against a scripted server", () => {
  it("safe: mailbox accepted, random address rejected", async () => {
    const { s, v } = await make({ rcpt: { "ana@clinic.mx": "250 2.1.5 Ok", default: "550 5.1.1 User unknown" } });
    const r = await v.verify("Ana@Clinic.mx");
    expect(r.verdict).toBe("safe");
    expect(r.reason).toBe("deliverable");
    expect(r.smtp?.catchAll).toBe(false);
    expect(r.smtp?.replyCode).toBe(250);
    expect(s.commands.filter((c) => c.startsWith("RCPT TO"))).toHaveLength(2);
    expect(s.commands[0]).toBe("EHLO test.eurekams.net");
    expect(s.commands[1]).toBe("MAIL FROM:<postmaster@eurekams.net>");
    // QUIT is flushed after verify() resolves; give the server a moment to read it.
    for (let i = 0; i < 50 && !s.commands.includes("QUIT"); i++) await new Promise((r) => setTimeout(r, 10));
    expect(s.commands.at(-1)).toBe("QUIT");
  });

  it("invalid: server rejects the mailbox", async () => {
    const { v } = await make({ rcpt: { default: "550 5.1.1 The email account that you tried to reach does not exist" } });
    const r = await v.verify("nobody@clinic.mx");
    expect(r.verdict).toBe("invalid");
    expect(r.reason).toBe("mailbox_rejected");
    expect(r.smtp?.deliverable).toBe(false);
  });

  it("risky: catch-all domain, and the catch-all answer is cached per domain", async () => {
    const { s, v } = await make({ rcpt: { default: "250 2.1.5 Ok" } });
    const r1 = await v.verify("a@catchall.mx");
    expect(r1.verdict).toBe("risky");
    expect(r1.reason).toBe("catch_all_domain");
    const r2 = await v.verify("b@catchall.mx");
    expect(r2.reason).toBe("catch_all_domain");
    // 2 RCPT for the first address (random + target), 1 for the second (cached catch-all).
    expect(s.commands.filter((c) => c.startsWith("RCPT TO"))).toHaveLength(3);
  });

  it("risky: role account even when deliverable", async () => {
    const { v } = await make({ rcpt: { "ventas@clinic.mx": "250 Ok", default: "550 User unknown" } });
    const r = await v.verify("ventas@clinic.mx");
    expect(r.verdict).toBe("risky");
    expect(r.reason).toBe("role_account");
    expect(r.misc.roleAccount).toBe(true);
  });

  it("risky: full inbox; invalid: disabled account", async () => {
    const { v } = await make({
      rcpt: { "full@clinic.mx": "452 4.2.2 Mailbox full", "gone@clinic.mx": "550 5.2.1 Account disabled", default: "550 User unknown" },
    });
    const full = await v.verify("full@clinic.mx");
    expect(full.verdict).toBe("risky");
    expect(full.smtp?.fullInbox).toBe(true);
    const gone = await v.verify("gone@clinic.mx");
    expect(gone.verdict).toBe("invalid");
    expect(gone.reason).toBe("mailbox_disabled");
  });

  it("greylisted: retries once on the same host and settles on the retry", async () => {
    let calls = 0;
    const s = await server({ rcpt: { default: "250 Ok" } });
    const base = await routed([s.port]);
    const v = verifier([s.port], {
      probe: async (opts) => {
        calls += 1;
        if (calls === 1) {
          return {
            rcpt: { code: 451, enhanced: "4.7.1", text: "Greylisted, try again later" },
            catchAll: { code: 550, enhanced: "5.1.1", text: "User unknown" },
            envelopeFailure: null,
            address: "127.0.0.1",
          };
        }
        return base(opts);
      },
    });
    const r = await v.verify("late@clinic.mx");
    expect(calls).toBe(2);
    expect(r.verdict).toBe("safe");
    expect(r.smtp?.catchAll).toBe(false);
    expect(v.governor.usage().usedToday).toBe(2); // the retry is a second charged connection
  });

  it("an unresolvable MX host costs no daily budget", async () => {
    const v = verifier([1], {
      resolveTargets: async (h) => {
        throw new Error(`cannot resolve MX host ${h}`);
      },
    });
    const r = await v.verify("ana@clinic.mx");
    expect(r.reason).toMatch(/^smtp_unreachable: cannot resolve/);
    expect(v.governor.usage().usedToday).toBe(0);
  });

  it("unknown/greylisted when the retry is greylisted too, and unknown results are not cached", async () => {
    const { s, v } = await make({ rcpt: { default: "451 4.7.1 Greylisted, try again later" } });
    const r = await v.verify("late@clinic.mx");
    expect(r.verdict).toBe("unknown");
    expect(r.reason).toBe("greylisted");
    const before = s.connections;
    await v.verify("late@clinic.mx");
    expect(s.connections).toBeGreaterThan(before);
  });

  it("blocked: our IP refused at MAIL FROM opens the circuit after the threshold, and it closes after the cooldown", async () => {
    let t = Date.UTC(2026, 8, 11, 18, 0, 0);
    const s = await server({ mailFrom: "554 5.7.1 Service unavailable; Client host blocked using Spamhaus", rcpt: {} });
    const v = verifier([s.port], {
      probe: await routed([s.port]),
      now: () => t,
      governance: { ...DEFAULT_GOVERNANCE, hostGapMs: 0, breakerThreshold: 2, breakerCooldownMs: 60_000 },
    });
    const r1 = await v.verify("a@clinic.mx");
    expect(r1.verdict).toBe("unknown");
    expect(r1.reason).toBe("blocked_by_host");
    expect(v.governor.breakerOpen()).toBe(false);
    await v.verify("b@clinic.mx");
    expect(v.governor.usage().breakerOpen).toBe(true);
    const before = s.connections;
    const r3 = await v.verify("c@clinic.mx");
    expect(r3.reason).toBe("circuit_open");
    expect(r3.smtp).toBeNull();
    expect(s.connections).toBe(before); // no connection while open
    t += 60_001;
    const r4 = await v.verify("d@clinic.mx");
    expect(r4.reason).toBe("blocked_by_host"); // probing resumed, no latch
    expect(s.connections).toBe(before + 1);
  });

  it("greylist retry that hits an envelope block is recorded as blocked", async () => {
    let calls = 0;
    const v = verifier([1], {
      governance: { ...DEFAULT_GOVERNANCE, hostGapMs: 0, breakerThreshold: 1 },
      probe: async () => {
        calls += 1;
        if (calls === 1) {
          return { rcpt: { code: 451, enhanced: "4.7.1", text: "Greylisted, try again later" }, catchAll: null, envelopeFailure: null, address: "1.1.1.1" };
        }
        return { rcpt: null, catchAll: null, envelopeFailure: { stage: "mail_from", reply: { code: 554, enhanced: "5.7.1", text: "Client host blocked" } }, address: "1.1.1.1" };
      },
    });
    const r = await v.verify("late@clinic.mx");
    expect(calls).toBe(2);
    expect(r.reason).toBe("blocked_by_host");
    expect(v.governor.usage().breakerOpen).toBe(true);
  });

  it("a 4xx on the catch-all probe is not cached as evidence", async () => {
    let n = 0;
    const v = verifier([1], {
      probe: async (o) => {
        n += 1;
        return {
          rcpt: { code: 250, enhanced: null, text: "Ok" },
          catchAll: o.skipCatchAll ? null : { code: 451, enhanced: "4.7.1", text: "Greylisted" },
          envelopeFailure: null,
          address: "1.1.1.1",
        };
      },
    });
    await v.verify("uno@catchall.mx");
    await v.verify("dos@catchall.mx");
    expect(n).toBe(2);
    // Both probes still asked the catch-all question (nothing was cached).
    expect((await v.verify("tres@catchall.mx")).smtp?.catchAll).toBe(false);
    expect(n).toBe(3);
  });

  it("MX failover: first host refuses the connection, second answers", async () => {
    const dead = await server({ dropOnConnect: true, rcpt: {} });
    const live = await server({ rcpt: { "ana@clinic.mx": "250 Ok", default: "550 User unknown" } });
    const v = verifier([dead.port, live.port], { probe: await routed([dead.port, live.port]) });
    const r = await v.verify("ana@clinic.mx");
    expect(r.verdict).toBe("safe");
    expect(r.smtp?.host).toBe("mx1.127.0.0.1");
    expect(r.mx.hosts).toEqual(["mx0.127.0.0.1", "mx1.127.0.0.1"]);
  });

  it("unknown/unreachable when every MX host times out, with a typo suggestion", async () => {
    const { v } = await make({ delayMs: 3000, rcpt: {} }, { timeoutMs: 200 });
    const r = await v.verify("ana@gmial.com");
    expect(r.verdict).toBe("unknown");
    expect(r.reason).toMatch(/^smtp_unreachable: banner: timeout/);
    expect(r.syntax.suggestion).toBe("ana@gmail.com");
  });

  it("connect timeout is bounded independently of the per-step timeout", async () => {
    // 10.255.255.1 is non-routable: the SYN is never answered.
    const v = verifier([25], {
      timeoutMs: 20_000,
      mxLookup: async () => [{ exchange: "10.255.255.1", priority: 10 }],
      resolveTargets: async () => [{ address: "10.255.255.1", family: 4 }],
      probe: async (o) => (await import("./smtp-client.js")).probeMailbox({ ...o, connectTimeoutMs: 150 }),
    });
    const t0 = Date.now();
    const r = await v.verify("ana@clinic.mx");
    expect(Date.now() - t0).toBeLessThan(2_000);
    // Blackholed here (timeout); a host with a route to 10/8 gets an immediate E*UNREACH instead.
    expect(r.reason).toMatch(/smtp_unreachable: connect: connect (timeout after 150ms|E[A-Z]+)/);
  });

  it("daily cap counts connections: a second MX host is not tried once the cap is spent", async () => {
    const dead = await server({ dropOnConnect: true, rcpt: {} });
    const live = await server({ rcpt: { default: "250 Ok" } });
    const v = verifier([dead.port, live.port], {
      probe: await routed([dead.port, live.port]),
      governance: { ...DEFAULT_GOVERNANCE, hostGapMs: 0, dailyCap: 1 },
    });
    const r = await v.verify("a@clinic.mx");
    expect(r.reason).toBe("daily_cap_reached");
    expect(dead.connections).toBe(1);
    expect(live.connections).toBe(0);
    const r2 = await v.verify("b@clinic.mx");
    expect(r2.reason).toBe("daily_cap_reached");
    expect(dead.connections).toBe(1);
  });

  it("pacing that blows the deadline is not charged (no packet left the box)", async () => {
    let t = 0;
    const s = await server({ rcpt: { default: "250 Ok" } });
    const v = verifier([s.port], {
      probe: await routed([s.port]),
      maxVerifyMs: 1_000,
      now: () => t,
      // hostGapMs is 0 in the helper; simulate a long queue by advancing the clock inside sleep
      sleep: async () => {
        t += 5_000;
      },
      governance: { ...DEFAULT_GOVERNANCE, hostGapMs: 100 },
    });
    await v.verify("a@clinic.mx"); // slot at t=0 → no sleep
    const before = s.connections;
    const r = await v.verify("b@clinic.mx"); // slot at t=100 → sleep → deadline blown
    expect(r.reason).toBe("verify_deadline");
    expect(s.connections).toBe(before);
    expect(v.governor.usage().usedToday).toBe(1);
  });

  it("wall-clock deadline bounds one address across hosts", async () => {
    let t = 0;
    const slow = await server({ delayMs: 3000, rcpt: {} });
    const v = verifier([slow.port, slow.port, slow.port], {
      probe: await routed([slow.port, slow.port, slow.port]),
      timeoutMs: 200,
      maxVerifyMs: 300,
      now: () => (t += 250), // every clock read advances 250 ms
    });
    const r = await v.verify("a@clinic.mx");
    expect(r.reason).toBe("verify_deadline");
    expect(slow.connections).toBeLessThan(3);
  });

  it("caches safe/invalid results for 24h", async () => {
    const { s, v } = await make({ rcpt: { "ana@clinic.mx": "250 Ok", default: "550 User unknown" } });
    await v.verify("ana@clinic.mx");
    const before = s.connections;
    const again = await v.verify("ANA@clinic.mx");
    expect(again.verdict).toBe("safe");
    expect(again.email).toBe("ana@clinic.mx");
    expect(s.connections).toBe(before);
  });
});

describe("EmailVerifier — stages before SMTP", () => {
  it("invalid syntax never touches DNS or the network", async () => {
    let dns = 0;
    const v = new EmailVerifier({ mxLookup: async () => (dns++, []), probe: async () => { throw new Error("no"); } });
    const r = await v.verify("not an email");
    expect(r.verdict).toBe("invalid");
    expect(r.reason).toMatch(/^syntax:/);
    expect(dns).toBe(0);
  });

  it("disposable domains are risky without a probe", async () => {
    let probes = 0;
    const v = new EmailVerifier({ mxLookup: async () => [{ exchange: "mx.x", priority: 1 }], probe: async () => (probes++, null as never) });
    const r = await v.verify("x@mailinator.com");
    expect(r.verdict).toBe("risky");
    expect(r.reason).toBe("disposable_domain");
    expect(probes).toBe(0);
  });

  it("no MX → invalid with a typo suggestion; DNS error → unknown", async () => {
    const v = new EmailVerifier({
      mxLookup: async (d) => {
        if (d === "gmial.com") throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
        throw Object.assign(new Error("ETIMEOUT"), { code: "ETIMEOUT" });
      },
    });
    const typo = await v.verify("ana@gmial.com");
    expect(typo.verdict).toBe("invalid");
    expect(typo.reason).toBe("nxdomain");
    expect(typo.syntax.suggestion).toBe("ana@gmail.com");
    const flaky = await v.verify("ana@flaky.mx");
    expect(flaky.verdict).toBe("unknown");
    expect(flaky.reason).toBe("dns_error");
  });

  it("skipSmtp stops after MX and never probes", async () => {
    let probes = 0;
    const v = new EmailVerifier({
      mxLookup: async () => [{ exchange: "aspmx.l.google.com", priority: 1 }],
      probe: async () => (probes++, null as never),
    });
    const r = await v.verify("ana@clinic.mx", { skipSmtp: true });
    expect(r.verdict).toBe("unknown");
    expect(r.reason).toBe("smtp_skipped");
    expect(r.mx.provider).toBe("google_workspace");
    expect(probes).toBe(0);
  });

  it("provider rules: gmail skips the catch-all probe", async () => {
    const seen: boolean[] = [];
    const v = new EmailVerifier({
      mxLookup: async () => [{ exchange: "gmail-smtp-in.l.google.com", priority: 5 }],
      probe: async (o) => {
        seen.push(o.skipCatchAll);
        return { rcpt: { code: 250, enhanced: null, text: "Ok" }, catchAll: null, envelopeFailure: null, address: "1.1.1.1" };
      },
      governance: { ...DEFAULT_GOVERNANCE, hostGapMs: 0 },
    });
    const r = await v.verify("someone@gmail.com");
    expect(seen).toEqual([true]);
    expect(r.mx.provider).toBe("gmail");
    expect(r.verdict).toBe("safe");
  });
});

describe("EmailVerifier.verifyMany", () => {
  it("stops starting rows after maxBatchMs and marks the rest batch_deadline", async () => {
    let t = 0;
    const { v } = await make({ rcpt: { default: "250 Ok" } }, { now: () => (t += 100) });
    const { results, summary } = await v.verifyMany(["a@one.mx", "b@two.mx", "c@three.mx", "d@four.mx"], { maxBatchMs: 250 });
    expect(results).toHaveLength(4);
    const late = results.filter((r) => r.reason === "batch_deadline");
    expect(late.length).toBeGreaterThan(0);
    expect(summary.unknown).toBe(late.length);
    expect(late.every((r) => r.smtp === null)).toBe(true);
    expect(late.every((r) => r.syntax.valid === true)).toBe(true); // never checked ≠ invalid (R4 W-4)
  });


  it("de-duplicates, interleaves domains and summarises", async () => {
    const { s, v } = await make({
      rcpt: { "a@one.mx": "250 Ok", "b@two.mx": "550 5.1.1 User unknown", default: "550 5.1.1 User unknown" },
    });
    const { results, summary } = await v.verifyMany(["a@one.mx", "A@one.mx", "b@two.mx", "bad", "c@one.mx"]);
    expect(results).toHaveLength(4);
    expect(summary).toEqual({ total: 4, safe: 1, invalid: 3, risky: 0, unknown: 0 });
    // Interleaved: one.mx, two.mx, (bad), one.mx — never two one.mx back to back.
    expect(results.map((r) => r.email)).toEqual(["a@one.mx", "b@two.mx", "bad", "c@one.mx"]);
    expect(s.connections).toBe(3);
  });
});

describe("envelope configuration guard (audit R4 C-1)", () => {
  it("discoverFqdn resolves the short hostname through /etc/hosts without spawning", () => {
    const short = hostname();
    const hosts = join(tmpdir(), `hosts-${process.pid}`);
    writeFileSync(hosts, `127.0.0.1 localhost\n# comment\n127.0.1.1 ${short}.example.test ${short}\n`);
    if (short.includes(".")) {
      expect(discoverFqdn(hosts)).toBe(short);
    } else {
      expect(discoverFqdn(hosts)).toBe(`${short}.example.test`);
    }
    expect(discoverFqdn("/nonexistent/hosts")).toBe(short);
  });

  it("discoverFqdn matches `hostname -f` on this box", () => {
    let fqdn = "";
    try {
      fqdn = execFileSync("hostname", ["-f"], { encoding: "utf8" }).trim();
    } catch {
      return; // no hostname binary here
    }
    if (!fqdn.includes(".")) return; // box without a FQDN: nothing to prove
    expect(discoverFqdn()).toBe(fqdn);
  });

  it("names the defect for a short, bogus or IP-literal HELO and an unroutable sender", () => {
    expect(envelopeConfigError("mail", "postmaster@mail")).toMatch(/HELO name "mail" is not a public/);
    for (const bad of ["localhost.localdomain", "vps.local", "box.internal", "(none)", "[1.2.3.4]", "host.example"]) {
      expect(envelopeConfigError(bad, ""), bad).toMatch(/HELO name/);
    }
    expect(envelopeConfigError("mail.eurekams.net", "postmaster@mail")).toMatch(/not a routable address/);
    expect(envelopeConfigError("mail.eurekams.net", "postmaster")).toMatch(/not a routable address/);
    expect(envelopeConfigError("mail.eurekams.net", "post master@x.mx")).toMatch(/not a routable address/);
    expect(envelopeConfigError("mail.eurekams.net", "a@localhost.localdomain")).toMatch(/not a routable address/);
    expect(envelopeConfigError("mail.eurekams.net", "")).toBeNull(); // null sender is fine
    expect(envelopeConfigError("mail.eurekams.net", "postmaster@eurekams.net")).toBeNull();
  });

  it("a misconfigured verifier refuses every probe before DNS or a socket", async () => {
    let dns = 0;
    let probes = 0;
    const v = new EmailVerifier({
      heloName: "mail",
      mxLookup: async () => (dns++, [{ exchange: "mx.clinic.mx", priority: 1 }]),
      probe: async () => (probes++, null as never),
    });
    expect(v.configError).toMatch(/not a public fully-qualified/);
    const r = await v.verify("ana@clinic.mx");
    expect(r.verdict).toBe("unknown");
    expect(r.reason).toMatch(/^misconfigured: HELO name "mail" is not a public/);
    expect(dns).toBe(1); // MX stage still runs (cheap, informative)
    expect(probes).toBe(0);
  });

  it("a 4xx about us is blocked for this address but never a breaker strike", async () => {
    const v = verifier([1], {
      governance: { ...DEFAULT_GOVERNANCE, hostGapMs: 0, breakerThreshold: 1 },
      probe: async () => ({
        rcpt: { code: 450, enhanced: "4.7.25", text: "Client host rejected: cannot find your hostname" },
        catchAll: null,
        envelopeFailure: null,
        address: "1.1.1.1",
      }),
    });
    const r = await v.verify("a@clinic.mx");
    expect(r.reason).toBe("blocked_by_host");
    expect(v.governor.usage().breakerOpen).toBe(false);
  });
});

describe("defaults", () => {
  it("MAIL FROM defaults to postmaster@<helo domain>; EMAIL_VERIFY_FROM overrides, empty = null sender", async () => {
    const { verifierOptionsFromEnv } = await import("./verify.js");
    delete process.env.EMAIL_VERIFY_FROM;
    process.env.EMAIL_VERIFY_HELO = "mail.eurekams.net";
    try {
      expect(verifierOptionsFromEnv().fromEmail).toBe("postmaster@eurekams.net");
      process.env.EMAIL_VERIFY_FROM = "verify@eurekams.net";
      expect(verifierOptionsFromEnv().fromEmail).toBe("verify@eurekams.net");
      process.env.EMAIL_VERIFY_FROM = "";
      expect(verifierOptionsFromEnv().fromEmail).toBe("");
    } finally {
      delete process.env.EMAIL_VERIFY_FROM;
      delete process.env.EMAIL_VERIFY_HELO;
    }
  });
});

describe("deriveMailDomain", () => {
  it("strips one label from a 3+ label hostname", () => {
    expect(deriveMailDomain("mail.eurekams.net")).toBe("eurekams.net");
    expect(deriveMailDomain("eurekams.net")).toBe("eurekams.net");
    expect(deriveMailDomain("vps")).toBe("vps");
  });
});
