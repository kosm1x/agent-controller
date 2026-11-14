/**
 * Storyboard brand-profile read on the real `ads_brand_profiles` table.
 *
 * storyboard.test.ts stubs `prepare`, so it never runs the SELECT. The read
 * swallows its own errors and a missing profile is a refusal, so a wrong
 * column or table would show only as "not found": the cases seed two
 * profiles and check that the requested one reaches the prompt. The model
 * call is stubbed and rejects unless a case answers it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";

vi.mock("../inference/adapter.js", () => ({
  infer: vi.fn(async () => {
    throw new Error("unexpected infer call");
  }),
}));

import { closeDatabase, initDatabase } from "../db/index.js";
import { infer } from "../inference/adapter.js";
import { generateStoryboard } from "./storyboard.js";

const MANIFEST = JSON.stringify({
  version: 1,
  title: "synthetic",
  template: "landscape",
  fps: 30,
  language: "es",
  scenes: [0, 1, 2].map((index) => ({
    index,
    durationSec: 5,
    text: `escena ${index}`,
    imageQuery: "synthetic scene",
  })),
});

let db: Database.Database;

function seedProfile(domain: string, profile: object, id?: number): number {
  const info = db
    .prepare(
      "INSERT INTO ads_brand_profiles (id, domain, brand_name, profile) VALUES (?, ?, ?, ?)",
    )
    .run(id ?? null, domain, domain, JSON.stringify(profile));
  return Number(info.lastInsertRowid);
}

function promptOf(call: number): string {
  const arg = vi.mocked(infer).mock.calls[call][0] as {
    messages: Array<{ role: string; content: string }>;
  };
  return arg.messages.find((m) => m.role === "user")?.content ?? "";
}

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
});

describe("generateStoryboard brand profile", () => {
  it("puts the requested profile's voice and lexicon into the prompt", async () => {
    // Profiles on both sides of the requested id, so only an exact match
    // on the id picks the requested one.
    seedProfile("before.example", {
      brand_name: "Before Brand",
      keywords_lexicon: ["before-word"],
    });
    const id = seedProfile("brand.example", {
      brand_name: "Synthetic Brand",
      voice: { descriptor: "calm and exact" },
      keywords_lexicon: ["steady"],
      avoid_lexicon: ["loud"],
    });
    seedProfile("after.example", {
      brand_name: "After Brand",
      keywords_lexicon: ["after-word"],
    });
    vi.mocked(infer).mockResolvedValueOnce({ content: MANIFEST } as Awaited<
      ReturnType<typeof infer>
    >);

    const manifest = await generateStoryboard({
      brief: "synthetic brief",
      duration: 15,
      brand_id: id,
    });

    expect(manifest.brandProfileId).toBe(id);
    const prompt = promptOf(0);
    expect(prompt).toContain("Brand name: Synthetic Brand");
    expect(prompt).toContain("Voice: calm and exact");
    expect(prompt).toContain("Use these words: steady");
    expect(prompt).toContain("Avoid these words: loud");
    expect(prompt).not.toContain("Before Brand");
    expect(prompt).not.toContain("After Brand");
  });

  it("refuses an id that has no profile row, before any model call", async () => {
    // Rows below and above the missing id: any comparison other than an
    // exact match would find one of them and skip the refusal.
    seedProfile("low.example", { brand_name: "Low Brand" }, 2);
    seedProfile("high.example", { brand_name: "High Brand" }, 7);

    await expect(
      generateStoryboard({ brief: "synthetic brief", duration: 15, brand_id: 4 }),
    ).rejects.toThrow("brand_id 4 not found");
    expect(infer).not.toHaveBeenCalled();
  });
});
