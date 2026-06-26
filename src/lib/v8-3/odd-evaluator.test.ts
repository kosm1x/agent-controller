import { describe, expect, it } from "vitest";
import type { ODDPredicate } from "./types.js";
import { evaluateODD, resolveField } from "./odd-evaluator.js";

describe("resolveField", () => {
  it("resolves dotted paths", () => {
    expect(resolveField({ task: { priority: "low" } }, "task.priority")).toBe(
      "low",
    );
  });
  it("returns undefined for a missing segment", () => {
    expect(resolveField({ task: {} }, "task.priority")).toBeUndefined();
    expect(resolveField({}, "a.b.c")).toBeUndefined();
  });
});

describe("evaluateODD", () => {
  it("eq / neq", () => {
    expect(evaluateODD({ op: "eq", field: "x", value: 1 }, { x: 1 })).toBe(
      true,
    );
    expect(evaluateODD({ op: "eq", field: "x", value: 1 }, { x: 2 })).toBe(
      false,
    );
    expect(evaluateODD({ op: "neq", field: "x", value: 1 }, { x: 2 })).toBe(
      true,
    );
  });

  it("numeric comparisons", () => {
    expect(evaluateODD({ op: "lte", field: "n", value: 14 }, { n: 14 })).toBe(
      true,
    );
    expect(evaluateODD({ op: "lt", field: "n", value: 14 }, { n: 14 })).toBe(
      false,
    );
    expect(evaluateODD({ op: "gte", field: "n", value: 3 }, { n: 5 })).toBe(
      true,
    );
    expect(evaluateODD({ op: "gt", field: "n", value: 3 }, { n: 2 })).toBe(
      false,
    );
  });

  it("non-numeric / missing field fails a numeric comparison (fail-safe)", () => {
    expect(evaluateODD({ op: "lt", field: "n", value: 14 }, { n: "x" })).toBe(
      false,
    );
    expect(evaluateODD({ op: "lt", field: "n", value: 14 }, {})).toBe(false);
  });

  it("in", () => {
    expect(
      evaluateODD({ op: "in", field: "s", values: ["a", "b"] }, { s: "b" }),
    ).toBe(true);
    expect(
      evaluateODD({ op: "in", field: "s", values: ["a", "b"] }, { s: "c" }),
    ).toBe(false);
  });

  it("and / or / not", () => {
    const both: ODDPredicate = {
      op: "and",
      clauses: [
        { op: "eq", field: "a", value: 1 },
        { op: "eq", field: "b", value: 2 },
      ],
    };
    expect(evaluateODD(both, { a: 1, b: 2 })).toBe(true);
    expect(evaluateODD(both, { a: 1, b: 3 })).toBe(false);
    expect(
      evaluateODD(
        {
          op: "or",
          clauses: [
            { op: "eq", field: "a", value: 1 },
            { op: "eq", field: "a", value: 2 },
          ],
        },
        { a: 2 },
      ),
    ).toBe(true);
    expect(
      evaluateODD(
        { op: "not", clause: { op: "eq", field: "a", value: 1 } },
        {
          a: 2,
        },
      ),
    ).toBe(true);
  });

  it("evaluates the task_edit compound predicate in and out of ODD", () => {
    const taskEdit: ODDPredicate = {
      op: "and",
      clauses: [
        { op: "neq", field: "task.priority", value: "urgent" },
        { op: "neq", field: "task.assigned_to", value: "operator" },
        { op: "in", field: "task.status", values: ["pending", "blocked"] },
        {
          op: "in",
          field: "edit_kind",
          values: ["status_update", "due_date_extension", "tag_add"],
        },
        { op: "lte", field: "days_extended", value: 14 },
      ],
    };
    const inCtx = {
      task: { priority: "medium", assigned_to: "jarvis", status: "pending" },
      edit_kind: "tag_add",
      days_extended: 3,
    };
    expect(evaluateODD(taskEdit, inCtx)).toBe(true);
    expect(
      evaluateODD(taskEdit, {
        ...inCtx,
        task: { ...inCtx.task, priority: "urgent" },
      }),
    ).toBe(false);
    expect(evaluateODD(taskEdit, { ...inCtx, days_extended: 30 })).toBe(false);
    // middle clause false: assigned_to = operator
    expect(
      evaluateODD(taskEdit, {
        ...inCtx,
        task: { ...inCtx.task, assigned_to: "operator" },
      }),
    ).toBe(false);
    // middle clause false: status not in the allowed set
    expect(
      evaluateODD(taskEdit, {
        ...inCtx,
        task: { ...inCtx.task, status: "completed" },
      }),
    ).toBe(false);
  });

  it("time_window honors the injected clock + tz", () => {
    const win: ODDPredicate = {
      op: "time_window",
      start_hour: 6,
      end_hour: 22,
      tz: "America/Mexico_City",
    };
    // 14:00 UTC = 08:00 MX (UTC-6) → inside [6,22)
    expect(evaluateODD(win, {}, new Date("2026-06-26T14:00:00Z"))).toBe(true);
    // 05:00 UTC = 23:00 MX (prev day) → outside
    expect(evaluateODD(win, {}, new Date("2026-06-26T05:00:00Z"))).toBe(false);
  });

  it("time_window wrapping window (22→6) includes overnight hours", () => {
    const overnight: ODDPredicate = {
      op: "time_window",
      start_hour: 22,
      end_hour: 6,
      tz: "America/Mexico_City",
    };
    // 05:00 UTC = 23:00 MX → inside (≥22)
    expect(evaluateODD(overnight, {}, new Date("2026-06-26T05:00:00Z"))).toBe(
      true,
    );
    // 13:00 UTC = 07:00 MX → outside (not ≥22, not <6)
    expect(evaluateODD(overnight, {}, new Date("2026-06-26T13:00:00Z"))).toBe(
      false,
    );
    // boundary 22:00 MX (04:00 UTC) → inside
    expect(evaluateODD(overnight, {}, new Date("2026-06-26T04:00:00Z"))).toBe(
      true,
    );
    // boundary 06:00 MX (12:00 UTC) → outside (end exclusive)
    expect(evaluateODD(overnight, {}, new Date("2026-06-26T12:00:00Z"))).toBe(
      false,
    );
  });
});
