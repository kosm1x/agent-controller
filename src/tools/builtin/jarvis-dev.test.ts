import { describe, it, expect } from "vitest";
import {
  isCacheFresh,
  TEST_CACHE_TTL_MS,
  type TestCacheEntry,
  type WorkingTreeState,
} from "./jarvis-dev.js";

const baseCache: TestCacheEntry = {
  branch: "jarvis/feat/example",
  head_sha: "abc123",
  dirty_hash: "deadbeef",
  tested_at_ms: 1_000_000,
  typecheck: "PASS",
  tests: "PASS (3734 tests)",
  ready_for_pr: true,
};

const baseState: WorkingTreeState = {
  branch: "jarvis/feat/example",
  head_sha: "abc123",
  dirty_hash: "deadbeef",
  now_ms: baseCache.tested_at_ms + 60_000, // 1 minute later
};

describe("jarvis_dev test cache freshness", () => {
  it("returns true when branch, head, dirty hash, and ready_for_pr all match and within TTL", () => {
    expect(isCacheFresh(baseCache, baseState)).toBe(true);
  });

  it("returns false for null cache", () => {
    expect(isCacheFresh(null, baseState)).toBe(false);
  });

  it("returns false when cache records a failing run", () => {
    expect(isCacheFresh({ ...baseCache, ready_for_pr: false }, baseState)).toBe(
      false,
    );
  });

  it("returns false when branch has changed since the cache was written", () => {
    expect(
      isCacheFresh(baseCache, { ...baseState, branch: "jarvis/feat/other" }),
    ).toBe(false);
  });

  it("returns false when HEAD has advanced (new commit) since the cache was written", () => {
    expect(isCacheFresh(baseCache, { ...baseState, head_sha: "abc124" })).toBe(
      false,
    );
  });

  it("returns false when the working tree has changed (edit after test pass)", () => {
    expect(
      isCacheFresh(baseCache, { ...baseState, dirty_hash: "cafef00d" }),
    ).toBe(false);
  });

  it("returns false when the cache is older than the TTL", () => {
    const stale: WorkingTreeState = {
      ...baseState,
      now_ms: baseCache.tested_at_ms + TEST_CACHE_TTL_MS + 1,
    };
    expect(isCacheFresh(baseCache, stale)).toBe(false);
  });

  it("returns true at exactly the TTL boundary (inclusive)", () => {
    const edge: WorkingTreeState = {
      ...baseState,
      now_ms: baseCache.tested_at_ms + TEST_CACHE_TTL_MS,
    };
    expect(isCacheFresh(baseCache, edge)).toBe(true);
  });
});
