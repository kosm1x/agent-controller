/**
 * benchmark-sonnet-tier.ts / benchmark-opus-tier.ts `--summarize` on fixture
 * rows in a throwaway dir under the OS temp dir: arms D/E are aggregated and
 * gated against A, and both summaries print cost two ways (SDK-reported vs
 * usage × src/budget/pricing.ts). The summarize path exits before the env
 * copy and the mc.db snapshot, so nothing live is read. The --before/--after
 * pool tests run the sonnet harness DRY on a fixture DB (MC_BENCH_SRC_DB,
 * schema.sql + a few fast tasks) with scratch under the temp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const HERE = dirname(fileURLToPath(import.meta.url));
const TSX = resolve(HERE, "../node_modules/.bin/tsx");

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
  };
}

describe("benchmark-sonnet-tier --summarize", () => {
  it("aggregates and gates D/E against A and prints cost two ways", () => {
    const rows = ["t1", "t2"].flatMap((t) => [
      sonnetRow(t, "A", "claude-sonnet-4-6"),
      sonnetRow(t, "C", "claude-sonnet-5-5", { cost_usd: 0.05 }),
      // D: SDK says $0.20 but pricing.ts (Opus 5.5 list) gives 2k×$4 + 8k×$0.2 + 500×$20 per M = $0.0196
      sonnetRow(t, "D", "claude-opus-5-5", { cost_usd: 0.2 }),
      sonnetRow(t, "E", "claude-opus-5-5", { cost_usd: 0.3, tool_jaccard: 0.5 }),
    ]);
    writeFileSync(join(dir, "calls.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const r = spawnSync(TSX, [resolve(HERE, "benchmark-sonnet-tier.ts"), "--summarize", `--out=${dir}`], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const md = readFileSync(join(dir, "summary.md"), "utf8");
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
    const json = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")) as { gates: Record<string, unknown>; arms: Array<{ arm: string }> };
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
    writeFileSync(join(dir, "calls.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const r = spawnSync(TSX, [resolve(HERE, "benchmark-sonnet-tier.ts"), "--summarize", `--out=${dir}`], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const md = readFileSync(join(dir, "summary.md"), "utf8");
    expect(md).toMatch(/Pool created 2026-09-20 10:00:00 → 2026-09-30 10:00:00 UTC · reference \(stored production answer\) model\(s\): claude-sonnet-4-6 ×1, claude-sonnet-5-5 ×1\./);
    const json = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")) as { reference: { models: Record<string, number> } };
    expect(json.reference.models).toEqual({ "claude-sonnet-4-6": 1, "claude-sonnet-5-5": 1 });
  });

  it("rejects a --model-a that is not a Sonnet id (claude-sdk.ts SONNET_MODEL_ID rule)", () => {
    for (const m of ["claude-opus-4-8", "sonnet-4-6", "claude-sonnet-x"]) {
      const r = spawnSync(TSX, [resolve(HERE, "benchmark-sonnet-tier.ts"), `--model-a=${m}`, "--summarize", `--out=${dir}`], { encoding: "utf8" });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/--model-a must match/);
    }
  });

  it("rejects a malformed --before / --after and an empty window", () => {
    for (const args of [["--before=nope"], ["--after=29/09/2026"], ["--before=2026-09-29T05:09:00"], ["--after=2026-09-29"], ["--before=2026-09-01T00:00:00Z", "--after=2026-09-01T00:00:00Z"]]) {
      const r = spawnSync(TSX, [resolve(HERE, "benchmark-sonnet-tier.ts"), ...args, "--summarize", `--out=${dir}`], { encoding: "utf8" });
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stderr).toMatch(/--(before|after)/);
    }
    const bare = spawnSync(TSX, [resolve(HERE, "benchmark-sonnet-tier.ts"), "--before=2026-09-29T05:09:00", "--summarize", `--out=${dir}`], { encoding: "utf8" });
    expect(bare.status).toBe(2);
    expect(bare.stderr).toMatch(/explicit Z or ±HH:MM offset.*TZ=America\/Mexico_City/);
    const offset = spawnSync(TSX, [resolve(HERE, "benchmark-sonnet-tier.ts"), "--before=2026-09-29T05:09:00-06:00", "--summarize", `--out=${dir}`], { encoding: "utf8" });
    expect(offset.stderr).not.toMatch(/--before/);
  });

  it("rejects an unknown or repeated arm in --configs", () => {
    for (const c of ["A,F", "A,A"]) {
      const r = spawnSync(TSX, [resolve(HERE, "benchmark-sonnet-tier.ts"), `--configs=${c}`, "--summarize", `--out=${dir}`], { encoding: "utf8" });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/subset of A,B,C,D,E/);
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
    writeFileSync(join(dir, "results.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const r = spawnSync(TSX, [resolve(HERE, "benchmark-opus-tier.ts"), "--summarize", `--out=${dir}`], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const md = readFileSync(join(dir, "summary.md"), "utf8");
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
    writeFileSync(join(dir, "results.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const r = spawnSync(TSX, [resolve(HERE, "benchmark-opus-tier.ts"), "--summarize", `--out=${dir}`], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const md = readFileSync(join(dir, "summary.md"), "utf8");
    expect(md).toMatch(/\| arm \| n \| ok \| bare JSON \| parsed \(ok\) \| think-leak \|/);
    // plan: 2 of 3 parsed (bare + fenced); bare JSON is 1 of the 2 OK rows
    expect(md).toMatch(/\| claude-opus-5-5 A \| 3 \| 67% \| 50% \| 67% \| 0 \|/);
    expect(md).toMatch(/\| claude-opus-5-5 A \| 1 \| 100% \| 0% \| n\/a \| 0 \|/);
    expect(md).toMatch(/Gate 1 \(contract\) reads `parsed \(ok\)`/);
  });

  it("--summarize on a missing dir exits 2 with one line naming it", () => {
    const missing = join(dir, "nope");
    const r = spawnSync(TSX, [resolve(HERE, "benchmark-opus-tier.ts"), "--summarize", `--out=${missing}`], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr.trim()).toBe(`[bench] --summarize: results dir ${missing} does not exist`);
  });
});

describe("benchmark-sonnet-tier pool window (--before / --after, DRY on a fixture DB)", () => {
  // Non-chat fast root tasks (no history needed), one grep call each; the
  // reference model comes from cost_ledger. Dates are SQLite UTC text.
  const TASKS: Array<[string, string, string]> = [
    ["aaaa0001-old", "2026-09-01 12:00:00", "claude-sonnet-4-6"],
    ["bbbb0002-mid", "2026-09-20 12:00:00", "claude-sonnet-4-6"],
    ["cccc0003-pre", "2026-09-28 12:00:00", "claude-sonnet-4-6"],
    ["dddd0004-new", "2026-09-30 12:00:00", "claude-sonnet-5-5"],
  ];
  let src: string;
  beforeEach(() => {
    src = join(dir, "fixture.db");
    const db = new Database(src);
    db.exec(readFileSync(resolve(HERE, "../src/db/schema.sql"), "utf8"));
    // cost_ledger comes from initDatabase's migrations (which the harness runs
    // on its copy); the fixture needs it now for the reference-model rows.
    db.exec(
      "CREATE TABLE cost_ledger (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL, agent_type TEXT NOT NULL, model TEXT NOT NULL DEFAULT 'unknown', " +
        "prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0.0, created_at TEXT DEFAULT (datetime('now')), " +
        "cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_tokens INTEGER NOT NULL DEFAULT 0)",
    );
    const ins = db.prepare(
      "INSERT INTO tasks (task_id, title, description, status, agent_type, spawn_type, metadata, output, created_at) VALUES (?, ?, 'd', 'completed', 'fast', 'root', ?, ?, ?)",
    );
    const led = db.prepare("INSERT INTO cost_ledger (run_id, task_id, agent_type, model, cost_usd, created_at) VALUES (?, ?, 'fast', ?, 0.1, ?)");
    for (const [id, at, model] of TASKS) {
      ins.run(id, `Resumen ${id}`, JSON.stringify({ tools: ["grep"] }), JSON.stringify({ text: "ok", toolCalls: ["grep"] }), at);
      led.run(`r-${id}`, id, model, at);
    }
    db.close();
    mkdirSync(join(dir, "scratch"));
  });
  const dry = (...args: string[]) =>
    spawnSync(TSX, [resolve(HERE, "benchmark-sonnet-tier.ts"), "--configs=A,C", `--out=${join(dir, "out")}`, ...args], {
      encoding: "utf8",
      // MC_PID "0": a regressed --run guard exits 2 at the /proc check instead of inheriting the live env and spending.
      env: { ...process.env, MC_BENCH_SRC_DB: src, MC_BENCH_SCRATCH: join(dir, "scratch"), MC_PID: "0" },
    });
  const listed = (out: string) => TASKS.map(([id]) => id.slice(0, 8)).filter((t) => new RegExp(`^  ${t} `, "m").test(out));

  it("--before keeps only tasks created before it, within 21 days of it, and reports the reference model", () => {
    const r = dry("--before=2026-09-29T05:09:00Z");
    expect(r.status, r.stderr).toBe(3);
    expect(listed(r.stdout).sort()).toEqual(["bbbb0002", "cccc0003"]);
    expect(r.stdout).toMatch(/2 task\(s\) of 2 eligible/);
    expect(r.stdout).toMatch(/created 2026-09-29 05:09:00 − 21d → 2026-09-29 05:09:00 UTC/);
    expect(r.stdout).toMatch(/Pool created 2026-09-20 12:00:00 → 2026-09-28 12:00:00 UTC · reference \(stored production answer\) model\(s\): claude-sonnet-4-6 ×2/);
  });

  it("--after overrides the 21-day lower bound; alone it leaves the upper bound at now", () => {
    const both = dry("--before=2026-09-29T05:09:00Z", "--after=2026-08-25T00:00:00Z");
    expect(both.status, both.stderr).toBe(3);
    expect(listed(both.stdout).sort()).toEqual(["aaaa0001", "bbbb0002", "cccc0003"]);
    const after = dry("--after=2026-09-25T00:00:00Z");
    expect(after.status, after.stderr).toBe(3);
    expect(listed(after.stdout).sort()).toEqual(["cccc0003", "dddd0004"]);
    expect(after.stdout).toMatch(/model\(s\): claude-sonnet-5-5 ×1, claude-sonnet-4-6 ×1|model\(s\): claude-sonnet-4-6 ×1, claude-sonnet-5-5 ×1/);
  });

  it("refuses --run against a fixture DB", () => {
    const r = dry("--run", "--before=2026-09-29T05:09:00Z");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/fixture dry runs only/);
    const empty = spawnSync(TSX, [resolve(HERE, "benchmark-sonnet-tier.ts"), "--configs=A,C", "--run", `--out=${join(dir, "out")}`], {
      encoding: "utf8",
      env: { ...process.env, MC_BENCH_SRC_DB: "", MC_BENCH_SCRATCH: join(dir, "scratch"), MC_PID: "0" },
    });
    expect(empty.status).toBe(2);
    expect(empty.stderr).toMatch(/fixture dry runs only/);
  });
});
