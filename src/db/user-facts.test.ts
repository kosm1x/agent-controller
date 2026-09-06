import { describe, it, expect, beforeEach, vi , afterEach } from "vitest";
import {
  setUserFact,
  getUserFacts,
  deleteUserFact,
  formatUserFactsBlock,
} from "./user-facts.js";

// Mock getDatabase to return an in-memory SQLite instance
const mockDb = {
  prepare: vi.fn(),
};

vi.mock("./index.js", () => ({
  getDatabase: () => mockDb,
}));

describe("user-facts", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("setUserFact", () => {
    it("should upsert a fact with correct params", () => {
      const runMock = vi.fn();
      mockDb.prepare.mockReturnValue({ run: runMock });

      setUserFact("personal", "age", "30", "conversation");

      expect(mockDb.prepare).toHaveBeenCalledOnce();
      const sql = mockDb.prepare.mock.calls[0][0] as string;
      expect(sql).toContain("INSERT INTO user_facts");
      expect(sql).toContain("ON CONFLICT");
      expect(runMock).toHaveBeenCalledWith(
        "personal",
        "age",
        "30",
        "conversation",
      );
    });
  });

  describe("getUserFacts", () => {
    it("should query all facts when no category", () => {
      const allMock = vi.fn().mockReturnValue([
        {
          category: "personal",
          key: "age",
          value: "30",
          source: "conversation",
          updated_at: "2026-03-18",
        },
      ]);
      mockDb.prepare.mockReturnValue({ all: allMock });

      const facts = getUserFacts();

      expect(facts).toHaveLength(1);
      expect(facts[0].key).toBe("age");
      const sql = mockDb.prepare.mock.calls[0][0] as string;
      expect(sql).not.toContain("WHERE category");
    });

    it("should filter by category when provided", () => {
      const allMock = vi.fn().mockReturnValue([]);
      mockDb.prepare.mockReturnValue({ all: allMock });

      getUserFacts("health");

      expect(allMock).toHaveBeenCalledWith("health");
      const sql = mockDb.prepare.mock.calls[0][0] as string;
      expect(sql).toContain("WHERE category = ?");
    });
  });

  describe("deleteUserFact", () => {
    it("should return true when a fact was deleted", () => {
      const runMock = vi.fn().mockReturnValue({ changes: 1 });
      mockDb.prepare.mockReturnValue({ run: runMock });

      const result = deleteUserFact("personal", "age");

      expect(result).toBe(true);
      expect(runMock).toHaveBeenCalledWith("personal", "age");
    });

    it("should return false when no fact matched", () => {
      const runMock = vi.fn().mockReturnValue({ changes: 0 });
      mockDb.prepare.mockReturnValue({ run: runMock });

      const result = deleteUserFact("personal", "nonexistent");

      expect(result).toBe(false);
    });
  });

  describe("formatUserFactsBlock", () => {
    it("should return empty string when no facts", () => {
      mockDb.prepare.mockReturnValue({ all: vi.fn().mockReturnValue([]) });

      expect(formatUserFactsBlock()).toBe("");
    });

    it("should format facts grouped by category", () => {
      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue([
          {
            category: "personal",
            key: "age",
            value: "30",
            source: "conversation",
            updated_at: "2026-03-18",
          },
          {
            category: "personal",
            key: "name",
            value: "Fede",
            source: "conversation",
            updated_at: "2026-03-18",
          },
          {
            category: "health",
            key: "diet",
            value: "high protein",
            source: "conversation",
            updated_at: "2026-03-18",
          },
        ]),
      });

      const block = formatUserFactsBlock();

      expect(block).toContain("Perfil del usuario");
      expect(block).toContain("NUNCA los olvides");
      expect(block).toContain("### personal");
      expect(block).toContain("**age**: 30");
      expect(block).toContain("**name**: Fede");
      expect(block).toContain("### health");
      expect(block).toContain("**diet**: high protein");
    });

    it("2026-09-06: always-inject facts do not consume the scored budget", () => {
      // Live regression: `personal` alone was 3,726 chars, so every scored
      // fact (all 197 `projects` rows) was skipped on every turn since 05-24.
      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue([
          {
            category: "personal",
            key: "bio",
            value: "x".repeat(3_100),
            source: "conversation",
            updated_at: "2026-05-24",
          },
          {
            category: "projects",
            key: "fantasy_espn_s2",
            value: "cookie-value",
            source: "conversation",
            updated_at: "2026-09-05",
          },
        ]),
      });

      const block = formatUserFactsBlock(
        "Revisa que puedes entrar al Fantasy de Espn vía API",
      );

      expect(block).toContain("**bio**:");
      expect(block).toContain("**fantasy_espn_s2**: cookie-value");
    });

    it("2026-09-06 qa-audit C1: a fact with no keyword overlap is never injected on an unrelated message", () => {
      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue([
          {
            category: "projects",
            key: "fantasy_espn_s2",
            value: "cookie-value",
            source: "conversation",
            updated_at: "2026-09-05",
          },
          {
            category: "projects",
            key: "doctoralia_password",
            value: "secret-value",
            source: "conversation",
            updated_at: "2026-09-04",
          },
        ]),
      });

      const block = formatUserFactsBlock("Cómo está la ofensiva de SEA?");

      expect(block).toContain("Perfil del usuario");
      expect(block).not.toContain("cookie-value");
      expect(block).not.toContain("secret-value");
    });

    it("qa-audit R2: a message with no scorable word injects no scored fact (no recency fallback)", () => {
      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue([
          {
            category: "projects",
            key: "fantasy_espn_s2",
            value: "cookie-value",
            source: "conversation",
            updated_at: "2026-09-05",
          },
        ]),
      });

      expect(formatUserFactsBlock("?")).not.toContain("cookie-value");
    });

    it("scored facts still respect their own budget (newest relevant first)", () => {
      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue([
          {
            category: "projects",
            key: "fantasy_one",
            value: "a".repeat(2_000),
            source: "conversation",
            updated_at: "2026-09-05",
          },
          {
            category: "projects",
            key: "fantasy_two",
            value: "b".repeat(2_000),
            source: "conversation",
            updated_at: "2026-09-04",
          },
        ]),
      });

      const block = formatUserFactsBlock("fantasy");

      expect(block).toContain("**fantasy_one**:");
      expect(block).not.toContain("**fantasy_two**:");
    });
  });
});
