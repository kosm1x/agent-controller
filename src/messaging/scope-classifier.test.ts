/**
 * Tests for scope-classifier — CIRICD-based semantic scope classification.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseScopeGroups,
  withDeterministicGroups,
  CLASSIFIER_SYSTEM_PROMPT,
  VALID_GROUPS,
} from "./scope-classifier.js";
import { DEFAULT_SCOPE_PATTERNS } from "./scope.js";

describe("parseScopeGroups", () => {
  it("parses valid JSON array", () => {
    const result = parseScopeGroups('["northstar_read","google"]');
    expect(result).not.toBeNull();
    expect(result!.has("northstar_read")).toBe(true);
    expect(result!.has("google")).toBe(true);
    expect(result!.size).toBe(2);
  });

  it("parses empty array", () => {
    const result = parseScopeGroups("[]");
    expect(result).not.toBeNull();
    expect(result!.size).toBe(0);
  });

  it("filters invalid group names", () => {
    const result = parseScopeGroups('["coding","invalid_group","meta"]');
    expect(result).not.toBeNull();
    expect(result!.size).toBe(2);
    expect(result!.has("coding")).toBe(true);
    expect(result!.has("meta")).toBe(true);
  });

  it("handles markdown code fences", () => {
    const result = parseScopeGroups('```json\n["northstar_write"]\n```');
    expect(result).not.toBeNull();
    expect(result!.has("northstar_write")).toBe(true);
  });

  it("handles comma-separated format", () => {
    const result = parseScopeGroups("google, schedule, intel");
    expect(result).not.toBeNull();
    expect(result!.size).toBe(3);
  });

  it("returns null for unparseable input", () => {
    expect(parseScopeGroups("I think you need google tools")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseScopeGroups("")).toBeNull();
  });

  it("handles single group as plain text", () => {
    const result = parseScopeGroups("coding");
    expect(result).not.toBeNull();
    expect(result!.has("coding")).toBe(true);
  });

  it("accepts xpoz as a valid group", () => {
    const result = parseScopeGroups('["xpoz"]');
    expect(result).not.toBeNull();
    expect(result!.has("xpoz")).toBe(true);
    expect(result!.size).toBe(1);
  });
});

describe("finance routing (usability Phase 3.4)", () => {
  it("parses 'finance' as a valid group", () => {
    expect(parseScopeGroups('["finance","google"]')).toEqual(
      new Set(["finance", "google"]),
    );
  });

  it("unions finance on deterministic ticker / price signals, case-sensitive on the ticker", () => {
    const fire = [
      "cuál es el precio de BSX hoy?",
      "dame la cotización de $AAPL",
      "market cap de NVDA",
      "precio actual de SPY",
      "P/E de MSFT",
      "precio del bitcoin",
      "valuación de la acción de TSLA",
    ];
    for (const m of fire) {
      expect(
        withDeterministicGroups(m, new Set(["intel"])).has("finance"),
        m,
      ).toBe(true);
    }
    const quiet = [
      "hola, echo $PWD y $HOME/claude",
      "precio de IVA incluido y valuación de VPS",
      "precio de la acción de CTV en el plan",
      "capitalización de KB y precio de CRM",
      "precio de la campaña de Meta Ads",
      "cotización de la renta del local",
      "el precio de venta sugerido para el curso",
      "valuación de daños en la casa",
      "cuánto pagamos de luz",
    ];
    for (const m of quiet) {
      expect(
        withDeterministicGroups(m, new Set(["google"])).has("finance"),
        m,
      ).toBe(false);
    }
  });

  it("R1 W9: is pure, never widens an EMPTY or a destructive classification", () => {
    const input = new Set(["intel"]);
    const out = withDeterministicGroups("precio de BSX", input);
    expect(out.has("finance")).toBe(true);
    expect(input.has("finance")).toBe(false);
    expect(withDeterministicGroups("precio de BSX", new Set()).size).toBe(0);
    expect(
      withDeterministicGroups(
        "borra todo lo de $SPY y confirma",
        new Set(["destructive", "jarvis_write"]),
      ).has("finance"),
    ).toBe(false);
  });
});

describe("SCOPE_CLASSIFIER_TIMEOUT_MS (2026-09-05: budget vs the claude-sdk floor)", () => {
  afterEach(() => {
    vi.doUnmock("../inference/adapter.js");
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("defaults to 8 s — above the measured p50 4.0 s wall time of a claude-sdk classifier call", async () => {
    vi.stubEnv("SCOPE_CLASSIFIER_TIMEOUT_MS", "");
    vi.resetModules();
    const mod = await import("./scope-classifier.js");
    expect(mod.SCOPE_CLASSIFIER_TIMEOUT_MS).toBe(8_000);
  });

  it("honors the SCOPE_CLASSIFIER_TIMEOUT_MS drop-in and falls back to the default on garbage", async () => {
    vi.stubEnv("SCOPE_CLASSIFIER_TIMEOUT_MS", "12000");
    vi.resetModules();
    expect((await import("./scope-classifier.js")).SCOPE_CLASSIFIER_TIMEOUT_MS).toBe(12_000);
    vi.stubEnv("SCOPE_CLASSIFIER_TIMEOUT_MS", "abc");
    vi.resetModules();
    expect((await import("./scope-classifier.js")).SCOPE_CLASSIFIER_TIMEOUT_MS).toBe(8_000);
    vi.stubEnv("SCOPE_CLASSIFIER_TIMEOUT_MS", "-5");
    vi.resetModules();
    expect((await import("./scope-classifier.js")).SCOPE_CLASSIFIER_TIMEOUT_MS).toBe(8_000);
  });

  it("wiring: an infer() slower than the budget yields null (regex fallback) and logs the timeout", async () => {
    vi.stubEnv("SCOPE_CLASSIFIER_TIMEOUT_MS", "20");
    vi.resetModules();
    vi.doMock("../inference/adapter.js", () => ({
      infer: () => new Promise(() => {}), // never resolves — models a slow SDK boot
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { classifyScopeGroups } = await import("./scope-classifier.js");
    await expect(classifyScopeGroups("corre el SQL contra DENUE")).resolves.toBeNull();
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("regex fallback: scope classifier timeout")),
    ).toBe(true);
  });

  it("wiring: an infer() inside the budget returns the parsed groups", async () => {
    vi.stubEnv("SCOPE_CLASSIFIER_TIMEOUT_MS", "500");
    vi.resetModules();
    vi.doMock("../inference/adapter.js", () => ({
      infer: async () => ({ content: '["coding"]' }),
    }));
    const { classifyScopeGroups } = await import("./scope-classifier.js");
    const groups = await classifyScopeGroups("corre el SQL contra DENUE");
    expect(groups).not.toBeNull();
    expect(groups!.has("coding")).toBe(true);
  });
});

// 2026-09-11 — the semantic classifier is the live path (193 semantic vs 60
// regex-fallback turns in the prior 7 days). A scope group that is absent
// from its prompt can never activate, whatever the regex says: `utility`
// (weather, currency, geocode, file_convert, email_verify) had activated 0
// times in 7 days for exactly that reason. This test pins prompt/scope
// parity so a group cannot be born invisible again. Groups already missing
// when the guard landed are listed explicitly — remove an entry when its
// prompt line is added (queued for the operator in next-sessions-queue.md).
describe("classifier prompt ↔ scope-group parity (2026-09-11)", () => {
  const KNOWN_MISSING_FROM_PROMPT = new Set([
    "alpha",
    "backtest",
    "diagram",
    "graph",
    "kb_ingest",
    "market_ritual",
    "paper",
    "pm_alpha",
    "pm_paper",
    "skills",
  ]);

  it("every scope group is either described to the classifier or explicitly listed as known-missing", () => {
    const promptGroups = new Set(
      [...CLASSIFIER_SYSTEM_PROMPT.matchAll(/^- ([a-z_]+):/gm)].map((m) => m[1]),
    );
    const scopeGroups = new Set(DEFAULT_SCOPE_PATTERNS.map((p) => p.group));
    const invisible = [...scopeGroups].filter(
      (g) => !promptGroups.has(g) && !KNOWN_MISSING_FROM_PROMPT.has(g),
    );
    expect(invisible, `groups the classifier is never told about: ${invisible.join(", ")}`).toEqual([]);
    // The allowlist must not go stale in the other direction either.
    const fixed = [...KNOWN_MISSING_FROM_PROMPT].filter((g) => promptGroups.has(g));
    expect(fixed, `now in the prompt — drop from KNOWN_MISSING_FROM_PROMPT: ${fixed.join(", ")}`).toEqual([]);
  });

  it("every group the prompt describes survives the parser whitelist (VALID_GROUPS)", () => {
    // The model can only return what the prompt lists; the parser must not drop it.
    // 2026-09-11: "utility" was added to the prompt but VALID_GROUPS still lacked it,
    // so ["utility"] parsed to [] and the turn fell to the regex path.
    const promptGroups = [...CLASSIFIER_SYSTEM_PROMPT.matchAll(/^- ([a-z_]+):/gm)].map((m) => m[1]);
    const dropped = promptGroups.filter((g) => !VALID_GROUPS.has(g));
    expect(dropped, `prompt groups the parser would discard: ${dropped.join(", ")}`).toEqual([]);
    expect(parseScopeGroups('["utility"]')).toEqual(new Set(["utility"]));
  });

  it("utility is described with email-verification vocabulary", () => {
    const line = CLASSIFIER_SYSTEM_PROMPT.split("\n").find((l) => l.startsWith("- utility:")) ?? "";
    for (const token of ["email_verify", "verifica si", "existe este correo", "bounce", "file_convert"]) {
      expect(line, token).toContain(token);
    }
  });
});
