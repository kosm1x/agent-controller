import { describe, it, expect, vi, afterEach } from "vitest";
import { TelegramStreamController } from "./telegram-stream.js";

function fakeBot() {
  const edits: string[] = [];
  const bot = {
    api: {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 777 }),
      editMessageText: vi
        .fn()
        .mockImplementation(async (_chat: string, _id: number, text: string) => {
          edits.push(text);
          return true;
        }),
    },
  };
  return { bot, edits };
}

describe("TelegramStreamController.reset()", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("before finalize: wipes to the placeholder and accepts chunks again (Phase 1.2 re-run contract)", async () => {
    const { bot, edits } = fakeBot();
    const ctl = new TelegramStreamController(
      bot as unknown as ConstructorParameters<typeof TelegramStreamController>[0],
      "12345",
    );
    await ctl.sendPlaceholder("⏳");
    ctl.appendChunk("Necesito `shell_exec` para esto.");
    ctl.reset("⏳");
    await Promise.resolve();
    expect(edits.at(-1)).toBe("⏳");
    await ctl.finalize("Publicado.");
    expect(edits.at(-1)).toContain("Publicado.");
  });

  it("2026-09-06 (qa-audit R2 W2): after finalize it is a no-op — a delivered reply is never replaced by ⏳", async () => {
    const { bot, edits } = fakeBot();
    const ctl = new TelegramStreamController(
      bot as unknown as ConstructorParameters<typeof TelegramStreamController>[0],
      "12345",
    );
    await ctl.sendPlaceholder("⏳");
    await ctl.finalize("🛑 Detenido.");
    const delivered = edits.at(-1);
    expect(delivered).toContain("Detenido");
    ctl.reset("⏳");
    ctl.appendChunk("Necesito `shell_exec` para esto.");
    await Promise.resolve();
    expect(edits.at(-1)).toBe(delivered);
  });
});

describe("TelegramStreamController.finalize()", () => {
  it("2026-09-24 (qa-audit W1): a placeholder that never landed → the reply is sent fresh, not dropped", async () => {
    const { bot, edits } = fakeBot();
    bot.api.sendMessage.mockRejectedValueOnce(new Error("429 Too Many Requests"));
    const ctl = new TelegramStreamController(
      bot as unknown as ConstructorParameters<typeof TelegramStreamController>[0],
      "12345",
    );
    await ctl.sendPlaceholder("⏳");
    expect(ctl.getMessageId()).toBeNull();
    await ctl.finalize("ESPN pide iniciar sesión otra vez.");
    expect(edits).toHaveLength(0);
    expect(bot.api.sendMessage).toHaveBeenLastCalledWith(
      "12345",
      expect.stringContaining("ESPN pide iniciar sesión"),
      { parse_mode: "HTML" },
    );
  });

  const longText = Array.from(
    { length: 150 },
    (_, i) => `Línea ${i}: ` + "palabra ".repeat(8),
  ).join("\n");

  it("edit path (qa-audit R2 W1): a long reply = one edit + the remaining chunks sent once each", async () => {
    const { bot, edits } = fakeBot();
    const ctl = new TelegramStreamController(
      bot as unknown as ConstructorParameters<typeof TelegramStreamController>[0],
      "12345",
    );
    await ctl.sendPlaceholder("⏳");
    bot.api.sendMessage.mockClear();
    await ctl.finalize(longText);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toContain("Línea 0:");
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
    const sent = bot.api.sendMessage.mock.calls.map((c) => String(c[1]));
    expect(sent.some((t) => t.includes("Línea 0:"))).toBe(false);
    expect(sent.at(-1)).toContain("Línea 149:");
  });

  it("fresh path (qa-audit R2 W1): a long reply with no placeholder = every chunk sent once, from the first", async () => {
    const { bot, edits } = fakeBot();
    bot.api.sendMessage.mockRejectedValueOnce(new Error("placeholder down"));
    const ctl = new TelegramStreamController(
      bot as unknown as ConstructorParameters<typeof TelegramStreamController>[0],
      "12345",
    );
    await ctl.sendPlaceholder("⏳");
    bot.api.sendMessage.mockClear();
    await ctl.finalize(longText);
    expect(edits).toHaveLength(0);
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(3);
    expect(String(bot.api.sendMessage.mock.calls[0][1])).toContain("Línea 0:");
    expect(String(bot.api.sendMessage.mock.calls[2][1])).toContain("Línea 149:");
  });

  it("spaces chunks 200 ms apart (Telegram rate limit) and waits after none but the last", async () => {
    const { bot } = fakeBot();
    bot.api.sendMessage.mockRejectedValueOnce(new Error("placeholder down"));
    const ctl = new TelegramStreamController(
      bot as unknown as ConstructorParameters<typeof TelegramStreamController>[0],
      "12345",
    );
    await ctl.sendPlaceholder("⏳");
    bot.api.sendMessage.mockClear();
    vi.useFakeTimers();
    try {
      let done = false;
      const p = ctl.finalize(longText).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(199);
      expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(200);
      expect(bot.api.sendMessage).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(true); // no trailing wait after the last chunk
      await p;
    } finally {
      vi.useRealTimers();
    }
  });

  it("an HTML chunk Telegram rejects is resent as plain text and the later chunks still go out (qa-audit R2 W1)", async () => {
    const { bot } = fakeBot();
    bot.api.sendMessage.mockRejectedValueOnce(new Error("placeholder down"));
    const ctl = new TelegramStreamController(
      bot as unknown as ConstructorParameters<typeof TelegramStreamController>[0],
      "12345",
    );
    await ctl.sendPlaceholder("⏳");
    bot.api.sendMessage.mockClear();
    bot.api.sendMessage.mockRejectedValueOnce(new Error("400 can't parse entities"));
    await ctl.finalize(longText);
    // chunk 0: HTML rejected → plain resend; chunks 1..2 as HTML.
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(4);
    expect(bot.api.sendMessage.mock.calls[1]).toHaveLength(2);
    expect(String(bot.api.sendMessage.mock.calls[3][1])).toContain("Línea 149:");
  });

  it("with no placeholder and Telegram down, finalize resolves (logged) instead of throwing into the router", async () => {
    const { bot } = fakeBot();
    bot.api.sendMessage.mockRejectedValue(new Error("network down"));
    const ctl = new TelegramStreamController(
      bot as unknown as ConstructorParameters<typeof TelegramStreamController>[0],
      "12345",
    );
    await ctl.sendPlaceholder("⏳");
    await expect(ctl.finalize("hola")).resolves.toBeUndefined();
  });

  it("finalize runs once (qa-audit R2 W2): a second call sends nothing", async () => {
    const { bot } = fakeBot();
    bot.api.sendMessage.mockRejectedValueOnce(new Error("placeholder down"));
    const ctl = new TelegramStreamController(
      bot as unknown as ConstructorParameters<typeof TelegramStreamController>[0],
      "12345",
    );
    await ctl.sendPlaceholder("⏳");
    await ctl.finalize("uno");
    const calls = bot.api.sendMessage.mock.calls.length;
    await ctl.finalize("dos");
    expect(bot.api.sendMessage.mock.calls.length).toBe(calls);
  });
});
