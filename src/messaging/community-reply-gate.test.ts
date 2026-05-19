/**
 * v7.7 Spine 1 Phase 2b — community-reply gate tests.
 *
 * Mocks `infer` per the codebase convention (see prometheus/reflector.test.ts).
 * The gate's behavior under critic mock pass/fail/error is the contract;
 * the actual critic prompt's claim-detection accuracy is a quality concern
 * verified by production telemetry, not unit tests.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  gateCommunityReply,
  COMMUNITY_REPLY_FALLBACK,
  COMMUNITY_REPLY_CRITIC_PROMPT,
} from "./community-reply-gate.js";
import { infer } from "../inference/adapter.js";

vi.mock("../inference/adapter.js", () => ({
  infer: vi.fn(),
}));

const mockInfer = vi.mocked(infer);

function mockInferResponse(content: string | null, costUsd = 0.0003) {
  mockInfer.mockResolvedValueOnce({
    content,
    usage: {
      prompt_tokens: 80,
      completion_tokens: 20,
      total_tokens: 100,
      cost_usd: costUsd,
    },
    provider: "test",
    latency_ms: 30,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("COMMUNITY_REPLY_FALLBACK — invariants", () => {
  it("contains an acknowledgement, no specific facts, no AI framing", () => {
    expect(COMMUNITY_REPLY_FALLBACK).toMatch(/Gracias por escribirnos/);
    expect(COMMUNITY_REPLY_FALLBACK).toMatch(
      /miembro del equipo te responderá/,
    );
    // No "AI", "IA", "Jarvis", "asistente", "Claude"
    expect(COMMUNITY_REPLY_FALLBACK).not.toMatch(
      /\b(AI|IA|Jarvis|asistente|Claude|chatbot)\b/i,
    );
    // No specific facts that would themselves need auditing
    expect(COMMUNITY_REPLY_FALLBACK).not.toMatch(/\$/);
    expect(COMMUNITY_REPLY_FALLBACK).not.toMatch(/\d{4}/); // no years
  });

  it("does NOT interpolate any dynamic sender name (safety property)", () => {
    // Bare neutral greeting — wrong-name inference defeats the safety
    expect(COMMUNITY_REPLY_FALLBACK).toMatch(/^Hola,/);
  });
});

describe("gateCommunityReply — pass path", () => {
  it("returns pass for empty/JSON-pass critic response", async () => {
    mockInferResponse('{"verdict":"pass","critique":""}');
    const r = await gateCommunityReply(
      "Hola, gracias por escribirnos. Un miembro del equipo te responderá pronto.",
    );
    expect(r.verdict).toBe("pass");
    expect(r.critique).toBe("");
    expect(r.error).toBe(false);
    expect(r.costUsd).toBe(0.0003);
  });

  it("returns pass with markdown-fenced JSON", async () => {
    mockInferResponse('```json\n{"verdict":"pass","critique":""}\n```');
    const r = await gateCommunityReply("Recibimos tu mensaje. Saludos.");
    expect(r.verdict).toBe("pass");
    expect(r.error).toBe(false);
  });
});

describe("gateCommunityReply — fail path", () => {
  it("returns fail with critique on specific factual claim", async () => {
    mockInferResponse(
      '{"verdict":"fail","critique":"Afirma una fecha específica (' +
        '15 de junio) sin cita verificable"}',
    );
    const r = await gateCommunityReply(
      "Hola, nuestro próximo evento es el 15 de junio en la sede central.",
    );
    expect(r.verdict).toBe("fail");
    expect(r.critique).toContain("fecha");
    expect(r.error).toBe(false);
  });

  it("returns fail with critique on monetary claim", async () => {
    mockInferResponse(
      '{"verdict":"fail","critique":"Cita monto específico ($50,000) sin cita verificable"}',
    );
    const r = await gateCommunityReply(
      "Confirmamos tu donativo de $50,000 MXN al programa de becas.",
    );
    expect(r.verdict).toBe("fail");
    expect(r.error).toBe(false);
  });
});

describe("gateCommunityReply — infra-error paths (fail-safe)", () => {
  it("treats empty critic response as fail+error (caller MUST fallback)", async () => {
    mockInferResponse("");
    const r = await gateCommunityReply("anything");
    expect(r.error).toBe(true);
    expect(r.verdict).toBe("fail");
    expect(r.critique).toContain("empty");
  });

  it("treats null content as fail+error", async () => {
    mockInferResponse(null);
    const r = await gateCommunityReply("anything");
    expect(r.error).toBe(true);
    expect(r.verdict).toBe("fail");
  });

  it("treats non-JSON prose as fail+error", async () => {
    mockInferResponse("This text seems fine to me, no issues.");
    const r = await gateCommunityReply("anything");
    expect(r.error).toBe(true);
    expect(r.verdict).toBe("fail");
    expect(r.critique).toContain("non-JSON");
  });

  it("treats infer() rejection as fail+error", async () => {
    mockInfer.mockRejectedValueOnce(new Error("upstream 503"));
    const r = await gateCommunityReply("anything");
    expect(r.error).toBe(true);
    expect(r.verdict).toBe("fail");
    expect(r.critique).toContain("upstream 503");
  });

  it("treats wrong-verdict-shape as fail+error (defense against critic drift)", async () => {
    mockInferResponse('{"verdict":"maybe","critique":"unsure"}');
    const r = await gateCommunityReply("anything");
    expect(r.error).toBe(true);
    expect(r.verdict).toBe("fail");
  });

  it("respects timeoutMs option", async () => {
    mockInfer.mockImplementationOnce(
      (_req, opts) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    const r = await gateCommunityReply("anything", { timeoutMs: 50 });
    expect(r.error).toBe(true);
    expect(r.verdict).toBe("fail");
  });

  it("pre-check: caller signal already aborted short-circuits without infer", async () => {
    const ac = new AbortController();
    ac.abort(new Error("caller budget exhausted"));
    const r = await gateCommunityReply("anything", { signal: ac.signal });
    expect(r.error).toBe(true);
    expect(r.verdict).toBe("fail");
    expect(r.critique).toContain("caller signal already aborted");
    expect(r.latencyMs).toBe(0);
    expect(mockInfer).not.toHaveBeenCalled();
  });
});

describe("gateCommunityReply — multi-object parser regression", () => {
  it("picks first valid verdict when critic emits example then real", async () => {
    mockInferResponse(
      'Ejemplo de verdict: {"verdict":"pass","critique":""}. Mi verdict real: {"verdict":"fail","critique":"x"}',
    );
    // First valid wins per the parser shared with audit/critic.ts
    const r = await gateCommunityReply("anything");
    expect(r.error).toBe(false);
    expect(r.verdict).toBe("pass");
  });

  it("balanced-paren walker handles nested objects in critique", async () => {
    mockInferResponse(
      '{"verdict":"fail","critique":"cita monto {ammount: 50000} sin verificación"}',
    );
    const r = await gateCommunityReply("anything");
    expect(r.error).toBe(false);
    expect(r.verdict).toBe("fail");
    expect(r.critique).toContain("monto");
  });
});

describe("gateCommunityReply — prompt + request shape", () => {
  it("uses the frozen critic system prompt + user-role wraps the text", async () => {
    mockInferResponse('{"verdict":"pass","critique":""}');
    await gateCommunityReply("Hola mundo");
    expect(mockInfer).toHaveBeenCalledOnce();
    const [request] = mockInfer.mock.calls[0];
    expect(request.messages[0].role).toBe("system");
    expect(request.messages[0].content).toBe(COMMUNITY_REPLY_CRITIC_PROMPT);
    expect(request.messages[1].role).toBe("user");
    expect(request.messages[1].content).toContain("Hola mundo");
    expect(request.messages[1].content).toContain("auditar");
    expect(request.temperature).toBe(0);
  });

  it("forwards providerName override", async () => {
    mockInferResponse('{"verdict":"pass","critique":""}');
    await gateCommunityReply("x", { providerName: "haiku" });
    const [, opts] = mockInfer.mock.calls[0];
    expect(opts?.providerName).toBe("haiku");
  });
});

describe("COMMUNITY_REPLY_CRITIC_PROMPT — invariants", () => {
  it("explicitly biases toward PASS when ambiguous (false-positive cost is real)", () => {
    expect(COMMUNITY_REPLY_CRITIC_PROMPT).toMatch(/INCL[IÍ]NATE A PASAR/i);
  });

  it("classifies system messages as PASS so reboot notifications aren't blocked", () => {
    expect(COMMUNITY_REPLY_CRITIC_PROMPT).toMatch(
      /[Mm]ensajes del sistema.*pasan/,
    );
  });

  it("enumerates the kinds of claims that should FAIL", () => {
    expect(COMMUNITY_REPLY_CRITIC_PROMPT).toMatch(/Tenemos X miembros/);
    expect(COMMUNITY_REPLY_CRITIC_PROMPT).toMatch(/15 de junio/);
    expect(COMMUNITY_REPLY_CRITIC_PROMPT).toMatch(/Aprobamos|Confirmamos/);
  });

  it("instructs JSON-only output", () => {
    expect(COMMUNITY_REPLY_CRITIC_PROMPT).toMatch(/EXCLUSIVAMENTE JSON/);
    expect(COMMUNITY_REPLY_CRITIC_PROMPT).toMatch(/"verdict".*"critique"/);
  });
});
