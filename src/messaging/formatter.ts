/**
 * Markdown dialect converter for messaging channels.
 *
 * Converts standard markdown (from ritual/task output) to WhatsApp
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

  // Headers: ## Header → *Header*
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // Bold: **text** → *text*
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");

  // Italic: __text__ → _text_ (WhatsApp italic)
  result = result.replace(/__(.+?)__/g, "_$1_");

  return result;
}

/**
 * Convert standard markdown to Telegram MarkdownV2 formatting.
 * Returns array of strings (split at 4096 char limit).
 *
 * - `**bold**` → `*bold*`
 * - `## Header` → `*Header*\n`
 * - Escapes special chars outside format markers
 */
export function formatForTelegram(text: string): string[] {
  if (!text) return [""];

  let result = text;

  // Headers: ## Header → *Header*
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "**$1**");

  // Extract bold markers, escape content, then restore
  // Step 1: Temporarily protect bold markers
  const boldSegments: string[] = [];
  result = result.replace(/\*\*(.+?)\*\*/g, (_match, content) => {
    boldSegments.push(content);
    return `\x00BOLD${boldSegments.length - 1}\x00`;
  });

  // Step 2: Escape special chars for MarkdownV2
  result = escapeTelegramChars(result);

  // Step 3: Restore bold markers with escaped content
  result = result.replace(/\x00BOLD(\d+)\x00/g, (_match, idx) => {
    return `*${escapeTelegramChars(boldSegments[Number(idx)])}*`;
  });

  return splitMessage(result, TG_MAX_LENGTH);
}

/**
 * Escape Telegram MarkdownV2 special characters.
 */
function escapeTelegramChars(text: string): string {
  return text.replace(/([_\[\]()~>#+\-=|{}.!\\])/g, "\\$1");
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
