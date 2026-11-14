/**
 * Knowledge maps on the real schema through initDatabase(":memory:"): the
 * node `type` CHECK, the NOT NULL columns, the `map_id` foreign key (ON) and
 * the `nextNodeSeq` SUBSTR/CAST arithmetic only exist in the real tables, so
 * every statement of the module runs against them here.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { initDatabase, closeDatabase } from "./index.js";
import {
  getMap,
  getMapByTopic,
  searchMaps,
  upsertMap,
  updateMapStats,
  deleteMap,
  getNodes,
  getNode,
  getChildNodes,
  countNodes,
  getMaxDepth,
  insertNodes,
  nextNodeSeq,
} from "./knowledge-maps.js";

const OLD = "2000-01-01 00:00:00";

type NodeIn = Parameters<typeof insertNodes>[0][number];

function node(
  id: string,
  depth: number,
  parent: string | null,
  mapId = "m",
): NodeIn {
  return {
    id,
    map_id: mapId,
    label: `label ${id}`,
    type: "concept",
    summary: `summary ${id}`,
    depth,
    parent_id: parent,
  };
}

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

describe("maps", () => {
  it("upsertMap inserts with zero stats and getMap/getMapByTopic read it back", () => {
    upsertMap("solar-energy", "Solar Energy");
    const map = getMap("solar-energy");
    expect(map).toMatchObject({
      id: "solar-energy",
      topic: "Solar Energy",
      node_count: 0,
      max_depth: 0,
    });
    expect(map?.created_at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    expect(getMapByTopic("Solar  Energy!")?.id).toBe("solar-energy");
    expect(getMap("missing")).toBeNull();
  });

  it("a second upsertMap of the same id updates topic and updated_at, keeps created_at", () => {
    upsertMap("m", "First");
    db.prepare(
      "UPDATE knowledge_maps SET created_at = ?, updated_at = ? WHERE id = 'm'",
    ).run(OLD, OLD);
    upsertMap("m", "Second");
    const rows = db.prepare("SELECT * FROM knowledge_maps").all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ topic: "Second", created_at: OLD });
    expect((rows[0] as { updated_at: string }).updated_at).not.toBe(OLD);
  });

  it("searchMaps requires every long keyword, ignores case, orders newest first, caps at five", () => {
    const stamp = db.prepare(
      "UPDATE knowledge_maps SET updated_at = ? WHERE id = ?",
    );
    for (let i = 1; i <= 6; i++) {
      upsertMap(`t${i}`, `Telecom Regulation part ${i}`);
      stamp.run(`2020-01-0${i} 00:00:00`, `t${i}`);
    }
    upsertMap("other", "Telecom pricing");
    expect(searchMaps("telecom regulation").map((m) => m.id)).toEqual([
      "t6",
      "t5",
      "t4",
      "t3",
      "t2",
    ]);
    expect(searchMaps("pricing of telecom").map((m) => m.id)).toEqual([
      "other",
    ]);
    expect(searchMaps("the of a")).toEqual([]);
  });

  it("updateMapStats writes node count, max depth and a new updated_at", () => {
    upsertMap("m", "Topic");
    insertNodes([node("m/n-1", 0, null), node("m/n-2", 1, "m/n-1")]);
    db.prepare("UPDATE knowledge_maps SET updated_at = ? WHERE id = 'm'").run(
      OLD,
    );
    updateMapStats("m");
    const map = getMap("m");
    expect(map).toMatchObject({ node_count: 2, max_depth: 1 });
    expect(map?.updated_at).not.toBe(OLD);
  });

  it("deleteMap removes the map and its nodes only, and reports whether it existed", () => {
    upsertMap("m", "Topic");
    upsertMap("keep", "Kept");
    insertNodes([node("m/n-1", 0, null), node("keep/n-1", 0, null, "keep")]);
    expect(deleteMap("m")).toBe(true);
    expect(getMap("m")).toBeNull();
    expect(countNodes("m")).toBe(0);
    expect(getMap("keep")).not.toBeNull();
    expect(countNodes("keep")).toBe(1);
    expect(deleteMap("m")).toBe(false);
  });

  // deleteMap removes the nodes itself rather than relying on the cascade, so
  // a handle without foreign keys still leaves no orphan nodes.
  it("deleteMap removes the map's nodes even with foreign keys off", () => {
    upsertMap("m", "Topic");
    upsertMap("keep", "Kept");
    insertNodes([node("m/n-1", 0, null), node("keep/n-1", 0, null, "keep")]);
    db.pragma("foreign_keys = OFF");
    expect(deleteMap("m")).toBe(true);
    expect(countNodes("m")).toBe(0);
    expect(countNodes("keep")).toBe(1);
  });
});

describe("nodes", () => {
  beforeEach(() => {
    upsertMap("m", "Topic");
  });

  it("insertNodes stores every column and the readers return the tree", () => {
    const inserted = insertNodes([
      node("m/n-3", 2, "m/n-2"),
      node("m/n-2", 1, "m/n-1"),
      node("m/n-4", 1, "m/n-1"),
      { ...node("m/n-1", 0, null), type: "gotcha" },
    ]);
    expect(inserted).toBe(4);
    expect(getNode("m/n-1")).toMatchObject({
      id: "m/n-1",
      map_id: "m",
      label: "label m/n-1",
      type: "gotcha",
      summary: "summary m/n-1",
      depth: 0,
      parent_id: null,
    });
    expect(getNode("m/n-9")).toBeNull();
    expect(getNodes("m").map((n) => n.id)).toEqual([
      "m/n-1",
      "m/n-2",
      "m/n-4",
      "m/n-3",
    ]);
    expect(getChildNodes("m/n-1").map((n) => n.id)).toEqual([
      "m/n-2",
      "m/n-4",
    ]);
    expect(countNodes("m")).toBe(4);
    expect(getMaxDepth("m")).toBe(2);
  });

  it("an empty map counts zero nodes, depth zero and next sequence one", () => {
    expect(countNodes("m")).toBe(0);
    expect(getMaxDepth("m")).toBe(0);
    expect(nextNodeSeq("m")).toBe(1);
  });

  it("insertNodes skips a duplicate id and keeps the first row", () => {
    insertNodes([node("m/n-1", 0, null)]);
    const again = insertNodes([
      { ...node("m/n-1", 3, null), label: "replacement" },
    ]);
    expect(again).toBe(0);
    expect(getNode("m/n-1")).toMatchObject({ label: "label m/n-1", depth: 0 });
  });

  // INSERT OR IGNORE applies IGNORE to CHECK and NOT NULL violations too: a
  // node with a type outside the CHECK, or a NULL label, is dropped without an
  // error and only the returned count shows it.
  it("insertNodes silently drops a node whose type fails the CHECK or whose label is NULL", () => {
    const inserted = insertNodes([
      node("m/n-1", 0, null),
      { ...node("m/n-2", 0, null), type: "bogus" as NodeIn["type"] },
      { ...node("m/n-3", 0, null), label: null as unknown as string },
    ]);
    expect(inserted).toBe(1);
    expect(getNode("m/n-2")).toBeNull();
    expect(getNode("m/n-3")).toBeNull();
    expect(countNodes("m")).toBe(1);
  });

  // The ON CONFLICT clause does not apply to foreign keys: a node for a map
  // that does not exist aborts the batch and the transaction rolls it back.
  it("insertNodes throws on an unknown map_id and keeps none of the batch", () => {
    expect(() =>
      insertNodes([node("m/n-1", 0, null), node("x/n-1", 0, null, "x")]),
    ).toThrow(/FOREIGN KEY/);
    expect(countNodes("m")).toBe(0);
  });

  it("nextNodeSeq takes the numeric maximum of this map's n- ids", () => {
    upsertMap("m2", "Other");
    insertNodes([
      node("m/n-3", 0, null),
      node("m/n-10", 0, null),
      node("m/n-9", 0, null),
      node("m/root", 0, null),
      node("m2/n-50", 0, null, "m2"),
    ]);
    expect(nextNodeSeq("m")).toBe(11);
    expect(nextNodeSeq("m2")).toBe(51);
  });
});
