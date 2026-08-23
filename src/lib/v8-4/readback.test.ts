/**
 * Usability Phase 2 — read-back gates: declared by write tools, run by the
 * harness at completion, enforced for write classes even under `shadow`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import { declareGates, listGates } from "./gates.js";
import { evaluateLedger } from "./gate-check.js";
import { applyCompletionLedger } from "./consumer.js";
import type { RunnerOutput } from "../../runners/types.js";
import {
  _resetReadbacks,
  declareReadbackGate,
  formatNoQuedo,
  formatVerificado,
  isReadbackRow,
  isWithdrawnReadback,
  parseReadback,
  readbackGateId,
  registerReadback,
  runReadback,
  sha8,
  withdrawReadbackGate,
} from "./readback.js";

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  initDatabase(":memory:");
  _resetReadbacks();
  saved.mode = process.env.TASK_GATES_MODE;
  delete process.env.TASK_GATES_MODE;
});
afterEach(() => {
  closeDatabase();
  _resetReadbacks();
  if (saved.mode === undefined) delete process.env.TASK_GATES_MODE;
  else process.env.TASK_GATES_MODE = saved.mode;
});

const okResult = (text: string): RunnerOutput => ({
  success: true,
  status: "DONE",
  output: { text },
  durationMs: 1,
});

describe("declareReadbackGate", () => {
  it("stores a harness-owned manual row keyed by ARTIFACT with the readback payload", () => {
    registerReadback("jarvis_file_write", async () => ({ ok: true, evidence: "x" }));
    expect(declareReadbackGate("t1", "jarvis_file_write", "kb:a.md", "KB a.md escrito", { path: "a.md", sha8: "abc" })).toBe(true);
    expect(declareReadbackGate("t1", "jarvis_file_write", "kb:b.md", "KB b.md escrito", { path: "b.md", sha8: "def" })).toBe(true);
    const rows = listGates("t1");
    expect(rows.map((r) => r.gate_id).sort()).toEqual([readbackGateId("kb:a.md"), readbackGateId("kb:b.md")].sort());
    const a = rows.find((r) => r.gate_id === readbackGateId("kb:a.md"))!;
    expect(a.check_kind).toBe("manual");
    expect(a.source).toBe("harness");
    expect(isReadbackRow(a)).toBe(true);
    expect(parseReadback(a)).toEqual({ tool: "jarvis_file_write", data: { path: "a.md", sha8: "abc" } });
  });

  it("R1 audit C1: a second write to the SAME artifact supersedes the first gate — one proof, the final state", () => {
    registerReadback("jarvis_file_write", async () => ({ ok: true, evidence: "x" }));
    registerReadback("jarvis_file_update", async () => ({ ok: true, evidence: "x" }));
    declareReadbackGate("t1", "jarvis_file_write", "kb:x.md", "KB x.md escrito", { path: "x.md", sha8: "first" });
    // simulate an evaluation having run on the first gate
    getDatabase().prepare("UPDATE task_gates SET state='failed', evidence='old' WHERE task_id='t1'").run();
    declareReadbackGate("t1", "jarvis_file_update", "kb:x.md", "KB x.md actualizado", { path: "x.md", must_contain: "sección 2" });
    const rows = listGates("t1");
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("pending");
    expect(rows[0].evidence).toBeNull();
    expect(rows[0].criterion).toBe("KB x.md actualizado");
    expect(parseReadback(rows[0])).toEqual({ tool: "jarvis_file_update", data: { path: "x.md", must_contain: "sección 2" } });
  });

  it("never re-points a row the harness did not author, even with the same id", () => {
    registerReadback("jarvis_file_write", async () => ({ ok: true, evidence: "x" }));
    const id = readbackGateId("kb:a.md");
    // The RB- namespace is reserved at the declare door (R2 audit W5), so a
    // non-harness row with this id can only exist by direct DB write — seed it.
    getDatabase()
      .prepare(`INSERT INTO task_gates (task_id, gate_id, criterion, check_kind, check_cmd, source) VALUES ('t1', ?, 'operator gate', 'shell', 'true', 'submission')`)
      .run(id);
    expect(declareReadbackGate("t1", "jarvis_file_write", "kb:a.md", "KB", { path: "a.md" })).toBe(false);
    expect(listGates("t1")[0]).toMatchObject({ source: "submission", criterion: "operator gate" });
  });

  it("R1 audit C1: a same-task delete withdraws the gate (harness-abandoned, rendered silently)", () => {
    registerReadback("schedule_task", async () => ({ ok: true, evidence: "x" }));
    declareReadbackGate("t1", "schedule_task", "schedule:abc", "Schedule creado", { schedule_id: "abc" });
    expect(withdrawReadbackGate("t1", "schedule_task", "schedule:abc", "deleted in the same task")).toBe(true);
    const row = listGates("t1")[0];
    expect(row.state).toBe("abandoned");
    expect(isWithdrawnReadback(row)).toBe(true);
    expect(formatNoQuedo([row])).toBe("");
    expect(formatVerificado([row])).toBe("");
    expect(withdrawReadbackGate("t1", "schedule_task", "schedule:nope", "x")).toBe(false);
  });

  it("is a no-op without a task id or without a verifier for the tool", () => {
    expect(declareReadbackGate(null, "jarvis_file_write", "kb:c", "c", {})).toBe(false);
    expect(declareReadbackGate("t1", "tool_without_verifier", "kb:c", "c", {})).toBe(false);
    expect(listGates("t1")).toHaveLength(0);
  });

  it("R1 audit W1: a readback payload from a NON-harness source keeps NO check text", () => {
    declareGates("t2", [{ criterion: "c", kind: "manual", check: 'readback:{"tool":"gsheets_write","data":{}}' }], "submission");
    expect(listGates("t2")[0].check_cmd).toBeNull();
    declareGates("t3", [{ criterion: "c", kind: "manual", check: "rm -rf /" }], "submission");
    expect(listGates("t3")[0].check_cmd).toBeNull();
  });
});

describe("runReadback", () => {
  it("dispatches to the registered verifier and caps evidence at 400 chars", async () => {
    registerReadback("gsheets_write", async (d) => ({ ok: true, evidence: "x".repeat(1000) + String(d.range) }));
    declareReadbackGate("t1", "gsheets_write", "sheet:s|Hoja", "Sheet", { range: "A1" });
    const v = await runReadback(listGates("t1")[0]);
    expect(v.ok).toBe(true);
    expect(v.evidence.length).toBe(400);
  });

  it("R1 audit W4: an unknown verifier, a throw and a timeout all FAIL with a phone-ready Spanish reason — never raw API text", async () => {
    registerReadback("slow", () => new Promise(() => {}));
    registerReadback("boom", async () => { throw new Error('Google API 403: {"error":{"code":403,"message":"The caller does not have permission"}}'); });
    declareReadbackGate("t1", "slow", "a:1", "c", {});
    declareReadbackGate("t1", "boom", "a:2", "c", {});
    const rows = listGates("t1");
    const slow = rows.find((r) => parseReadback(r)?.tool === "slow")!;
    const boom = rows.find((r) => parseReadback(r)?.tool === "boom")!;
    expect((await runReadback(slow, 20)).evidence).toContain("sin respuesta");
    const b = await runReadback(boom);
    expect(b.ok).toBe(false);
    expect(b.evidence).toBe("no pude releerlo (permiso denegado HTTP 403)");
    expect(b.evidence).not.toContain("Google API");
    expect(await runReadback({ check_cmd: 'readback:{"tool":"gone","data":{}}' })).toMatchObject({ ok: false });
    expect(await runReadback({ check_cmd: "readback:not-json" })).toMatchObject({ ok: false });
  });
});

describe("evaluateLedger runs read-back rows", () => {
  it("met with evidence on ok, failed with evidence on mismatch", async () => {
    registerReadback("jarvis_file_write", async (d) =>
      d.path === "ok.md" ? { ok: true, evidence: "KB ok.md (sha 1234)" } : { ok: false, evidence: "KB bad.md: no existe" },
    );
    declareReadbackGate("t1", "jarvis_file_write", "kb:ok.md", "KB ok.md escrito", { path: "ok.md" });
    declareReadbackGate("t1", "jarvis_file_write", "kb:bad.md", "KB bad.md escrito", { path: "bad.md" });
    const res = await evaluateLedger({ taskId: "t1", outputText: "Listo.", shellGatesRunnable: false });
    expect(res.ran).toBe(2);
    const rows = listGates("t1").sort((a, b) => a.criterion.localeCompare(b.criterion));
    expect(rows.map((r) => [r.state, r.evidence])).toEqual([
      ["failed", "KB bad.md: no existe"],
      ["met", "KB ok.md (sha 1234)"],
    ]);
    expect(formatNoQuedo(rows)).toBe("⚠️ No quedó: KB bad.md escrito — KB bad.md: no existe");
    expect(formatVerificado(rows)).toBe("✔ Verificado: KB ok.md (sha 1234)");
  });
});

describe("evaluateLedger — R1 audit C2: a model ABANDON line cannot void a read-back", () => {
  it("ABANDON: RB-… in the report is ignored; the verifier still runs and fails the gate", async () => {
    registerReadback("jarvis_file_write", async () => ({ ok: false, evidence: "KB ghost.md: no existe tras la escritura" }));
    declareReadbackGate("t1", "jarvis_file_write", "kb:ghost.md", "KB ghost.md escrito", { path: "ghost.md" });
    const id = readbackGateId("kb:ghost.md");
    await evaluateLedger({ taskId: "t1", outputText: `Listo, ya actualicé el KB.\nABANDON: ${id} no pude escribirlo`, shellGatesRunnable: false });
    const row = listGates("t1")[0];
    expect(row.state).toBe("failed");
    expect(row.abandon_reason).toBeNull();
  });
});

describe("applyCompletionLedger — write-class enforce under shadow", () => {
  it("a failed read-back demotes completed → completed_with_concerns and appends «No quedó» even in shadow mode", async () => {
    process.env.TASK_GATES_MODE = "shadow";
    registerReadback("gsheets_write", async () => ({ ok: false, evidence: "Sheet A1:C3: col 2 dice «12», escribí «16»" }));
    declareReadbackGate("t1", "gsheets_write", "sheet:s|Hoja", "Sheet A1:C3 contiene las filas escritas", { range: "A1:C3" });
    const out = await applyCompletionLedger({
      taskId: "t1", runId: "r1", agentType: "fast", tags: [], taskDescription: "x",
      result: okResult("Listo. Sheet actualizado con el modelo confirmado."), taskStatus: "completed",
    });
    expect(out.taskStatus).toBe("completed_with_concerns");
    const text = (out.output as { text: string }).text;
    expect(text).toContain("⚠️ No quedó: Sheet A1:C3 contiene las filas escritas — Sheet A1:C3: col 2 dice «12», escribí «16»");
    const trace = getDatabase().prepare("SELECT name, attrs FROM task_trace_events WHERE task_id='t1' AND name='gates.readback'").get() as { attrs: string };
    expect(JSON.parse(trace.attrs)).toMatchObject({ total: 1, failed: 1, demoted: true });
  });

  it("a met read-back keeps the status and appends one «Verificado» line", async () => {
    process.env.TASK_GATES_MODE = "shadow";
    registerReadback("jarvis_file_write", async () => ({ ok: true, evidence: "KB x.md (sha 9f3a)" }));
    declareReadbackGate("t1", "jarvis_file_write", "kb:x.md", "KB x.md escrito", { path: "x.md", sha8: "9f3a" });
    const out = await applyCompletionLedger({
      taskId: "t1", runId: "r1", agentType: "fast", tags: [], taskDescription: "x",
      result: okResult("KB actualizado."), taskStatus: "completed",
    });
    expect(out.taskStatus).toBe("completed");
    expect((out.output as { text: string }).text).toBe("KB actualizado.\n\n✔ Verificado: KB x.md (sha 9f3a)");
  });

  it("R1 audit C3: under `enforce` the Spanish lines still render and no English ledger block mentions the read-back", async () => {
    process.env.TASK_GATES_MODE = "enforce";
    registerReadback("jarvis_file_write", async () => ({ ok: false, evidence: "KB ghost.md: no existe tras la escritura" }));
    declareReadbackGate("t1", "jarvis_file_write", "kb:ghost.md", "KB ghost.md escrito y legible", { path: "ghost.md" });
    const out = await applyCompletionLedger({
      taskId: "t1", runId: "r1", agentType: "fast", tags: [], taskDescription: "x",
      result: okResult("Listo, ya actualicé el KB."), taskStatus: "completed",
    });
    expect(out.taskStatus).toBe("completed_with_concerns");
    const text = (out.output as { text: string }).text;
    expect(text).toContain("⚠️ No quedó: KB ghost.md escrito y legible — KB ghost.md: no existe tras la escritura");
    expect(text).not.toContain("Gates:");
    expect(text).not.toContain("FAILED:");
  });

  it("R2 audit C1: under `enforce`, one failed read-back + one met shell gate → no contradictory headline, JSON populations agree", async () => {
    process.env.TASK_GATES_MODE = "enforce";
    registerReadback("jarvis_file_update", async () => ({ ok: false, evidence: "KB x.md: el texto agregado no aparece" }));
    declareReadbackGate("t1", "jarvis_file_update", "kb:x.md", "KB x.md actualizado y legible", { path: "x.md" });
    declareGates("t1", [{ id: "G1", criterion: "tests green", check: "true" }], "submission");
    const out = await applyCompletionLedger({
      taskId: "t1", runId: "r1", agentType: "fast", tags: [], taskDescription: "x",
      result: okResult("Listo."), taskStatus: "completed",
    });
    const text = (out.output as { text: string }).text;
    expect(out.taskStatus).toBe("completed_with_concerns");
    expect(text).toContain("⚠️ No quedó: KB x.md actualizado y legible");
    // The shell gate's block covers ONLY the non-read-back population…
    expect(text).toContain("Gates: 1/1 met");
    // …and the stored JSON says the same about the same population, with the read-back reported apart.
    const gates = (out.output as { gates: Record<string, unknown> }).gates;
    expect(gates).toMatchObject({ total: 1, met: 1, failed: 0, verdict: "met", readback: { total: 1, failed: 1 } });
  });

  it("R2 audit W6: a read-back the ledger could not run renders as «Sin releer», never silently", async () => {
    process.env.TASK_GATES_MODE = "shadow";
    registerReadback("jarvis_file_write", async () => ({ ok: true, evidence: "unreachable" }));
    declareReadbackGate("t1", "jarvis_file_write", "kb:x.md", "KB x.md escrito", { path: "x.md" });
    // A read-back never run stays `pending`.
    const { formatSinReleer } = await import("./readback.js");
    expect(formatSinReleer(listGates("t1"))).toBe("⏳ Sin releer (no alcancé a verificar): KB x.md escrito");
    // Through the consumer: a shell gate declared FIRST burns the whole
    // ledger budget, so the read-back (evaluated after it) is never run —
    // the line must still reach the deliverable (R3 audit W2).
    getDatabase().prepare("DELETE FROM task_gates WHERE task_id='t1'").run();
    declareGates("t1", [{ id: "G1", criterion: "slow", check: "sleep 0.3" }], "submission");
    declareReadbackGate("t1", "jarvis_file_write", "kb:x.md", "KB x.md escrito", { path: "x.md" });
    process.env.TASK_GATES_LEDGER_BUDGET_MS = "50";
    try {
      const out = await applyCompletionLedger({
        taskId: "t1", runId: "r1", agentType: "fast", tags: [], taskDescription: "x",
        result: okResult("Listo."), taskStatus: "completed",
      });
      const text = (out.output as { text: string }).text;
      expect(text).toContain("⏳ Sin releer (no alcancé a verificar): KB x.md escrito");
      expect(text).not.toContain("✔ Verificado");
    } finally {
      delete process.env.TASK_GATES_LEDGER_BUDGET_MS;
    }
  });

  it("R2 audit W5: a submission/plan gate cannot claim the RB- namespace", () => {
    expect(() => declareGates("t1", [{ id: "RB-deadbeef", criterion: "x", check: "true" }], "submission")).toThrow(/reserved/);
    expect(() => declareGates("t1", [{ id: "RB-deadbeef", criterion: "x", check: "true" }], "plan")).toThrow(/reserved/);
  });

  it("R1 audit W14: a run with an EMPTY deliverable still carries the «No quedó» line", async () => {
    process.env.TASK_GATES_MODE = "shadow";
    registerReadback("jarvis_file_write", async () => ({ ok: false, evidence: "KB ghost.md: no existe tras la escritura" }));
    declareReadbackGate("t1", "jarvis_file_write", "kb:ghost.md", "KB ghost.md escrito", { path: "ghost.md" });
    const out = await applyCompletionLedger({
      taskId: "t1", runId: "r1", agentType: "fast", tags: [], taskDescription: "x",
      result: { success: true, status: "DONE", output: { text: "" }, durationMs: 1 }, taskStatus: "completed",
    });
    expect((out.output as { text: string }).text).toContain("⚠️ No quedó");
  });

  it("mode off: read-backs are not run (nothing appended, status untouched)", async () => {
    process.env.TASK_GATES_MODE = "off";
    registerReadback("jarvis_file_write", async () => ({ ok: false, evidence: "nope" }));
    declareReadbackGate("t1", "jarvis_file_write", "kb:x.md", "KB x.md escrito", { path: "x.md" });
    const out = await applyCompletionLedger({
      taskId: "t1", runId: "r1", agentType: "fast", tags: [], taskDescription: "x",
      result: okResult("KB actualizado."), taskStatus: "completed",
    });
    expect(out.taskStatus).toBe("completed");
    expect((out.output as { text: string }).text).toBe("KB actualizado.");
  });
});

describe("reverifyChildLedger — R3 audit W3", () => {
  it("a failed read-back on a child does not fail the parent's verdict (other gates decide); read-backs are not re-run", async () => {
    process.env.TASK_GATES_MODE = "enforce";
    let calls = 0;
    registerReadback("jarvis_file_write", async () => { calls++; return { ok: false, evidence: "KB x.md: no existe tras la escritura" }; });
    declareReadbackGate("child", "jarvis_file_write", "kb:x.md", "KB x.md escrito", { path: "x.md" });
    declareGates("child", [{ id: "G1", criterion: "ok", check: "true" }], "plan");
    const { reverifyChildLedger } = await import("./consumer.js");
    const v = await reverifyChildLedger("parent", "child", { text: "done" });
    expect(v?.verdict).toBe("met");
    expect(v?.total).toBe(1);
    expect(calls).toBeGreaterThanOrEqual(1);
  });
});

describe("sha8", () => {
  it("is stable and 8 hex chars", () => {
    expect(sha8("hola")).toMatch(/^[0-9a-f]{8}$/);
    expect(sha8("hola")).toBe(sha8("hola"));
    expect(sha8("hola")).not.toBe(sha8("hola "));
  });
});

describe("formatVerificado / formatNoQuedo caps", () => {
  it("shows at most 3 evidences and counts the rest (both lines — R1 audit W5)", () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({
      task_id: "t", gate_id: `R-${i + 1}`, criterion: `c${i}`, check_kind: "manual" as const,
      check_cmd: 'readback:{"tool":"x","data":{}}', expect: null, state: "met" as const,
      evidence: `e${i}`, abandon_reason: null, source: "harness" as const, frozen_at: null, checked_at: null, created_at: "",
    }));
    expect(formatVerificado(rows)).toBe("✔ Verificado: e0 · e1 · e2 · y 4 más");
    const failed = rows.map((r) => ({ ...r, state: "failed" as const }));
    const nq = formatNoQuedo(failed);
    expect(nq.split("\n")).toHaveLength(3);
    expect(nq.endsWith(" · y 4 más")).toBe(true);
  });
});
