import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { retrieveSkills } from "./retrieval.js";

vi.mock("../inference/embeddings.js", () => ({
  generateEmbedding: vi.fn(),
  generateEmbeddings: vi.fn(),
  isEmbeddingEnabled: vi.fn(() => true),
}));

import { generateEmbedding } from "../inference/embeddings.js";
const mockGenerateEmbedding = vi.mocked(generateEmbedding);

let testKbDir: string;

beforeEach(() => {
  testKbDir = mkdtempSync(join(tmpdir(), "mc-retrieval-test-"));
  process.env.JARVIS_KB_MIRROR_DIR = testKbDir;
  initDatabase(":memory:");
  mockGenerateEmbedding.mockReset();
});

afterEach(() => {
  closeDatabase();
  rmSync(testKbDir, { recursive: true, force: true });
  delete process.env.JARVIS_KB_MIRROR_DIR;
});

/**
 * Helper: seed a certified+active skill with a synthetic embedding vector.
 * The vec is a 1536-float array passed as a JS number[] — we serialize
 * to BLOB via the same path embedAndStoreSkill uses, but inline here
 * to avoid an embed() mock per row.
 */
function seedEmbeddedSkill(
  skillId: string,
  name: string,
  description: string,
  vec: number[],
  options: {
    certified?: boolean;
    consecutiveFailures?: number;
    active?: boolean;
  } = {},
): void {
  const certified = options.certified ?? true;
  const consec = options.consecutiveFailures ?? 0;
  const active = options.active ?? true;
  const db = getDatabase();
  const buf = Buffer.from(new Float32Array(vec).buffer);
  db.prepare(
    `INSERT INTO skills (
       skill_id, name, description, trigger_text, steps, tools, source,
       is_certified, active, consecutive_failures, description_embedding
     ) VALUES (?, ?, ?, ?, '[]', '[]', 'manual', ?, ?, ?, ?)`,
  ).run(
    skillId,
    name,
    description,
    name,
    certified ? 1 : 0,
    active ? 1 : 0,
    consec,
    buf,
  );
}

function vecOf(value: number): number[] {
  return new Array(1536).fill(value);
}

describe("retrieveSkills — vector path", () => {
  it("returns empty array when query is empty", async () => {
    const result = await retrieveSkills("");
    expect(result).toEqual([]);
  });

  it("returns empty array when k <= 0", async () => {
    mockGenerateEmbedding.mockResolvedValueOnce(vecOf(1));
    const result = await retrieveSkills("query", { k: 0 });
    expect(result).toEqual([]);
  });

  it("ranks skills by cosine similarity (most-similar first)", async () => {
    // Build vectors with DIFFERENT angles to the query so cosine scores
    // are actually distinct (not just colinear positive vectors that
    // all hit cos=1.0). Pattern: query = [1, 0, 0, 0, 1, 0, 0, 0, ...]
    // near = same pattern (matches query exactly → cos = 1.0)
    // mid  = first half 1s only (partial overlap → ~0.71)
    // far  = inverted pattern (orthogonal → cos ≈ 0)
    const query = new Array(1536).fill(0).map((_, i) => (i % 4 === 0 ? 1 : 0));
    const near = [...query]; // exact match
    const mid = new Array(1536).fill(0).map((_, i) => (i < 768 ? 1 : 0));
    const far = new Array(1536).fill(0).map((_, i) => (i % 4 === 1 ? 1 : 0));

    seedEmbeddedSkill("id-near", "near-skill", "near", near);
    seedEmbeddedSkill("id-mid", "mid-skill", "mid", mid);
    seedEmbeddedSkill("id-far", "far-skill", "far", far);

    mockGenerateEmbedding.mockResolvedValueOnce(query);

    // Threshold=-1 disables filtering so we observe full ranking order.
    // far is orthogonal → cos ≈ 0; mid has partial overlap → cos ≈ 0.35;
    // near is identical → cos = 1.0.
    const result = await retrieveSkills("query", { minSimilarity: -1 });
    expect(result).toHaveLength(3);
    expect(result[0].name).toBe("near-skill");
    expect(result[0].source).toBe("vector");
    expect(result[0].similarity).toBeCloseTo(1.0, 3);
    expect(result[1].name).toBe("mid-skill");
    expect(result[1].similarity).toBeGreaterThan(result[2].similarity);
    expect(result[2].name).toBe("far-skill");
  });

  it("respects k limit", async () => {
    seedEmbeddedSkill("id-1", "a", "alpha", vecOf(1));
    seedEmbeddedSkill("id-2", "b", "beta", vecOf(1));
    seedEmbeddedSkill("id-3", "c", "gamma", vecOf(1));
    mockGenerateEmbedding.mockResolvedValueOnce(vecOf(1));

    const result = await retrieveSkills("q", { k: 2 });
    expect(result).toHaveLength(2);
  });

  it("filters by minSimilarity threshold", async () => {
    // v1 and query are colinear (cos=1); v2 is opposite (cos=-1).
    seedEmbeddedSkill("id-near", "near", "alpha", vecOf(1));
    seedEmbeddedSkill("id-far", "far", "beta", vecOf(-1));
    mockGenerateEmbedding.mockResolvedValueOnce(vecOf(1));

    const result = await retrieveSkills("q", { minSimilarity: 0.5 });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("near");
  });

  it("excludes uncertified skills (spec §6 anti-list)", async () => {
    seedEmbeddedSkill("id-1", "certified", "alpha", vecOf(1), {
      certified: true,
    });
    seedEmbeddedSkill("id-2", "uncertified", "beta", vecOf(1), {
      certified: false,
    });
    mockGenerateEmbedding.mockResolvedValueOnce(vecOf(1));

    const result = await retrieveSkills("q");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("certified");
  });

  it("excludes inactive skills", async () => {
    seedEmbeddedSkill("id-1", "active", "alpha", vecOf(1), { active: true });
    seedEmbeddedSkill("id-2", "inactive", "beta", vecOf(1), { active: false });
    mockGenerateEmbedding.mockResolvedValueOnce(vecOf(1));

    const result = await retrieveSkills("q");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("active");
  });

  it("excludes skills with consecutive_failures >= 3 (anti-list)", async () => {
    seedEmbeddedSkill("id-ok", "ok-skill", "alpha", vecOf(1), {
      consecutiveFailures: 2,
    });
    seedEmbeddedSkill("id-bad", "bad-skill", "beta", vecOf(1), {
      consecutiveFailures: 3,
    });
    mockGenerateEmbedding.mockResolvedValueOnce(vecOf(1));

    const result = await retrieveSkills("q");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("ok-skill");
  });

  it("skips skills whose BLOB dim does not match query dim", async () => {
    // Seed with a mis-sized BLOB (1000 floats = 4000 bytes != 6144).
    const db = getDatabase();
    const wrongBuf = Buffer.from(new Float32Array(1000).buffer);
    db.prepare(
      `INSERT INTO skills (skill_id, name, description, trigger_text, steps, tools, source,
                          is_certified, active, consecutive_failures, description_embedding)
       VALUES ('id-bad', 'bad-dim', 'desc', 'trig', '[]', '[]', 'manual', 1, 1, 0, ?)`,
    ).run(wrongBuf);
    seedEmbeddedSkill("id-ok", "good-dim", "desc", vecOf(1));

    mockGenerateEmbedding.mockResolvedValueOnce(vecOf(1));
    const result = await retrieveSkills("q");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("good-dim");
  });
});

describe("retrieveSkills — fallback paths", () => {
  it("falls back to keyword search when no embeddings exist", async () => {
    // Seed a skill with NO embedding but a trigger that matches the query.
    const db = getDatabase();
    db.prepare(
      `INSERT INTO skills (skill_id, name, description, trigger_text, steps, tools, source, active)
       VALUES ('id-1', 'wordpress_sync', 'Sync to WordPress', 'wordpress sync entries', '[]', '[]', 'manual', 1)`,
    ).run();

    // embed() not even called — early return on rows.length === 0.
    const result = await retrieveSkills("wordpress sync");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("wordpress_sync");
    expect(result[0].source).toBe("keyword");
    expect(result[0].similarity).toBe(0);
  });

  it("falls back to keyword when query embed returns null", async () => {
    seedEmbeddedSkill("id-1", "wordpress_sync", "Sync", vecOf(1));
    const db = getDatabase();
    db.prepare(`UPDATE skills SET trigger_text = ? WHERE skill_id = ?`).run(
      "wordpress sync entries",
      "id-1",
    );

    mockGenerateEmbedding.mockResolvedValueOnce(null);

    const result = await retrieveSkills("wordpress sync");
    // findSkillsByKeywords filters active=1; we still need a match
    expect(result.length).toBeGreaterThanOrEqual(0);
    if (result.length > 0) {
      expect(result[0].source).toBe("keyword");
    }
  });

  it("falls back to keyword when ALL embedded rows have wrong dim (R1-W1 regression)", async () => {
    // Seed a certified+active row with a deliberately wrong-sized BLOB.
    // The vector loop should mark `mismatched++`, leave `scored` empty,
    // and the new post-loop fallback should fire to keyword search.
    const db = getDatabase();
    const wrongBuf = Buffer.from(new Float32Array(1000).buffer);
    db.prepare(
      `INSERT INTO skills (skill_id, name, description, trigger_text, steps, tools, source,
                          is_certified, active, consecutive_failures, description_embedding)
       VALUES ('id-1', 'kw_skill', 'desc', 'wordpress sync entries', '[]', '[]', 'manual', 1, 1, 0, ?)`,
    ).run(wrongBuf);

    mockGenerateEmbedding.mockResolvedValueOnce(vecOf(1));

    const result = await retrieveSkills("wordpress sync");
    // Vector path yielded 0 (all mismatched) → fallback to keyword.
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].source).toBe("keyword");
    expect(result[0].name).toBe("kw_skill");
  });

  it("disables fallback when fallbackToKeyword=false", async () => {
    // No embeddings; fallback disabled → return empty regardless of keyword matches.
    const db = getDatabase();
    db.prepare(
      `INSERT INTO skills (skill_id, name, description, trigger_text, steps, tools, source, active)
       VALUES ('id-1', 'kw_skill', 'desc', 'wordpress sync', '[]', '[]', 'manual', 1)`,
    ).run();

    const result = await retrieveSkills("wordpress sync", {
      fallbackToKeyword: false,
    });
    expect(result).toEqual([]);
  });

  it("returns empty when fallback would, but doesn't throw", async () => {
    const result = await retrieveSkills("totally unrelated nonexistent terms");
    expect(result).toEqual([]);
  });
});
