/**
 * Gmail tools — send, search, and read emails (with attachments).
 */

import type { Tool } from "../types.js";
import { googleFetch } from "../../google/client.js";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// gmail_send
// ---------------------------------------------------------------------------

export const gmailSendTool: Tool = {
  name: "gmail_send",
  requiresConfirmation: true,
  deferred: false,
  definition: {
    type: "function",
    function: {
      name: "gmail_send",
      description: `Send an email from Jarvis's Gmail account.

USE WHEN:
- The user EXPLICITLY asks to send an email ("envía un correo a...", "manda un email")
- You need to share research results or reports BY USER REQUEST

DO NOT USE WHEN:
- The user asks about received emails (use gmail_search)
- The user asks to "verify" or "check" email status (use gmail_search, NEVER send)
- You are doing research (NEVER send emails to researchers/contacts during research tasks)
- The user did not explicitly ask you to send an email

CRITICAL: Sending unsolicited emails is a SERIOUS violation. NEVER send an email
unless the user explicitly requested it in the current message. "Verify the email"
means SEARCH, not SEND.

AFTER SENDING: Report the recipient, subject, and confirmation that the email was sent.`,
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
    let to = args.to as string;
    const subject = args.subject as string;

    // Poka-yoke: LLM consistently mistypes the owner email (eurekamd → eurekadb,
    // eurekand, etc.). Correct any close variant mechanically.
    if (/fede@eureka\w+\.net/i.test(to) && to !== "fede@eurekamd.net") {
      console.log(
        `[gmail_send] Email corrected: "${to}" → "fede@eurekamd.net"`,
      );
      to = "fede@eurekamd.net";
    }
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
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "gmail_search",
      description: `Search emails in Jarvis's Gmail inbox.

USE WHEN:
- The user asks about received emails, recent messages, or to find a specific email
- You need to check if an email was received from someone
- User asks to "verify" email status

CRITICAL: Report ONLY what the search returns. If the result is 0 emails, say "0 results found."
NEVER fabricate, infer, or claim emails exist that weren't in the search results.
If no emails match, the answer is "no emails found" — not a story about what might have been sent.

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

      // Pre-formatted: numbered email list with from, subject, date, snippet.
      if (emails.length === 0) return `📧 "${query}" — 0 results`;
      const lines = [`📧 **"${query}"** — ${emails.length} emails`];
      for (const e of emails) {
        lines.push(
          `\n**${e.subject}**\nDe: ${e.from}\nFecha: ${e.date}\n> ${e.snippet}`,
        );
      }
      return lines.join("\n");
    } catch (err) {
      return JSON.stringify({
        error: `Gmail search failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};

// ---------------------------------------------------------------------------
// gmail_read
// ---------------------------------------------------------------------------

/** Gmail message part (recursive — multipart messages nest parts). */
interface GmailPart {
  partId: string;
  mimeType: string;
  filename: string;
  headers: Array<{ name: string; value: string }>;
  body: { attachmentId?: string; size: number; data?: string };
  parts?: GmailPart[];
}

interface GmailFullMessage {
  id: string;
  threadId: string;
  snippet: string;
  payload: GmailPart;
  internalDate: string;
}

const ATTACHMENT_DIR = "/tmp/gmail-attachments";

/** Recursively extract body text and attachment metadata from message parts. */
function extractParts(
  part: GmailPart,
  bodyParts: Array<{ mimeType: string; content: string }>,
  attachments: Array<{
    partId: string;
    filename: string;
    mimeType: string;
    size: number;
    attachmentId: string;
  }>,
): void {
  if (part.parts) {
    for (const child of part.parts) extractParts(child, bodyParts, attachments);
    return;
  }
  if (part.body.attachmentId && part.filename) {
    attachments.push({
      partId: part.partId,
      filename: part.filename,
      mimeType: part.mimeType,
      size: part.body.size,
      attachmentId: part.body.attachmentId,
    });
  } else if (
    part.body.data &&
    (part.mimeType === "text/plain" || part.mimeType === "text/html")
  ) {
    const decoded = Buffer.from(part.body.data, "base64url").toString("utf-8");
    bodyParts.push({ mimeType: part.mimeType, content: decoded });
  }
}

export const gmailReadTool: Tool = {
  name: "gmail_read",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "gmail_read",
      description: `Read a full email message — body text and attachments.

USE WHEN:
- You have a message ID from gmail_search and need to read the full content
- The user asks to read, open, or view an email
- You need to download or inspect email attachments

WORKFLOW: gmail_search → get message ID → gmail_read with that ID.

Returns the email body (plain text preferred, HTML fallback) and a list of
attachments with filenames and sizes. Use download_attachments=true to save
attachments to /tmp/ and get their local file paths (then use file_read or
pdf_read to inspect them).`,
      parameters: {
        type: "object",
        properties: {
          message_id: {
            type: "string",
            description:
              "Gmail message ID (from gmail_search results). NOT the subject or sender — the actual ID string.",
          },
          download_attachments: {
            type: "boolean",
            description:
              "If true, download all attachments to /tmp/gmail-attachments/ and return file paths. Default: false (returns metadata only).",
          },
        },
        required: ["message_id"],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const messageId = args.message_id as string;
    const downloadAttachments = (args.download_attachments as boolean) ?? false;

    try {
      // Fetch full message (includes body data + attachment metadata)
      const msg = await googleFetch<GmailFullMessage>(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
        { timeout: 20_000 },
      );

      // Extract headers
      const getHeader = (name: string) =>
        msg.payload.headers.find(
          (h) => h.name.toLowerCase() === name.toLowerCase(),
        )?.value ?? "";

      // Extract body parts and attachment metadata
      const bodyParts: Array<{ mimeType: string; content: string }> = [];
      const attachments: Array<{
        partId: string;
        filename: string;
        mimeType: string;
        size: number;
        attachmentId: string;
      }> = [];
      extractParts(msg.payload, bodyParts, attachments);

      // Prefer plain text body, fall back to HTML
      const plainBody = bodyParts.find((p) => p.mimeType === "text/plain");
      const htmlBody = bodyParts.find((p) => p.mimeType === "text/html");
      const body = plainBody?.content ?? htmlBody?.content ?? msg.snippet;
      const bodyType = plainBody
        ? "text/plain"
        : htmlBody
          ? "text/html"
          : "snippet";

      // Download attachments if requested
      const downloadedFiles: Array<{
        filename: string;
        path: string;
        size: number;
        mimeType: string;
      }> = [];
      const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024; // 25MB
      if (downloadAttachments && attachments.length > 0) {
        mkdirSync(ATTACHMENT_DIR, { recursive: true });
        for (const att of attachments) {
          if (att.size > MAX_ATTACHMENT_SIZE) {
            downloadedFiles.push({
              filename: att.filename,
              path: `[skipped: ${(att.size / 1024 / 1024).toFixed(1)}MB exceeds 25MB limit]`,
              size: att.size,
              mimeType: att.mimeType,
            });
            continue;
          }
          const attData = await googleFetch<{ size: number; data: string }>(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${att.attachmentId}`,
            { timeout: 30_000 },
          );
          const buffer = Buffer.from(attData.data, "base64url");
          const safeName = att.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
          const filePath = join(ATTACHMENT_DIR, `${Date.now()}-${safeName}`);
          writeFileSync(filePath, buffer);
          downloadedFiles.push({
            filename: att.filename,
            path: filePath,
            size: buffer.length,
            mimeType: att.mimeType,
          });
        }
      }

      // Cap body at 8K chars to avoid token bloat
      const cappedBody =
        body.length > 8000
          ? body.slice(0, 8000) +
            "\n... [truncated, " +
            body.length +
            " chars total]"
          : body;

      return JSON.stringify({
        id: msg.id,
        threadId: msg.threadId,
        from: getHeader("From"),
        to: getHeader("To"),
        subject: getHeader("Subject"),
        date: getHeader("Date"),
        bodyType,
        body: cappedBody,
        attachments: downloadAttachments
          ? downloadedFiles
          : attachments.map((a) => ({
              filename: a.filename,
              mimeType: a.mimeType,
              size: a.size,
            })),
      });
    } catch (err) {
      return JSON.stringify({
        error: `Failed to read email: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};
