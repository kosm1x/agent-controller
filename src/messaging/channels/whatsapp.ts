/**
 * WhatsApp channel adapter using Baileys (Multi-Device).
 *
 * Owner-only, text-only. Reuses auth/reconnect patterns from CRM-Azteca.
 * Env vars: WHATSAPP_ENABLED, WHATSAPP_OWNER_JID
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

export class WhatsAppAdapter implements ChannelAdapter {
  readonly name = "whatsapp" as const;

  private sock: WASocket | null = null;
  private connected = false;
  private messageHandler: ((msg: IncomingMessage) => void) | null = null;
  private outgoingQueue: Array<{ to: string; text: string }> = [];
  private flushing = false;

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
      printQRInTerminal: true,
      browser: ["Mission Control", "Chrome", "1.0.0"],
    });

    this.sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect } = update;

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
        if (msg.key.fromMe) continue;

        const jid = msg.key.remoteJid;
        if (!jid || jid === "status@broadcast") continue;

        // Owner-only: ignore messages from non-owner JIDs
        if (jid !== OWNER_JID) continue;

        let text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          null;

        // Voice/audio message → transcribe via Whisper
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

        if (!text) continue;

        this.messageHandler({
          channel: "whatsapp",
          from: jid,
          text,
          timestamp: new Date(Number(msg.messageTimestamp) * 1000),
          replyTo: msg.key.id ?? undefined,
        });
      }
    });
  }

  async send(msg: OutgoingMessage): Promise<string> {
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
