/**
 * Alert router — evaluates deltas against thresholds, assigns tiers,
 * applies cross-domain correlation, cooldown decay, and content-hash dedup.
 *
 * Tiers:
 *   FLASH    — critical delta OR cross-domain correlation (immediate Telegram + email)
 *   PRIORITY — high delta OR 3+ moderate in same domain within 1h (Telegram)
 *   ROUTINE  — moderate deltas, trends (digest only)
 */

import { getDatabase, writeWithRetry } from "../db/index.js";
import type { Delta } from "./types.js";
import { contentHash } from "./signal-store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AlertTier = "FLASH" | "PRIORITY" | "ROUTINE";

export interface AlertCandidate {
  tier: AlertTier;
  domain: string;
  title: string;
  body: string;
  signalIds: number[];
  contentHash: string;
}

export interface AlertRow {
  id: number;
  tier: string;
  domain: string;
  title: string;
  body: string;
  signals_json: string;
  delivered_via: string | null;
  content_hash: string | null;
  cooldown_until: string | null;
  created_at: string;
  delivered_at: string | null;
}

// ---------------------------------------------------------------------------
// Cross-domain correlation rules
// ---------------------------------------------------------------------------

const CROSS_DOMAIN_FLASH: Array<[string, string]> = [
  ["financial", "geopolitical"],
  ["cyber", "infrastructure"],
  ["weather", "financial"],
  ["health", "financial"],
];

function checkCrossDomainEscalation(deltas: Delta[]): Set<string> {
  const criticalDomains = new Set<string>();
  const highDomains = new Set<string>();

  for (const d of deltas) {
    const domain = domainForSource(d.source);
    if (d.severity === "critical") criticalDomains.add(domain);
    if (d.severity === "high") highDomains.add(domain);
  }

  const escalatedDomains = new Set<string>();
  for (const [a, b] of CROSS_DOMAIN_FLASH) {
    if (
      criticalDomains.has(a) &&
      (criticalDomains.has(b) || highDomains.has(b))
    ) {
      escalatedDomains.add(a);
      escalatedDomains.add(b);
    }
    if (
      criticalDomains.has(b) &&
      (criticalDomains.has(a) || highDomains.has(a))
    ) {
      escalatedDomains.add(a);
      escalatedDomains.add(b);
    }
  }

  return escalatedDomains;
}

function domainForSource(source: string): string {
  const map: Record<string, string> = {
    usgs: "weather",
    nws: "weather",
    gdelt: "geopolitical",
    frankfurter: "financial",
    cisa_kev: "cyber",
    coingecko: "financial",
    treasury: "financial",
    google_news: "news",
    finnhub: "financial",
    nvd: "cyber",
    cloudflare: "infrastructure",
    ioda: "infrastructure",
    who: "health",
  };
  return map[source] ?? "unknown";
}

// ---------------------------------------------------------------------------
// Evaluate deltas → alert candidates
// ---------------------------------------------------------------------------

export function evaluateDeltas(deltas: Delta[]): AlertCandidate[] {
  if (deltas.length === 0) return [];

  const candidates: AlertCandidate[] = [];
  const escalatedDomains = checkCrossDomainEscalation(deltas);

  // Group moderate deltas by domain for batch escalation
  const moderateByDomain = new Map<string, Delta[]>();

  for (const d of deltas) {
    const domain = domainForSource(d.source);
    const hash = contentHash(`${d.source}:${d.key}:${d.severity}`);

    if (d.severity === "critical" || escalatedDomains.has(domain)) {
      candidates.push({
        tier: "FLASH",
        domain,
        title: `🔴 ${d.source}/${d.key}: ${formatChange(d)}`,
        body: `${d.key} changed from ${d.previous ?? "N/A"} to ${d.current} (${d.severity}, ratio ${d.changeRatio}x)`,
        signalIds: [],
        contentHash: hash,
      });
    } else if (d.severity === "high") {
      candidates.push({
        tier: "PRIORITY",
        domain,
        title: `🟠 ${d.source}/${d.key}: ${formatChange(d)}`,
        body: `${d.key} changed from ${d.previous ?? "N/A"} to ${d.current} (${d.severity}, ratio ${d.changeRatio}x)`,
        signalIds: [],
        contentHash: hash,
      });
    } else if (d.severity === "moderate") {
      const group = moderateByDomain.get(domain) ?? [];
      group.push(d);
      moderateByDomain.set(domain, group);
    }
  }

  // 3+ moderate in same domain → escalate to PRIORITY
  for (const [domain, group] of moderateByDomain) {
    if (group.length >= 3) {
      const hash = contentHash(
        `batch:${domain}:${group.map((d) => d.key).join(",")}`,
      );
      candidates.push({
        tier: "PRIORITY",
        domain,
        title: `🟠 ${domain}: ${group.length} moderate signals`,
        body: group
          .map((d) => `  ${d.source}/${d.key}: ${formatChange(d)}`)
          .join("\n"),
        signalIds: [],
        contentHash: hash,
      });
    } else {
      // Individual ROUTINE alerts
      for (const d of group) {
        candidates.push({
          tier: "ROUTINE",
          domain,
          title: `🟡 ${d.source}/${d.key}: ${formatChange(d)}`,
          body: `${d.key}: ${d.previous ?? "N/A"} → ${d.current}`,
          signalIds: [],
          contentHash: contentHash(`${d.source}:${d.key}:${d.severity}`),
        });
      }
    }
  }

  return candidates;
}

function formatChange(d: Delta): string {
  if (d.previous === null) return `${d.current} (first observation)`;
  const pct =
    d.previous !== 0
      ? ((d.current - d.previous) / Math.abs(d.previous)) * 100
      : 0;
  const arrow = pct > 0 ? "↑" : pct < 0 ? "↓" : "→";
  return `${d.previous} ${arrow} ${d.current} (${pct > 0 ? "+" : ""}${pct.toFixed(1)}%)`;
}

// ---------------------------------------------------------------------------
// Dedup + cooldown
// ---------------------------------------------------------------------------

const DEDUP_WINDOW_HOURS = 4;
const COOLDOWN_HOURS = [0, 4, 8, 24]; // 1st immediate, 2nd +4h, 3rd +8h, 4th+ +24h

export function shouldSuppress(candidate: AlertCandidate): boolean {
  const db = getDatabase();

  // Check content-hash dedup window
  const recent = db
    .prepare(
      `SELECT id, cooldown_until FROM signal_alerts
       WHERE content_hash = ? AND created_at >= datetime('now', '-' || ? || ' hours')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(candidate.contentHash, DEDUP_WINDOW_HOURS) as
    | { id: number; cooldown_until: string | null }
    | undefined;

  if (!recent) return false;

  // Check cooldown
  if (recent.cooldown_until) {
    const cooldownEnd = new Date(recent.cooldown_until);
    if (new Date() < cooldownEnd) return true;
  }

  return true; // Within dedup window
}

export function createAlert(candidate: AlertCandidate): number {
  const db = getDatabase();

  // Count previous alerts with same hash (for cooldown escalation)
  const prevCount = (
    db
      .prepare(
        `SELECT COUNT(*) as cnt FROM signal_alerts
       WHERE content_hash = ? AND created_at >= datetime('now', '-24 hours')`,
      )
      .get(candidate.contentHash) as { cnt: number }
  ).cnt;

  const cooldownIdx = Math.min(prevCount, COOLDOWN_HOURS.length - 1);
  const cooldownHours = COOLDOWN_HOURS[cooldownIdx];
  const cooldownUntil =
    cooldownHours > 0
      ? new Date(Date.now() + cooldownHours * 3600_000).toISOString()
      : null;

  let alertId = 0;
  writeWithRetry(() => {
    const result = db
      .prepare(
        `INSERT INTO signal_alerts (tier, domain, title, body, signals_json, content_hash, cooldown_until)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        candidate.tier,
        candidate.domain,
        candidate.title,
        candidate.body,
        JSON.stringify(candidate.signalIds),
        candidate.contentHash,
        cooldownUntil,
      );
    alertId = Number(result.lastInsertRowid);
  });

  return alertId;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function getUndeliveredAlerts(tier?: AlertTier): AlertRow[] {
  const db = getDatabase();
  const where = tier
    ? "WHERE delivered_at IS NULL AND tier = ?"
    : "WHERE delivered_at IS NULL";
  const params = tier ? [tier] : [];

  return db
    .prepare(
      `SELECT * FROM signal_alerts ${where} ORDER BY created_at DESC LIMIT 20`,
    )
    .all(...params) as AlertRow[];
}

export function getRecentAlerts(
  hours: number = 48,
  tier?: AlertTier,
  limit: number = 20,
): AlertRow[] {
  const db = getDatabase();
  const conditions = ["created_at >= datetime('now', '-' || ? || ' hours')"];
  const params: unknown[] = [hours];

  if (tier) {
    conditions.push("tier = ?");
    params.push(tier);
  }

  params.push(limit);

  return db
    .prepare(
      `SELECT * FROM signal_alerts WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...params) as AlertRow[];
}

export function markDelivered(alertId: number, via: string): void {
  const db = getDatabase();
  db.prepare(
    "UPDATE signal_alerts SET delivered_at = datetime('now'), delivered_via = ? WHERE id = ?",
  ).run(via, alertId);
}
