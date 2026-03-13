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

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID;

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

    // Status check command
    this.bot.command("ping", (ctx) => {
      ctx.reply("Mission Control online.");
    });

    // Chat ID discovery
    this.bot.command("chatid", (ctx) => {
      ctx.reply(`Chat ID: ${ctx.chat.id}`);
    });

    this.bot.on("message:text", (ctx) => {
      if (!this.messageHandler) return;
      if (ctx.message.text.startsWith("/")) return;

      // Owner-only filter
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

    this.bot.catch((err) => {
      console.error("[telegram] Bot error:", err.message);
    });

    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          console.log(`[telegram] Bot connected: @${botInfo.username}`);
          resolve();
        },
      });
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
