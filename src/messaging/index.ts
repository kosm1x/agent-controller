/**
 * Messaging layer init/shutdown/singleton.
 *
 * Channels are enabled via env vars (WHATSAPP_ENABLED, TELEGRAM_ENABLED).
 * If no channels are enabled, messaging is a no-op.
 */

import { MessageRouter } from "./router.js";

let router: MessageRouter | null = null;

export async function initMessaging(): Promise<MessageRouter | null> {
  router = new MessageRouter();

  if (process.env.WHATSAPP_ENABLED === "true") {
    const { WhatsAppAdapter } = await import("./channels/whatsapp.js");
    const wa = new WhatsAppAdapter();
    await wa.start();
    router.registerChannel(wa);
    console.log("[messaging] WhatsApp channel active");
  }

  if (process.env.TELEGRAM_ENABLED === "true") {
    const { TelegramAdapter } = await import("./channels/telegram.js");
    const tg = new TelegramAdapter();
    await tg.start();
    router.registerChannel(tg);
    console.log("[messaging] Telegram channel active");
  }

  if (process.env.EMAIL_ENABLED === "true") {
    const { EmailAdapter, parseEmailAccounts } =
      await import("./channels/email.js");
    // parseEmailAccounts() throws on a misconfigured .env — fail fast at boot
    // rather than silently running zero mailboxes. One adapter per account,
    // each registered under its own `email:<id>` channel name.
    const accounts = parseEmailAccounts();
    for (const account of accounts) {
      const email = new EmailAdapter(account);
      // Register before start(): start() runs an initial poll, and the adapter
      // must already hold the router's onMessage handler — otherwise unseen
      // owner mail present at boot is marked \Seen and silently dropped.
      router.registerChannel(email);
      await email.start();
    }
    console.log(
      `[messaging] Email channel active — ${accounts.length} mailbox(es)`,
    );
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
