/**
 * `checkArtifactProvenance` — its read of the run's own task description, on
 * the real schema (`initDatabase(":memory:")`). The figure appears only in
 * the descriptions of tasks whose ids sort on each side of the run's task, so
 * reading a neighbour's description would admit it. The check is given an
 * empty environment, so the gate's default mode (enforce) applies whatever
 * the process environment holds; no file is written. Fixtures are synthetic.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import { enterRunToolContext } from "../../tools/rule-of-two.js";
import { _resetToolEvidence } from "./numbers.js";
import { checkArtifactProvenance } from "./provenance-gate.js";

const FIGURE_TEXT = "Inventario: 4,321 unidades en bodega.";

function seedTask(id: string, description: string): void {
  getDatabase()
    .prepare(
      `INSERT INTO tasks (task_id, title, description, status, agent_type)
       VALUES (?, 'Scheduled report', ?, 'running', 'fast')`,
    )
    .run(id, description);
}

function check(taskId: string): boolean {
  return enterRunToolContext(taskId, () =>
    checkArtifactProvenance(
      { tool: "jarvis_file_write", artifact: "kb:report", text: FIGURE_TEXT },
      {},
    ),
  ).ok;
}

beforeEach(() => {
  initDatabase(":memory:");
  _resetToolEvidence();
  seedTask("t-c", "Genera el reporte: 4,321 unidades en bodega.");
  seedTask("t-a", "Genera el reporte: 4,321 unidades en bodega.");
});
afterEach(() => {
  closeDatabase();
  _resetToolEvidence();
});

describe("checkArtifactProvenance — the run's own task description", () => {
  it("a run whose task row is absent gets no evidence from its neighbours' descriptions", () => {
    expect(check("t-b")).toBe(false);
  });

  it("a run whose own description lacks the figure is rejected", () => {
    seedTask("t-b", "Genera el reporte de bodega.");
    expect(check("t-b")).toBe(false);
  });

  it("a run whose own description carries the figure is admitted", () => {
    seedTask("t-b", "Genera el reporte: 4,321 unidades en bodega.");
    getDatabase()
      .prepare("UPDATE tasks SET description = 'Genera el reporte de bodega.' WHERE task_id IN ('t-a', 't-c')")
      .run();
    expect(check("t-b")).toBe(true);
  });
});
