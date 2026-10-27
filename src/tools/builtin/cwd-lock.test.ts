import { describe, it, expect } from "vitest";
import { cwdLockKeyCount, withCwdLock } from "./cwd-lock.js";

// Queue 4ao (f)(ii): one git sequence at a time per cwd, parallel across cwds.
const held = () => {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
};
const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

describe("withCwdLock", () => {
  it("runs calls on the same cwd one at a time, in arrival order", async () => {
    const order: string[] = [];
    const gate = held();
    const a = withCwdLock("/r/x", async () => {
      order.push("a:start");
      await gate.promise;
      order.push("a:end");
    });
    const b = withCwdLock("/r/x/", async () => {
      order.push("b:start");
    });
    await flush();
    expect(order).toEqual(["a:start"]);
    gate.release();
    await Promise.all([a, b]);
    expect(order).toEqual(["a:start", "a:end", "b:start"]);
  });

  it("runs calls on different cwds in parallel", async () => {
    const order: string[] = [];
    const gate = held();
    const a = withCwdLock("/r/x", async () => {
      order.push("a:start");
      await gate.promise;
    });
    await withCwdLock("/r/y", async () => {
      order.push("b:ran");
    });
    expect(order).toEqual(["a:start", "b:ran"]);
    gate.release();
    await a;
  });

  it("a rejected call propagates its error and does not wedge the next one", async () => {
    await expect(
      withCwdLock("/r/z", () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    expect(await withCwdLock("/r/z", async () => "next")).toBe("next");
  });

  it("a call queued behind one that REJECTS still runs and returns its own value (qa R1 W1)", async () => {
    let fail!: (e: Error) => void;
    const a = withCwdLock(
      "/r/w",
      () => new Promise<string>((_, rej) => (fail = rej)),
    );
    let bRan = false;
    const b = withCwdLock("/r/w", async () => {
      bRan = true;
      return "b-value";
    });
    await flush();
    expect(bRan).toBe(false);
    fail(new Error("a-failed"));
    await expect(a).rejects.toThrow("a-failed");
    expect(await b).toBe("b-value");
    expect(bRan).toBe(true);
  });

  it("deletes a key once its last call settles; a later call does not chain behind it (qa R1 R1)", async () => {
    expect(cwdLockKeyCount()).toBe(0);
    const gate = held();
    const a = withCwdLock("/r/m", () => gate.promise);
    const b = withCwdLock("/r/m", async () => "b");
    expect(cwdLockKeyCount()).toBe(1);
    gate.release();
    await a;
    expect(await b).toBe("b");
    expect(cwdLockKeyCount()).toBe(0);
    // A fresh call starts at once (same tick) — no settled tail ahead of it.
    let started = false;
    const c = withCwdLock("/r/m", async () => {
      started = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toBe(true);
    await c;
    expect(cwdLockKeyCount()).toBe(0);
  });
});
