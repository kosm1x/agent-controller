import { describe, it, expect } from "vitest";
import { renderConversationContext } from "./conversation-context.js";

describe("renderConversationContext", () => {
  it("renders empty string for absent or empty history (non-chat prompts stay byte-identical)", () => {
    expect(renderConversationContext(undefined)).toBe("");
    expect(renderConversationContext([])).toBe("");
  });

  it("renders turns with roles and flags the last user message as the live instruction", () => {
    const out = renderConversationContext([
      { role: "user", content: "Ya lo tienes. Cada archivo .md que generas" },
      { role: "assistant", content: "Sí — el mirror va a jarvis-kb." },
      {
        role: "user",
        content:
          "Primero establece el protocolo como debe ser, después haz un pase completo del KB",
      },
    ]);
    expect(out).toContain("## Conversación del hilo");
    expect(out).toContain("instrucción vigente");
    expect(out).toContain(
      "Usuario: Primero establece el protocolo como debe ser",
    );
    expect(out).toContain("Jarvis: Sí — el mirror va a jarvis-kb.");
    // The full instruction survives past any 60-char title truncation.
    expect(out).toContain("después haz un pase completo del KB");
  });
});
