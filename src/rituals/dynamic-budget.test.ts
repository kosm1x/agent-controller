/**
 * Usability Phase 5 — scheduled-task broadcasts go through the delivery seam
 * (reading budget, mute, sent-before), the Morning Sync receives yesterday's
 * deferrals, and email-only schedules feed the sent-before ledger.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import type { ScheduledTaskRow } from "./dynamic.js";

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  submitTask: vi.fn(),
  broadcastToAll: vi.fn(async () => ({ sent: 1, failed: 0 })),
}));

vi.mock("../db/index.js", () => ({ getDatabase: () => mocks.db }));
vi.mock("../dispatch/dispatcher.js", () => ({ submitTask: mocks.submitTask }));
vi.mock("../messaging/index.js", () => ({
  getRouter: () => ({ broadcastToAll: mocks.broadcastToAll }),
}));

import {
  createSchedule,
  ensureScheduledTasksTable,
  handleScheduledTaskResult,
  promptExtras,
  watchScheduledTask,
} from "./dynamic.js";
import { PUSH_CAP, applyRitualDeliveryPolicy } from "./delivery-policy.js";
import { enqueueDeferral, pendingDeferrals } from "./ritual-controls.js";
import { ensureSentItemsTable, recordSentItems } from "./sent-before.js";

function makeSchedule(overrides: Partial<ScheduledTaskRow> = {}): ScheduledTaskRow {
  return {
    id: 58,
    schedule_id: "bdb82f0c-posthumanismo",
    name: "Transición al Posthumanismo — Reflexión Diaria",
    description: "Genera la reflexión…",
    cron_expr: "0 12 * * 1-5",
    tools: "[]",
    delivery: "telegram",
    email_to: null,
    email_subject: null,
    active: 1,
    last_run_at: null,
    created_at: "2026-08-01 00:00:00",
    ...overrides,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function db(): Database.Database {
  return mocks.db as Database.Database;
}

/** Both anchors + `n` optional pushes: n=2 fills the day (slots are reserved for undelivered anchors). */
function fillBudget(n: number) {
  applyRitualDeliveryPolicy("schedule:ms", "a-sync", "Buenos días", { displayName: "Morning Sync — Piotr 8am", scheduleId: "ms" });
  applyRitualDeliveryPolicy("nightly-close", "a-close", "Cierre");
  for (let i = 0; i < n; i++) {
    applyRitualDeliveryPolicy(`schedule:filler-${i}`, `f${i}`, "x", { displayName: `Filler ${i}`, scheduleId: `filler-${i}` });
  }
}

describe("handleScheduledTaskResult → delivery seam", () => {
  beforeEach(() => {
    delete process.env.V82_SYNC_SCHEDULE_ID;
    mocks.db = new Database(":memory:");
    ensureScheduledTasksTable();
    createSchedule({
      scheduleId: "ms",
      name: "Morning Sync — Piotr 8am",
      description: "…",
      cronExpr: "0 8 * * *",
      tools: [],
      delivery: "telegram",
    } as never);
    mocks.broadcastToAll.mockClear();
  });
  afterEach(() => {
    db().close();
    vi.restoreAllMocks();
  });

  it("under the cap the text is broadcast and ledgered under schedule:<id>", async () => {
    watchScheduledTask("t1", makeSchedule());
    handleScheduledTaskResult("t1", "Tesis del día: el cuerpo como hardware.", "completed", []);
    await flush();
    expect(mocks.broadcastToAll).toHaveBeenCalledWith("Tesis del día: el cuerpo como hardware.");
    const row = db()
      .prepare("SELECT ritual_id, delivered, reason FROM ritual_deliveries ORDER BY id DESC LIMIT 1")
      .get();
    expect(row).toEqual({ ritual_id: "schedule:bdb82f0c-posthumanismo", delivered: 1, reason: "default" });
  });

  it("over the cap the schedule is NOT broadcast; a deferral is queued for the Morning Sync", async () => {
    fillBudget(2);
    watchScheduledTask("t2", makeSchedule());
    handleScheduledTaskResult("t2", "Tesis del día…", "completed", []);
    await flush();
    expect(mocks.broadcastToAll).not.toHaveBeenCalled();
    const d = db().prepare("SELECT title, reason FROM ritual_deferrals").all();
    expect(d).toEqual([{ title: "Transición al Posthumanismo — Reflexión Diaria", reason: "budget" }]);
  });

  it("the Morning Sync broadcasts over the cap", async () => {
    fillBudget(2);
    watchScheduledTask("t3", makeSchedule({ schedule_id: "ms", name: "Morning Sync — Piotr 8am" }));
    handleScheduledTaskResult("t3", "Buenos días, Fede…", "completed", []);
    await flush();
    expect(mocks.broadcastToAll).toHaveBeenCalledWith("Buenos días, Fede…");
  });

  it("a manual run (executeScheduleNow → watch(…, manual=true)) broadcasts over the cap", async () => {
    fillBudget(2);
    watchScheduledTask("t4", makeSchedule(), 0, null, true);
    handleScheduledTaskResult("t4", "Corrida manual", "completed", []);
    await flush();
    expect(mocks.broadcastToAll).toHaveBeenCalledWith("Corrida manual");
  });

  it("an email-only schedule (Pharma) never broadcasts but its items enter the sent-before ledger", async () => {
    watchScheduledTask(
      "t5",
      makeSchedule({ schedule_id: "pharma", name: "Reporte Diario Pharma", delivery: "email", email_to: "javier@eurekamd.net" }),
    );
    handleScheduledTaskResult(
      "t5",
      "- Tudriqev recibe aprobación FDA para cáncer de pulmón — https://fda.example/tudriqev",
      "completed",
      ["gmail_send"],
    );
    await flush();
    expect(mocks.broadcastToAll).not.toHaveBeenCalled();
    const items = db().prepare("SELECT ritual_id, head FROM ritual_sent_items").all();
    expect(items).toEqual([
      { ritual_id: "schedule:pharma", head: "- Tudriqev recibe aprobación FDA para cáncer de pulmón — https://fda.example/tudriqev" },
    ]);
  });
});

describe("promptExtras + deferral consumption on delivery", () => {
  beforeEach(() => {
    delete process.env.V82_SYNC_SCHEDULE_ID;
    mocks.db = new Database(":memory:");
    ensureScheduledTasksTable();
    mocks.broadcastToAll.mockClear();
  });
  afterEach(() => {
    (mocks.db as { close?: () => void }).close?.();
  });

  it("the Morning Sync gets the deferred block (not consumed yet); others get their sent-before list", () => {
    const id = enqueueDeferral("market-eod-scan", "t1", "Market EOD scan", "SPY −1.2%", "budget");
    ensureSentItemsTable();
    recordSentItems("schedule:pharma", "t2", "- Tudriqev recibe aprobación FDA — https://fda.example/t");

    const sync = promptExtras(makeSchedule({ schedule_id: "ms", name: "Morning Sync — Piotr 8am" }));
    expect(sync.text).toContain("DIFERIDOS (1)");
    expect(sync.text).toContain("SPY −1.2%");
    expect(sync.text).toContain(`/rituales completo ${id}`);
    expect(sync.deferralIds).toEqual([id]);
    expect(pendingDeferrals()).toHaveLength(1); // still pending until delivered

    const pharma = promptExtras(makeSchedule({ schedule_id: "pharma", name: "Reporte Diario Pharma" }));
    expect(pharma.text).toContain("YA ENVIADO en los últimos 14 días");
    expect(pharma.text).toContain("Tudriqev");
    expect(pharma.deferralIds).toEqual([]);
    expect(promptExtras(makeSchedule({ schedule_id: "nuevo", name: "Nuevo" })).text).toBe("");
  });

  it("deferrals are consumed only when the DELIVERED sync echoes their handle — not at build, not on a 0-send, not when the model drops the fold (R2 W5 / R3 W2)", async () => {
    const id = enqueueDeferral("market-eod-scan", "t1", "Market EOD scan", "SPY −1.2%", "budget");
    const id2 = enqueueDeferral("schedule:tw", "t2", "Tweet", "Tweet publicado", "budget");
    const sync = makeSchedule({ schedule_id: "ms", name: "Morning Sync — Piotr 8am" });
    const folded = `Buenos días…\n\nDiferido de ayer:\n- Market EOD scan: SPY −1.2% → /rituales completo ${id}\n- Tweet → /rituales completo ${id2}`;
    // 0 channels reached → nothing consumed.
    mocks.broadcastToAll.mockResolvedValueOnce({ sent: 0, failed: 1 });
    watchScheduledTask("s1", sync, 0, null, false, [id, id2]);
    handleScheduledTaskResult("s1", folded, "completed", []);
    await flush();
    expect(pendingDeferrals()).toHaveLength(2);
    // Delivered but the model dropped the section → still pending.
    watchScheduledTask("s2", sync, 0, null, false, [id, id2]);
    handleScheduledTaskResult("s2", "Buenos días… (sin diferidos)", "completed", []);
    await flush();
    expect(pendingDeferrals()).toHaveLength(2);
    // Delivered with one handle echoed → only that one is consumed.
    watchScheduledTask("s3", sync, 0, null, false, [id, id2]);
    handleScheduledTaskResult("s3", `Buenos días…\n- Market EOD scan → /rituales completo ${id}`, "completed", []);
    await flush();
    expect(pendingDeferrals().map((r) => r.id)).toEqual([id2]);
  });

  it("degrades to '' on a broken DB (the schedule still runs)", () => {
    mocks.db = { exec: () => { throw new Error("disk I/O"); }, prepare: () => { throw new Error("disk I/O"); } };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(promptExtras(makeSchedule()).text).toBe("");
    expect(promptExtras(makeSchedule({ name: "Morning Sync — Piotr 8am" })).text).toBe("");
    err.mockRestore();
  });
});
