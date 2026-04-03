/**
 * CISA KEV adapter — Known Exploited Vulnerabilities catalog.
 * No auth required. Polling: 6 hours.
 */

import type { CollectorAdapter, Signal } from "../types.js";
import { contentHash } from "../signal-store.js";

const FEED_URL =
  "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
const TIMEOUT_MS = 15_000;

interface CISAVuln {
  cveID: string;
  vendorProject: string;
  product: string;
  vulnerabilityName: string;
  dateAdded: string;
  shortDescription: string;
  requiredAction: string;
  dueDate: string;
  knownRansomwareCampaignUse: string;
}

interface CISAResponse {
  title: string;
  catalogVersion: string;
  dateReleased: string;
  count: number;
  vulnerabilities: CISAVuln[];
}

export const cisaKevAdapter: CollectorAdapter = {
  source: "cisa_kev",
  domain: "cyber",
  defaultInterval: 6 * 60 * 60_000,

  async collect(): Promise<Signal[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(FEED_URL, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return [];

      const data = (await res.json()) as CISAResponse;
      const signals: Signal[] = [];

      // Filter to recently added (last 7 days)
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      const recent = data.vulnerabilities.filter(
        (v) => new Date(v.dateAdded) >= weekAgo,
      );

      // Count metric (for delta engine)
      signals.push({
        source: "cisa_kev",
        domain: "cyber",
        signalType: "numeric",
        key: "new_vulns",
        valueNumeric: recent.length,
        metadata: { catalog_total: data.count },
      });

      // Individual CVEs
      for (const v of recent.slice(0, 10)) {
        signals.push({
          source: "cisa_kev",
          domain: "cyber",
          signalType: "alert",
          key: v.cveID,
          valueText: `${v.vendorProject} ${v.product}: ${v.vulnerabilityName}`,
          contentHash: contentHash(v.cveID),
          sourceTimestamp: `${v.dateAdded}T00:00:00Z`,
          metadata: {
            vendor: v.vendorProject,
            product: v.product,
            description: v.shortDescription?.slice(0, 300),
            action: v.requiredAction,
            due: v.dueDate,
            ransomware: v.knownRansomwareCampaignUse,
          },
        });
      }

      return signals;
    } catch {
      return [];
    } finally {
      clearTimeout(timeout);
    }
  },
};
