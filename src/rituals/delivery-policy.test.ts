import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

const mem = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../db/index.js", () => ({ getDatabase: () => mem.db }));

import {
  EMAILED_PUSH_WORD_CAP,
  EMAILED_SHARE,
  PUSH_CAP,
  TELEGRAM_PUSH_WORD_CAP,
  WORD_CAP,
  applyRitualDeliveryPolicy,
  budgetUsed,
  capWords,
  decideRitualDelivery,
  fingerprintReport,
} from "./delivery-policy.js";
import { GLOBAL_MUTE_ID, pendingDeferrals, setMutedUntil } from "./ritual-controls.js";

const ZERO_DAY_1 = `**PM diario — 2026-08-20**

Universo: 100 mercados | Pesos: +0 largos, −0 cortos-via-NO | Rechazos: 198
Equity: $10000 → $10000  |  Cash: $10000 → $10000  |  Órdenes: 0/0/0
Top fills: (ninguno)
Alertas: 178 extreme_price + 20 far_resolution — considera ajustar market_limit`;

const ZERO_DAY_2 = ZERO_DAY_1.replace("2026-08-20", "2026-08-21").replace(
  "Órdenes: 0/0/0",
  "Órdenes: 0 planeadas / 0 ejecutadas / 0 rechazadas",
);

const WITH_FILLS = ZERO_DAY_1.replace("Órdenes: 0/0/0", "Órdenes: 3/2/1");

describe("decideRitualDelivery", () => {
  it("suppresses evolution-log and day-narrative unconditionally", () => {
    expect(decideRitualDelivery("evolution-log", "anything", null).deliver).toBe(false);
    expect(decideRitualDelivery("day-narrative", "anything", null).reason).toBe("suppressed");
  });

  it("delivers every non-policy ritual untouched", () => {
    expect(decideRitualDelivery("nightly-close", "x", "x")).toMatchObject({
      deliver: true,
      reason: "default",
      fingerprint: null,
      text: "x",
    });
  });

  it("pm: first ever report is delivered", () => {
    const d = decideRitualDelivery("pm-daily-rebalance", ZERO_DAY_1, null);
    expect(d.deliver).toBe(true);
    expect(d.reason).toBe("first");
  });

  it("pm: an unchanged zero-order report (different wording, same numbers) is silenced", () => {
    const fp = fingerprintReport(ZERO_DAY_1);
    const d = decideRitualDelivery("pm-daily-rebalance", ZERO_DAY_2, fp);
    expect(d.deliver).toBe(false);
    expect(d.reason).toBe("unchanged");
  });

  it("pm: fills always deliver", () => {
    const d = decideRitualDelivery(
      "pm-daily-rebalance",
      WITH_FILLS,
      fingerprintReport(WITH_FILLS),
    );
    expect(d.deliver).toBe(true);
    expect(d.reason).toBe("orders");
  });

  it("pm: an error report always delivers", () => {
    const d = decideRitualDelivery(
      "pm-daily-rebalance",
      "Error: pm_paper_rebalance abortó por posiciones stale",
      "whatever",
    );
    expect(d.deliver).toBe(true);
    expect(d.reason).toBe("error");
  });

  it("pm: changed rejections deliver", () => {
    const changed = ZERO_DAY_1.replace("Rechazos: 198", "Rechazos: 120");
    const d = decideRitualDelivery(
      "pm-daily-rebalance",
      changed,
      fingerprintReport(ZERO_DAY_1),
    );
    expect(d.deliver).toBe(true);
    expect(d.reason).toBe("changed");
  });
});

describe("applyRitualDeliveryPolicy (ledger)", () => {
  beforeEach(() => {
    mem.db = new Database(":memory:");
  });
  afterEach(() => {
    const db = mem.db as { close?: () => void };
    db.close?.();
    vi.restoreAllMocks();
  });

  it("records decisions and silences the second identical report", () => {
    const a = applyRitualDeliveryPolicy("pm-daily-rebalance", "t1", ZERO_DAY_1);
    const b = applyRitualDeliveryPolicy("pm-daily-rebalance", "t2", ZERO_DAY_2);
    expect(a.deliver).toBe(true);
    expect(b.deliver).toBe(false);
    const rows = (mem.db as Database.Database)
      .prepare("SELECT task_id, delivered, reason FROM ritual_deliveries ORDER BY id")
      .all();
    expect(rows).toEqual([
      { task_id: "t1", delivered: 1, reason: "first" },
      { task_id: "t2", delivered: 0, reason: "unchanged" },
    ]);
  });

  it("a silenced report does not become the comparison baseline", () => {
    applyRitualDeliveryPolicy("pm-daily-rebalance", "t1", ZERO_DAY_1);
    applyRitualDeliveryPolicy("pm-daily-rebalance", "t2", ZERO_DAY_2);
    // Same numbers as the last DELIVERED one → still unchanged.
    const c = applyRitualDeliveryPolicy("pm-daily-rebalance", "t3", ZERO_DAY_1);
    expect(c.deliver).toBe(false);
  });

  it("falls back to DELIVER when the DB is broken (mutation: ledger must never silence)", () => {
    mem.db = { exec: () => { throw new Error("disk I/O"); } };
    const d = applyRitualDeliveryPolicy("pm-daily-rebalance", "t9", ZERO_DAY_1);
    expect(d.deliver).toBe(true);
  });
});

describe("pm change-only against REAL reports (R1 audit W1, tasks 8519/8591/8615)", () => {
  const R_0820 = `I'll execute the PM daily rebalance ritual in sequence.---

**PM diario — 2026-08-20**

Universo: 100 mercados | Pesos: +0 largos, −0 cortos-via-NO | Rechazos: 198
Equity: — → — | Cash: sin cambios | Órdenes: 0 / 0 / 0
Top fills: *(ninguna — sin órdenes generadas)*
Alertas:

- 🔇 **Sin edge accionable:** \`pm_alpha_run\` encontró 100 mercados pero solo 2 tokens pasaron los filtros de liquidez/precio; ninguno superó el umbral Kelly mínimo (\`totalExposure = 0.00\`).
- 🚫 **extreme_price:** 176 tokens excluidos (precio ≤ 0.02 o ≥ 0.98 → sin edge significativo). La mayoría del universo son mercados 2028 con precios colapsados a $0.00–$0.01
- ✅ Sin posiciones abiertas previas, no hay stale-gate que disparar`;
  const R_0822 = `**PM diario — 2026-08-22**

Universo: 100 mercados | Pesos: +0 largos, −0 cortos-via-NO | Rechazos: 198
Equity: $10,000.00 → $10,000.00 | Cash: $10,000.00 → $10,000.00 | Órdenes: 0 planeadas / 0 ejecutadas / 0 rechazadas
Top fills: *(ninguna — sin órdenes generadas)*
Alertas:
- **176 tokens excluidos por \`extreme_price\`**: todo el universo de 2028 tiene YES a $0.00–$0.04
- **22 tokens por \`far_resolution\`** — mercados 2028 fuera de ventana. Los tres pasos completaron sin errores.`;
  const R_0821 = `## PM diario — 2026-08-21

**Universo:** 100 mercados | **Pesos:** +0 largos, −0 cortos-via-NO | **Rechazos:** 98

**Equity:** $10,000.00 → $10,000.00 | **Cash:** $10,000.00 → $10,000.00 | **Órdenes:** 0 planeadas / 0 ejecutadas / 0 rechazadas`;

  it("two zero-order days with the same rejections → the second is silenced (different wording, prices, dates)", () => {
    const fp = fingerprintReport(R_0820);
    expect(fp).toBe(fingerprintReport(R_0822));
    const d = decideRitualDelivery("pm-daily-rebalance", R_0822, fp);
    expect(d).toMatchObject({ deliver: false, reason: "unchanged" });
  });

  it("'stale' / 'sin errores' in a normal report are not error events", () => {
    expect(decideRitualDelivery("pm-daily-rebalance", R_0820, fingerprintReport(R_0820)).reason).toBe("unchanged");
    expect(decideRitualDelivery("pm-daily-rebalance", R_0822, fingerprintReport(R_0822)).reason).toBe("unchanged");
  });

  it("a negated error mention ('Sin stale-position abort', task 8473) is not an error event", () => {
    const negated = R_0822 + "\n- ✅ Sin stale-position abort — portafolio en cero, nada que sanear.";
    expect(decideRitualDelivery("pm-daily-rebalance", negated, fingerprintReport(R_0822)).reason).toBe("unchanged");
    const real = R_0822 + "\n- ❌ pm_paper_rebalance abortó: posiciones stale";
    expect(decideRitualDelivery("pm-daily-rebalance", real, fingerprintReport(R_0822)).reason).toBe("error");
  });

  it("a real change in rejections (198 → 98) is delivered", () => {
    const d = decideRitualDelivery("pm-daily-rebalance", R_0821, fingerprintReport(R_0820));
    expect(d).toMatchObject({ deliver: true, reason: "changed" });
  });

  it("bold-wrapped Órdenes with fills → orders", () => {
    const withFills = R_0821.replace("0 planeadas / 0 ejecutadas", "2 planeadas / 2 ejecutadas");
    expect(decideRitualDelivery("pm-daily-rebalance", withFills, fingerprintReport(withFills)).reason).toBe("orders");
  });
});

// ---------------------------------------------------------------------------
// Usability Phase 5 — the seam pipeline
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-24T18:00:00Z"); // 12:00 MX
const DAY = "2026-08-24";

function db(): Database.Database {
  return mem.db as Database.Database;
}

function ledger() {
  return db()
    .prepare("SELECT ritual_id, delivered, reason, words, day FROM ritual_deliveries ORDER BY id")
    .all() as { ritual_id: string; delivered: number; reason: string; words: number; day: string }[];
}

function deferrals() {
  return db()
    .prepare("SELECT ritual_id, title, reason FROM ritual_deferrals ORDER BY id")
    .all() as { ritual_id: string; title: string; reason: string }[];
}

/** One Telegram-only optional push (`wordsEach` words) — delivered or deferred by the seam. */
function optional(i: number, wordsEach = 10) {
  return applyRitualDeliveryPolicy(`schedule:filler-${i}`, `f${i}`, "palabra ".repeat(wordsEach).trim(), {
    displayName: `Filler ${i}`,
    scheduleId: `filler-${i}`,
    now: NOW,
  });
}

/** Both anchors delivered (2 pushes, ~5 words) plus `n` optional pushes: n=2 fills the day. */
function fillBudget(n: number, wordsEach = 10) {
  applyRitualDeliveryPolicy("schedule:ms", "a-sync", "Buenos días Fede", SYNC);
  applyRitualDeliveryPolicy("nightly-close", "a-close", "Cierre del día", { now: NOW });
  for (let i = 0; i < n; i++) optional(i, wordsEach);
}

/** The deferral consumer: an ACTIVE Morning Sync row (identity by name — env unset in tests). */
function seedSync(active = 1) {
  delete process.env.V82_SYNC_SCHEDULE_ID;
  db().exec(`CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, schedule_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '', cron_expr TEXT NOT NULL DEFAULT '0 8 * * *', active INTEGER DEFAULT 1)`);
  db().prepare("INSERT OR REPLACE INTO scheduled_tasks (schedule_id, name, active) VALUES ('ms', 'Morning Sync — Piotr 8am', ?)").run(active);
}

const SYNC = { displayName: "Morning Sync — Piotr 8am", scheduleId: "ms", now: NOW };

const DIGEST = `**Señales — hoy**
- Anthropic lanza Claude Agent SDK 2.0 — https://example.com/sdk2
- Meta abre WhatsApp Calling API — https://example.com/wa-calling
📊 **Meta**: 3 fuentes.`;

describe("Phase 5 seam — ledger columns and reading budget (5.6, plan-literal)", () => {
  beforeEach(() => {
    mem.db = new Database(":memory:");
    seedSync();
  });
  afterEach(() => {
    db().close();
    vi.restoreAllMocks();
  });

  it("records words and the MX day; delivers under the cap", () => {
    const d = applyRitualDeliveryPolicy("market-eod-scan", "t1", "uno dos tres cuatro", { now: NOW });
    expect(d).toMatchObject({ deliver: true, reason: "default", words: 4 });
    expect(ledger()).toEqual([
      { ritual_id: "market-eod-scan", delivered: 1, reason: "default", words: 4, day: DAY },
    ]);
  });

  it("migrates a pre-Phase-5 ledger (no words/day/anchor/emailed columns) in place", () => {
    db().exec(`CREATE TABLE ritual_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ritual_id TEXT NOT NULL, task_id TEXT,
      fingerprint TEXT, delivered INTEGER NOT NULL, reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    db().prepare("INSERT INTO ritual_deliveries (ritual_id, delivered, reason) VALUES ('x', 1, 'default')").run();
    const d = applyRitualDeliveryPolicy("market-eod-scan", "t1", "hola", { now: NOW });
    expect(d.deliver).toBe(true);
    expect(ledger().at(-1)).toMatchObject({ words: 1, day: DAY });
    expect(budgetUsed(DAY)).toMatchObject({ pushes: 1, emailedPushes: 0 });
  });

  it(`the ${PUSH_CAP + 1}th push of the day is deferred into the Morning Sync queue`, () => {
    fillBudget(2);
    const d = applyRitualDeliveryPolicy("market-eod-scan", "t5", "SPY −1.2%", { now: NOW });
    expect(d).toMatchObject({ deliver: false, reason: "budget" });
    expect(deferrals()).toEqual([{ ritual_id: "market-eod-scan", title: "market-eod-scan", reason: "budget" }]);
    expect(ledger().at(-1)).toMatchObject({ delivered: 0, reason: "budget" });
  });

  it(`a Telegram-only push over ${TELEGRAM_PUSH_WORD_CAP} words is cut with a phone handle; the full text is stored and NOT folded (R1 C2 / R2 C2)`, () => {
    const post = Array.from({ length: 120 }, (_, i) => `línea ${i} con seis palabras aquí`).join("\n");
    const a = applyRitualDeliveryPolicy("schedule:williams", "t1", post, { displayName: "Williams Journal", scheduleId: "williams", now: NOW });
    expect(a.deliver).toBe(true);
    const [body, pointer] = a.text.split("\n\n📄 ");
    expect(body.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(TELEGRAM_PUSH_WORD_CAP);
    expect(pointer).toMatch(/^Completo: \/rituales completo \d+$/);
    const id = Number(pointer.match(/\d+$/)![0]);
    const stored = db().prepare("SELECT title, text, reason, consumed_at FROM ritual_deferrals WHERE id = ?").get(id) as { title: string; text: string; reason: string; consumed_at: string | null };
    expect(stored).toMatchObject({ title: "Williams Journal", text: post, reason: "capped" });
    expect(stored.consumed_at).not.toBeNull(); // never folded into the sync
    expect(pendingDeferrals()).toEqual([]);
    // A short Telegram-only push is untouched.
    const b = applyRitualDeliveryPolicy("schedule:tweet", "t2", "Tweet publicado ✅", { displayName: "Tweet", scheduleId: "tw", now: NOW });
    expect(b.text).toBe("Tweet publicado ✅");
  });

  it(`emailed content is cut to ${EMAILED_PUSH_WORD_CAP} words on Telegram (the inbox has it) and delivers on an empty day`, () => {
    const digest = Array.from({ length: 80 }, (_, i) => `- señal ${i} con ocho palabras en la línea aquí`).join("\n");
    const d = applyRitualDeliveryPolicy("signal-intelligence", "t1", digest, { now: NOW });
    expect(d.deliver).toBe(true);
    const [body, pointer] = d.text.split("\n\n📄 ");
    expect(body.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(EMAILED_PUSH_WORD_CAP);
    expect(pointer).toBe("Completo en el correo · mc-ctl task t1");
  });

  it("R2 C1: the sent-before ledger records the PRE-cap text — a repeat beyond the Telegram cut is still a repeat", () => {
    const digest = Array.from({ length: 30 }, (_, i) => `- Hallazgo número ${i} sobre agentes autónomos y orquestación en producción — https://example.com/${i}`).join("\n");
    applyRitualDeliveryPolicy("signal-intelligence", "t1", digest, { now: NOW });
    const ledgered = db().prepare("SELECT COUNT(*) AS n FROM ritual_sent_items WHERE ritual_id = 'signal-intelligence'").get() as { n: number };
    expect(ledgered.n).toBe(30);
    const again = applyRitualDeliveryPolicy("signal-intelligence", "t2", digest, { now: new Date("2026-08-25T18:00:00Z") });
    expect(again).toMatchObject({ deliver: false, reason: "no_new_items", droppedItems: 30 });
  });

  it(`emailed pushes take at most ${EMAILED_SHARE.pushes} push / ${EMAILED_SHARE.words} words a day; Telegram-only readings keep the rest`, () => {
    const scan = "palabra ".repeat(180).trim();
    expect(applyRitualDeliveryPolicy("signal-intelligence", "t1", scan, { now: NOW }).deliver).toBe(true);
    const second = applyRitualDeliveryPolicy("market-morning-scan", "t2", scan, { now: NOW });
    expect(second).toMatchObject({ deliver: false, reason: "budget" });
    const essay = "palabra ".repeat(200).trim();
    const d = applyRitualDeliveryPolicy("schedule:post", "t4", essay, { displayName: "Posthumanismo", scheduleId: "post", now: NOW });
    expect(d).toMatchObject({ deliver: true, words: 200 });
    expect(budgetUsed(DAY)).toMatchObject({ pushes: 2, emailedPushes: 1 });
  });

  it("a push that would pass the day's word cap is deferred (pushes still free)", () => {
    // A long Morning Sync (anchors are not capped) leaves 200 words of room.
    applyRitualDeliveryPolicy("schedule:ms", "a-sync", "palabra ".repeat(495).trim(), SYNC);
    applyRitualDeliveryPolicy("nightly-close", "a-close", "Cierre del día", { now: NOW }); // 3 words
    const fits = applyRitualDeliveryPolicy("schedule:tweet", "t0", "palabra ".repeat(150).trim(), { displayName: "Tweet", scheduleId: "tw", now: NOW });
    expect(fits.deliver).toBe(true); // 648
    const d = applyRitualDeliveryPolicy("schedule:post", "t1", "palabra ".repeat(100).trim(), { displayName: "Posthumanismo", scheduleId: "post", now: NOW });
    expect(d).toMatchObject({ deliver: false, reason: "budget" }); // 748 > 700 with 1 slot left
  });

  it("the budget is per MX day: yesterday's pushes do not count", () => {
    fillBudget(2);
    db().prepare("UPDATE ritual_deliveries SET day = '2026-08-23'").run();
    const d = applyRitualDeliveryPolicy("market-eod-scan", "t5", "SPY −1.2%", { now: NOW });
    expect(d.deliver).toBe(true);
  });

  it("optional pushes leave a slot for each anchor not yet delivered today — the close is never the 5th push", () => {
    // 06:00: nothing delivered → 2 slots reserved → the 3rd optional push waits.
    expect(optional(0).deliver).toBe(true);
    expect(optional(1).deliver).toBe(true);
    expect(applyRitualDeliveryPolicy("market-eod-scan", "t1", "SPY", { now: NOW }).reason).toBe("budget");
    // After the sync: 1 slot reserved for the close → still no room (3 + 1 ≥ 4).
    applyRitualDeliveryPolicy("schedule:ms", "t2", "Buenos días…", SYNC);
    expect(applyRitualDeliveryPolicy("market-eod-scan", "t3", "SPY", { now: NOW }).reason).toBe("budget");
    // The close takes its reserved slot: exactly 4 pushes, never 5.
    expect(applyRitualDeliveryPolicy("nightly-close", "t4", "Cierre", { now: NOW }).deliver).toBe(true);
    expect(budgetUsed(DAY).pushes).toBe(PUSH_CAP);
  });

  it("Morning Sync and nightly-close ALWAYS deliver and COUNT toward the plan's 4/700 (R2 C2)", () => {
    fillBudget(0);
    expect(db().prepare("SELECT COUNT(*) AS n FROM ritual_deliveries WHERE anchor = 1 AND delivered = 1").get()).toEqual({ n: 2 });
    expect(budgetUsed(DAY).pushes).toBe(2);
    expect(optional(0).deliver).toBe(true);
    expect(optional(1).deliver).toBe(true);
    expect(budgetUsed(DAY).pushes).toBe(PUSH_CAP);
    expect(applyRitualDeliveryPolicy("market-eod-scan", "t8", "SPY", { now: NOW }).reason).toBe("budget");
    // Anchors still deliver when everything is over.
    expect(applyRitualDeliveryPolicy("schedule:ms", "t10", "Buenos días…", SYNC).deliver).toBe(true);
  });

  it("the Morning Sync is identified by V82_SYNC_SCHEDULE_ID when set (name is the fallback only)", () => {
    process.env.V82_SYNC_SCHEDULE_ID = "ms";
    fillBudget(2);
    const impostor = applyRitualDeliveryPolicy("schedule:x", "t1", "hola", { displayName: "Morning Sync — Piotr 8am", scheduleId: "x", now: NOW });
    expect(impostor).toMatchObject({ deliver: false, reason: "budget" });
    const renamed = applyRitualDeliveryPolicy("schedule:ms", "t2", "hola", { displayName: "Briefing matutino", scheduleId: "ms", now: NOW });
    expect(renamed.deliver).toBe(true);
    delete process.env.V82_SYNC_SCHEDULE_ID;
  });

  it("a paused Morning Sync does not void the budget: the push is still deferred and reachable by id (R2 C3/W3)", () => {
    seedSync(0);
    fillBudget(2);
    const d = applyRitualDeliveryPolicy("market-eod-scan", "t5", "SPY −1.2%", { now: NOW });
    expect(d).toMatchObject({ deliver: false, reason: "budget" });
    expect(pendingDeferrals().map((r) => r.title)).toEqual(["market-eod-scan"]);
  });

  it("ANCHOR_SCHEDULE_IDS: a schedule in the list delivers even when the budget is full", () => {
    const READING_ID = "bdb82f0c-c2f4-4414-8244-300bf4721d78";
    process.env.ANCHOR_SCHEDULE_IDS = READING_ID;
    fillBudget(2);
    const d = applyRitualDeliveryPolicy(
      `schedule:${READING_ID}`,
      "t-reading",
      "Reflexión filosófica del día",
      { displayName: "Transición al Posthumanismo — Reflexión Diaria", scheduleId: READING_ID, now: NOW },
    );
    expect(d.deliver).toBe(true);
    // Must be recorded as anchor so the ledger is honest.
    const row = db().prepare("SELECT anchor FROM ritual_deliveries WHERE task_id = 't-reading'").get() as { anchor: number };
    expect(row.anchor).toBe(1);
    delete process.env.ANCHOR_SCHEDULE_IDS;
  });

  it("ANCHOR_SCHEDULE_IDS: a schedule NOT in the list still hits the budget", () => {
    process.env.ANCHOR_SCHEDULE_IDS = "some-other-id";
    fillBudget(2);
    const d = applyRitualDeliveryPolicy("schedule:x", "t-not-anchor", "hola", { displayName: "Química", scheduleId: "x", now: NOW });
    expect(d).toMatchObject({ deliver: false, reason: "budget" });
    delete process.env.ANCHOR_SCHEDULE_IDS;
  });

  it("ANCHOR_SCHEDULE_IDS: empty/whitespace env var has no effect", () => {
    process.env.ANCHOR_SCHEDULE_IDS = "  ,  ";
    fillBudget(2);
    const d = applyRitualDeliveryPolicy("schedule:x", "t-empty", "hola", { displayName: "Química", scheduleId: "x", now: NOW });
    expect(d).toMatchObject({ deliver: false, reason: "budget" });
    delete process.env.ANCHOR_SCHEDULE_IDS;
  });

  it("an operator-forced run (/run) delivers over the cap", () => {
    fillBudget(2);
    const d = applyRitualDeliveryPolicy("schedule:x", "t8", "manual", { displayName: "Química", scheduleId: "x", forced: true, now: NOW });
    expect(d.deliver).toBe(true);
  });

  it("deferred pushes are NOT counted as delivered", () => {
    fillBudget(2);
    applyRitualDeliveryPolicy("market-eod-scan", "t5", "SPY −1.2%", { now: NOW });
    expect(budgetUsed(DAY).pushes).toBe(PUSH_CAP);
  });

  it("words are counted after the deliverable filter (R1 W4)", () => {
    const d = applyRitualDeliveryPolicy("market-eod-scan", "t1", "STATUS: DONE\nuno dos tres", { now: NOW });
    expect(d.words).toBe(3);
  });
});

describe("Phase 5 seam — mute (5.5)", () => {
  beforeEach(() => {
    mem.db = new Database(":memory:");
    seedSync();
  });
  afterEach(() => {
    db().close();
    vi.restoreAllMocks();
  });

  it("a global mute defers every non-exempt push; an expired mute delivers", () => {
    setMutedUntil(GLOBAL_MUTE_ID, new Date("2026-08-24T21:00:00Z"));
    const d = applyRitualDeliveryPolicy("market-eod-scan", "t1", "SPY −1.2%", { now: NOW });
    expect(d).toMatchObject({ deliver: false, reason: "muted" });
    expect(deferrals()).toEqual([{ ritual_id: "market-eod-scan", title: "market-eod-scan", reason: "muted" }]);
    const later = applyRitualDeliveryPolicy("market-eod-scan", "t2", "SPY −1.2%", {
      now: new Date("2026-08-24T21:00:01Z"),
    });
    expect(later.deliver).toBe(true);
  });

  it("a mute still defers when the Morning Sync is paused — never silently void (R2 C3)", () => {
    seedSync(0);
    setMutedUntil(GLOBAL_MUTE_ID, new Date("2026-08-24T21:00:00Z"));
    const d = applyRitualDeliveryPolicy("market-eod-scan", "t1", "SPY −1.2%", { now: NOW });
    expect(d).toMatchObject({ deliver: false, reason: "muted" });
    expect(pendingDeferrals()).toHaveLength(1);
  });

  it("the Morning Sync ignores the mute", () => {
    setMutedUntil(GLOBAL_MUTE_ID, new Date("2026-08-25T21:00:00Z"));
    const d = applyRitualDeliveryPolicy("schedule:ms", "t1", "Buenos días", SYNC);
    expect(d.deliver).toBe(true);
  });
});

describe("Phase 5 seam — sent-before (5.1/5.2), word cap (5.3), signal lead (5.4)", () => {
  beforeEach(() => {
    mem.db = new Database(":memory:");
    seedSync();
  });
  afterEach(() => {
    db().close();
    vi.restoreAllMocks();
  });

  it("signal-intelligence: repeated items are dropped with a footer; a fully repeated digest is silenced", () => {
    const a = applyRitualDeliveryPolicy("signal-intelligence", "t1", DIGEST, { now: NOW });
    expect(a).toMatchObject({ deliver: true, droppedItems: 0 });
    expect(a.text).toBe(DIGEST);

    const partial = DIGEST.replace(
      "- Meta abre WhatsApp Calling API — https://example.com/wa-calling",
      "- OpenAI publica Realtime v2 — https://example.com/realtime",
    );
    const b = applyRitualDeliveryPolicy("signal-intelligence", "t2", partial, {
      now: new Date("2026-08-25T18:00:00Z"),
    });
    // The bold title normalises to 11 chars (< 12) and is not an item — only
    // the Anthropic finding repeats.
    expect(b).toMatchObject({ deliver: true, droppedItems: 1 });
    expect(b.text).not.toContain("Anthropic");
    expect(b.text).toContain("OpenAI publica Realtime v2");
    expect(b.text).toContain("**Señales — hoy**");
    expect(b.text).toContain("(1 señal ya enviada omitida)");

    const c = applyRitualDeliveryPolicy("signal-intelligence", "t3", DIGEST, {
      now: new Date("2026-08-26T18:00:00Z"),
    });
    expect(c).toMatchObject({ deliver: false, reason: "no_new_items" });
    expect(ledger().at(-1)).toMatchObject({ delivered: 0, reason: "no_new_items" });
  });

  it("a silenced digest does not consume the reading budget", () => {
    applyRitualDeliveryPolicy("signal-intelligence", "t1", DIGEST, { now: NOW });
    applyRitualDeliveryPolicy("signal-intelligence", "t2", DIGEST, { now: NOW });
    const used = db()
      .prepare("SELECT COUNT(*) AS n FROM ritual_deliveries WHERE delivered = 1")
      .get() as { n: number };
    expect(used.n).toBe(1);
  });

  it("other rituals are never line-filtered (market scans repeat tickers by design)", () => {
    const scan = "- SPY 450 → 452\n- QQQ 380 → 381";
    applyRitualDeliveryPolicy("market-eod-scan", "t1", scan, { now: NOW });
    const d = applyRitualDeliveryPolicy("market-eod-scan", "t2", scan, { now: NOW });
    expect(d).toMatchObject({ deliver: true, droppedItems: 0 });
    expect(d.text).toBe(scan);
  });

  it("skill-evolution is suppressed (5.3 — the memory bank + mc-ctl task keep it)", () => {
    const d = applyRitualDeliveryPolicy("skill-evolution", "t1", "EVOLUTION REPORT", { now: NOW });
    expect(d).toMatchObject({ deliver: false, reason: "suppressed" });
  });

  it("nightly-close is capped at 250 words on Telegram with a pointer to the email", () => {
    const long = Array.from({ length: 40 }, (_, i) => `- línea ${i} con ocho palabras en total aquí mismo`).join("\n");
    const d = applyRitualDeliveryPolicy("nightly-close", "t1", long, { now: NOW });
    expect(d.deliver).toBe(true);
    const [body, pointer] = d.text.split("\n\n📄 ");
    expect(body.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(250);
    expect(pointer).toBe("Completo en el correo · mc-ctl task t1");
    expect(d.text).not.toContain("línea 39");
    // A short close is untouched.
    const short = applyRitualDeliveryPolicy("nightly-close", "t2", "Cierre breve.", { now: NOW });
    expect(short.text).toBe("Cierre breve.");
  });

  it("capWords cuts at a line boundary", () => {
    expect(capWords("a b c\nd e f\ng h", 4, "P")).toBe("a b c\n\nP");
    expect(capWords("a b", 4, "P")).toBe("a b");
  });

  it("signal digest: a ≥10 % tracked move is prepended deterministically and 'estables' is flagged", () => {
    db().exec(`CREATE TABLE signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, domain TEXT NOT NULL,
      signal_type TEXT NOT NULL, key TEXT NOT NULL, value_numeric REAL, value_text TEXT,
      metadata TEXT, geo_lat REAL, geo_lon REAL, content_hash TEXT,
      collected_at TEXT NOT NULL, source_timestamp TEXT)`);
    const ins = db().prepare(
      "INSERT INTO signals (source, domain, signal_type, key, value_numeric, collected_at) VALUES ('coingecko','financial','numeric','bitcoin',?,?)",
    );
    ins.run(60000, "2026-08-23 17:00:00");
    ins.run(73200, "2026-08-24 17:30:00");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = applyRitualDeliveryPolicy("signal-intelligence", "t1", "Crypto estables hoy.\n" + DIGEST, { now: NOW });
    expect(d.deliver).toBe(true);
    expect(d.text.startsWith("📈 Movimientos ≥10%: BTC +22.0% (24h)")).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("estables"));
  });

  it("no signals table → no lead line, digest still delivers", () => {
    const d = applyRitualDeliveryPolicy("signal-intelligence", "t1", DIGEST, { now: NOW });
    expect(d.text).toBe(DIGEST);
  });
});
