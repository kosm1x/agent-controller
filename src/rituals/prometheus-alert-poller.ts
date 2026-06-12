/**
 * Prometheus alert notifier.
 *
 * mc-prometheus EVALUATES alert rules but has no Alertmanager and no running
 * Grafana, so firing alerts only light the Prometheus UI — nobody gets paged.
 * This ritual closes that gap: every 2 min it GETs /api/v1/alerts and pushes
 * NEWLY firing (and newly resolved) alerts to the operator's owner channels
 * (WhatsApp / Telegram / owner-email if configured). It covers ALL mc alert
 * rules (vps-system, mission-control, hindsight, salones-wa), not just one.
 * Delivery to ZERO channels is treated as a failure (retried), never a
 * silent-commit (qa-C1).
 *
 * Notify-once semantics (like Alertmanager): an alert is announced when it
 * starts firing and once more when it resolves; steady-state firing is NOT
 * re-sent every tick. State is in-memory and resets on restart — a still-firing
 * alert re-announces once after a restart, which is acceptable (and never emits
 * a false "resolved", because a failed fetch leaves the state untouched).
 *
 * Re-alert cadence (2026-06-12): pure notify-once let a single missed ping become
 * a multi-day silent outage (the salones-wa 525640501088 logout — one 23:00-MX
 * notification, then ~22h of silence). So a still-firing CRITICAL alert is
 * re-announced every ALERT_RENOTIFY_HOURS (default 6h) as a reminder, resetting
 * its per-fingerprint clock on each send. Only `critical` re-nags — warnings stay
 * notify-once to keep the channel from becoming noise. Set ALERT_RENOTIFY_HOURS=0
 * to disable reminders (back to pure notify-once).
 *
 * Env:
 *   ALERT_NOTIFY_ENABLED   gate (default off; set "true" to enable)
 *   ALERT_NOTIFY_PROM_URL  Prometheus base URL (default http://127.0.0.1:9090)
 *   ALERT_RENOTIFY_HOURS   re-alert interval for still-firing criticals (default 6; 0 disables)
 *
 * Delivery reuses router.broadcastToAll → WHATSAPP_OWNER_JID /
 * TELEGRAM_OWNER_CHAT_ID (whichever are configured). See queue: salones-wa
 * alert-delivery follow-up (2026-06-06).
 */
import { getRouter } from "../messaging/index.js";

const DEFAULT_PROM_URL = "http://127.0.0.1:9090";
const QUERY_TIMEOUT_MS = 10_000;

/** Default re-alert interval (hours) for still-firing CRITICAL alerts. */
const DEFAULT_RENOTIFY_HOURS = 6;
/** Severities that re-nag past the interval; everything else is notify-once. */
const RENOTIFY_SEVERITIES = new Set(["critical"]);

/**
 * Env → re-alert interval in ms. Unset → default 6h; an explicit `<= 0` disables
 * reminders (pure notify-once); a non-numeric typo falls back to the default
 * rather than silently disabling (a silently-off reminder loop is the exact
 * failure class this feature exists to prevent).
 */
function resolveReNotifyMs(): number {
  const raw = process.env.ALERT_RENOTIFY_HOURS;
  const hours =
    raw == null || raw.trim() === "" ? DEFAULT_RENOTIFY_HOURS : Number(raw);
  const eff = Number.isFinite(hours) ? hours : DEFAULT_RENOTIFY_HOURS;
  return eff > 0 ? eff * 3_600_000 : 0;
}

export interface PromAlert {
  labels: Record<string, string>;
  annotations: Record<string, string>;
  state: "firing" | "pending" | "inactive";
  activeAt?: string;
  value?: string;
}

interface AlertsResponse {
  status: "success" | "error";
  data?: { alerts: PromAlert[] };
  error?: string;
}

export interface NotifiedAlert {
  fingerprint: string;
  name: string;
  severity: string;
  summary: string;
  /**
   * Epoch ms when this alert was last ANNOUNCED (initial firing or a reminder).
   * Drives the re-alert cadence: a still-firing critical re-nags once
   * `now - notifiedAt >= reNotifyMs`, and each send resets this to `now`.
   */
  notifiedAt: number;
}

const SEVERITY_EMOJI: Record<string, string> = {
  critical: "🔴",
  warning: "🟠",
  info: "🔵",
};

/** Stable identity for an alert instance = alertname + its sorted label set. */
export function alertFingerprint(alert: PromAlert): string {
  const labels = alert.labels ?? {};
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(",");
}

function toNotified(alert: PromAlert, now: number): NotifiedAlert {
  const labels = alert.labels ?? {};
  const ann = alert.annotations ?? {};
  return {
    fingerprint: alertFingerprint(alert),
    name: labels.alertname ?? "alert",
    severity: labels.severity ?? "none",
    summary: ann.summary ?? ann.description ?? labels.alertname ?? "alert",
    notifiedAt: now,
  };
}

export interface AlertPlan {
  /** Alerts that just started firing (announce). */
  newlyFiring: NotifiedAlert[];
  /** Still-firing CRITICAL alerts past the re-alert interval (re-announce). */
  reminders: NotifiedAlert[];
  /** Alerts that were firing last tick and no longer are (announce resolved). */
  resolved: NotifiedAlert[];
  /** The announced-set to COMMIT after a successful send (= current firing). */
  nextNotified: Map<string, NotifiedAlert>;
}

export interface PlanOptions {
  /** Current epoch ms (injected for tests). Defaults to `Date.now()`. */
  now?: number;
  /** Re-alert interval in ms for still-firing criticals. `0` disables reminders. */
  reNotifyMs?: number;
}

/**
 * Pure: diff the currently-firing alerts against the already-announced map.
 * Returns what to announce now — newly-firing, plus CRITICAL `reminders` whose
 * per-fingerprint clock has passed `reNotifyMs` — and the next announced-map to
 * commit ONLY after a successful send. Does not mutate `notified`.
 *
 * `nextNotified` is the current firing set: `notifiedAt = now` for anything
 * announced this tick (new or reminder), and the prior `notifiedAt` carried
 * forward for steady alerts — so reminders fire on a fixed cadence, not every
 * tick, and resolved alerts drop out.
 */
export function planAlertNotifications(
  firing: PromAlert[],
  notified: Map<string, NotifiedAlert>,
  opts: PlanOptions = {},
): AlertPlan {
  const now = opts.now ?? Date.now();
  const reNotifyMs = opts.reNotifyMs ?? 0;

  const newlyFiring: NotifiedAlert[] = [];
  const reminders: NotifiedAlert[] = [];
  const nextNotified = new Map<string, NotifiedAlert>();

  for (const a of firing) {
    const fresh = toNotified(a, now);
    const prior = notified.get(fresh.fingerprint);
    if (!prior) {
      newlyFiring.push(fresh);
      nextNotified.set(fresh.fingerprint, fresh); // notifiedAt = now
      continue;
    }
    const due =
      reNotifyMs > 0 &&
      RENOTIFY_SEVERITIES.has(fresh.severity) &&
      now - prior.notifiedAt >= reNotifyMs;
    if (due) {
      reminders.push(fresh);
      nextNotified.set(fresh.fingerprint, fresh); // reset the clock to now
    } else {
      // steady: keep the ORIGINAL clock so the cadence is fixed, not per-tick
      nextNotified.set(fresh.fingerprint, {
        ...fresh,
        notifiedAt: prior.notifiedAt,
      });
    }
  }

  const resolved = [...notified.values()].filter(
    (n) => !nextNotified.has(n.fingerprint),
  );
  return { newlyFiring, reminders, resolved, nextNotified };
}

/** Max alert lines rendered per section before collapsing to "…and N more". */
const MAX_LINES_PER_SECTION = 20;

/** Compose the operator-facing message for a batch of firing + resolved alerts.
 * Caps each section (qa-N1) so a correlated outage firing many instance-level
 * alerts at once doesn't produce a 50-line message that's itself spam-shaped. */
export function formatAlertMessage(
  newlyFiring: NotifiedAlert[],
  resolved: NotifiedAlert[],
  reminders: NotifiedAlert[] = [],
): string {
  const lines: string[] = [];
  if (newlyFiring.length > 0) {
    lines.push(`🚨 ${newlyFiring.length} alert(s) firing:`);
    for (const a of newlyFiring.slice(0, MAX_LINES_PER_SECTION)) {
      lines.push(`${SEVERITY_EMOJI[a.severity] ?? "⚪"} ${a.summary}`);
    }
    if (newlyFiring.length > MAX_LINES_PER_SECTION) {
      lines.push(`…and ${newlyFiring.length - MAX_LINES_PER_SECTION} more`);
    }
  }
  if (reminders.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`⏰ ${reminders.length} still firing (reminder):`);
    for (const a of reminders.slice(0, MAX_LINES_PER_SECTION)) {
      lines.push(`${SEVERITY_EMOJI[a.severity] ?? "⚪"} ${a.summary}`);
    }
    if (reminders.length > MAX_LINES_PER_SECTION) {
      lines.push(`…and ${reminders.length - MAX_LINES_PER_SECTION} more`);
    }
  }
  if (resolved.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`✅ ${resolved.length} resolved:`);
    for (const a of resolved.slice(0, MAX_LINES_PER_SECTION)) {
      lines.push(`• ${a.name}`);
    }
    if (resolved.length > MAX_LINES_PER_SECTION) {
      lines.push(`…and ${resolved.length - MAX_LINES_PER_SECTION} more`);
    }
  }
  return lines.join("\n");
}

export interface AlertPollDeps {
  /** Returns the currently-FIRING alerts. Injected in tests. */
  fetchAlerts?: () => Promise<PromAlert[]>;
  /** Delivers one message to the operator. Injected in tests. */
  send?: (text: string) => Promise<void>;
  /** Current-time source (injected in tests for the re-alert clock). */
  now?: () => number;
}

export interface AlertPollSummary {
  firing: number;
  newlyFiring: number;
  reminders: number;
  resolved: number;
  sent: boolean;
}

// In-memory announced-set. Resets on restart (acceptable — see module doc).
let notifiedState = new Map<string, NotifiedAlert>();

/** Test helper: clear the in-memory announced-set between cases. */
export function _resetAlertNotifierState(): void {
  notifiedState = new Map();
}

async function defaultFetchAlerts(): Promise<PromAlert[]> {
  const baseUrl = process.env.ALERT_NOTIFY_PROM_URL ?? DEFAULT_PROM_URL;
  const resp = await fetch(`${baseUrl}/api/v1/alerts`, {
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`Prometheus HTTP ${resp.status} for /api/v1/alerts`);
  }
  const body = (await resp.json()) as AlertsResponse;
  if (body.status !== "success") {
    throw new Error(`Prometheus alerts error: ${body.error ?? "unknown"}`);
  }
  return (body.data?.alerts ?? []).filter((a) => a.state === "firing");
}

async function defaultSend(text: string): Promise<void> {
  const router = getRouter();
  if (!router) {
    throw new Error("messaging router unavailable — cannot deliver alert");
  }
  // qa-C1: deliver to the operator's owner channels (WhatsApp / Telegram /
  // owner-email if configured) and THROW on zero delivery. broadcastToAll
  // resolves "successfully" even when no owner address is configured (it sends
  // to nobody) — using that would commit the announced-set and lose the alert
  // forever. sendBriefingToOwner returns a {sent,failed} tally; sent===0 means
  // nothing went out, so we throw → state is not committed → retried next tick.
  const { sent, failed } = await router.sendBriefingToOwner(text);
  if (sent === 0) {
    throw new Error(
      `alert not delivered to any operator channel (failed=${failed}) — check WHATSAPP_OWNER_JID / TELEGRAM_OWNER_CHAT_ID`,
    );
  }
}

/**
 * One poll cycle: fetch firing alerts, announce newly-firing + newly-resolved,
 * and commit the announced-set ONLY after a successful send. A fetch error
 * throws BEFORE any state change (so a transient Prometheus outage never emits
 * a false "resolved"); a send error throws BEFORE the commit (so the same
 * batch is retried next tick rather than silently dropped).
 */
export async function runPrometheusAlertPoll(
  deps: AlertPollDeps = {},
): Promise<AlertPollSummary> {
  const fetchAlerts = deps.fetchAlerts ?? defaultFetchAlerts;
  const send = deps.send ?? defaultSend;
  const now = deps.now?.() ?? Date.now();
  const reNotifyMs = resolveReNotifyMs();

  const firing = await fetchAlerts();
  const plan = planAlertNotifications(firing, notifiedState, {
    now,
    reNotifyMs,
  });
  const hasChanges =
    plan.newlyFiring.length > 0 ||
    plan.reminders.length > 0 ||
    plan.resolved.length > 0;

  if (hasChanges) {
    await send(
      formatAlertMessage(plan.newlyFiring, plan.resolved, plan.reminders),
    );
  }
  // Reached only if send did not throw → safe to commit the announced-set.
  notifiedState = plan.nextNotified;

  return {
    firing: firing.length,
    newlyFiring: plan.newlyFiring.length,
    reminders: plan.reminders.length,
    resolved: plan.resolved.length,
    sent: hasChanges,
  };
}
