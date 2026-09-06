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
