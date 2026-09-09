import { describe, it, expect } from "vitest";
import { computeKbHealth, normalizeName, KB_SIZE_WARN_BYTES } from "./kb-health.js";

describe("kb-health (paper plan B.3 — report only)", () => {
  it("normalizeName folds case, _ vs -, extension and copy markers; keeps version/ordinal/date series", () => {
    expect(normalizeName("d/northstar_recurring_tasks.md")).toBe("northstar-recurring-tasks");
    expect(normalizeName("d/Northstar-Recurring-Tasks.MD")).toBe("northstar-recurring-tasks");
    expect(normalizeName("d/plan (1).md")).toBe("plan");
    expect(normalizeName("d/plan-copy.md")).toBe("plan");
    expect(normalizeName("d/plan-old-copy.md")).toBe("plan");
    // A `-old` copy of a versioned file collides with THAT version (audit S1).
    expect(normalizeName("d/plan-v2-old.md")).toBe("plan-v2");
    // Series are distinct by design (audit W2/S2 + the 22,901-pair Jaccard class).
    expect(normalizeName("d/plan-v2.md")).toBe("plan-v2");
    expect(normalizeName("d/sprint-1.md")).not.toBe(normalizeName("d/sprint-2.md"));
    expect(normalizeName("logs/day-logs/2026-04-03.md")).not.toBe(
      normalizeName("logs/day-logs/2026-04-04.md"),
    );
  });

  it("P1 flags same-folder basename collisions, not cross-folder ones or date series", () => {
    const r = computeKbHealth([
      { path: "k/denue-patterns.md", title: "DENUE patterns", size: 10 },
      { path: "k/denue_patterns.md", title: "DENUE patterns", size: 10 },
      { path: "k/denue-patterns-v2.md", title: "DENUE patterns", size: 10 },
      { path: "other/denue-patterns.md", title: "DENUE patterns", size: 10 },
      { path: "logs/2026-04-03.md", title: "Day log", size: 10 },
      { path: "logs/2026-04-04.md", title: "Day log", size: 10 },
    ]);
    expect(r.nearDuplicates).toEqual([
      { a: "k/denue-patterns.md", b: "k/denue_patterns.md", key: "denue-patterns" },
    ]);
  });

  it("P5 flags single-file folders without subfolders; root excluded", () => {
    const r = computeKbHealth([
      { path: "README.md", title: "root", size: 1 },
      { path: "lonely/one.md", title: "one", size: 1 },
      { path: "parent/index.md", title: "idx", size: 1 },
      { path: "parent/child/a.md", title: "a", size: 1 },
      { path: "parent/child/b.md", title: "b", size: 1 },
    ]);
    expect(r.singleChildFolders).toEqual(["lonely"]);
  });

  it("size warning trips above 15 MB", () => {
    const big = computeKbHealth([{ path: "a/b.md", title: "b", size: KB_SIZE_WARN_BYTES + 1 }]);
    expect(big.sizeWarning).toBe(true);
    expect(big.files).toBe(1);
    expect(computeKbHealth([]).sizeWarning).toBe(false);
  });
});
