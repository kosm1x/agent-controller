import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockInfer = vi.hoisted(() => vi.fn());
vi.mock("../inference/adapter.js", () => ({ infer: mockInfer }));

import {
  CLASSIFIER_SYSTEM_PROMPT,
  VALID_GROUPS,
  classifyScopeGroups,
} from "./scope-classifier.js";
import {
  JEV_SCOPE_THRESHOLD,
  classifyScopeGroupsWithJev,
  jevScopeEnabled,
  mustNotLeave,
} from "./scope-classifier-jev.js";

// Assembled at runtime: a literal would trip the repo's secret guard.
const SECRET = "Xy" + "7" + "kQ9" + "zz";

const mockFetch = vi.fn();

/** A vendor body answering every group; `picked` get 0.9, the rest 0.1. */
function body(picked: string[], override: Record<string, number> = {}) {
  const answers: Record<string, { noul: number }> = {};
  for (const g of VALID_GROUPS)
    answers[`g_${g}`] = {
      noul: override[g] ?? (picked.includes(g) ? 0.9 : 0.1),
    };
  return { answers, usage: { input_tokens: 5800 } };
}
const ok = (json: unknown) => ({
  ok: true,
  status: 200,
  json: async () => json,
});

const ask = (message: string, context?: string) =>
  classifyScopeGroupsWithJev(
    message,
    context,
    CLASSIFIER_SYSTEM_PROMPT,
    VALID_GROUPS,
  );

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  vi.stubEnv("TYPESAFE_API_KEY", "test-key");
  vi.stubEnv("SCOPE_CLASSIFIER_PROVIDER", "");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  mockFetch.mockReset();
  mockInfer.mockReset();
});

describe("jevScopeEnabled", () => {
  it("is on when the key is present", () => {
    expect(jevScopeEnabled()).toBe(true);
  });

  it("is off without a key", () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    expect(jevScopeEnabled()).toBe(false);
  });

  it("is off when the kill switch names sonnet", () => {
    vi.stubEnv("SCOPE_CLASSIFIER_PROVIDER", "sonnet");
    expect(jevScopeEnabled()).toBe(false);
  });
});

describe("classifyScopeGroupsWithJev", () => {
  it("sends the retest's request and keeps the groups at the threshold", async () => {
    mockFetch.mockResolvedValue(
      ok(
        // Hard numbers: the registered threshold is 0.70, not "the constant".
        body(["coding"], { research: 0.7, utility: 0.69 }),
      ),
    );
    const groups = await ask(
      "revisa el deploy",
      "assistant: listo\nuser: revisa el deploy",
    );
    expect([...(groups ?? [])].sort()).toEqual(["coding", "research"]);
    expect(JEV_SCOPE_THRESHOLD).toBe(0.7);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.headers.Authorization).toBe("Bearer test-key");
    const sent = JSON.parse(init.body);
    expect(sent.model).toBe("jev-1.13.0");
    expect(sent.state.message).toBe("revisa el deploy");
    expect(sent.state.recent_context).toBe(
      "assistant: listo\nuser: revisa el deploy",
    );
    expect(sent.state.classifier_rules.length).toBeGreaterThan(5);
    expect(sent.state.classifier_examples.length).toBeGreaterThan(0);
    expect(Object.keys(sent.questions).sort()).toEqual(
      [...VALID_GROUPS].map((g) => `g_${g}`).sort(),
    );
  });

  it("returns an empty set when Jev answers that no group is needed", async () => {
    mockFetch.mockResolvedValue(ok(body([])));
    expect((await ask("gracias"))?.size).toBe(0);
  });

  it("never sends a credential-shaped message", async () => {
    expect(
      await ask(`entra a la liga\nLogin: pedro\nPswd: ${SECRET}`),
    ).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("never sends a message carrying an e-mail address", async () => {
    expect(await ask("escribe a ana@clinica.mx y confirma")).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("never sends a credential-shaped context, even under a role label", async () => {
    expect(
      await ask("ahora entra", `user: Pswd: ${SECRET}\nuser: ahora entra`),
    ).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("never sends a bare opaque token, as the message or as the previous turn", async () => {
    expect(await ask(SECRET)).toBeNull();
    expect(
      await ask("usa ese codigo", `user: ${SECRET}\nuser: usa ese codigo`),
    ).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
    // A lone URL or path is not a token.
    expect(mustNotLeave("https://example.com/a1b2")).toBe(false);
    expect(mustNotLeave("/root/claude/v2")).toBe(false);
  });

  it("does not withhold a turn over the role labels themselves", async () => {
    mockFetch.mockResolvedValue(ok(body(["coding"])));
    expect(
      await ask("corre los tests", "assistant: hecho\nuser: corre los tests"),
    ).not.toBeNull();
    expect(mustNotLeave("corre los tests")).toBe(false);
  });

  it("returns null on a vendor error", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({}),
    });
    expect(await ask("revisa el deploy")).toBeNull();
  });

  it("returns null on a non-2xx even when the body looks like an answer", async () => {
    mockFetch.mockResolvedValue({
      ...ok(body(["coding"])),
      ok: false,
      status: 500,
    });
    expect(await ask("revisa el deploy")).toBeNull();
  });

  it("returns null on a body that does not answer every group", async () => {
    mockFetch.mockResolvedValue(ok({ answers: { g_coding: { noul: 0.9 } } }));
    expect(await ask("revisa el deploy")).toBeNull();
  });

  it("returns null when the request throws (timeout, network)", async () => {
    mockFetch.mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    expect(await ask("revisa el deploy")).toBeNull();
  });

  it("returns null without a key and sends nothing", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    expect(await ask("revisa el deploy")).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("classifyScopeGroups wiring", () => {
  it("uses Jev's answer and does not call Sonnet", async () => {
    mockFetch.mockResolvedValue(ok(body(["coding"])));
    const groups = await classifyScopeGroups("revisa el deploy");
    expect(groups?.has("coding")).toBe(true);
    expect(mockInfer).not.toHaveBeenCalled();
  });

  it("adds the deterministic finance group to Jev's answer", async () => {
    mockFetch.mockResolvedValue(ok(body(["coding"])));
    const groups = await classifyScopeGroups("precio de $AAPL hoy");
    expect(groups?.has("finance")).toBe(true);
  });

  it("treats the kill switch case- and space-insensitively", async () => {
    vi.stubEnv("SCOPE_CLASSIFIER_PROVIDER", " Sonnet ");
    expect(jevScopeEnabled()).toBe(false);
  });

  it("falls back to Sonnet when Jev does not answer", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    mockInfer.mockResolvedValue({ content: '["research"]' });
    const groups = await classifyScopeGroups("busca noticias de hoy");
    expect(groups?.has("research")).toBe(true);
    expect(mockInfer).toHaveBeenCalledTimes(1);
  });

  it("sends withheld text to Sonnet, never to Jev", async () => {
    mockInfer.mockResolvedValue({ content: '["coding"]' });
    const groups = await classifyScopeGroups(`Login: pedro\nPswd: ${SECRET}`);
    expect(groups?.has("coding")).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("goes straight to Sonnet when the kill switch is set", async () => {
    vi.stubEnv("SCOPE_CLASSIFIER_PROVIDER", "sonnet");
    mockInfer.mockResolvedValue({ content: '["coding"]' });
    await classifyScopeGroups("revisa el deploy");
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockInfer).toHaveBeenCalledTimes(1);
  });
});
