// Operator one-shot (2026-10-06): retire the COMMIT sync from three KB directives.
//
// The `northstar_sync` tool was removed from the codebase; these directive lines
// still name it (core.md rule 13) or carry a COMMIT recurring task. Same write
// path as scripts/kb-preview-directive.mjs: upsertFile() updates the
// `jarvis_files` registry row AND the mirror file (a filesystem edit alone never
// reaches the registry). Title, tags, qualifier, priority, condition and
// related_to are written back unchanged from the current row (checked after).
//
// All-or-nothing: every target is checked before anything is written. The run
// refuses (exit 2, nothing written) unless each target's mirror file exists and
// is byte-equal to its registry row, and the row either carries its expected
// text once with no other `northstar_sync`/`COMMIT` mention after the edit, or
// is already fully applied. core.md is matched by fragment, not by its full
// rule text (this repo is public): `northstar_sync o ` must occur exactly once,
// on a line starting with `13. `, and only that fragment is removed.
// Exit 0 = applied, already applied, or --dry-run; exit 1 = verification
// failed, a write failed (PARTIAL apply, named in the error), or another error;
// exit 2 = refused, nothing written.
//
// --dry-run still opens the database READ-WRITE through initDatabase (schema
// exec + SCHEMA_MIGRATIONS + directive seeding): idempotent with the deployed
// dist/, but not a read-only open. Only the jarvis_files registry rows and the
// mirror files are updated: the pgvector and Google Drive copies are
// fire-and-forget in upsertFile and are not updated from an operator shell
// (the process exits first); they catch up on the next write of each file.
//
// Usage (operator shell, after deploy so dist/ is current). BOTH env vars must
// be UNSET for the live run (a mixed state refuses before opening anything):
//   env -u MC_DB_PATH -u JARVIS_KB_MIRROR_DIR node /root/claude/mission-control/scripts/kb-retire-commit-directives-2026-10-06.mjs --dry-run
//   env -u MC_DB_PATH -u JARVIS_KB_MIRROR_DIR node /root/claude/mission-control/scripts/kb-retire-commit-directives-2026-10-06.mjs
// Scratch runs set BOTH MC_DB_PATH (not the live db) and JARVIS_KB_MIRROR_DIR.
// The mirror dir printed is where writes go (getKbMirrorWriteDir in
// dist/db/jarvis-fs.js); a disabled mirror (null) refuses.
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

const LIVE_DB = "/root/claude/mission-control/data/mc.db";
const DRY_RUN = process.argv.includes("--dry-run");

// Mixed env states refuse BEFORE anything under dist/ is imported or any db is
// opened (the imports below are dynamic for this reason): the live db with only
// the mirror override set would edit the live registry, write the mirror files
// to the override dir and leave the live mirror stale.
{
  const envDb = process.env.MC_DB_PATH;
  const envMirror = process.env.JARVIS_KB_MIRROR_DIR;
  let why = null;
  if (envDb === "" || envMirror === "") why = "MC_DB_PATH / JARVIS_KB_MIRROR_DIR is set but empty";
  else if ((envDb === undefined) !== (envMirror === undefined))
    why = `only ${envDb === undefined ? "JARVIS_KB_MIRROR_DIR" : "MC_DB_PATH"} is set; set both (scratch run) or unset both (live run)`;
  else if (envDb !== undefined && existsSync(envDb) && realpathSync(envDb) === realpathSync(LIVE_DB))
    why = "MC_DB_PATH is the live db while JARVIS_KB_MIRROR_DIR is set; unset both for the live run";
  if (why) {
    console.error(`REFUSED (nothing opened, nothing written): ${why}`);
    process.exit(2);
  }
}

const { initDatabase, closeDatabase } = await import("/root/claude/mission-control/dist/db/index.js");
const { upsertFile, getFile, getKbMirrorWriteDir } = await import("/root/claude/mission-control/dist/db/jarvis-fs.js");

const DB_PATH = process.env.MC_DB_PATH ?? LIVE_DB;

const CORE_FRAGMENT = "northstar_sync o ";
const CORE_LINE_PREFIX = "13. ";

/** Each edit: the exact current line and its replacement (null = remove the line), or core.md's fragment. */
const EDITS = [
  { path: "directives/core.md", fragment: CORE_FRAGMENT },
  { path: "directives/northstar-recurring-tasks.md", old: '  - "Testear la funcionalidad de COMMIT [recurring]"', next: null },
  { path: "directives/northstar_recurring_tasks.md", old: "- Testear la funcionalidad de COMMIT [recurring]", next: null },
];

const META = ["id", "title", "tags", "qualifier", "condition", "priority", "related_to", "created_at"];
const residual = (s) => (s.match(/northstar_sync|COMMIT/g) ?? []).length;
const count = (s, sub) => s.split(sub).length - 1;

class Refusal extends Error {}

/** Strict JSON-array column: must round-trip byte-identically through upsertFile. */
function strictList(path, col, raw) {
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Refusal(`${path}: ${col} is not valid JSON — refusing`);
  }
  if (!Array.isArray(v) || JSON.stringify(v) !== raw)
    throw new Refusal(`${path}: ${col} would not round-trip unchanged — refusing`);
  return v;
}

/** core.md: remove the one fragment on the rule-13 line. Returns { out, at } or { applied }. */
function planFragment(e, content) {
  const lines = content.split("\n");
  const n = count(content, e.fragment);
  if (n === 0) {
    const applied = count(content, "northstar_sync") === 0 && residual(content) === 0 && lines.some((l) => l.startsWith(CORE_LINE_PREFIX));
    if (!applied) throw new Refusal(`${e.path}: expected fragment not found and edit not already applied — refusing`);
    return { applied: true, at: -1, out: content };
  }
  if (n !== 1) throw new Refusal(`${e.path}: expected fragment occurs ${n} times, not once — refusing`);
  const at = lines.findIndex((l) => l.includes(e.fragment));
  if (!lines[at].startsWith(CORE_LINE_PREFIX))
    throw new Refusal(`${e.path}: expected fragment is not on a line starting with "${CORE_LINE_PREFIX}" — refusing`);
  const i = content.indexOf(e.fragment);
  const out = content.slice(0, i) + content.slice(i + e.fragment.length);
  if (out.length !== content.length - e.fragment.length || count(out, "northstar_sync") !== 0 || residual(out) !== 0)
    throw new Refusal(`${e.path}: other northstar_sync/COMMIT mentions remain after the edit — refusing`);
  return { applied: false, at, out };
}

/** Recurring-task files: remove the one exact line. Returns { out, at } or { applied }. */
function planLine(e, content) {
  const lines = content.split("\n");
  const at = lines.indexOf(e.old);
  if (at === -1) {
    const applied = residual(content) === 0 && (e.next === null || lines.includes(e.next));
    if (!applied) throw new Refusal(`${e.path}: expected line not found and edit not already applied — refusing`);
    return { applied: true, at: -1, out: content };
  }
  if (lines.indexOf(e.old, at + 1) !== -1) throw new Refusal(`${e.path}: expected line occurs more than once — refusing`);
  const next = [...lines];
  if (e.next === null) next.splice(at, 1);
  else next[at] = e.next;
  const out = next.join("\n");
  if (residual(out) !== 0) throw new Refusal(`${e.path}: other northstar_sync/COMMIT mentions remain after the edit — refusing`);
  return { applied: false, at, out };
}

console.log(`db: ${DB_PATH}${DRY_RUN ? " (dry run)" : ""}`);
initDatabase(DB_PATH);
let exitCode = 0;
const written = [];
try {
  const mirrorDir = getKbMirrorWriteDir();
  console.log(`mirror write dir: ${mirrorDir}`);
  if (mirrorDir === null) throw new Refusal("KB mirror writes are disabled for this db (null write dir) — refusing");

  // Plan every edit first; refuse the whole run if any target is unexpected.
  const plans = [];
  for (const e of EDITS) {
    const row = getFile(e.path);
    if (!row) throw new Refusal(`${e.path}: not in the jarvis_files registry — refusing`);
    const tags = strictList(e.path, "tags", row.tags);
    const relatedTo = strictList(e.path, "related_to", row.related_to);
    const mirror = join(mirrorDir, e.path);
    if (!existsSync(mirror)) throw new Refusal(`${mirror}: mirror file missing — refusing`);
    if (readFileSync(mirror, "utf-8") !== row.content)
      throw new Refusal(`${mirror}: mirror file differs from the registry row — refusing`);
    const p = e.fragment ? planFragment(e, row.content) : planLine(e, row.content);
    plans.push({ e, row, tags, relatedTo, mirror, ...p });
  }

  for (const p of plans) {
    if (p.applied) {
      console.log(`[skip] ${p.e.path}: already applied`);
      continue;
    }
    if (p.e.fragment) {
      console.log(`[edit] ${p.e.path} line ${p.at + 1}: remove "${p.e.fragment}" (${p.row.content.length} -> ${p.out.length} chars)`);
    } else {
      console.log(`[edit] ${p.e.path} line ${p.at + 1}`);
      console.log(`  - ${p.e.old}`);
      console.log(p.e.next === null ? "  + (line removed)" : `  + ${p.e.next}`);
    }
  }
  if (!DRY_RUN) {
    for (const p of plans) {
      if (p.applied) continue;
      const r = p.row;
      try {
        upsertFile(p.e.path, r.title, p.out, p.tags, r.qualifier, r.priority, r.condition, p.relatedTo);
      } catch (err) {
        const notWritten = plans.filter((q) => !q.applied && !written.includes(q.e.path)).map((q) => q.e.path);
        throw new Error(
          `PARTIAL apply — write of ${p.e.path} failed (${err.message}). Written: ${written.length ? written.join(", ") : "(none)"}. ` +
            `Not written: ${notWritten.join(", ")}. A re-run converges: written targets are detected as already applied.`,
        );
      }
      written.push(p.e.path);
    }
  }

  // Verification: registry content is what was planned (or untouched on a dry
  // run), metadata unchanged, registry == mirror, no residual mentions.
  let ok = true;
  for (const p of plans) {
    const row = getFile(p.e.path);
    const expected = DRY_RUN ? p.row.content : p.out;
    const contentOk = row.content === expected;
    const metaOk = META.every((k) => row[k] === p.row[k]);
    const disk = existsSync(p.mirror) ? readFileSync(p.mirror, "utf-8") : null;
    const agree = disk === row.content;
    const left = residual(row.content);
    console.log(
      `[verify] ${p.e.path}: content-as-planned ${contentOk}; metadata-unchanged ${metaOk}; registry==mirror ${agree}; northstar_sync|COMMIT count ${left}`,
    );
    if (!contentOk || !metaOk || !agree || (!DRY_RUN && left !== 0)) ok = false;
  }
  if (!ok) exitCode = 1;
  console.log(DRY_RUN ? (ok ? "DRY RUN — nothing changed." : "DRY RUN — VERIFY FAILED") : ok ? "DONE" : "VERIFY FAILED");
} catch (err) {
  console.error(err instanceof Refusal ? `REFUSED (nothing written): ${err.message}` : `ERROR: ${err.message}`);
  exitCode = err instanceof Refusal ? 2 : 1;
} finally {
  closeDatabase();
}
process.exit(exitCode);
