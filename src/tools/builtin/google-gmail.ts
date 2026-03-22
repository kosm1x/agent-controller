/**
 * Gmail tools — send and search emails.
 */

import type { Tool } from "../types.js";
import { googleFetch } from "../../google/client.js";

// ---------------------------------------------------------------------------
// gmail_send
// ---------------------------------------------------------------------------

export const gmailSendTool: Tool = {
  name: "gmail_send",
  requiresConfirmation: true,
  definition: {
    type: "function",
    function: {
      name: "gmail_send",
      description: `Send an email from Jarvis's Gmail account.

USE WHEN:
- The user asks to send an email, forward information, or share something via email
- You need to notify someone on behalf of the user

DO NOT USE WHEN:
- The user is asking about received emails (use gmail_search instead)`,
      parameters: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description: "Recipient email address",
          },
          subject: {
            type: "string",
            description: "Email subject line",
          },
          body: {
            type: "string",
            description:
              "Email body (plain text). Keep it professional and concise.",
          },
          cc: {
            type: "string",
            description: "CC email address (optional)",
          },
        },
        required: ["to", "subject", "body"],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const to = args.to as string;
    const subject = args.subject as string;
    const body = args.body as string;
    const cc = args.cc as string | undefined;

    try {
      // Encode subject per RFC 2047 if it contains non-ASCII characters
      const needsEncoding = /[^\x20-\x7E]/.test(subject);
      const encodedSubject = needsEncoding
        ? `=?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`
        : subject;

      // Build RFC 2822 email
      const headers = [
        "MIME-Version: 1.0",
        `To: ${to}`,
        `Subject: ${encodedSubject}`,
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: base64",
      ];
      if (cc) headers.push(`Cc: ${cc}`);

      // Base64-encode the body separately (Content-Transfer-Encoding: base64)
      // to safely handle UTF-8 characters in the body
      const bodyBase64 = Buffer.from(body).toString("base64");
      const raw = [...headers, "", bodyBase64].join("\r\n");
      const encoded = Buffer.from(raw)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      const result = await googleFetch<{ id: string; threadId: string }>(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        { method: "POST", body: { raw: encoded } },
      );

      return JSON.stringify({
        sent: true,
        to,
        subject,
        messageId: result.id,
      });
    } catch (err) {
      return JSON.stringify({
        error: `Failed to send email: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};

// ---------------------------------------------------------------------------
// gmail_search
// ---------------------------------------------------------------------------

export const gmailSearchTool: Tool = {
  name: "gmail_search",
  definition: {
    type: "function",
    function: {
      name: "gmail_search",
      description: `Search emails in Jarvis's Gmail inbox.

USE WHEN:
- The user asks about received emails, recent messages, or to find a specific email
- You need to check if an email was received from someone

Supports Gmail search operators: from:, to:, subject:, after:, before:, is:unread, has:attachment`,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              'Gmail search query (e.g., "from:john subject:invoice after:2026/03/01")',
          },
          max_results: {
            type: "number",
            description: "Max emails to return (1-10, default: 5)",
          },
        },
        required: ["query"],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const query = args.query as string;
    const maxResults = Math.min(
      Math.max((args.max_results as number) ?? 5, 1),
      10,
    );

    try {
      // Search for message IDs
      const list = await googleFetch<{
        messages?: Array<{ id: string }>;
        resultSizeEstimate?: number;
      }>(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
      );

      if (!list.messages || list.messages.length === 0) {
        return JSON.stringify({ results: [], total: 0, query });
      }

      // Fetch each message's metadata
      const emails = await Promise.all(
        list.messages.map(async (m) => {
          const msg = await googleFetch<{
            id: string;
            snippet: string;
            payload: {
              headers: Array<{ name: string; value: string }>;
            };
            internalDate: string;
          }>(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
          );

          const getHeader = (name: string) =>
            msg.payload.headers.find(
              (h) => h.name.toLowerCase() === name.toLowerCase(),
            )?.value ?? "";

          return {
            id: msg.id,
            from: getHeader("From"),
            subject: getHeader("Subject"),
            date: getHeader("Date"),
            snippet: msg.snippet,
          };
        }),
      );

      return JSON.stringify({
        results: emails,
        total: list.resultSizeEstimate ?? emails.length,
        query,
      });
    } catch (err) {
      return JSON.stringify({
        error: `Gmail search failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};
