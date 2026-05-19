/**
 * v7.7 Spine 3 Phase 5 Bundle 2 — seed + certify the 5 production skills.
 *
 * Reads the 5 SKILL.md files from `seed/skills/<name>/SKILL.md`, upserts
 * each into `jarvis_files` (so the boot loader keeps them in sync), runs
 * `skillSave` (critic gate + version write + current_version_id pointer),
 * then runs `runSkillTests` to drive certification.
 *
 * Idempotent: re-running with unchanged bodies hits skillSave's
 * `unchanged` path (no-op) and re-runs the tests (re-certifies).
 *
 * Env: MODE=save|test|both (default both).
 *   save — upsert files + skillSave only (critic gate)
 *   test — runSkillTests only (assumes already saved)
 *   both — save then test
 *
 * Exit codes: 0 all 5 certified | 1 partial | 2 fatal.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initDatabase, getDatabase } from "../src/db/index.js";
import { upsertFile } from "../src/db/jarvis-fs.js";
import {
  parseSkillFile,
  type ParsedSkillFile,
} from "../src/skills/frontmatter.js";
import { skillSave } from "../src/skills/lifecycle.js";
import { runSkillTests } from "../src/skills/test-runner.js";

const SKILL_NAMES = [
  "planificar-proyecto-por-fases",
  "resumir-avance-de-tareas",
  "clasificar-prioridad-tarea",
  "construir-peticion-http",
  "evaluar-roi-de-fase",
] as const;

interface SeedOutcome {
  name: string;
  saved: boolean;
  saveDetail: string;
  skillId: string | null;
  versionId: number | null;
  tested: boolean;
  certified: boolean;
  testDetail: string;
}

async function main(): Promise<number> {
  initDatabase("./data/mc.db");
  const mode = (process.env.MODE ?? "both").toLowerCase();
  const doSave = mode === "save" || mode === "both";
  const doTest = mode === "test" || mode === "both";
  const repoRoot = process.cwd();

  // R3 audit fold: the script reads `./data/mc.db` + `seed/skills/` relative
  // to cwd. Running it from anywhere but the repo root would touch the
  // wrong (or a fresh empty) DB. Guard explicitly.
  try {
    readFileSync(join(repoRoot, "seed", "skills", SKILL_NAMES[0], "SKILL.md"));
  } catch {
    console.error(
      `[seed-phase5] must run from the mission-control repo root; cwd=${repoRoot} has no seed/skills/. Aborting.`,
    );
    return 2;
  }

  const outcomes: SeedOutcome[] = [];

  for (const name of SKILL_NAMES) {
    const outcome: SeedOutcome = {
      name,
      saved: false,
      saveDetail: "",
      skillId: null,
      versionId: null,
      tested: false,
      certified: false,
      testDetail: "",
    };

    const fsPath = join(repoRoot, "seed", "skills", name, "SKILL.md");
    const jarvisPath = `skills/${name}/SKILL.md`;
    let content: string;
    try {
      content = readFileSync(fsPath, "utf8");
    } catch (e) {
      outcome.saveDetail = `read failed: ${e instanceof Error ? e.message : String(e)}`;
      outcomes.push(outcome);
      continue;
    }

    let parsed: ParsedSkillFile;
    try {
      parsed = parseSkillFile(content);
    } catch (e) {
      outcome.saveDetail = `parse failed: ${e instanceof Error ? e.message : String(e)}`;
      outcomes.push(outcome);
      continue;
    }

    if (doSave) {
      // Mirror the body into jarvis_files so the boot loader keeps it in
      // sync on future restarts. Qualifier 'reference' (the jarvis_files
      // CHECK enum doesn't have a 'skill' value); the 'skill' tag is the
      // discriminator. Priority 50 keeps it out of directive injection.
      upsertFile(
        jarvisPath,
        `Skill: ${name}`,
        content,
        ["skill", "v7.7-spine-3", "phase-5"],
        "reference",
        50,
      );

      const result = await skillSave(parsed, { bodyPath: jarvisPath });
      if (result.ok) {
        outcome.saved = true;
        outcome.skillId = result.skillId;
        outcome.versionId = result.versionId;
        outcome.saveDetail = `critic=${result.criticVerdict}`;
      } else if (result.kind === "unchanged") {
        // Already registered with this exact body — resolve ids from DB.
        const db = getDatabase();
        const row = db
          .prepare(
            `SELECT s.skill_id, s.current_version_id
             FROM skills s WHERE s.name = ?`,
          )
          .get(name) as
          | { skill_id: string; current_version_id: number | null }
          | undefined;
        if (row?.current_version_id) {
          outcome.saved = true;
          outcome.skillId = row.skill_id;
          outcome.versionId = row.current_version_id;
          outcome.saveDetail = "unchanged (already registered)";
        } else {
          outcome.saveDetail = "unchanged but no current_version_id";
        }
      } else if (result.kind === "drift") {
        // W3 audit fold: drift means the seed/ file body diverged from
        // the registered skill_versions row at the same version. Distinct
        // from a critic rejection — give the operator a remediation hint.
        outcome.saveDetail =
          `drift: seed file body differs from registered version ${parsed.frontmatter.version} ` +
          `(existing sha ${result.existingShaPrefix ?? "?"}…). Bump the SKILL.md \`version:\` to register the new body.`;
      } else {
        outcome.saveDetail = `${result.kind}: ${result.critique.slice(0, 200)}`;
      }
    } else {
      // test-only mode: resolve ids from DB.
      const db = getDatabase();
      const row = db
        .prepare(
          `SELECT skill_id, current_version_id FROM skills WHERE name = ?`,
        )
        .get(name) as
        | { skill_id: string; current_version_id: number | null }
        | undefined;
      if (row?.current_version_id) {
        outcome.saved = true;
        outcome.skillId = row.skill_id;
        outcome.versionId = row.current_version_id;
        outcome.saveDetail = "resolved from DB (test-only mode)";
      } else {
        outcome.saveDetail = "not found in DB — run MODE=save first";
      }
    }

    if (doTest && outcome.skillId && outcome.versionId !== null) {
      const tr = await runSkillTests(outcome.skillId, outcome.versionId);
      outcome.tested = true;
      outcome.certified = tr.certified;
      const passes = tr.outcomes.filter((o) => o.result === "pass").length;
      outcome.testDetail = `${passes}/${tr.outcomes.length} pass`;
      if (!tr.certified) {
        for (const o of tr.outcomes) {
          if (o.result !== "pass") {
            outcome.testDetail +=
              ` | ${o.testName}=${o.result}: ${o.diffSummary ?? ""}`.slice(
                0,
                260,
              );
          }
        }
      }
    }

    outcomes.push(outcome);
  }

  // Report
  console.log("\n=== Phase 5 Bundle 2 — skill seed + certify ===\n");
  for (const o of outcomes) {
    const certMark = o.certified
      ? "CERTIFIED"
      : o.tested
        ? "NOT CERTIFIED"
        : "—";
    console.log(`  ${o.name}`);
    console.log(`    save:  ${o.saved ? "ok" : "FAIL"} (${o.saveDetail})`);
    console.log(`    test:  ${certMark} (${o.testDetail || "not run"})`);
  }

  // Activation gate query (spec §14)
  const db = getDatabase();
  const gate = db
    .prepare(
      `SELECT COUNT(*) AS n FROM skills s
       WHERE s.is_certified = 1 AND s.active = 1
         AND EXISTS (SELECT 1 FROM skill_test_runs str
                     WHERE str.skill_id = s.skill_id
                       AND str.result = 'pass'
                       AND str.ran_at >= datetime('now','-7 days'))`,
    )
    .get() as { n: number };
  console.log(
    `\n  Activation gate (spec §14): ${gate.n} certified skills with green tests in 7d`,
  );
  console.log(`  Target: >= 5 — ${gate.n >= 5 ? "PASS" : "NOT YET"}\n`);

  const certifiedCount = outcomes.filter((o) => o.certified).length;
  return certifiedCount === SKILL_NAMES.length ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(2);
  });
