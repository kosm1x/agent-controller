/**
 * `db/user-facts` statements on the real schema (`initDatabase(":memory:")`).
 * user-facts.test.ts stubs the database, so a wrong key, conflict target,
 * assignment or order passes there. The key is (category, key): every keyed
 * write acts on a row with a neighbour on both sides in EACH column that must
 * stay unchanged, and every sorted read is seeded so that insertion order and
 * the other sort column give a different answer.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "./index.js";
import { deleteUserFact, getUserFacts, setUserFact } from "./user-facts.js";

const OLD_CREATED = "2001-01-01 00:00:00";
const OLD_UPDATED = "2002-02-02 00:00:00";
const STAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

type RawFact = {
  id: number;
  category: string;
  key: string;
  value: string;
  source: string | null;
  created_at: string;
  updated_at: string;
};

const all = (): RawFact[] =>
  getDatabase().prepare("SELECT * FROM user_facts ORDER BY id").all() as RawFact[];

const raw = (category: string, key: string): RawFact | undefined =>
  getDatabase()
    .prepare("SELECT * FROM user_facts WHERE category = ? AND key = ?")
    .get(category, key) as RawFact | undefined;

function seed(category: string, key: string, value: string, updatedAt = OLD_UPDATED): void {
  getDatabase()
    .prepare(
      "INSERT INTO user_facts (category, key, value, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(category, key, value, `src-${category}-${key}`, OLD_CREATED, updatedAt);
}

/** The target (cat-b, k2) with a neighbour below and above it in each key column. */
function seedCross(): void {
  seed("cat-b", "k3", "v-b3");
  seed("cat-a", "k2", "v-a2");
  seed("cat-b", "k2", "v-b2");
  seed("cat-c", "k2", "v-c2");
  seed("cat-b", "k1", "v-b1");
}

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

describe("setUserFact on the real schema", () => {
  it("inserts a new fact with its own value and source; an omitted source is 'conversation'", () => {
    expect(setUserFact("cat-n", "k-given", "value-given", "source-given")).toBe(true);
    expect(setUserFact("cat-n", "k-bare", "value-bare")).toBe(true);
    expect(raw("cat-n", "k-given")).toEqual({
      id: expect.any(Number),
      category: "cat-n",
      key: "k-given",
      value: "value-given",
      source: "source-given",
      created_at: expect.stringMatching(STAMP_RE),
      updated_at: expect.stringMatching(STAMP_RE),
    });
    expect(raw("cat-n", "k-bare")).toMatchObject({
      value: "value-bare",
      source: "conversation",
    });
  });

  it("on an existing (category, key) rewrites value, source and updated_at of that row only", () => {
    seedCross();
    const before = all();
    const target = before.find((f) => f.category === "cat-b" && f.key === "k2")!;

    setUserFact("cat-b", "k2", "value-new", "source-new");

    const after = all();
    expect(after).toHaveLength(5);
    expect(after.find((f) => f.id === target.id)).toEqual({
      ...target,
      value: "value-new",
      source: "source-new",
      updated_at: expect.stringMatching(STAMP_RE),
    });
    expect(raw("cat-b", "k2")!.updated_at).not.toBe(OLD_UPDATED);
    expect(raw("cat-b", "k2")!.created_at).toBe(OLD_CREATED);
    expect(after.filter((f) => f.id !== target.id)).toEqual(
      before.filter((f) => f.id !== target.id),
    );

    // An update without a source writes the default source.
    setUserFact("cat-b", "k2", "value-again");
    expect(raw("cat-b", "k2")).toMatchObject({ value: "value-again", source: "conversation" });
  });
});

describe("getUserFacts on the real schema", () => {
  beforeEach(() => {
    // Inserted out of order; within a category the keys are not in id order,
    // and key order across categories differs from category order.
    seed("cat-b", "kz", "v-bz", "2026-01-01 10:00:01");
    seed("cat-c", "ka", "v-ca", "2026-01-01 10:00:02");
    seed("cat-b", "ka", "v-ba", "2026-01-01 10:00:03");
    seed("cat-a", "km", "v-am", "2026-01-01 10:00:04");
    seed("cat-b", "km", "v-bm", "2026-01-01 10:00:05");
  });

  const pairs = (rows: Array<{ category: string; key: string }>) =>
    rows.map((r) => `${r.category}/${r.key}`);

  it("returns every fact ordered by category, then key, with the five public columns", () => {
    const rows = getUserFacts();
    expect(pairs(rows)).toEqual(["cat-a/km", "cat-b/ka", "cat-b/km", "cat-b/kz", "cat-c/ka"]);
    expect(rows[2]).toEqual({
      category: "cat-b",
      key: "km",
      value: "v-bm",
      source: "src-cat-b-km",
      updated_at: "2026-01-01 10:00:05",
    });
  });

  it("filters by the exact category (neighbours below and above stay out), ordered by key", () => {
    expect(pairs(getUserFacts("cat-b"))).toEqual(["cat-b/ka", "cat-b/km", "cat-b/kz"]);
    expect(getUserFacts("cat-b")[0]).toEqual({
      category: "cat-b",
      key: "ka",
      value: "v-ba",
      source: "src-cat-b-ka",
      updated_at: "2026-01-01 10:00:03",
    });
    expect(pairs(getUserFacts("cat-a"))).toEqual(["cat-a/km"]);
    expect(pairs(getUserFacts("cat-c"))).toEqual(["cat-c/ka"]);
  });
});

describe("deleteUserFact on the real schema", () => {
  it("removes the one (category, key) row; its neighbours in each column stay", () => {
    seedCross();
    const before = all();
    expect(deleteUserFact("cat-b", "k2")).toBe(true);
    expect(all()).toEqual(before.filter((f) => !(f.category === "cat-b" && f.key === "k2")));
  });

  it("an absent pair deletes nothing and reports false", () => {
    seedCross();
    const before = all();
    expect(deleteUserFact("cat-0", "k2")).toBe(false);
    expect(deleteUserFact("cat-b", "k0")).toBe(false);
    expect(deleteUserFact("cat-z", "k2")).toBe(false);
    expect(deleteUserFact("cat-b", "k9")).toBe(false);
    expect(all()).toEqual(before);
  });
});
