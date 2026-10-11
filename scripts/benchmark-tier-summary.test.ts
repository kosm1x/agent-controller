/**
 * benchmark-sonnet-tier.ts / benchmark-opus-tier.ts summaries on fixture rows:
 * arms D/E are aggregated and gated against A, and both summaries print cost
 * two ways (SDK-reported vs usage × src/budget/pricing.ts). The renderers are
 * pure (scripts/lib/benchmark-*-summary.ts) and called directly: the scripts
 * themselves are operator-gated at module top (S6 item 3c), so a spawn from
 * CI or a task is refused (rc 2) and a spawn from an operator session runs
 * the argument checks. Every spawn here exits before any mc.db copy.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { operatorContextReason } from "../src/lib/operator-gate.js";
import Database from "better-sqlite3";
import { isUnderRepoData } from "./lib/bench-paths.js";
import { selectPoolRows, windowLabel } from "./lib/benchmark-sonnet-pool.js";
import { renderSummary as renderOpus, type CallRow as OpusRow } from "./lib/benchmark-opus-summary.js";
import { referenceInfo, referenceLine, renderSummary as renderSonnet, type CallRow as SonnetRow } from "./lib/benchmark-sonnet-summary.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TSX = resolve(HERE, "../node_modules/.bin/tsx");
/** Same test the scripts run: spawned children share this process's cgroup. */
const OPERATOR = operatorContextReason(readFileSync("/proc/self/cgroup", "utf8"), false, { tty: false }) === null;
const REFUSED = /\[benchmark-(sonnet|opus)-tier\] [^\n]*; this script is not callable from a task/;

/** rc 2: the argument error in an operator context, the gate refusal anywhere else. */
function expectRc2(r: SpawnSyncReturns<string>, operatorMessage: RegExp): void {
  expect(r.status, r.stderr).toBe(2);
  expect(r.stderr).toMatch(OPERATOR ? operatorMessage : REFUSED);
}

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "tier-bench-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function sonnetRow(task: string, arm: string, model: string, over: Record<string, unknown> = {}) {
  return {
    task, title: `Chat: ${task}`, arm, position: 0, model, effective_model: model, model_mismatch: false,
    cost_usd: 0.1, cost_authoritative: true, cost_estimated: false, turns: 1, tool_calls: 1, tool_names: ["grep"],
    prompt_tokens: 10_000, cache_read_tokens: 8_000, cache_creation_tokens: 0, completion_tokens: 500,
    cache_read_ratio: 0.8, duration_ms: 1000, sdk_calls: 1, status: "DONE", raw_status: "DONE", success: true,
    empty_completion: false, text_chars: 10, tool_jaccard: 1, msg_truncated: false,
    orig_cost_usd: 0.1, orig_turns: 1, orig_tools: ["grep"], ...over,
  } as SonnetRow;
}
const sonnet = (rows: SonnetRow[]) => renderSonnet(rows, "claude-sonnet-4-6", dir);
const sonnetSpawn = (...args: string[]) =>
  spawnSync(TSX, [resolve(HERE, "benchmark-sonnet-tier.ts"), ...args], { encoding: "utf8" });

describe("benchmark-sonnet-tier --summarize", () => {
  it("aggregates and gates D/E against A and prints cost two ways", () => {
    const rows = ["t1", "t2"].flatMap((t) => [
      sonnetRow(t, "A", "claude-sonnet-4-6"),
      sonnetRow(t, "C", "claude-sonnet-5-5", { cost_usd: 0.05 }),
      // D: SDK says $0.20 but pricing.ts (Opus 5.5 list) gives 2k×$4 + 8k×$0.2 + 500×$20 per M = $0.0196
      sonnetRow(t, "D", "claude-opus-5-5", { cost_usd: 0.2 }),
      sonnetRow(t, "E", "claude-opus-5-5", { cost_usd: 0.3, tool_jaccard: 0.5 }),
    ]);
    const { md, json: raw } = sonnet(rows);
    expect(md).toMatch(/Arms: A = claude-sonnet-4-6, incumbent \(claude-sonnet-4-6, effort unset\)[^·]*· C = claude-sonnet-5-5, adaptive thinking, effort low · D = claude-opus-5-5, adaptive thinking, effort low · E = claude-opus-5-5, adaptive thinking, effort medium\./);
    expect(md).toMatch(/paired tasks 2/);
    // Pre-10-06 rows carry no reference model: said so, not guessed.
    expect(md).toMatch(/reference \(stored production answer\) model\(s\): n\/a · 2 task\(s\) without a recorded reference model/);
    expect(md).toMatch(/## Cost two ways/);
    expect(md).toMatch(/\| D \| claude-opus-5-5 \| 0\.400 \| 0\.039 \| 10\.20 \| 0 \|/);
    // A: Sonnet 4.6 list = 2k×$3 + 8k×$0.3 + 500×$15 per M = $0.0159 per row
    expect(md).toMatch(/\| A \| claude-sonnet-4-6 \| 0\.200 \| 0\.032 \|/);
    expect(md).toMatch(/\| D \| FAIL \| PASS \| PASS \| PASS \| FAIL \|/); // $/completed 0.2 > A 0.1
    expect(md).toMatch(/\| E \| FAIL \| PASS \| FAIL \| PASS \| FAIL \|/); // jaccard 0.5 vs 1
    expect(md).toMatch(/\| C \| PASS \| PASS \| PASS \| PASS \| PASS \|/);
    const json = raw as { gates: Record<string, unknown>; arms: Array<{ arm: string }> };
    expect(Object.keys(json.gates).sort()).toEqual(["C", "D", "E"]);
    expect(json.arms.map((a) => a.arm)).toEqual(["A", "C", "D", "E"]);
  });

  it("prints the pool date range and reference model(s) from the rows", () => {
    const rows = [
      sonnetRow("t1", "A", "claude-sonnet-4-6", { orig_models: ["claude-sonnet-4-6"], orig_created_at: "2026-09-20 10:00:00" }),
      sonnetRow("t1", "C", "claude-sonnet-5-5", { orig_models: ["claude-sonnet-4-6"], orig_created_at: "2026-09-20 10:00:00" }),
      sonnetRow("t2", "A", "claude-sonnet-4-6", { orig_models: ["claude-sonnet-5-5"], orig_created_at: "2026-09-30 10:00:00" }),
      sonnetRow("t2", "C", "claude-sonnet-5-5", { orig_models: ["claude-sonnet-5-5"], orig_created_at: "2026-09-30 10:00:00" }),
    ];
    const { md, json: raw } = sonnet(rows);
    expect(md).toMatch(/Pool created 2026-09-20 10:00:00 → 2026-09-30 10:00:00 UTC · reference \(stored production answer\) model\(s\): claude-sonnet-4-6 ×1, claude-sonnet-5-5 ×1\./);
    const json = raw as { reference: { models: Record<string, number> } };
    expect(json.reference.models).toEqual({ "claude-sonnet-4-6": 1, "claude-sonnet-5-5": 1 });
  });

  it("rejects a --model-a that is not a Sonnet id (claude-sdk.ts SONNET_MODEL_ID rule)", () => {
    for (const m of ["claude-opus-4-8", "sonnet-4-6", "claude-sonnet-x"]) {
      expectRc2(sonnetSpawn(`--model-a=${m}`, "--summarize", `--out=${dir}`), /--model-a must match/);
    }
  });

  it("rejects a malformed --before / --after and an empty window", () => {
    for (const args of [["--before=nope"], ["--after=29/09/2026"], ["--before=2026-09-29T05:09:00"], ["--after=2026-09-29"], ["--before=2026-09-01T00:00:00Z", "--after=2026-09-01T00:00:00Z"]]) {
      expectRc2(sonnetSpawn(...args, "--summarize", `--out=${dir}`), /--(before|after)/);
    }
    expectRc2(sonnetSpawn("--before=2026-09-29T05:09:00", "--summarize", `--out=${dir}`), /explicit Z or ±HH:MM offset.*TZ=America\/Mexico_City/);
    // A valid offset passes the window check; the run then stops at the gate or the data/ rule.
    const offset = sonnetSpawn("--before=2026-09-29T05:09:00-06:00", "--summarize", `--out=${dir}`);
    expect(offset.stderr).not.toMatch(/--before/);
    expectRc2(offset, /--out must resolve under/);
  });

  it("rejects an unknown or repeated arm in --configs", () => {
    for (const c of ["A,F", "A,A"]) {
      expectRc2(sonnetSpawn(`--configs=${c}`, "--summarize", `--out=${dir}`), /subset of A,B,C,D,E/);
    }
  });
});

describe("benchmark-opus-tier --summarize", () => {
  it("prints SDK-reported vs pricing.ts cost per arm × phase", () => {
    const base = { task: "t1", family: "ops", phase: "plan", ok: true, durationMs: 1000, numTurns: 1, cacheReadTokens: 0, cacheCreationTokens: 0, textChars: 10, bareJson: true, thinkingLeak: false, toolCallInText: false };
    const rows = [
      { ...base, model: "claude-opus-4-8", config: "A", reportedModel: "claude-opus-4-8", promptTokens: 1_000_000, completionTokens: 0, costUsd: 5 },
      { ...base, model: "claude-opus-5-5", config: "B", reportedModel: "claude-opus-5-5", promptTokens: 1_000_000, completionTokens: 100_000, costUsd: 7 },
    ];
    const md = renderOpus(rows as OpusRow[], dir);
    expect(md).toMatch(/## Cost two ways/);
    expect(md).toMatch(/\| claude-opus-4-8 A \| plan \| 1 \| 5\.000 \| 5\.000 \| 1\.00 \|/);
    // Opus 5.5: 1M in × $4 + 100k out × $20/M = $6.00; SDK said $7 → 1.17
    expect(md).toMatch(/\| claude-opus-5-5 B \| plan \| 1 \| 7\.000 \| 6\.000 \| 1\.17 \|/);
  });

  it("gate 1 reads parse success: a `parsed (ok)` column next to `bare JSON` (fenced JSON parses; reflect n/a)", () => {
    const base = { task: "t1", family: "ops", model: "claude-opus-5-5", config: "A", durationMs: 1000, numTurns: 1, promptTokens: 100, completionTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.01, textChars: 10, thinkingLeak: false, toolCallInText: false };
    const rows = [
      { ...base, phase: "plan", ok: true, bareJson: true, fencedJson: false },
      { ...base, task: "t2", phase: "plan", ok: true, bareJson: false, fencedJson: true },
      { ...base, task: "t3", phase: "plan", ok: false, bareJson: false, fencedJson: false, error: "unparseable" },
      { ...base, phase: "reflect", ok: true, bareJson: false, fencedJson: true },
    ];
    const md = renderOpus(rows as OpusRow[], dir);
    expect(md).toMatch(/\| arm \| n \| ok \| bare JSON \| parsed \(ok\) \| think-leak \|/);
    // plan: 2 of 3 parsed (bare + fenced); bare JSON is 1 of the 2 OK rows
    expect(md).toMatch(/\| claude-opus-5-5 A \| 3 \| 67% \| 50% \| 67% \| 0 \|/);
    expect(md).toMatch(/\| claude-opus-5-5 A \| 1 \| 100% \| 0% \| n\/a \| 0 \|/);
    expect(md).toMatch(/Gate 1 \(contract\) reads `parsed \(ok\)`/);
  });

  it("--summarize on a missing dir exits 2 with one line naming it", () => {
    const missing = join(dir, "nope");
    const r = spawnSync(TSX, [resolve(HERE, "benchmark-opus-tier.ts"), "--summarize", `--out=${missing}`], { encoding: "utf8" });
    expectRc2(r, new RegExp(`^\\[bench\\] --summarize: results dir ${missing} does not exist\\n$`));
  });
});

describe("benchmark harnesses write only under the repo's data/ (audit R1 W3)", () => {
  it("a dry run or --summarize into a dir outside data/ is refused before any mc.db copy", () => {
    const scratch = join(dir, "scratch");
    mkdirSync(scratch);
    const env = { ...process.env, MC_BENCH_SCRATCH: scratch, MC_PID: "0" };
    const dry = spawnSync(TSX, [resolve(HERE, "benchmark-sonnet-tier.ts"), "--configs=A,C", `--out=${join(dir, "out")}`], { encoding: "utf8", env });
    expectRc2(dry, /\[bench\] MC_BENCH_SCRATCH must resolve under \/root\/claude\/mission-control\/data\//);
    const opus = spawnSync(TSX, [resolve(HERE, "benchmark-opus-tier.ts"), "--summarize", `--out=${dir}`], { encoding: "utf8" });
    expectRc2(opus, /\[bench\] --out must resolve under/);
    expect(readdirSync(scratch)).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(["scratch"]);
  });

  it("refuses --run against a fixture DB", () => {
    const env = { ...process.env, MC_BENCH_SRC_DB: "", MC_BENCH_SCRATCH: join(dir, "scratch"), MC_PID: "0" };
    const r = spawnSync(TSX, [resolve(HERE, "benchmark-sonnet-tier.ts"), "--configs=A,C", "--run", `--out=${join(dir, "out")}`], { encoding: "utf8", env });
    expectRc2(r, /fixture dry runs only/);
  });

  it("isUnderRepoData: under data/, no symlink component or leaf (dangling included), only the leaf may be new", () => {
    const data = join(dir, "data");
    mkdirSync(join(data, "bench"), { recursive: true });
    mkdirSync(join(data, "sub"));
    mkdirSync(join(dir, "outside"));
    symlinkSync(data, join(dir, "link-in"));
    symlinkSync(join(dir, "outside"), join(data, "link-out"));
    symlinkSync(join(data, "bench"), join(data, "link-bench"));
    symlinkSync("/nonexistent", join(data, "x"));
    expect(isUnderRepoData(join(data, "bench"), data)).toBe(true);
    expect(isUnderRepoData(join(data, "sub/new"), data)).toBe(true);
    expect(isUnderRepoData(join(data, "new"), data)).toBe(true);
    expect(isUnderRepoData(join(data, "x"), data)).toBe(false);
    expect(isUnderRepoData(join(data, "x/new"), data)).toBe(false);
    expect(isUnderRepoData(join(data, "link-bench"), data)).toBe(false);
    expect(isUnderRepoData(join(data, "new/deeper"), data)).toBe(false);
    expect(isUnderRepoData(join(dir, "link-in/new"), data)).toBe(false);
    expect(isUnderRepoData(join(dir, "link-in/bench"), data)).toBe(false);
    expect(isUnderRepoData(data, data)).toBe(false);
    expect(isUnderRepoData(join(dir, "outside/x"), data)).toBe(false);
    expect(isUnderRepoData(join(data, "../outside"), data)).toBe(false);
    expect(isUnderRepoData(join(data, "link-out/x"), data)).toBe(false);
    expect(isUnderRepoData(`${data}-sibling/x`, data)).toBe(false);
  });
});

describe("benchmark-sonnet-tier pool window (--before / --after) on a fixture DB", () => {
  // Fast completed root tasks; dates are SQLite UTC text (the harness converts the flags).
  const TASKS: Array<[string, string, string]> = [
    ["aaaa0001-old", "2026-09-01 12:00:00", "claude-sonnet-4-6"],
    ["bbbb0002-mid", "2026-09-20 12:00:00", "claude-sonnet-4-6"],
    ["cccc0003-pre", "2026-09-28 12:00:00", "claude-sonnet-4-6"],
    ["dddd0004-new", "2026-09-30 12:00:00", "claude-sonnet-5-5"],
  ];
  let db: Database.Database;
  const MODEL = new Map(TASKS.map(([id, , m]) => [id, m]));
  const ids = (after?: string, before?: string) => selectPoolRows(db, after, before, 21).map((r) => r.task_id.slice(0, 8)).sort();
  const insert = (id: string, at: string) =>
    db
      .prepare("INSERT INTO tasks (task_id, title, description, status, agent_type, spawn_type, metadata, output, created_at) VALUES (?, ?, 'd', 'completed', 'fast', 'root', '{}', '{}', ?)")
      .run(id, `Resumen ${id}`, at);
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(readFileSync(resolve(HERE, "../src/db/schema.sql"), "utf8"));
    for (const [id, at] of TASKS) insert(id, at);
  });
  afterEach(() => db.close());

  it("--before keeps only tasks created before it, within 21 days of it, and reports the reference model", () => {
    const before = "2026-09-29 05:09:00";
    const rows = selectPoolRows(db, undefined, before, 21);
    expect(rows.map((r) => r.task_id.slice(0, 8))).toEqual(["cccc0003", "bbbb0002"]); // newest first
    expect(windowLabel(undefined, before, 21)).toBe("created 2026-09-29 05:09:00 − 21d → 2026-09-29 05:09:00 UTC");
    const ref = referenceInfo(rows.map((r) => ({ task: r.task_id.slice(0, 8), orig_created_at: r.created_at, orig_models: [MODEL.get(r.task_id)!] }) as SonnetRow));
    expect(referenceLine(ref)).toMatch(/Pool created 2026-09-20 12:00:00 → 2026-09-28 12:00:00 UTC · reference \(stored production answer\) model\(s\): claude-sonnet-4-6 ×2/);
  });

  it("--after overrides the 21-day lower bound; alone it leaves the upper bound at now", () => {
    expect(ids("2026-08-25 00:00:00", "2026-09-29 05:09:00")).toEqual(["aaaa0001", "bbbb0002", "cccc0003"]);
    expect(ids("2026-09-25 00:00:00")).toEqual(["cccc0003", "dddd0004"]);
    expect(windowLabel("2026-09-25 00:00:00", undefined, 21)).toBe("created 2026-09-25 00:00:00 → now UTC");
  });

  it("bounds: the lower bound is inclusive, --before is exclusive; a non-completed status is out", () => {
    insert("eeee0005-atb", "2026-09-29 05:09:00"); // exactly --before: out
    insert("ffff0006-low", "2026-09-08 05:09:00"); // exactly --before − 21d: in
    db.prepare("UPDATE tasks SET status = 'failed' WHERE task_id = 'bbbb0002-mid'").run();
    expect(ids(undefined, "2026-09-29 05:09:00")).toEqual(["cccc0003", "ffff0006"]);
    expect(ids("2026-09-28 12:00:00", "2026-09-30 12:00:00")).toEqual(["cccc0003", "eeee0005"]);
  });
});
