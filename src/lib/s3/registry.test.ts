import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDatabase, closeDatabase, getDatabase } from "../../db/index.js";
import {
  insertSignalIfMissing,
  loadEnabledSignalsByCadence,
  loadAllEnabledSignals,
  loadAllSignals,
  recordEvaluation,
  loadAllEnabledSignalsFromDb,
  type Cadence,
  type AlertPriority,
} from "./registry.js";

/**
 * The drift-signal registry's loaders and evaluation write on the real
 * `drift_signals` table (`initDatabase` creates it empty; the boot seed runs
 * only from the scheduler). Loaders order by cadence, priority and name as
 * stored text, which the scheduler and the inventory walk rely on.
 */

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

function seed(
  name: string,
  cadence: Cadence,
  priority: AlertPriority,
  enabled = 1,
): number {
  return insertSignalIfMissing({
    signal_name: name,
    signal_kind: "test",
    source_substrate: "test",
    baseline_query: "SELECT 1 AS value",
    baseline_value_json: '{"value":1}',
    tolerance_json: '{"kind":"absolute_threshold","op":"gt","value":5}',
    cadence,
    alert_priority: priority,
    enabled,
    established_at: "2026-01-01T00:00:00.000Z",
    established_by: "test",
  });
}

function seedMix(): void {
  seed("n_p2_b", "nightly", "P2");
  seed("n_p1_z", "nightly", "P1");
  seed("n_p2_a", "nightly", "P2");
  seed("n_off", "nightly", "P0", 0);
  seed("h_p2", "hourly", "P2");
  seed("w_off", "weekly", "P1", 0);
}

const names = (rows: Array<{ signal_name: string }>) =>
  rows.map((r) => r.signal_name);

describe("loaders", () => {
  it("loadEnabledSignalsByCadence returns that cadence's enabled signals by priority then name", () => {
    seedMix();
    expect(names(loadEnabledSignalsByCadence("nightly"))).toEqual([
      "n_p1_z",
      "n_p2_a",
      "n_p2_b",
    ]);
    expect(names(loadEnabledSignalsByCadence("weekly"))).toEqual([]);
  });

  it("loadAllEnabledSignals and the injected-handle variant return every enabled signal by cadence, priority, name", () => {
    seedMix();
    const expected = ["h_p2", "n_p1_z", "n_p2_a", "n_p2_b"];
    expect(names(loadAllEnabledSignals())).toEqual(expected);
    expect(names(loadAllEnabledSignalsFromDb(getDatabase()))).toEqual(
      expected,
    );
  });

  it("loadAllSignals includes disabled signals, by cadence, priority, name", () => {
    seedMix();
    expect(names(loadAllSignals())).toEqual([
      "h_p2",
      "n_off",
      "n_p1_z",
      "n_p2_a",
      "n_p2_b",
      "w_off",
    ]);
  });
});

describe("recordEvaluation", () => {
  it("stamps the observation on that signal only; a null alert id keeps the last linked alert", () => {
    const id = seed("sig", "nightly", "P1");
    const other = seed("other", "nightly", "P1");
    const read = (sid: number) =>
      getDatabase()
        .prepare(
          "SELECT last_evaluated_at, last_observed_value_json, last_alert_id FROM drift_signals WHERE id = ?",
        )
        .get(sid) as {
        last_evaluated_at: string | null;
        last_observed_value_json: string | null;
        last_alert_id: number | null;
      };

    recordEvaluation(id, '{"value":9}', 41);
    expect(read(id)).toMatchObject({
      last_observed_value_json: '{"value":9}',
      last_alert_id: 41,
    });
    expect(read(id).last_evaluated_at).not.toBeNull();

    recordEvaluation(id, '{"value":2}', null);
    expect(read(id)).toMatchObject({
      last_observed_value_json: '{"value":2}',
      last_alert_id: 41,
    });

    expect(read(other)).toEqual({
      last_evaluated_at: null,
      last_observed_value_json: null,
      last_alert_id: null,
    });
  });
});
