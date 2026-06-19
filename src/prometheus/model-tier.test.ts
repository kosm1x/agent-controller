import { describe, it, expect, afterEach } from "vitest";
import { assessTaskComplexity, resolveUseOpus } from "./model-tier.js";
import {
  queryClaudeSdkTiered,
  SONNET_MODEL_ID,
  OPUS_MODEL_ID,
} from "../inference/claude-sdk.js";

// The exact note nanoclaw-worker appends to coding prompts before orchestrate()
// sees them — used to prove the keyword heuristic is immune to its ~600 chars.
const ENV_NOTE =
  "\n\n[ENVIRONMENT] You are in an isolated Docker container. Your WRITABLE " +
  "working copy of the mission-control repo is at /workspace and is already " +
  "your working directory — do ALL file edits, test runs, commits and pushes " +
  "there. /root/claude/mission-control is a READ-ONLY reference mount; never " +
  "write or commit in it. Dependencies are ALREADY installed (node_modules is " +
  "present) — run tests directly with `npx vitest run <file>`; do NOT run " +
  "`npm install`/`npm ci`. To DELIVER a change you MUST create a branch, " +
  "commit, and `git push -u origin <branch>`. Report the pushed branch name.";

describe("assessTaskComplexity", () => {
  it("flags architecture / broad-scope work as complex", () => {
    for (const task of [
      "Refactor the authentication layer",
      "Redesign the dispatcher architecture",
      "Migrate the database to Postgres",
      "Audit the salones service end-to-end",
      "Design a new caching system",
      "Investigate the cost regression across all runners",
      "Rewrite the scheduler from scratch",
    ]) {
      expect(assessTaskComplexity(task)).toBe("complex");
    }
  });

  it("flags bounded mechanical edits as simple", () => {
    for (const task of [
      "Write a clamp function for percentages and push it",
      "Rename the helper to formatDate",
      "Bump the zod dependency",
      "Fix the typo in the error message",
      "Add a test for the slot finder",
      "Update the version string in package.json",
    ]) {
      expect(assessTaskComplexity(task)).toBe("simple");
    }
  });

  it("defaults to complex (Opus) when there is no signal either way", () => {
    expect(assessTaskComplexity("Do the thing we discussed")).toBe("complex");
    expect(assessTaskComplexity("")).toBe("complex");
  });

  it("lets complex win when both signals are present", () => {
    // 'rename' (simple) + 'entire'/'across all' (complex) → must stay Opus.
    expect(
      assessTaskComplexity("Rename the entire auth system across all services"),
    ).toBe("complex");
  });

  it("does NOT downgrade broad rename / default-change tasks (W1 fold)", () => {
    // qa-auditor flagged these as the dangerous direction: a terse-but-broad
    // task with only a 'rename'/'change the default' token and no explicit
    // breadth word. Bare 'rename' and 'change/update the default' were dropped
    // from SIMPLE so these fall through to the Opus default.
    for (const task of [
      "Rename the database column and backfill 2M rows safely",
      "rename the Salesforce integration and re-point all webhooks",
      "Rename every API endpoint and update all callers",
      "change the default retry policy to exponential backoff",
      "update the default timeout for all requests",
    ]) {
      expect(assessTaskComplexity(task)).toBe("complex");
    }
    // The genuinely-mechanical "rename X to Y" form is still simple.
    expect(assessTaskComplexity("Rename the helper to formatDate")).toBe(
      "simple",
    );
  });

  it("is immune to the nanoclaw [ENVIRONMENT] note (keyword-, not length-driven)", () => {
    // A trivial coding task stays simple even with the long note appended...
    expect(assessTaskComplexity("Write a clamp function" + ENV_NOTE)).toBe(
      "simple",
    );
    // ...and a complex one stays complex. The note itself flips neither
    // (it contains no complex/simple signal words — notably "node_modules"
    // must NOT trip the 'module' complex pattern).
    expect(assessTaskComplexity("Refactor the auth module" + ENV_NOTE)).toBe(
      "complex",
    );
    expect(assessTaskComplexity("A neutral task" + ENV_NOTE)).toBe("complex");
  });
});

describe("resolveUseOpus", () => {
  afterEach(() => {
    delete process.env.PROMETHEUS_ECONOMY_MODEL;
  });

  it("returns false (Sonnet) for confidently-simple tasks when tiering is on", () => {
    expect(resolveUseOpus("Fix the typo in the README")).toBe(false);
  });

  it("returns true (Opus) for complex tasks when tiering is on", () => {
    expect(resolveUseOpus("Refactor the dispatcher")).toBe(true);
  });

  it("forces Opus everywhere when the kill switch is set", () => {
    process.env.PROMETHEUS_ECONOMY_MODEL = "false";
    // Even a confidently-simple task goes back to Opus when economy is off.
    expect(resolveUseOpus("Fix the typo in the README")).toBe(true);
  });

  it("keeps tiering active for any kill-switch value other than 'false'", () => {
    process.env.PROMETHEUS_ECONOMY_MODEL = "true";
    expect(resolveUseOpus("Fix the typo in the README")).toBe(false);
  });
});

// W3 fold: prove the decision actually reaches the model. The unit tests above
// assert what useOpus *should* be; this asserts queryClaudeSdkTiered honors it —
// the contract every Prometheus call site relies on. Uses a stub callback, so
// no SDK / DB is touched.
describe("queryClaudeSdkTiered (model-selection contract)", () => {
  it("calls back with Sonnet — and never attempts Opus — when useOpus=false", async () => {
    const models: string[] = [];
    const out = await queryClaudeSdkTiered(false, async (model) => {
      models.push(model);
      return "ok";
    });
    expect(out).toBe("ok");
    expect(models).toEqual([SONNET_MODEL_ID]);
    expect(models).not.toContain(OPUS_MODEL_ID);
  });

  it("calls back with Opus first when useOpus=true", async () => {
    const models: string[] = [];
    await queryClaudeSdkTiered(true, async (model) => {
      models.push(model);
      return "ok";
    });
    expect(models[0]).toBe(OPUS_MODEL_ID);
  });
});
