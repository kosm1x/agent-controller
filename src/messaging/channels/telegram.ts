/**
 * Telegram channel adapter using Grammy (long-polling).
 *
 * Owner-only. Filters by TELEGRAM_OWNER_CHAT_ID.
 * Env vars: TELEGRAM_ENABLED, TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_CHAT_ID
 */

import { Bot } from "grammy";
import type {
  ChannelAdapter,
  IncomingMessage,
  OutgoingMessage,
} from "../types.js";
import { formatForTelegram } from "../formatter.js";
import { extractPdfFromUrl, extractPdfToMarkdown } from "../../lib/pdf.js";
import { writeFile, mkdir } from "fs/promises";
import { basename, join } from "path";
import {
  isTranscriptionConfigured,
  transcribeBuffer,
} from "../../inference/transcription.js";
import { errMsg } from "../../lib/err-msg.js";
import { EXTRACTED_FILE_MARKER } from "../extracted-file.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID;
const MAX_FILE_CONTENT = 15_000; // chars
const DOWNLOADS_DIR = "/tmp/jarvis-downloads"; // same root gdrive_download uses

/**
 * Remove the bot token from text that leaves this adapter (message text, log
 * lines). Telegram file URLs embed it (`api.telegram.org/file/bot<token>/…`);
 * until 2026-10-03 the HTML path sent that URL to Jina Reader, whose
 * `URL Source:` echo carried the token into the message, the day-log and
 * every store downstream. Both the URL form and any bare occurrence of the
 * configured token are replaced.
 */
export function redactBotToken(
  text: string,
  token: string | undefined = BOT_TOKEN,
): string {
  const out = text.replace(
    /(api\.telegram\.org\/(?:file\/)?bot)[^/\s"'<>]+/gi,
    "$1[REDACTED]",
  );
  return token ? out.split(token).join("[REDACTED]") : out;
}

const HTML_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Input cap for `htmlToText` — it runs on the event loop; 20 MB is allowed in. */
const HTML_MAX_INPUT = 1_000_000;

// Elements whose whole content is dropped.
const DROPPED_ELEMENT_RE =
  /^<(head|script|style|noscript|template|svg)(?![\w-])/;

/** A numeric entity's character, or "" for controls, surrogates, BOM, out of range. */
function numericEntity(code: number): string {
  if (code === 9 || code === 10 || code === 13)
    return String.fromCharCode(code);
  if (
    !(code > 0 && code <= 0x10ffff) ||
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0xd800 && code <= 0xdfff) ||
    code === 0xfeff
  )
    return "";
  return String.fromCodePoint(code);
}

function decodeEntities(s: string): string {
  return s.replace(
    /&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{1,32});/gi,
    (m, e: string) => {
      if (e[0] !== "#") return HTML_ENTITIES[e.toLowerCase()] ?? m;
      return numericEntity(
        e[1] === "x" || e[1] === "X"
          ? parseInt(e.slice(2), 16)
          : parseInt(e.slice(1), 10),
      );
    },
  );
}

/**
 * Remove comments and dropped elements with an index walk — no backtracking
 * regex over the whole document (an unclosed `<script` or `<!--` used to make
 * the lazy patterns quadratic). An unclosed one drops the rest.
 */
function stripDroppedBlocks(html: string, lower: string): string {
  let out = "";
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    if (lower.startsWith("<!--", lt)) {
      const e = lower.indexOf("-->", lt + 4);
      i = e === -1 ? html.length : e + 3;
      continue;
    }
    const m = DROPPED_ELEMENT_RE.exec(lower.slice(lt, lt + 12));
    if (m) {
      const close = lower.indexOf(`</${m[1]}`, lt + 1);
      const gt = close === -1 ? -1 : lower.indexOf(">", close);
      i = gt === -1 ? html.length : gt + 1;
      continue;
    }
    out += "<";
    i = lt + 1;
  }
  return out;
}

/**
 * HTML → plain text, locally. Replaces the Jina Reader round-trip, which had
 * to be handed the token-bearing file URL. Keeps the <title>, drops
 * head/script/style/comments, turns block ends into line breaks. Linear: input
 * over HTML_MAX_INPUT is cut first and the output says so.
 */
export function htmlToText(input: string): string {
  const cut = input.length > HTML_MAX_INPUT;
  const html = cut ? input.slice(0, HTML_MAX_INPUT) : input;
  const lower = html.toLowerCase();
  let title = "";
  const ts = lower.indexOf("<title");
  const tgt = ts === -1 ? -1 : lower.indexOf(">", ts);
  const te = tgt === -1 ? -1 : lower.indexOf("</title", tgt);
  if (te !== -1) title = decodeEntities(html.slice(tgt + 1, te)).trim();
  const body = decodeEntities(
    stripDroppedBlocks(html, lower)
      .replace(
        /<\s*(?:br|hr)(?![\w-])[^<>]*>|<\/\s*(?:p|div|tr|li|h[1-6]|section|article|table|ul|ol|blockquote|pre)\s*>/gi,
        "\n",
      )
      .replace(/<[^<>]*>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const note = cut
    ? `[HTML truncado: solo se convirtieron los primeros ${HTML_MAX_INPUT.toLocaleString("en-US")} de ${input.length.toLocaleString("en-US")} caracteres]\n\n`
    : "";
  return `${note}${title ? `Title: ${title}\n\n` : ""}${body}`;
}

/**
 * Decode HTML bytes by BOM first, else in the charset the page declares
 * (`<meta charset>` or the http-equiv Content-Type) — Spanish pages in Latin-1/windows-1252 otherwise
 * garble every accent. UTF-8 when undeclared or unknown.
 */
export function decodeHtmlBytes(bytes: Uint8Array): string {
  // A byte-order mark wins over any declaration (WHATWG encoding sniffing).
  const [b0, b1, b2] = bytes;
  if (b0 === 0xef && b1 === 0xbb && b2 === 0xbf)
    return new TextDecoder("utf-8").decode(bytes);
  if (b0 === 0xff && b1 === 0xfe)
    return new TextDecoder("utf-16le").decode(bytes);
  if (b0 === 0xfe && b1 === 0xff)
    return new TextDecoder("utf-16be").decode(bytes);
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const label =
    /<meta\b[^<>]{0,512}?charset\s*=\s*["']?\s*([\w.:-]{1,40})/i.exec(
      head,
    )?.[1];
  if (label) {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // Unknown label → UTF-8 below.
    }
  }
  return new TextDecoder().decode(bytes);
}

function clipFileContent(text: string): string {
  return text.length > MAX_FILE_CONTENT
    ? text.slice(0, MAX_FILE_CONTENT) + "\n...(truncado)"
    : text;
}

/** Sanitize a Telegram attachment filename for local persistence. */
export function sanitizeAttachmentName(name: string | undefined): string {
  const base = basename(name ?? "document").replace(/[^\w.\-]/g, "_");
  return base.slice(0, 120) || "document";
}

// Telegram's bot API caps getFile downloads at 20 MB — mirror it as our own
// guard (qa W2) so a misbehaving CDN response can't fill the disk.
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * Persist the raw attachment bytes to DOWNLOADS_DIR so downstream tools
 * (pdf_read, gemini_upload) have a real source path. Image-only PDFs extract
 * 0 chars of text — before this, the bytes were discarded and the agent had
 * nothing to feed the vision path (2026-07-22 incident). Returns the saved
 * path + bytes (so callers can extract without re-downloading, qa W3), or
 * null on failure (message flow must not break on a save error).
 */
async function saveAttachmentToDisk(
  fileUrl: string,
  fileName: string | undefined,
): Promise<{ path: string; bytes: Uint8Array } | null> {
  try {
    const response = await fetch(fileUrl, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      console.warn(
        `[telegram] Attachment too large to persist: ${bytes.byteLength} bytes`,
      );
      return null;
    }
    await mkdir(DOWNLOADS_DIR, { recursive: true });
    const path = join(DOWNLOADS_DIR, sanitizeAttachmentName(fileName));
    await writeFile(path, bytes);
    console.log(
      `[telegram] Attachment saved: ${path} (${bytes.byteLength} bytes)`,
    );
    return { path, bytes };
  } catch (err) {
    console.warn(
      `[telegram] Attachment save failed: ${redactBotToken(errMsg(err))}`,
    );
    return null;
  }
}

/**
 * Download a file from Telegram and extract readable content.
 * PDFs: local extraction via OpenDataLoader (no external API).
 * HTML: downloads directly, converted locally (`htmlToText`) — the URL holds
 * the bot token and must not reach a third-party reader.
 * Text files: downloads directly.
 */
async function extractFileContent(
  telegramFileUrl: string,
  mimeType?: string,
): Promise<string> {
  try {
    const isPdf = mimeType?.includes("pdf") || telegramFileUrl.endsWith(".pdf");
    const isHtml =
      mimeType?.includes("html") || telegramFileUrl.endsWith(".html");

    if (isPdf) {
      return await extractPdfFromUrl(telegramFileUrl, {
        maxChars: MAX_FILE_CONTENT,
        timeoutMs: 30_000,
      });
    }

    if (isHtml) {
      return htmlToText(await downloadRawText(telegramFileUrl));
    }

    // For text-based files, download directly
    return await downloadRawText(telegramFileUrl);
  } catch (err) {
    return `[Error al extraer contenido: ${errMsg(err)}]`;
  }
}

async function downloadRawText(url: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return `[Error HTTP ${response.status}]`;
  return clipFileContent(redactBotToken(await response.text()));
}

/**
 * Sniff an image mime type from magic bytes. Telegram's file CDN returns
 * content-type `application/octet-stream` for photos, so we cannot trust the
 * HTTP header — we have to look at the actual bytes. Returns null for
 * unrecognized formats so the caller can decide whether to fall back.
 */
function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  // GIF: "GIF87a" or "GIF89a"
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "image/gif";
  }
  // WEBP: "RIFF" ???? "WEBP"
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * Download an image from Telegram and return as a base64 data URL
 * suitable for OpenAI-compatible vision APIs. The mime type is sniffed
 * from magic bytes because Telegram's CDN advertises octet-stream.
 */
async function downloadImageAsBase64(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    // Trust magic bytes over the HTTP header (Telegram sends octet-stream).
    // Fall back to HTTP header for unrecognized formats, then JPEG as a last
    // resort — Telegram photos are always JPEG on the wire.
    const sniffed = sniffImageMime(bytes);
    const headerType = response.headers.get("content-type");
    const mimeType =
      sniffed ??
      (headerType && headerType.startsWith("image/") ? headerType : null) ??
      "image/jpeg";
    const base64 = Buffer.from(buffer).toString("base64");
    return `data:${mimeType};base64,${base64}`;
  } catch (err) {
    console.error(
      "[telegram] Image download failed:",
      redactBotToken(errMsg(err)),
    );
    return null;
  }
}

export class TelegramAdapter implements ChannelAdapter {
  readonly name = "telegram" as const;

  private bot: Bot | null = null;
  private messageHandler: ((msg: IncomingMessage) => void) | null = null;
  private pollingActive = false;
  private restartAttempts = 0;
  // Audit W1 round 1: guards against a single failure incrementing the
  // restart counter twice (e.g. synchronous throw + async .catch both firing).
  private restartScheduled = false;
  // Audit W2 round 1: suppresses the "giving up" log when stop() closed the
  // bot on purpose. Set in stop(), checked at restartPolling() entry.
  private shuttingDown = false;
  // When true, the most recent polling failure was a 409 Conflict (external
  // rival getUpdates, see stabilization plan P0-1). Suppress the 3-line noise
  // pair for this specific class — a single terse line is logged at the
  // failure site instead. Cleared on any non-409 outcome.
  private lastFailureWas409 = false;
  private static readonly MAX_RESTART_ATTEMPTS = 5;

  /** True iff the error is a Telegram 409 Conflict from a competing getUpdates. */
  private static is409Conflict(err: unknown): boolean {
    const msg = errMsg(err);
    return (
      msg.includes("409: Conflict") &&
      msg.includes("terminated by other getUpdates")
    );
  }

  /** Expose bot instance for streaming controller. */
  getBot(): Bot | null {
    return this.bot;
  }

  /** Whether Telegram polling is actively connected. */
  isConnected(): boolean {
    return this.pollingActive && this.bot !== null;
  }

  /** Restart polling after a fatal error. Caps at 5 attempts, then gives up. */
  private restartPolling(): void {
    // Shutdown: silently exit. stop() already set shuttingDown + nulled bot.
    if (this.shuttingDown) {
      this.pollingActive = false;
      return;
    }
    // Re-entry guard (audit W1): if a restart is already scheduled, drop
    // duplicate calls rather than double-incrementing the counter. A single
    // failure that fires both `bot.start().catch` and the outer `try/catch`
    // would otherwise burn through two attempt slots per real failure.
    if (this.restartScheduled) return;
    if (
      this.restartAttempts >= TelegramAdapter.MAX_RESTART_ATTEMPTS ||
      !this.bot
    ) {
      console.error(
        `[telegram] Polling restart failed after ${this.restartAttempts} attempts — giving up`,
      );
      this.pollingActive = false;
      return;
    }
    this.restartAttempts++;
    this.pollingActive = false;
    this.restartScheduled = true;
    const delay = Math.min(5000 * this.restartAttempts, 30_000);
    // 409 path: terse single-line notice was already logged at the failure
    // site. Skip the "Restarting… / Restarted successfully" pair to avoid
    // 3× log noise per cycle for this known class.
    if (!this.lastFailureWas409) {
      console.warn(
        `[telegram] Restarting polling in ${delay}ms (attempt ${this.restartAttempts}/${TelegramAdapter.MAX_RESTART_ATTEMPTS})`,
      );
    }
    setTimeout(async () => {
      this.restartScheduled = false;
      if (!this.bot) return; // Shutdown happened during delay — abort restart
      try {
        await this.bot.api.deleteWebhook({ drop_pending_updates: true });
        // Attach .catch for the same reason as the initial start() —
        // polling-infra errors reject the promise and would otherwise go
        // unhandled. Route them back into restartPolling() via backoff.
        this.bot
          .start({
            drop_pending_updates: true,
            onStart: () => {
              if (!this.lastFailureWas409) {
                console.log("[telegram] Polling restarted successfully");
              }
              this.pollingActive = true;
              this.restartAttempts = 0; // Reset on success
              this.lastFailureWas409 = false;
            },
          })
          .catch((err) => {
            const conflict = TelegramAdapter.is409Conflict(err);
            this.lastFailureWas409 = conflict;
            if (conflict) {
              console.log(
                `[telegram] 409 conflict — external getUpdates rival, auto-recovering (every ~3min until token rotated; see stabilization plan P0-1)`,
              );
            } else {
              console.error(
                "[telegram] Polling loop died after restart:",
                errMsg(err),
              );
            }
            this.pollingActive = false;
            this.restartPolling();
          });
      } catch (err) {
        console.error("[telegram] Polling restart failed:", errMsg(err));
        this.restartPolling(); // Retry with backoff
      }
    }, delay);
  }

  async start(): Promise<void> {
    if (!BOT_TOKEN) {
      throw new Error(
        "TELEGRAM_BOT_TOKEN is required when TELEGRAM_ENABLED=true",
      );
    }
    if (!OWNER_CHAT_ID) {
      throw new Error(
        "TELEGRAM_OWNER_CHAT_ID is required when TELEGRAM_ENABLED=true",
      );
    }

    this.bot = new Bot(BOT_TOKEN);
    this.setupHandlers();

    // Initialize bot info (getMe) without starting polling
    await this.bot.init();
    console.log(`[telegram] Bot initialized: @${this.bot.botInfo.username}`);

    // Clear any stale polling sessions
    await this.bot.api.deleteWebhook({ drop_pending_updates: true });

    // Start polling in background — don't await (it resolves only on stop).
    // The .catch below is load-bearing: grammy's `bot.catch(...)` handles
    // MIDDLEWARE errors (inside command/message handlers), NOT polling-infra
    // errors from getUpdates. A 409 Conflict on getUpdates rejects the
    // start() promise, and without this .catch the rejection becomes an
    // `unhandled rejection` — the polling loop dies silently and Telegram
    // stays dead until a manual systemd restart. Route the rejection into
    // the same restartPolling() path middleware errors already use.
    this.bot
      .start({
        drop_pending_updates: true,
        onStart: () => {
          console.log("[telegram] Polling started");
          this.pollingActive = true;
        },
      })
      .catch((err) => {
        const conflict = TelegramAdapter.is409Conflict(err);
        this.lastFailureWas409 = conflict;
        if (conflict) {
          console.log(
            `[telegram] 409 conflict — external getUpdates rival, auto-recovering (every ~3min until token rotated; see stabilization plan P0-1)`,
          );
        } else {
          console.error("[telegram] Polling loop died:", errMsg(err));
        }
        this.pollingActive = false;
        this.restartPolling();
      });

    // Give polling a moment to confirm no 409
    await new Promise((r) => setTimeout(r, 2000));
  }

  /** Register command and message handlers on the bot instance. */
  private setupHandlers(): void {
    if (!this.bot) return;

    // Owner-only like every other handler (SEC-17): a stranger who finds the
    // bot must get silence, not a liveness oracle.
    this.bot.command("ping", (ctx) => {
      if (String(ctx.chat.id) !== OWNER_CHAT_ID) return;
      ctx.reply("Mission Control online.");
    });

    this.bot.command("chatid", (ctx) => {
      if (String(ctx.chat.id) !== OWNER_CHAT_ID) return;
      ctx.reply(`Chat ID: ${ctx.chat.id}`);
    });

    this.bot.on("message:text", (ctx) => {
      if (!this.messageHandler) return;
      // Slash commands stay dropped, except `/loop` (the router's unlimited-
      // task prefix — an unregistered command, so it falls through to here).
      if (
        ctx.message.text.startsWith("/") &&
        !/^\/loop\b/i.test(ctx.message.text)
      )
        return;

      const chatId = String(ctx.chat.id);
      if (chatId !== OWNER_CHAT_ID) return;

      this.messageHandler({
        channel: "telegram",
        from: chatId,
        text: ctx.message.text,
        timestamp: new Date(ctx.message.date * 1000),
        replyTo: String(ctx.message.message_id),
      });
    });

    // Handle document/file messages (PDFs, images, etc.)
    this.bot.on(["message:document", "message:photo"], async (ctx) => {
      if (!this.messageHandler) return;
      const chatId = String(ctx.chat.id);
      if (chatId !== OWNER_CHAT_ID) return;

      try {
        const doc = ctx.message.document;
        const photo = ctx.message.photo;
        const caption = ctx.message.caption ?? "";

        let fileContent = "";
        let fileLabel = "";
        let imageUrl: string | undefined;
        let savedPath: string | null = null;
        let isPdf = false;

        if (doc) {
          fileLabel = doc.file_name ?? "document";
          const file = await ctx.api.getFile(doc.file_id);
          const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

          // Image documents (sent as file) → vision path, same as photos
          const isImage = doc.mime_type?.startsWith("image/");
          if (isImage) {
            const base64Url = await downloadImageAsBase64(fileUrl);
            if (base64Url) {
              imageUrl = base64Url;
              console.log(
                `[telegram] Image document downloaded: ${Math.round(base64Url.length / 1024)}KB base64`,
              );
            } else {
              fileContent =
                "[Imagen recibida pero no se pudo descargar para análisis.]";
            }
          } else {
            // Non-image documents: persist raw bytes first, then extract text
            // from the saved copy (no second download — qa W3).
            const saved = await saveAttachmentToDisk(fileUrl, doc.file_name);
            savedPath = saved?.path ?? null;
            isPdf =
              doc.mime_type?.includes("pdf") || fileLabel.endsWith(".pdf");
            const isHtml =
              doc.mime_type?.includes("html") || fileLabel.endsWith(".html");
            if (saved && isPdf) {
              try {
                fileContent = await extractPdfToMarkdown(saved.path, {
                  maxChars: MAX_FILE_CONTENT,
                });
              } catch (err) {
                fileContent = `[Error al extraer contenido: ${errMsg(err)}]`;
              }
            } else if (saved) {
              // Text-ish and HTML files: decode the bytes we already have
              // (HTML converted locally — never a URL-based external reader).
              // Redact BEFORE clipping: a token cut at the clip boundary
              // would no longer match the redactor.
              const text = isHtml
                ? htmlToText(decodeHtmlBytes(saved.bytes))
                : new TextDecoder().decode(saved.bytes);
              fileContent = clipFileContent(redactBotToken(text));
            } else {
              // Save failed
              fileContent = await extractFileContent(fileUrl, doc.mime_type);
            }
          }
        } else if (photo && photo.length > 0) {
          fileLabel = "imagen";
          const largest = photo[photo.length - 1];
          const file = await ctx.api.getFile(largest.file_id);
          const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

          // Download image as base64 — passed directly to LLM via multimodal content
          const base64Url = await downloadImageAsBase64(fileUrl);
          if (base64Url) {
            imageUrl = base64Url;
            console.log(
              `[telegram] Image downloaded: ${Math.round(base64Url.length / 1024)}KB base64`,
            );
          } else {
            fileContent =
              "[Imagen recibida pero no se pudo descargar para análisis.]";
          }
        }

        let text: string;
        if (imageUrl) {
          // Vision path: image goes as imageUrl, text is just the caption/prompt
          text =
            caption || "El usuario envió una imagen. Descríbela y responde.";
        } else {
          const pathNote = savedPath
            ? `\n(Archivo original guardado en ${savedPath})`
            : "";
          // qa W1: the pdf_read/vision advice is PDF-only — for other formats
          // that extract empty, prescribe nothing (pdf_read on a .docx errors
          // and re-opens the improvisation loop this fix closes).
          const contentBlock = fileContent.trim()
            ? `\n\n${EXTRACTED_FILE_MARKER} "${fileLabel}" ---\n${fileContent}\n--- Fin del archivo ---${pathNote}`
            : savedPath && isPdf
              ? `\n\n[El archivo "${fileLabel}" no contiene texto extraíble — probablemente escaneado o basado en imágenes. Archivo guardado en ${savedPath}: usa pdf_read con esa ruta, o gemini_upload + gemini_research para análisis visual.]`
              : savedPath
                ? `\n\n[No se pudo extraer texto del archivo "${fileLabel}" — archivo guardado en ${savedPath}]`
                : `\n\n[No se pudo extraer contenido del archivo "${fileLabel}"]`;
          text = caption
            ? `${caption}${contentBlock}`
            : `El usuario envió un archivo: "${fileLabel}".${contentBlock}\n\nAnaliza el contenido y responde.`;
        }

        this.messageHandler({
          channel: "telegram",
          from: chatId,
          text: redactBotToken(text),
          imageUrl,
          timestamp: new Date(ctx.message.date * 1000),
          replyTo: String(ctx.message.message_id),
        });
      } catch (err) {
        console.error(
          "[telegram] File handler error:",
          redactBotToken(errMsg(err)),
        );
      }
    });

    // Handle voice notes and audio messages → transcribe via Whisper
    this.bot.on(["message:voice", "message:audio"], async (ctx) => {
      if (!this.messageHandler) return;
      const chatId = String(ctx.chat.id);
      if (chatId !== OWNER_CHAT_ID) return;

      if (!isTranscriptionConfigured()) {
        console.warn(
          "[telegram] Voice message received but WHISPER_API_URL/KEY not configured",
        );
        return;
      }

      try {
        const voice = ctx.message.voice;
        const audio = ctx.message.audio;
        const caption = ctx.message.caption ?? "";
        const duration = voice?.duration ?? audio?.duration ?? 0;
        const fileId = voice?.file_id ?? audio?.file_id;

        if (!fileId) return;

        const file = await ctx.api.getFile(fileId);
        const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

        // Download audio
        const response = await fetch(fileUrl, {
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          console.error(
            `[telegram] Voice download failed: HTTP ${response.status}`,
          );
          return;
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        const sizeKB = Math.round(buffer.length / 1024);

        console.log(`[telegram] Voice message: ${sizeKB}KB, ${duration}s`);

        // Transcribe
        const ext = voice
          ? "ogg"
          : (audio?.mime_type?.split("/")[1]?.split(";")[0] ?? "ogg");
        const result = await transcribeBuffer(buffer, ext);

        let text: string;
        if (result?.text) {
          const header = `[Audio: ${duration}s, ${sizeKB}KB, confianza ${(result.confidence * 100).toFixed(0)}%]`;
          text = caption
            ? `${caption}\n\n${header}\n\nTranscripción:\n${result.text}`
            : `${header}\n\nTranscripción:\n${result.text}`;
        } else {
          text = caption
            ? `${caption}\n\n[Audio: ${duration}s — no se pudo transcribir]`
            : `[Audio: ${duration}s — no se pudo transcribir]`;
        }

        this.messageHandler({
          channel: "telegram",
          from: chatId,
          text,
          timestamp: new Date(ctx.message.date * 1000),
          replyTo: String(ctx.message.message_id),
        });
      } catch (err) {
        console.error(
          "[telegram] Voice handler error:",
          redactBotToken(errMsg(err)),
        );
      }
    });

    this.bot.catch((err) => {
      console.error("[telegram] Bot error:", err.message);
      // Reconnect on fatal polling errors — without this, Telegram dies silently
      this.restartPolling();
    });
  }

  async send(msg: OutgoingMessage): Promise<string> {
    if (!this.bot) {
      // Throw, don't return a sentinel: broadcastToAll/sendBriefingToOwner
      // count any resolved send() as delivered, so a sentinel string here
      // silently drops messages and never increments the push-failure
      // counters (same class the email adapter fixed for SMTP failures).
      throw new Error(
        "Telegram bot not initialized (polling gave up or never started)",
      );
    }

    const chunks = formatForTelegram(msg.text);
    let lastMessageId = "";
    let plainFallbacks = 0;

    for (let i = 0; i < chunks.length; i++) {
      try {
        // Try HTML first, fall back to plain text (strip tags) on parse error
        const result = await this.bot.api
          .sendMessage(msg.to, chunks[i], { parse_mode: "HTML" })
          .catch(async () => {
            plainFallbacks++;
            const plain = chunks[i].replace(/<[^>]+>/g, "");
            return this.bot!.api.sendMessage(msg.to, plain);
          });
        lastMessageId = String(result.message_id);

        // Delay between chunks to avoid rate limits
        if (i < chunks.length - 1) {
          await new Promise((r) => setTimeout(r, 200));
        }
      } catch (err) {
        // Throw, don't return a sentinel (same invariant as the no-bot guard
        // above): broadcastToAll/sendBriefingToOwner count any RESOLVED send()
        // as delivered — a resolved "error" here would tally sent>0 on a total
        // failure, and since 2026-08-03 that tally is a CONSENT record (the
        // sync-surfacing surfaced_at stamp). A partial delivery (earlier chunks
        // landed, this one didn't) also throws: the strategic line rides in the
        // final chunk, so a lost tail means the operator did not see it.
        console.error("[telegram] Send failed:", err);
        throw err instanceof Error ? err : new Error(String(err));
      }
    }

    console.log(
      `[telegram] Sent ${chunks.length} chunk(s) to ${msg.to} (msgId=${lastMessageId}${plainFallbacks ? `, ${plainFallbacks} HTML→plain fallback` : ""})`,
    );
    return lastMessageId;
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  async stop(): Promise<void> {
    // Audit W2 round 1: signal shutdown BEFORE bot.stop() so any late
    // start() rejection that fires during teardown is silently absorbed
    // by restartPolling() instead of logging "giving up".
    this.shuttingDown = true;
    this.pollingActive = false;
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
    }
  }
}
