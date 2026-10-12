/**
 * LOCK: the nanoclaw worker judges the TARGET_NOT_IN_SANDBOX sentinel on the
 * goals' RAW answers (sandboxStopEmitted over the exec results), never on the
 * extracted <deliverable> text, which can drop a sentinel written outside the
 * block. The worker self-invokes main() on import, so its wiring is pinned by
 * source.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "nanoclaw-worker.ts"),
  "utf8",
);

describe("nanoclaw-worker sandbox-sentinel wiring", () => {
  it("calls sandboxStopEmitted with the summary and the raw exec results", () => {
    expect(SRC).toMatch(
      /const targetMissing = sandboxStopEmitted\(\s*summary,\s*result\.executionResults,?\s*\)/,
    );
  });

  it("never runs the sentinel check on the extracted finalAnswer", () => {
    expect(SRC).not.toContain("emittedTargetNotInSandbox(finalAnswer");
    expect(SRC).not.toMatch(/sandboxStopEmitted\([^)]*finalAnswer/);
  });
});
