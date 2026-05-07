/**
 * Outcome counter tests (W8 audit fix, queue #7 part 3, 2026-05-07).
 *
 * Reads the prom-client registry directly via `getSingleMetric()` rather
 * than mocking — these helpers are pure-ish and the registry lookup is
 * deterministic per-process. We reset the metric values between cases.
 */

import { describe, it, expect, beforeEach } from "vitest";
import client from "prom-client";
import { recordRecallOutcomes, recordRetainOutcome } from "./prometheus.js";

function getCounterValue(name: string, labels: Record<string, string>): number {
  const metric = client.register.getSingleMetric(name);
  if (!metric) return 0;
  const data = (
    metric as unknown as {
      hashMap: Record<
        string,
        { value: number; labels: Record<string, string> }
      >;
    }
  ).hashMap;
  for (const entry of Object.values(data)) {
    let match = true;
    for (const k of Object.keys(labels)) {
      if (entry.labels[k] !== labels[k]) {
        match = false;
        break;
      }
    }
    if (match) return entry.value;
  }
  return 0;
}

describe("recordRetainOutcome", () => {
  beforeEach(() => {
    const m = client.register.getSingleMetric("mc_retain_outcome_total");
    if (m) (m as client.Counter).reset();
  });

  it("extracts outcome:success from tags and increments matching counter", () => {
    recordRetainOutcome("mc-jarvis", ["telegram", "outcome:success"]);
    expect(
      getCounterValue("mc_retain_outcome_total", {
        outcome: "success",
        bank: "mc-jarvis",
      }),
    ).toBe(1);
  });

  it("first outcome:* match wins on multi-tag arrays", () => {
    // ["outcome:concerns", "outcome:success"] → concerns
    recordRetainOutcome("mc-jarvis", ["outcome:concerns", "outcome:success"]);
    expect(
      getCounterValue("mc_retain_outcome_total", {
        outcome: "concerns",
        bank: "mc-jarvis",
      }),
    ).toBe(1);
    expect(
      getCounterValue("mc_retain_outcome_total", {
        outcome: "success",
        bank: "mc-jarvis",
      }),
    ).toBe(0);
  });

  it("tags=undefined → outcome:unknown", () => {
    recordRetainOutcome("mc-operational", undefined);
    expect(
      getCounterValue("mc_retain_outcome_total", {
        outcome: "unknown",
        bank: "mc-operational",
      }),
    ).toBe(1);
  });

  it("no outcome:* tag → outcome:unknown", () => {
    recordRetainOutcome("mc-jarvis", ["telegram", "conversation"]);
    expect(
      getCounterValue("mc_retain_outcome_total", {
        outcome: "unknown",
        bank: "mc-jarvis",
      }),
    ).toBe(1);
  });

  it("unknown bank label folds to 'unknown' (W4 cardinality guard)", () => {
    recordRetainOutcome("mc-typo-fake-bank", ["outcome:success"]);
    expect(
      getCounterValue("mc_retain_outcome_total", {
        outcome: "success",
        bank: "unknown",
      }),
    ).toBe(1);
  });
});

describe("recordRecallOutcomes", () => {
  beforeEach(() => {
    const m = client.register.getSingleMetric("mc_recall_outcome_total");
    if (m) (m as client.Counter).reset();
  });

  it("increments by per-class count from breakdown", () => {
    recordRecallOutcomes("mc-jarvis", {
      success: 3,
      concerns: 1,
      failed: 0,
      unknown: 2,
    });
    expect(
      getCounterValue("mc_recall_outcome_total", {
        outcome: "success",
        bank: "mc-jarvis",
      }),
    ).toBe(3);
    expect(
      getCounterValue("mc_recall_outcome_total", {
        outcome: "concerns",
        bank: "mc-jarvis",
      }),
    ).toBe(1);
    expect(
      getCounterValue("mc_recall_outcome_total", {
        outcome: "failed",
        bank: "mc-jarvis",
      }),
    ).toBe(0);
    expect(
      getCounterValue("mc_recall_outcome_total", {
        outcome: "unknown",
        bank: "mc-jarvis",
      }),
    ).toBe(2);
  });

  it("zero-only breakdown produces no increments", () => {
    recordRecallOutcomes("mc-operational", {
      success: 0,
      concerns: 0,
      failed: 0,
      unknown: 0,
    });
    for (const outcome of ["success", "concerns", "failed", "unknown"]) {
      expect(
        getCounterValue("mc_recall_outcome_total", {
          outcome,
          bank: "mc-operational",
        }),
      ).toBe(0);
    }
  });
});
