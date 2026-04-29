/**
 * V8 substrate S3 — drift detector tests.
 */

import { describe, it, expect } from "vitest";
import {
  checkDrift,
  checkInvariant,
  summarizeDrift,
  type Invariant,
  DEFAULT_INVARIANTS,
} from "./drift.js";

describe("checkInvariant — equality", () => {
  const inv: Invariant = {
    key: "FOO",
    description: "test",
    expected: "bar",
    severity: "warning",
  };

  it("returns null when actual matches expected", () => {
    expect(checkInvariant(inv, "bar")).toBeNull();
  });

  it("reports `different` when actual is set but mismatched", () => {
    const r = checkInvariant(inv, "baz");
    expect(r).not.toBeNull();
    expect(r!.status).toBe("different");
    expect(r!.expected).toBe("bar");
    expect(r!.actual).toBe("baz");
  });

  it("reports `missing` when actual is undefined", () => {
    const r = checkInvariant(inv, undefined);
    expect(r!.status).toBe("missing");
    expect(r!.actual).toBe("");
  });

  it("reports `missing` when actual is empty string", () => {
    const r = checkInvariant(inv, "");
    expect(r!.status).toBe("missing");
  });
});

describe("checkInvariant — pattern", () => {
  const inv: Invariant = {
    key: "FOO",
    description: "test",
    pattern: /^[0-9]+$/,
    severity: "info",
  };

  it("returns null when actual matches pattern", () => {
    expect(checkInvariant(inv, "12345")).toBeNull();
  });

  it("reports `pattern-mismatch` when actual is set but doesn't match", () => {
    const r = checkInvariant(inv, "abc");
    expect(r!.status).toBe("pattern-mismatch");
    expect(r!.actual).toBe("abc");
  });

  it("reports `missing` when pattern-required but actual is undefined", () => {
    const r = checkInvariant(inv, undefined);
    expect(r!.status).toBe("missing");
  });
});

describe("checkInvariant — required (presence-only)", () => {
  const inv: Invariant = {
    key: "FOO",
    description: "test",
    required: true,
    severity: "critical",
  };

  it("returns null when actual is set", () => {
    expect(checkInvariant(inv, "anything")).toBeNull();
  });

  it("reports missing when actual is undefined", () => {
    const r = checkInvariant(inv, undefined);
    expect(r!.status).toBe("missing");
    expect(r!.expected).toBe("(any value)");
  });

  it("reports missing when actual is empty string", () => {
    const r = checkInvariant(inv, "");
    expect(r!.status).toBe("missing");
  });
});

describe("checkDrift — multi-invariant scan", () => {
  const invariants: Invariant[] = [
    {
      key: "ENV_A",
      description: "A",
      expected: "alpha",
      severity: "critical",
    },
    {
      key: "ENV_B",
      description: "B",
      expected: "beta",
      severity: "warning",
    },
    {
      key: "ENV_C",
      description: "C",
      pattern: /^[0-9]+$/,
      severity: "info",
    },
  ];

  it("returns empty when all invariants hold", () => {
    expect(
      checkDrift(invariants, {
        ENV_A: "alpha",
        ENV_B: "beta",
        ENV_C: "42",
      }),
    ).toEqual([]);
  });

  it("returns only the drifted records", () => {
    const drifts = checkDrift(invariants, {
      ENV_A: "alpha", // ok
      ENV_B: "WRONG", // drift
      ENV_C: "abc", // pattern mismatch
    });
    expect(drifts).toHaveLength(2);
    expect(drifts[0].key).toBe("ENV_B");
    expect(drifts[1].key).toBe("ENV_C");
  });

  it("preserves invariant declaration order in output", () => {
    const drifts = checkDrift(invariants, {});
    expect(drifts.map((d) => d.key)).toEqual(["ENV_A", "ENV_B", "ENV_C"]);
  });

  it("uses process.env when no env supplied", () => {
    // Inject via process.env temporarily
    const original = process.env.DRIFT_TEST_KEY;
    process.env.DRIFT_TEST_KEY = "expected_value";
    try {
      const drifts = checkDrift([
        {
          key: "DRIFT_TEST_KEY",
          description: "x",
          expected: "expected_value",
          severity: "info",
        },
      ]);
      expect(drifts).toEqual([]);
    } finally {
      if (original === undefined) delete process.env.DRIFT_TEST_KEY;
      else process.env.DRIFT_TEST_KEY = original;
    }
  });
});

describe("summarizeDrift", () => {
  it("counts per severity", () => {
    const summary = summarizeDrift([
      {
        key: "A",
        description: "",
        expected: "",
        actual: "",
        status: "missing",
        severity: "critical",
      },
      {
        key: "B",
        description: "",
        expected: "",
        actual: "",
        status: "different",
        severity: "warning",
      },
      {
        key: "C",
        description: "",
        expected: "",
        actual: "",
        status: "different",
        severity: "warning",
      },
      {
        key: "D",
        description: "",
        expected: "",
        actual: "",
        status: "pattern-mismatch",
        severity: "info",
      },
    ]);
    expect(summary).toEqual({ total: 4, critical: 1, warning: 2, info: 1 });
  });

  it("returns zeros for empty input", () => {
    expect(summarizeDrift([])).toEqual({
      total: 0,
      critical: 0,
      warning: 0,
      info: 0,
    });
  });
});

describe("DEFAULT_INVARIANTS", () => {
  it("covers the documented expectations", () => {
    const keys = DEFAULT_INVARIANTS.map((i) => i.key);
    expect(keys).toContain("INFERENCE_PRIMARY_PROVIDER");
    expect(keys).toContain("INFERENCE_PRIMARY_MODEL");
    expect(keys).toContain("HINDSIGHT_URL");
    expect(keys).toContain("HINDSIGHT_RECALL_ENABLED");
    expect(keys).toContain("TZ");
  });

  it("each invariant has at least one check (expected | required | pattern)", () => {
    for (const inv of DEFAULT_INVARIANTS) {
      const hasCheck =
        inv.expected !== undefined ||
        inv.required === true ||
        inv.pattern !== undefined;
      expect(hasCheck).toBe(true);
    }
  });

  it("each invariant has a severity classifier", () => {
    for (const inv of DEFAULT_INVARIANTS) {
      expect(["critical", "warning", "info"]).toContain(inv.severity);
    }
  });

  it("fires drift on a deliberately wrong env, one record per invariant (W2)", () => {
    // Simulate a worst-case env where every invariant fails. This would
    // catch a typo in the `expected:` field of any DEFAULT_INVARIANTS entry,
    // which the smoke tests above don't cover.
    const drifted = checkDrift(DEFAULT_INVARIANTS, {
      INFERENCE_PRIMARY_PROVIDER: "openai-but-wrong",
      INFERENCE_PRIMARY_MODEL: "qwen2.5-plus", // pre-2026-04-26 stale model
      // HINDSIGHT_URL deliberately unset — should report missing
      HINDSIGHT_RECALL_ENABLED: "false", // pre-rehab disabled state
      HINDSIGHT_RECALL_TIMEOUT_MS: "1500", // pre-rehab timeout
      TZ: "UTC", // wrong timezone
    });

    // Every default invariant should fire.
    expect(drifted.length).toBe(DEFAULT_INVARIANTS.length);

    // Spot-check a few specific drifts so a typo in expected-values gets caught.
    const byKey = Object.fromEntries(drifted.map((d) => [d.key, d]));
    expect(byKey["INFERENCE_PRIMARY_PROVIDER"]?.expected).toBe("claude-sdk");
    expect(byKey["INFERENCE_PRIMARY_PROVIDER"]?.status).toBe("different");
    expect(byKey["INFERENCE_PRIMARY_MODEL"]?.expected).toBe("qwen3.6-plus");
    expect(byKey["HINDSIGHT_URL"]?.status).toBe("missing");
    expect(byKey["HINDSIGHT_RECALL_ENABLED"]?.expected).toBe("true");
    expect(byKey["HINDSIGHT_RECALL_TIMEOUT_MS"]?.expected).toBe("5000");
    expect(byKey["HINDSIGHT_RECALL_TIMEOUT_MS"]?.actual).toBe("1500");
    expect(byKey["TZ"]?.expected).toBe("America/Mexico_City");
  });

  it("fires zero drift when env matches every default invariant", () => {
    const clean = checkDrift(DEFAULT_INVARIANTS, {
      INFERENCE_PRIMARY_PROVIDER: "claude-sdk",
      INFERENCE_PRIMARY_MODEL: "qwen3.6-plus",
      HINDSIGHT_URL: "http://localhost:8888",
      HINDSIGHT_RECALL_ENABLED: "true",
      HINDSIGHT_RECALL_TIMEOUT_MS: "5000",
      TZ: "America/Mexico_City",
    });
    expect(clean).toEqual([]);
  });
});
