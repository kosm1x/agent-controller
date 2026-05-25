/**
 * Outcome counter tests (W8 audit fix, queue #7 part 3, 2026-05-07).
 *
 * Reads the prom-client registry directly via `getSingleMetric()` rather
 * than mocking — these helpers are pure-ish and the registry lookup is
 * deterministic per-process. We reset the metric values between cases.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import client from "prom-client";
import {
  recordRecallOutcomes,
  recordRetainOutcome,
  recordSkillRun,
  recordSwarmSubtaskRetry,
} from "./prometheus.js";

// W3-R2 audit fix (round-2 2026-05-07): protect the prom-client registry
// from cross-test leakage. If a parallel test file imports prometheus.ts
// after this one runs, the counters would carry over their accumulated
// values. resetMetrics() zeros all counters owned by the registry.
afterAll(() => {
  client.register.resetMetrics();
});

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

// ---------------------------------------------------------------------------
// recordSwarmSubtaskRetry — queue #231 + qa-audit W1 fold (2026-05-23)
// W1 caught that unknown labels collapsed to a real bucket (`skipped_terminal`
// for unknown decisions) which silently masked call-site typos. The fix
// promotes unknown labels to a distinguished `unknown_label` sentinel that
// no legitimate caller produces — so a future typo shows up in dashboards
// as its own bucket instead of mixing with a real one. These tests pin it.
// ---------------------------------------------------------------------------

describe("recordSwarmSubtaskRetry", () => {
  beforeEach(() => {
    const m = client.register.getSingleMetric("mc_swarm_subtask_retry_total");
    if (m) (m as client.Counter).reset();
  });

  it("records known labels verbatim", () => {
    recordSwarmSubtaskRetry({
      decision: "retried",
      reason: "provider_transient",
      recoveryMode: "plain",
    });
    expect(
      getCounterValue("mc_swarm_subtask_retry_total", {
        decision: "retried",
        reason: "provider_transient",
        recovery_mode: "plain",
      }),
    ).toBe(1);
  });

  it("records shadow_skipped + hallucination labels (preserved per W3 fold)", () => {
    recordSwarmSubtaskRetry({
      decision: "shadow_skipped",
      reason: "hallucination",
      recoveryMode: "hallucination",
    });
    expect(
      getCounterValue("mc_swarm_subtask_retry_total", {
        decision: "shadow_skipped",
        reason: "hallucination",
        recovery_mode: "hallucination",
      }),
    ).toBe(1);
  });

  it("collapses an UNKNOWN decision label to 'unknown_label' (NOT a real bucket like 'skipped_terminal')", () => {
    // W1 pin: a future typo at the call site (e.g. "skipped_taint" instead
    // of "skipped_side_effect") must land in its own bucket so the bug is
    // visible, not silently mixed with real skipped_terminal events.
    recordSwarmSubtaskRetry({
      decision: "skipped_taint", // typo — not in KNOWN_RETRY_DECISIONS
      reason: "provider_transient",
      recoveryMode: "none",
    });
    expect(
      getCounterValue("mc_swarm_subtask_retry_total", {
        decision: "unknown_label",
        reason: "provider_transient",
        recovery_mode: "none",
      }),
    ).toBe(1);
    // And the real 'skipped_terminal' bucket stays empty.
    expect(
      getCounterValue("mc_swarm_subtask_retry_total", {
        decision: "skipped_terminal",
        reason: "provider_transient",
        recovery_mode: "none",
      }),
    ).toBe(0);
  });

  it("collapses an UNKNOWN reason to 'unknown_label' (NOT 'unknown_failure')", () => {
    // unknown_failure is a real classifier output for empty/unparseable
    // errors. Conflating dashboard typos with that bucket would mask both.
    recordSwarmSubtaskRetry({
      decision: "retried",
      reason: "providr_trnsient", // typo
      recoveryMode: "plain",
    });
    expect(
      getCounterValue("mc_swarm_subtask_retry_total", {
        decision: "retried",
        reason: "unknown_label",
        recovery_mode: "plain",
      }),
    ).toBe(1);
  });

  it("collapses an UNKNOWN recoveryMode to 'unknown_label' (NOT 'none')", () => {
    recordSwarmSubtaskRetry({
      decision: "retried",
      reason: "provider_transient",
      recoveryMode: "fancy_new_mode", // typo / forward-ref
    });
    expect(
      getCounterValue("mc_swarm_subtask_retry_total", {
        decision: "retried",
        reason: "provider_transient",
        recovery_mode: "unknown_label",
      }),
    ).toBe(1);
  });
});

// Queue #233 S5-P4-B1-R2: counter-increment regression for
// `mc_skills_run_total`. The counter has shipped live since v7.7 Spine 3
// Phase 4 but no test pinned the contract that recordSkillRun() actually
// bumps it. Without this, a future refactor (e.g. swapping in a typed
// wrapper, dropping prom-client, renaming the metric) could silently
// break the observation pipeline that mc-ctl + Grafana depend on.
describe("recordSkillRun", () => {
  beforeEach(() => {
    const m = client.register.getSingleMetric("mc_skills_run_total");
    if (m) (m as client.Counter).reset();
  });

  it("increments mc_skills_run_total{name, result='ok'} on a successful run", () => {
    recordSkillRun("my-skill", "ok");
    expect(
      getCounterValue("mc_skills_run_total", {
        name: "my-skill",
        result: "ok",
      }),
    ).toBe(1);
  });

  it("partitions by result class — repeated names with different results", () => {
    recordSkillRun("my-skill", "ok");
    recordSkillRun("my-skill", "ok");
    recordSkillRun("my-skill", "timeout");
    expect(
      getCounterValue("mc_skills_run_total", {
        name: "my-skill",
        result: "ok",
      }),
    ).toBe(2);
    expect(
      getCounterValue("mc_skills_run_total", {
        name: "my-skill",
        result: "timeout",
      }),
    ).toBe(1);
  });

  it("collapses an unknown result class into 'other'", () => {
    recordSkillRun("my-skill", "fancy_new_failure_mode");
    expect(
      getCounterValue("mc_skills_run_total", {
        name: "my-skill",
        result: "other",
      }),
    ).toBe(1);
  });

  it("clips absurdly long skill names to 64 chars (cardinality guard)", () => {
    const longName = "x".repeat(200);
    recordSkillRun(longName, "ok");
    expect(
      getCounterValue("mc_skills_run_total", {
        name: "x".repeat(64),
        result: "ok",
      }),
    ).toBe(1);
  });

  // Defensive: dispatcher never calls with "" (NAME_RE enforces ≥1 char
  // in frontmatter), but pinning the cardinality-guard contract for
  // future call sites that may bypass NAME_RE.
  it("does not crash on empty-string name (cardinality guard)", () => {
    recordSkillRun("", "ok");
    expect(
      getCounterValue("mc_skills_run_total", { name: "", result: "ok" }),
    ).toBe(1);
  });
});
