/**
 * Proactive X-health probe — in-process node-cron (mirrors the register/stop/tick
 * trio of `lib/self-healing/triage-cron.ts`). Ships DORMANT: registers ONLY when
 * `X_PROBE_ENABLED=true`, armed via a systemd drop-in like the V8.2 producer.
 *
 * Each tick probes EVERY configured account, records `mc_x_backend_healthy`
 * {account,backend}, and notifies the operator ON TRANSITION — healthy→unhealthy
 * (cookies expiring, act now) and unhealthy→healthy (recovered). Edge-triggered
 * per account+backend, so a persistently-stale account pings once, not daily.
 */

import cron, { type ScheduledTask } from "node-cron";
import { RITUALS_TIMEZONE } from "../../rituals/config.js";
import { recordXBackendHealth } from "../../observability/prometheus.js";
import { probeAllAccounts } from "./index.js";
import { getXProbeCron } from "./config.js";
import type { RouterProbe } from "./types.js";
import { errMsg } from "../err-msg.js";

export interface XProbeLog {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

const NOOP_LOG: XProbeLog = { info: () => {}, warn: () => {} };

export interface AccountProbe {
  account: string;
  probe: RouterProbe;
}

export interface XProbeTickDeps {
  probeAll: () => Promise<AccountProbe[]>;
  record: (account: string, backend: string, healthy: boolean) => void;
  notify: (text: string) => Promise<void>;
  /** Previous health per `account|backend`; mutated in place to track transitions. */
  state: Map<string, boolean>;
  log: XProbeLog;
}

/**
 * One probe tick. Pure of cron/network wiring (deps injected) so the
 * transition-notify logic is unit-testable. Never throws.
 */
export async function runXProbeTick(deps: XProbeTickDeps): Promise<void> {
  const { probeAll, record, notify, state, log } = deps;
  try {
    const accounts = await probeAll();
    if (accounts.length === 0) {
      log.info("[x-probe] no X account configured — skipping");
      return;
    }
    for (const { account, probe } of accounts) {
      for (const r of probe.results) {
        record(account, r.backend, r.ok);
        const key = `${account}|${r.backend}`;
        const prev = state.get(key);
        state.set(key, r.ok);
        if (prev === undefined || prev === r.ok) continue; // first sight / no change

        if (!r.ok) {
          const why = r.authExpired
            ? "auth expired — refresh cookies"
            : r.detail;
          await notify(
            `🔴 X "${account}" backend "${r.backend}" UNHEALTHY (${why}). ` +
              `Refresh: log into x.com → copy auth_token + ct0 → update ` +
              `X_AUTH_TOKEN__${account} / X_CT0__${account}.`,
          ).catch((e) => log.warn(`[x-probe] notify failed: ${errMsg(e)}`));
        } else {
          await notify(
            `🟢 X "${account}" backend "${r.backend}" recovered (${r.detail}).`,
          ).catch((e) => log.warn(`[x-probe] notify failed: ${errMsg(e)}`));
        }
      }
    }
  } catch (err) {
    log.warn(`[x-probe] tick failed (non-fatal): ${errMsg(err)}`);
  }
}

let scheduledJob: ScheduledTask | null = null;
const liveState = new Map<string, boolean>();

async function defaultNotify(text: string): Promise<void> {
  const { getRouter } = await import("../../messaging/index.js");
  const router = getRouter();
  if (!router) throw new Error("messaging router unavailable");
  const { sent, failed } = await router.sendBriefingToOwner(text);
  if (sent === 0) {
    throw new Error(
      `X probe alert reached no operator channel (failed=${failed})`,
    );
  }
}

function tickWithRealDeps(log: XProbeLog): Promise<void> {
  return runXProbeTick({
    probeAll: probeAllAccounts,
    record: recordXBackendHealth,
    notify: defaultNotify,
    state: liveState,
    log,
  });
}

/** Register the probe cron (idempotent — stops any prior job first). */
export function registerXProbeCron(log: XProbeLog = NOOP_LOG): boolean {
  stopXProbeCron();
  const schedule = getXProbeCron();
  scheduledJob = cron.schedule(schedule, () => void tickWithRealDeps(log), {
    timezone: RITUALS_TIMEZONE,
  });
  log.info(`registered X probe cron (${schedule}, ${RITUALS_TIMEZONE})`);
  return true;
}

export function stopXProbeCron(): void {
  if (scheduledJob) {
    scheduledJob.stop();
    scheduledJob = null;
  }
}
