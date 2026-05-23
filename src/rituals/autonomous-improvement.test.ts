/**
 * Tests for autonomous-improvement ritual.
 *
 * Focus: circuit-breaker that detects self-cancelling fix loops when
 * mission-control:latest image is pruned (2026-05-23 recurrence fix).
 * The pre-existing canCreatePR / env-gate paths are exercised implicitly
 * by setting up baseline mocks; the new behavior is exercised explicitly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../db/index.js", () => ({
  getDatabase: vi.fn(),
}));

vi.mock("../intelligence/improvement-detector.js", () => ({
  detectImprovements: vi.fn(() => [
    {
      type: "scope-miss",
      severity: "high",
      frequency: 5,
      suggestedAction: "Anchor regex for foo",
    },
  ]),
  formatCandidates: vi.fn(() => "candidate text"),
}));

import { createImprovementTask } from "./autonomous-improvement.js";
import { getDatabase } from "../db/index.js";

const mockGetDatabase = vi.mocked(getDatabase);

/**
 * Build a routed mock DB whose prepare() returns query-specific stubs.
 * canCreatePR uses .get() on a COUNT query; circuit-breaker uses .all()
 * on a nanoclaw-failure query. We route by SQL substring so a single mock
 * serves both code paths cleanly.
 */
function makeRoutedDb(opts: {
  prCount?: number;
  nanoclawRecent?: { status: string; error: string }[];
  throwOnNanoclawQuery?: boolean;
}) {
  const prCount = opts.prCount ?? 0;
  const nanoclawRecent = opts.nanoclawRecent ?? [];

  return {
    prepare: (sql: string) => {
      if (sql.includes("COUNT(*) as cnt")) {
        return { get: () => ({ cnt: prCount }) };
      }
      if (sql.includes("agent_type = 'nanoclaw'")) {
        if (opts.throwOnNanoclawQuery) {
          throw new Error("Simulated DB failure on nanoclaw query");
        }
        return { all: () => nanoclawRecent };
      }
      throw new Error(`Unmocked SQL prefix: ${sql.slice(0, 80)}`);
    },
  };
}

const ORIGINAL_ENV = process.env.AUTONOMOUS_IMPROVEMENT_ENABLED;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTONOMOUS_IMPROVEMENT_ENABLED = "true";
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.AUTONOMOUS_IMPROVEMENT_ENABLED;
  } else {
    process.env.AUTONOMOUS_IMPROVEMENT_ENABLED = ORIGINAL_ENV;
  }
});

describe("createImprovementTask — circuit-breaker (nanoclaw image-missing)", () => {
  // Fixture below copies the LITERAL production error string. Verified
  // against mc.db 2026-05-23: rows look like
  //   Container exited with code 125: Unable to find image '...' locally\ndocker: Error response from daemon: pull access denied for ...
  // qa-audit R2 — use real data, not synthetic, so a future container.ts
  // rewording breaks this test before it ships.
  const REAL_IMAGE_MISSING_ERROR =
    "Container exited with code 125: Unable to find image 'mission-control:latest' locally\ndocker: Error response from daemon: pull access denied for mission-control, repository does not exist or may require 'docker login'";

  it("opens circuit when last 3 nanoclaw tasks all failed with image-missing (real production wording)", () => {
    mockGetDatabase.mockReturnValue(
      makeRoutedDb({
        nanoclawRecent: [
          { status: "failed", error: REAL_IMAGE_MISSING_ERROR },
          { status: "failed", error: REAL_IMAGE_MISSING_ERROR },
          { status: "failed", error: REAL_IMAGE_MISSING_ERROR },
        ],
      }) as unknown as ReturnType<typeof getDatabase>,
    );

    const result = createImprovementTask();
    expect(result).toBeNull();
  });

  it("opens circuit on 'exited with code 125' without the 'Unable to find image' phrase (defensive matching)", () => {
    // Match container.ts:221 template `Container exited with code ${code}`
    // even when the docker daemon error text differs (e.g. future locale).
    mockGetDatabase.mockReturnValue(
      makeRoutedDb({
        nanoclawRecent: [
          {
            status: "failed",
            error: "Container exited with code 125: <unknown>",
          },
          {
            status: "failed",
            error: "Container exited with code 125: <unknown>",
          },
          {
            status: "failed",
            error: "Container exited with code 125: <unknown>",
          },
        ],
      }) as unknown as ReturnType<typeof getDatabase>,
    );

    const result = createImprovementTask();
    expect(result).toBeNull();
  });

  it("circuit stays closed when one of the recent 3 tasks succeeded", () => {
    mockGetDatabase.mockReturnValue(
      makeRoutedDb({
        nanoclawRecent: [
          { status: "completed", error: "" }, // <-- one success closes the circuit
          {
            status: "failed",
            error: "Unable to find image 'mission-control:latest' locally",
          },
          {
            status: "failed",
            error: "Unable to find image 'mission-control:latest' locally",
          },
        ],
      }) as unknown as ReturnType<typeof getDatabase>,
    );

    const result = createImprovementTask();
    expect(result).not.toBeNull();
    expect(result?.agentType).toBe("nanoclaw");
    expect(result?.title).toContain("Auto-improvement");
  });

  it("circuit stays closed when fewer than 3 recent nanoclaw tasks exist", () => {
    mockGetDatabase.mockReturnValue(
      makeRoutedDb({
        nanoclawRecent: [
          {
            status: "failed",
            error: "Unable to find image 'mission-control:latest' locally",
          },
          {
            status: "failed",
            error: "Unable to find image 'mission-control:latest' locally",
          },
        ], // only 2 — not enough to trip
      }) as unknown as ReturnType<typeof getDatabase>,
    );

    const result = createImprovementTask();
    expect(result).not.toBeNull();
  });

  it("circuit stays closed when failures are NOT image-missing class", () => {
    mockGetDatabase.mockReturnValue(
      makeRoutedDb({
        nanoclawRecent: [
          {
            status: "failed",
            error: "Planning failed: LLM plan response missing 'goals' array",
          },
          { status: "failed", error: "Container OOMKilled" },
          { status: "failed", error: "Container timed out after 300000ms" },
        ],
      }) as unknown as ReturnType<typeof getDatabase>,
    );

    const result = createImprovementTask();
    expect(result).not.toBeNull();
  });

  it("fails open (does not block) on DB error during circuit check", () => {
    mockGetDatabase.mockReturnValue(
      makeRoutedDb({
        throwOnNanoclawQuery: true,
      }) as unknown as ReturnType<typeof getDatabase>,
    );

    const result = createImprovementTask();
    // Fail-open: a broken query is not itself a reason to halt the ritual.
    expect(result).not.toBeNull();
  });
});

describe("createImprovementTask — pre-existing safety gates still honored", () => {
  it("returns null when AUTONOMOUS_IMPROVEMENT_ENABLED is not 'true'", () => {
    process.env.AUTONOMOUS_IMPROVEMENT_ENABLED = "false";
    mockGetDatabase.mockReturnValue(
      makeRoutedDb({}) as unknown as ReturnType<typeof getDatabase>,
    );

    const result = createImprovementTask();
    expect(result).toBeNull();
  });

  it("returns null when daily PR cap reached", () => {
    mockGetDatabase.mockReturnValue(
      makeRoutedDb({ prCount: 5 }) as unknown as ReturnType<typeof getDatabase>,
    );

    const result = createImprovementTask();
    expect(result).toBeNull();
  });
});
