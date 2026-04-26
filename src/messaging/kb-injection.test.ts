import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  conditionMatches,
  detectProjectInMessage,
  buildKnowledgeBaseSection,
} from "./kb-injection.js";

vi.mock("../db/jarvis-fs.js", () => ({
  getFilesByQualifier: vi.fn(),
  getFile: vi.fn(),
}));
import { getFilesByQualifier, getFile } from "../db/jarvis-fs.js";

describe("conditionMatches (KB injection conditional matcher)", () => {
  it("matches coding when shell_exec is scoped", () => {
    expect(conditionMatches("coding", ["shell_exec", "file_read"])).toBe(true);
  });

  it("does NOT match coding without any CODING_TOOLS in scope", () => {
    expect(conditionMatches("coding", ["gmail_send", "northstar_sync"])).toBe(
      false,
    );
  });

  it("matches teaching for both learning_plan_* and learner_model_status", () => {
    expect(conditionMatches("teaching", ["learning_plan_quiz"])).toBe(true);
    expect(conditionMatches("teaching", ["learner_model_status"])).toBe(true);
  });

  it("matches multi-keyword conditions on any keyword", () => {
    expect(conditionMatches("reporting, schedule, crm", ["crm_query"])).toBe(
      true,
    );
    expect(
      conditionMatches("reporting, schedule, crm", ["schedule_task"]),
    ).toBe(true);
    expect(conditionMatches("reporting, schedule, crm", ["web_search"])).toBe(
      true,
    );
  });

  it("does NOT match when no keyword maps to any scoped tool", () => {
    expect(conditionMatches("coding", ["gmail_search"])).toBe(false);
    expect(conditionMatches("teaching", ["shell_exec"])).toBe(false);
    expect(conditionMatches("crm", [])).toBe(false);
  });

  it("matches google for any GOOGLE_TOOLS member, not just gmail_send", () => {
    expect(conditionMatches("google", ["gdrive_list"])).toBe(true);
    expect(conditionMatches("google", ["calendar_list"])).toBe(true);
  });

  it("schedule no longer matches via always-on list_schedules sentinel", () => {
    expect(conditionMatches("schedule", ["list_schedules"])).toBe(false);
    expect(conditionMatches("schedule", ["schedule_task"])).toBe(true);
    expect(conditionMatches("schedule", ["delete_schedule"])).toBe(true);
  });

  it("is case-insensitive on the condition string", () => {
    expect(conditionMatches("CODING", ["shell_exec"])).toBe(true);
    expect(conditionMatches("Teaching", ["learning_plan_quiz"])).toBe(true);
  });

  it("returns false on empty condition", () => {
    expect(conditionMatches("", ["shell_exec"])).toBe(false);
  });
});

describe("detectProjectInMessage", () => {
  it("detects exact slug", () => {
    expect(detectProjectInMessage("update vlmp")).toBe("vlmp");
  });

  it("detects natural-name aliases", () => {
    expect(detectProjectInMessage("how is the cuatro flor doing")).toBe(
      "cuatro-flor",
    );
  });

  it("aliases bare 'crm' to crm-azteca", () => {
    expect(detectProjectInMessage("status del CRM")).toBe("crm-azteca");
  });

  it("aliases bare 'williams' to williams-radar", () => {
    expect(detectProjectInMessage("Williams ranking")).toBe("williams-radar");
  });

  it("returns null when no project mentioned", () => {
    expect(detectProjectInMessage("what time is it")).toBe(null);
  });
});

describe("buildKnowledgeBaseSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns enforce-only section when enforceOnly=true", () => {
    vi.mocked(getFilesByQualifier).mockReturnValue([
      {
        path: "directives/repo-authorization.md",
        title: "Repo Authorization",
        content: "Only EurekaMD repos",
        qualifier: "enforce",
        condition: null,
        priority: 0,
      },
    ]);
    const result = buildKnowledgeBaseSection([], true);
    expect(result).toContain("[JARVIS KNOWLEDGE BASE]");
    expect(result).toContain("MANDATORY: Repo Authorization");
    expect(result).toContain("Only EurekaMD repos");
    expect(getFilesByQualifier).toHaveBeenCalledWith("enforce");
  });

  it("returns null when no files match", () => {
    vi.mocked(getFilesByQualifier).mockReturnValue([]);
    expect(buildKnowledgeBaseSection([], false)).toBe(null);
  });

  it("includes always-read + matching-conditional + skips non-matching conditional", () => {
    vi.mocked(getFilesByQualifier).mockReturnValue([
      {
        path: "always.md",
        title: "Always",
        content: "AC",
        qualifier: "always-read",
        condition: null,
        priority: 0,
      },
      {
        path: "code.md",
        title: "Code SOP",
        content: "SOP",
        qualifier: "conditional",
        condition: "coding",
        priority: 0,
      },
      {
        path: "teach.md",
        title: "Teach",
        content: "TC",
        qualifier: "conditional",
        condition: "teaching",
        priority: 0,
      },
    ]);
    const result = buildKnowledgeBaseSection(["shell_exec"], false);
    expect(result).toContain("Always");
    expect(result).toContain("Code SOP");
    expect(result).not.toContain("TC");
  });

  it("falls through gracefully on DB error (returns null, no throw)", () => {
    vi.mocked(getFilesByQualifier).mockImplementation(() => {
      throw new Error("DB closed");
    });
    expect(buildKnowledgeBaseSection([], false)).toBe(null);
  });

  it("never includes reference-qualifier files (e.g. code-evaluations journal)", () => {
    vi.mocked(getFilesByQualifier).mockImplementation((...quals: string[]) => {
      const all = [
        {
          path: "knowledge/procedures/code-generation-sop.md",
          title: "SOP",
          content: "evergreen",
          qualifier: "conditional",
          condition: "coding",
          priority: 50,
        },
        {
          path: "knowledge/journal/code-evaluations.md",
          title: "Journal",
          content: "27 KB of project evaluations",
          qualifier: "reference",
          condition: null,
          priority: 50,
        },
      ];
      return all.filter((f) => quals.includes(f.qualifier));
    });
    const result = buildKnowledgeBaseSection(["shell_exec"], false);
    expect(result).toContain("SOP");
    expect(result).not.toContain("27 KB of project evaluations");
    expect(result).not.toContain("Journal");
  });

  it("auto-injects project README when message mentions a known slug", () => {
    vi.mocked(getFilesByQualifier).mockReturnValue([
      {
        path: "always.md",
        title: "Always",
        content: "AC",
        qualifier: "always-read",
        condition: null,
        priority: 0,
      },
    ]);
    vi.mocked(getFile).mockReturnValue({
      id: "r",
      path: "projects/vlmp/README.md",
      title: "VLMP",
      content: "Very Light Media Player",
      tags: "[]",
      qualifier: "reference",
      condition: null,
      priority: 50,
      related_to: "[]",
      created_at: "",
      updated_at: "",
      user_edit_time: null,
    });
    const result = buildKnowledgeBaseSection([], false, "tell me about vlmp");
    expect(result).toContain("Project Context: VLMP");
    expect(result).toContain("Very Light Media Player");
  });
});
