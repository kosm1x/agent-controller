import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../inference/adapter.js", () => ({
  infer: vi.fn(async () => ({
    content: "¡Hola Fede! ¿Cómo va todo?",
    tool_calls: null,
    usage: { prompt_tokens: 50, completion_tokens: 10 },
  })),
}));

const { isConversationalFastPath, fastPathRespond } =
  await import("./fast-path.js");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isConversationalFastPath", () => {
  // --- Should fast-path (true) ---
  it.each([
    "hola",
    "Hola!",
    "buenos días",
    "Buenas tardes!",
    "buenas noches",
    "qué tal",
    "cómo estás",
    "qué onda",
    "adiós",
    "hasta luego",
    "nos vemos",
    "bye",
    "hello",
    "hi",
    "good morning",
    "thanks",
  ])("returns true for greeting/farewell: %s", (text) => {
    expect(isConversationalFastPath(text)).toBe(true);
  });

  it.each([
    "me siento bien",
    "estoy contento",
    "qué calor",
    "mucho trabajo",
    "vamos bien",
    "Hablame de la serie de TV Community",
    "Cuéntame sobre tu día favorito",
    "Dime algo interesante sobre México",
    "Estoy pensando en cambiar de carrera",
  ])("returns false for 3+ word messages (full pipeline): %s", (text) => {
    expect(isConversationalFastPath(text)).toBe(false);
  });

  // --- Should NOT fast-path (false) ---
  it.each([
    "qué hora es?",
    "busca noticias de IA",
    "crea una tarea",
    "envía un correo",
    "publica el artículo",
    "lee el PDF",
    "genera una imagen",
    "revisa el calendario",
    "programa un recordatorio",
  ])("returns false for tool-needing message: %s", (text) => {
    expect(isConversationalFastPath(text)).toBe(false);
  });

  it("returns false for long messages", () => {
    expect(
      isConversationalFastPath(
        "Fue una noche larga, tal vez no tan exitosa como otras, pero estamos haciéndote mejor",
      ),
    ).toBe(false);
  });

  it("returns false for questions ending with ?", () => {
    expect(isConversationalFastPath("todo bien?")).toBe(false);
  });

  it("returns false for messages with project keywords", () => {
    expect(isConversationalFastPath("abre el proyecto")).toBe(false);
  });

  it("returns false for messages with image keywords", () => {
    expect(isConversationalFastPath("manda la foto")).toBe(false);
  });
});

describe("fastPathRespond", () => {
  it("returns a response string", async () => {
    const result = await fastPathRespond("hola", []);
    expect(result).toBe("¡Hola Fede! ¿Cómo va todo?");
  });

  it("passes thread turns for continuity", async () => {
    const { infer } = await import("../inference/adapter.js");
    const mockInfer = infer as ReturnType<typeof vi.fn>;

    await fastPathRespond("qué tal", [
      { role: "user", content: "hola" },
      { role: "assistant", content: "¡Hola!" },
    ]);

    const call = mockInfer.mock.calls[0];
    const messages = call[0].messages;
    // system + 2 thread turns + current user message = 4
    expect(messages).toHaveLength(4);
    expect(messages[0].role).toBe("system");
    expect(messages[1].content).toBe("hola");
    expect(messages[2].content).toBe("¡Hola!");
    expect(messages[3].content).toBe("qué tal");
  });

  it("uses fallback provider for speed", async () => {
    const { infer } = await import("../inference/adapter.js");
    const mockInfer = infer as ReturnType<typeof vi.fn>;

    await fastPathRespond("hey", []);

    const optionsArg = mockInfer.mock.calls[0][1] as { providerName?: string };
    expect(optionsArg?.providerName).toBe("fallback");
  });

  it("returns fallback emoji if infer returns empty", async () => {
    const { infer } = await import("../inference/adapter.js");
    (infer as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      content: "",
      tool_calls: null,
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    });

    const result = await fastPathRespond("hola", []);
    expect(result).toBe("👋");
  });
});
