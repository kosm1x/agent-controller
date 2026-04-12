/**
 * Tests for graph-aware coherence reranker.
 *
 * These tests rely on the real v6.5 entity extractor to build entity bags,
 * so fixtures use real project slug mentions (`cuatro-flor`, `pipesong`,
 * `crm-azteca`) that the extractor is guaranteed to catch.
 */

import { describe, it, expect } from "vitest";
import { rerankByCoherence, type RerankableItem } from "./graph-rerank.js";

interface TestItem extends RerankableItem {
  id: string;
}

function item(id: string, content: string, score: number): TestItem {
  return { id, content, _score: score };
}

describe("rerankByCoherence", () => {
  describe("edge cases", () => {
    it("returns empty for empty input", () => {
      const result = rerankByCoherence([]);
      expect(result.reranked).toEqual([]);
      expect(result.coherence).toBe(0);
    });

    it("returns single item unchanged", () => {
      const items = [item("a", "cuatro-flor completed today", 0.9)];
      const result = rerankByCoherence(items);
      expect(result.reranked).toHaveLength(1);
      expect(result.reranked[0].id).toBe("a");
      expect(result.coherence).toBe(1);
    });

    it("returns 2 items unchanged with coherence based on shared entity", () => {
      const connected = [
        item("a", "Trabajando en cuatro-flor día 1, completé el reporte", 0.9),
        item("b", "cuatro-flor día 2 terminé la investigación", 0.8),
      ];
      const r1 = rerankByCoherence(connected);
      expect(r1.reranked.map((x) => x.id)).toEqual(["a", "b"]);
      expect(r1.coherence).toBe(1);

      const disconnected = [
        item("x", "Trabajando en cuatro-flor día 1, completé el reporte", 0.9),
        item("y", "pipesong TTS está bloqueado por audio latency", 0.8),
      ];
      const r2 = rerankByCoherence(disconnected);
      expect(r2.reranked.map((x) => x.id)).toEqual(["x", "y"]);
      expect(r2.coherence).toBe(0);
    });
  });

  describe("clustering behavior", () => {
    it("keeps ordering stable when all items are disconnected", () => {
      const items = [
        item("a", "Trabajando en cuatro-flor, completé el día 1", 0.9),
        item("b", "pipesong tiene un bug en el pipeline de audio", 0.8),
        item("c", "vlmp listo para demo, terminé la UI", 0.7),
      ];
      const result = rerankByCoherence(items);
      expect(result.reranked.map((x) => x.id)).toEqual(["a", "b", "c"]);
      expect(result.coherence).toBe(0);
    });

    it("promotes a connected candidate inside the 15% tiebreaker window", () => {
      // seed score 0.90, candidate B at 0.80 (connected), candidate C at 0.82 (disconnected).
      // Without bonus: order would be A, C, B.
      // With 5% single-link bonus: B combined = 0.80 * 1.05 = 0.84 > C's 0.82.
      // So B should promote above C.
      const items = [
        item("a", "Trabajando en cuatro-flor día 1 completé el reporte", 0.9),
        item("c", "pipesong bug en audio pipeline bloqueado", 0.82),
        item("b", "cuatro-flor día 2 terminé la investigación", 0.8),
      ];
      const result = rerankByCoherence(items);
      expect(result.reranked.map((x) => x.id)).toEqual(["a", "b", "c"]);
    });

    it("does NOT promote when base score gap exceeds 15% cap", () => {
      // seed 0.90, B at 0.50 (connected), C at 0.70 (disconnected).
      // With max 15% bonus: B best case = 0.50 * 1.15 = 0.575 < 0.70.
      // So C should stay above B — base relevance dominates outside window.
      const items = [
        item("a", "Trabajando en cuatro-flor día 1 completé el reporte", 0.9),
        item("c", "pipesong bug en audio pipeline bloqueado", 0.7),
        item("b", "cuatro-flor día 2 terminé la investigación", 0.5),
      ];
      const result = rerankByCoherence(items);
      expect(result.reranked.map((x) => x.id)).toEqual(["a", "c", "b"]);
    });

    it("builds coherent clusters from mixed-topic recall", () => {
      // 6 items: 3 about cuatro-flor (high+mid+low scores), 2 about pipesong, 1 about crm-azteca.
      // Without rerank: top-5 would interleave topics by raw score.
      // With rerank: after seeding with highest, we should see the
      //              cuatro-flor trio grouped and pipesong pair grouped.
      const items = [
        item("cf1", "cuatro-flor día 5 terminé la síntesis final", 0.95),
        item("ps1", "pipesong TTS completé el fix de latency", 0.9),
        item(
          "cf2",
          "cuatro-flor día 3 completé la investigación de energía",
          0.88,
        ),
        item(
          "cf3",
          "cuatro-flor día 4 terminé el análisis arquitectural",
          0.85,
        ),
        item("ps2", "pipesong Deepgram STT deployed a producción", 0.82),
        item("ca1", "crm-azteca empezó el módulo de prospectos", 0.8),
      ];
      const result = rerankByCoherence(items);
      const orderIds = result.reranked.map((x) => x.id);

      // First item is always the highest-scoring seed
      expect(orderIds[0]).toBe("cf1");
      // The cf trio should be adjacent in the first 3 positions
      const cfPositions = ["cf1", "cf2", "cf3"]
        .map((id) => orderIds.indexOf(id))
        .sort((a, b) => a - b);
      expect(cfPositions).toEqual([0, 1, 2]);
      // pipesong pair should then cluster together
      const psPositions = ["ps1", "ps2"]
        .map((id) => orderIds.indexOf(id))
        .sort((a, b) => a - b);
      expect(psPositions[1] - psPositions[0]).toBe(1);
      // Coherence should be > 0 because top-5 contains the cuatro-flor trio (3 pairs)
      expect(result.coherence).toBeGreaterThan(0);
    });
  });

  describe("invariants", () => {
    it("enforces monotonically decreasing scores", () => {
      // Construct a case where a lower-base candidate gets promoted
      // and whose bonus-boosted score could exceed the prior item.
      const items = [
        item("a", "Trabajando en cuatro-flor día 1 completé el reporte", 0.9),
        item("b", "pipesong bug en audio bloqueado", 0.88),
        item("c", "cuatro-flor día 2 terminé la investigación", 0.85),
      ];
      const result = rerankByCoherence(items);
      for (let i = 1; i < result.reranked.length; i++) {
        expect(result.reranked[i]._score).toBeLessThanOrEqual(
          result.reranked[i - 1]._score,
        );
      }
    });

    it("does not mutate the caller's input array", () => {
      const items = [
        item("a", "Trabajando en cuatro-flor día 1 completé el reporte", 0.9),
        item("b", "pipesong bug en audio bloqueado", 0.8),
        item("c", "cuatro-flor día 2 terminé la investigación", 0.7),
      ];
      const before = items.map((x) => ({ id: x.id, score: x._score }));
      rerankByCoherence(items);
      const after = items.map((x) => ({ id: x.id, score: x._score }));
      expect(after).toEqual(before);
    });

    it("produces a coherence of 1.0 when all top-5 items share an entity", () => {
      const items = [
        item("a", "cuatro-flor día 1 completé el trabajo", 0.9),
        item("b", "cuatro-flor día 2 terminé la investigación", 0.88),
        item("c", "cuatro-flor día 3 deployed a producción", 0.86),
        item("d", "cuatro-flor día 4 completé el análisis", 0.84),
      ];
      const result = rerankByCoherence(items);
      expect(result.coherence).toBe(1);
    });

    it("produces a coherence of 0 when no items share entities", () => {
      const items = [
        item("a", "Trabajando en cuatro-flor hoy, completé el día 1", 0.9),
        item("b", "pipesong bug en audio, bloqueado por latency", 0.8),
        item("c", "vlmp terminé la UI, deployed a producción", 0.7),
      ];
      const result = rerankByCoherence(items);
      expect(result.coherence).toBe(0);
    });
  });

  describe("options", () => {
    it("honors custom connectivityBonus", () => {
      const items = [
        item("a", "Trabajando en cuatro-flor día 1 completé el reporte", 0.9),
        item("c", "pipesong bug en audio bloqueado", 0.82),
        item("b", "cuatro-flor día 2 terminé la investigación", 0.8),
      ];
      // With default 5% bonus: 0.80 * 1.05 = 0.84 > 0.82 → b promotes
      const def = rerankByCoherence(items);
      expect(def.reranked.map((x) => x.id)).toEqual(["a", "b", "c"]);

      // With 0% bonus: pure relevance → c stays above b
      const noBonus = rerankByCoherence(items, { connectivityBonus: 0 });
      expect(noBonus.reranked.map((x) => x.id)).toEqual(["a", "c", "b"]);
    });

    it("honors custom maxBonus cap when connections accumulate", () => {
      // 4 items: seed 'a' (cuatro-flor), 2 connected at low score ('b','d'),
      // 1 disconnected at mid score ('c'). Permissive options (higher per-link
      // bonus + higher cap) should let the connected pair win over 'c'.
      const items = [
        item("a", "cuatro-flor día 1 completé el reporte", 0.9),
        item("c", "pipesong bug en audio bloqueado", 0.7),
        item("b", "cuatro-flor día 2 terminé la investigación", 0.5),
        item("d", "cuatro-flor día 3 deployed a producción", 0.45),
      ];

      // Default: c beats b (0.70 > 0.50 * 1.05); b beats d;
      // expected order a, c, b, d
      const def = rerankByCoherence(items);
      expect(def.reranked.map((x) => x.id)).toEqual(["a", "c", "b", "d"]);

      // Permissive (bonus 0.5, cap 0.5): b gets 0.50 * 1.5 = 0.75 > 0.70 → b beats c;
      // then d connected to both a and b: 0.45 * 1.5 = 0.675 < 0.70 → c beats d;
      // expected order a, b, c, d
      const permissive = rerankByCoherence(items, {
        connectivityBonus: 0.5,
        maxBonus: 0.5,
      });
      expect(permissive.reranked.map((x) => x.id)).toEqual([
        "a",
        "b",
        "c",
        "d",
      ]);
    });
  });
});
