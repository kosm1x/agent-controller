/**
 * Knowledge Maps — Layer 0 infrastructure for Prometheus domain understanding.
 *
 * Structured concept maps (8-12 nodes) cached in SQLite, reusable across tasks.
 * Each node is typed (concept | pattern | gotcha) with wikilink-in-prose summaries.
 */

import { getDatabase } from "./index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max nodes per knowledge map. */
export const MAX_NODES_PER_MAP = 60;

/** Max tree depth for node expansion. */
export const MAX_DEPTH = 5;

/** Map freshness TTL in days. */
export const MAP_TTL_DAYS = 7;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KnowledgeMap {
  id: string;
  topic: string;
  node_count: number;
  max_depth: number;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeNode {
  id: string;
  map_id: string;
  label: string;
  type: "concept" | "pattern" | "gotcha";
  summary: string;
  depth: number;
  parent_id: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Convert a topic string to a URL-safe slug. */
export function slugify(topic: string): string {
  return topic
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/[^a-z0-9\s-]/g, "") // strip non-alphanumeric
    .trim()
    .replace(/\s+/g, "-") // spaces to hyphens
    .replace(/-+/g, "-"); // collapse multiple hyphens
}

/** Check if a map is stale (older than TTL). */
export function isStale(map: KnowledgeMap): boolean {
  const updated = new Date(map.updated_at + "Z").getTime();
  const ttl = MAP_TTL_DAYS * 24 * 60 * 60 * 1000;
  return Date.now() - updated > ttl;
}

// ---------------------------------------------------------------------------
// Map operations
// ---------------------------------------------------------------------------

/** Get a map by its ID (slug). */
export function getMap(mapId: string): KnowledgeMap | null {
  const db = getDatabase();
  return (
    (db.prepare("SELECT * FROM knowledge_maps WHERE id = ?").get(mapId) as
      | KnowledgeMap
      | undefined) ?? null
  );
}

/** Find a map by topic string (slugifies then looks up). */
export function getMapByTopic(topic: string): KnowledgeMap | null {
  return getMap(slugify(topic));
}

/** Search for maps whose topic contains the given keywords (LIKE match). */
export function searchMaps(query: string): KnowledgeMap[] {
  const db = getDatabase();
  const keywords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3);
  if (keywords.length === 0) return [];

  const conditions = keywords.map(() => "topic LIKE ?");
  const params = keywords.map((k) => `%${k}%`);

  return db
    .prepare(
      `SELECT * FROM knowledge_maps WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC LIMIT 5`,
    )
    .all(...params) as KnowledgeMap[];
}

/** Create or update a map entry. */
export function upsertMap(mapId: string, topic: string): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO knowledge_maps (id, topic) VALUES (?, ?)
     ON CONFLICT(id) DO UPDATE SET topic = excluded.topic, updated_at = datetime('now')`,
  ).run(mapId, topic);
}

/** Update node_count and max_depth on a map. */
export function updateMapStats(mapId: string): void {
  const db = getDatabase();
  const stats = db
    .prepare(
      "SELECT COUNT(*) as cnt, COALESCE(MAX(depth), 0) as maxd FROM knowledge_nodes WHERE map_id = ?",
    )
    .get(mapId) as { cnt: number; maxd: number };
  db.prepare(
    "UPDATE knowledge_maps SET node_count = ?, max_depth = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(stats.cnt, stats.maxd, mapId);
}

/** Delete a map and its nodes (CASCADE). */
export function deleteMap(mapId: string): boolean {
  const db = getDatabase();
  // CASCADE may not be enforced by default in SQLite — delete nodes explicitly
  db.prepare("DELETE FROM knowledge_nodes WHERE map_id = ?").run(mapId);
  const result = db
    .prepare("DELETE FROM knowledge_maps WHERE id = ?")
    .run(mapId);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Node operations
// ---------------------------------------------------------------------------

/** Get all nodes for a map, ordered by depth then id. */
export function getNodes(mapId: string): KnowledgeNode[] {
  const db = getDatabase();
  return db
    .prepare(
      "SELECT * FROM knowledge_nodes WHERE map_id = ? ORDER BY depth ASC, id ASC",
    )
    .all(mapId) as KnowledgeNode[];
}

/** Get a single node by id. */
export function getNode(nodeId: string): KnowledgeNode | null {
  const db = getDatabase();
  return (
    (db.prepare("SELECT * FROM knowledge_nodes WHERE id = ?").get(nodeId) as
      | KnowledgeNode
      | undefined) ?? null
  );
}

/** Get child nodes of a parent. */
export function getChildNodes(parentId: string): KnowledgeNode[] {
  const db = getDatabase();
  return db
    .prepare(
      "SELECT * FROM knowledge_nodes WHERE parent_id = ? ORDER BY id ASC",
    )
    .all(parentId) as KnowledgeNode[];
}

/** Count nodes in a map. */
export function countNodes(mapId: string): number {
  const db = getDatabase();
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM knowledge_nodes WHERE map_id = ?")
    .get(mapId) as { cnt: number };
  return row.cnt;
}

/** Get max depth in a map. */
export function getMaxDepth(mapId: string): number {
  const db = getDatabase();
  const row = db
    .prepare(
      "SELECT COALESCE(MAX(depth), 0) as maxd FROM knowledge_nodes WHERE map_id = ?",
    )
    .get(mapId) as { maxd: number };
  return row.maxd;
}

/** Batch insert nodes in a transaction. Uses INSERT OR IGNORE for idempotency. */
export function insertNodes(
  nodes: Array<{
    id: string;
    map_id: string;
    label: string;
    type: "concept" | "pattern" | "gotcha";
    summary: string;
    depth: number;
    parent_id: string | null;
  }>,
): number {
  const db = getDatabase();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO knowledge_nodes (id, map_id, label, type, summary, depth, parent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  let inserted = 0;
  const tx = db.transaction(() => {
    for (const n of nodes) {
      const result = stmt.run(
        n.id,
        n.map_id,
        n.label,
        n.type,
        n.summary,
        n.depth,
        n.parent_id,
      );
      inserted += result.changes;
    }
  });
  tx();
  return inserted;
}

/** Get the next sequential node number for a map (MAX-based, survives deletions). */
export function nextNodeSeq(mapId: string): number {
  const db = getDatabase();
  const prefix = `${mapId}/n-`;
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(CAST(SUBSTR(id, LENGTH(?) + 1) AS INTEGER)), 0) as maxseq
       FROM knowledge_nodes WHERE map_id = ? AND id LIKE ?`,
    )
    .get(prefix, mapId, `${prefix}%`) as { maxseq: number };
  return row.maxseq + 1;
}
