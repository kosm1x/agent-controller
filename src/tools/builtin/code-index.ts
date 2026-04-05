/**
 * Code indexer — extracts exported symbols from TypeScript source files.
 *
 * Regex-based (no tree-sitter dep). Extracts: functions, classes, interfaces,
 * types, constants, enums. Stores in SQLite for fast querying via code_search tool.
 *
 * Refresh: on boot + on jarvis_dev branch switch.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { getDatabase, writeWithRetry } from "../../db/index.js";

const MC_DIR = "/root/claude/mission-control";
const SRC_DIR = join(MC_DIR, "src");

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "const"
  | "enum";

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  file: string; // relative to MC_DIR (e.g. "src/runners/fast-runner.ts")
  line: number;
  exported: boolean;
  signature: string; // first line of the declaration
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS code_index (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL,
  kind      TEXT NOT NULL,
  file      TEXT NOT NULL,
  line      INTEGER NOT NULL,
  exported  INTEGER NOT NULL DEFAULT 1,
  signature TEXT NOT NULL DEFAULT '',
  indexed_at TEXT DEFAULT (datetime('now'))
)`;

const CREATE_IDX = `CREATE INDEX IF NOT EXISTS idx_code_index_name ON code_index(name COLLATE NOCASE)`;
const CREATE_IDX_FILE = `CREATE INDEX IF NOT EXISTS idx_code_index_file ON code_index(file)`;

function ensureTable(): void {
  const db = getDatabase();
  db.exec(CREATE_TABLE);
  db.exec(CREATE_IDX);
  db.exec(CREATE_IDX_FILE);
}

// ---------------------------------------------------------------------------
// Extraction regexes
// ---------------------------------------------------------------------------

const SYMBOL_PATTERNS: Array<{ re: RegExp; kind: SymbolKind }> = [
  {
    re: /^(export\s+)?(?:async\s+)?function\s+(\w+)/,
    kind: "function",
  },
  {
    re: /^(export\s+)?class\s+(\w+)/,
    kind: "class",
  },
  {
    re: /^(export\s+)?interface\s+(\w+)/,
    kind: "interface",
  },
  {
    re: /^(export\s+)?type\s+(\w+)\s*=/,
    kind: "type",
  },
  {
    re: /^(export\s+)?const\s+(\w+)\s*[=:]/,
    kind: "const",
  },
  {
    re: /^(export\s+)?enum\s+(\w+)/,
    kind: "enum",
  },
];

/** @internal Exported for testing only. */
export function extractSymbols(filePath: string): CodeSymbol[] {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const symbols: CodeSymbol[] = [];
  const relPath = relative(MC_DIR, filePath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimStart();
    for (const { re, kind } of SYMBOL_PATTERNS) {
      const match = line.match(re);
      if (match) {
        symbols.push({
          name: match[2],
          kind,
          file: relPath,
          line: i + 1,
          exported: !!match[1],
          signature: lines[i].trim().slice(0, 200),
        });
        break; // one match per line
      }
    }
  }

  return symbols;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function findTsFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git")
        continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        results.push(...findTsFiles(full));
      } else if (
        entry.endsWith(".ts") &&
        !entry.endsWith(".test.ts") &&
        !entry.endsWith(".d.ts")
      ) {
        results.push(full);
      }
    }
  } catch {
    // permission error, etc.
  }
  return results;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Rebuild the entire code index from source files.
 * ~218 files, ~879 symbols, takes <500ms.
 */
export function rebuildIndex(): { files: number; symbols: number } {
  ensureTable();
  const db = getDatabase();

  // Clear existing
  db.exec("DELETE FROM code_index");

  const files = findTsFiles(SRC_DIR);
  let totalSymbols = 0;

  const insert = db.prepare(
    `INSERT INTO code_index (name, kind, file, line, exported, signature) VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const tx = db.transaction(() => {
    for (const file of files) {
      const symbols = extractSymbols(file);
      for (const s of symbols) {
        insert.run(
          s.name,
          s.kind,
          s.file,
          s.line,
          s.exported ? 1 : 0,
          s.signature,
        );
      }
      totalSymbols += symbols.length;
    }
  });

  writeWithRetry(() => tx());

  console.log(
    `[code-index] Indexed ${totalSymbols} symbols from ${files.length} files`,
  );

  return { files: files.length, symbols: totalSymbols };
}

/**
 * Search the code index by name (case-insensitive) or keyword in signature.
 */
export function searchCode(
  query: string,
  opts?: { kind?: SymbolKind; limit?: number },
): CodeSymbol[] {
  ensureTable();
  const db = getDatabase();
  const limit = opts?.limit ?? 20;

  let sql = `SELECT name, kind, file, line, exported, signature FROM code_index WHERE (name LIKE ? OR signature LIKE ?)`;
  const params: unknown[] = [`%${query}%`, `%${query}%`];

  if (opts?.kind) {
    sql += ` AND kind = ?`;
    params.push(opts.kind);
  }

  sql += ` ORDER BY exported DESC, name COLLATE NOCASE LIMIT ?`;
  params.push(limit);

  return db.prepare(sql).all(...params) as CodeSymbol[];
}

/**
 * Get all symbols in a specific file.
 */
export function symbolsInFile(filePath: string): CodeSymbol[] {
  ensureTable();
  const db = getDatabase();
  return db
    .prepare(
      `SELECT name, kind, file, line, exported, signature FROM code_index WHERE file = ? ORDER BY line`,
    )
    .all(filePath) as CodeSymbol[];
}
