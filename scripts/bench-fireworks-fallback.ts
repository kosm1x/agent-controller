/**
 * Fireworks fallback benchmark — which Fireworks serverless model should back
 * the OpenAI-compatible `fallback` provider (`INFERENCE_FALLBACK_*`).
 *
 * DB-free: no database is opened; tools come from a fresh `ToolRegistry`
 * filled from the eval gate's sources (src/tuning/gate-tools.ts); cases are
 * the tool_selection rows of src/tuning/seed-cases.json, scoped per message
 * exactly as the eval gate does. Logic lives in src/tuning/bench-fallback.ts.
 *
 *   npx tsx scripts/bench-fireworks-fallback.ts                 # DRY: no key, no spend, exit 3
 *   npx tsx scripts/bench-fireworks-fallback.ts --run          # key from the environment (see the exit-2 message)
 *     [--models=a,b] [--cases=N] [--out=docs/benchmarks/x.md] [--reasoning-effort=none]
 *
 * The key is read ONLY from the environment and never printed or written.
 * Exit: 0 run complete · 1 bad argument · 2 key missing/invalid or --run
 *       outside an operator context · 3 dry ·
 *       4 every candidate dropped · 5 a report file could not be written.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireOperatorContext } from "../src/lib/operator-gate.js";
import { ToolRegistry } from "../src/tools/registry.js";
import {
  CHAT_PROMPTS,
  CONCURRENCY,
  DEFAULT_CANDIDATES,
  EST_COMPLETION_TOKENS,
  estimateCost,
  parseBenchArgs,
  renderJson,
  renderMarkdown,
  renderScoreTable,
  runBenchmark,
  scopeCases,
  toolCountRange,
  type SeedCase,
} from "../src/tuning/bench-fallback.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const parsed = parseBenchArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`[bench] ${parsed.error}`);
  process.exit(1);
}
const args = parsed.args;

// S6 3c: --run spends money and writes the report files, so it runs from an
// operator context only (exit 2 from a task). DRY has no side effect and stays
// callable anywhere.
if (args.run) requireOperatorContext("bench-fireworks-fallback", { tty: false });

const apiKey = process.env.FIREWORKS_API_KEY ?? "";
if (args.run && apiKey.length === 0) {
  console.error("[bench] --run needs FIREWORKS_API_KEY in the environment (not set). exit 2.");
  process.exit(2);
}

// ---- Tools: the eval gate's sources, each proven DB-free or skipped ----
const registry = new ToolRegistry();
const registered: string[] = [];
const skipped: string[] = [];
const sources: Array<[string, () => Promise<void>]> = [
  [
    "builtin",
    async () => {
      const { BuiltinToolSource } = await import("../src/tools/sources/builtin.js");
      await new BuiltinToolSource().registerTools(registry);
    },
  ],
  [
    "builtin WP/CRM/GWS groups",
    async () => {
      const { WP_TOOLS, CRM_TOOLS, GWS_TOOLS } = await import("../src/tools/sources/builtin.js");
      for (const tool of [...WP_TOOLS, ...CRM_TOOLS, ...GWS_TOOLS]) registry.register(tool);
    },
  ],
  [
    "google",
    async () => {
      const { GoogleToolSource } = await import("../src/tools/sources/google.js");
      await new GoogleToolSource().registerTools(registry);
    },
  ],
  [
    "skills",
    async () => {
      const { SkillsToolSource } = await import("../src/tools/sources/skills.js");
      await new SkillsToolSource().registerTools(registry);
    },
  ],
  [
    "memory(backend_independent)",
    async () => {
      const { MemoryToolSource } = await import("../src/tools/sources/memory.js");
      await new MemoryToolSource("backend_independent").registerTools(registry);
    },
  ],
];
for (const [name, register] of sources) {
  try {
    await register();
    registered.push(name);
  } catch (err) {
    skipped.push(name);
    console.warn(
      `[bench] tool source "${name}" skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
const toolCount = registry.getDefinitions().length;

// ---- Cases ----
const seed = JSON.parse(
  readFileSync(resolve(REPO, "src/tuning/seed-cases.json"), "utf-8"),
) as SeedCase[];
const { cases, unreachable } = scopeCases(seed, registry, args.cases);
const range = toolCountRange(cases);
const models = args.models ?? [...DEFAULT_CANDIDATES];
const date = new Date().toISOString().slice(0, 10);

console.log(`[bench] candidates: ${models.join(", ")}`);
console.log(
  `[bench] tool sources registered: ${registered.join(", ")}${skipped.length ? ` | SKIPPED: ${skipped.join(", ")}` : ""}`,
);
console.log(`[bench] tool definitions: ${toolCount}`);
console.log(
  `[bench] tool cases: ${cases.length} scored, ${unreachable.length} unreachable${unreachable.length ? ` (${unreachable.join(", ")})` : ""}; chat prompts: ${CHAT_PROMPTS.length}`,
);
console.log(`[bench] per-case tool count min/median/max: ${range.min}/${range.median}/${range.max}`);

// ---- DRY ----
if (!args.run) {
  console.log(
    `[bench] estimated cost per model (prompt tokens = request chars/4; ${EST_COMPLETION_TOKENS} completion tokens/call assumed; builtin prices; probe call not counted):`,
  );
  for (const e of estimateCost(models, cases)) {
    console.log(
      `  ${e.model.padEnd(24)} ~${e.promptTokens} prompt tokens  ${e.costUsd === null ? "n/a (no price)" : `~$${e.costUsd.toFixed(4)}`}`,
    );
  }
  console.log(
    `[bench] DRY — nothing called, nothing written. Pass --run with the Fireworks key in the environment for the paid run (concurrency ${CONCURRENCY}/model). exit 3.`,
  );
  process.exit(3);
}

// ---- RUN ----
const outcome = await runBenchmark({
  config: {
    apiKey,
    models,
    ...(args.reasoningEffort !== undefined && { reasoningEffort: args.reasoningEffort }),
    date,
    toolCount,
    toolSources: { registered, skipped },
  },
  cases,
  unreachable,
  deps: {
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  },
  log: (line) => console.log(line),
});

if (outcome.kind === "bad_key") {
  console.error(`[bench] ${outcome.message}. exit 2.`);
  process.exit(2);
}

const result = outcome.result;
const outMd = args.out
  ? isAbsolute(args.out)
    ? args.out
    : resolve(REPO, args.out)
  : resolve(REPO, `docs/benchmarks/fireworks-fallback-${date}.md`);
const outJson = outMd.replace(/\.md$/, ".json");

// Results first: a failed write must not lose a paid run's verdict.
console.log("");
console.log(renderScoreTable(result));
for (const d of result.dropped) console.log(`[bench] dropped ${d.model} (${d.stage}): ${d.reason}`);
console.log(`\nRECOMMENDED: ${result.recommended ?? "none"}`);

let writeFailed = false;
const writeOut = (path: string, content: string) => {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    console.log(`[bench] wrote ${path}`);
  } catch (err) {
    writeFailed = true;
    console.error(`[bench] could not write ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
};
writeOut(outMd, renderMarkdown(result, apiKey));
writeOut(outJson, renderJson(result, apiKey) + "\n");

if (outcome.kind === "all_dropped") {
  console.error("[bench] every candidate was dropped. exit 4.");
  process.exit(4);
}
if (writeFailed) {
  console.error("[bench] a report file was not written (results printed above). exit 5.");
  process.exit(5);
}
process.exit(0);
