import { describe, it, expect } from "vitest";
import { TtlCache } from "./cache.js";

describe("TtlCache", () => {
  it("expires entries after the TTL", () => {
    let t = 1000;
    const c = new TtlCache<string>(100, 10, () => t);
    c.set("a", "x");
    expect(c.get("a")).toBe("x");
    t += 100;
    expect(c.get("a")).toBeUndefined();
    expect(c.size).toBe(0);
  });

  it("evicts the oldest entry when full and re-inserts refresh position", () => {
    const c = new TtlCache<number>(10_000, 2, () => 0);
    c.set("a", 1);
    c.set("b", 2);
    c.set("a", 11); // refresh: "b" is now the oldest
    c.set("c", 3);
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe(11);
    expect(c.get("c")).toBe(3);
  });
});
