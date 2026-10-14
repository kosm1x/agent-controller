/**
 * Prompt dump (debugging aid, queue item 3v context-bleed): when
 * PROMPT_DUMP_DIR is set, the fast runner writes each task's assembled
 * message array to one file. It is the array BEFORE the provider reshapes
 * it: the claude-sdk path joins the cacheable system messages into one
 * system prompt and moves `cacheable:false` text into the user prompt.
 * Content is scrubbed (stored secrets, then credential shapes) first; if
 * the scrub throws (secret index cold or failing — it fails closed),
 * nothing is written. The dir must be absolute and outside the KB root
 * (the hourly reindex would import every dump as a KB row).
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "path";
import type { ChatMessage } from "../inference/adapter.js";
import { scrubSecrets } from "../lib/secret-refs.js";
import { redactCredentials } from "../api/mcp-server/redact.js";
import { getJarvisKbRoot } from "../db/jarvis-fs.js";
import { errMsg } from "../lib/err-msg.js";

const MAX_DUMPS = 50;
/** Only files this module wrote; retention never touches anything else. */
const DUMP_NAME = /^\d{8}T\d{9}-[^/]+\.md$/;

/** realpath of an absolute path, or of its nearest existing ancestor + rest. */
function realPath(p: string): string {
  const rest: string[] = [];
  let cur = p;
  while (!existsSync(cur)) {
    rest.unshift(basename(cur));
    cur = dirname(cur);
  }
  return join(realpathSync(cur), ...rest);
}

/** Text of a message; image blocks become `[image_url]` (no pixels on disk). */
function contentText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  return content
    .map((b) => (typeof b.text === "string" ? b.text : `[${b.type}]`))
    .join("\n");
}

export function dumpPrompt(
  dir: string,
  taskId: string,
  messages: ReadonlyArray<Pick<ChatMessage, "role" | "content" | "cacheable">>,
): void {
  try {
    if (!isAbsolute(dir)) throw new Error("PROMPT_DUMP_DIR must be absolute");
    const real = realPath(resolve(dir));
    const kb = realPath(resolve(getJarvisKbRoot()));
    if (real === kb || real.startsWith(kb + sep)) {
      throw new Error("PROMPT_DUMP_DIR is inside the KB root");
    }
    const blocks = messages.map((m, i) => {
      const text = redactCredentials(scrubSecrets(contentText(m.content)));
      const cacheable = m.cacheable === undefined ? "unset" : m.cacheable;
      return {
        text,
        header: `## [${i}] role=${m.role} cacheable=${cacheable} chars=${text.length}`,
      };
    });
    const total = blocks.reduce((n, b) => n + b.text.length, 0);
    const now = new Date();
    const out = [
      `# task ${taskId} ${now.toISOString()} messages=${blocks.length} chars=${total}`,
      ...blocks.map((b) => `${b.header}\n${b.text}`),
    ].join("\n\n");

    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700); // mkdir's mode does not apply to an existing dir
    // Timestamp first so lexical order = chronological (retention below).
    const ts = now.toISOString().replace(/[-:.Z]/g, "");
    writeFileSync(join(dir, `${ts}-${taskId}.md`), out, { mode: 0o600 });

    const files = readdirSync(dir).filter((f) => DUMP_NAME.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - MAX_DUMPS))) {
      unlinkSync(join(dir, f));
    }
  } catch (err) {
    console.warn(`[prompt-dump] skipped: ${errMsg(err)}`);
  }
}
