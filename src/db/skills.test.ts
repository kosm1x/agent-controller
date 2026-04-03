/**
 * Skills CRUD tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = {
  prepare: vi.fn().mockReturnValue({
    run: vi.fn(),
    get: vi.fn(),
    all: vi.fn().mockReturnValue([]),
  }),
};

vi.mock("./index.js", () => ({
  getDatabase: () => mockDb,
}));

import {
  saveSkill,
  getSkill,
  listSkills,
  incrementSkillUsage,
  findSkillsByKeywords,
} from "./skills.js";

describe("skills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.prepare.mockReturnValue({
      run: vi.fn(),
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
    });
  });

  describe("saveSkill", () => {
    it("should insert skill and return skill_id", () => {
      const getFn = vi.fn().mockReturnValue({ skill_id: "test-uuid" });
      const runFn = vi.fn();
      mockDb.prepare
        .mockReturnValueOnce({ run: runFn })
        .mockReturnValueOnce({ get: getFn });

      const id = saveSkill({
        name: "weekly review",
        description: "Review goals and tasks for the week",
        trigger: "weekly review or revisión semanal",
        steps: ["list_goals", "list_tasks", "search_journal"],
        tools: ["project_list", "jarvis_file_read"],
      });

      expect(runFn).toHaveBeenCalled();
      expect(id).toBe("test-uuid");
    });
  });

  describe("getSkill", () => {
    it("should query by name or skill_id", () => {
      const getFn = vi.fn().mockReturnValue({ name: "test", skill_id: "abc" });
      mockDb.prepare.mockReturnValue({ get: getFn });

      getSkill("test");
      expect(getFn).toHaveBeenCalledWith("test", "test");
    });

    it("should return null when not found", () => {
      const getFn = vi.fn().mockReturnValue(undefined);
      mockDb.prepare.mockReturnValue({ get: getFn });

      expect(getSkill("nonexistent")).toBeNull();
    });
  });

  describe("listSkills", () => {
    it("should list all skills", () => {
      listSkills();
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining("SELECT * FROM skills ORDER BY"),
      );
    });

    it("should filter by active status", () => {
      listSkills({ active: true });
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining("WHERE active = ?"),
      );
    });
  });

  describe("incrementSkillUsage", () => {
    it("should increment use_count and success_count on success", () => {
      const runFn = vi.fn();
      mockDb.prepare.mockReturnValue({ run: runFn });

      incrementSkillUsage("skill-1", true);
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining("success_count = success_count + 1"),
      );
    });

    it("should only increment use_count on failure", () => {
      const runFn = vi.fn();
      mockDb.prepare.mockReturnValue({ run: runFn });

      incrementSkillUsage("skill-1", false);
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.not.stringContaining("success_count = success_count + 1"),
      );
    });
  });

  describe("findSkillsByKeywords", () => {
    it("should return empty for short words only", () => {
      expect(findSkillsByKeywords("do it")).toEqual([]);
    });

    it("should search trigger_text and name with LIKE", () => {
      findSkillsByKeywords("weekly review tasks");
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining("LOWER(trigger_text) LIKE"),
      );
    });
  });
});
