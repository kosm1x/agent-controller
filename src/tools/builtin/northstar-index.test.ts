/**
 * Unit tests for the NorthStar INDEX.md compass-narrative renderer.
 *
 * The renderer is a pure function over post-sync local entries + commit
 * data, so these tests don't touch the network/DB harness that
 * northstar-sync.test.ts mocks. Cover: hierarchy walk, status sort, orphan
 * footer, empty-data fallback, parent-resolution failure modes.
 */

import { describe, it, expect } from "vitest";
import {
  renderCompassIndex,
  type IndexKind,
  type IndexLocalEntry,
  type IndexCommitItem,
} from "./northstar-index.js";

const META = {
  bootstrap: false,
  totalListed: 0,
  syncedAt: "2026-05-09T00:00:00.000Z",
};

function emptyLocals(): Record<IndexKind, IndexLocalEntry[]> {
  return { vision: [], goal: [], objective: [], task: [] };
}

function emptyCommits(): Record<IndexKind, Map<string, IndexCommitItem>> {
  return {
    vision: new Map(),
    goal: new Map(),
    objective: new Map(),
    task: new Map(),
  };
}

function commit(
  id: string,
  title: string,
  status: string,
  parents: Partial<IndexCommitItem> = {},
): IndexCommitItem {
  return { id, title, status, ...parents };
}

function local(commitId: string, path: string, content = ""): IndexLocalEntry {
  return { path, commitId, content };
}

describe("renderCompassIndex — empty state", () => {
  it("renders compass placeholder when no visions", () => {
    const md = renderCompassIndex(emptyLocals(), emptyCommits(), META);
    expect(md).toContain("# NorthStar — La Brújula");
    expect(md).toContain("Sin visiones registradas");
    expect(md).toContain("Local records: 0");
  });

  it("preserves bootstrap mode in footer", () => {
    const md = renderCompassIndex(emptyLocals(), emptyCommits(), {
      ...META,
      bootstrap: true,
    });
    expect(md).toContain("Mode: bootstrap (no deletes)");
  });

  it("preserves LWW mode in footer", () => {
    const md = renderCompassIndex(emptyLocals(), emptyCommits(), META);
    expect(md).toContain("Mode: LWW (deletes propagated)");
  });
});

describe("renderCompassIndex — hierarchy walk", () => {
  it("nests goal → objective → task under vision", () => {
    const locals = emptyLocals();
    const commits = emptyCommits();
    locals.vision.push(local("v1", "NorthStar/visions/v1.md"));
    commits.vision.set(
      "v1",
      commit("v1", "Vivir intencionalmente", "in_progress"),
    );
    locals.goal.push(local("g1", "NorthStar/goals/g1.md"));
    commits.goal.set(
      "g1",
      commit("g1", "Optimizar salud", "in_progress", { vision_id: "v1" }),
    );
    locals.objective.push(local("o1", "NorthStar/objectives/o1.md"));
    commits.objective.set(
      "o1",
      commit("o1", "Bajar FC", "in_progress", { goal_id: "g1" }),
    );
    locals.task.push(local("t1", "NorthStar/tasks/t1.md"));
    commits.task.set(
      "t1",
      commit("t1", "Subir 15 pisos diarios", "in_progress", {
        objective_id: "o1",
      }),
    );

    const md = renderCompassIndex(locals, commits, { ...META, totalListed: 4 });

    // Vision header
    expect(md).toContain("## 📍 Vivir intencionalmente");
    // Goal header (sub-section under vision)
    expect(md).toContain("### 📍 Optimizar salud — in_progress");
    // Objective bullet (under goal)
    expect(md).toMatch(/- 📍 \*\*\[Bajar FC\]/);
    // Task indented bullet (under objective)
    expect(md).toMatch(/  - 📍 \[Subir 15 pisos diarios\]/);
    // No orphan footer when everything is linked
    expect(md).not.toContain("## Sin parent");
  });

  it("sorts active records before completed within a level", () => {
    const locals = emptyLocals();
    const commits = emptyCommits();
    locals.vision.push(local("v1", "NorthStar/visions/v1.md"));
    commits.vision.set("v1", commit("v1", "Visión", "in_progress"));
    locals.goal.push(local("gA", "NorthStar/goals/gA.md"));
    locals.goal.push(local("gB", "NorthStar/goals/gB.md"));
    commits.goal.set(
      "gA",
      commit("gA", "Aaaa-completed", "completed", { vision_id: "v1" }),
    );
    commits.goal.set(
      "gB",
      commit("gB", "Bbbb-active", "in_progress", { vision_id: "v1" }),
    );

    const md = renderCompassIndex(locals, commits, { ...META, totalListed: 3 });
    const activeIdx = md.indexOf("Bbbb-active");
    const completedIdx = md.indexOf("Aaaa-completed");
    expect(activeIdx).toBeGreaterThan(0);
    expect(completedIdx).toBeGreaterThan(activeIdx);
  });

  it("renders 'sin metas activas' when vision has no goals", () => {
    const locals = emptyLocals();
    const commits = emptyCommits();
    locals.vision.push(local("v1", "NorthStar/visions/v1.md"));
    commits.vision.set("v1", commit("v1", "Visión sola", "in_progress"));

    const md = renderCompassIndex(locals, commits, { ...META, totalListed: 1 });
    expect(md).toContain("Visión sola");
    expect(md).toContain("Sin metas activas bajo esta visión");
  });
});

describe("renderCompassIndex — orphan footer", () => {
  it("captures records whose parent is not in commits", () => {
    const locals = emptyLocals();
    const commits = emptyCommits();
    locals.vision.push(local("v1", "NorthStar/visions/v1.md"));
    commits.vision.set("v1", commit("v1", "Visión", "in_progress"));
    // Goal references a vision_id that doesn't exist on commit
    locals.goal.push(local("orphan-g", "NorthStar/goals/orphan-g.md"));
    commits.goal.set(
      "orphan-g",
      commit("orphan-g", "Meta huérfana", "blocked", {
        vision_id: "v-missing",
      }),
    );

    const md = renderCompassIndex(locals, commits, { ...META, totalListed: 2 });
    expect(md).toContain("## Sin parent");
    expect(md).toContain("**Meta**: [Meta huérfana]");
  });

  it("captures parentless tasks (no objective_id)", () => {
    const locals = emptyLocals();
    const commits = emptyCommits();
    locals.vision.push(local("v1", "NorthStar/visions/v1.md"));
    commits.vision.set("v1", commit("v1", "Visión", "in_progress"));
    locals.task.push(local("t-orphan", "NorthStar/tasks/t-orphan.md"));
    commits.task.set(
      "t-orphan",
      commit("t-orphan", "Tarea suelta", "in_progress"),
    );

    const md = renderCompassIndex(locals, commits, { ...META, totalListed: 2 });
    expect(md).toContain("**Tarea**: [Tarea suelta]");
  });

  it("uses local content fallback when commit data is missing", () => {
    // Mid-sync race: local file has a commitId but commitData doesn't have
    // it any more (commit-side delete just propagated). Renderer falls back
    // to the file's `# Heading` and `Status:` lines.
    const locals = emptyLocals();
    const commits = emptyCommits();
    locals.task.push(
      local(
        "ghost",
        "NorthStar/tasks/ghost.md",
        "# Tarea fantasma\nStatus: in_progress\nPriority: high\n",
      ),
    );

    const md = renderCompassIndex(locals, commits, { ...META, totalListed: 1 });
    expect(md).toContain("**Tarea**: [Tarea fantasma]");
    expect(md).toContain("in_progress");
    // Audit W2: unsynced fallback path must surface a marker so a partial
    // Phase-4 failure that left a stale local file can't render as a normal
    // entry (operator visibility, not data-loss prevention).
    expect(md).toContain("`[unsynced]`");
  });

  // Audit W5: orphan ordering is operator-visible — pin the kind sequence
  // (goals → objectives → tasks) so a future loop reorder doesn't silently
  // flip the rendered list.
  it("orphan footer renders goals → objectives → tasks in that order", () => {
    const locals = emptyLocals();
    const commits = emptyCommits();
    locals.goal.push(local("g-orph", "NorthStar/goals/g-orph.md"));
    commits.goal.set(
      "g-orph",
      commit("g-orph", "Meta sin visión", "in_progress"),
    );
    locals.objective.push(local("o-orph", "NorthStar/objectives/o-orph.md"));
    commits.objective.set(
      "o-orph",
      commit("o-orph", "Objetivo sin meta", "in_progress"),
    );
    locals.task.push(local("t-orph", "NorthStar/tasks/t-orph.md"));
    commits.task.set(
      "t-orph",
      commit("t-orph", "Tarea sin objetivo", "in_progress"),
    );

    const md = renderCompassIndex(locals, commits, { ...META, totalListed: 3 });
    const gIdx = md.indexOf("**Meta**: [Meta sin visión]");
    const oIdx = md.indexOf("**Objetivo**: [Objetivo sin meta]");
    const tIdx = md.indexOf("**Tarea**: [Tarea sin objetivo]");
    expect(gIdx).toBeGreaterThan(0);
    expect(oIdx).toBeGreaterThan(gIdx);
    expect(tIdx).toBeGreaterThan(oIdx);
  });

  // Audit W6: when a goal is orphaned, its descendant objectives + tasks
  // should still appear (in the orphan footer) — not vanish silently.
  it("descendants of an orphan goal still render in footer", () => {
    const locals = emptyLocals();
    const commits = emptyCommits();
    locals.goal.push(local("g-orph", "NorthStar/goals/g-orph.md"));
    commits.goal.set(
      "g-orph",
      commit("g-orph", "Meta huérfana", "in_progress", { vision_id: "v-gone" }),
    );
    locals.objective.push(local("o-child", "NorthStar/objectives/o-child.md"));
    commits.objective.set(
      "o-child",
      commit("o-child", "Hijo de meta huérfana", "in_progress", {
        goal_id: "g-orph",
      }),
    );
    locals.task.push(local("t-grandchild", "NorthStar/tasks/t-grandchild.md"));
    commits.task.set(
      "t-grandchild",
      commit("t-grandchild", "Nieto de meta huérfana", "in_progress", {
        objective_id: "o-child",
      }),
    );

    const md = renderCompassIndex(locals, commits, { ...META, totalListed: 3 });
    expect(md).toContain("Meta huérfana");
    expect(md).toContain("Hijo de meta huérfana");
    expect(md).toContain("Nieto de meta huérfana");
  });
});

describe("renderCompassIndex — formatting invariants", () => {
  it("emits markdown links with correct paths", () => {
    const locals = emptyLocals();
    const commits = emptyCommits();
    locals.vision.push(local("v1", "NorthStar/visions/path-with-dashes.md"));
    commits.vision.set("v1", commit("v1", "Path test", "in_progress"));

    const md = renderCompassIndex(locals, commits, { ...META, totalListed: 1 });
    expect(md).toContain("(NorthStar/visions/path-with-dashes.md)");
  });

  // Audit W1: titles can contain `[`, `]`, `\` — these are user-typed via
  // the COMMIT app and must be escaped before going into Markdown link
  // syntax, otherwise `[FX trade [WIP]](path.md)` breaks at the inner `]`.
  it("escapes `[` and `]` in user-typed titles", () => {
    const locals = emptyLocals();
    const commits = emptyCommits();
    locals.vision.push(local("v1", "NorthStar/visions/v1.md"));
    commits.vision.set("v1", commit("v1", "Visión [sample]", "in_progress"));
    locals.goal.push(local("g1", "NorthStar/goals/g1.md"));
    commits.goal.set(
      "g1",
      commit("g1", "Meta [WIP]", "in_progress", { vision_id: "v1" }),
    );

    const md = renderCompassIndex(locals, commits, { ...META, totalListed: 2 });
    // Titles are present in escaped form
    expect(md).toContain("Visión \\[sample\\]");
    expect(md).toContain("Meta \\[WIP\\]");
    // No raw bracket pair survived inside link labels
    expect(md).not.toMatch(/\[Meta \[WIP\]\]/);
  });

  it("escapes backslashes in titles", () => {
    const locals = emptyLocals();
    const commits = emptyCommits();
    locals.task.push(local("t1", "NorthStar/tasks/t1.md"));
    commits.task.set("t1", commit("t1", "Path\\with\\slash", "in_progress"));

    const md = renderCompassIndex(locals, commits, { ...META, totalListed: 1 });
    expect(md).toContain("Path\\\\with\\\\slash");
  });

  it("includes total record count in footer", () => {
    const md = renderCompassIndex(emptyLocals(), emptyCommits(), {
      ...META,
      totalListed: 42,
    });
    expect(md).toContain("Local records: 42");
  });

  it("includes syncedAt timestamp in footer", () => {
    const md = renderCompassIndex(emptyLocals(), emptyCommits(), {
      ...META,
      syncedAt: "2026-05-09T12:34:56.000Z",
    });
    expect(md).toContain("Last sync: 2026-05-09T12:34:56.000Z");
  });
});
