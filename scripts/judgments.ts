/**
 * mc-ctl judgments — inspect the V8.2 "Strategic Initiative Layer" shadow
 * judgments accruing toward the §17 activation gate. Read-only (no row writes;
 * opens the shared DB via initDatabase, same as scripts/briefing-gate.ts).
 *
 *   mc-ctl judgments                 list the most recent judgments (default 20)
 *   mc-ctl judgments --window=7      only those written in the last N days
 *   mc-ctl judgments --limit=50      cap the row count (hard max 200)
 *   mc-ctl judgments <id>            full detail for one judgment
 *
 * The judgment producer (Phase 9, shadow-armed 2026-06-19) writes `judgments`
 * rows but delivers nothing; this is the operator's window into WHAT it is
 * producing — subject, posture, mechanical confidence, citation health,
 * concession state, critic verdict — the complement to `mc-ctl briefing-gate`
 * (which gives the §17 pass/fail verdict but not the rows behind it).
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initDatabase } from "../src/db/index.js";
import {
  getRecentJudgments,
  getJudgmentById,
  getJudgmentClaimSummary,
  getAttributedClaimRows,
  type JudgmentRow,
} from "../src/lib/v8-2/judgments-store.js";
import { evaluateV82Gate } from "../src/briefing/v82-activation-gate.js";
import {
  confShort,
  relAge,
  pad,
  truncate,
  criticVerdict,
  confidenceBasis,
  renderOptions,
} from "../src/lib/v8-2/judgment-format.js";

// Resolve the DB path relative to THIS script, so the helper works regardless
// of the invoking cwd (same pattern as scripts/briefing-gate.ts).
const DB_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
  "mc.db",
);

// Display formatters (confShort/relAge/pad/truncate/criticVerdict/
// confidenceBasis/renderOptions) live in src/lib/v8-2/judgment-format.ts so
// their defensive JSON-parsing contracts are unit-testable — imported above.

function printList(windowDays: number, limit: number): number {
  const judgments = getRecentJudgments({ windowDays, limit });

  // ── §17 gate-readiness header (the volume term most operators want at a glance).
  const g = evaluateV82Gate();
  const verdictLabel =
    g.verdict === "pass"
      ? "✅ PASS"
      : g.verdict === "fail"
        ? "❌ FAIL"
        : "⏳ INSUFFICIENT DATA";
  console.log("=== V8.2 Strategic Judgments (shadow) ===\n");
  console.log(`§17 gate: ${verdictLabel}  ·  ${g.checks.volume.detail}`);
  console.log(
    `          resolver ${g.resolverPct ?? "—"}%  ·  unfixable ${g.unfixablePct ?? "—"}%  ·  ` +
      `sycophancy ${g.sycophancyPct ?? "—"}%  ·  acceptance ${g.promoteRatio === null ? "—" : g.promoteRatio + "×"}`,
  );
  console.log("          (full gate: mc-ctl briefing-gate)\n");

  if (judgments.length === 0) {
    console.log(
      windowDays > 0
        ? `No judgments in the last ${windowDays}d.`
        : "No judgments yet (producer shadow-armed; none written).",
    );
    return 0;
  }

  console.log(
    pad("ID", 5) +
      pad("AGE", 6) +
      pad("CONF", 5) +
      pad("POSTURE", 17) +
      pad("CLAIMS", 9) +
      pad("CONC", 6) +
      pad("CRITIC", 14) +
      "SUBJECT",
  );
  for (const j of judgments) {
    const cs = getJudgmentClaimSummary(j.id);
    const claimCell =
      cs.total === 0
        ? "0"
        : `${cs.resolved}/${cs.total}` +
          (cs.contradicted > 0 || cs.stale > 0 ? " ⚠" : "");
    const conc =
      j.concessionKind === "updated_with_evidence"
        ? "upd"
        : j.concessionKind === "held_position"
          ? "held"
          : j.concessionKind === "conceded_without_evidence"
            ? "CONC!"
            : "—";
    console.log(
      pad(String(j.id), 5) +
        pad(relAge(j.createdAt), 6) +
        pad(confShort(j.confidence), 5) +
        pad(j.posture, 17) +
        pad(claimCell, 9) +
        pad(conc, 6) +
        pad(truncate(criticVerdict(j.criticTrailJson), 13), 14) +
        truncate(j.subject, 44),
    );
  }
  console.log(`\n${judgments.length} judgment(s) shown.`);
  return 0;
}

function printDetail(id: number): number {
  const j: JudgmentRow | null = getJudgmentById(id);
  if (!j) {
    console.error(`Judgment #${id} not found.`);
    return 1;
  }
  const cs = getJudgmentClaimSummary(j.id);
  const claims = getAttributedClaimRows(j.id);
  const options = renderOptions(j.proposedOptionsJson);

  console.log(`=== Judgment #${j.id} ===\n`);
  console.log(`subject:    ${j.subject}`);
  console.log(`posture:    ${j.posture}`);
  console.log(
    `confidence: ${j.confidence ?? "—"}   (${confidenceBasis(j.confidenceBasisJson)})`,
  );
  console.log(`created:    ${j.createdAt}  (${relAge(j.createdAt)} ago)`);
  console.log(`briefing:   ${j.briefingId}`);
  if (j.signalKind)
    console.log(
      `signal:     ${j.signalKind}${j.signalLastSeenAt ? ` (last seen ${j.signalLastSeenAt})` : ""}`,
    );
  console.log(`critic:     ${criticVerdict(j.criticTrailJson)}`);
  console.log(`concession: ${j.concessionKind ?? "—"}`);
  if (j.triggeringEvidenceText)
    console.log(`  triggered by: ${truncate(j.triggeringEvidenceText, 120)}`);

  console.log(`\nprose:\n${j.prose}`);

  if (options.length > 0) {
    console.log(`\noptions (${options.length}):`);
    for (const o of options) console.log(`  ${o}`);
  }

  console.log(
    `\nattributed claims (${cs.total}: ${cs.resolved} resolved · ${cs.unresolved} unresolved · ${cs.stale} stale · ${cs.contradicted} contradicted):`,
  );
  for (const c of claims) {
    console.log(
      `  [c${c.claimId}] ${pad(c.resolverStatus, 12)} ${pad(`${c.evidenceKind}:${c.evidenceId}`, 24)} ${truncate(c.evidenceExcerpt, 60)}`,
    );
  }
  return 0;
}

function main(): number {
  const args = process.argv.slice(2);
  let id: number | null = null;
  let windowDays = 0;
  let limit = 20;
  for (const a of args) {
    if (/^\d+$/.test(a)) id = Number(a);
    else if (a.startsWith("--window=")) windowDays = Number(a.slice(9)) || 0;
    else if (a.startsWith("--limit=")) limit = Number(a.slice(8)) || 20;
    else if (a === "-h" || a === "--help") {
      console.log(
        "Usage: mc-ctl judgments [<id>] [--window=N] [--limit=N]\n" +
          "  (no args)      list the most recent judgments (default 20)\n" +
          "  <id>           full detail for one judgment\n" +
          "  --window=N     only judgments written in the last N days\n" +
          "  --limit=N      cap the row count (hard max 200)",
      );
      return 0;
    } else {
      console.error(`unknown arg: ${a} (try --help)`);
      return 1;
    }
  }

  initDatabase(DB_PATH);
  return id !== null ? printDetail(id) : printList(windowDays, limit);
}

process.exit(main());
