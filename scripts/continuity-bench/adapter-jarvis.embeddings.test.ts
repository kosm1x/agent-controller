/**
 * The --allow-embeddings path with a MOCKED embedding function: no key, no
 * network. Stored rows get vectors the way retain() writes them, through a
 * content-hash cache persisted under os.tmpdir(); JME dedup outcomes a
 * correction can produce with vectors are accepted.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { embedMock } = vi.hoisted(() => ({
  embedMock: vi.fn(async (text: string): Promise<Float32Array | null> => {
    if (text.includes("EMBED-FAILS")) return null;
    // Deterministic 1536-dim vector; texts about the same budget share one, so JME dedup sees a near-twin.
    const v = new Float32Array(1536);
    const key = /presupuesto/i.test(text) ? "presupuesto" : text;
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0;
    for (let i = 0; i < v.length; i++) {
      h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
      v[i] = (h % 2000) / 1000 - 1;
    }
    return v;
  }),
}));

vi.mock("../../src/memory/embeddings.js", async (orig) => ({
  ...(await orig<typeof import("../../src/memory/embeddings.js")>()),
  embed: embedMock,
}));

// A stand-in credential: production scrubSecrets replaces stored credential values; here one fixed token.
vi.mock("../../src/lib/secret-refs.js", async (orig) => {
  const real = await orig<typeof import("../../src/lib/secret-refs.js")>();
  return { ...real, scrubSecrets: (t: string) => real.scrubSecrets(t).replaceAll("tok-SYNTHETIC-77", "[secret:bench]") };
});

import { getDatabase } from "../../src/db/index.js";
import { EMBED_MAX_CONSECUTIVE_FAILURES, EmbedCache, JarvisAdapter, exchangeContent, scratchDbPath } from "./adapter-jarvis.js";
import { FILLER_SPEC_V1 } from "./filler.js";
import { embedPlan } from "./run.js";
import type { Corpus, Scenario } from "./types.js";

beforeAll(() => {
  vi.stubEnv("GEMINI_API_KEY", undefined);
  vi.stubEnv("EMBEDDING_KEY", undefined);
  vi.stubEnv("COMMIT_DB_KEY", undefined);
  vi.stubEnv("HINDSIGHT_ENABLED", "false");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

const DAY = 86_400;
const C2: Scenario = {
  id: "C2-emb",
  class: "C2",
  base: 1,
  lang: "es",
  fillerSize: 4,
  fillerSeed: 11,
  fillerFromT: -2 * DAY,
  fillerToT: 10 * DAY,
  events: [
    { day: 0, t: 32_400, session: "d0", kind: "person_fact", text: "El presupuesto de la remodelación es de 3.847.215 pesos.", durable: true, asUser: "El presupuesto es de 3.847.215 pesos.", asAssistant: "Anotado." },
    { day: 5, t: 5 * DAY + 32_520, session: "d5", kind: "correction", targetEventIndex: 0, text: "El presupuesto de la remodelación es de 2.960.400 pesos.", asUser: "Ahora el presupuesto es de 2.960.400 pesos.", asAssistant: "Ajustado." },
  ],
  probes: [{ day: 10, t: 10 * DAY + 64_800, session: "d10", text: "¿Cuál es el presupuesto vigente?", expect: ["2.960.400"], forbid: ["3.847.215"], surface: "both" }],
};

describe("JarvisAdapter with embeddings (mocked embed)", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-emb-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("embeds every stored row once, persists the cache, and accepts a correction JME absorbs", async () => {
    const cachePath = join(dir, "cache.jsonl");
    const cache = new EmbedCache(cachePath);
    const adapter = new JarvisAdapter(scratchDbPath(dir), "ideal", { embeddings: true, embedCache: cache });
    adapter.open();
    try {
      const [run] = await adapter.runScenario(C2, FILLER_SPEC_V1);
      const db = getDatabase();
      const rows = (db.prepare("SELECT COUNT(*) AS n FROM conversations").get() as { n: number }).n;
      const vecs = (db.prepare("SELECT COUNT(*) AS n FROM conversation_embeddings").get() as { n: number }).n;
      expect(rows).toBe(6); // 4 filler + 2 events
      expect(vecs).toBe(rows);
      expect(cache.calls).toBe(rows);
      // The correction shares the fact's vector (cos 1.0 ≥ 0.95): upsertFact returns "skipped" (accepted,
      // no throw) and, per jme.ts, the surviving row takes the incoming wording: one row, the new value.
      const facts = db.prepare("SELECT fact_text FROM jme_facts").all() as Array<{ fact_text: string }>;
      expect(facts.map((f) => f.fact_text)).toEqual(["El presupuesto de la remodelación es de 2.960.400 pesos."]);
      expect(run.ingestedRows).toBe(7); // 6 rows + the first fact; the skipped correction adds none
      expect(embedMock).toHaveBeenCalled();
    } finally {
      adapter.close();
    }
    expect(existsSync(cachePath)).toBe(true);
    expect(readFileSync(cachePath, "utf8").trim().split("\n")).toHaveLength(6);

    // A second run on a fresh db reuses the persisted vectors: no new row embed.
    const reloaded = new EmbedCache(cachePath);
    expect(reloaded.size).toBe(6);
    const dir2 = mkdtempSync(join(tmpdir(), "cb-emb2-"));
    const again = new JarvisAdapter(scratchDbPath(dir2), "raw", { embeddings: true, embedCache: reloaded });
    again.open();
    try {
      await again.runScenario(C2, FILLER_SPEC_V1);
      expect(reloaded.calls).toBe(0);
      expect(reloaded.hits).toBe(6);
    } finally {
      again.close();
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("stores AND embeds scrubSecrets(content), as retain() does", async () => {
    const s: Scenario = {
      ...C2,
      id: "C2-scrub",
      fillerSize: 0,
      events: [{ day: 0, t: 32_400, session: "d0", kind: "exchange", user: "mi token es tok-SYNTHETIC-77", assistant: "No lo guardo." }],
      probes: [{ ...C2.probes[0], expect: [], forbid: [] }],
    };
    const d = mkdtempSync(join(tmpdir(), "cb-scrub-"));
    const adapter = new JarvisAdapter(scratchDbPath(d), "raw", { embeddings: true, embedCache: new EmbedCache() });
    adapter.open();
    try {
      embedMock.mockClear();
      await adapter.runScenario(s, FILLER_SPEC_V1);
      const rows = getDatabase().prepare("SELECT content FROM conversations").all() as Array<{ content: string }>;
      expect(rows.map((r) => r.content)).toEqual(["User: mi token es [secret:bench]\nJarvis: No lo guardo."]);
      const embedded = embedMock.mock.calls.map(([t]) => t);
      expect(embedded).toContain("User: mi token es [secret:bench]\nJarvis: No lo guardo.");
      expect(embedded.some((t) => t.includes("tok-SYNTHETIC-77"))).toBe(false);
    } finally {
      adapter.close();
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("a failed embed is cached for the run (not re-called); N consecutive failures stop the run", async () => {
    const cache = new EmbedCache();
    embedMock.mockClear();
    expect(await cache.vector("EMBED-FAILS a")).toBeNull();
    expect(await cache.vector("EMBED-FAILS a")).toBeNull();
    expect(embedMock).toHaveBeenCalledTimes(1);
    expect(cache).toMatchObject({ calls: 1, failures: 1 });
    expect(await cache.vector("ok text")).not.toBeNull(); // a success resets the streak
    for (let i = 1; i < EMBED_MAX_CONSECUTIVE_FAILURES; i++) expect(await cache.vector(`EMBED-FAILS b${i}`)).toBeNull();
    await expect(cache.vector("EMBED-FAILS last")).rejects.toThrow(/in a row/);
  });

  it("refuses a cache file outside os.tmpdir()", () => {
    expect(() => new EmbedCache("/root/embed-cache.jsonl")).toThrow(/under/);
  });

  it("embedPlan counts unique texts before any call and skips cached ones", () => {
    const corpus = { fillerSpec: FILLER_SPEC_V1, scenarios: [C2, { ...C2, id: "C2-emb-b" }] } as unknown as Corpus;
    const plan = embedPlan(corpus, [4], "ideal", exchangeContent);
    expect(plan.rowTexts).toBe(6); // the second scenario repeats the same texts
    expect(plan.otherTexts).toBe(3); // 2 fact texts + 1 probe text
    expect(plan.unique).toBe(9);
    expect(plan.probeCalls).toBe(2 * 6); // 2 probes × 6 uncached calls
    expect(plan.upsertCalls).toBe(2 * 2 * 2); // 2 probes × 2 facts re-upserted × 2 calls
    expect(plan.upperBound).toBe(6 + 12 + 8);
    const raw = embedPlan(corpus, [4], "raw", exchangeContent);
    expect(raw.upsertCalls).toBe(0);
    expect(raw.upperBound).toBe(6 + 12);
    const none = embedPlan(corpus, [4], "raw", exchangeContent, () => true);
    expect(none.rowTexts).toBe(0);
  });
});
