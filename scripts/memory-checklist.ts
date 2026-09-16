/**
 * memory-checklist.ts — the agent-memory playbook's 10-item production
 * checklist, evaluated from live data. Read-only. Invoked by
 * `mc-ctl memory-checklist [--stale] [--json]`.
 *
 * Plan: docs/planning/agent-memory-5-layer-plan-2026-09-16.md §3 P0.
 * Same shape as `mc-ctl briefing-gate`: one row per item, a status, and the
 * evidence the status was read from. It REPORTS ONLY — every red row maps to
 * a later phase of the plan, and nothing here changes store behaviour.
 *
 * Sources: `data/mc.db` via a read-only better-sqlite3 handle (safe while
 * mission-control runs) and the local `/metrics` endpoint for ritual
 * last-success timestamps (unreachable → rows that need it say so).
 *
 *   --stale   also list user_facts not updated in 90 d (the paper's
 *             staleness test, applied to the store with no TTL)
 *   --json    machine-readable output
 */

import Database from "better-sqlite3";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type RowStatus = "green" | "amber" | "red";

export interface ChecklistRow {
  n: number;
  item: string;
  status: RowStatus;
  evidence: string;
  /** Plan phase that turns a non-green row green. */
  phase?: string;
}

/** Everything the evaluator needs, gathered by `collect()` so the evaluator
 * itself is pure and testable. */
export interface ChecklistInputs {
  episodicRows24h: number;
  recallAudit24h: number;
  precedentRows7d: number;
  precedentUsed7d: number;
  userFacts: number;
  userFactsStale90d: number;
  jmeFactsLive: number;
  jmeFactsExpiredUnpruned: number;
  triples: number;
  triplesClosed: number;
  skillsActive: number;
  skillsCertified: number;
  skillVersions30d: number;
  kbSkillFiles: number;
  /** ritual_id → seconds since last success, from /metrics; null when the
   * endpoint was unreachable. */
  ritualAgeSec: Record<string, number> | null;
}

export const STALE_FACT_DAYS = 90;
const DAY = 86_400;

function fmtAge(sec: number | undefined): string {
  if (sec === undefined) return "no success metric";
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < DAY) return `${(sec / 3600).toFixed(1)} h ago`;
  return `${(sec / DAY).toFixed(1)} d ago`;
}

export function evaluateChecklist(i: ChecklistInputs): ChecklistRow[] {
  const age = (id: string) => i.ritualAgeSec?.[id];
  const ritual = (id: string, maxDays: number): RowStatus =>
    i.ritualAgeSec === null
      ? "amber"
      : age(id) !== undefined && age(id)! <= maxDays * DAY
        ? "green"
        : "red";

  return [
    {
      n: 1,
      item: "Episodic log written every turn",
      status: i.episodicRows24h > 0 ? "green" : "red",
      evidence: `conversations rows 24 h: ${i.episodicRows24h}; recall_audit rows 24 h: ${i.recallAudit24h}`,
    },
    {
      n: 2,
      item: "Precedent retrieval keyed on task records",
      status:
        i.precedentRows7d === 0 ? "red" : i.precedentUsed7d > 0 ? "green" : "amber",
      evidence: `recall_audit bank=precedents 7 d: ${i.precedentRows7d} logged, ${i.precedentUsed7d} re-derived (shadow — nothing injected)`,
      phase: "P1 shadow → inject after readout",
    },
    {
      n: 3,
      item: "Semantic stores populated",
      status: i.userFacts + i.jmeFactsLive + i.triples > 0 ? "green" : "red",
      evidence: `user_facts ${i.userFacts}; jme_facts live ${i.jmeFactsLive}; knowledge_triples ${i.triples}`,
    },
    {
      n: 4,
      item: "Ontology / entity registry",
      status: "red",
      evidence: "none — user_facts keys and JME categories are free-form",
      phase: "P2",
    },
    {
      n: 5,
      item: "Contradictions flagged, not overwritten",
      status: i.triplesClosed > 0 ? "amber" : "red",
      evidence: `user_facts UNIQUE(category,key) upsert overwrites silently; knowledge_triples closed by valid_to: ${i.triplesClosed}`,
      phase: "P2",
    },
    {
      n: 6,
      item: "Skills promoted from repeated success",
      status: i.skillVersions30d > 0 ? "amber" : "red",
      evidence: `skill_versions 30 d: ${i.skillVersions30d}; active skills ${i.skillsActive}, certified ${i.skillsCertified}; KB skills/ files ${i.kbSkillFiles} (second store)`,
      phase: "P4 gated producer; certification stays operator-only",
    },
    {
      n: 7,
      item: "Skill rollback available",
      status: "green",
      evidence: "mc-ctl skills revert <name> <version> repoints current_version_id",
    },
    {
      n: 8,
      item: "Expiry / consolidation crons alive",
      status:
        [ritual("skill-evolution", 2), ritual("nightly-close", 2)].includes("red")
          ? "red"
          : i.ritualAgeSec === null
            ? "amber"
            : "green",
      evidence: `skill-evolution ${fmtAge(age("skill-evolution"))}; nightly-close ${fmtAge(age("nightly-close"))}; jme-consolidate / memory-consolidation publish no last-success metric${i.ritualAgeSec === null ? " (metrics endpoint unreachable)" : ""}`,
    },
    {
      n: 9,
      item: "Compaction → memory handoff",
      status: "red",
      evidence: "none — context compaction writes nothing to any store",
      phase: "P3",
    },
    {
      n: 10,
      item: "Forgetting: expire / supersede / flag",
      // Amber until runForgetting() exists — zero counters would mean "nothing
      // to forget today", not "forgetting works" (qa R2 W-5).
      status: "amber",
      evidence: `jme_facts expired but never pruned: ${i.jmeFactsExpiredUnpruned} (pruneExpiredFacts has no caller); user_facts untouched > ${STALE_FACT_DAYS} d: ${i.userFactsStale90d}; supersede: JME dedup + triples valid_to; flag: none`,
      phase: "P5 runForgetting()",
    },
  ];
}

/** Parse `mc_ritual_last_success_timestamp{ritual_id="x"} <epoch>` lines. */
export function parseRitualAges(metricsText: string, nowSec: number): Record<string, number> {
  const out: Record<string, number> = {};
  const re = /^mc_ritual_last_success_timestamp\{ritual_id="([^"]+)"\}\s+([0-9.]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(metricsText)) !== null) {
    out[m[1]] = Math.max(0, nowSec - Number(m[2]));
  }
  return out;
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.MC_DB_PATH ?? join(SCRIPT_DIR, "..", "data", "mc.db");
const METRICS_URL = process.env.MC_METRICS_URL ?? "http://127.0.0.1:8080/metrics";

function count(db: Database.Database, sql: string, ...params: unknown[]): number {
  try {
    const row = db.prepare(sql).get(...params) as { n: number } | undefined;
    return row?.n ?? 0;
  } catch (err) {
    // Only an absent table reads as empty; any other failure (busy, corrupt,
    // bad SQL) must surface, or a row would read RED for the wrong reason.
    if (/no such table/i.test(err instanceof Error ? err.message : String(err))) return 0;
    throw err;
  }
}

async function collect(db: Database.Database): Promise<ChecklistInputs> {
  const nowMs = Date.now();
  let ritualAgeSec: Record<string, number> | null = null;
  try {
    const res = await fetch(METRICS_URL, { signal: AbortSignal.timeout(3000) });
    if (res.ok) ritualAgeSec = parseRitualAges(await res.text(), nowMs / 1000);
  } catch {
    // unreachable → rows that need it report amber
  }
  return {
    episodicRows24h: count(db, "SELECT COUNT(*) n FROM conversations WHERE created_at >= datetime('now','-1 day')"),
    recallAudit24h: count(db, "SELECT COUNT(*) n FROM recall_audit WHERE created_at >= datetime('now','-1 day')"),
    precedentRows7d: count(db, "SELECT COUNT(*) n FROM recall_audit WHERE bank='precedents' AND created_at >= datetime('now','-7 days')"),
    precedentUsed7d: count(db, "SELECT COUNT(*) n FROM recall_audit WHERE bank='precedents' AND was_used=1 AND created_at >= datetime('now','-7 days')"),
    userFacts: count(db, "SELECT COUNT(*) n FROM user_facts"),
    userFactsStale90d: count(db, `SELECT COUNT(*) n FROM user_facts WHERE updated_at < datetime('now','-${STALE_FACT_DAYS} days')`),
    jmeFactsLive: count(db, "SELECT COUNT(*) n FROM jme_facts WHERE expires_at IS NULL OR expires_at > ?", nowMs),
    jmeFactsExpiredUnpruned: count(db, "SELECT COUNT(*) n FROM jme_facts WHERE expires_at IS NOT NULL AND expires_at <= ?", nowMs),
    triples: count(db, "SELECT COUNT(*) n FROM knowledge_triples"),
    triplesClosed: count(db, "SELECT COUNT(*) n FROM knowledge_triples WHERE valid_to IS NOT NULL"),
    skillsActive: count(db, "SELECT COUNT(*) n FROM skills WHERE active=1"),
    skillsCertified: count(db, "SELECT COUNT(*) n FROM skills WHERE active=1 AND is_certified=1"),
    skillVersions30d: count(db, "SELECT COUNT(*) n FROM skill_versions WHERE created_at >= datetime('now','-30 days')"),
    kbSkillFiles: count(db, "SELECT COUNT(*) n FROM jarvis_files WHERE path LIKE 'skills/%'"),
    ritualAgeSec,
  };
}

interface StaleFact {
  category: string;
  key: string;
  updated_at: string;
}

function staleFacts(db: Database.Database): StaleFact[] {
  try {
    return db
      .prepare(
        `SELECT category, key, updated_at FROM user_facts
          WHERE updated_at < datetime('now','-${STALE_FACT_DAYS} days')
          ORDER BY updated_at ASC LIMIT 50`,
      )
      .all() as StaleFact[];
  } catch {
    return [];
  }
}

const MARK: Record<RowStatus, string> = { green: "GREEN", amber: "AMBER", red: "RED  " };

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const db = new Database(DB_PATH, { readonly: true });
  const inputs = await collect(db);
  const rows = evaluateChecklist(inputs);
  const stale = args.has("--stale") ? staleFacts(db) : [];
  db.close();

  if (args.has("--json")) {
    console.log(JSON.stringify({ rows, inputs, stale }, null, 2));
    return;
  }
  const tally = { green: 0, amber: 0, red: 0 };
  console.log("=== Agent-memory checklist (read-only) ===");
  for (const r of rows) {
    tally[r.status]++;
    console.log(`${MARK[r.status]}  ${r.n.toString().padStart(2)}. ${r.item}`);
    console.log(`         ${r.evidence}${r.phase ? `  [→ ${r.phase}]` : ""}`);
  }
  console.log(`\n${tally.green} green · ${tally.amber} amber · ${tally.red} red`);
  if (args.has("--stale")) {
    console.log(`\nuser_facts untouched > ${STALE_FACT_DAYS} d (oldest first, max 50): ${inputs.userFactsStale90d}`);
    for (const f of stale) console.log(`  ${f.updated_at}  ${f.category}/${f.key}`);
    console.log("No auto-expire: user_facts has no TTL by design; review is an operator decision.");
  }
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
if (process.argv[1] !== undefined && real(fileURLToPath(import.meta.url)) === real(process.argv[1])) {
  main().catch((err) => {
    console.error("memory-checklist failed:", err instanceof Error ? err.message : String(err));
    process.exit(3);
  });
}
