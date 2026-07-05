/**
 * One-off validation harness for the Phase 4.3 schema-version migration gate
 * (2026-07-05). Per CLAUDE.md "Validating a risky / never-run path": exercises
 * initDatabase against ISOLATED copies, never live state.
 *
 * Usage (one mode per process — initDatabase is a singleton):
 *   npx tsx scripts/validate-migration-runner.ts fresh    /tmp/x/fresh.db
 *   npx tsx scripts/validate-migration-runner.ts migrated /tmp/x/snap.db   # pre-copied live snapshot
 *   npx tsx scripts/validate-migration-runner.ts reboot   /tmp/x/snap.db   # 2nd boot of the migrated copy
 *
 * Each run prints a JSON signature {mode, userVersion, tables:{name:[cols]}, indexes:[...]}.
 * Compare: fresh ⊆ migrated on tables+columns (legacy DBs may carry retired
 * extra tables); baseline_history absent in BOTH; userVersion === 2 everywhere;
 * reboot signature must equal migrated signature.
 */

import { initDatabase } from "../src/db/index.js";

const [mode, dbPath] = process.argv.slice(2);
if (!mode || !dbPath) {
  console.error(
    "usage: validate-migration-runner.ts <fresh|migrated|reboot> <dbPath>",
  );
  process.exit(2);
}

const db = initDatabase(dbPath);

const tables = db
  .prepare(
    `SELECT name FROM sqlite_master WHERE type='table'
     AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'
     ORDER BY name`,
  )
  .all() as Array<{ name: string }>;

const signature: Record<string, string[]> = {};
for (const t of tables) {
  const cols = db
    .prepare(`PRAGMA table_info(${JSON.stringify(t.name)})`)
    .all() as Array<{
    name: string;
  }>;
  signature[t.name] = cols.map((c) => c.name).sort();
}

const indexes = (
  db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='index'
       AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all() as Array<{ name: string }>
).map((i) => i.name);

console.log(
  JSON.stringify({
    mode,
    userVersion: db.pragma("user_version", { simple: true }),
    tableCount: tables.length,
    tables: signature,
    indexes,
  }),
);
