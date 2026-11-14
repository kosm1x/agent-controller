/**
 * `collectMetrics` database statements on the real schema
 * (`initDatabase(":memory:")`): task counts by status, runner stats over the
 * last 7 days, token and cost sums over the last day, and the conversation
 * and embedding counts. Each case asserts the exact gauge values, with rows
 * just outside each time window (aged with the database's own clock) and
 * duplicate values in neighbouring columns, so a different count or sum
 * gives a different number. Fixtures are synthetic.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import client from "prom-client";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
// collectMetrics also reads the budget service, which loads config. The
// budget gauges are not under test here, so the module is stubbed.
vi.mock("../budget/service.js", () => ({
  getBudgetStatus: () => ({ dailySpend: 0, dailyLimit: 1, remaining: 1 }),
  getThreeWindowStatus: () => ({
    hourly: { spend: 0, limit: 1 },
    monthly: { spend: 0, limit: 1 },
  }),
}));

import { collectMetrics } from "./prometheus.js";

/** Gauge values keyed by the value of its one label ("" when unlabelled). */
async function gauge(name: string): Promise<Record<string, number>> {
  const metric = client.register.getSingleMetric(name);
  if (!metric) throw new Error(`metric ${name} not registered`);
  const { values } = await metric.get();
  const out: Record<string, number> = {};
  for (const v of values) {
    const labels = Object.values(v.labels ?? {});
    out[labels.length ? String(labels[0]) : ""] = v.value;
  }
  return out;
}

let seq = 0;
function task(status: string, agentType: string | null, title: string): void {
  seq++;
  getDatabase()
    .prepare(
      `INSERT INTO tasks (task_id, title, description, status, agent_type)
       VALUES (?, ?, 'synthetic task', ?, ?)`,
    )
    .run(`t-prom-${seq}`, title, status, agentType);
}

/** `age` is a datetime() modifier list such as `'-7 days', '+5 minutes'`. */
function outcome(ranOn: string, success: number, durationMs: number, age: string): void {
  seq++;
  getDatabase()
    .prepare(
      `INSERT INTO task_outcomes (task_id, classified_as, ran_on, duration_ms, success, created_at)
       VALUES (?, 'class-x', ?, ?, ?, datetime('now', ${age}))`,
    )
    .run(`t-out-${seq}`, ranOn, durationMs, success);
}

function ledger(
  model: string,
  v: { prompt: number; completion: number; cost: number; read: number; creation: number },
  age: string,
): void {
  seq++;
  getDatabase()
    .prepare(
      `INSERT INTO cost_ledger
         (run_id, task_id, agent_type, model, prompt_tokens, completion_tokens, cost_usd,
          cache_read_tokens, cache_creation_tokens, created_at)
       VALUES (?, 't-ledger', 'fast', ?, ?, ?, ?, ?, ?, datetime('now', ${age}))`,
    )
    .run(`r-${seq}`, model, v.prompt, v.completion, v.cost, v.read, v.creation);
}

function conversation(bank: string, content: string): number {
  return Number(
    getDatabase()
      .prepare("INSERT INTO conversations (bank, content) VALUES (?, ?)")
      .run(bank, content).lastInsertRowid,
  );
}

beforeEach(() => {
  initDatabase(":memory:");
  client.register.resetMetrics();
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDatabase();
});

afterAll(() => {
  client.register.resetMetrics();
});

describe("collectMetrics — task counts by status", () => {
  // Distinct counts per status; within a status the agent type and title
  // repeat, so a count of distinct values in those columns is smaller, and
  // one row has no agent type, so a count of that column is smaller too.
  it("sets one gauge per status with that status's row count", async () => {
    task("completed", "fast", "same title");
    task("completed", "fast", "same title");
    task("completed", "heavy", "other title");
    task("failed", "fast", "same title");
    task("running", "fast", "same title");
    task("running", "fast", "same title");
    task("running", null, "same title");
    collectMetrics();
    expect(await gauge("mc_tasks_completed_total")).toEqual({
      completed: 3,
      failed: 1,
      running: 3,
    });
  });
});

describe("collectMetrics — runner stats over the last 7 days", () => {
  // fast: successes 2 of 3 and durations 100/100/700 (avg 300) inside the
  // window, plus a failed 10 s row five minutes outside it; heavy: 2 of 2,
  // avg 100. Durations repeat inside a runner, and every row has the same
  // class, so other columns cannot stand in for the runner or the count.
  it("averages duration and computes the success rate per runner inside the window", async () => {
    outcome("fast", 1, 100, "'-1 hour'");
    outcome("fast", 0, 100, "'-3 days'");
    outcome("fast", 1, 700, "'-7 days', '+5 minutes'");
    outcome("fast", 0, 10_000, "'-7 days', '-5 minutes'");
    outcome("heavy", 1, 50, "'-2 hours'");
    outcome("heavy", 1, 150, "'-6 days'");
    collectMetrics();
    expect(await gauge("mc_tasks_duration_avg_ms")).toEqual({ fast: 300, heavy: 100 });
    const rate = await gauge("mc_tasks_success_rate");
    expect(Object.keys(rate).sort()).toEqual(["fast", "heavy"]);
    expect(rate.fast).toBeCloseTo(2 / 3, 10);
    expect(rate.heavy).toBe(1);
  });
});

describe("collectMetrics — tokens and cost over the last day", () => {
  // Model A: two rows inside the window (one five minutes inside the edge)
  // and one large row five minutes outside it. Every summed column has its
  // own value, and every summed column of model A (and every token and cost
  // column of model B) has two different non-zero values inside the window,
  // so a swapped or dropped column, or a MAX/MIN in place of SUM, shows.
  // Model B has no cache telemetry (its cache columns are 0), so it gets no
  // cache gauges.
  it("sums each column per model inside the window", async () => {
    ledger("model-a", { prompt: 100, completion: 7, cost: 0.25, read: 40, creation: 15 }, "'-2 hours'");
    ledger(
      "model-a",
      { prompt: 300, completion: 9, cost: 0.5, read: 25, creation: 60 },
      "'-1 day', '+5 minutes'",
    );
    ledger(
      "model-a",
      { prompt: 5_000, completion: 4_000, cost: 9, read: 3_000, creation: 2_000 },
      "'-1 day', '-5 minutes'",
    );
    ledger("model-b", { prompt: 20, completion: 30, cost: 0.125, read: 0, creation: 0 }, "'-3 hours'");
    ledger("model-b", { prompt: 50, completion: 11, cost: 0.0625, read: 0, creation: 0 }, "'-4 hours'");
    collectMetrics();
    expect(await gauge("mc_tokens_prompt_total")).toEqual({ "model-a": 400, "model-b": 70 });
    expect(await gauge("mc_tokens_completion_total")).toEqual({ "model-a": 16, "model-b": 41 });
    expect(await gauge("mc_cost_total_usd")).toEqual({ "model-a": 0.75, "model-b": 0.1875 });
    expect(await gauge("mc_inference_cache_read_tokens_24h")).toEqual({ "model-a": 65 });
    const ratio = await gauge("mc_inference_cache_read_ratio_24h");
    expect(Object.keys(ratio)).toEqual(["model-a"]);
    expect(ratio["model-a"]).toBeCloseTo(65 / 400, 10);
  });
});

describe("collectMetrics — conversation and embedding counts", () => {
  // Bank and content repeat across rows, and two embeddings are identical,
  // so a count of distinct values in any column is smaller than the row
  // count. The embedding count is sampled at most every 10 minutes from the
  // process clock, so the clock is moved an hour past any earlier sample.
  // The module's sampling memo is not reset afterwards and stays at the
  // faked time, so this must remain the last case that reads the embeddings
  // gauge.
  it("counts every conversation row and every embedding row", async () => {
    vi.spyOn(Date, "now").mockReturnValue(4_000_000_000_000);
    const a = conversation("mc-jarvis", "same text");
    const b = conversation("mc-jarvis", "same text");
    const c = conversation("mc-operational", "other text");
    conversation("mc-operational", "other text");
    const blob = Buffer.from([1, 2, 3, 4]);
    const insert = getDatabase().prepare(
      "INSERT INTO conversation_embeddings (conversation_id, embedding) VALUES (?, ?)",
    );
    insert.run(a, blob);
    insert.run(b, blob);
    insert.run(c, Buffer.from([9, 9, 9, 9]));
    collectMetrics();
    expect(await gauge("mc_conversations_total")).toEqual({ "": 4 });
    expect(await gauge("mc_embeddings_total")).toEqual({ "": 3 });
  });
});
