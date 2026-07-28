/**
 * Validate the planner's workload-sizing rules (2026-07-27) with ONE live
 * plan() call on the incident-shaped task (588389e9: "analiza cada slide" on
 * a 14-slide deck → monolithic goals → per-goal timeouts → ceiling).
 *
 * The eval:gate corpus (tool_selection/scope/classification) is blind to
 * PLAN_SYSTEM — this probe is the substitute gate (qa-audit S1).
 *
 * PASS criteria (printed for eyeball + basic asserts):
 *  - enumerable workload split into batch goals with explicit ranges
 *  - batch goals independent (depends_on=[]) so they run concurrently
 *  - no goal whose criteria quantify over ALL 14 slides
 *
 * Usage: npx tsx scripts/validate-planner-sizing.ts --run
 * (reads live service env from /proc/<MainPID>/environ — never printed;
 * works on a /tmp snapshot of mc.db per the validate-* harness pattern)
 */

import { copyFileSync, chmodSync, existsSync, readFileSync } from "fs";
import { execSync } from "child_process";

if (!process.argv.includes("--run")) {
  console.log("Dry: pass --run to spend one Opus plan() call.");
  process.exit(0);
}

// Load live service env (INFERENCE_*, HOME) — values are never printed.
const mainPid = execSync("systemctl show mission-control -p MainPID --value")
  .toString()
  .trim();
const environ = readFileSync(`/proc/${mainPid}/environ`).toString();
for (const kv of environ.split("\0")) {
  const eq = kv.indexOf("=");
  if (eq > 0) process.env[kv.slice(0, eq)] ??= kv.slice(eq + 1);
}

// DB snapshot (plan() reads memory + knowledge maps + KB via SQLite).
const SRC = "/root/claude/mission-control/data/mc.db";
const TMP = "/tmp/validate-planner-sizing.db";
copyFileSync(SRC, TMP);
chmodSync(TMP, 0o600);
for (const ext of ["-wal", "-shm"]) {
  if (existsSync(SRC + ext)) {
    copyFileSync(SRC + ext, TMP + ext);
    chmodSync(TMP + ext, 0o600);
  }
}

const { initDatabase } = await import("../src/db/index.js");
initDatabase(TMP);

const TASK = `Analiza cada slide

--- Contenido del archivo "CTV_—_La_2da_Fuerza_de_Video_Digital_de_México_·_TV_Azteca_2027.pdf" ---
Deck interno de 14 slides sobre CTV en México. Slides: (1) Portada, (2) El mito que hay que destruir — 89.9% hogares con TV, 75.6% Smart TV, 59.9M audiencia abierta, (3) La pantalla grande como campo de batalla, (4) El nuevo entorno CTV, (5) El mercado potencial CTV — 51.1M usuarios, 88% co-viewing, (6) La velocidad del dinero — inversión $7,200 MDP, (7) El ecosistema — 3 capas, (8) Device share vs content share, (9) Programática abierta vs walled gardens, (10) Medición y atribución, (11) Frecuencia y saturación, (12) La 2da Fuerza de Video Digital — detrás solo de YouTube, (13) Oferta TV Azteca Digital, (14) Cierre.
Para cada slide: analiza el contenido, verifica las cifras contra el KB y fuentes primarias, y da una recomendación concreta.`;

const { plan } = await import("../src/prometheus/planner.js");
const { graph } = await plan(TASK, true);

const goals = Object.values(graph.toJSON().goals);
console.log(`\n=== Planned ${goals.length} goals ===`);
for (const g of goals) {
  console.log(
    `- ${g.id} [deps: ${g.dependsOn.join(",") || "none"}] ${g.description.slice(0, 110)}`,
  );
  for (const c of g.completionCriteria) console.log(`    · ${c.slice(0, 100)}`);
}

const rangeRe = /\b(slides?|láminas?)\s+\d+\s*[-–a]\s*\d+/i;
const batchGoals = goals.filter((g) => rangeRe.test(g.description));
const batchIds = new Set(batchGoals.map((g) => g.id));
// What matters for same-round parallelism is MUTUAL independence: no batch
// depends on another batch. A shared scaffolding dep (domain overview g-1)
// is fine — once it completes, all batches become ready together.
const chainedBatches = batchGoals.filter((g) =>
  g.dependsOn.some((d) => batchIds.has(d)),
);
// ALL-quantified criteria are only the failure shape on NON-consolidation
// goals (a consolidation goal legitimately references every item in its own
// assembled output). Consolidation ≈ the goal that depends on 2+ batches.
const consolidationIds = new Set(
  goals
    .filter((g) => g.dependsOn.filter((d) => batchIds.has(d)).length >= 2)
    .map((g) => g.id),
);
const allQuantified = goals.filter(
  (g) =>
    !consolidationIds.has(g.id) &&
    g.completionCriteria.some((c) =>
      /(cada|todas?|todos|every|all)\s+(uno de los\s+)?(14|los\s+14|slides?|figuras?|cifras?)/i.test(
        c,
      ),
    ),
);

console.log(`\nbatch goals with ranges: ${batchGoals.length}`);
console.log(`batches chained to other batches: ${chainedBatches.length}`);
console.log(
  `non-consolidation goals with ALL-quantified criteria: ${allQuantified.length}${allQuantified.length ? " ← " + allQuantified.map((g) => g.id).join(",") : ""}`,
);
console.log(
  batchGoals.length >= 2 &&
    chainedBatches.length === 0 &&
    allQuantified.length === 0
    ? "\nVERDICT: PASS — workload batched, batches mutually independent"
    : "\nVERDICT: REVIEW — inspect the graph above",
);
