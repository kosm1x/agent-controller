/**
 * LOCK: the deliverable-boundary and no-unrequested-mutation sentences in the
 * Prometheus prompts. A later edit that drops one turns this red instead of
 * silently reopening the narration leak (final turn joined verbatim into chat)
 * or the criterion-driven KB edit (retry changed the world to meet a criterion
 * the user never asked for).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (f: string): string => readFileSync(join(HERE, f), "utf8");

describe("prompt boundary lock", () => {
  it("planner: criteria describe the user's outcome, never a change the request did not ask for — in PLAN_SYSTEM and REPLAN_SYSTEM", () => {
    const rule =
      "- Criteria describe the outcome the USER asked for. A goal must not create or modify files, KB pages, records or external state the request did not ask to change; if a criterion could only be met by such a change, rewrite the criterion (observe and report), never the world.";
    const planner = src("planner.ts");
    const planAt = planner.indexOf("const PLAN_SYSTEM");
    const replanAt = planner.indexOf("const REPLAN_SYSTEM");
    expect(planAt).toBeGreaterThanOrEqual(0);
    expect(replanAt).toBeGreaterThan(planAt);
    const replan = planner.slice(replanAt);
    const replanEnd = replan.indexOf("Emit ONLY valid JSON");
    expect(replanEnd).toBeGreaterThanOrEqual(0);
    expect(planner.slice(planAt, replanAt)).toContain(rule);
    expect(replan.slice(0, replanEnd)).toContain(rule);
  });

  it("executor system prompt: no unrequested change, even to meet a criterion", () => {
    expect(src("executor.ts")).toContain(
      "- Use tools to accomplish the goal. Never create or modify anything the goal does not ask you to change, not even to meet a criterion.",
    );
  });

  it("executor self-assess retry: report the gap instead of modifying", () => {
    expect(src("executor.ts")).toContain(
      "If a criterion can only be met by modifying something the goal does not ask you to change, do not modify it; report the gap as this goal's result.",
    );
  });

  it("executor system prompt: the summary IS the <deliverable> block collectFinalAnswer relies on", () => {
    const executor = src("executor.ts");
    expect(executor).toContain(
      "- When all completion criteria are met, respond with a summary of what you achieved between <deliverable> and </deliverable>: only that text is delivered, verbatim, to the operator's chat, with no preamble about evidence, tools, retries or criteria; everything outside the markers is discarded.",
    );
    // One place says where the summary goes: the old competing claims are gone.
    expect(executor).not.toContain("it is delivered to the operator's chat as-is");
    expect(executor).not.toContain("- Put the user-facing answer between");
  });
});
