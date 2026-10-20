/**
 * W1 operator labels (ruling 2026-10-18 #2): the hand labels in
 * docs/planning/v9-w1-labels.md, read-only. Parse rule: inside every section
 * whose heading starts `## Rows`, the markdown table's header names the
 * columns; a data row counts when its `task_id` cell is one backticked id and
 * its `label` cell is exactly `really done` or `not done`. Every other column
 * (the note above all) is never read; other sections are ignored; a later
 * row for the same task_id wins. Ids are lower-cased (lookups lower-case too).
 */

import { readFileSync } from "node:fs";

export type OperatorLabel = "really done" | "not done";

export interface LabelsRead {
  path: string;
  found: boolean;
  labels: Map<string, OperatorLabel>;
  /** Table rows in a `## Rows` section that were not a valid (task_id, label) pair. */
  skipped: number;
}

export function readW1Labels(path: string): LabelsRead {
  const out: LabelsRead = { path, found: false, labels: new Map(), skipped: 0 };
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return out;
  }
  out.found = true;
  let inRows = false;
  let cols: { id: number; label: number } | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("## ")) {
      inRows = line.startsWith("## Rows");
      cols = null;
      continue;
    }
    if (!inRows || !line.startsWith("|")) continue;
    const cells = line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (cols === null) {
      const id = cells.indexOf("task_id");
      const label = cells.indexOf("label");
      if (id >= 0 && label >= 0) cols = { id, label };
      continue;
    }
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    const id = /^`([0-9A-Za-z][0-9A-Za-z_-]*)`$/.exec(cells[cols.id] ?? "")?.[1];
    const label = cells[cols.label];
    if (id && (label === "really done" || label === "not done")) out.labels.set(id.toLowerCase(), label);
    else out.skipped++;
  }
  return out;
}
