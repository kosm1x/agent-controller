import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { verifyMany, usage } = vi.hoisted(() => ({ verifyMany: vi.fn(), usage: vi.fn() }));
vi.mock("../../email-verify/index.js", () => ({
  getSharedVerifier: () => ({ verifyMany, governor: { usage } }),
}));

import { emailVerifyTool } from "./email-verify.js";

const safe = {
  email: "ana@clinic.mx",
  verdict: "safe",
  reason: "deliverable",
  syntax: { valid: true, normalized: "ana@clinic.mx", suggestion: null },
  mx: { acceptsMail: true, hosts: ["mx.clinic.mx"], provider: "other" },
  smtp: { host: "mx.clinic.mx", deliverable: true, catchAll: false, fullInbox: false, disabled: false, replyCode: 250, reply: "Ok" },
  misc: { disposable: false, roleAccount: false, freeProvider: false },
  note: null,
  durationMs: 12,
};

beforeEach(() => {
  verifyMany.mockReset();
  usage.mockReset().mockReturnValue({ usedToday: 1, dailyCap: 500, breakerOpen: false });
});

describe("email_verify", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has consistent name and conservative annotations", () => {
    expect(emailVerifyTool.name).toBe("email_verify");
    expect(emailVerifyTool.definition.function.name).toBe("email_verify");
    expect(emailVerifyTool.readOnlyHint).toBe(true);
    expect(emailVerifyTool.destructiveHint).toBe(false);
    expect(emailVerifyTool.deferred).toBe(true);
  });

  it("rejects an empty list and an oversized list with {error}", async () => {
    expect(JSON.parse(await emailVerifyTool.execute({ emails: [] })).error).toMatch(/at least one/);
    expect(JSON.parse(await emailVerifyTool.execute({ emails: ["", "  "] })).error).toMatch(/at least one/);
    const big = Array.from({ length: 101 }, (_, i) => `u${i}@x.mx`);
    expect(JSON.parse(await emailVerifyTool.execute({ emails: big })).error).toMatch(/too many/);
    expect(verifyMany).not.toHaveBeenCalled();
  });

  it("accepts a single string, returns compact rows, summary and budget", async () => {
    verifyMany.mockResolvedValue({ results: [safe], summary: { total: 1, safe: 1, risky: 0, invalid: 0, unknown: 0 } });
    const out = JSON.parse(await emailVerifyTool.execute({ emails: "ana@clinic.mx" }));
    expect(verifyMany).toHaveBeenCalledWith(["ana@clinic.mx"], { skipSmtp: false, catchAllProbe: true });
    expect(out.summary.safe).toBe(1);
    expect(out.budget.dailyCap).toBe(500);
    expect(out.results[0]).toEqual({ email: "ana@clinic.mx", verdict: "safe", reason: "deliverable", provider: "other" });
    expect(out.halted).toBeUndefined();
  });

  it("passes skip_smtp / catch_all_probe through and returns full rows when verbose", async () => {
    verifyMany.mockResolvedValue({ results: [safe], summary: { total: 1, safe: 1, risky: 0, invalid: 0, unknown: 0 } });
    const out = JSON.parse(await emailVerifyTool.execute({ emails: ["ana@clinic.mx"], skip_smtp: true, catch_all_probe: false, verbose: true }));
    expect(verifyMany).toHaveBeenCalledWith(["ana@clinic.mx"], { skipSmtp: true, catchAllProbe: false });
    expect(out.results[0].smtp.replyCode).toBe(250);
  });

  it("ignores verbose above 10 addresses and says so", async () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({ ...safe, email: `u${i}@clinic.mx` }));
    verifyMany.mockResolvedValue({ results: rows, summary: { total: 11, safe: 11, risky: 0, invalid: 0, unknown: 0 } });
    const out = JSON.parse(await emailVerifyTool.execute({ emails: rows.map((r) => r.email), verbose: true }));
    expect(out.results[0].smtp).toBeUndefined();
    expect(out.note).toMatch(/verbose ignored/);
  });

  it("surfaces a halted batch (daily cap / circuit open) at the top level", async () => {
    verifyMany.mockResolvedValue({
      results: [{ ...safe, verdict: "unknown", reason: "daily_cap_reached", smtp: null }],
      summary: { total: 1, safe: 0, risky: 0, invalid: 0, unknown: 1 },
    });
    const out = JSON.parse(await emailVerifyTool.execute({ emails: ["ana@clinic.mx"] }));
    expect(out.halted).toBe("daily_cap_reached");
    verifyMany.mockResolvedValue({
      results: [{ ...safe, verdict: "unknown", reason: "batch_deadline", smtp: null }],
      summary: { total: 1, safe: 0, risky: 0, invalid: 0, unknown: 1 },
    });
    expect(JSON.parse(await emailVerifyTool.execute({ emails: ["ana@clinic.mx"] })).halted).toBe("batch_deadline");
  });

  it("wraps engine failures as {error}", async () => {
    verifyMany.mockRejectedValue(new Error("boom"));
    expect(JSON.parse(await emailVerifyTool.execute({ emails: ["ana@clinic.mx"] })).error).toMatch(/boom/);
  });
});
