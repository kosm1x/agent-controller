/**
 * Tests for prompt-enhancer — shouldEnhance, CIRICD parsing, toggle commands.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  shouldEnhance,
  checkToggle,
  parseCiricdResponse,
  analyzePrompt,
} from "./prompt-enhancer.js";

// Mock inference adapter — analyzePrompt uses dynamic imports, so we
// stub the modules at module-resolution time.
vi.mock("../inference/adapter.js", () => ({
  infer: vi.fn(),
}));
vi.mock("../lib/with-timeout.js", () => ({
  withTimeout: <T>(p: Promise<T>) => p,
}));

/** Build a minimal `InferenceResponse` for `infer` mocks. */
const inferResp = (content: string) => ({
  content,
  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  provider: "mock",
  latency_ms: 0,
});

// ---------------------------------------------------------------------------
// shouldEnhance — pass-through detection
// ---------------------------------------------------------------------------

describe("shouldEnhance", () => {
  it("rejects short messages (< 40 chars)", () => {
    expect(shouldEnhance("Hola")).toBe(false);
    expect(shouldEnhance("Qué tal?")).toBe(false);
  });

  it("rejects greetings", () => {
    expect(shouldEnhance("hola buenos días cómo estás")).toBe(false);
    expect(shouldEnhance("buenas tardes, todo bien?")).toBe(false);
  });

  it("rejects confirmations", () => {
    expect(shouldEnhance("sí, dale, procede con todo eso ahora")).toBe(false);
  });

  it("rejects read-only verbs", () => {
    expect(
      shouldEnhance("lista todas las tareas pendientes del proyecto"),
    ).toBe(false);
    expect(shouldEnhance("muestra el estado del servidor principal")).toBe(
      false,
    );
  });

  it("rejects continuation commands", () => {
    expect(shouldEnhance("continúa con lo que estabas haciendo antes")).toBe(
      false,
    );
  });

  it("accepts long actionable messages", () => {
    expect(
      shouldEnhance(
        "Crea un reporte semanal de ventas y envíalo a javier@eurekamd.net con los datos del CRM",
      ),
    ).toBe(true);
  });

  it("rejects skip signals", () => {
    expect(shouldEnhance("hazlo ya sin preguntas por favor amigo")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkToggle
// ---------------------------------------------------------------------------

describe("checkToggle", () => {
  it("returns false for 'enhancer off'", () => {
    expect(checkToggle("enhancer off")).toBe(false);
  });

  it("returns true for 'enhancer on'", () => {
    expect(checkToggle("enhancer on")).toBe(true);
  });

  it("returns null for non-toggle messages", () => {
    expect(checkToggle("hola")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CIRICD response parsing (v6.4 PE1)
// ---------------------------------------------------------------------------

describe("parseCiricdResponse", () => {
  it("parses PASS decision", () => {
    const raw = `{"decision":"PASS","intent":"Buscar noticias","clarity":8,"risk":"low","impact":1,"context":"resolved","decompose":"ok"}`;
    const result = parseCiricdResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("PASS");
    expect(result!.clarity).toBe(8);
    expect(result!.risk).toBe("low");
    expect(result!.impact).toBe(1);
    expect(result!.context).toBe("resolved");
    expect(result!.decompose).toBe("ok");
    expect(result!.intent).toBe("Buscar noticias");
  });

  it("parses ASK decision with questions", () => {
    const raw = `{"decision":"ASK","intent":"Borrar archivos","clarity":2,"risk":"high","impact":5,"context":"unresolved","decompose":"ok","questions":["¿Qué archivos quieres borrar?","¿Del directorio projects/ o knowledge/?"]}`;
    const result = parseCiricdResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("ASK");
    expect(result!.risk).toBe("high");
    expect(result!.questions).toHaveLength(2);
    expect(result!.questions![0]).toContain("archivos");
  });

  it("parses SPLIT decision with plan", () => {
    const raw = `{"decision":"SPLIT","intent":"Migrar 23 archivos","clarity":7,"risk":"low","impact":23,"context":"resolved","decompose":"split","split_plan":"Sugiero dividir en 3 bloques:\\n1. Los 6 de X\\n2. Los 15 de Y"}`;
    const result = parseCiricdResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("SPLIT");
    expect(result!.decompose).toBe("split");
    expect(result!.splitPlan).toContain("dividir");
  });

  it("caps questions at 2", () => {
    const raw = `{"decision":"ASK","intent":"test","clarity":1,"risk":"high","impact":1,"context":"unresolved","decompose":"ok","questions":["Q1","Q2","Q3","Q4"]}`;
    const result = parseCiricdResponse(raw);
    expect(result!.questions).toHaveLength(2);
  });

  it("returns null for invalid JSON", () => {
    expect(parseCiricdResponse("not json at all")).toBeNull();
  });

  it("returns null for JSON without decision field", () => {
    expect(parseCiricdResponse('{"foo": "bar"}')).toBeNull();
  });

  it("extracts JSON from markdown code fence", () => {
    const raw =
      '```json\n{"decision":"PASS","intent":"test","clarity":9,"risk":"low","impact":1,"context":"resolved","decompose":"ok"}\n```';
    const result = parseCiricdResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("PASS");
  });

  it("normalizes decision to uppercase", () => {
    const raw = `{"decision":"pass","intent":"test","clarity":10,"risk":"low","impact":1,"context":"resolved","decompose":"ok"}`;
    const result = parseCiricdResponse(raw);
    expect(result!.decision).toBe("PASS");
  });

  it("defaults missing numeric fields", () => {
    const raw = `{"decision":"PASS","intent":"test"}`;
    const result = parseCiricdResponse(raw);
    expect(result!.clarity).toBe(5);
    expect(result!.impact).toBe(1);
    expect(result!.risk).toBe("low");
    expect(result!.context).toBe("resolved");
    expect(result!.decompose).toBe("ok");
  });

  // RC5 — shape rejection: only valid CIRICD decisions parse
  it("rejects decision values outside the CIRICD enum", () => {
    expect(parseCiricdResponse('{"decision":"FOO","intent":"x"}')).toBeNull();
    expect(
      parseCiricdResponse('{"decision":"REJECT","intent":"x"}'),
    ).toBeNull();
    expect(parseCiricdResponse('{"decision":""}')).toBeNull();
  });

  it("rejects non-string decision values", () => {
    expect(parseCiricdResponse('{"decision":null}')).toBeNull();
    expect(parseCiricdResponse('{"decision":5}')).toBeNull();
    expect(parseCiricdResponse('{"decision":true}')).toBeNull();
  });

  it("accepts decision in any case (PASS, pass, Pass)", () => {
    for (const v of ["PASS", "pass", "Pass", "ASSUME", "assume"]) {
      const r = parseCiricdResponse(
        `{"decision":"${v}","intent":"x","clarity":7,"risk":"low","impact":1,"context":"resolved","decompose":"ok"}`,
      );
      expect(r).not.toBeNull();
      expect(r!.decision).toBe(v.toUpperCase());
    }
  });
});

// ---------------------------------------------------------------------------
// analyzePrompt — leakage-prevention regressions (Critical RC1, RC2, RC3)
// ---------------------------------------------------------------------------

describe("analyzePrompt — RC1: parse failure does not leak raw output", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns PASS when LLM produces a 27-line non-JSON blob", async () => {
    const { infer } = await import("../inference/adapter.js");
    // Simulate the failure mode that produced "Asking 27 questions" in
    // production: a multi-line LLM ramble that contains no parseable JSON.
    const blob = Array.from({ length: 27 }, (_, i) => `Line ${i + 1}`).join(
      "\n",
    );
    vi.mocked(infer).mockResolvedValue(inferResp(blob));

    const result = await analyzePrompt(
      "Guarda este paper con referencia a Pipesong y a EurekaMD",
      "User: hola\nJarvis: hola",
    );

    expect(result).toBe("PASS");
  });

  it("returns PASS when JSON parses but decision is invalid", async () => {
    const { infer } = await import("../inference/adapter.js");
    vi.mocked(infer).mockResolvedValue(
      inferResp('{"decision":"FOO","intent":"x"}'),
    );

    const result = await analyzePrompt("any task", "User: x\nJarvis: y");
    expect(result).toBe("PASS");
  });

  it("returns PASS when LLM responds with prose explanation, no JSON", async () => {
    const { infer } = await import("../inference/adapter.js");
    vi.mocked(infer).mockResolvedValue(
      inferResp(
        "I think this message is asking about file management. Let me ask:\n1. Which file?\n2. Where to save?",
      ),
    );

    const result = await analyzePrompt("save this", "User: x\nJarvis: y");
    expect(result).toBe("PASS");
  });
});

describe("analyzePrompt — RC2: SPLIT path returns typed marker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefixes SPLIT plans so the router can frame them as proposals", async () => {
    const { infer } = await import("../inference/adapter.js");
    vi.mocked(infer).mockResolvedValue(
      inferResp(
        '{"decision":"SPLIT","intent":"Migrar 23 archivos","clarity":7,"risk":"low","impact":23,"context":"resolved","decompose":"split","split_plan":"1. Bloque A (6 archivos)\\n2. Bloque B (15 archivos)\\n3. Bloque C (2 archivos)"}',
      ),
    );

    // Provide enough context (>50 chars) so the cold-start guard does NOT
    // fire — we want to verify the SPLIT marker plumbing in isolation.
    const ctx =
      "User: estoy planeando migrar la carpeta projects/ completa.\nJarvis: ok, dime cuándo y arrancamos.";
    const result = await analyzePrompt(
      "Migra todos los archivos de la carpeta projects",
      ctx,
    );

    expect(result.startsWith("SPLIT:")).toBe(true);
    expect(result).toContain("Bloque A");
    expect(result).toContain("Bloque B");
  });
});

describe("analyzePrompt — RC3: cold-start guard forces PASS without context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forces PASS when recentContext is empty AND clarity ≥ 5 AND decision=ASK", async () => {
    const { infer } = await import("../inference/adapter.js");
    vi.mocked(infer).mockResolvedValue(
      inferResp(
        '{"decision":"ASK","intent":"x","clarity":6,"risk":"low","impact":1,"context":"unresolved","decompose":"ok","questions":["q1?","q2?"]}',
      ),
    );

    // No recent context — post-/compact or fresh channel.
    const result = await analyzePrompt("Long enough message body here.", "");
    expect(result).toBe("PASS");
  });

  it("forces PASS when recentContext is whitespace-only", async () => {
    const { infer } = await import("../inference/adapter.js");
    vi.mocked(infer).mockResolvedValue(
      inferResp(
        '{"decision":"SPLIT","intent":"x","clarity":7,"risk":"low","impact":12,"context":"unresolved","decompose":"split","split_plan":"step 1\\nstep 2"}',
      ),
    );

    const result = await analyzePrompt(
      "Long enough message body here.",
      "   \n  ",
    );
    expect(result).toBe("PASS");
  });

  it("does NOT force PASS when context is short but clarity is low", async () => {
    const { infer } = await import("../inference/adapter.js");
    vi.mocked(infer).mockResolvedValue(
      inferResp(
        '{"decision":"ASK","intent":"x","clarity":2,"risk":"high","impact":1,"context":"unresolved","decompose":"ok","questions":["q1?","q2?"]}',
      ),
    );

    const result = await analyzePrompt("ambiguous", "");
    // Clarity 2 < 5 — the guard should NOT fire; ASK should pass through.
    expect(result).not.toBe("PASS");
    expect(result).toContain("q1?");
  });

  it("does NOT force PASS when context exists, even if short", async () => {
    const { infer } = await import("../inference/adapter.js");
    vi.mocked(infer).mockResolvedValue(
      inferResp(
        '{"decision":"ASK","intent":"x","clarity":6,"risk":"low","impact":1,"context":"resolved","decompose":"ok","questions":["q1?","q2?"]}',
      ),
    );

    // Context has 60+ chars — well past the 50-char threshold.
    const ctx =
      "User: previous request about file X.\nJarvis: did the work, here is summary.";
    const result = await analyzePrompt("follow-up question", ctx);
    expect(result).not.toBe("PASS");
  });

  it("preserves PASS decision regardless of context", async () => {
    const { infer } = await import("../inference/adapter.js");
    vi.mocked(infer).mockResolvedValue(
      inferResp(
        '{"decision":"PASS","intent":"clear request","clarity":9,"risk":"low","impact":1,"context":"resolved","decompose":"ok"}',
      ),
    );

    const result = await analyzePrompt("clear request", "");
    expect(result).toBe("PASS");
  });

  it("preserves ASSUME path regardless of cold-start", async () => {
    const { infer } = await import("../inference/adapter.js");
    vi.mocked(infer).mockResolvedValue(
      inferResp(
        '{"decision":"ASSUME","intent":"x","clarity":5,"risk":"low","impact":2,"context":"unresolved","decompose":"ok","assumption":"Entiendo que quieres X"}',
      ),
    );

    const result = await analyzePrompt("ambiguous-ish task", "");
    expect(result.startsWith("ASSUME:")).toBe(true);
    expect(result).toContain("Entiendo");
  });

  // Audit W1: destructive prompts on cold start MUST still trigger ASK —
  // the cold-start guard is purely an ergonomics relief for low-risk asks.
  it("does NOT force PASS when risk=high, even on cold start", async () => {
    const { infer } = await import("../inference/adapter.js");
    vi.mocked(infer).mockResolvedValue(
      inferResp(
        '{"decision":"ASK","intent":"borrar archivos","clarity":7,"risk":"high","impact":15,"context":"unresolved","decompose":"ok","questions":["¿Cuál directorio exactamente?","¿Confirmas borrado permanente?"]}',
      ),
    );

    // Empty context (cold start) + clarity=7 (>5) — would normally force
    // PASS, but risk=high overrides to preserve the safety gate.
    const result = await analyzePrompt(
      "Borra todos los archivos del proyecto X",
      "",
    );
    expect(result).not.toBe("PASS");
    expect(result).toContain("directorio");
    expect(result).toContain("Confirmas");
  });
});

// ---------------------------------------------------------------------------
// Audit W2: producer/consumer coupling — analyzePrompt's question format
// must match router.ts's RC4 line-counter regex. This test pins both ends.
// ---------------------------------------------------------------------------

describe("ASK question format — router log-counter coupling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits questions matching router's `^\\s*\\d+[\\.)]\\s` counter regex", async () => {
    const { infer } = await import("../inference/adapter.js");
    vi.mocked(infer).mockResolvedValue(
      inferResp(
        '{"decision":"ASK","intent":"x","clarity":2,"risk":"high","impact":1,"context":"unresolved","decompose":"ok","questions":["¿Primera pregunta?","¿Segunda pregunta?"]}',
      ),
    );

    const result = await analyzePrompt(
      "Long enough message body for analysis",
      "User: setup\nJarvis: ok we have lots of context here for grounding",
    );
    // Mirror router.ts:1399 exactly.
    const ROUTER_RC4_REGEX = /^\s*\d+[\.\)]\s/;
    const numberedLines = result
      .split("\n")
      .filter((l) => ROUTER_RC4_REGEX.test(l));
    expect(numberedLines).toHaveLength(2);
    expect(numberedLines[0]).toMatch(/^1\.\s/);
    expect(numberedLines[1]).toMatch(/^2\.\s/);
  });
});
