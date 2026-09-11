import { describe, it, expect } from "vitest";
import { lookupMx, type MxLookup } from "./mx.js";

function failing(code: string): MxLookup {
  return async () => {
    throw Object.assign(new Error(code), { code });
  };
}

describe("lookupMx", () => {
  it("sorts by preference and strips trailing dots", async () => {
    const r = await lookupMx("x.com", async () => [
      { exchange: "Alt.MX.x.com.", priority: 20 },
      { exchange: "mx.x.com", priority: 10 },
    ]);
    expect(r.hosts.map((h) => h.exchange)).toEqual(["mx.x.com", "alt.mx.x.com"]);
    expect(r.reason).toBeNull();
    expect(r.implicit).toBe(false);
  });

  it("recognises RFC 7505 null MX", async () => {
    const r = await lookupMx("x.com", async () => [{ exchange: ".", priority: 0 }]);
    expect(r.hosts).toEqual([]);
    expect(r.reason).toBe("null_mx");
  });

  it("reports NXDOMAIN", async () => {
    const r = await lookupMx("nope.invalid", failing("ENOTFOUND"));
    expect(r.reason).toBe("nxdomain");
  });

  it("reports transient DNS errors separately so they are not cached", async () => {
    const r = await lookupMx("x.com", failing("ETIMEOUT"));
    expect(r.reason).toBe("dns_error");
  });

  it("falls back to implicit MX (A record) when there are no MX records", async () => {
    const r = await lookupMx("clinic.mx", failing("ENODATA"), async () => true);
    expect(r.implicit).toBe(true);
    expect(r.hosts).toEqual([{ exchange: "clinic.mx", priority: 0 }]);
  });

  it("returns no_records when neither MX nor A exist", async () => {
    const r = await lookupMx("ghost.mx", async () => [], async () => false);
    expect(r.hosts).toEqual([]);
    expect(r.reason).toBe("no_records");
  });
});
