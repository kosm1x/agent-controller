/**
 * Messaging layer types.
 *
 * Defines the adapter interface and message shapes for bidirectional
 * communication over WhatsApp and Telegram.
 */

export type ChannelName = "whatsapp" | "telegram";

export interface IncomingMessage {
  channel: ChannelName;
  from: string; // JID (WhatsApp) or chat ID (Telegram)
  text: string;
  timestamp: Date;
  replyTo?: string; // Message ID for threading
  imageUrl?: string; // Base64 data URL for vision (from photos)
  metadata?: Record<string, unknown>;
}

export interface OutgoingMessage {
  channel: ChannelName;
  to: string;
  text: string; // Pre-formatted for target dialect
  replyTo?: string;
}

export interface ChannelAdapter {
  readonly name: ChannelName;
  start(): Promise<void>;
  send(msg: OutgoingMessage): Promise<string>; // Returns message ID
  onMessage(handler: (msg: IncomingMessage) => void): void;
  stop(): Promise<void>;
  /** Whether the channel is currently connected and receiving messages. */
  isConnected(): boolean;
}
