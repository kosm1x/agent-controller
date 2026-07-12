/**
 * mc-ctl v83-promote <capability> [--confirm] — the operator's L1→L2 promotion.
 *
 * The "small guarded command" deferred at V8.3 Phase 7. Dry run by default:
 * evaluates every guard (seeded, level, max_level, §14 gate) and reports what
 * would change; only `--confirm` writes. On execution it renders a MADR-style
 * promotion record to logs/decisions/. L≥3 has no code path here — see
 * src/lib/v8-3/promotion.ts.
 *
 * Exit: 0 = promoted (or dry run with all guards green), 1 = refused by a
 * structural guard, 2 = §14 gate not green yet (the expected state while the
 * 7-day shadow accumulates).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initDatabase } from "../src/db/index.js";
import {
  promoteCapabilityL1toL2,
  renderPromotionAdr,
} from "../src/lib/v8-3/promotion.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = join(ROOT, "data", "mc.db");
const ADR_DIR = join(ROOT, "logs", "decisions");

function main(): number {
  const args = process.argv.slice(2);
  const confirm = args.includes("--confirm");
  const capability = args.find((a) => !a.startsWith("--"));

  if (!capability) {
    console.error(
      "usage: mc-ctl v83-promote <capability> [--confirm]\n" +
        "Dry run without --confirm. See mc-ctl v83-gate for readiness.",
    );
    return 1;
  }

  initDatabase(DB_PATH);
  const result = promoteCapabilityL1toL2(capability, { confirm });

  console.log("=== V8.3 L1→L2 promotion ===\n");

  if (!result.ok) {
    console.log(`❌ REFUSED (${result.refusedBy}): ${result.reason}`);
    return result.refusedBy === "gate" ? 2 : 1;
  }

  if (!result.executed) {
    console.log(
      `✅ DRY RUN — all guards green. "${result.capability}" would move L1 → L2.`,
    );
    console.log("Re-run with --confirm to promote.");
    return 0;
  }

  // Ledger names are controlled identifiers, but never let one shape a path
  // unfiltered (mirrors adr-writer.ts's adrFilename whitelist).
  const safeName = result.capability.replace(/[^a-zA-Z0-9_-]/g, "_");
  const adrPath = join(
    ADR_DIR,
    `promotion-${safeName}-${result.promotedAt.slice(0, 10)}.md`,
  );
  mkdirSync(ADR_DIR, { recursive: true });
  writeFileSync(adrPath, renderPromotionAdr(result));

  console.log(
    `✅ PROMOTED — "${result.capability}" is now L2 (promoted_at ${result.promotedAt}).`,
  );
  console.log(`ADR: ${adrPath}`);
  console.log(
    "\nL≥3 remains gated on V8.2 §17 (mc-ctl briefing-gate) + judgment linkage",
  );
  console.log("+ per-capability operator signoff — not this command.");
  return 0;
}

process.exit(main());
