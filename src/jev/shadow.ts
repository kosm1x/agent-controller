/**
 * Jev shadow consumers — log Jev's answer beside the live decision, change
 * nothing. Plan: docs/planning/jev-consumers-plan-2026-09-21.md.
 *
 * Ships dormant: `JEV_SHADOW_CONSUMERS` (comma list of kb, feedback) arms
 * each consumer, and arming one is the operator's ruling on the text it
 * sends. Every call is deferred with `setImmediate` and never awaited, so no
 * turn waits on the vendor and no failure reaches the caller.
 */

import { getDatabase, writeWithRetry } from "../db/index.js";
import type { JevQuestion } from "../tuning/jev-scope-replay.js";
import { askJev, jevKey, mustNotLeave } from "./client.js";

/**
 * `memory` (consumer 2) is not in this ship — operator ruling A, 2026-09-22,
 * after audit round 4 found the recall query cut upstream of the vendor
 * filter. The table's CHECK keeps the value so it can return additively.
 */
export type ShadowConsumer = "kb" | "feedback";

/** Off the turn's path, so generous; the retest's max was 532 ms. */
const SHADOW_DEADLINE_MS = 5000;
/**
 * What leaves is cut to these sizes — by `ask`, after the filter has read the
 * whole text. A cut is a rewrite: made first, it can remove the word that
 * makes the filter object and keep the value (qa R3). Callers pass text whole.
 */
const MESSAGE_CHARS = 500;
const ITEM_CHARS = 400;

export function shadowArmed(consumer: ShadowConsumer): boolean {
  if (!jevKey()) return false;
  return (process.env.JEV_SHADOW_CONSUMERS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .includes(consumer);
}

export interface ShadowRow {
  consumer: "scope" | ShadowConsumer;
  ref: string | null;
  /** What was judged; `_withheld` / `_failed` mark a request with no answer. */
  item: string;
  noul: number | null;
  latencyMs: number | null;
  incumbent: string | null;
}

/** Never throws: instrumentation must not break the path it watches. */
export function recordJevShadow(rows: readonly ShadowRow[]): void {
  try {
    const insert = getDatabase().prepare(
      `INSERT INTO jev_shadow (consumer, ref, item, noul, latency_ms, incumbent)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    writeWithRetry(() => {
      for (const r of rows)
        insert.run(r.consumer, r.ref, r.item, r.noul, r.latencyMs, r.incumbent);
    });
  } catch (err) {
    console.warn(
      `[jev-shadow] record failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export interface ShadowItem {
  item: string;
  incumbent: string | null;
  instructions: string;
  /** The text Jev judges against the state. Whole: `ask` filters, then cuts. */
  positive: string;
  negative: string;
}

async function ask(
  consumer: ShadowConsumer,
  ref: string | null,
  state: Record<string, string>,
  items: readonly ShadowItem[],
): Promise<void> {
  const row = (
    item: string,
    noul: number | null,
    latencyMs: number | null,
    incumbent: string | null,
  ): ShadowRow => ({ consumer, ref, item, noul, latencyMs, incumbent });

  if (Object.values(state).some(mustNotLeave)) {
    recordJevShadow([row("_withheld", null, null, null)]);
    return;
  }
  // A sensitive (or emptied) item is dropped on its own; the rest goes.
  const sendable = items.filter(
    (i) => i.positive.trim() && !mustNotLeave(i.positive),
  );
  const rows = items
    .filter((i) => !sendable.includes(i))
    .map((i) => row(i.item, null, null, i.incumbent));
  if (sendable.length > 0) {
    const questions: Record<string, JevQuestion> = {};
    sendable.forEach((i, n) => {
      questions[`q${n}`] = {
        type: "noul",
        instructions: i.instructions,
        criteria: {
          true: i.positive.slice(0, ITEM_CHARS),
          false: i.negative,
        },
      };
    });
    const sent = Object.fromEntries(
      Object.entries(state).map(([k, v]) => [k, v.slice(0, MESSAGE_CHARS)]),
    );
    const started = performance.now();
    try {
      const nouls = await askJev(sent, questions, SHADOW_DEADLINE_MS);
      const latency = Math.round(performance.now() - started);
      sendable.forEach((i, n) =>
        rows.push(row(i.item, nouls[`q${n}`], latency, i.incumbent)),
      );
    } catch (err) {
      console.warn(
        `[jev-shadow] ${consumer} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      rows.push(
        row("_failed", null, Math.round(performance.now() - started), null),
      );
    }
  }
  recordJevShadow(rows);
}

export function deferShadow(
  consumer: ShadowConsumer,
  ref: string | null,
  state: Record<string, string>,
  items: () => ShadowItem[],
): void {
  if (!shadowArmed(consumer)) return;
  const warn = (err: unknown) =>
    console.warn(
      `[jev-shadow] ${consumer} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  setImmediate(() => {
    try {
      const built = items();
      if (built.length === 0) return;
      void ask(consumer, ref, state, built).catch(warn);
    } catch (err) {
      warn(err);
    }
  });
}

/**
 * Consumer 3 — the follow-up's feedback label. The regex detector's inputs,
 * cut to `MESSAGE_CHARS`. No positive question: "excelente" is the only eval word.
 */
export function shadowFeedback(
  taskId: string,
  followUp: string,
  previousMessage: string | undefined,
  incumbent: string,
): void {
  deferShadow(
    "feedback",
    taskId,
    {
      follow_up: followUp,
      previous_message: previousMessage ?? "",
    },
    () => [
      {
        item: "correction",
        incumbent,
        instructions:
          "`follow_up` is what the user wrote right after the assistant answered `previous_message`.",
        positive:
          "The user is correcting the assistant or complaining that the previous answer was wrong, incomplete or not what was asked.",
        negative:
          "The user is doing anything else: a new request, a continuation, an acknowledgement, or a neutral remark.",
      },
      {
        item: "restatement",
        incumbent,
        instructions:
          "`follow_up` is what the user wrote right after the assistant answered `previous_message`.",
        positive:
          "The user is asking for the same thing as `previous_message` again, in other words.",
        negative:
          "The follow-up asks for something different, or asks nothing.",
      },
    ],
  );
}
