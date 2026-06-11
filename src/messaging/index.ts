/**
 * Messaging layer init/shutdown/singleton.
 *
 * Channels are enabled via env vars (WHATSAPP_ENABLED, TELEGRAM_ENABLED).
 * If no channels are enabled, messaging is a no-op.
 */

import { MessageRouter } from "./router.js";
import { withTimeout } from "../lib/with-timeout.js";

let router: MessageRouter | null = null;

/** Per-channel init window. A channel's start() must not exceed this. */
const CHANNEL_START_TIMEOUT_MS = 20_000;

export async function initMessaging(): Promise<MessageRouter | null> {
  router = new MessageRouter();

  // Channel init is ISOLATED: a channel whose start() throws — or HANGS — must
  // not take down the others. WhatsApp's start() resolves only on a successful
  // connection open, so an invalid session (401) that closes instead leaves
  // start() pending forever; unbounded + uncaught, that hung the whole
  // messaging layer (Telegram + email never initialized). Bound and catch each.
  if (process.env.WHATSAPP_ENABLED === "true") {
    let wa: import("./channels/whatsapp.js").WhatsAppAdapter | null = null;
    try {
      const { WhatsAppAdapter } = await import("./channels/whatsapp.js");
      wa = new WhatsAppAdapter();
      await withTimeout(
        wa.start(),
        CHANNEL_START_TIMEOUT_MS,
        "WhatsApp start()",
      );
      router.registerChannel(wa);
      console.log("[messaging] WhatsApp channel active");
    } catch (err) {
      // The withTimeout rejection does NOT stop connectInternal(): without an
      // explicit stop(), the orphaned Baileys socket can connect later, hold
      // the WA session, and drop inbound messages into a null handler for the
      // life of the process.
      await wa?.stop().catch(() => {});
      console.error(
        "[messaging] WhatsApp channel FAILED — skipped:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (process.env.TELEGRAM_ENABLED === "true") {
    try {
      const { TelegramAdapter } = await import("./channels/telegram.js");
      const tg = new TelegramAdapter();
      await withTimeout(
        tg.start(),
        CHANNEL_START_TIMEOUT_MS,
        "Telegram start()",
      );
      router.registerChannel(tg);
      console.log("[messaging] Telegram channel active");
    } catch (err) {
      console.error(
        "[messaging] Telegram channel FAILED — skipped:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (process.env.EMAIL_ENABLED === "true") {
    // Same isolation contract as WhatsApp/Telegram: a broken email config or
    // a hanging mailbox must not crash main() (→ systemd crash-loop taking
    // down already-healthy channels). parseEmailAccounts() throwing on a
    // misconfigured .env is still loud — logged as FAILED — but non-fatal.
    try {
      const { EmailAdapter, parseEmailAccounts } =
        await import("./channels/email.js");
      // One adapter per account, each registered under its own `email:<id>`
      // channel name.
      const accounts = parseEmailAccounts();
      let active = 0;
      for (const account of accounts) {
        const email = new EmailAdapter(account);
        try {
          // Register before start(): start() runs an initial poll, and the
          // adapter must already hold the router's onMessage handler —
          // otherwise unseen owner mail present at boot is marked \Seen and
          // silently dropped.
          router.registerChannel(email);
          await withTimeout(
            email.start(),
            CHANNEL_START_TIMEOUT_MS,
            `Email start() [${account.id}]`,
          );
          active++;
        } catch (err) {
          router.unregisterChannel(email.name);
          console.error(
            `[messaging] Email mailbox ${account.id} FAILED — skipped:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
      console.log(
        `[messaging] Email channel active — ${active}/${accounts.length} mailbox(es)`,
      );
    } catch (err) {
      console.error(
        "[messaging] Email channel FAILED — skipped:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (router.channelCount === 0) {
    console.log("[messaging] No channels enabled");
    router = null;
    return null;
  }

  router.startEventListeners();
  console.log(
    `[messaging] Router active with ${router.channelCount} channel(s)`,
  );
  return router;
}

export function getRouter(): MessageRouter | null {
  return router;
}

/** Channel connection status for health endpoint. */
export function getMessagingStatus(): Record<string, boolean> {
  if (!router) return {};
  return router.getChannelStatus();
}

export async function shutdownMessaging(): Promise<void> {
  if (router) {
    await router.stopAll();
    router = null;
    console.log("[messaging] Shutdown complete");
  }
}
