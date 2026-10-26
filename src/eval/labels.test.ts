/**
 * W1 operator-label parse (docs/planning/v9-w1-labels.md): `## Rows*`
 * sections only, header-named columns, backticked task_id, exact label.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeEvalLabels } from "../test-utils/w3-eval-fixture.js";
import { readW1Labels } from "./labels.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "w3-eval-l-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readW1Labels", () => {
  it("reads task_id → label from every ## Rows section; other sections and bad labels are not labels", () => {
    const r = readW1Labels(writeEvalLabels(dir));
    expect(r.found).toBe(true);
    expect([...r.labels]).toEqual([
      ["op-fast-4", "not done"], // the later row wins
      ["op-fast-3", "really done"],
      ["sch-2", "really done"],
      ["ghost-id", "really done"],
      ["child-1", "really done"], // `CHILD-1` lower-cased
    ]);
    expect(r.skipped).toBe(3); // "Really done", unbackticked sch-1, rit-1 "maybe"
    expect(r.labels.has("sch-1")).toBe(false); // Label rules section, wrong case, no backticks
    expect(r.labels.has("op-fast-1")).toBe(false); // Tally section
  });

  it("a missing file is no labels", () => {
    expect(readW1Labels(join(dir, "nope.md"))).toEqual({ path: join(dir, "nope.md"), found: false, labels: new Map(), skipped: 0 });
  });

  it("parses the repo's own labels doc (rows are append-only, never relabelled)", () => {
    const doc = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "planning", "v9-w1-labels.md");
    const r = readW1Labels(doc);
    expect(r.found).toBe(true);
    expect(r.labels.size).toBeGreaterThanOrEqual(37);
    expect(r.skipped).toBe(0);
    for (const v of r.labels.values()) expect(["really done", "not done"]).toContain(v);
  });
});
