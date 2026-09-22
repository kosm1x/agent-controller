/**
 * Jev shadow consumer 1 — KB row relevance. Apart from `shadow.ts` so the
 * router and scope paths do not pull the KB modules in with them.
 */

import { getFilesByQualifier } from "../db/jarvis-fs.js";
import {
  packConditionalRows,
  type ConditionalRow,
} from "../messaging/kb-injection.js";
import { deferShadow } from "./shadow.js";

export interface KbShadowRow {
  /** What Jev judges. Written here, reviewed in the diff — never KB text. */
  describes: string;
  /** Registered evidence: the row was needed iff the turn called one of these. */
  evidence: readonly string[];
}

/**
 * The rows consumer 1 scores (plan §1), fixed before the first shadow row
 * exists. KB content is operator- and Jarvis-editable at run time, and no
 * rewrite of it keeps the vendor filter whole (qa R1 + R2: cutting what the
 * filter objects to also cuts the label that made it object). So no KB text
 * leaves: a row is sent as its description here, and a row without an entry
 * (`knowledge/people/*`, anything added later) is not sent at all.
 */
export const KB_SHADOW_ROWS: Readonly<Record<string, KbShadowRow>> = {
  "knowledge/procedures/code-generation-sop.md": {
    describes:
      "Standing procedure for code work: the principles and past lessons to read before planning or writing code in any project.",
    evidence: ["file_write", "file_edit", "git_commit", "jarvis_dev"],
  },
  "directives/x-posting-card.md": {
    describes:
      "Operating card for the X (Twitter) accounts: which configured account is which, and how to carry out any instruction about posting on X.",
    evidence: ["tweet_post"],
  },
  "projects/mexico-necesario-ac/docs/protocolo-publicacion.md": {
    describes:
      "Publication protocol for one organisation's X (Twitter) account: the rules for its daily scheduled tweet and for any ad-hoc request to publish there.",
    evidence: ["tweet_post"],
  },
  "directives/data-doc-authoring.md": {
    describes:
      "How to author a Google Doc, PDF, README or other lasting document that holds a table, a ranking or computed numbers: re-run the query and write from a file.",
    evidence: [
      "gdocs_write",
      "gdocs_replace",
      "gsheets_write",
      "gdrive_create",
    ],
  },
  "directives/northstar_recurring_tasks.md": {
    describes:
      "The difference between recurring tasks in the user's goal tracker and the system's scheduled jobs, and which one a request about recurring work means.",
    evidence: ["northstar_sync", "schedule_task", "list_schedules"],
  },
  "knowledge/domain/intelligence-depot-live-sources.md": {
    describes:
      "Catalogue of live world data sources (geospatial, environmental, conflict, infrastructure) to use when a request needs real-time global data.",
    evidence: ["intel_query", "intel_alert_history"],
  },
  "knowledge/learning/active-plans.md": {
    describes:
      "The user's active learning plans and the protocol for resuming their lessons.",
    evidence: [
      "learner_model_status",
      "learning_plan_advance",
      "learning_plan_create",
      "learning_plan_explain_back",
      "learning_plan_quiz",
      "learning_plan_status",
      "learning_plan_summarize",
    ],
  },
};

/** Consumer 1 — every scoreable conditional row that applies to this scope. */
export function shadowKbRows(
  taskId: string,
  message: string | undefined,
  scopedTools: readonly string[],
): void {
  if (!message) return;
  deferShadow("kb", taskId, { message }, () => {
    const packed = packConditionalRows(
      getFilesByQualifier("conditional"),
      scopedTools,
    );
    const item = (incumbent: string) => (f: (typeof packed.inBudget)[0]) => ({
      item: f.path,
      incumbent,
      instructions:
        "Is the internal directive described in the criteria needed to handle the user's `message` correctly?",
      positive: KB_SHADOW_ROWS[f.path].describes,
      negative: "The message can be handled correctly without this directive.",
    });
    // Own keys only: `in` would also accept a path named `constructor`.
    const scoreable = (f: ConditionalRow) =>
      Object.hasOwn(KB_SHADOW_ROWS, f.path);
    return [
      ...packed.inBudget.filter(scoreable).map(item("budget")),
      ...packed.pointer.filter(scoreable).map(item("pointer")),
    ];
  });
}
