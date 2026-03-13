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

export async function shutdownMessaging(): Promise<void> {
  if (router) {
    await router.stopAll();
    router = null;
    console.log("[messaging] Shutdown complete");
  }
}
