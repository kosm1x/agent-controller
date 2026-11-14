/**
 * Alert router SQL on the real `signal_alerts` table.
 *
 * alert-router.test.ts stubs `prepare`, so it proves only which values are
 * bound. These cases run the dedup SELECT, the cooldown COUNT, the INSERT, the
 * two listing SELECTs and the delivery UPDATE on `initDatabase(":memory:")`
 * (with the real `tier` CHECK) and read the rows back.
 *
 * The time windows are computed by SQLite's clock (`datetime('now', …)`), so
 * rows are aged with that same expression. JavaScript `Date` is fixed, so the
 * cooldown end the module computes in JavaScript is an exact value.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import {
  createAlert,
  getRecentAlerts,
  getUndeliveredAlerts,
  markDelivered,
  shouldSuppress,
  type AlertCandidate,
  type AlertRow,
  type AlertTier,
} from "./alert-router.js";

const NOW = Date.parse("2026-03-01T12:00:00.000Z");
const HOUR = 3_600_000;
const SQLITE_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function candidate(overrides: Partial<AlertCandidate> = {}): AlertCandidate {
  return {
    tier: "PRIORITY",
    domain: "financial",
    title: "synthetic title",
    body: "synthetic body",
    signalIds: [7, 8],
    contentHash: "hash-a",
    ...overrides,
  };
}

/** Moves a row back in time on SQLite's clock, the one the windows read. */
function age(id: number, modifier: string): void {
  getDatabase()
    .prepare(
      "UPDATE signal_alerts SET created_at = datetime('now', ?) WHERE id = ?",
    )
    .run(modifier, id);
}

function row(id: number): AlertRow {
  return getDatabase()
    .prepare("SELECT * FROM signal_alerts WHERE id = ?")
    .get(id) as AlertRow;
}

const ids = (rows: AlertRow[]) => rows.map((r) => r.id);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
  vi.useRealTimers();
});

describe("createAlert on the real signal_alerts table", () => {
  it("writes every candidate field; the first alert of a hash has no cooldown", () => {
    const id = createAlert(candidate());
    expect(id).toBeGreaterThan(0);
    expect(row(id)).toMatchObject({
      tier: "PRIORITY",
      domain: "financial",
      title: "synthetic title",
      body: "synthetic body",
      signals_json: "[7,8]",
      content_hash: "hash-a",
      cooldown_until: null,
      delivered_via: null,
      delivered_at: null,
    });
    expect(row(id).created_at).toMatch(SQLITE_DATETIME);
  });

  it("repeats of a hash inside 24 h step the cooldown 4 h, 8 h, then 24 h", () => {
    const cooldowns = [1, 2, 3, 4, 5].map(
      (n) => row(createAlert(candidate({ title: `repeat ${n}` }))).cooldown_until,
    );
    expect(cooldowns).toEqual([
      null,
      new Date(NOW + 4 * HOUR).toISOString(),
      new Date(NOW + 8 * HOUR).toISOString(),
      new Date(NOW + 24 * HOUR).toISOString(),
      new Date(NOW + 24 * HOUR).toISOString(),
    ]);
    // Another hash starts its own count.
    expect(row(createAlert(candidate({ contentHash: "hash-b" }))).cooldown_until).toBeNull();
  });

  it("a repeat older than 24 h does not count toward the cooldown", () => {
    age(createAlert(candidate()), "-25 hours");
    expect(row(createAlert(candidate())).cooldown_until).toBeNull();
  });

  it("the real tier CHECK refuses a tier outside FLASH/PRIORITY/ROUTINE", () => {
    expect(() =>
      createAlert(candidate({ tier: "URGENT" as AlertTier })),
    ).toThrow(/CHECK constraint failed/);
    const n = getDatabase()
      .prepare("SELECT COUNT(*) AS n FROM signal_alerts")
      .get() as { n: number };
    expect(n.n).toBe(0);
  });
});

describe("shouldSuppress on the real signal_alerts table", () => {
  it("suppresses a hash seen inside the 4 h dedup window, and only that hash", () => {
    expect(shouldSuppress(candidate())).toBe(false);
    const id = createAlert(candidate());
    expect(shouldSuppress(candidate())).toBe(true);
    expect(shouldSuppress(candidate({ contentHash: "hash-b" }))).toBe(false);
    age(id, "-3 hours");
    expect(shouldSuppress(candidate())).toBe(true);
    age(id, "-5 hours");
    expect(shouldSuppress(candidate())).toBe(false);
  });

  it.todo(
    "a cooldown that outlasts the 4 h dedup window still suppresses a repeat",
  );
});

describe("alert listings on the real signal_alerts table", () => {
  it("lists undelivered alerts newest first, optionally one tier; a delivered alert drops out", () => {
    const flash = createAlert(candidate({ tier: "FLASH", contentHash: "h-f" }));
    const priority = createAlert(candidate({ tier: "PRIORITY", contentHash: "h-p" }));
    const routine = createAlert(candidate({ tier: "ROUTINE", contentHash: "h-r" }));
    age(flash, "-3 hours");
    age(priority, "-2 hours");
    age(routine, "-1 hours");

    expect(ids(getUndeliveredAlerts())).toEqual([routine, priority, flash]);
    expect(ids(getUndeliveredAlerts("FLASH"))).toEqual([flash]);

    markDelivered(priority, "telegram");
    expect(row(priority).delivered_via).toBe("telegram");
    expect(row(priority).delivered_at).toMatch(SQLITE_DATETIME);
    expect(row(flash).delivered_at).toBeNull();
    expect(row(routine).delivered_at).toBeNull();

    expect(ids(getUndeliveredAlerts())).toEqual([routine, flash]);
    expect(getUndeliveredAlerts("PRIORITY")).toEqual([]);
  });

  it("caps the undelivered list at 20 rows", () => {
    for (let n = 0; n < 21; n++) createAlert(candidate({ contentHash: `h-${n}` }));
    expect(getUndeliveredAlerts()).toHaveLength(20);
  });

  it("returns alerts inside the hour window newest first, by tier and up to the limit", () => {
    const old = createAlert(candidate({ tier: "FLASH", contentHash: "h-old" }));
    const mid = createAlert(candidate({ tier: "PRIORITY", contentHash: "h-mid" }));
    const recent = createAlert(candidate({ tier: "FLASH", contentHash: "h-new" }));
    age(old, "-30 hours");
    age(mid, "-2 hours");
    age(recent, "-1 hours");

    expect(ids(getRecentAlerts(24))).toEqual([recent, mid]);
    expect(ids(getRecentAlerts())).toEqual([recent, mid, old]);
    expect(ids(getRecentAlerts(48, "FLASH"))).toEqual([recent, old]);
    expect(ids(getRecentAlerts(48, undefined, 1))).toEqual([recent]);
    // Delivery does not hide an alert from the recent list.
    markDelivered(recent, "email");
    expect(ids(getRecentAlerts(24))).toEqual([recent, mid]);
  });
});
