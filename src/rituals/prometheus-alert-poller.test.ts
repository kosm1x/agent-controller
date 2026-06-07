/**
 * Prometheus alert notifier — pure diff/format + the runPoll state machine.
 * No network / router: fetch + send are injected.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the messaging singleton so the default send path (router.sendBriefingToOwner)
// is exercisable without a live router. vi.hoisted per project testing convention.
const { mockRouter } = vi.hoisted(() => ({
  mockRouter: { sendBriefingToOwner: vi.fn() },
}));
vi.mock("../messaging/index.js", () => ({
  getRouter: () => mockRouter,
}));

import {
  alertFingerprint,
  planAlertNotifications,
  formatAlertMessage,
  runPrometheusAlertPoll,
  _resetAlertNotifierState,
  type PromAlert,
  type NotifiedAlert,
} from "./prometheus-alert-poller.js";

function alert(
  name: string,
  severity: string,
  extraLabels: Record<string, string> = {},
  summary?: string,
): PromAlert {
  return {
    labels: { alertname: name, severity, ...extraLabels },
    annotations: { summary: summary ?? `${name} summary` },
    state: "firing",
  };
}

function notifiedMap(...alerts: PromAlert[]): Map<string, NotifiedAlert> {
  const m = new Map<string, NotifiedAlert>();
  for (const a of alerts) {
    const fp = alertFingerprint(a);
    m.set(fp, {
      fingerprint: fp,
      name: a.labels.alertname!,
      severity: a.labels.severity!,
      summary: a.annotations.summary!,
    });
  }
  return m;
}

describe("alertFingerprint", () => {
  it("is independent of label order", () => {
    const a: PromAlert = {
      labels: { b: "2", a: "1" },
      annotations: {},
      state: "firing",
    };
    const b: PromAlert = {
      labels: { a: "1", b: "2" },
      annotations: {},
      state: "firing",
    };
    expect(alertFingerprint(a)).toBe(alertFingerprint(b));
  });

  it("distinguishes instances by label value (e.g. salon_id)", () => {
    const a = alert("SalonWhatsAppLoggedOut", "critical", { salon_id: "x" });
    const b = alert("SalonWhatsAppLoggedOut", "critical", { salon_id: "y" });
    expect(alertFingerprint(a)).not.toBe(alertFingerprint(b));
  });
});

describe("planAlertNotifications", () => {
  it("announces all firing when nothing was notified yet", () => {
    const firing = [alert("A", "warning"), alert("B", "critical")];
    const plan = planAlertNotifications(firing, new Map());
    expect(plan.newlyFiring.map((n) => n.name).sort()).toEqual(["A", "B"]);
    expect(plan.resolved).toEqual([]);
    expect(plan.nextNotified.size).toBe(2);
  });

  it("dedupes already-notified firing alerts (steady state = no-op)", () => {
    const a = alert("A", "warning");
    const plan = planAlertNotifications([a], notifiedMap(a));
    expect(plan.newlyFiring).toEqual([]);
    expect(plan.resolved).toEqual([]);
  });

  it("announces resolved when a notified alert stops firing", () => {
    const a = alert("A", "warning");
    const plan = planAlertNotifications([], notifiedMap(a));
    expect(plan.newlyFiring).toEqual([]);
    expect(plan.resolved.map((n) => n.name)).toEqual(["A"]);
    expect(plan.nextNotified.size).toBe(0);
  });

  it("handles a mixed tick (new + resolved + steady)", () => {
    const a = alert("A", "warning");
    const b = alert("B", "critical");
    const c = alert("C", "warning");
    // was firing {A,B}; now firing {B,C} → new=C, resolved=A, steady=B
    const plan = planAlertNotifications([b, c], notifiedMap(a, b));
    expect(plan.newlyFiring.map((n) => n.name)).toEqual(["C"]);
    expect(plan.resolved.map((n) => n.name)).toEqual(["A"]);
    expect([...plan.nextNotified.values()].map((n) => n.name).sort()).toEqual([
      "B",
      "C",
    ]);
  });
});

describe("formatAlertMessage", () => {
  const fire = (name: string, sev: string, summary: string): NotifiedAlert => ({
    fingerprint: name,
    name,
    severity: sev,
    summary,
  });

  it("renders firing with a severity emoji + summary", () => {
    const msg = formatAlertMessage(
      [fire("CritCPU", "critical", "CPU > 95%")],
      [],
    );
    expect(msg).toContain("🚨 1 alert(s) firing:");
    expect(msg).toContain("🔴 CPU > 95%");
  });

  it("renders resolved by name", () => {
    const msg = formatAlertMessage([], [fire("HighCPU", "warning", "x")]);
    expect(msg).toContain("✅ 1 resolved:");
    expect(msg).toContain("• HighCPU");
  });

  it("renders both sections together", () => {
    const msg = formatAlertMessage(
      [fire("A", "warning", "a fires")],
      [fire("B", "critical", "b")],
    );
    expect(msg).toContain("🟠 a fires");
    expect(msg).toContain("✅ 1 resolved:");
    expect(msg).toContain("• B");
  });

  it("caps a long firing section with '…and N more' (qa-N1)", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      fire(`A${i}`, "warning", `summary ${i}`),
    );
    const msg = formatAlertMessage(many, []);
    expect(msg).toContain("🚨 25 alert(s) firing:");
    expect(msg).toContain("…and 5 more"); // 25 − 20 cap
    expect(msg).not.toContain("summary 24"); // 21st+ item not rendered inline
  });
});

describe("defaultSend path — qa-C1: zero delivery must not commit", () => {
  beforeEach(() => {
    _resetAlertNotifierState();
    mockRouter.sendBriefingToOwner.mockReset();
  });

  it("throws when no operator channel delivered (sent=0) → not committed, retried", async () => {
    const a = alert("A", "critical");
    mockRouter.sendBriefingToOwner.mockResolvedValue({ sent: 0, failed: 1 });
    await expect(
      runPrometheusAlertPoll({ fetchAlerts: async () => [a] }),
    ).rejects.toThrow(/not delivered/);

    // state not committed → next tick (channel now up) re-attempts + delivers
    mockRouter.sendBriefingToOwner.mockResolvedValue({ sent: 1, failed: 0 });
    const r = await runPrometheusAlertPoll({ fetchAlerts: async () => [a] });
    expect(r).toMatchObject({ newlyFiring: 1, sent: true });
    expect(mockRouter.sendBriefingToOwner).toHaveBeenCalledTimes(2);
  });

  it("commits when at least one channel delivered (sent>=1), then dedupes", async () => {
    const a = alert("A", "warning");
    mockRouter.sendBriefingToOwner.mockResolvedValue({ sent: 1, failed: 0 });
    const r1 = await runPrometheusAlertPoll({ fetchAlerts: async () => [a] });
    expect(r1.sent).toBe(true);
    const r2 = await runPrometheusAlertPoll({ fetchAlerts: async () => [a] });
    expect(r2.sent).toBe(false); // committed → deduped
  });
});

describe("runPrometheusAlertPoll", () => {
  beforeEach(() => _resetAlertNotifierState());

  it("announces newly firing alerts once, then dedupes on the next tick", async () => {
    const a = alert(
      "SalonWhatsAppLoggedOut",
      "critical",
      { salon_id: "x" },
      "Salón x LOGGED OUT",
    );
    const send = vi.fn(async (_text: string) => {});
    const fetchAlerts = vi.fn(async () => [a]);

    const r1 = await runPrometheusAlertPoll({ fetchAlerts, send });
    expect(r1).toMatchObject({
      firing: 1,
      newlyFiring: 1,
      resolved: 0,
      sent: true,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toContain("Salón x LOGGED OUT");

    const r2 = await runPrometheusAlertPoll({ fetchAlerts, send });
    expect(r2).toMatchObject({ newlyFiring: 0, resolved: 0, sent: false });
    expect(send).toHaveBeenCalledTimes(1); // not re-sent
  });

  it("announces a resolution when the alert clears", async () => {
    const a = alert("A", "warning");
    const send = vi.fn(async (_text: string) => {});
    await runPrometheusAlertPoll({ fetchAlerts: async () => [a], send });
    const r = await runPrometheusAlertPoll({
      fetchAlerts: async () => [],
      send,
    });
    expect(r).toMatchObject({ resolved: 1, sent: true });
    expect(send.mock.calls[1]![0]).toContain("✅ 1 resolved:");
  });

  it("does NOT commit state when send fails → retries the same batch next tick", async () => {
    const a = alert("A", "critical");
    const failing = vi.fn(async () => {
      throw new Error("router down");
    });
    await expect(
      runPrometheusAlertPoll({ fetchAlerts: async () => [a], send: failing }),
    ).rejects.toThrow("router down");

    // state was not committed → next tick re-attempts the announcement
    const ok = vi.fn(async () => {});
    const r = await runPrometheusAlertPoll({
      fetchAlerts: async () => [a],
      send: ok,
    });
    expect(r).toMatchObject({ newlyFiring: 1, sent: true });
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("a fetch error never emits a false resolved (state untouched on outage)", async () => {
    const a = alert("A", "warning");
    const send = vi.fn(async (_text: string) => {});
    await runPrometheusAlertPoll({ fetchAlerts: async () => [a], send }); // A committed

    // transient Prometheus outage
    await expect(
      runPrometheusAlertPoll({
        fetchAlerts: async () => {
          throw new Error("prom down");
        },
        send,
      }),
    ).rejects.toThrow("prom down");

    // A still firing on recovery → no re-send, and crucially no "resolved"
    const r = await runPrometheusAlertPoll({
      fetchAlerts: async () => [a],
      send,
    });
    expect(r).toMatchObject({ newlyFiring: 0, resolved: 0, sent: false });
    expect(send).toHaveBeenCalledTimes(1); // only the original firing announce
  });
});
