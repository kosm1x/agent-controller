import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

const mem = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../db/index.js", () => ({ getDatabase: () => mem.db }));

import {
  applyRitualDeliveryPolicy,
  decideRitualDelivery,
  fingerprintReport,
} from "./delivery-policy.js";

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
    expect(decideRitualDelivery("nightly-close", "x", "x")).toEqual({
      deliver: true,
      reason: "default",
      fingerprint: null,
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
