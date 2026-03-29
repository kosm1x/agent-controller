/**
 * Telegram streaming controller — progressive message updates.
 *
 * Sends a placeholder message, then edits it as LLM chunks arrive.
 * Throttled to ~1 edit per 1.5s to respect Telegram rate limits.
 * On finalize, applies full HTML formatting via formatForTelegram().
 */

import type { Bot } from "grammy";
import { formatForTelegram } from "../formatter.js";

const EDIT_THROTTLE_MS = 1_500;
const MAX_MSG_LENGTH = 4_000; // leave margin below Telegram's 4096 limit
const TYPING_INDICATOR = "▍";

export class TelegramStreamController {
  private bot: Bot;
  private chatId: string;
  private messageId: number | null = null;
  private accumulatedText = "";
  private lastEditTime = 0;
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private finalized = false;

  constructor(bot: Bot, chatId: string) {
    this.bot = bot;
    this.chatId = chatId;
  }

  /** Send the initial placeholder message. Must be called before appendChunk. */
  async sendPlaceholder(text = "⏳"): Promise<void> {
    try {
      const result = await this.bot.api.sendMessage(this.chatId, text);
      this.messageId = result.message_id;
    } catch (err) {
      console.error("[telegram-stream] Placeholder send failed:", err);
    }
  }

  /** Append a text chunk from the LLM. Triggers throttled edits. */
  appendChunk(text: string): void {
    if (this.finalized || !this.messageId) return;
    this.accumulatedText += text;
    this.scheduleEdit();
  }

  /**
   * Finalize with the complete response text (from task result).
   * Applies HTML formatting. This is the last edit — uses the guard-modified
   * text if hallucination guard fired.
   */
  async finalize(fullText: string): Promise<void> {
    this.finalized = true;
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }

    if (!this.messageId) return;

    try {
      const chunks = formatForTelegram(fullText);
      // Edit the existing message with the first chunk (HTML formatted)
      await this.bot.api
        .editMessageText(this.chatId, this.messageId, chunks[0], {
          parse_mode: "HTML",
        })
        .catch(async () => {
          // Fallback: plain text if HTML fails
          const plain = chunks[0].replace(/<[^>]+>/g, "");
          await this.bot.api.editMessageText(
            this.chatId,
            this.messageId!,
            plain,
          );
        });

      // Send remaining chunks as new messages (for long responses)
      for (let i = 1; i < chunks.length; i++) {
        await this.bot.api
          .sendMessage(this.chatId, chunks[i], { parse_mode: "HTML" })
          .catch(async () => {
            const plain = chunks[i].replace(/<[^>]+>/g, "");
            await this.bot.api.sendMessage(this.chatId, plain);
          });
        if (i < chunks.length - 1) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    } catch (err) {
      console.error("[telegram-stream] Finalize failed:", err);
      // Last resort: send as new message
      try {
        await this.bot.api.sendMessage(this.chatId, fullText.slice(0, 4000));
      } catch {
        /* give up */
      }
    }
  }

  /** Get the placeholder message ID (for the router to track). */
  getMessageId(): number | null {
    return this.messageId;
  }

  private scheduleEdit(): void {
    const now = Date.now();
    const elapsed = now - this.lastEditTime;

    if (elapsed >= EDIT_THROTTLE_MS) {
      this.doEdit();
    } else if (!this.editTimer) {
      this.editTimer = setTimeout(
        () => this.doEdit(),
        EDIT_THROTTLE_MS - elapsed,
      );
    }
  }

  private doEdit(): void {
    if (this.finalized || !this.messageId) return;
    this.editTimer = null;
    this.lastEditTime = Date.now();

    // Show accumulated text + typing indicator (plain text during streaming)
    const displayText =
      this.accumulatedText.slice(0, MAX_MSG_LENGTH) + TYPING_INDICATOR;

    this.bot.api
      .editMessageText(this.chatId, this.messageId, displayText)
      .catch(() => {
        // Silently ignore edit failures (rate limit, message unchanged, etc.)
      });
  }
}
