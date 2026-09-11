/**
 * email-verify — MX stage.
 *
 * Improvements over upstream: RFC 7505 null MX ("." at preference 0 means
 * the domain explicitly refuses mail) and RFC 5321 §5.1 implicit MX (no MX
 * records → the domain's own A/AAAA record is the mail host).
 */

import { promises as dns } from "node:dns";

export interface MxHost {
  readonly exchange: string;
  readonly priority: number;
}

export type MxLookup = (domain: string) => Promise<MxHost[]>;
/** Address-record probe used for RFC 5321 implicit MX; true when the name resolves. */
export type HostExists = (domain: string) => Promise<boolean>;

export interface MxResult {
  /** Hosts sorted by preference (lowest first). Empty when the domain cannot receive mail. */
  readonly hosts: readonly MxHost[];
  /** Why there are no hosts; null when hosts is non-empty. */
  readonly reason: "null_mx" | "no_records" | "nxdomain" | "dns_error" | null;
  readonly implicit: boolean;
}

function code(err: unknown): string {
  return (err as { code?: string })?.code ?? "";
}

/** Default resolver: real DNS via node:dns/promises. Tests inject their own. */
export const systemMxLookup: MxLookup = async (domain) => {
  const records = await dns.resolveMx(domain);
  return records.map((r) => ({ exchange: r.exchange, priority: r.priority }));
};

export const systemHostExists: HostExists = async (domain) => {
  try {
    await dns.lookup(domain);
    return true;
  } catch {
    return false;
  }
};

export async function lookupMx(
  domain: string,
  resolve: MxLookup = systemMxLookup,
  hostExists: HostExists = systemHostExists,
): Promise<MxResult> {
  let records: MxHost[];
  try {
    records = await resolve(domain);
  } catch (err) {
    const c = code(err);
    if (c === "ENOTFOUND") return { hosts: [], reason: "nxdomain", implicit: false };
    if (c === "ENODATA" || c === "ENOTIMP") {
      records = [];
    } else {
      return { hosts: [], reason: "dns_error", implicit: false };
    }
  }

  const cleaned = records
    .map((r) => ({ exchange: r.exchange.replace(/\.$/, "").toLowerCase(), priority: r.priority }))
    .filter((r) => r.exchange.length > 0 || r.priority === 0);

  // RFC 7505: a single MX of "." (empty after trailing-dot strip) at pref 0.
  if (cleaned.length === 1 && cleaned[0].exchange === "" && cleaned[0].priority === 0) {
    return { hosts: [], reason: "null_mx", implicit: false };
  }
  const hosts = cleaned.filter((r) => r.exchange.length > 0).sort((a, b) => a.priority - b.priority);
  if (hosts.length > 0) return { hosts, reason: null, implicit: false };

  // RFC 5321 §5.1 implicit MX: fall back to the domain's own address record.
  if (await hostExists(domain)) return { hosts: [{ exchange: domain, priority: 0 }], reason: null, implicit: true };
  return { hosts: [], reason: "no_records", implicit: false };
}
