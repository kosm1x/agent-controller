/**
 * Classifier unit tests.
 * Tests the heuristic scoring and agent type routing.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  classify,
  isCodingTask,
  needsHeavyReasoning,
  targetsForeignRepo,
} from "./classifier.js";
import type {
  RunnerStats,
  KeywordOutcomeRow,
  FeedbackStats,
} from "../db/task-outcomes.js";

describe("classifier", () => {
  it("should classify short simple tasks as fast", () => {
    const result = classify({
      title: "Disk usage",
      description: "Show disk usage",
    });
    expect(result.agentType).toBe("fast");
    expect(result.score).toBeLessThan(3);
    expect(result.explicit).toBe(false);
  });

  it("should classify isolation keywords as nanoclaw", () => {
    const result = classify({
      title: "Run in container",
      description:
        "Execute this task in a sandbox environment with proper isolation",
    });
    expect(result.agentType).toBe("nanoclaw");
    expect(result.score).toBeGreaterThanOrEqual(3);
    expect(result.score).toBeLessThan(6);
  });

  it("should classify multi-step (non-coding) tasks as heavy", () => {
    // Coding multi-step tasks now route to the nanoclaw sandbox; a multi-step
    // NON-coding task (analysis/strategy across scopes, in parallel) → heavy.
    const result = classify({
      title: "Market positioning review",
      description:
        "Evaluate our market positioning across all regional segments, working the strategic options in parallel, then recommend a prioritized roadmap.",
    });
    expect(result.agentType).toBe("heavy");
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  it("should classify parallelizable tasks as swarm", () => {
    const result = classify({
      title: "Full audit",
      description:
        "Audit all 12 service modules for security. Check multiple files across all services. Each module independently reviewed in parallel.",
    });
    expect(result.agentType).toBe("swarm");
    expect(result.score).toBeGreaterThanOrEqual(9);
  });

  it("should respect explicit agent_type override", () => {
    const result = classify({
      title: "Simple task",
      description: "Very short",
      agentType: "heavy",
    });
    expect(result.agentType).toBe("heavy");
    expect(result.explicit).toBe(true);
    expect(result.score).toBe(-1);
  });

  it("should treat auto as non-explicit", () => {
    const result = classify({
      title: "Simple task",
      description: "Very short",
      agentType: "auto",
    });
    expect(result.explicit).toBe(false);
    expect(result.agentType).toBe("fast");
  });

  it("should boost score with tags", () => {
    const simple = classify({
      title: "Task",
      description: "A task",
    });
    const withTags = classify({
      title: "Task",
      description: "A task",
      tags: ["complex", "research"],
    });
    expect(withTags.score).toBeGreaterThan(simple.score);
  });

  it("should boost score for critical priority", () => {
    const normal = classify({
      title: "Task",
      description: "A moderate length task description for testing",
    });
    const critical = classify({
      title: "Task",
      description: "A moderate length task description for testing",
      priority: "critical",
    });
    expect(critical.score).toBe(normal.score + 1);
  });

  it("should account for description length", () => {
    const shortDesc = classify({
      title: "Task",
      description: "Short",
    });
    const longDesc = classify({
      title: "Task",
      description: Array(201).fill("word").join(" "),
    });
    expect(longDesc.score).toBeGreaterThan(shortDesc.score);
  });

  // Model tier tests
  it("should recommend flash model for simple tasks", () => {
    const result = classify({
      title: "Disk usage",
      description: "Show disk usage",
    });
    expect(result.modelTier).toBe("flash");
  });

  it("should recommend capable model for architecture tasks", () => {
    const result = classify({
      title: "Review auth",
      description:
        "Review the authentication architecture and suggest improvements",
    });
    expect(result.modelTier).toBe("capable");
  });

  it("should recommend standard model for medium complexity", () => {
    const result = classify({
      title: "Weekly summary",
      description: Array(101).fill("word").join(" "),
    });
    expect(result.modelTier).toBe("standard");
  });

  it("should assign flash tier for short messaging tasks", () => {
    const result = classify({
      title: "Chat: hola",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("fast");
    expect(result.modelTier).toBe("flash");
  });

  it("should assign capable tier for research messaging tasks", () => {
    const result = classify({
      title: "Chat: Investiga las tendencias del mercado de AI en 2026",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("fast");
    expect(result.modelTier).toBe("capable");
  });

  it("should assign standard tier for medium messaging tasks", () => {
    const result = classify({
      title: "Chat: Necesito que me ayudes con un correo para el cliente",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("fast");
    expect(result.modelTier).toBe("standard");
  });

  it("should assign capable tier when user message has architecture signals", () => {
    const result = classify({
      title: "Chat: Analiza el rendimiento del pipeline y hazme un audit",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("fast");
    expect(result.modelTier).toBe("capable");
  });

  it("should set standard model tier for explicit overrides", () => {
    const result = classify({
      title: "Simple task",
      description: "Very short",
      agentType: "heavy",
    });
    expect(result.modelTier).toBe("standard");
  });

  // 2026-05-06 regression — task b59dbab6 fired a 52-word ranking question,
  // routed to flash, fabricated 1500 words of farmacia rankings without
  // calling the DENUE API. New high-stakes-data tier-upgrade keywords cover
  // the prompt patterns that should never be answered without DB access.
  it("should tier up to capable for greenfield site-selection prompts (regression b59dbab6)", () => {
    const result = classify({
      title: "Top farmacias greenfield CDMX",
      description:
        "Dame el top 10 de AGEBs en CDMX para abrir una farmacia greenfield. Output narrativo, una decisión de site-selection.",
    });
    expect(result.modelTier).toBe("capable");
    expect(result.reason).toContain("high-stakes data prompt");
  });

  it("should tier up to capable for ranking-de-X prompts in Spanish", () => {
    const result = classify({
      title: "Ranking municipios pharma",
      description: "Dame el ranking de municipios para abrir farmacia",
    });
    expect(result.modelTier).toBe("capable");
  });

  it("should tier up to capable for 'qué AGEB / colonia' wh-questions", () => {
    const result = classify({
      title: "AGEB selection",
      description: "Qué AGEB es la mejor para abrir un local en Iztapalapa",
    });
    expect(result.modelTier).toBe("capable");
  });

  it("should NOT tier up to capable for routine non-data tasks", () => {
    const result = classify({
      title: "Disk usage",
      description: "Show disk usage of /var/log",
    });
    expect(result.modelTier).toBe("flash");
  });

  // ----- Coding → nanoclaw sandbox, challenging → heavy (2026-06-19) -----
  // All coding tasks run containerized (nanoclaw = sandboxed Prometheus PER);
  // genuinely challenging non-coding requests get heavy's PER loop; else fast.
  it("routes a build/ship coding chat to nanoclaw (regression 6511)", () => {
    const result = classify({
      title:
        "Chat: Haz un plan para el cambio 3. Execute, test, audit, commit a...",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("nanoclaw");
    expect(result.reason).toContain("coding task");
  });

  it("routes a code-authoring chat (verb+noun) to nanoclaw", () => {
    const result = classify({
      title: "Chat: implement the retry endpoint and add a test",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("nanoclaw");
  });

  it("routes a refactor chat to nanoclaw (strong solo coding signal)", () => {
    const result = classify({
      title: "Chat: refactoriza el módulo de auth",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("nanoclaw");
  });

  it("routes a challenging non-coding chat to heavy", () => {
    const result = classify({
      title: "Chat: analiza nuestra estrategia comercial y recomienda pasos",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("heavy");
    expect(result.reason).toContain("challenging");
  });

  it("keeps a bare 'commit and push' chat on fast (host git op, not authoring)", () => {
    const result = classify({
      title: "Chat: commit and push",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("fast");
  });

  // ----- Foreign-repo git ops stay on the HOST, never nanoclaw (2026-06-20) -----
  // The nanoclaw sandbox only mounts /root/claude/mission-control. A git/file op on
  // a sibling repo (e.g. the Williams Journal) routed to nanoclaw silently never
  // lands on the host — the W25 journal publish regression.
  it("keeps a journal git-commit task OFF nanoclaw (foreign repo → host)", () => {
    const result = classify({
      title: "Git commit W25 journal",
      description:
        "git_commit en /root/claude/thewilliamsradar-journal: staged files = " +
        "[pages/w25-2026.md], commit message = feat: publish W25. Luego git_push a origin main.",
    });
    expect(result.agentType).not.toBe("nanoclaw");
    expect(result.agentType).toBe("fast");
  });

  it("still routes a mission-control coding task to nanoclaw (control)", () => {
    const result = classify({
      title: "git commit the fix in /root/claude/mission-control/src/scope.ts",
      description: "tighten the EMAIL_SEND_RE regex and push",
    });
    expect(result.agentType).toBe("nanoclaw");
  });

  it("keeps a messaging journal task OFF nanoclaw when the path is in the title", () => {
    // Messaging tasks classify on the TITLE only (description is persona-inflated).
    // When the sibling-repo path is visible in the title, the guard still fires.
    const result = classify({
      title: "Chat: git commit en /root/claude/thewilliamsradar-journal y push",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).not.toBe("nanoclaw");
  });

  it("GAP CLOSED: a path-less journal-commit messaging chat stays on the host", () => {
    // Was the qa W1 residual: "commit the journal repo" named no absolute path, so
    // the foreign-repo guard couldn't fire and it landed on nanoclaw (silent-fail).
    // Closed 2026-06-20 by dropping lone "repo" from STRONG_CODING_PATTERNS — a bare
    // "repo" mention is too weak a coding signal. With no git/filename/verb×noun
    // signal, this is no longer a coding task → it stays on `fast` (host), where the
    // git_* tools can actually reach the repo. Genuine coding ("fix the repo bug",
    // "git commit …") still routes via the remaining strong/verb×noun signals.
    const result = classify({
      title: "Chat: commit the journal repo and push to origin",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).not.toBe("nanoclaw");
    expect(result.agentType).toBe("fast");
  });

  it("keeps a 'guarda en el repo' KB-save chat OFF nanoclaw (silent-save regression)", () => {
    // Task 6548 (2026-06-20): "Guarda esto en el repo y marca las cadenas como
    // target" was forced to nanoclaw by the lone word "repo", which can't reach the
    // KB → 0 tool calls, nothing saved. A save-to-KB chat must stay on the host
    // (fast), where jarvis_file_write/project_update exist.
    const result = classify({
      title: "Chat: Guarda esto en el repo y marca las cadenas como target",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).not.toBe("nanoclaw");
    expect(result.agentType).toBe("fast");
  });

  it("treats 'repo' as non-coding (lone OR verb-paired) — real code work has a specific noun", () => {
    // "repo" is neither a strong signal nor a coding noun: in chat it's ambiguous
    // between a git repo and the KB. A verb×repo paraphrase ("agrega esto al repo")
    // is the same silent-save class as the original bug → must stay off nanoclaw.
    expect(isCodingTask("guarda esto en el repo")).toBe(false);
    expect(isCodingTask("agrega esto al repo")).toBe(false);
    expect(isCodingTask("add this note to the repo")).toBe(false);
    // Genuine code work still routes via a specific noun / strong signal:
    expect(isCodingTask("fix the bug in the repo")).toBe(true); // bug
    expect(isCodingTask("rename the branch")).toBe(true); // branch
    expect(isCodingTask("git commit and push the fix")).toBe(true); // git
  });

  describe("targetsForeignRepo", () => {
    it("flags /root/claude sibling repos as foreign", () => {
      expect(
        targetsForeignRepo(
          "git_commit en /root/claude/thewilliamsradar-journal",
        ),
      ).toBe(true);
      expect(
        targetsForeignRepo("cd /root/claude/williams-entry-radar && git add"),
      ).toBe(true);
      expect(
        targetsForeignRepo("edit /root/claude/crm-azteca/src/index.ts"),
      ).toBe(true);
    });

    it("does NOT flag the mission-control checkout", () => {
      expect(targetsForeignRepo("/root/claude/mission-control")).toBe(false);
      expect(
        targetsForeignRepo("edit /root/claude/mission-control/src/scope.ts"),
      ).toBe(false);
    });

    it("does NOT flag a bare ellipsis or pathless text", () => {
      expect(targetsForeignRepo("filesystem access at /root/claude/...")).toBe(
        false,
      );
      expect(targetsForeignRepo("just refactor the auth module")).toBe(false);
    });
  });

  it("keeps a plain chat on fast", () => {
    const result = classify({
      title: "Chat: cómo va el día?",
      description: "You are Jarvis, a strategic AI assistant...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("fast");
  });
});

describe("classifier — coding/heavy routing predicates (2026-06-19)", () => {
  afterEach(() => {
    delete process.env.MESSAGING_HEAVY_ESCALATION;
  });

  it("isCodingTask: code authoring → true; host git ops / prose / strategy → false", () => {
    expect(isCodingTask("Chat: refactoriza el módulo")).toBe(true);
    expect(isCodingTask("implement the endpoint and write a test")).toBe(true);
    expect(
      isCodingTask("Chat: haz un plan y ejecuta el cambio, luego commit"),
    ).toBe(
      true, // build×ship co-occurrence
    );
    expect(isCodingTask("git rebase onto main and merge")).toBe(true);
    expect(isCodingTask("commit and push")).toBe(false); // lone ship verbs = host git op
    expect(isCodingTask("write an email to the client")).toBe(false);
    expect(isCodingTask("build a 2027 commercial strategy")).toBe(false);
  });

  it("isCodingTask: ES 'comité' false-positive guard still holds", () => {
    expect(isCodingTask("implementa el plan del comité de marketing")).toBe(
      false,
    );
  });

  it("isCodingTask: incremental edits sandbox (C1 — no coding escapes the invariant)", () => {
    expect(isCodingTask("fix the login flow")).toBe(true);
    expect(isCodingTask("rename the function")).toBe(true);
    expect(isCodingTask("bump the dependency")).toBe(true);
    expect(isCodingTask("add a column to the users table")).toBe(true);
    expect(isCodingTask("tighten the regex in scope.ts")).toBe(true); // filename
    expect(isCodingTask("update users.sql")).toBe(true); // filename
    expect(isCodingTask("optimize the query")).toBe(true);
    expect(isCodingTask("modifica el endpoint de auth")).toBe(true);
    expect(isCodingTask("remove the import in config.ts")).toBe(true);
    expect(isCodingTask("wire up the webhook handler")).toBe(true);
    expect(isCodingTask("patch the vulnerability")).toBe(true);
    expect(isCodingTask("migrate the schema")).toBe(true);
    expect(isCodingTask("delete the route")).toBe(true);
  });

  it("isCodingTask: non-coding 'merge'/'build+deploy' prose stays out of the sandbox", () => {
    expect(isCodingTask("merge the two spreadsheets")).toBe(false); // polysemous merge
    expect(isCodingTask("build a strategy and deploy the team")).toBe(false); // build×ship prose
    expect(isCodingTask("create a report for the client")).toBe(false);
  });

  it("needsHeavyReasoning: architecture/strategy/multi-step → true; bare research → false", () => {
    expect(needsHeavyReasoning("redesign the architecture")).toBe(true);
    expect(needsHeavyReasoning("diseña la estrategia 2027")).toBe(true);
    expect(needsHeavyReasoning("analiza el mercado y recomienda pasos")).toBe(
      true,
    );
    expect(needsHeavyReasoning("compare the options and pick one")).toBe(true);
    expect(needsHeavyReasoning("investiga las tendencias de AI")).toBe(false); // bare research
    expect(needsHeavyReasoning("cómo estás?")).toBe(false);
  });

  it("INVARIANT: a non-messaging (auto) coding task is containerized → nanoclaw", () => {
    const result = classify({
      title: "Debug the slot-finder script",
      description: "There is a bug in the module; debug and patch the code.",
    });
    expect(result.agentType).toBe("nanoclaw");
  });

  it("kill switch: MESSAGING_HEAVY_ESCALATION=false reverts a coding chat to fast", () => {
    process.env.MESSAGING_HEAVY_ESCALATION = "false";
    const result = classify({
      title: "Chat: refactoriza el módulo de auth",
      description: "...",
      tags: ["messaging"],
    });
    expect(result.agentType).toBe("fast");
  });

  it("kill switch does NOT affect non-messaging coding (invariant holds)", () => {
    process.env.MESSAGING_HEAVY_ESCALATION = "false";
    const result = classify({
      title: "Refactor the auth module",
      description: "...",
    });
    expect(result.agentType).toBe("nanoclaw");
  });
});

// ---------------------------------------------------------------------------
// Outcome adjustment tests (mock DB for these)
// ---------------------------------------------------------------------------

describe("classifier outcome adjustments", () => {
  function makeStats(overrides: Partial<RunnerStats>[]): RunnerStats[] {
    return overrides.map((o) => ({
      ran_on: "fast",
      total: 20,
      successes: 18,
      avg_duration_ms: 5000,
      success_rate: 0.9,
      avg_cost_usd: 0.01,
      ...o,
    }));
  }

  async function classifyWith(
    stats: RunnerStats[],
    keywords: KeywordOutcomeRow[],
    input: { title: string; description: string },
    feedbackStats: FeedbackStats[] = [],
  ) {
    vi.resetModules();
    vi.doMock("../db/task-outcomes.js", () => ({
      queryRunnerStats: () => stats,
      queryOutcomesByKeywords: () => keywords,
      queryFeedbackQuality: () => feedbackStats,
    }));
    const { classify: c } = await import("./classifier.js");
    return c(input);
  }

  it("should return 0 adjustment with insufficient data", async () => {
    const result = await classifyWith(makeStats([{ total: 5 }]), [], {
      title: "Test",
      description: "task",
    });
    expect(result.score).toBeLessThan(3);
  });

  it("should pull score down when fast has high success rate", async () => {
    const result = await classifyWith(
      makeStats([
        { ran_on: "fast", total: 50, successes: 48, success_rate: 0.96 },
      ]),
      [],
      { title: "Test", description: "task" },
    );
    expect(result.reason).toContain("prefer fast");
  });

  it("should push score up when fast has low success rate", async () => {
    const result = await classifyWith(
      makeStats([
        { ran_on: "fast", total: 20, successes: 8, success_rate: 0.4 },
      ]),
      [],
      { title: "Test", description: "task" },
    );
    expect(result.reason).toContain("try heavier");
  });

  it("should detect heavy duration anomaly", async () => {
    const result = await classifyWith(
      makeStats([
        { ran_on: "fast", total: 30, success_rate: 0.7 },
        {
          ran_on: "heavy",
          total: 10,
          avg_duration_ms: 8000,
          success_rate: 0.8,
        },
      ]),
      [],
      { title: "Test", description: "task" },
    );
    expect(result.reason).toContain("over-classified");
  });

  it("should penalize expensive low-success runners", async () => {
    const result = await classifyWith(
      makeStats([
        { ran_on: "fast", total: 30, success_rate: 0.7 },
        { ran_on: "heavy", total: 10, success_rate: 0.3, avg_cost_usd: 0.1 },
      ]),
      [],
      { title: "Test", description: "task" },
    );
    expect(result.reason).toContain("costly");
  });

  it("should nudge toward runner that succeeds on similar tasks", async () => {
    const similar: KeywordOutcomeRow[] = [
      { task_id: "t1", ran_on: "nanoclaw", success: 1, duration_ms: 5000 },
      { task_id: "t2", ran_on: "nanoclaw", success: 1, duration_ms: 6000 },
      { task_id: "t3", ran_on: "nanoclaw", success: 1, duration_ms: 4000 },
      { task_id: "t4", ran_on: "fast", success: 0, duration_ms: 3000 },
    ];
    const result = await classifyWith(
      makeStats([
        { ran_on: "fast", total: 30, success_rate: 0.7 },
        { ran_on: "nanoclaw", total: 10, success_rate: 0.8 },
      ]),
      similar,
      {
        title: "Quarterly numbers",
        description: "tally the quarterly numbers across regions",
      },
    );
    expect(result.reason).toContain("similar tasks");
  });

  it("should clamp total adjustment to [-3, +4]", async () => {
    const result = await classifyWith(
      makeStats([
        { ran_on: "fast", total: 50, success_rate: 0.95 },
        {
          ran_on: "heavy",
          total: 10,
          avg_duration_ms: 5000,
          success_rate: 0.3,
        },
      ]),
      [],
      { title: "Test", description: "task" },
    );
    expect(result.score).toBeGreaterThanOrEqual(-3);
  });

  it("should nudge score up when fast+flash has high negative rate", async () => {
    const fbStats: FeedbackStats[] = [
      {
        ran_on: "fast",
        model_tier: "flash",
        total: 10,
        negative_count: 3,
        negative_rate: 0.3,
      },
    ];
    const result = await classifyWith(
      makeStats([{ ran_on: "fast", total: 30, success_rate: 0.7 }]),
      [],
      { title: "Test", description: "task" },
      fbStats,
    );
    expect(result.reason).toContain("tier upgrade");
  });

  it("should not nudge when feedback data is insufficient", async () => {
    const result = await classifyWith(
      makeStats([{ ran_on: "fast", total: 30, success_rate: 0.7 }]),
      [],
      { title: "Test", description: "task" },
      [], // no feedback stats
    );
    expect(result.reason).not.toContain("tier upgrade");
  });
});
