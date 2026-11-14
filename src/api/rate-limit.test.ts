/**
 * The local API's per-address request limiter, driven in-process.
 *
 * The limiter keeps, per client address, the times of the requests it let
 * through and refuses a request once `maxPerWindow` of them fall inside the
 * last `windowMs`. Only `Date` is faked, so every window edge is an exact
 * millisecond. The address comes from the connection the node adapter attaches
 * to the context environment; requests here pass that environment directly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { apiRateLimit } from "./rate-limit.js";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const WINDOW = 60_000;
const MAX = 3;

function makeApp(maxPerWindow = MAX): Hono {
  const app = new Hono();
  app.use("/*", apiRateLimit({ windowMs: WINDOW, maxPerWindow }));
  app.get("/probe", (c) => c.json({ ok: true }));
  return app;
}

/** One request from a connection address (none when undefined). */
function from(
  app: Hono,
  address: string | undefined,
  headers: Record<string, string> = {},
): Promise<Response> {
  const env =
    address === undefined ? undefined : { incoming: { socket: { remoteAddress: address } } };
  return Promise.resolve(app.request("/probe", { headers }, env));
}

async function statuses(
  app: Hono,
  n: number,
  address: string | undefined,
  headers: (i: number) => Record<string, string> = () => ({}),
): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await from(app, address, headers(i))).status);
  return out;
}

/** The limiter's private address map, caught as a first request stores its address. */
async function trackedMap(app: Hono, address: string): Promise<Map<string, number[]>> {
  const set = vi.spyOn(Map.prototype, "set");
  let map: Map<string, number[]> | undefined;
  try {
    await from(app, address);
    const i = set.mock.calls.findIndex(([key]) => key === address);
    map = i >= 0 ? (set.mock.contexts[i] as Map<string, number[]>) : undefined;
  } finally {
    set.mockRestore();
  }
  expect(map).toBeDefined();
  return map!;
}

const PASS3_REFUSE = [200, 200, 200, 429];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  vi.stubEnv("TRUST_FORWARDED_FOR", "");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("apiRateLimit — the budget inside one window", () => {
  it("exactly maxPerWindow requests pass; the next is refused with 429, its body and Retry-After", async () => {
    const app = makeApp();
    const first = await from(app, "10.0.0.2");
    expect(first.status).toBe(200);
    expect(first.headers.get("Retry-After")).toBeNull();
    expect(await statuses(app, 2, "10.0.0.2")).toEqual([200, 200]);

    const refused = await from(app, "10.0.0.2");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("60");
    expect(await refused.json()).toEqual({
      error: "rate_limit_exceeded",
      windowMs: WINDOW,
      maxPerWindow: MAX,
      retryAfterSec: 60,
    });
  });

  it("a request one millisecond inside the window still counts; at the window's edge it no longer does", async () => {
    const app = makeApp();
    for (const at of [0, 10_000, 20_000]) {
      vi.setSystemTime(T0 + at);
      expect((await from(app, "10.0.0.2")).status).toBe(200);
    }

    vi.setSystemTime(T0 + WINDOW - 1);
    const inside = await from(app, "10.0.0.2");
    expect(inside.status).toBe(429);
    expect(inside.headers.get("Retry-After")).toBe("1");
    expect(((await inside.json()) as { retryAfterSec: number }).retryAfterSec).toBe(1);

    // The request at T0 is now exactly one window old: it is out, one slot frees.
    vi.setSystemTime(T0 + WINDOW);
    expect((await from(app, "10.0.0.2")).status).toBe(200);
    const next = await from(app, "10.0.0.2");
    expect(next.status).toBe(429);
    expect(next.headers.get("Retry-After")).toBe("10");
  });

  it("the full budget returns once every counted request is a window old; refused requests are not counted", async () => {
    const app = makeApp();
    expect(await statuses(app, 4, "10.0.0.2")).toEqual(PASS3_REFUSE);
    vi.setSystemTime(T0 + 30_000);
    expect(await statuses(app, 2, "10.0.0.2")).toEqual([429, 429]);

    vi.setSystemTime(T0 + WINDOW);
    expect(await statuses(app, 4, "10.0.0.2")).toEqual(PASS3_REFUSE);
  });
});

describe("apiRateLimit — what decides the address", () => {
  it("each connection address has its own budget; the neighbours on both sides keep theirs", async () => {
    const app = makeApp();
    expect(await statuses(app, 4, "10.0.0.2")).toEqual(PASS3_REFUSE);
    expect(await statuses(app, 4, "10.0.0.1")).toEqual(PASS3_REFUSE);
    expect(await statuses(app, 4, "10.0.0.3")).toEqual(PASS3_REFUSE);
  });

  it("forwarding headers do not decide the address unless the flag is exactly true and the connection is loopback", async () => {
    const rotating = (i: number) => ({
      "x-forwarded-for": `203.0.113.${i + 1}`,
      "x-real-ip": `198.51.100.${i + 1}`,
    });

    // Flag off: a direct caller rotating the headers stays on its connection's budget.
    expect(await statuses(makeApp(), 4, "10.0.0.2", rotating)).toEqual(PASS3_REFUSE);

    // Flag on, but the connection is not loopback.
    vi.stubEnv("TRUST_FORWARDED_FOR", "true");
    expect(await statuses(makeApp(), 4, "10.0.0.2", rotating)).toEqual(PASS3_REFUSE);

    // Loopback connection, but the flag holds another truthy spelling.
    vi.stubEnv("TRUST_FORWARDED_FOR", "1");
    expect(await statuses(makeApp(), 4, "127.0.0.1", rotating)).toEqual(PASS3_REFUSE);
  });

  it("with the flag on behind a loopback connection, the first X-Forwarded-For entry decides, then X-Real-IP", async () => {
    vi.stubEnv("TRUST_FORWARDED_FOR", "true");
    const app = makeApp();
    const xff = (value: string) => () => ({ "x-forwarded-for": value });

    expect(await statuses(app, 4, "127.0.0.1", xff("203.0.113.2, 10.9.9.9"))).toEqual(PASS3_REFUSE);
    // Every loopback spelling shares the forwarded address's budget.
    expect(await statuses(app, 1, "::1", xff("203.0.113.2"))).toEqual([429]);
    expect(await statuses(app, 1, "::ffff:127.0.0.1", xff(" 203.0.113.2 "))).toEqual([429]);
    // Neighbours of the forwarded address, the later entry, and the proxy itself are separate.
    expect(await statuses(app, 1, "127.0.0.1", xff("203.0.113.1"))).toEqual([200]);
    expect(await statuses(app, 1, "127.0.0.1", xff("203.0.113.3"))).toEqual([200]);
    expect(await statuses(app, 1, "127.0.0.1", xff("10.9.9.9"))).toEqual([200]);
    expect(await statuses(app, 1, "127.0.0.1")).toEqual([200]);

    // Without X-Forwarded-For, X-Real-IP decides; with both, X-Forwarded-For wins.
    const realIp = () => ({ "x-real-ip": "198.51.100.2" });
    expect(await statuses(app, 4, "::1", realIp)).toEqual(PASS3_REFUSE);
    expect(
      await statuses(app, 1, "::1", () => ({
        "x-forwarded-for": "203.0.113.9",
        "x-real-ip": "198.51.100.2",
      })),
    ).toEqual([200]);
  });

  it("requests without a connection address share one budget whatever their headers", async () => {
    const app = makeApp();
    const rotating = (i: number) => ({ "x-forwarded-for": `203.0.113.${i + 1}` });
    expect(await statuses(app, 4, undefined, rotating)).toEqual(PASS3_REFUSE);
    expect(await statuses(app, 1, "10.0.0.2")).toEqual([200]);
  });
});

describe("apiRateLimit — idle addresses are dropped from memory", () => {
  const address = (i: number) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;

  it("each passing request drops one idle other address, the earliest tracked, never an active one", async () => {
    const app = makeApp();
    const map = await trackedMap(app, "10.0.0.1");
    await from(app, "10.0.0.2");
    vi.setSystemTime(T0 + 30_000);
    await from(app, "10.0.0.3");
    expect([...map.keys()]).toEqual(["10.0.0.1", "10.0.0.2", "10.0.0.3"]);

    // .1 and .2 are now one window old (idle); .3 is still active.
    vi.setSystemTime(T0 + WINDOW);
    await from(app, "10.0.0.4");
    expect([...map.keys()]).toEqual(["10.0.0.2", "10.0.0.3", "10.0.0.4"]);
    await from(app, "10.0.0.4");
    expect([...map.keys()]).toEqual(["10.0.0.3", "10.0.0.4"]);
    await from(app, "10.0.0.4");
    expect([...map.keys()]).toEqual(["10.0.0.3", "10.0.0.4"]);
  });

  it("past 10,000 tracked addresses a passing request drops every idle one; active ones are kept past the cap", async () => {
    const app = makeApp(1);
    const map = await trackedMap(app, address(0));
    for (let i = 1; i <= 10_000; i++) await from(app, address(i));
    expect(map.size).toBe(10_001);

    vi.setSystemTime(T0 + WINDOW);
    await from(app, "192.0.2.1");
    expect([...map.keys()]).toEqual(["192.0.2.1"]);
  });

  it("at exactly 10,000 tracked addresses only the one idle address is dropped", async () => {
    const app = makeApp(1);
    const map = await trackedMap(app, address(0));
    for (let i = 1; i < 10_000; i++) await from(app, address(i));
    expect(map.size).toBe(10_000);

    vi.setSystemTime(T0 + WINDOW);
    await from(app, "192.0.2.1");
    expect(map.size).toBe(10_000);
    expect(map.has(address(0))).toBe(false);
    expect(map.has(address(1))).toBe(true);
    expect(map.has("192.0.2.1")).toBe(true);
  });
});
