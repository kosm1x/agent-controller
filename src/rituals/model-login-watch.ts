/**
 * Model-login expiry watch (2026-09-19).
 *
 * With INFERENCE_PRIMARY_PROVIDER=claude-sdk every model call authenticates
 * through the claude.ai login in ~/.claude/.credentials.json. That login ends
 * ~29 days after `/login`: the refresh POST then returns `invalid_grant`, the
 * CLI blanks `refreshToken` on disk, and every SDK call on the host fails
 * until the operator runs `claude /login` (outages 2026-07-17 and 2026-09-19 —
 * the second failed the 13:00 UTC PM rebalance). The file states the end date
 * (`refreshTokenExpiresAt`); nothing read it.
 *
 * Hourly: warn the operator inside the last 72 h, and when the login is
 * already dead. One message per state per 24 h (in-memory; a restart may
 * repeat one). Reads ONLY `refreshToken === ""` and `refreshTokenExpiresAt` —
 * token values are never logged or sent.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getRouter } from "../messaging/index.js";

const WARN_WINDOW_MS = 72 * 3_600_000;
const RENOTIFY_MS = 24 * 3_600_000;

export type LoginState =
  | { kind: "ok"; expiresAt: number }
  | { kind: "expiring"; expiresAt: number }
  | { kind: "dead" }
  /** No claude.ai login on disk, or a CLI that does not stamp the end date. */
  | { kind: "unknown" };

export function classifyLogin(creds: unknown, now: number): LoginState {
  const oauth = (creds as { claudeAiOauth?: Record<string, unknown> } | null)
    ?.claudeAiOauth;
  if (!oauth) return { kind: "unknown" };
  if (oauth.refreshToken === "") return { kind: "dead" };
  const expiresAt = oauth.refreshTokenExpiresAt;
  if (typeof expiresAt !== "number") return { kind: "unknown" };
  if (expiresAt <= now) return { kind: "dead" };
  return {
    kind: expiresAt - now <= WARN_WINDOW_MS ? "expiring" : "ok",
    expiresAt,
  };
}

export function formatLoginMessage(state: LoginState, now: number): string {
  if (state.kind === "dead") {
    return "🔴 Model login is DEAD — every Jarvis model call fails until you run `claude /login` on the VPS.";
  }
  if (state.kind === "expiring") {
    const hours = Math.floor((state.expiresAt - now) / 3_600_000);
    const when = new Date(state.expiresAt).toISOString().slice(0, 16);
    return `🟡 Model login expires in ${hours} h (${when.replace("T", " ")} UTC). Run \`claude /login\` on the VPS before then — after it, every Jarvis model call fails.`;
  }
  return "";
}

export interface LoginWatchDeps {
  readCreds?: () => Promise<unknown>;
  send?: (text: string) => Promise<void>;
  now?: () => number;
}

export interface LoginWatchSummary {
  state: LoginState["kind"];
  sent: boolean;
}

const lastNotified = new Map<LoginState["kind"], number>();

/** Test hook. */
export function _resetLoginWatchState(): void {
  lastNotified.clear();
}

/** A missing file reads as `{}` (→ `unknown`: the host may authenticate by
 *  token env instead) — not an hourly ritual failure. */
export async function readLoginFile(
  path = join(homedir(), ".claude", ".credentials.json"),
): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

async function defaultSend(text: string): Promise<void> {
  const router = getRouter();
  if (!router) {
    throw new Error("messaging router unavailable — cannot deliver warning");
  }
  // Same zero-delivery rule as the alert poller: nothing sent = throw, so the
  // throttle is not stamped and the next tick retries.
  const { sent, failed } = await router.sendBriefingToOwner(text, {
    raw: true,
  });
  if (sent === 0) {
    throw new Error(
      `login warning not delivered to any operator channel (failed=${failed})`,
    );
  }
}

export async function runModelLoginWatch(
  deps: LoginWatchDeps = {},
): Promise<LoginWatchSummary> {
  const now = (deps.now ?? Date.now)();
  const state = classifyLogin(await (deps.readCreds ?? readLoginFile)(), now);
  if (state.kind !== "dead" && state.kind !== "expiring") {
    lastNotified.clear();
    return { state: state.kind, sent: false };
  }
  const last = lastNotified.get(state.kind);
  if (last !== undefined && now - last < RENOTIFY_MS) {
    return { state: state.kind, sent: false };
  }
  await (deps.send ?? defaultSend)(formatLoginMessage(state, now));
  lastNotified.set(state.kind, now);
  return { state: state.kind, sent: true };
}
