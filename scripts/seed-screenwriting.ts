/**
 * Screenwriting corpus adoption (2026-09-12) — seed the KB docs and the
 * five craft skills. Plan: docs/planning/screenwriting-corpus-adoption-plan.md
 *
 * KB docs: seed/knowledge/screenwriting/NN-*.md → jarvis_files
 *   `knowledge/screenwriting/NN-*.md` (upsertFile also writes the FS mirror,
 *   so the hourly kb-reindex sees nothing to do). Qualifier `reference` is
 *   what keeps them out of prompt injection (injection selects by qualifier,
 *   not priority); priority 50 only orders rows inside a qualifier set.
 * Skills:  seed/skills/<name>/SKILL.md → skillSave (critic gate + version row)
 *   THEN jarvis_files `skills/<name>/SKILL.md` (only critic-accepted bodies
 *   reach the registry the boot loader reads) + runSkillTests (certification).
 *   Same contract as scripts/skills-seed-phase5.ts, order of writes fixed
 *   per the 2026-09-12 R1 audit (W1).
 *
 * Usage (from the repo root; the critic/test LLM needs the service env —
 * load it from /proc/<MainPID>/environ, never print it):
 *   MODE=all    npx tsx scripts/seed-screenwriting.ts  # kb + save + test (default)
 *   MODE=kb     npx tsx scripts/seed-screenwriting.ts  # docs only, no LLM
 *   MODE=save   npx tsx scripts/seed-screenwriting.ts  # skills: critic + version (leaves is_certified as-is — run test next)
 *   MODE=test   npx tsx scripts/seed-screenwriting.ts  # skills: run tests only
 *   MODE=skills npx tsx scripts/seed-screenwriting.ts  # save then test
 *   SKILLS=a,b  limits the skills step to the named skills (comma list; an unknown name exits 1 before any write)
 *
 * Exit codes: 0 everything done | 1 partial / nothing done | 2 fatal (bad MODE, wrong cwd, DB missing).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { initDatabase, getDatabase } from "../src/db/index.js";
import { upsertFile } from "../src/db/jarvis-fs.js";
import { parseSkillFile, type ParsedSkillFile } from "../src/skills/frontmatter.js";
import { skillSave } from "../src/skills/lifecycle.js";
import { runSkillTests } from "../src/skills/test-runner.js";

const SKILL_NAMES = [
  "short-form-script",
  "logline-premise-test",
  "scene-value-turn-diagnostic",
  "dialogue-on-the-nose-pass",
  "series-engine-test",
] as const;
type SkillName = (typeof SKILL_NAMES)[number];

const MODES = new Set(["all", "kb", "save", "test", "skills"]);
const KB_SRC = "seed/knowledge/screenwriting";
const KB_DST = "knowledge/screenwriting";
const KB_TAGS = ["screenwriting", "craft", "2026-09-12"];
/** CJK ideographs + CJK/fullwidth punctuation + kana + hangul + compatibility forms. */
const CJK_RE = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/u;
/** Let the fire-and-forget pgvector/Drive syncs and the 5 s INDEX.md debounce drain before exit. */
const SETTLE_MS = 15_000;

function titleOf(md: string, fallback: string): string {
  const m = md.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : fallback;
}

function seedKb(): { upserted: number; skipped: string[] } {
  const skipped: string[] = [];
  const docs: { f: string; content: string }[] = [];
  // Pass 1: read + validate everything before any write (no partial seed).
  for (const f of readdirSync(KB_SRC).sort()) {
    if (!/^\d{2}-.+\.md$/.test(f)) {
      skipped.push(f); // DISTILL-BRIEF.md etc. never reach the KB
      continue;
    }
    const content = readFileSync(join(KB_SRC, f), "utf8");
    if (CJK_RE.test(content)) {
      throw new Error(`${f} contains CJK characters — distillation incomplete; nothing written`);
    }
    docs.push({ f, content });
  }
  // Pass 2: write.
  for (const d of docs) {
    upsertFile(`${KB_DST}/${d.f}`, titleOf(d.content, d.f), d.content, KB_TAGS, "reference", 50, null, [], {
      skipUserEdit: true,
    });
  }
  return { upserted: docs.length, skipped };
}

interface Outcome {
  name: string;
  saved: boolean;
  saveDetail: string;
  skillId: string | null;
  versionId: number | null;
  tested: boolean;
  certified: boolean;
  testDetail: string;
}

function resolveIds(name: string): { skill_id: string; current_version_id: number | null } | undefined {
  return getDatabase()
    .prepare(`SELECT skill_id, current_version_id FROM skills WHERE name = ?`)
    .get(name) as { skill_id: string; current_version_id: number | null } | undefined;
}

function selectedSkills(): readonly SkillName[] {
  const only = (process.env.SKILLS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (only.length === 0) return SKILL_NAMES;
  const unknown = only.filter((n) => !(SKILL_NAMES as readonly string[]).includes(n));
  if (unknown.length) throw new Error(`unknown SKILLS: ${unknown.join(", ")} (known: ${SKILL_NAMES.join(", ")})`);
  return SKILL_NAMES.filter((n) => only.includes(n));
}

async function seedSkills(doSave: boolean, doTest: boolean): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (const name of selectedSkills()) {
    const o: Outcome = {
      name, saved: false, saveDetail: "", skillId: null, versionId: null,
      tested: false, certified: false, testDetail: "",
    };
    const seedPath = join("seed/skills", name, "SKILL.md");
    const jarvisPath = `skills/${name}/SKILL.md`;
    if (!existsSync(seedPath)) {
      o.saveDetail = `missing ${seedPath}`;
      outcomes.push(o);
      continue;
    }
    let content: string;
    let parsed: ParsedSkillFile;
    try {
      content = readFileSync(seedPath, "utf8");
      parsed = parseSkillFile(content);
    } catch (e) {
      o.saveDetail = `read/parse failed: ${e instanceof Error ? e.message : String(e)}`;
      outcomes.push(o);
      continue;
    }

    if (doSave) {
      const r = await skillSave(parsed, { bodyPath: jarvisPath });
      if (r.ok) {
        o.saved = true; o.skillId = r.skillId; o.versionId = r.versionId;
        o.saveDetail = `critic=${r.criticVerdict}`;
        if (!doTest) o.saveDetail += " | WARNING: new version registered without tests — is_certified unchanged; run MODE=test";
      } else if (r.kind === "unchanged") {
        const row = resolveIds(name);
        if (row?.current_version_id) {
          o.saved = true; o.skillId = row.skill_id; o.versionId = row.current_version_id;
          o.saveDetail = "unchanged (already registered)";
        } else o.saveDetail = "unchanged but no current_version_id";
      } else if (r.kind === "drift") {
        o.saveDetail = `drift: seed body differs from registered ${parsed.frontmatter.version} (sha ${r.existingShaPrefix ?? "?"}…) — bump version:`;
      } else {
        o.saveDetail = `${r.kind}: ${r.critique.slice(0, 300)}`;
      }
      // Only a critic-accepted (or already-registered) body reaches jarvis_files,
      // which the boot loader would otherwise register with critic_verdict=skipped.
      if (o.saved) {
        upsertFile(jarvisPath, `Skill: ${name}`, content, ["skill", "screenwriting", "2026-09-12"], "reference", 50, null, [], {
          skipUserEdit: true,
        });
      }
    } else {
      const row = resolveIds(name);
      if (row?.current_version_id) {
        o.saved = true; o.skillId = row.skill_id; o.versionId = row.current_version_id;
        o.saveDetail = "resolved from DB";
      } else o.saveDetail = "not in DB — run MODE=save first";
    }

    if (doTest && o.skillId && o.versionId !== null) {
      const tr = await runSkillTests(o.skillId, o.versionId);
      o.tested = true; o.certified = tr.certified;
      const passes = tr.outcomes.filter((t) => t.result === "pass").length;
      o.testDetail = `${passes}/${tr.outcomes.length} pass`;
      for (const t of tr.outcomes) {
        if (t.result !== "pass") o.testDetail += ` | ${t.testName}=${t.result}: ${(t.diffSummary ?? "").slice(0, 200)}`;
      }
    }
    outcomes.push(o);
  }
  return outcomes;
}

function printActivationGate(): void {
  const gate = getDatabase()
    .prepare(
      `SELECT COUNT(*) AS n FROM skills s
       WHERE s.is_certified = 1 AND s.active = 1
         AND EXISTS (SELECT 1 FROM skill_test_runs str
                     WHERE str.skill_id = s.skill_id
                       AND str.result = 'pass'
                       AND str.ran_at >= datetime('now','-7 days'))`,
    )
    .get() as { n: number };
  console.log(`\n  Activation gate (spec §14): ${gate.n} certified active skills with green tests in 7d — target >= 5: ${gate.n >= 5 ? "PASS" : "NOT YET"}\n`);
}

async function main(): Promise<number> {
  const mode = (process.env.MODE ?? "all").trim().toLowerCase();
  if (!MODES.has(mode)) {
    console.error(`unknown MODE=${JSON.stringify(process.env.MODE)}; expected one of ${[...MODES].join("|")}`);
    return 2;
  }
  if (!existsSync("./data/mc.db") || !existsSync(KB_SRC) || !existsSync("seed/skills")) {
    console.error("run from the mission-control repo root (needs ./data/mc.db, seed/knowledge/screenwriting/ and seed/skills/)");
    return 2;
  }
  initDatabase("./data/mc.db");
  try {
    selectedSkills(); // refuse unknown SKILLS= names before any write
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
  const doKb = mode === "kb" || mode === "all";
  const doSave = mode === "save" || mode === "skills" || mode === "all";
  const doTest = mode === "test" || mode === "skills" || mode === "all";
  let rc = 0;
  let wrote = false;

  if (doKb) {
    const r = seedKb();
    wrote = r.upserted > 0;
    console.log(`KB: ${r.upserted} docs upserted under ${KB_DST}/ (skipped: ${r.skipped.join(", ") || "none"})`);
    if (r.upserted === 0) rc = 1;
  }

  if (doSave || doTest) {
    const outcomes = await seedSkills(doSave, doTest);
    console.log("\n=== screenwriting skills ===");
    for (const o of outcomes) {
      if (o.saved && doSave) wrote = true;
      const mark = o.certified ? "CERTIFIED" : o.tested ? "NOT CERTIFIED" : o.saved ? "SAVED" : "FAILED";
      console.log(`${mark.padEnd(14)} ${o.name.padEnd(30)} ${o.saveDetail}${o.testDetail ? " | " + o.testDetail : ""}`);
      if (doTest ? !o.certified : !o.saved) rc = 1;
    }
    printActivationGate();
  }

  if (wrote) {
    console.log(`settling ${SETTLE_MS / 1000}s for async KB syncs…`);
    await new Promise((r) => setTimeout(r, SETTLE_MS));
  }
  return rc;
}

main()
  .then((rc) => { process.exitCode = rc; })
  .catch((e) => { console.error(e); process.exitCode = 2; });
