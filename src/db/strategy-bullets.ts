/**
 * Strategy bullets — ACE-inspired per-instruction scoring.
 *
 * Each bullet is a discrete strategy/insight with helpful/harmful counters
 * that evolve based on task outcomes. Bullets are organized by section
 * (strategies, mistakes, heuristics, etc.) and can be injected into prompts
 * with preference for high-performing entries.
 */

import { getDatabase } from "./index.js";

// ---------------------------------------------------------------------------
// Section slug mapping (mirrors ACE playbook sections)
// ---------------------------------------------------------------------------

const SECTION_SLUGS: Record<string, string> = {
  strategies: "str",
  mistakes: "mis",
  heuristics: "heu",
  formulas: "cal",
  templates: "tpl",
  context: "ctx",
  other: "oth",
};

function slugFor(section: string): string {
  return SECTION_SLUGS[section] ?? section.slice(0, 3).toLowerCase();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StrategyBullet {
  bullet_id: string;
  section: string;
  content: string;
  helpful_count: number;
  harmful_count: number;
  source: string;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface BulletStats {
  total: number;
  active: number;
  highPerforming: number;
  problematic: number;
  unused: number;
  bySection: Record<string, number>;
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

/** Insert a new strategy bullet. Returns the generated bullet_id. */
export function insertBullet(
  section: string,
  content: string,
  source = "reflector",
): string {
  const db = getDatabase();
  const slug = slugFor(section);

  // Atomic SELECT+INSERT to prevent TOCTOU race on bullet_id
  const insertTx = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT bullet_id FROM strategy_bullets
         WHERE bullet_id LIKE ? || '-%'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(slug) as { bullet_id: string } | undefined;

    let nextNum = 1;
    if (row) {
      const match = row.bullet_id.match(/-(\d+)$/);
      if (match) nextNum = parseInt(match[1], 10) + 1;
    }

    const bulletId = `${slug}-${String(nextNum).padStart(5, "0")}`;

    db.prepare(
      `INSERT INTO strategy_bullets (bullet_id, section, content, source)
       VALUES (?, ?, ?, ?)`,
    ).run(bulletId, section, content, source);

    return bulletId;
  });

  const bulletId = insertTx();

  return bulletId;
}

/** Increment helpful or harmful counter for a bullet. */
export function updateBulletCounts(
  bulletId: string,
  tag: "helpful" | "harmful",
): void {
  const db = getDatabase();
  const col = tag === "helpful" ? "helpful_count" : "harmful_count";
  db.prepare(
    `UPDATE strategy_bullets
     SET ${col} = ${col} + 1, updated_at = datetime('now')
     WHERE bullet_id = ?`,
  ).run(bulletId);
}

/** Get top-performing active bullets, sorted by net score (helpful - harmful). */
export function getTopBullets(limit = 10, minHelpful = 0): StrategyBullet[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT * FROM strategy_bullets
       WHERE active = 1 AND helpful_count >= ?
       ORDER BY (helpful_count - harmful_count) DESC, helpful_count DESC
       LIMIT ?`,
    )
    .all(minHelpful, limit) as StrategyBullet[];
}

/** Get problematic bullets where harmful >= helpful. */
export function getProblematicBullets(minHarmful = 1): StrategyBullet[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT * FROM strategy_bullets
       WHERE active = 1
         AND harmful_count >= ?
         AND harmful_count >= helpful_count
       ORDER BY harmful_count DESC`,
    )
    .all(minHarmful) as StrategyBullet[];
}

/** Soft-delete a bullet by setting active = 0. */
export function deactivateBullet(bulletId: string): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE strategy_bullets
     SET active = 0, updated_at = datetime('now')
     WHERE bullet_id = ?`,
  ).run(bulletId);
}

/** Get aggregate stats about the bullet table. */
export function getBulletStats(): BulletStats {
  const db = getDatabase();

  const totals = db
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(active) as active,
         SUM(CASE WHEN helpful_count > 5 AND harmful_count < 2 THEN 1 ELSE 0 END) as high_performing,
         SUM(CASE WHEN harmful_count >= helpful_count AND harmful_count > 0 THEN 1 ELSE 0 END) as problematic,
         SUM(CASE WHEN helpful_count + harmful_count = 0 THEN 1 ELSE 0 END) as unused
       FROM strategy_bullets`,
    )
    .get() as {
    total: number;
    active: number;
    high_performing: number;
    problematic: number;
    unused: number;
  };

  const sections = db
    .prepare(
      `SELECT section, COUNT(*) as count
       FROM strategy_bullets WHERE active = 1
       GROUP BY section`,
    )
    .all() as { section: string; count: number }[];

  const bySection: Record<string, number> = {};
  for (const s of sections) bySection[s.section] = s.count;

  return {
    total: totals.total,
    active: totals.active,
    highPerforming: totals.high_performing,
    problematic: totals.problematic,
    unused: totals.unused,
    bySection,
  };
}
