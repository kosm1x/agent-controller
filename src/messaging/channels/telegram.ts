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
import { extractPdfFromUrl } from "../../lib/pdf.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID;
const JINA_PREFIX = "https://r.jina.ai/";
const MAX_FILE_CONTENT = 15_000; // chars

/**
 * Download a file from Telegram and extract readable content.
 * PDFs: local extraction via OpenDataLoader (no external API).
 * HTML: routes through Jina Reader for Markdown conversion.
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
      // HTML still uses Jina Reader for clean Markdown conversion
      const response = await fetch(`${JINA_PREFIX}${telegramFileUrl}`, {
        headers: { Accept: "text/markdown" },
        signal: AbortSignal.timeout(20_000),
      });

      if (!response.ok) {
        return await downloadRawText(telegramFileUrl);
      }

      const content = await response.text();
      return content.length > MAX_FILE_CONTENT
        ? content.slice(0, MAX_FILE_CONTENT) + "\n...(truncado)"
        : content;
    }

    // For text-based files, download directly
    return await downloadRawText(telegramFileUrl);
  } catch (err) {
    return `[Error al extraer contenido: ${err instanceof Error ? err.message : err}]`;
  }
}

async function downloadRawText(url: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return `[Error HTTP ${response.status}]`;
  const text = await response.text();
  return text.length > MAX_FILE_CONTENT
    ? text.slice(0, MAX_FILE_CONTENT) + "\n...(truncado)"
    : text;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly name = "telegram" as const;

  private bot: Bot | null = null;
  private messageHandler: ((msg: IncomingMessage) => void) | null = null;

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

    // Start polling in background — don't await (it resolves only on stop)
    this.bot.start({
      drop_pending_updates: true,
      onStart: () => {
        console.log("[telegram] Polling started");
      },
    });

    // Give polling a moment to confirm no 409
    await new Promise((r) => setTimeout(r, 2000));
  }

  /** Register command and message handlers on the bot instance. */
  private setupHandlers(): void {
    if (!this.bot) return;

    this.bot.command("ping", (ctx) => {
      ctx.reply("Mission Control online.");
    });

    this.bot.command("chatid", (ctx) => {
      ctx.reply(`Chat ID: ${ctx.chat.id}`);
    });

    this.bot.on("message:text", (ctx) => {
      if (!this.messageHandler) return;
      if (ctx.message.text.startsWith("/")) return;

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

        if (doc) {
          fileLabel = doc.file_name ?? "document";
          const file = await ctx.api.getFile(doc.file_id);
          const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

          // Download and extract content server-side via Jina Reader
          fileContent = await extractFileContent(fileUrl, doc.mime_type);
        } else if (photo && photo.length > 0) {
          fileLabel = "imagen";
          const largest = photo[photo.length - 1];
          const file = await ctx.api.getFile(largest.file_id);
          const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
          fileContent = `[Imagen recibida — URL interna procesada. No se pudo extraer texto de la imagen.]`;
          // Future: could use vision model or OCR here
          void fileUrl; // suppress unused warning
        }

        const contentBlock = fileContent
          ? `\n\n--- Contenido extraído del archivo "${fileLabel}" ---\n${fileContent}\n--- Fin del archivo ---`
          : `\n\n[No se pudo extraer contenido del archivo "${fileLabel}"]`;

        const text = caption
          ? `${caption}${contentBlock}`
          : `El usuario envió un archivo: "${fileLabel}".${contentBlock}\n\nAnaliza el contenido y responde.`;

        this.messageHandler({
          channel: "telegram",
          from: chatId,
          text,
          timestamp: new Date(ctx.message.date * 1000),
          replyTo: String(ctx.message.message_id),
        });
      } catch (err) {
        console.error("[telegram] File handler error:", err);
      }
    });

    this.bot.catch((err) => {
      console.error("[telegram] Bot error:", err.message);
    });
  }

  async send(msg: OutgoingMessage): Promise<string> {
    if (!this.bot) {
      console.warn("[telegram] Bot not initialized");
      return "not_initialized";
    }

    const chunks = formatForTelegram(msg.text);
    let lastMessageId = "";

    for (let i = 0; i < chunks.length; i++) {
      try {
        // Try MarkdownV2 first, fall back to plain text on parse error
        const result = await this.bot.api
          .sendMessage(msg.to, chunks[i], { parse_mode: "MarkdownV2" })
          .catch(async () => {
            return this.bot!.api.sendMessage(msg.to, chunks[i]);
          });
        lastMessageId = String(result.message_id);

        // Delay between chunks to avoid rate limits
        if (i < chunks.length - 1) {
          await new Promise((r) => setTimeout(r, 200));
        }
      } catch (err) {
        console.error("[telegram] Send failed:", err);
        return "error";
      }
    }

    return lastMessageId;
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  async stop(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
    }
  }
}
