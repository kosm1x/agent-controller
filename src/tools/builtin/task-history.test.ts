import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDatabase, closeDatabase, getDatabase } from "../../db/index.js";
import { taskHistoryTool, matchSnippet } from "./task-history.js";

function seed(taskId: string, title: string, text: string): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO tasks (task_id, title, description, status, agent_type)
     VALUES (?, ?, 'd', 'completed', 'fast')`,
  ).run(taskId, title);
  db.prepare(
    `INSERT INTO runs (run_id, task_id, agent_type, input, output, status)
     VALUES (?, ?, 'fast', '{}', ?, 'completed')`,
  ).run(`run-${taskId}`, taskId, JSON.stringify({ text, toolCalls: ["shell_exec"] }));
}

beforeEach(() => {
  initDatabase(":memory:");
  seed("t-dent", "Chat: densidad de dentistas top 10", "Oaxaca de Juárez: 626 consultorios, 23.10 por 10k habitantes.");
  seed("t-other", "Chat: clima", "Soleado en la ciudad.");
});
afterEach(() => closeDatabase());

describe("task_history search_output (paper plan A.1 — output is the episode log)", () => {
  it("default: matches title/ID only — a term that lives only in the output is NOT found", async () => {
    const res = JSON.parse(await taskHistoryTool.execute({ query: "Oaxaca" }));
    expect(res.results).toEqual([]);
  });

  it("search_output: finds the task by a term in its output and cites taskId + outputMatch", async () => {
    const res = JSON.parse(
      await taskHistoryTool.execute({ query: "Oaxaca", search_output: true }),
    );
    expect(res.results).toHaveLength(1);
    expect(res.results[0].taskId).toBe("t-dent");
    expect(res.results[0].outputMatch).toContain("Oaxaca de Juárez: 626");
  });

  it("search_output with a title hit leaves outputMatch undefined (no fabricated snippet)", async () => {
    const res = JSON.parse(
      await taskHistoryTool.execute({ query: "clima", search_output: true }),
    );
    expect(res.results[0].taskId).toBe("t-other");
    expect(res.results[0].outputMatch).toBeUndefined();
  });

  it("a task with several runs yields ONE row (latest run), not one per run (audit W4)", async () => {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO tasks (task_id, title, description, status, agent_type) VALUES ('t-multi','Chat: rerun','d','completed','fast')`,
    ).run();
    for (let i = 1; i <= 3; i++) {
      db.prepare(
        `INSERT INTO runs (run_id, task_id, agent_type, input, output, status, created_at)
         VALUES (?, 't-multi', 'fast', '{}', ?, 'completed', ?)`,
      ).run(`run-multi-${i}`, JSON.stringify({ text: `attempt ${i} Oaxaca` }), `2026-09-0${i} 10:00:00`);
    }
    const res = JSON.parse(await taskHistoryTool.execute({ query: "Oaxaca", search_output: true, limit: 10 }));
    const multi = res.results.filter((r: { taskId: string }) => r.taskId === "t-multi");
    expect(multi).toHaveLength(1);
    expect(multi[0].outputMatch).toContain("attempt 3");
  });

  it("a finding in an EARLIER run is still found and cited, later failed retries notwithstanding (audit W7)", async () => {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO tasks (task_id, title, description, status, agent_type) VALUES ('t-early','Chat: retry','d','completed','fast')`,
    ).run();
    const outs = ["Encontré 626 consultorios en Oaxaca.", "timeout", "timeout again"];
    outs.forEach((text, i) => {
      db.prepare(
        `INSERT INTO runs (run_id, task_id, agent_type, input, output, status, created_at)
         VALUES (?, 't-early', 'fast', '{}', ?, 'completed', ?)`,
      ).run(`run-early-${i}`, JSON.stringify({ text }), `2026-09-0${i + 1} 10:00:00`);
    });
    const res = JSON.parse(await taskHistoryTool.execute({ query: "Oaxaca", search_output: true, limit: 10 }));
    const hit = res.results.filter((r: { taskId: string }) => r.taskId === "t-early");
    expect(hit).toHaveLength(1);
    expect(hit[0].outputMatch).toContain("626 consultorios");
    // Without search_output the pinned run is still the latest one.
    const plain = JSON.parse(await taskHistoryTool.execute({ query: "retry" }));
    expect(plain.results[0].outputPreview).toBe("timeout again");
  });

  it("output without a .text field never surfaces JSON machinery as outputMatch (audit W5)", async () => {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO tasks (task_id, title, description, status, agent_type) VALUES ('t-json','Chat: json','d','completed','fast')`,
    ).run();
    db.prepare(
      `INSERT INTO runs (run_id, task_id, agent_type, input, output, status) VALUES ('run-json','t-json','fast','{}',?, 'completed')`,
    ).run(JSON.stringify({ toolCalls: ["web_search"], exitReason: "done" }));
    const res = JSON.parse(await taskHistoryTool.execute({ query: "exitReason", search_output: true }));
    expect(res.results[0].taskId).toBe("t-json");
    expect(res.results[0].outputMatch).toBeUndefined();
  });

  it("matchSnippet: case-insensitive, whitespace-collapsed, bounded window", () => {
    const text = "a".repeat(300) + "\nNeedle\n" + "b".repeat(300);
    const snip = matchSnippet(text, "needle")!;
    expect(snip.startsWith("…")).toBe(true);
    expect(snip.endsWith("…")).toBe(true);
    expect(snip).toContain(" Needle ");
    expect(snip.length).toBeLessThan(220);
    expect(matchSnippet("nothing here", "needle")).toBeUndefined();
  });
});
