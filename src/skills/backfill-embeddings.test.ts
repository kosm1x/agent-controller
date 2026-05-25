import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { backfillSkillEmbeddings, BackfillLog } from "./backfill-embeddings.js";

vi.mock("../inference/embeddings.js", () => ({
  generateEmbedding: vi.fn(),
  generateEmbeddings: vi.fn(),
  isEmbeddingEnabled: vi.fn(() => true),
}));

import { generateEmbedding } from "../inference/embeddings.js";
const mockGenerateEmbedding = vi.mocked(generateEmbedding);

let testKbDir: string;

const SILENT: BackfillLog = {
  info: () => {},
};

function seedSkill(name: string, description: string): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO skills (
       skill_id, name, description, trigger_text, steps, tools, source
     ) VALUES (?, ?, ?, 'trigger', '[]', '[]', 'manual')`,
  ).run(`id-${name}`, name, description);
}

beforeEach(() => {
  testKbDir = mkdtempSync(join(tmpdir(), "mc-backfill-test-"));
  process.env.JARVIS_KB_MIRROR_DIR = testKbDir;
  initDatabase(":memory:");
  mockGenerateEmbedding.mockReset();
});

afterEach(() => {
  closeDatabase();
  rmSync(testKbDir, { recursive: true, force: true });
  delete process.env.JARVIS_KB_MIRROR_DIR;
});

describe("backfillSkillEmbeddings", () => {
  it("returns considered=0 when no skills need embedding", async () => {
    const result = await backfillSkillEmbeddings({}, SILENT);
    expect(result.considered).toBe(0);
    expect(result.embedded).toBe(0);
  });

  it("embeds skills missing description_embedding", async () => {
    seedSkill("skill-a", "first skill");
    seedSkill("skill-b", "second skill");

    const vec = new Array(1536).fill(0.1);
    mockGenerateEmbedding.mockResolvedValue(vec);

    const result = await backfillSkillEmbeddings({}, SILENT);
    expect(result.considered).toBe(2);
    expect(result.embedded).toBe(2);
    expect(result.errors).toEqual([]);

    const db = getDatabase();
    const filled = (
      db
        .prepare(
          "SELECT COUNT(*) as n FROM skills WHERE description_embedding IS NOT NULL",
        )
        .get() as { n: number }
    ).n;
    expect(filled).toBe(2);
  });

  it("is idempotent — second run after success embeds 0 more", async () => {
    seedSkill("solo", "the only skill");
    mockGenerateEmbedding.mockResolvedValue(new Array(1536).fill(0.2));

    const first = await backfillSkillEmbeddings({}, SILENT);
    expect(first.embedded).toBe(1);

    const second = await backfillSkillEmbeddings({}, SILENT);
    expect(second.considered).toBe(0);
    expect(second.embedded).toBe(0);
  });

  it("records errors when embed returns null + leaves the row unembedded", async () => {
    seedSkill("broken-skill", "this skill cannot embed");
    mockGenerateEmbedding.mockResolvedValueOnce(null);

    const result = await backfillSkillEmbeddings({}, SILENT);
    expect(result.embedded).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].name).toBe("broken-skill");
    expect(result.errors[0].reason).toContain("null");

    const db = getDatabase();
    const row = db
      .prepare("SELECT description_embedding FROM skills WHERE name = ?")
      .get("broken-skill") as { description_embedding: Buffer | null };
    expect(row.description_embedding).toBeNull();
  });

  it("respects --limit", async () => {
    seedSkill("a", "alpha");
    seedSkill("b", "beta");
    seedSkill("c", "gamma");
    mockGenerateEmbedding.mockResolvedValue(new Array(1536).fill(0));

    const result = await backfillSkillEmbeddings({ limit: 2 }, SILENT);
    expect(result.considered).toBe(2);
    expect(result.embedded).toBe(2);

    const db = getDatabase();
    const unembedded = (
      db
        .prepare(
          "SELECT COUNT(*) as n FROM skills WHERE description_embedding IS NULL",
        )
        .get() as { n: number }
    ).n;
    expect(unembedded).toBe(1);
  });

  it("skips rows with empty description (defensive against legacy seed corruption)", async () => {
    const db = getDatabase();
    // Force a row with whitespace description that should NOT trigger an embed call.
    db.prepare(
      `INSERT INTO skills (skill_id, name, description, trigger_text, steps, tools, source)
       VALUES ('id-blank', 'blank-skill', '   ', 'trigger', '[]', '[]', 'manual')`,
    ).run();

    const result = await backfillSkillEmbeddings({}, SILENT);
    expect(result.considered).toBe(0);
    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
  });

  it("continues past per-row null-embed (network etc.)", async () => {
    // Seed in any order — SQL processes in `use_count DESC, name ASC`.
    // All share use_count=0, so name alphabetical wins:
    // a-skill → fail-skill → z-skill.
    seedSkill("a-skill", "first alphabetical");
    seedSkill("fail-skill", "middle alphabetical");
    seedSkill("z-skill", "last alphabetical");

    // generateEmbedding rejections are caught upstream in
    // `/memory/embeddings.ts:embed()` (graceful degradation) and become a
    // null return → the backfill records this as a skipped-with-null-reason
    // row rather than an unhandled throw. The catch in backfill itself
    // covers the rarer case of a thrown error.
    mockGenerateEmbedding
      .mockResolvedValueOnce(new Array(1536).fill(0.1))
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockResolvedValueOnce(new Array(1536).fill(0.3));

    const result = await backfillSkillEmbeddings({}, SILENT);
    expect(result.embedded).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].name).toBe("fail-skill");
    expect(result.errors[0].reason).toMatch(/null|API|upstream/i);
  });
});
