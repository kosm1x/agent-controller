/**
 * WhatsApp channel adapter using Baileys (Multi-Device).
 *
 * Supports DM (owner-only) and group chats (mention-only).
 * Env vars: WHATSAPP_ENABLED, WHATSAPP_OWNER_JID, WHATSAPP_GROUP_JIDS
 */

import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WASocket,
} from "@whiskeysockets/baileys";
import fs from "fs";
import {
  isTranscriptionConfigured,
  transcribeBuffer,
} from "../../inference/transcription.js";
import type {
  ChannelAdapter,
  IncomingMessage,
  OutgoingMessage,
} from "../types.js";
import { formatForWhatsApp } from "../formatter.js";

const AUTH_DIR = "./data/whatsapp-session";
const OWNER_JID = process.env.WHATSAPP_OWNER_JID;

/** Allowed group JIDs (comma-separated env var). */
const GROUP_JIDS = new Set(
  (process.env.WHATSAPP_GROUP_JIDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

export class WhatsAppAdapter implements ChannelAdapter {
  readonly name = "whatsapp" as const;

  private sock: WASocket | null = null;
  private connected = false;
  private messageHandler: ((msg: IncomingMessage) => void) | null = null;
  private outgoingQueue: Array<{ to: string; text: string }> = [];
  private flushing = false;
  /** Active typing indicators — cleared on send. */
  private typingTimers = new Map<string, ReturnType<typeof setInterval>>();

  /** Start "composing" presence for a chat. Refreshes every 5s until stopped. */
  private startTyping(jid: string): void {
    if (this.typingTimers.has(jid)) return;
    const send = () => {
      this.sock?.sendPresenceUpdate("composing", jid).catch(() => {});
    };
    send(); // immediate
    this.typingTimers.set(jid, setInterval(send, 5_000));
  }

  /** Stop typing indicator for a chat. */
  private stopTyping(jid: string): void {
    const timer = this.typingTimers.get(jid);
    if (timer) {
      clearInterval(timer);
      this.typingTimers.delete(jid);
    }
    this.sock?.sendPresenceUpdate("paused", jid).catch(() => {});
  }

  async start(): Promise<void> {
    if (!OWNER_JID) {
      throw new Error(
        "WHATSAPP_OWNER_JID is required when WHATSAPP_ENABLED=true",
      );
    }

    fs.mkdirSync(AUTH_DIR, { recursive: true });
    return new Promise<void>((resolve, reject) => {
      this.connectInternal(resolve).catch(reject);
    });
  }

  private async connectInternal(onFirstOpen?: () => void): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const { version } = await fetchLatestWaWebVersion({}).catch(() => ({
      version: undefined,
    }));

    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, undefined as any),
      },
      browser: ["Mission Control", "Chrome", "1.0.0"],
    });

    this.sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      // QR code for first-time pairing — log the raw string so it can
      // be rendered with any QR tool (e.g. qrencode, online generator)
      if (qr) {
        console.log(
          `[whatsapp] QR code for pairing (paste into any QR renderer):\n${qr}`,
        );
      }

      if (connection === "close") {
        this.connected = false;
        const reason = (
          lastDisconnect?.error as { output?: { statusCode?: number } }
        )?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;

        console.log(
          `[whatsapp] Connection closed (reason: ${reason}, reconnect: ${shouldReconnect})`,
        );

        if (shouldReconnect) {
          setTimeout(() => {
            this.connectInternal().catch((err) => {
              console.error("[whatsapp] Reconnect failed:", err);
            });
          }, 3000);
        } else {
          console.log(
            "[whatsapp] Logged out. Delete ./data/whatsapp-session and restart to re-auth.",
          );
        }
      } else if (connection === "open") {
        this.connected = true;
        console.log("[whatsapp] Connected");

        this.flushOutgoingQueue().catch((err) =>
          console.error("[whatsapp] Failed to flush queue:", err),
        );

        if (onFirstOpen) {
          onFirstOpen();
          onFirstOpen = undefined;
        }
      }
    });

    this.sock.ev.on("creds.update", saveCreds);

    this.sock.ev.on("messages.upsert", async ({ messages }) => {
      if (!this.messageHandler) return;

      for (const msg of messages) {
        if (!msg.message) continue;

        const jid = msg.key.remoteJid;
        if (msg.key.fromMe) continue;
        if (!jid || jid === "status@broadcast") continue;

        const isGroup = jid.endsWith("@g.us");
        const senderJid = isGroup ? (msg.key.participant ?? null) : jid;

        // Access control:
        // DM: owner-only
        // Group: only allowed groups, mention-only
        if (isGroup) {
          if (!GROUP_JIDS.has(jid)) continue;
        } else {
          if (jid !== OWNER_JID) continue;
        }

        let text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          null;

        // Group: only respond when bot is mentioned (text or structured mention)
        // Bot identity: phone-based JID (5215640501088@s.whatsapp.net) AND
        // LID-based JID (196692976615515@lid). WhatsApp uses LID in mentions.
        const botJid = this.sock?.user?.id;
        const botNumber = botJid?.split(":")[0]?.split("@")[0];
        const botLid = (this.sock?.user as { lid?: string })?.lid
          ?.split(":")[0]
          ?.split("@")[0];
        if (isGroup) {
          if (text) {
            const mentionedJids =
              msg.message.extendedTextMessage?.contextInfo?.mentionedJid ?? [];
            const isMentioned =
              mentionedJids.some((m) => {
                const id = m.split(":")[0]?.split("@")[0];
                return id === botNumber || id === botLid;
              }) ||
              (botNumber && text.includes(`@${botNumber}`)) ||
              (botLid && text.includes(`@${botLid}`));
            if (!isMentioned) continue;
            // Strip all forms of @mention from the text
            if (botNumber) text = text.replaceAll(`@${botNumber}`, "");
            if (botLid) text = text.replaceAll(`@${botLid}`, "");
            text = text.trim();
          } else {
            // Audio/media in group without text mention — skip
            continue;
          }
        }

        // Voice/audio message → transcribe via Whisper (DM only — groups filtered above)
        if (!text && msg.message.audioMessage) {
          if (isTranscriptionConfigured()) {
            try {
              const buffer = (await downloadMediaMessage(
                msg,
                "buffer",
                {},
              )) as Buffer;
              const mimetype = msg.message.audioMessage.mimetype || "audio/ogg";
              const ext = (mimetype.split("/")[1] || "ogg")
                .split(";")[0]
                .trim();
              const duration = msg.message.audioMessage.seconds || 0;
              const sizeKB = Math.round(buffer.length / 1024);

              console.log(
                `[whatsapp] Voice message: ${sizeKB}KB, ${duration}s`,
              );

              const result = await transcribeBuffer(buffer, ext);
              if (result?.text) {
                text = `[Audio: ${duration}s, ${sizeKB}KB, confianza ${(result.confidence * 100).toFixed(0)}%]\n\nTranscripción:\n${result.text}`;
              } else {
                text = `[Audio: ${duration}s — no se pudo transcribir]`;
              }
            } catch (err) {
              console.warn(
                `[whatsapp] Voice transcription failed: ${err instanceof Error ? err.message : err}`,
              );
              text = `[Audio recibido — transcripción falló]`;
            }
          } else {
            console.warn(
              "[whatsapp] Voice message received but WHISPER not configured",
            );
          }
        }

        // Image message → download + base64 for vision
        let imageUrl: string | undefined;
        if (msg.message.imageMessage) {
          try {
            const buffer = (await downloadMediaMessage(
              msg,
              "buffer",
              {},
            )) as Buffer;
            const mimetype = msg.message.imageMessage.mimetype || "image/jpeg";
            const base64 = buffer.toString("base64");
            imageUrl = `data:${mimetype};base64,${base64}`;
            const sizeKB = Math.round(buffer.length / 1024);
            console.log(`[whatsapp] Image received: ${sizeKB}KB, ${mimetype}`);
            // Use caption as text, or default prompt
            if (!text) {
              text =
                msg.message.imageMessage.caption || "¿Qué ves en esta imagen?";
            }
          } catch (err) {
            console.warn(
              `[whatsapp] Image download failed: ${err instanceof Error ? err.message : err}`,
            );
          }
        }

        if (!text) continue;

        // Sender identity: phone number from JID (no API call needed)
        const senderName =
          isGroup && senderJid ? senderJid.split("@")[0] : undefined;

        // Start typing indicator — user sees "composing..." while task runs
        this.startTyping(jid);

        this.messageHandler({
          channel: "whatsapp",
          from: jid, // Group JID for groups, owner JID for DM — reply routes correctly
          text: isGroup
            ? `[Grupo: ${jid.split("@")[0]}, De: ${senderName ?? "desconocido"}]\n${text}`
            : text,
          timestamp: new Date(Number(msg.messageTimestamp) * 1000),
          replyTo: msg.key.id ?? undefined,
          imageUrl,
          metadata: isGroup
            ? { isGroup: true, groupJid: jid, senderJid, senderName }
            : undefined,
        });
      }
    });
  }

  async send(msg: OutgoingMessage): Promise<string> {
    // Stop typing indicator when response is ready
    this.stopTyping(msg.to);

    const text = formatForWhatsApp(msg.text);

    if (!this.connected || !this.sock) {
      this.outgoingQueue.push({ to: msg.to, text });
      console.log(
        `[whatsapp] Disconnected, message queued (${this.outgoingQueue.length} in queue)`,
      );
      return "queued";
    }

    try {
      const result = await this.sock.sendMessage(msg.to, { text });
      return result?.key?.id ?? "sent";
    } catch (err) {
      this.outgoingQueue.push({ to: msg.to, text });
      console.error("[whatsapp] Send failed, queued:", err);
      return "queued";
    }
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  async stop(): Promise<void> {
    this.connected = false;
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0 || !this.sock) return;
    this.flushing = true;

    try {
      console.log(
        `[whatsapp] Flushing ${this.outgoingQueue.length} queued messages`,
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        await this.sock.sendMessage(item.to, { text: item.text });
      }
    } finally {
      this.flushing = false;
    }
  }
}
