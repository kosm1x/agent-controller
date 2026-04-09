/**
 * Markdown dialect converter for messaging channels.
 *
 * Converts standard markdown (from LLM output) to WhatsApp
 * and Telegram-specific formatting, with message splitting for limits.
 */

const TG_MAX_LENGTH = 4096;

/**
 * Convert standard markdown to WhatsApp formatting.
 * - `**bold**` → `*bold*`
 * - `## Header` → `*Header*\n`
 * - Keeps bullet points as-is
 */
export function formatForWhatsApp(text: string): string {
  if (!text) return "";

  let result = text;

  // Strip code fences (```language ... ```) — WhatsApp can't render them
  result = result.replace(/```[\w]*\n?([\s\S]*?)```/g, "$1");

  // Headers: ## Header → *Header*
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // Bold: **text** → *text*
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");

  // Italic: __text__ → _text_ (WhatsApp italic)
  result = result.replace(/__(.+?)__/g, "_$1_");

  // Inline code: `text` → ```text``` (WhatsApp monospace)
  result = result.replace(/`([^`]+)`/g, "```$1```");

  // Strikethrough: ~~text~~ → ~text~ (WhatsApp strikethrough)
  result = result.replace(/~~(.+?)~~/g, "~$1~");

  // Strip HTML tags that may leak from mixed formatting
  result = result.replace(/<\/?[a-z][^>]*>/gi, "");

  return result;
}

/**
 * Convert standard markdown to Telegram HTML formatting.
 * Returns array of strings (split at 4096 char limit).
 *
 * Uses HTML parse mode instead of MarkdownV2 to avoid escaping nightmares.
 * HTML only needs &, <, > escaped — no backslashes for . - ! ( ) etc.
 */
export function formatForTelegram(text: string): string[] {
  if (!text) return [""];

  // Strip spurious backslash escapes from LLM output (Qwen/GLM artifact)
  let result = text.replace(/\\([_*\[\]()~>#+\-=|{}.!`])/g, "$1");

  // Escape HTML entities first (before adding our own tags)
  result = result.replace(/&/g, "&amp;");
  result = result.replace(/</g, "&lt;");
  result = result.replace(/>/g, "&gt;");

  // Headers: ## Header → <b>Header</b>
  // Strip any **bold** markers inside the header to avoid double-bolding
  result = result.replace(/^#{1,6}\s+(.+)$/gm, (_match, content) => {
    const clean = content.replace(/\*\*(.+?)\*\*/g, "$1");
    return `<b>${clean}</b>`;
  });

  // Bold: **text** → <b>text</b>
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // Italic: *text* (single asterisk, not inside bold tags)
  // Only match single * that aren't part of <b> tags or bullet points
  result = result.replace(/(?<![<\/b])\*(?!\*|  )(.+?)\*(?!\*)/g, "<i>$1</i>");

  // Inline code: `code` → <code>code</code>
  result = result.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Strikethrough: ~~text~~ → <s>text</s>
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

  return splitMessage(result, TG_MAX_LENGTH);
}

/**
 * Split a message at paragraph boundaries, falling back to sentence
 * boundaries if a single paragraph exceeds the limit.
 */
export function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n/);
  let current = "";

  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;

    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }

    // Push what we have so far
    if (current) {
      chunks.push(current);
      current = "";
    }

    // If single paragraph exceeds limit, split at sentence boundaries
    if (para.length > maxLength) {
      const sentences = para.split(/(?<=[.!?])\s+/);
      for (const sentence of sentences) {
        const sentCandidate = current ? `${current} ${sentence}` : sentence;
        if (sentCandidate.length <= maxLength) {
          current = sentCandidate;
        } else {
          if (current) chunks.push(current);
          // Hard split if single sentence exceeds limit
          if (sentence.length > maxLength) {
            for (let i = 0; i < sentence.length; i += maxLength) {
              chunks.push(sentence.slice(i, i + maxLength));
            }
            current = "";
          } else {
            current = sentence;
          }
        }
      }
    } else {
      current = para;
    }
  }

  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [text];
}
