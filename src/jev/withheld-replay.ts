/**
 * Why the live scope path withholds a turn from Jev. `jev_shadow` scope rows
 * carry no text and no task id, so the answer is replayed: each router
 * exchange (`User: …\nJarvis: …`, bank mc-jarvis) is walked in channel order
 * and the same two texts the classifier filters — the message and the whole
 * turn behind it, the previous Jarvis reply (`conversationHistory.slice(-2)`
 * is that reply plus the message itself; the previous USER message reaches
 * the filter only after a poisoned exchange, whose reply the router drops —
 * 0.7 % of turns) — go through `withholdReasons`. Only rule NAMES are
 * counted, never text.
 */

import { withholdReasons } from "./client.js";

export interface Exchange {
  channel: string;
  user: string;
  jarvis: string;
}

export type Part = "message" | "prev_jarvis";
export const PARTS: readonly Part[] = ["message", "prev_jarvis"];

/** The router persists a turn as `User: <text>\nJarvis: <reply>`. */
export function parseExchange(
  content: string,
): { user: string; jarvis: string } | null {
  const m = /^User: ([\s\S]*?)\nJarvis: ([\s\S]*)$/.exec(content);
  return m ? { user: m[1], jarvis: m[2] } : null;
}

export interface WithholdTally {
  turns: number;
  withheld: number;
  /** Turns where that part alone would have withheld. */
  byPart: Record<Part, number>;
  /** Rule → part → turns it fired on. */
  byRule: Record<string, Record<Part, number>>;
  /** Withheld turns whose own message is clean: the context did it. */
  contextOnly: number;
}

const zero = (): Record<Part, number> => ({ message: 0, prev_jarvis: 0 });

export function tallyWithholds(exchanges: readonly Exchange[]): WithholdTally {
  const last = new Map<string, Exchange>();
  const tally: WithholdTally = {
    turns: 0,
    withheld: 0,
    byPart: zero(),
    byRule: {},
    contextOnly: 0,
  };
  for (const ex of exchanges) {
    const prev = last.get(ex.channel);
    last.set(ex.channel, ex);
    const parts: [Part, string][] = [["message", ex.user]];
    if (prev) parts.push(["prev_jarvis", prev.jarvis]);
    tally.turns++;
    const hit = new Set<Part>();
    for (const [part, text] of parts) {
      for (const rule of withholdReasons(text)) {
        hit.add(part);
        (tally.byRule[rule] ??= zero())[part]++;
      }
    }
    if (hit.size === 0) continue;
    tally.withheld++;
    for (const part of hit) tally.byPart[part]++;
    if (!hit.has("message")) tally.contextOnly++;
  }
  return tally;
}
