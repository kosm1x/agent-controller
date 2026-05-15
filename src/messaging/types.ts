/**
 * Messaging layer types.
 *
 * Defines the adapter interface and message shapes for bidirectional
 * communication over WhatsApp, Telegram and email.
 */

/**
 * Channel identity. WhatsApp and Telegram are singletons. Email is
 * multi-mailbox: one adapter per configured account, each registered under a
 * distinct `email:<id>` name so the router routes replies back to the exact
 * mailbox a message arrived on. Code that branches on "is this email" must
 * use the `isEmailChannel()` predicate in router.ts (matches the bare
 * `"email"` and `email:<id>`), not an exact `=== "email"`.
 */
export type ChannelName = "whatsapp" | "telegram" | "email" | `email:${string}`;

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

/**
 * Email-channel policy. `owner-only` (default) treats the mailbox like the
 * Telegram channel — one trusted sender (the operator) drives Jarvis with full
 * tool access. `community-manager` treats the mailbox as a public-facing org
 * inbox: any sender's mail is read and answered, threads are per-sender, the
 * tool set is restricted to read-only / lookup, and the system prompt branches
 * to a "responding on behalf of the org" persona.
 */
export type EmailChannelMode = "owner-only" | "community-manager";

export interface ChannelAdapter {
  readonly name: ChannelName;
  /**
   * The owner address for this channel, when the adapter owns that mapping
   * itself (email accounts each carry their own owner). When absent, the
   * router falls back to its env-var lookup (WhatsApp/Telegram). In email
   * community-manager mode this is the operator escalation address (optional,
   * may be null) — it is NOT a sender filter in that mode.
   */
  readonly ownerAddress?: string | null;
  /**
   * Mode hint, set by email adapters. The router uses this to decide whether
   * to apply the restricted community-manager tool scope. Non-email adapters
   * leave it undefined.
   */
  readonly mode?: EmailChannelMode;
  start(): Promise<void>;
  send(msg: OutgoingMessage): Promise<string>; // Returns message ID
  onMessage(handler: (msg: IncomingMessage) => void): void;
  stop(): Promise<void>;
  /** Whether the channel is currently connected and receiving messages. */
  isConnected(): boolean;
}
