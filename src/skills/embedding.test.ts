import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import {
  composeEmbeddingText,
  embedAndStoreSkill,
  loadSkillEmbedding,
} from "./embedding.js";

vi.mock("../inference/embeddings.js", () => ({
  generateEmbedding: vi.fn(),
  generateEmbeddings: vi.fn(),
  isEmbeddingEnabled: vi.fn(() => true),
}));

import { generateEmbedding } from "../inference/embeddings.js";
const mockGenerateEmbedding = vi.mocked(generateEmbedding);

let testKbDir: string;
const SKILL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

beforeEach(() => {
  testKbDir = mkdtempSync(join(tmpdir(), "mc-embedding-test-"));
  process.env.JARVIS_KB_MIRROR_DIR = testKbDir;
  initDatabase(":memory:");
  // Seed a minimal skill row to point at.
  const db = getDatabase();
  db.prepare(
    `INSERT INTO skills (
       skill_id, name, description, trigger_text, steps, tools, source
     ) VALUES (?, 'echo', 'Echo the input message verbatim.', 'echo', '[]', '[]', 'manual')`,
  ).run(SKILL_ID);
  mockGenerateEmbedding.mockReset();
});

afterEach(() => {
  closeDatabase();
  rmSync(testKbDir, { recursive: true, force: true });
  delete process.env.JARVIS_KB_MIRROR_DIR;
});

describe("composeEmbeddingText", () => {
  it("joins description + trigger_examples with newline", () => {
    const text = composeEmbeddingText({
      description: "Send a follow-up",
      trigger_examples: ["one", "two", "three"],
    });
    expect(text).toBe("Send a follow-up\none\ntwo\nthree");
  });

  it("returns description only when trigger_examples is empty", () => {
    const text = composeEmbeddingText({
      description: "Send a follow-up",
      trigger_examples: [],
    });
    expect(text).toBe("Send a follow-up");
  });

  it("returns description only when trigger_examples is missing", () => {
    const text = composeEmbeddingText({
      description: "Send a follow-up",
    });
    expect(text).toBe("Send a follow-up");
  });
});

describe("embedAndStoreSkill", () => {
  it("writes a BLOB and returns true on a successful embed", async () => {
    const vec = new Array(1536).fill(0).map((_, i) => i / 1536);
    mockGenerateEmbedding.mockResolvedValueOnce(vec);

    const ok = await embedAndStoreSkill(SKILL_ID, {
      description: "Echo the input",
      trigger_examples: ["echo", "repeat"],
    });
    expect(ok).toBe(true);

    const db = getDatabase();
    const row = db
      .prepare(
        "SELECT length(description_embedding) AS bytes FROM skills WHERE skill_id = ?",
      )
      .get(SKILL_ID) as { bytes: number };
    expect(row.bytes).toBe(1536 * 4);
  });

  it("returns false when embed() returns null (graceful degradation)", async () => {
    mockGenerateEmbedding.mockResolvedValueOnce(null);

    const ok = await embedAndStoreSkill(SKILL_ID, {
      description: "Echo the input",
      trigger_examples: [],
    });
    expect(ok).toBe(false);

    const db = getDatabase();
    const row = db
      .prepare(
        "SELECT description_embedding AS blob FROM skills WHERE skill_id = ?",
      )
      .get(SKILL_ID) as { blob: Buffer | null };
    expect(row.blob).toBeNull();
  });

  it("returns false when description is empty (no embed call)", async () => {
    const ok = await embedAndStoreSkill(SKILL_ID, {
      description: "   ",
      trigger_examples: [],
    });
    expect(ok).toBe(false);
    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
  });

  it("passes the composed text to generateEmbedding", async () => {
    const vec = new Array(1536).fill(0.5);
    mockGenerateEmbedding.mockResolvedValueOnce(vec);

    await embedAndStoreSkill(SKILL_ID, {
      description: "Send follow-up",
      trigger_examples: ["a", "b", "c"],
    });

    expect(mockGenerateEmbedding).toHaveBeenCalledWith(
      "Send follow-up\na\nb\nc",
    );
  });
});

describe("loadSkillEmbedding", () => {
  it("returns null when no embedding stored", () => {
    expect(loadSkillEmbedding(SKILL_ID)).toBeNull();
  });

  it("round-trips the Float32Array via the BLOB", async () => {
    const original = new Array(1536).fill(0).map((_, i) => i / 1000);
    mockGenerateEmbedding.mockResolvedValueOnce(original);

    await embedAndStoreSkill(SKILL_ID, {
      description: "Echo",
      trigger_examples: [],
    });

    const loaded = loadSkillEmbedding(SKILL_ID);
    expect(loaded).not.toBeNull();
    expect(loaded?.length).toBe(1536);
    // Validate first few values survive the round-trip (Float32 precision).
    for (let i = 0; i < 10; i++) {
      expect(loaded?.[i]).toBeCloseTo(original[i], 4);
    }
  });

  it("returns null when BLOB length does not match EMBED_DIMS * 4 (dimension drift)", () => {
    const db = getDatabase();
    // Write a wrong-sized BLOB to simulate dimension drift.
    db.prepare(
      "UPDATE skills SET description_embedding = ? WHERE skill_id = ?",
    ).run(Buffer.alloc(100), SKILL_ID); // wrong size

    expect(loadSkillEmbedding(SKILL_ID)).toBeNull();
  });

  it("returns null for non-existent skill_id", () => {
    expect(loadSkillEmbedding("does-not-exist")).toBeNull();
  });
});
