/**
 * grade-benchmark.ts — pure helpers (blind mapping, strict JSON parse, prompt,
 * summary) and the DRY / --summarize CLI paths on a throwaway fixture dir
 * under the OS temp dir (no env, no DB, no SDK call).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  blindMapping,
  buildGraderPrompt,
  estimateGradeCost,
  gradeKey,
  gradeWithinBudget,
  parseGrades,
  parseResultFile,
  preSpendStop,
  renderGradeSummary,
  resumePlan,
  seededShuffle,
  titleFromHeader,
  type GradeRow,
} from "./grade-benchmark.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TSX = resolve(HERE, "../node_modules/.bin/tsx");
const SCRIPT = resolve(HERE, "grade-benchmark.ts");

describe("parseResultFile / titleFromHeader", () => {
  const STATUS = "status=DONE cost=$0.1000 12s turns=2 tools=[grep,file_read] model=claude-opus-5-5";
  it("splits an arm file at the status line and drops the model header", () => {
    const f = `# t1 — arm D (claude-opus-5-5 · thinking adaptive · effort low)\n\nChat: hola\n\n${STATUS}\n\n---\n\nRespuesta\n\n---\n\nmás\n`;
    const { header, answer, title } = parseResultFile(f);
    expect(answer).toBe("Respuesta\n\n---\n\nmás");
    expect(answer).not.toMatch(/claude-opus/);
    expect(header).toMatch(/claude-opus-5-5/);
    expect(title).toBe("Chat: hola");
  });
  it("is independent of a title that itself contains the separator (arm and orig files)", () => {
    const title = "Chat: uno\n\n---\n\nstatus=fake model=x";
    const arm = parseResultFile(`# t1 — arm D (claude-opus-5-5 · x)\n\n${title}\n\n${STATUS}\n\n---\n\nRespuesta\n`);
    expect(arm.answer).toBe("Respuesta");
    expect(arm.title).toBe(title);
    const orig = parseResultFile(`# t1 — stored production answer\n\n${title}\n\n---\n\nprod\n`, arm.title);
    expect(orig.answer).toBe("prod");
    expect(orig.title).toBe(title);
  });
  it("drops a multi-line error= header and an effective model 'none'", () => {
    const f = `# t1 — arm E (x)\n\nChat: hola\n\nstatus=BLOCKED cost=$0.0000 300s turns=0 tools=[] model=none error=boom\nat line 2\n\n---\n\n\n`;
    const { header, answer } = parseResultFile(f);
    expect(answer).toBe("");
    expect(header).toMatch(/model=none error=boom\nat line 2$/);
  });
  it("reads the title from an orig header, multi-paragraph titles included", () => {
    const { header } = parseResultFile("# t1 — stored production answer\n\nChat: uno \n\ndos\n\n---\n\nx\n");
    expect(titleFromHeader(header)).toBe("Chat: uno \n\ndos");
  });
});

describe("pre-spend cap", () => {
  it("estimates a grader call from the prompt size and stops before a call that would cross --max-usd", () => {
    const cands = [
      { label: "R1", answer: "x".repeat(3500) },
      { label: "R2", answer: "y" },
    ];
    const small = estimateGradeCost("pide", "ref", cands, "claude-opus-5-5");
    const big = estimateGradeCost("pide".repeat(3000), "ref", cands, "claude-opus-5-5");
    expect(small).toBeGreaterThan(0);
    expect(big).toBeGreaterThan(small);
    expect(preSpendStop(0, small, 10)).toBeNull();
    expect(preSpendStop(9.99, 0.02, 10)).toMatch(/spent \$9\.99 \+ next call est \$0\.02 would exceed --max-usd 10/);
    expect(preSpendStop(0, 0.5, 0.4)).toMatch(/would exceed/); // even the first call
    expect(preSpendStop(9.5, 0.5, 10)).toBeNull(); // landing exactly on the cap is allowed
  });
  it("skips a task whose estimate would cross --max-usd and still grades a later cheaper one (each skip logged with its estimate)", async () => {
    const todo = [
      { task: "t1", est: 1 },
      { task: "t2", est: 5 }, // 1 + 5 > 3: skipped
      { task: "t3", est: 1.5 }, // 1 + 1.5 fits
      { task: "t4", est: 1 }, // 2.5 + 1 > 3: skipped
    ];
    const graded: string[] = [];
    const log: string[] = [];
    const r = await gradeWithinBudget(todo, (j) => j.est, 3, async (j) => (graded.push(j.task), j.est), (l) => log.push(l));
    expect(graded).toEqual(["t1", "t3"]);
    expect(r).toEqual({ spent: 2.5, graded: 2, skipped: ["t2", "t4"] });
    expect(log).toEqual([
      "[grade] t2: spent $1.00 + next call est $5.00 would exceed --max-usd 3; skipped (re-run resumes)",
      "[grade] t4: spent $2.50 + next call est $1.00 would exceed --max-usd 3; skipped (re-run resumes)",
    ]);
    // The check runs per call on ACTUAL spend: a cheap estimate that costs more blocks the next job.
    const r2 = await gradeWithinBudget([{ task: "a", est: 1 }, { task: "b", est: 1 }], (j) => j.est, 2, async () => 1.5, () => {});
    expect(r2).toEqual({ spent: 1.5, graded: 1, skipped: ["b"] });
    // Nothing fits: no call made, everything skipped (main() exits 2 on graded 0).
    const r3 = await gradeWithinBudget([{ task: "x", est: 9 }], (j) => j.est, 1, async () => { throw new Error("no call"); }, () => {});
    expect(r3).toEqual({ spent: 0, graded: 0, skipped: ["x"] });
  });
});

describe("resume key", () => {
  it("counts a task done only under the same grader model, seed and arm set", () => {
    const key = gradeKey("claude-opus-5-5", "grade-v1", ["D", "A"]);
    expect(key).toBe("claude-opus-5-5|grade-v1|A,D");
    const rows = [
      row("t1", { A: [4, 4, 4], D: [4, 4, 4] }, { mapping: { R1: "D", R2: "A" } }),
      row("t2", { A: [4, 4, 4], D: [4, 4, 4] }, { mapping: { R1: "A", R2: "D" }, seed: "other" }),
      row("t3", {}, { mapping: { R1: "A", R2: "D" }, error: "parse" }),
    ];
    const plan = resumePlan(rows, ["t1", "t2", "t3", "t4"].map((task) => ({ task, key })));
    expect([...plan.done]).toEqual(["t1"]);
    expect(plan.mismatched).toEqual([{ task: "t2", had: "claude-opus-5-5|other|A,D", want: key }]);
  });
});

describe("blind mapping", () => {
  it("is deterministic per seed, a permutation of the arms, labelled R1..Rk", () => {
    const arms = ["A", "C", "D", "E"];
    const m1 = blindMapping(arms, "grade-v1:t1");
    expect(blindMapping(arms, "grade-v1:t1")).toEqual(m1);
    expect(Object.keys(m1)).toEqual(["R1", "R2", "R3", "R4"]);
    expect(Object.values(m1).sort()).toEqual(arms);
  });
  it("varies the order across seeds (A is not always R1)", () => {
    const firsts = new Set(Array.from({ length: 40 }, (_, i) => seededShuffle(["A", "B", "C", "D", "E"], `s:${i}`)[0]));
    expect(firsts.size).toBeGreaterThan(2);
  });
});

describe("parseGrades", () => {
  const labels = ["R1", "R2"];
  it("accepts strict JSON, fenced JSON and leading prose", () => {
    const body = '{"R1":{"fit":5,"grounding":4,"quality":3,"rationale":"ok"},"R2":{"fit":1,"grounding":2,"quality":2}}';
    for (const t of [body, "```json\n" + body + "\n```", `Here you go:\n${body}`]) {
      const g = parseGrades(t, labels);
      expect(g.R1).toEqual({ fit: 5, grounding: 4, quality: 3, rationale: "ok" });
      expect(g.R2.rationale).toBe("");
    }
  });
  it("rejects a missing label, an out-of-range or non-integer score, and unknown labels", () => {
    expect(() => parseGrades('{"R1":{"fit":5,"grounding":4,"quality":3}}', labels)).toThrow(/lacks R2/);
    expect(() => parseGrades('{"R1":{"fit":6,"grounding":4,"quality":3},"R2":{"fit":1,"grounding":1,"quality":1}}', labels)).toThrow(/R1.fit/);
    expect(() => parseGrades('{"R1":{"fit":4.5,"grounding":4,"quality":3},"R2":{"fit":1,"grounding":1,"quality":1}}', labels)).toThrow(/R1.fit/);
    expect(() => parseGrades('{"R1":{"fit":"4","grounding":4,"quality":3},"R2":{"fit":1,"grounding":1,"quality":1}}', labels)).toThrow(/R1.fit/);
    expect(() =>
      parseGrades('{"R1":{"fit":4,"grounding":4,"quality":3},"R2":{"fit":1,"grounding":1,"quality":1},"R3":{"fit":1,"grounding":1,"quality":1}}', labels),
    ).toThrow(/unknown labels: R3/);
    expect(() => parseGrades("no json here", labels)).toThrow(/no JSON/);
  });
});

describe("buildGraderPrompt", () => {
  it("carries request, reference and blind candidates only, empty answers marked", () => {
    const p = buildGraderPrompt("pide X", "ref Y", [
      { label: "R1", answer: "uno", tools: ["grep"] },
      { label: "R2", answer: "", tools: [] },
    ]);
    expect(p).toMatch(/# REQUEST\n\npide X/);
    expect(p).toMatch(/# REFERENCE[^\n]*\n\nref Y/);
    expect(p).toMatch(/# R1 \(tools called: grep\)\n\nuno/);
    expect(p).toMatch(/# R2 \(tools called: none\)\n\n\(empty answer/);
    expect(p).not.toMatch(/\barm\b|claude-/i);
  });
});

function row(task: string, scores: Record<string, [number, number, number]>, extra: Partial<GradeRow> = {}): GradeRow {
  return {
    task,
    grader_model: "claude-opus-5-5",
    seed: "grade-v1",
    mapping: {},
    scores: Object.fromEntries(Object.entries(scores).map(([a, [f, g, q]]) => [a, { fit: f, grounding: g, quality: q, rationale: "" }])),
    arm_models: { A: "claude-sonnet-4-6", D: "claude-opus-5-5" },
    request_source: "request.md",
    cost_usd: 0.5,
    cost_authoritative: true,
    pricing_cost_usd: 0.5,
    effective_model: "claude-opus-5-5",
    duration_ms: 1000,
    graded_at: "2026-10-06T00:00:00Z",
    ...extra,
  };
}

describe("renderGradeSummary", () => {
  it("means per arm, Δ vs A and the 0.3 rule; the latest error-free row per task wins", () => {
    const md = renderGradeSummary(
      [
        row("t1", { A: [1, 1, 1], D: [1, 1, 1] }),
        row("t1", { A: [4, 4, 4], D: [5, 4, 3] }), // supersedes the first t1 row
        row("t2", { A: [4, 4, 4], D: [5, 4, 4] }),
        row("t3", {}, { error: "parse: no JSON object in grader output" }),
      ],
      "/x/benchmarks/sonnet-tier-2026-10-07-01-00",
    );
    expect(md).toMatch(/graded tasks 2/);
    expect(md).toMatch(/\| A \| claude-sonnet-4-6 \| 2 \| 4\.00 \| 4\.00 \| 4\.00 \| 4\.00 \| — \| — \| — \| — \|/);
    // D: fit 5.00, grounding 4.00, quality 3.50 → Δquality −0.50 → FAIL
    expect(md).toMatch(/\| D \| claude-opus-5-5 \| 2 \| 5\.00 \| 4\.00 \| 3\.50 \| 4\.17 \| \+1\.00 \| \+0\.00 \| -0\.50 \| FAIL \|/);
    expect(md).toMatch(/\| t1 \| 4\/4\/4 \| 5\/4\/3 \|/);
    expect(md).toMatch(/## Errors\n\n- t3: parse/);
    expect(md).toMatch(/grader spend \$2\.00/);
  });
});

describe("CLI on a fixture dir", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "grade-bench-"));
    mkdirSync(join(dir, "results"));
    const w = (f: string, s: string) => writeFileSync(join(dir, "results", f), s);
    w("t1-orig.md", "# t1 — stored production answer\n\nChat: hola\n\n---\n\nprod\n");
    w("t1-request.md", "# t1 — replayed request\n\nChat: hola\n\n## Request\n\nhola\n");
    w("t1-A.md", "# t1 — arm A (x)\n\nChat: hola\n\nstatus=DONE\n\n---\n\na\n");
    w("t1-D.md", "# t1 — arm D (x)\n\nChat: hola\n\nstatus=DONE\n\n---\n\nd\n");
    w("t2-orig.md", "# t2 — stored production answer\n\nChat: solo\n\n---\n\nprod\n");
    w("t2-A.md", "# t2 — arm A (x)\n\nChat: solo\n\nstatus=DONE\n\n---\n\na\n");
    for (const arm of ["A", "C", "D"]) w(`t3-${arm}.md`, `# t3 — arm ${arm} (x)\n\nChat: tres\n\nstatus=DONE\n\n---\n\n${arm.toLowerCase()}\n`);
    w("t3-orig.md", "# t3 — stored production answer\n\nChat: tres\n\n---\n\nprod\n");
    writeFileSync(join(dir, "calls.jsonl"), [{ task: "t1", arm: "A", model: "claude-sonnet-4-6", tool_names: [] }, { task: "t1", arm: "D", model: "claude-opus-5-5", tool_names: ["grep"] }].map((r) => JSON.stringify(r)).join("\n") + "\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const run = (...args: string[]) => spawnSync(TSX, [SCRIPT, dir, ...args], { encoding: "utf8", env: { ...process.env, MC_PID: "0" } });

  it("DRY lists the gradable tasks (≥2 arms) and exits 3 without spending", () => {
    const r = run();
    expect(r.status).toBe(3);
    expect(r.stdout).toMatch(/2 task\(s\) gradable, 0 already graded, 2 to grade/);
    expect(r.stdout).toMatch(/t1 arms=A,D request=request\.md/);
    expect(r.stdout).toMatch(/t3 arms=A,C,D request=title/);
    expect(r.stdout).not.toMatch(/\bt2 arms/);
    expect(r.stdout).toMatch(/DRY/);
  });
  it("--arms is strict: a task lacking a requested arm is skipped with a reason", () => {
    const r = run("--arms=A,C,D");
    expect(r.status).toBe(3);
    expect(r.stdout).toMatch(/skip t1: lacks requested arm\(s\) C \(has A,D\)/);
    expect(r.stdout).toMatch(/1 task\(s\) gradable/);
    expect(r.stdout).toMatch(/t3 arms=A,C,D/);
  });
  it("resumes only under the same key and refuses a mixed grades.jsonl unless --force-mixed", () => {
    mkdirSync(join(dir, "grades"));
    const g = (over: Partial<GradeRow>) => JSON.stringify(row("t1", { A: [4, 4, 4], D: [4, 4, 4] }, { mapping: { R1: "A", R2: "D" }, ...over })) + "\n";
    writeFileSync(join(dir, "grades", "grades.jsonl"), g({}));
    const same = run();
    expect(same.status).toBe(3);
    expect(same.stdout).toMatch(/2 task\(s\) gradable, 1 already graded, 1 to grade/);
    writeFileSync(join(dir, "grades", "grades.jsonl"), g({ seed: "grade-v0" }));
    const mixed = run();
    expect(mixed.status).toBe(2);
    expect(mixed.stderr).toMatch(/1 task\(s\) graded under a different grader\|seed\|arms key: t1 \(graded claude-opus-5-5\|grade-v0\|A,D, now claude-opus-5-5\|grade-v1\|A,D\)/);
    const otherGrader = run("--grader-model=claude-sonnet-5-5");
    expect(otherGrader.status).toBe(2);
    const forced = run("--force-mixed");
    expect(forced.status).toBe(3);
    expect(forced.stdout).toMatch(/--force-mixed: re-grading 1 task/);
    expect(forced.stdout).toMatch(/0 already graded, 2 to grade/);
  });
  it("--summarize re-renders grades-summary.md from grades.jsonl", () => {
    mkdirSync(join(dir, "grades"));
    writeFileSync(join(dir, "grades", "grades.jsonl"), JSON.stringify(row("t1", { A: [4, 4, 4], D: [4, 4, 4] })) + "\n");
    const r = run("--summarize");
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, "grades", "grades-summary.md"), "utf8")).toMatch(/\| D \| claude-opus-5-5 \| 1 \|/);
  });
  it("refuses a dir without results/", () => {
    const r = spawnSync(TSX, [SCRIPT, join(dir, "nope")], { encoding: "utf8" });
    expect(r.status).toBe(2);
  });
});
