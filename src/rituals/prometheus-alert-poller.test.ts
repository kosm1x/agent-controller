/**
 * Prometheus alert notifier — pure diff/format + the runPoll state machine.
 * No network / router: fetch + send are injected.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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

function notifiedMapAt(
  notifiedAt: number,
  ...alerts: PromAlert[]
): Map<string, NotifiedAlert> {
  const m = new Map<string, NotifiedAlert>();
  for (const a of alerts) {
    const fp = alertFingerprint(a);
    m.set(fp, {
      fingerprint: fp,
      name: a.labels.alertname!,
      severity: a.labels.severity!,
      summary: a.annotations.summary!,
      notifiedAt,
    });
  }
  return m;
}

function notifiedMap(...alerts: PromAlert[]): Map<string, NotifiedAlert> {
  return notifiedMapAt(0, ...alerts);
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

describe("planAlertNotifications — re-alert cadence", () => {
  const SIX_H = 6 * 3_600_000;
  const T0 = 1_000_000_000_000;

  it("re-announces a still-firing CRITICAL once the interval elapses, resetting its clock", () => {
    const a = alert("SalonWhatsAppLoggedOut", "critical", { salon_id: "x" });
    const fp = alertFingerprint(a);

    // before the interval → no reminder, clock carried forward unchanged
    const early = planAlertNotifications([a], notifiedMapAt(T0, a), {
      now: T0 + SIX_H - 1,
      reNotifyMs: SIX_H,
    });
    expect(early.reminders).toEqual([]);
    expect(early.newlyFiring).toEqual([]);
    expect(early.nextNotified.get(fp)!.notifiedAt).toBe(T0);

    // at the interval → reminder fires, clock reset to now
    const due = planAlertNotifications([a], notifiedMapAt(T0, a), {
      now: T0 + SIX_H,
      reNotifyMs: SIX_H,
    });
    expect(due.reminders.map((n) => n.name)).toEqual([
      "SalonWhatsAppLoggedOut",
    ]);
    expect(due.newlyFiring).toEqual([]);
    expect(due.nextNotified.get(fp)!.notifiedAt).toBe(T0 + SIX_H);
  });

  it("does NOT re-announce a still-firing WARNING (only criticals re-nag)", () => {
    const a = alert("SalonWhatsAppDisconnected", "warning", { salon_id: "x" });
    const plan = planAlertNotifications([a], notifiedMapAt(T0, a), {
      now: T0 + 100 * SIX_H, // way past any interval
      reNotifyMs: SIX_H,
    });
    expect(plan.reminders).toEqual([]);
    // a warning's clock is never reset — it stays notify-once
    expect(plan.nextNotified.get(alertFingerprint(a))!.notifiedAt).toBe(T0);
  });

  it("reNotifyMs=0 disables reminders entirely (pure notify-once)", () => {
    const a = alert("Crit", "critical");
    const plan = planAlertNotifications([a], notifiedMapAt(T0, a), {
      now: T0 + 100 * SIX_H,
      reNotifyMs: 0,
    });
    expect(plan.reminders).toEqual([]);
  });

  it("does not re-fire every tick — the clock only advances on an actual reminder", () => {
    const a = alert("Crit", "critical");
    const fp = alertFingerprint(a);
    // tick at T0+6h → reminder, clock → T0+6h
    const p1 = planAlertNotifications([a], notifiedMapAt(T0, a), {
      now: T0 + SIX_H,
      reNotifyMs: SIX_H,
    });
    expect(p1.reminders.length).toBe(1);
    // a minute later, feeding p1's committed map → not due again
    const p2 = planAlertNotifications([a], p1.nextNotified, {
      now: T0 + SIX_H + 60_000,
      reNotifyMs: SIX_H,
    });
    expect(p2.reminders).toEqual([]);
    expect(p2.nextNotified.get(fp)!.notifiedAt).toBe(T0 + SIX_H);
  });
});

describe("formatAlertMessage", () => {
  const fire = (name: string, sev: string, summary: string): NotifiedAlert => ({
    fingerprint: name,
    name,
    severity: sev,
    summary,
    notifiedAt: 0,
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

describe("formatAlertMessage — reminder section", () => {
  const fire = (name: string, sev: string, summary: string): NotifiedAlert => ({
    fingerprint: name,
    name,
    severity: sev,
    summary,
    notifiedAt: 0,
  });

  it("renders a reminder section distinctly from newly-firing", () => {
    const msg = formatAlertMessage(
      [],
      [],
      [fire("SalonWhatsAppLoggedOut", "critical", "Salón x LOGGED OUT")],
    );
    expect(msg).toContain("⏰ 1 still firing (reminder):");
    expect(msg).toContain("🔴 Salón x LOGGED OUT");
    expect(msg).not.toContain("🚨"); // not mislabeled as newly-firing
  });
});

describe("runPrometheusAlertPoll — re-alert cadence (env + injected clock)", () => {
  const OLD_ENV = process.env.ALERT_RENOTIFY_HOURS;
  beforeEach(() => _resetAlertNotifierState());
  afterEach(() => {
    if (OLD_ENV == null) delete process.env.ALERT_RENOTIFY_HOURS;
    else process.env.ALERT_RENOTIFY_HOURS = OLD_ENV;
  });

  it("re-sends a still-firing critical after ALERT_RENOTIFY_HOURS, as a reminder", async () => {
    process.env.ALERT_RENOTIFY_HOURS = "6";
    const a = alert(
      "SalonWhatsAppLoggedOut",
      "critical",
      { salon_id: "x" },
      "Salón x LOGGED OUT",
    );
    const send = vi.fn(async (_t: string) => {});
    const T0 = 1_000_000_000_000;
    let now = T0;

    const r1 = await runPrometheusAlertPoll({
      fetchAlerts: async () => [a],
      send,
      now: () => now,
    });
    expect(r1).toMatchObject({ newlyFiring: 1, reminders: 0, sent: true });

    now = T0 + 2 * 60_000; // 2 min later → steady, no re-send
    const r2 = await runPrometheusAlertPoll({
      fetchAlerts: async () => [a],
      send,
      now: () => now,
    });
    expect(r2).toMatchObject({ reminders: 0, sent: false });

    now = T0 + 6 * 3_600_000; // 6h later → reminder
    const r3 = await runPrometheusAlertPoll({
      fetchAlerts: async () => [a],
      send,
      now: () => now,
    });
    expect(r3).toMatchObject({ reminders: 1, sent: true });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0]).toContain("still firing (reminder)");
    expect(send.mock.calls[1]![0]).toContain("Salón x LOGGED OUT");
  });

  it("ALERT_RENOTIFY_HOURS=0 keeps pure notify-once across a long gap", async () => {
    process.env.ALERT_RENOTIFY_HOURS = "0";
    const a = alert("Crit", "critical");
    const send = vi.fn(async (_t: string) => {});
    let now = 1_000_000_000_000;

    await runPrometheusAlertPoll({
      fetchAlerts: async () => [a],
      send,
      now: () => now,
    });
    now += 100 * 3_600_000; // 100h later
    const r = await runPrometheusAlertPoll({
      fetchAlerts: async () => [a],
      send,
      now: () => now,
    });
    expect(r.sent).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a non-numeric ALERT_RENOTIFY_HOURS falls back to the 6h default (does not silently disable)", async () => {
    process.env.ALERT_RENOTIFY_HOURS = "not-a-number";
    const a = alert("Crit", "critical", {}, "crit fires");
    const send = vi.fn(async (_t: string) => {});
    const T0 = 1_000_000_000_000;
    let now = T0;

    await runPrometheusAlertPoll({
      fetchAlerts: async () => [a],
      send,
      now: () => now,
    });
    now = T0 + 6 * 3_600_000; // 6h → default interval still re-nags
    const r = await runPrometheusAlertPoll({
      fetchAlerts: async () => [a],
      send,
      now: () => now,
    });
    expect(r).toMatchObject({ reminders: 1, sent: true });
  });
});
