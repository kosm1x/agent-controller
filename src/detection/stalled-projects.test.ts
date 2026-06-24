/**
 * Stalled-project detector — the day-log-grounded work-truth detector.
 *
 * Seeds the `projects` table (the active-project list) + `jarvis_files`
 * day-logs (`logs/day-logs/YYYY-MM-DD.md`, the operator's record of work) and
 * asserts: a project mentioned recently is quiet-free; one absent from the
 * window (or last seen beyond the stale window) is flagged; non-active projects
 * and an empty day-log are no-ops; matching works by slug/name token.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { detectStalledProjects } from "./stalled-projects.js";

beforeEach(() => initDatabase(":memory:"));
afterEach(() => closeDatabase());

function addProject(
  slug: string,
  name: string,
  status: "active" | "paused" | "archived" = "active",
  config: string | null = null,
): void {
  getDatabase()
    .prepare(
      `INSERT INTO projects (id, slug, name, status, config) VALUES (?,?,?,?,?)`,
    )
    .run(slug, slug, name, status, config);
}

/** Seed a day-log at logs/day-logs/<date>.md with the given content. */
function addDayLog(date: string, content: string): void {
  getDatabase()
    .prepare(
      `INSERT INTO jarvis_files (id, path, title, content, qualifier)
       VALUES (?,?,?,?, 'workspace')`,
    )
    .run(`dl-${date}`, `logs/day-logs/${date}.md`, `Day Log: ${date}`, content);
}

describe("detectStalledProjects", () => {
  it("flags an active project absent from the entire day-log window", () => {
    addProject("salones-wa", "Salones WA");
    addProject("pipesong", "Pipesong");
    addDayLog("2026-06-23", "Avancé en pipesong, merge del Flux branch");
    addDayLog("2026-06-22", "más trabajo en pipesong");
    const signals = detectStalledProjects();
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      kind: "stalled_project",
      slug: "salones-wa",
      daysSinceMention: null,
    });
  });

  it("does NOT flag a project mentioned within the stale window", () => {
    addProject("salones-wa", "Salones WA");
    addDayLog("2026-06-23", "hoy trabajé en salones, deploy del bot");
    expect(detectStalledProjects()).toHaveLength(0);
  });

  it("flags a project last seen beyond the stale window, with the right age", () => {
    addProject("salones-wa", "Salones WA");
    addDayLog("2026-06-23", "día dedicado a pipesong"); // newest, no mention
    addDayLog("2026-06-10", "cerré tareas de salones"); // 13d before newest
    const signals = detectStalledProjects(7);
    expect(signals).toHaveLength(1);
    expect(signals[0].daysSinceMention).toBe(13);
  });

  it("counts a distinctive token as a mention (not a generic short one)", () => {
    addProject("salon-voice-outreach", "Salon Voice Outreach");
    // "outreach" (len>=6, distinctive) is a match; "voice"/"salon" (short) are not.
    addDayLog("2026-06-23", "grabé el flujo del outreach hoy");
    expect(detectStalledProjects()).toHaveLength(0);
  });

  it("a coincidental common/short word does NOT suppress a real stall", () => {
    // "data-intelligence" → "data" (short) + "intelligence" (generic) are excluded,
    // so an unrelated "data pipeline" mention must NOT mark it active.
    addProject("data-intelligence", "Data Intelligence");
    addDayLog("2026-06-23", "armé un data pipeline para otro proyecto");
    expect(detectStalledProjects().map((x) => x.slug)).toContain(
      "data-intelligence",
    );
  });

  it("ignores paused / archived projects", () => {
    addProject("old-thing", "Old Thing", "archived");
    addProject("parked", "Parked", "paused");
    addDayLog("2026-06-23", "nada que ver");
    expect(detectStalledProjects()).toHaveLength(0);
  });

  it("returns [] when there is no day-log to judge against", () => {
    addProject("salones-wa", "Salones WA");
    expect(detectStalledProjects()).toEqual([]);
  });

  it("does NOT flag a project marked config.stall_exempt (intentional silence)", () => {
    // VLMP case: code-complete, launch-pending — quiet by design, not stalling.
    addProject(
      "vlmp",
      "VLMP",
      "active",
      JSON.stringify({ stall_exempt: true }),
    );
    addDayLog("2026-06-23", "trabajé en otra cosa"); // vlmp absent on purpose
    expect(detectStalledProjects()).toHaveLength(0);
  });

  it("exempts only the marked project — a silent non-exempt sibling still flags", () => {
    addProject(
      "vlmp",
      "VLMP",
      "active",
      JSON.stringify({ stall_exempt: true }),
    );
    addProject("salones-wa", "Salones WA"); // not exempt, also absent
    addDayLog("2026-06-23", "día de descanso");
    const signals = detectStalledProjects();
    expect(signals).toHaveLength(1);
    expect(signals[0].slug).toBe("salones-wa");
  });

  it("malformed config is NOT treated as exempt (fails toward flagging)", () => {
    addProject("vlmp", "VLMP", "active", "{not valid json");
    addDayLog("2026-06-23", "puro descanso hoy"); // no mention of the project
    const signals = detectStalledProjects();
    expect(signals).toHaveLength(1);
    expect(signals[0].slug).toBe("vlmp");
  });

  it("stall_exempt must be exactly true — a falsy/other value still flags", () => {
    addProject(
      "vlmp",
      "VLMP",
      "active",
      JSON.stringify({ stall_exempt: "yes" }),
    );
    addDayLog("2026-06-23", "otra cosa");
    expect(detectStalledProjects()).toHaveLength(1);
  });

  it("the production-default config '{}' (no stall_exempt key) still flags", () => {
    // Every live row carries '{}' at minimum (projects.config DEFAULT '{}').
    addProject("vlmp", "VLMP", "active", "{}");
    addDayLog("2026-06-23", "otra cosa");
    expect(detectStalledProjects()).toHaveLength(1);
  });
});
