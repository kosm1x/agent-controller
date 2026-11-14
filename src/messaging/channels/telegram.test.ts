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

// The adapter's `new Bot(...)` is asserted on (queue 4ar); `init` rejects so
// start() stops right after construction (no network, no polling).
vi.mock("grammy", () => ({
  Bot: vi.fn(function () {
    return {
      command: vi.fn(),
      on: vi.fn(),
      catch: vi.fn(),
      api: { config: { use: vi.fn() } },
      init: vi.fn(async () => {
        throw new Error("stop after construct");
      }),
    };
  }),
}));
vi.mock("../../observability/prometheus.js", () => ({
  recordTelegramInboundLag: vi.fn(),
  recordTelegramPollSuccess: vi.fn(),
  recordTelegramPollFailure: vi.fn(),
}));

import { Bot } from "grammy";
import {
  recordTelegramInboundLag,
  recordTelegramPollFailure,
  recordTelegramPollSuccess,
} from "../../observability/prometheus.js";
import { TelegramAdapter } from "./telegram.js";
import {
  classifyPollError,
  decodeHtmlBytes,
  htmlToText,
  observeGetUpdates,
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

describe("text handler: `/loop` reaches the router, other slash text is dropped", () => {
  it("passes `/loop …` through; `/other`, `/loops` stay dropped; plain text passes", () => {
    const handlers = new Map<string, (ctx: unknown) => void>();
    const commands: string[] = [];
    const adapter = new TelegramAdapter();
    (adapter as unknown as { bot: unknown }).bot = {
      command: vi.fn((name: string) => commands.push(name)),
      catch: vi.fn(),
      on: vi.fn((ev: string | string[], fn: (ctx: unknown) => void) => {
        for (const e of [ev].flat()) handlers.set(e, fn);
      }),
    };
    (adapter as unknown as { setupHandlers(): void }).setupHandlers();
    const received: string[] = [];
    adapter.onMessage((m) => received.push(m.text));
    for (const text of [
      "/loop Ordena la carpeta de pruebas",
      "/LOOP Ordena la carpeta",
      "/other algo",
      "/loops algo",
      "hola",
    ]) {
      handlers.get("message:text")!({
        chat: { id: OWNER },
        message: { text, date: 0, message_id: 1 },
      });
    }
    expect(received).toEqual([
      "/loop Ordena la carpeta de pruebas",
      "/LOOP Ordena la carpeta",
      "hola",
    ]);
    // The registered commands are untouched (and `loop` is not one of them).
    expect(commands).toEqual(["ping", "chatid"]);
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
// CPU-time measurement. Process CPU time, not elapsed time: a fixed bound on elapsed time fails
// on a busy machine although nothing is wrong, while CPU time leaves out the time spent waiting
// for a processor.

/** CPU ms per call of `fn`: one warm-up call, then the minimum of 3 runs of `reps` calls each. */
function cpuMsPerCall(fn: () => unknown, reps = 1): number {
  fn();
  let best = Infinity;
  for (let r = 0; r < 3; r++) {
    const c0 = process.cpuUsage();
    for (let i = 0; i < reps; i++) fn();
    const d = process.cpuUsage(c0);
    best = Math.min(best, (d.user + d.system) / 1000);
  }
  return best / reps;
}

/** Bound on `growth4x().ratio`: linear work measures about 4, quadratic work about 16. */
const GROWTH_BOUND = 8;

/**
 * How the CPU time of `fn` grows from input `make(n)` to input `make(4 * n)`. Both sizes repeat
 * the call the same number of times, doubled until one run of the smaller size takes 40 ms, so
 * the figure is not lost in timer noise. Linear work grows about 4x and quadratic work about 16x,
 * whatever the machine's speed or load. The ratio is measured up to three times and the smallest
 * is kept, stopping at the first one under GROWTH_BOUND: on a busy machine one noisy measurement
 * can push a single ratio over the bound, but the noise does not repeat three times, while a real
 * super-linear change measures about 16x on every attempt and still fails. `largeMs` is the larger
 * size's CPU ms per call from the first attempt.
 */
function growth4x<T>(
  make: (size: number) => T,
  n: number,
  fn: (input: T) => unknown,
): { ratio: number; largeMs: number; label: string } {
  const small = make(n);
  const large = make(4 * n);
  let reps = 1;
  fn(small);
  for (;;) {
    const c0 = process.cpuUsage();
    for (let i = 0; i < reps; i++) fn(small);
    const d = process.cpuUsage(c0);
    if ((d.user + d.system) / 1000 >= 40 || reps >= 1_000_000) break;
    reps *= 2;
  }
  let ratio = Infinity;
  let largeMs = NaN;
  let label = "";
  for (let attempt = 1; attempt <= 3 && ratio >= GROWTH_BOUND; attempt++) {
    const a = cpuMsPerCall(() => fn(small), reps);
    const b = cpuMsPerCall(() => fn(large), reps);
    if (attempt === 1) largeMs = b;
    if (b / a < ratio) {
      ratio = b / a;
      label = `${b.toFixed(3)} ms / ${a.toFixed(3)} ms per call, ${reps} calls per run, attempt ${attempt}`;
    }
  }
  return { ratio, largeMs, label };
}

describe("htmlToText is linear and capped", () => {
  const MB = 1_000_000;
  const KB = 1_024;
  // Each shape grows from 16 KB to 64 KB: about 4x for linear work, 16x for a pattern that
  // rescans from each opener. Both sizes stay under 128 KB: across that size the cheapest shapes
  // measured a growth above 20x although the conversion is linear. CEILING_MS is per call at
  // 64 KB: the original 1 s at 1 MB, scaled to this size.
  const CEILING_MS = 64;
  it.each<[string, (size: number) => string]>([
    ["unclosed <script", (size) => "<script>" + "a".repeat(size)],
    ["repeated <script", (size) => "<script".repeat(size / 7)],
    ["repeated <", (size) => "<".repeat(size)],
    ["repeated <!--", (size) => "<!--".repeat(size / 4)],
    ["repeated < br", (size) => "< br".repeat(size / 4)],
    ["repeated <title", (size) => "<title".repeat(size / 6)],
    ["repeated &aaaa", (size) => ("&" + "a".repeat(40)).repeat(size / 41)],
  ])("%s converts in linear time (16 KB to 64 KB)", (_name, html) => {
    const g = growth4x(html, 16 * KB, (text) => htmlToText(text));
    expect(g.ratio, g.label).toBeLessThan(GROWTH_BOUND);
    expect(g.largeMs, g.label).toBeLessThan(CEILING_MS);
  });

  it("repeated <!-- at the 1 MB input cap converts in bounded CPU time", () => {
    const html = "<!--".repeat(MB / 4);
    expect(cpuMsPerCall(() => htmlToText(html))).toBeLessThan(1_000);
  });

  it("input over 1 MB is cut and the output says so", () => {
    // No elapsed-time bound (it would fail on a busy machine): the cut is proven by the message
    // below, and the runner's test timeout guards against a hang.
    const out = htmlToText("<p>x</p>" + "<".repeat(20 * MB));
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

// 2026-10-27 (queue 4ar): a dead getUpdates long poll sat for grammY's default
// 500 s client timeout; inbound lag was invisible after the fact.
describe("getUpdates stall: 45 s client timeout + inbound lag signal (queue 4ar)", () => {
  it("builds the Bot with client.timeoutSeconds 45 (not grammY's 500 s default)", async () => {
    vi.mocked(Bot).mockClear();
    await expect(new TelegramAdapter().start()).rejects.toThrow(
      "stop after construct",
    );
    expect(Bot).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Bot).mock.calls[0]).toEqual([
      FAKE_TOKEN,
      { client: { timeoutSeconds: 45 } },
    ]);
  });

  function handlerFor(event: string) {
    const handlers = new Map<string, (ctx: unknown) => unknown>();
    const adapter = new TelegramAdapter();
    (adapter as unknown as { bot: unknown }).bot = {
      command: vi.fn(),
      catch: vi.fn(),
      on: vi.fn((ev: string | string[], fn: (ctx: unknown) => unknown) => {
        for (const e of [ev].flat()) handlers.set(e, fn);
      }),
    };
    (adapter as unknown as { setupHandlers(): void }).setupHandlers();
    adapter.onMessage(() => {});
    return handlers.get(event)!;
  }

  const SECRET = "texto privado del operador";

  it("a message 40 s old warns with lag_s and records the gauge; never the text", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(recordTelegramInboundLag).mockClear();
    try {
      const date = Math.floor(Date.now() / 1000) - 40;
      handlerFor("message:text")({
        chat: { id: OWNER },
        message: { text: SECRET, date, message_id: 901 },
      });
      const warned = warn.mock.calls.map((c) => c.join(" "));
      expect(warned).toHaveLength(1);
      expect(warned[0]).toMatch(
        /^\[telegram\] inbound lag_s=\d+\.\d msgId=901 /,
      );
      expect(warned[0]).toContain("getUpdates stalled?");
      expect(warned[0]).not.toContain(SECRET);
      expect(log.mock.calls.flat().join(" ")).not.toContain("inbound lag_s=");
      expect(recordTelegramInboundLag).toHaveBeenCalledTimes(1);
      const lag = vi.mocked(recordTelegramInboundLag).mock.calls[0]![0];
      expect(lag).toBeGreaterThanOrEqual(40);
      expect(lag).toBeLessThan(45);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it("a fresh message logs the plain lag line and does not warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(recordTelegramInboundLag).mockClear();
    try {
      handlerFor("message:text")({
        chat: { id: OWNER },
        message: {
          text: SECRET,
          date: Math.floor(Date.now() / 1000),
          message_id: 902,
        },
      });
      expect(warn).not.toHaveBeenCalled();
      const logged = log.mock.calls.map((c) => c.join(" "));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatch(
        /^\[telegram\] inbound lag_s=\d+\.\d msgId=902$/,
      );
      expect(logged[0]).not.toContain(SECRET);
      expect(recordTelegramInboundLag).toHaveBeenCalledTimes(1);
      expect(
        vi.mocked(recordTelegramInboundLag).mock.calls[0]![0],
      ).toBeLessThan(5);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  /** Every console line (log + warn) that carries the lag marker. */
  function lagLines(
    log: ReturnType<typeof vi.spyOn>,
    warn: ReturnType<typeof vi.spyOn>,
  ): string[] {
    return [...log.mock.calls, ...warn.mock.calls]
      .map((c) => c.join(" "))
      .filter((l) => l.includes("inbound lag_s="));
  }

  // getFile rejects: the handler's own try/catch absorbs it after the lag line,
  // so no download or transcription runs.
  const failingApi = {
    getFile: vi.fn(async () => {
      throw new Error("no network in tests");
    }),
  };

  it.each([
    [
      "message:document",
      { document: { file_id: "f", file_name: "a.pdf", mime_type: "x" } },
    ],
    ["message:photo", { photo: [{ file_id: "p" }] }],
    ["message:voice", { voice: { file_id: "v", duration: 3 } }],
    ["message:audio", { audio: { file_id: "a", duration: 3 } }],
  ])(
    "%s logs the lag line and records the gauge",
    async (event, body) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(recordTelegramInboundLag).mockClear();
      try {
        await handlerFor(event)({
          chat: { id: OWNER },
          message: {
            ...body,
            date: Math.floor(Date.now() / 1000),
            message_id: 903,
          },
          api: failingApi,
        });
        const lines = lagLines(log, warn);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(
          /^\[telegram\] inbound lag_s=\d+\.\d msgId=903$/,
        );
        expect(recordTelegramInboundLag).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
        log.mockRestore();
        err.mockRestore();
      }
    },
  );

  it("a non-owner chat gets no lag line and no gauge write", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(recordTelegramInboundLag).mockClear();
    try {
      handlerFor("message:text")({
        chat: { id: `${OWNER}0` },
        message: { text: SECRET, date: 0, message_id: 904 },
      });
      expect(lagLines(log, warn)).toEqual([]);
      expect(recordTelegramInboundLag).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it("a future-dated message (clock skew) clamps to lag_s=0.0 and does not warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(recordTelegramInboundLag).mockClear();
    try {
      handlerFor("message:text")({
        chat: { id: OWNER },
        message: {
          text: SECRET,
          date: Math.floor(Date.now() / 1000) + 60,
          message_id: 905,
        },
      });
      expect(warn).not.toHaveBeenCalled();
      expect(lagLines(log, warn)).toEqual([
        "[telegram] inbound lag_s=0.0 msgId=905",
      ]);
      expect(recordTelegramInboundLag).toHaveBeenCalledWith(0);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });
});

// 2026-11-08 (queue 4ar): 8 min of silent grammY getUpdates retries. Errors
// mirror grammY 1.44's shapes (HttpError: name + `.error` cause; Bot API
// failures resolve as `{ ok: false, error_code }` inside the transformer).
describe("getUpdates observer: poll failures are counted and warned (queue 4ar)", () => {
  class FakeHttpError extends Error {
    constructor(
      message: string,
      readonly error: unknown,
    ) {
      super(message);
      this.name = "HttpError";
    }
  }
  type Prev = Parameters<typeof observeGetUpdates>[0];
  const call = (prev: (...a: unknown[]) => Promise<unknown>, method: string) =>
    observeGetUpdates(
      prev as unknown as Prev,
      method as "getUpdates",
      {} as never,
    );

  function reset() {
    vi.mocked(recordTelegramPollSuccess).mockClear();
    vi.mocked(recordTelegramPollFailure).mockClear();
  }

  it("is installed on the bot's API client right after construction", async () => {
    vi.mocked(Bot).mockClear();
    reset();
    await expect(new TelegramAdapter().start()).rejects.toThrow(
      "stop after construct",
    );
    const bot = vi.mocked(Bot).mock.results[0]!.value as {
      api: { config: { use: ReturnType<typeof vi.fn> } };
    };
    expect(bot.api.config.use).toHaveBeenCalledWith(observeGetUpdates);
    // start() stamps once up front so MCTelegramPollStalled has a clock.
    expect(recordTelegramPollSuccess).toHaveBeenCalledTimes(1);
  });

  it("passes other methods straight through and records nothing", async () => {
    reset();
    const res = { ok: true, result: { message_id: 1 } };
    const prev = vi.fn(async () => res);
    await expect(call(prev, "sendMessage")).resolves.toBe(res);
    expect(prev).toHaveBeenCalledWith("sendMessage", {}, undefined);
    expect(recordTelegramPollSuccess).not.toHaveBeenCalled();
    expect(recordTelegramPollFailure).not.toHaveBeenCalled();
  });

  it("a successful getUpdates stamps success once and returns the result", async () => {
    reset();
    const res = { ok: true, result: [] };
    await expect(call(async () => res, "getUpdates")).resolves.toBe(res);
    expect(recordTelegramPollSuccess).toHaveBeenCalledTimes(1);
    expect(recordTelegramPollFailure).not.toHaveBeenCalled();
  });

  it("a timed-out getUpdates records kind=timeout, warns one redacted line, rethrows", async () => {
    reset();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = new FakeHttpError(
      "Network request for 'getUpdates' failed!",
      new Error(
        `Request to 'getUpdates' timed out after 45 seconds ${FAKE_TOKEN} https://api.telegram.org/bot${FAKE_TOKEN}/getUpdates`,
      ),
    );
    try {
      await expect(
        call(async () => {
          throw err;
        }, "getUpdates"),
      ).rejects.toBe(err);
      expect(recordTelegramPollFailure).toHaveBeenCalledWith("timeout");
      expect(recordTelegramPollSuccess).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]![0]);
      expect(line).toContain("[telegram] getUpdates failed kind=timeout");
      expect(line).toContain("timed out after 45 seconds");
      expect(line).toMatch(/ \(queue 4ar\)$/);
      expect(line).not.toContain("retrying");
      expect(line).not.toContain(FAKE_TOKEN);
      expect(line).not.toContain(FAKE_TOKEN.split(":")[1]!.slice(0, 8));
    } finally {
      warn.mockRestore();
    }
  });

  it("a Bot API 502 resolved as ok:false records http_502 and still returns it", async () => {
    reset();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = { ok: false, error_code: 502, description: "Bad Gateway" };
    try {
      await expect(call(async () => res, "getUpdates")).resolves.toBe(res);
      expect(recordTelegramPollFailure).toHaveBeenCalledWith("http_502");
      expect(recordTelegramPollSuccess).not.toHaveBeenCalled();
      expect(String(warn.mock.calls[0]![0])).toContain(
        "kind=http_502 Bad Gateway",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("a network failure keeps the reason and replaces the URL with <url>", async () => {
    reset();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cause = new Error(
      `request to https://api.telegram.org/bot${FAKE_TOKEN}/getUpdates failed, reason: connect ETIMEDOUT 192.0.2.10:443`,
    );
    cause.name = "FetchError";
    try {
      await expect(
        call(async () => {
          throw new FakeHttpError("x", cause);
        }, "getUpdates"),
      ).rejects.toBeInstanceOf(FakeHttpError);
      expect(recordTelegramPollFailure).toHaveBeenCalledWith("network");
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
        "[telegram] getUpdates failed kind=network FetchError: request to <url> failed, reason: connect ETIMEDOUT 192.0.2.10:443 (queue 4ar)",
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("a token straddling the 160-char cut is redacted before the cut", async () => {
    reset();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // "Error: " (7) + 128 - 7 pad puts the token at offset 128: 32 chars of it
    // would survive a cut-then-redact order.
    const cause = new Error("x".repeat(128 - 7) + FAKE_TOKEN);
    try {
      await expect(
        call(async () => {
          throw new FakeHttpError("x", cause);
        }, "getUpdates"),
      ).rejects.toBeInstanceOf(FakeHttpError);
      const line = String(warn.mock.calls[0]![0]);
      expect(line).toContain("[REDACTED]");
      expect(line).not.toContain(FAKE_TOKEN.slice(0, 15));
      expect(line).not.toContain(FAKE_TOKEN.split(":")[1]!.slice(0, 8));
    } finally {
      warn.mockRestore();
    }
  });

  it("a clean stop (AbortError) is counted but not warned, and rethrown", async () => {
    reset();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = new FakeHttpError(
      "x",
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    );
    try {
      await expect(
        call(async () => {
          throw err;
        }, "getUpdates"),
      ).rejects.toBe(err);
      expect(recordTelegramPollFailure).toHaveBeenCalledWith("aborted");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("a 409 is counted but not warned (the adapter logs each 409 cycle)", async () => {
    reset();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = { ok: false, error_code: 409, description: "Conflict" };
    try {
      await expect(call(async () => res, "getUpdates")).resolves.toBe(res);
      expect(recordTelegramPollFailure).toHaveBeenCalledWith("http_409");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    [{ name: "GrammyError", error_code: 502 }, "http_502"],
    [new FakeHttpError("x", new Error("connect ECONNREFUSED")), "network"],
    [
      new FakeHttpError(
        "x",
        Object.assign(new Error("aborted"), { name: "AbortError" }),
      ),
      "aborted",
    ],
    [new Error("boom"), "other"],
  ])("classifyPollError(%#) -> %s", (err, kind) => {
    expect(classifyPollError(err)).toBe(kind);
  });
});
