/**
 * email-verify — provider detection + per-provider probe rules.
 *
 * Provider is decided by the MX host suffix (ports the Rust `mx::is_*`
 * predicates and `rules.json`). The rules only tune the probe; they never
 * fabricate a result.
 */

export type Provider =
  | "gmail"
  | "google_workspace"
  | "microsoft_consumer"
  | "microsoft_365"
  | "yahoo"
  | "proofpoint"
  | "mimecast"
  | "antispamcloud"
  | "other";

export interface ProviderRules {
  readonly provider: Provider;
  /**
   * Skip the random-address catch-all probe. Big consumer providers reject
   * unknown mailboxes reliably, so the extra RCPT TO buys nothing and
   * costs one more "unknown user" strike against our IP.
   */
  readonly skipCatchAll: boolean;
  /** Per-command timeout floor in ms (some hosts answer RCPT TO in ~30 s). */
  readonly minTimeoutMs: number;
  /** Human note surfaced in the result when the provider limits what SMTP can reveal. */
  readonly note: string | null;
}

const CONSUMER_GOOGLE = new Set(["gmail.com", "googlemail.com"]);
const CONSUMER_YAHOO_SUFFIXES = ["yahoo.", "ymail.com", "rocketmail.com", "aol.com"];

function endsWith(host: string, suffix: string): boolean {
  return host.endsWith(suffix) || host.endsWith(`${suffix}.`);
}

export function detectProvider(mxHost: string, domain: string): Provider {
  const host = mxHost.toLowerCase();
  const dom = domain.toLowerCase();
  if (endsWith(host, ".olc.protection.outlook.com")) return "microsoft_consumer";
  if (endsWith(host, ".protection.outlook.com")) return "microsoft_365";
  if (endsWith(host, ".google.com") || endsWith(host, ".googlemail.com")) {
    return CONSUMER_GOOGLE.has(dom) ? "gmail" : "google_workspace";
  }
  if (endsWith(host, ".yahoodns.net")) return "yahoo";
  if (endsWith(host, ".pphosted.com") || endsWith(host, "ppe-hosted.com")) return "proofpoint";
  if (endsWith(host, ".mimecast.com")) return "mimecast";
  if (endsWith(host, ".antispamcloud.com")) return "antispamcloud";
  return "other";
}

export function rulesFor(mxHost: string, domain: string): ProviderRules {
  const provider = detectProvider(mxHost, domain);
  const dom = domain.toLowerCase();
  switch (provider) {
    case "gmail":
      return { provider, skipCatchAll: true, minTimeoutMs: 0, note: null };
    case "microsoft_consumer":
      // Live probe 2026-09-11: hotmail.com answers "550 5.5.0 mailbox unavailable" for
      // unknown users, so SMTP is trustworthy here; only the catch-all probe is wasted.
      return { provider, skipCatchAll: true, minTimeoutMs: 0, note: null };
    case "yahoo":
      return {
        provider,
        skipCatchAll: CONSUMER_YAHOO_SUFFIXES.some((s) => dom.startsWith(s) || dom === s),
        minTimeoutMs: 0,
        note: "Yahoo answers unknown users with '554 delivery error: dd This user doesn't have a yahoo.com account'; a 4xx here is throttling, re-run later",
      };
    case "antispamcloud":
      return { provider, skipCatchAll: true, minTimeoutMs: 45_000, note: null };
    default:
      return { provider, skipCatchAll: false, minTimeoutMs: 0, note: null };
  }
}
