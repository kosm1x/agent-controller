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
// Token-shaped fixture assembled at runtime — never a literal in this public
// repo. Forced into the env (never `??=`) so no real token can reach a test.
const FAKE_TOKEN = vi.hoisted(() => {
  const t = ["4815162342", ["Zq", "x".repeat(31), "-9"].join("")].join(":");
  process.env.TELEGRAM_BOT_TOKEN = t;
  return t;
});
// Voice handler runs only with transcription configured.
vi.mock("../../inference/transcription.js", () => ({
  isTranscriptionConfigured: () => true,
  transcribeBuffer: vi.fn(async () => null),
}));
vi.mock("fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("fs/promises")>()),
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
}));

import { TelegramAdapter } from "./telegram.js";
import {
  decodeHtmlBytes,
  htmlToText,
  redactBotToken,
  sanitizeAttachmentName,
} from "./telegram.js";
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

// 2026-10-03: an .html attachment's file URL (which embeds the bot token) went
// to Jina Reader, whose `URL Source:` echo put the token into the message.

describe("bot token never leaves the adapter (2026-10-03)", () => {
  it("redactBotToken strips the file-URL and bare forms", () => {
    const text = `URL Source: https://api.telegram.org/file/bot${FAKE_TOKEN}/documents/file_3.html y api.telegram.org/bot${FAKE_TOKEN}/getMe; suelto ${FAKE_TOKEN}.`;
    const out = redactBotToken(text, FAKE_TOKEN);
    expect(out).not.toContain(FAKE_TOKEN);
    expect(out).toContain(
      "https://api.telegram.org/file/bot[REDACTED]/documents/file_3.html",
    );
    expect(out).toContain("api.telegram.org/bot[REDACTED]/getMe");
    // URL form is caught without knowing the token.
    expect(redactBotToken(text, undefined)).not.toContain(`bot${FAKE_TOKEN}`);
  });

  it("htmlToText converts locally: title, blocks, entities; drops script/style", () => {
    const html =
      "<html><head><title>Plan &amp; notas</title><style>p{}</style></head><body><h1>Uno</h1><p>dos&nbsp;tres &#8212; &#x41;</p><script>alert(1)</script></body></html>";
    expect(htmlToText(html)).toBe("Title: Plan & notas\n\nUno\ndos tres — A");
  });

  it("an .html attachment is fetched only from Telegram, converted locally, and the message carries no token", async () => {
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
    // The page itself names the URL it was saved from (a token-bearing one).
    const page = `<html><head><title>Reporte</title></head><body><p>Contenido real</p><a>https://api.telegram.org/file/bot${FAKE_TOKEN}/documents/x.html</a></body></html>`;
    const fetchMock = vi.fn(async () => new Response(page));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await handlers.get("message:document")!({
        chat: { id: OWNER },
        message: {
          date: 0,
          message_id: 2,
          document: {
            file_id: "f",
            file_name: "reporte.html",
            mime_type: "text/html",
          },
        },
        api: {
          getFile: vi.fn(async () => ({ file_path: "documents/x.html" })),
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
    // One download, straight from Telegram — no third-party reader.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = String(
      (fetchMock.mock.calls[0] as unknown[] | undefined)?.[0],
    );
    expect(calledUrl).toBe(
      `https://api.telegram.org/file/bot${FAKE_TOKEN}/documents/x.html`,
    );
    expect(received).toHaveLength(1);
    const text = received[0]!;
    expect(text).toContain("Title: Reporte");
    expect(text).toContain("Contenido real");
    expect(text).not.toContain("<p>");
    expect(text).not.toContain(FAKE_TOKEN);
    expect(text).not.toMatch(
      /api\.telegram\.org\/(file\/)?bot(?!\[REDACTED\])/,
    );
  });
});

// Audit fold (2026-10-03): the converter runs on the event loop with up to
// 20 MB in; every pathological shape must stay linear.
describe("htmlToText is linear and capped", () => {
  const MB = 1_000_000;
  it.each([
    ["unclosed <script", "<script>" + "a".repeat(MB)],
    ["repeated <script", "<script".repeat(MB / 7)],
    ["repeated <", "<".repeat(MB)],
    ["repeated <!--", "<!--".repeat(MB / 4)],
    ["repeated < br", "< br".repeat(MB / 4)],
    ["repeated <title", "<title".repeat(MB / 6)],
    ["repeated &aaaa", ("&" + "a".repeat(40)).repeat(MB / 41)],
  ])("%s (1 MB) converts well under 1 s", (_name, html) => {
    const t0 = performance.now();
    htmlToText(html);
    expect(performance.now() - t0).toBeLessThan(1_000);
  });

  it("input over 1 MB is cut and the output says so", () => {
    const t0 = performance.now();
    const out = htmlToText("<p>x</p>" + "<".repeat(20 * MB));
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(out).toMatch(
      /^\[HTML truncado: solo se convirtieron los primeros 1,000,000 de 20,000,008 caracteres\]/,
    );
  });

  it("numeric entities never yield controls, lone surrogates or a BOM", () => {
    expect(
      htmlToText("<p>a&#1;b&#x7F;c&#xD800;d&#xFEFF;e&#x110000;f&#233;</p>"),
    ).toBe("abcdefé");
  });

  it("an unclosed comment or script drops the rest, not the text before it", () => {
    expect(htmlToText("<p>antes</p><!-- sin cierre <p>x</p>")).toBe("antes");
    expect(htmlToText("<p>antes</p><script>var a='<p>'")).toBe("antes");
  });
});

describe("decodeHtmlBytes honours the declared charset", () => {
  const latin1 = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));
  it("<meta charset> Latin-1", () => {
    const html = '<meta charset="iso-8859-1"><p>Año, acción</p>';
    expect(decodeHtmlBytes(latin1(html))).toContain("Año, acción");
  });
  it("http-equiv windows-1252", () => {
    const html =
      '<meta http-equiv="Content-Type" content="text/html; charset=windows-1252"><p>Señal</p>';
    expect(decodeHtmlBytes(latin1(html))).toContain("Señal");
  });
  it("a BOM wins over the meta scan: UTF-16LE, UTF-16BE, UTF-8", () => {
    const html = '<meta charset="iso-8859-1"><p>Año, acción</p>';
    const le = new Uint8Array([0xff, 0xfe, ...Buffer.from(html, "utf16le")]);
    expect(decodeHtmlBytes(le)).toBe(html);
    const be = Buffer.from(html, "utf16le").swap16();
    expect(decodeHtmlBytes(new Uint8Array([0xfe, 0xff, ...be]))).toBe(html);
    const u8 = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode(html),
    ]);
    expect(decodeHtmlBytes(u8)).toBe(html);
  });
  it("undeclared or unknown → UTF-8", () => {
    const utf8 = new TextEncoder().encode("<p>Año</p>");
    expect(decodeHtmlBytes(utf8)).toBe("<p>Año</p>");
    const bogus = new TextEncoder().encode(
      '<meta charset="nope-42"><p>Año</p>',
    );
    expect(decodeHtmlBytes(bogus)).toContain("Año");
  });
});

describe("token redaction: before the clip, and on every log line", () => {
  function wire() {
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
    return { handlers, received };
  }
  const tokenUrl = `https://api.telegram.org/file/bot${FAKE_TOKEN}/x`;
  const leaky = () => new TypeError(`Failed to parse URL from ${tokenUrl}`);

  async function logsOf(run: () => Promise<void>): Promise<string> {
    const lines: string[] = [];
    const cap = (...a: unknown[]) => {
      lines.push(
        a
          .map((x) =>
            x instanceof Error ? `${x.message} ${x.stack}` : String(x),
          )
          .join(" "),
      );
    };
    const w = vi.spyOn(console, "warn").mockImplementation(cap);
    const e = vi.spyOn(console, "error").mockImplementation(cap);
    const l = vi.spyOn(console, "log").mockImplementation(cap);
    try {
      await run();
    } finally {
      w.mockRestore();
      e.mockRestore();
      l.mockRestore();
      vi.unstubAllGlobals();
    }
    return lines.join("\n");
  }

  // The token starts 20 chars before the 15,000-char clip, so the clip lands
  // inside its secret half: clip-then-redact would keep a 20-char partial.
  it.each([
    ["saved bytes", false],
    ["save failed → downloadRawText", true],
  ])(
    "a token straddling the 15,000-char clip does not survive as a partial (%s)",
    async (_path, saveFails) => {
      const { handlers, received } = wire();
      const body = () =>
        new Response("a".repeat(14_979) + ` ${FAKE_TOKEN} ` + "b".repeat(100));
      const fetchMock = vi.fn(async () => body());
      if (saveFails) fetchMock.mockRejectedValueOnce(new Error("save down"));
      vi.stubGlobal("fetch", fetchMock);
      await logsOf(() =>
        handlers.get("message:document")!({
          chat: { id: OWNER },
          message: {
            date: 0,
            message_id: 3,
            document: {
              file_id: "f",
              file_name: "n.txt",
              mime_type: "text/plain",
            },
          },
          api: { getFile: vi.fn(async () => ({ file_path: "d/n.txt" })) },
        }),
      );
      expect(fetchMock).toHaveBeenCalledTimes(saveFails ? 2 : 1);
      expect(received).toHaveLength(1);
      expect(received[0]).toContain("(truncado)");
      expect(received[0]).not.toContain(FAKE_TOKEN.slice(0, 15));
    },
  );

  it("attachment-save log line (and the message) carry no token", async () => {
    const { handlers, received } = wire();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw leaky();
      }),
    );
    const logs = await logsOf(() =>
      handlers.get("message:document")!({
        chat: { id: OWNER },
        message: {
          date: 0,
          message_id: 4,
          document: {
            file_id: "f",
            file_name: "n.txt",
            mime_type: "text/plain",
          },
        },
        api: { getFile: vi.fn(async () => ({ file_path: "d/n.txt" })) },
      }),
    );
    expect(logs).toContain("Attachment save failed");
    expect(logs).not.toContain(FAKE_TOKEN);
    expect(received.join("")).not.toContain(FAKE_TOKEN);
  });

  it("image-download log line carries no token", async () => {
    const { handlers } = wire();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw leaky();
      }),
    );
    const logs = await logsOf(() =>
      handlers.get("message:photo")!({
        chat: { id: OWNER },
        message: { date: 0, message_id: 5, photo: [{ file_id: "p" }] },
        api: { getFile: vi.fn(async () => ({ file_path: "photos/p.jpg" })) },
      }),
    );
    expect(logs).toContain("Image download failed");
    expect(logs).not.toContain(FAKE_TOKEN);
  });

  it("file-handler log line carries no token", async () => {
    const { handlers } = wire();
    const logs = await logsOf(() =>
      handlers.get("message:document")!({
        chat: { id: OWNER },
        message: {
          date: 0,
          message_id: 6,
          document: {
            file_id: "f",
            file_name: "n.txt",
            mime_type: "text/plain",
          },
        },
        api: {
          getFile: vi.fn(async () => {
            throw leaky();
          }),
        },
      }),
    );
    expect(logs).toContain("File handler error");
    expect(logs).not.toContain(FAKE_TOKEN);
  });

  it("voice-handler log line carries no token", async () => {
    const { handlers } = wire();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw leaky();
      }),
    );
    const logs = await logsOf(() =>
      handlers.get("message:voice")!({
        chat: { id: OWNER },
        message: {
          date: 0,
          message_id: 7,
          voice: { file_id: "v", duration: 3 },
        },
        api: { getFile: vi.fn(async () => ({ file_path: "voice/v.ogg" })) },
      }),
    );
    expect(logs).toContain("Voice handler error");
    expect(logs).not.toContain(FAKE_TOKEN);
  });
});
