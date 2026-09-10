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

describe("task_history limit clamp (logic audit F22)", () => {
  it("limit:-1 is not 'unbounded' and limit:0 is not 'no results'", async () => {
    const neg = JSON.parse(await taskHistoryTool.execute({ query: "Chat", limit: -1 }));
    expect(neg.returned).toBeGreaterThanOrEqual(1);
    expect(neg.returned).toBeLessThanOrEqual(10);
    const zero = JSON.parse(await taskHistoryTool.execute({ query: "Chat", limit: 0 }));
    expect(zero.returned).toBeGreaterThanOrEqual(1);
  });
});

describe("task_history search_output (paper plan A.1 — output is the episode log)", () => {
  it("output matching is ON by default: a term that lives only in the output is found and tagged matchedIn:'output' (task 9495)", async () => {
    const res = JSON.parse(await taskHistoryTool.execute({ query: "Oaxaca" }));
    expect(res.results).toHaveLength(1);
    expect(res.results[0]).toMatchObject({ taskId: "t-dent", matchedIn: "output" });
    expect(res.results[0].outputMatch).toContain("Oaxaca de Juárez");
    const plain = JSON.parse(await taskHistoryTool.execute({ query: "clima" }));
    expect(plain.results[0]).toMatchObject({ taskId: "t-other", matchedIn: "title" });
    expect(plain.results[0].outputMatch).toBeUndefined();
    // search_output:false restricts to titles/IDs.
    const titleOnly = JSON.parse(await taskHistoryTool.execute({ query: "Oaxaca", search_output: false }));
    expect(titleOnly.results).toEqual([]);
    expect(titleOnly.message).not.toMatch(/outputs/);
  });

  it("keywords are AND-ed in any order across title and output — the literal-phrase failure of task 9495", async () => {
    // "dentistas" lives in the title, "Oaxaca" only in the output.
    for (const q of ["dentistas Oaxaca", "Oaxaca dentistas", "  oaxaca   DENTISTAS "]) {
      const res = JSON.parse(await taskHistoryTool.execute({ query: q }));
      expect(res.results.map((r: { taskId: string }) => r.taskId)).toEqual(["t-dent"]);
    }
    // Every keyword must match: one from each task → nothing.
    const none = JSON.parse(await taskHistoryTool.execute({ query: "dentistas clima" }));
    expect(none.results).toEqual([]);
    expect(none.message).toMatch(/fewer or broader/);
    const blank = JSON.parse(await taskHistoryTool.execute({ query: "   " }));
    expect(blank.results).toEqual([]);
  });

  it("the question being answered (status running, no output) sorts LAST and never shadows the finding", async () => {
    getDatabase()
      .prepare(
        `INSERT INTO tasks (task_id, title, description, status, agent_type, created_at)
         VALUES ('t-question','Chat: ¿Qué encontraste hoy sobre dentistas en Oaxaca?','d','running','fast', datetime('now','+1 hour'))`,
      )
      .run();
    const res = JSON.parse(await taskHistoryTool.execute({ query: "dentistas Oaxaca", limit: 3 }));
    expect(res.results.map((r: { taskId: string }) => r.taskId)).toEqual(["t-dent", "t-question"]);
    expect(res.results[0].matchedIn).toBe("output");
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

  it("outputMatch quotes the keyword the title did NOT carry (audit W1)", async () => {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO tasks (task_id, title, description, status, agent_type) VALUES ('t-w1','Chat: densidad de dentistas','d','completed','fast')`,
    ).run();
    const text = "Top 10 dentistas por municipio. " + "x".repeat(300) + " | 1 | Oaxaca de Juárez | 23.10 |";
    db.prepare(
      `INSERT INTO runs (run_id, task_id, agent_type, input, output, status) VALUES ('run-w1','t-w1','fast','{}',?, 'completed')`,
    ).run(JSON.stringify({ text }));
    const res = JSON.parse(await taskHistoryTool.execute({ query: "dentistas Oaxaca", limit: 10 }));
    const hit = res.results.find((r: { taskId: string }) => r.taskId === "t-w1");
    expect(hit.matchedIn).toBe("output");
    expect(hit.outputMatch).toContain("Oaxaca de Juárez");
  });

  it("keywords are literal: '_' and '%' are not LIKE wildcards; matchedIn agrees with the SQL filter (audit W2)", async () => {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO tasks (task_id, title, description, status, agent_type) VALUES ('t-space','Auto-skill: file read + shell exec','d','completed','fast')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (task_id, title, description, status, agent_type) VALUES ('t-under','Chat: usa shell_exec para listar','d','completed','fast')`,
    ).run();
    // Title-only so the seed runs' toolCalls:["shell_exec"] JSON does not join in.
    const res = JSON.parse(await taskHistoryTool.execute({ query: "shell_exec", search_output: false, limit: 10 }));
    expect(res.results.map((r: { taskId: string }) => r.taskId)).toEqual(["t-under"]);
    expect(res.results[0].matchedIn).toBe("title");
    // With output matching, the JSON envelope hit is labeled honestly as output.
    const withOut = JSON.parse(await taskHistoryTool.execute({ query: "shell_exec", limit: 10 }));
    expect(withOut.results.find((r: { taskId: string }) => r.taskId === "t-dent").matchedIn).toBe("output");
    expect(withOut.results.find((r: { taskId: string }) => r.taskId === "t-space")).toBeUndefined();
    const pct = JSON.parse(await taskHistoryTool.execute({ query: "100%", limit: 10 }));
    expect(pct.results).toEqual([]);
  });

  it("a task_id fragment hit is labeled matchedIn:'title' (title or ID) — audit W3", async () => {
    const res = JSON.parse(await taskHistoryTool.execute({ query: "t-oth" }));
    expect(res.results[0]).toMatchObject({ taskId: "t-other", matchedIn: "title" });
  });

  it("total_matched counts before the LIMIT; returned is the page size (audit W4)", async () => {
    const res = JSON.parse(await taskHistoryTool.execute({ query: "Chat", limit: 1 }));
    expect(res.returned).toBe(1);
    expect(res.total_matched).toBeGreaterThanOrEqual(2);
  });

  it("three keywords bind and AND correctly; scheduled_only composes with them", async () => {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO tasks (task_id, title, description, status, agent_type) VALUES ('t-sched','[Scheduled] Reporte diario dentistas','d','completed','fast')`,
    ).run();
    const three = JSON.parse(await taskHistoryTool.execute({ query: "densidad dentistas Oaxaca", limit: 10 }));
    expect(three.results.map((r: { taskId: string }) => r.taskId)).toEqual(["t-dent"]);
    const sched = JSON.parse(await taskHistoryTool.execute({ query: "dentistas", scheduled_only: true, limit: 10 }));
    expect(sched.results.map((r: { taskId: string }) => r.taskId)).toEqual(["t-sched"]);
  });

  it("a keyword found only in an EARLIER run still matches; the pinned run is the matching one (audit W6)", async () => {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO tasks (task_id, title, description, status, agent_type) VALUES ('t-runs','Chat: intento','d','completed','fast')`,
    ).run();
    db.prepare(
      `INSERT INTO runs (run_id, task_id, agent_type, input, output, status, created_at) VALUES ('run-a','t-runs','fast','{}',?, 'completed','2026-09-01 10:00:00')`,
    ).run(JSON.stringify({ text: "Monterrey 42 farmacias" }));
    db.prepare(
      `INSERT INTO runs (run_id, task_id, agent_type, input, output, status, created_at) VALUES ('run-b','t-runs','fast','{}',?, 'completed','2026-09-02 10:00:00')`,
    ).run(JSON.stringify({ text: "timeout" }));
    const res = JSON.parse(await taskHistoryTool.execute({ query: "Monterrey farmacias", limit: 10 }));
    expect(res.results.map((r: { taskId: string }) => r.taskId)).toEqual(["t-runs"]);
    expect(res.results[0].outputMatch).toContain("Monterrey 42 farmacias");
  });

  it("matchSnippet: case-insensitive, whitespace-collapsed, bounded window", () => {
    const text = "a".repeat(300) + "\nNeedle\n" + "b".repeat(300);
    const snip = matchSnippet(text, "needle")!;
    expect(snip.startsWith("…")).toBe(true);
    expect(snip.endsWith("…")).toBe(true);
    expect(snip).toContain(" Needle ");
    expect(snip.length).toBeLessThan(220);
    expect(matchSnippet("nothing here", "needle")).toBeUndefined();
    // Array form: the earliest-positioned term anchors the window.
    expect(matchSnippet("alpha ... beta", ["beta", "alpha"])).toBe("alpha ... beta");
    expect(matchSnippet("alpha ... beta", ["zzz", "beta"])).toBe("alpha ... beta");
    expect(matchSnippet("alpha", ["zzz"])).toBeUndefined();
  });
});
