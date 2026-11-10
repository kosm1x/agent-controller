/**
 * Parity (operator ruling 14): every redaction entry point must take its
 * shapes from the shared list in `./redact-secrets.ts`, so a shape added there
 * once is removed everywhere.
 *
 * Method: the shared module is mocked with a wrapper around the real
 * `redactSecretText` that also removes one INVENTED shape no entry point
 * knows on its own. Every entry point must then remove the invented shape.
 * An entry point that keeps its own list, or calls the shared function only
 * for some inputs, leaves the invented shape in place and this file fails.
 * This checks behaviour through the real import graph rather than scanning
 * source text for pattern literals, so it survives refactors of how a helper
 * is written and cannot be satisfied by an unused import.
 */

import { describe, expect, it, vi } from "vitest";

/** Assembled at runtime; a shape that exists only inside this test. */
const INVENTED = "qq" + "x9" + "_" + "7".repeat(12);

vi.mock("./redact-secrets.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./redact-secrets.js")>();
  return {
    ...real,
    redactSecretText: (input: string, opts: Parameters<typeof real.redactSecretText>[1]) =>
      real.redactSecretText(input.replace(/\bqqx9_7{12}\b/g, "[REDACTED_KEY]"), opts),
  };
});
vi.mock("../inference/adapter.js", () => ({ infer: vi.fn(), inferWithTools: vi.fn() }));
vi.mock("../tools/registry.js", () => ({ toolRegistry: { get: vi.fn(), getDefinitions: vi.fn(() => []) } }));

import {
  redactCredentials,
  redactCredentialsForPersist,
  redactDeep,
  redactSecrets as redactMcp,
  stringifyRedacted,
} from "../api/mcp-server/redact.js";
import { redactSecrets as redactMemory } from "../memory/recall-utility.js";
import { redactSecretsInArgs } from "../prometheus/executor.js";

const text = `value ${INVENTED} end`;

describe("every redaction entry point delegates to the shared list", () => {
  it.each<[string, () => unknown]>([
    ["mcp redactSecrets", () => redactMcp(text)],
    ["mcp redactCredentials", () => redactCredentials(text)],
    ["mcp redactCredentialsForPersist", () => redactCredentialsForPersist(text)],
    ["mcp stringifyRedacted", () => stringifyRedacted({ a: { b: [text] } })],
    ["mcp redactDeep", () => JSON.stringify(redactDeep({ a: [text] }))],
    ["memory redactSecrets", () => redactMemory(text)],
    ["executor redactSecretsInArgs (JSON args)", () => redactSecretsInArgs(JSON.stringify({ note: text }))],
    ["executor redactSecretsInArgs (non-JSON args)", () => redactSecretsInArgs(text)],
  ])("%s removes a shape that exists only in the shared list", (_entry, run) => {
    const out = String(run());
    expect(out).not.toContain(INVENTED);
    expect(out).toContain("[REDACTED_KEY]");
  });
});
