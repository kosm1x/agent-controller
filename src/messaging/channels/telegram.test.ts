/**
 * Tests for the Telegram attachment persistence helper (2026-07-22 fix:
 * document bytes are saved to /tmp/jarvis-downloads so pdf_read/gemini_upload
 * have a real source path — previously discarded after text extraction).
 */

import { describe, it, expect, vi } from "vitest";

// telegram.ts reads the owner chat id at import; the document test needs one.
const OWNER = vi.hoisted(() => {
  process.env.TELEGRAM_OWNER_CHAT_ID ??= "4242";
  return process.env.TELEGRAM_OWNER_CHAT_ID;
});
vi.mock("fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("fs/promises")>()),
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
}));

import { TelegramAdapter } from "./telegram.js";
import { sanitizeAttachmentName } from "./telegram.js";
import { EXTRACTED_FILE_MARKER } from "../extracted-file.js";

describe("sanitizeAttachmentName", () => {
  it("keeps ordinary filenames intact", () => {
    expect(sanitizeAttachmentName("EurekaMS_Intelligence_Evolution.pdf")).toBe(
      "EurekaMS_Intelligence_Evolution.pdf",
    );
    expect(sanitizeAttachmentName("report-v2.1.pdf")).toBe("report-v2.1.pdf");
  });

  it("strips path components (no traversal via file_name)", () => {
    expect(sanitizeAttachmentName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeAttachmentName("/etc/cron.d/evil")).toBe("evil");
  });

  it("replaces shell-hostile characters", () => {
    expect(sanitizeAttachmentName("mi archivo (final) ¡ya!.pdf")).toBe(
      "mi_archivo__final___ya_.pdf",
    );
  });

  it("falls back to 'document' when name is missing or empty", () => {
    expect(sanitizeAttachmentName(undefined)).toBe("document");
    expect(sanitizeAttachmentName("")).toBe("document");
  });

  it("caps length at 120 chars", () => {
    expect(sanitizeAttachmentName("a".repeat(300) + ".pdf").length).toBe(120);
  });
});

describe("send() failure contract (2026-08-03 — the tally is a consent record)", () => {
  function adapterWithBot(sendMessage: ReturnType<typeof vi.fn>) {
    const adapter = new TelegramAdapter();
    // Inject a minimal bot double — initialize() needs a live token/polling.
    (adapter as unknown as { bot: unknown }).bot = {
      api: { sendMessage },
    };
    return adapter;
  }

  it("REJECTS (never resolves a sentinel) when every attempt fails — broadcastToAll must count it failed", async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error("429"));
    const adapter = adapterWithBot(sendMessage);
    await expect(
      adapter.send({ channel: "telegram", to: "1", text: "hola" }),
    ).rejects.toThrow();
    // HTML attempt + plain-text fallback both tried before giving up.
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("resolves the message id on success", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 77 });
    const adapter = adapterWithBot(sendMessage);
    await expect(
      adapter.send({ channel: "telegram", to: "1", text: "hola" }),
    ).resolves.toBe("77");
  });
});

describe("document handler writes EXTRACTED_FILE_MARKER before the file text (the DENUE guard cuts there)", () => {
  it("caption, then the marker line, then the extracted content", async () => {
    const handlers = new Map<string, (ctx: unknown) => Promise<void>>();
    const adapter = new TelegramAdapter();
    (adapter as unknown as { bot: unknown }).bot = {
      command: vi.fn(),
      catch: vi.fn(),
      on: vi.fn(
        (ev: string | string[], fn: (ctx: unknown) => Promise<void>) => {
          for (const e of [ev].flat()) handlers.set(e, fn);
        },
      ),
    };
    (adapter as unknown as { setupHandlers(): void }).setupHandlers();
    const received: string[] = [];
    adapter.onMessage((m) => received.push(m.text));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Fuente: DENUE 05/2026")),
    );
    try {
      await handlers.get("message:document")!({
        chat: { id: OWNER },
        message: {
          caption: "resúmelo",
          date: 0,
          message_id: 1,
          document: {
            file_id: "f",
            file_name: "notas.txt",
            mime_type: "text/plain",
          },
        },
        api: { getFile: vi.fn(async () => ({ file_path: "p" })) },
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(received).toHaveLength(1);
    const text = received[0]!;
    const at = text.indexOf(EXTRACTED_FILE_MARKER);
    expect(at).toBeGreaterThan(-1);
    expect(text.slice(0, at)).toBe("resúmelo\n\n");
    expect(text.slice(at)).toContain("Fuente: DENUE 05/2026");
  });
});
