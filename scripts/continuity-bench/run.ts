/**
 * Continuity Scorecard — runner (offline, no LLM, scratch db only).
 *
 *   npx tsx scripts/continuity-bench/run.ts --leg raw --sizes 50,500 \
 *     [--corpus benchmarks/continuity/corpus-v2.json] [--out <json>]
 *     [--allow-embeddings [--max-embed-calls 3000] [--embed-cache <file under TMPDIR>]]
 *     [--switch MEMORY_OPEN_WORK=on ...] [--switch MEMORY_RECALL_FLOOR=on] [--switch MEMORY_TOMBSTONES=on]
 *   npx tsx scripts/continuity-bench/run.ts --leg extracted (--run | --dry-run) [--max-model-calls 6] \
 *     [--window day|clean] [--classes C6] [--sizes 50] [--corpus ...] [--out <json>]
 *   npx tsx scripts/continuity-bench/run.ts --report <a.json,b.json,...> --md <out.md>
 *   npx tsx scripts/continuity-bench/run.ts --compare <before.json,after.json[,before2,after2...]> \
 *     [--reference <ref.json[,ref2.json]>] --md <out.md>
 *
 * Switches are production env switches set in this process only (each run
 * sets every known switch, defaults off, and records the states in meta).
 *
 * Refuses to start when an embedding/remote-memory key is in the environment
 * (GEMINI_API_KEY, EMBEDDING_KEY, COMMIT_DB_KEY, HINDSIGHT_ENABLED=true)
 * unless --allow-embeddings; COMMIT_DB_KEY is refused even then (the
 * pgvector leg reads and writes a live remote store). With
 * --allow-embeddings the runner first bounds every embedding call the run can
 * make (stored rows through the bench cache + the per-probe and per-upsert
 * calls production makes itself) and refuses when that bound exceeds
 * --max-embed-calls; at run time a fetch meter refuses any call past the cap
 * and stops the run. The db is a fresh file under os.tmpdir(), removed at exit.
 *
 * `--leg extracted` is the one leg with a model in the loop: the production
 * nightly consolidator (jme.ts consolidateAll -> infer, Haiku) runs once per
 * consolidation night of each scenario. It refuses without `--run` (exit 2);
 * `--dry-run` writes the turns and counts the calls without making one. Under
 * `--run` it refuses (exit 2) unless INFERENCE_PRIMARY_PROVIDER=claude-sdk
 * (the production path), INFERENCE_SDK_LASTLINE_ENABLED is not true (a failed
 * Haiku call would go to the fallback provider) and MC_API_KEY is set (the
 * config loader requires it; any placeholder, nothing is served). Before each
 * call it checks --max-model-calls (default 6) and stops with exit 3 before
 * the call that would exceed it, no result written. A call is one infer();
 * it can make up to 2 billed SDK requests (Haiku, then its retry). `--window
 * day` (default) writes each night's stated turns among seeded ordinary
 * exchanges; `--window clean` writes the stated turns alone (an upper bound).
 * Defaults: --classes C6, --sizes 50, --corpus corpus-v2.json, --out named
 * after the classes and the window.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { requireOperatorContext } from "../../src/lib/operator-gate.js";
import { scrubSecrets } from "../../src/lib/secret-refs.js";
import { generateFiller } from "./filler.js";
import {
  aggregate,
  aggregateAuthor,
  aggregateByGap,
  ingestStats,
  markdownTable,
  scoreProbeWith,
  type Aggregate,
  type AuthorAggregate,
  type AuthorMarkerSpec,
  type GapAggregate,
  type IngestStat,
} from "./score.js";
import type { ExtractionStat, ExtractionWindow } from "./adapter-jarvis.js";
import type { Corpus, CorpusEvent, ProbeRun, ProbeScore, SurfaceScore } from "./types.js";
import { CLASS_LABELS } from "./types.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface RunResult {
  meta: {
    system: "jarvis";
    commit: string;
    leg: "raw" | "ideal" | "extracted";
    embeddings: "off" | "on";
    corpusVersion: string;
    sizes: number[];
    startedAt: string;
    durationMs: number;
    notes: string[];
    /** v2: the author markers the scorer applied. */
    markers?: AuthorMarkerSpec;
    /** v2: embedding calls (rows: through the cache; fetches: every outbound call, cached or not) when embeddings are on. */
    embed?: { uniqueRowTexts: number; rowCalls: number; rowCacheHits: number; rowFailures?: number; fetches?: number; plan?: EmbedPlan };
    /** Production switch states this run set in its process (absent on results from before switches existed = all off). */
    switches?: Record<string, string>;
    /** --classes filter (absent = every class). */
    classes?: string[];
    /** `extracted` leg: model calls made (dry-run: the calls the run would make), against the cap. */
    extraction?: { mode: "run" | "dry-run"; calls: number; maxModelCalls: number; model: string; window: ExtractionWindow };
  };
  ingest: IngestStat[];
  aggregates: Aggregate[];
  probes: Array<
    ProbeScore & {
      text: string;
      components: { proactive: string[]; asked: string[] };
      /** v2: blocks the prompt budget dropped (proactive). */
      dropped?: string[];
    }
  >;
  /** v2 */
  gapAggregates?: GapAggregate[];
  authorAggregates?: AuthorAggregate[];
  /** v2: per component name, its item cap (absent = no count cap). */
  caps?: Record<string, number | null>;
  /** `extracted` leg: per scenario, what the real consolidator did. */
  extraction?: ExtractionStat[];
}

const NOTES = [
  "No model in the loop: scores what REACHES the model, not what it answers.",
  "Embeddings off is the HARNESS configuration (no key, no network): every recall falls back to SQLite FTS5 / LIKE. A keyed production instance also ranks by vectors, supersedes JME facts and runs temporal dedup.",
  "raw leg = conversations rows only; ideal leg adds perfect extraction to jme_facts (upsertFact; with embeddings off a correction supersedes its target through supersedeCluster, and pruneExpiredFacts runs after the ingest) and user_facts (user_fact_set).",
  "Thread: `hydrate` probes read a thread key this process never used (`telegram:p<n>`, same base channel, so the router hydrates the newest 15 rows); C3 `live` pushes the timeline through the router's push seam into an already-held thread; C4 restarts for real (db reopened, router module re-imported, caches and backend reset).",
  "Profile, relevant facts and enrichment pass through the production prompt budget (buildJarvisSystemPrompt with CORE_TOOLS, owner channel); a dropped block is listed under `dropped` and is not in the payload. Production passes CORE_TOOLS plus the scoped groups' tools, whose sections take more room, so the dropped count is a lower bound.",
  "Proactive ms is the sequential sum of the components; production runs enrichment and the scope classifier in parallel.",
  "JME block text replicates the fast-runner template (fast-runner.ts:1126-1139, pinned by a test); the facts come from the real queryMemory/orderForInjection.",
];

/** Appended to the notes of an `extracted` run. */
export const EXTRACTED_NOTE =
  "extracted leg = raw + the jme_facts rows the production nightly consolidator wrote: the stated-fact exchanges (standing, person_fact, correction) through writeEpisodic (window `day`: among seeded ordinary exchanges of the same night; `clean`: alone, an upper bound; meta.extraction.window), then jme.ts consolidateAll once per consolidation night (one real model call each), and pruneExpiredFacts per probe. The consolidator writes facts in English; a Spanish needle is caught only when the fact keeps the word or figure.";

/** Haiku 4.5 list price, USD per million tokens, for the cost line only. */
export const EXTRACTION_PRICE_PER_MTOK = { input: 1, output: 5 };

/**
 * USD per model call at that list price (README §Extracted leg): typical =
 * the measured input (clean about 1,000 tokens, day about 2,300) and a short
 * reply; ceiling = the input at its largest plus the full 1,024-token output.
 */
export const EXTRACTION_COST_PER_CALL: Record<ExtractionWindow, { typical: number; ceiling: number }> = {
  clean: { typical: 0.0015, ceiling: 0.0063 },
  day: { typical: 0.003, ceiling: 0.0076 },
};

/** One infer() can make this many billed SDK requests (Haiku, then its retry); the cap counts infer() calls. */
export const BILLED_REQUESTS_PER_CALL = 2;

const usd = (v: number) => `$${v.toPrecision(2)}`;

/** The window as every printed line names it. */
export function windowLabel(w: ExtractionWindow): string {
  return w === "clean" ? "clean (upper bound: the stated turns alone)" : "day (the stated turns among seeded ordinary exchanges)";
}

/** Typical, ceiling and 2x worst-case cost of `calls` model calls in one window. */
export function extractionCostLine(w: ExtractionWindow, calls: number): string {
  const c = EXTRACTION_COST_PER_CALL[w];
  return `${calls} calls, window ${w}: about ${usd(calls * c.typical)} typical, ${usd(calls * c.ceiling)} ceiling, up to ${BILLED_REQUESTS_PER_CALL}x billed requests (Haiku + its retry) so ${usd(BILLED_REQUESTS_PER_CALL * calls * c.ceiling)} worst case`;
}

/** Printed under every extraction heading. */
export const EXTRACTION_LIMITS = [
  "Limits:",
  "1. The consolidator writes facts in English while the corpus needles are Spanish or English: `caught` and hit % understate what was extracted; the per-scenario `facts` in the JSON are there for a human read.",
  "2. Embeddings off: no cosine supersede, so in C2 the old and the new value both stay live; part of the ideal → extracted stale-hit gap is the harness, not the extractor.",
  "3. Window: `clean` = the stated turns alone (an upper bound); `day` = the stated turns among seeded ordinary exchanges, not the operator's real day.",
].join("\n");

/**
 * Why an `extracted` run may not start (exit 2), or null. Names the cost
 * without --run; under --run, the provider settings the production
 * consolidator needs (names only, never values).
 */
export function extractionRefusal(
  args: { run: boolean; dryRun: boolean; maxModelCalls: number; allowEmbeddings: boolean; window: ExtractionWindow },
  env: NodeJS.ProcessEnv,
): string | null {
  if (args.run && args.dryRun) return "--run and --dry-run are exclusive";
  if (args.allowEmbeddings) return "the extracted leg runs with embeddings off only (its embedding bound is not counted)";
  if (!args.run && !args.dryRun)
    return (
      "the extracted leg makes REAL model calls (the production consolidator, claude-haiku-4-5, one per consolidation night per scenario; " +
      `per call about ${usd(EXTRACTION_COST_PER_CALL.clean.typical)} typical / ${usd(EXTRACTION_COST_PER_CALL.clean.ceiling)} ceiling with --window clean, ` +
      `${usd(EXTRACTION_COST_PER_CALL.day.typical)} / ${usd(EXTRACTION_COST_PER_CALL.day.ceiling)} with --window day, at the list price of ${EXTRACTION_PRICE_PER_MTOK.input} / ${EXTRACTION_PRICE_PER_MTOK.output} USD per million input / output tokens; ` +
      `at most --max-model-calls ${args.maxModelCalls}: ${extractionCostLine(args.window, args.maxModelCalls)}). ` +
      "Pass --run to make them, or --dry-run to count them without a call"
    );
  if (args.dryRun) return null;
  if (env.INFERENCE_PRIMARY_PROVIDER !== "claude-sdk") return "INFERENCE_PRIMARY_PROVIDER is not claude-sdk: the consolidator would not run on the production path";
  if (env.INFERENCE_SDK_LASTLINE_ENABLED === "true") return "INFERENCE_SDK_LASTLINE_ENABLED=true: a failed Haiku call would go to the fallback provider; unset it";
  if (!env.MC_API_KEY) return "MC_API_KEY is not set: the config loader requires it (any placeholder; the bench serves nothing)";
  return null;
}

export function refuseReason(env: NodeJS.ProcessEnv, allowEmbeddings: boolean): string | null {
  if (env.COMMIT_DB_KEY) return "COMMIT_DB_KEY is set (pgvector reads and writes a live remote store) — refused even with --allow-embeddings";
  if (allowEmbeddings) return null;
  const set = ["GEMINI_API_KEY", "EMBEDDING_KEY"].filter((k) => env[k]);
  if (env.HINDSIGHT_ENABLED === "true") set.push("HINDSIGHT_ENABLED=true");
  return set.length ? `${set.join(", ")} set — pass --allow-embeddings to run with embeddings` : null;
}

export type CliArgs =
  | { mode: "report"; report: string[]; md: string }
  | { mode: "compare"; compare: string[]; reference: string[]; md: string }
  | {
      mode: "run";
      leg: "raw" | "ideal" | "extracted";
      sizes: number[];
      /** `--classes C6,C2` (null = every class; the extracted leg defaults to C6). */
      classes: string[] | null;
      /** extracted leg: consent to the model calls / count them without one / the cap. */
      run: boolean;
      dryRun: boolean;
      maxModelCalls: number;
      /** extracted leg: what else each night's window holds (default day). */
      window: ExtractionWindow;
      corpus: string;
      out: string | null;
      allowEmbeddings: boolean;
      maxEmbedCalls: number;
      embedCache: string | null;
      /** `--switch NAME=VALUE`, repeatable (validated against the adapter's SWITCHES at run time). */
      switches: Record<string, string>;
    };

export function parseArgs(argv: readonly string[]): CliArgs {
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const report = arg("--report");
  if (report) {
    const md = arg("--md");
    if (!md) throw new Error("--report needs --md <path>");
    return { mode: "report", report: report.split(","), md };
  }
  const compare = arg("--compare");
  if (compare) {
    const md = arg("--md");
    if (!md) throw new Error("--compare needs --md <path>");
    const files = compare.split(",");
    if (files.length === 0 || files.length % 2 !== 0) throw new Error("--compare needs before,after pairs");
    const reference = arg("--reference");
    return { mode: "compare", compare: files, reference: reference ? reference.split(",") : [], md };
  }
  const switches: Record<string, string> = {};
  for (const [i, a] of argv.entries()) {
    if (a !== "--switch") continue;
    const m = /^([A-Z][A-Z0-9_]*)=([a-z]+)$/.exec(argv[i + 1] ?? "");
    if (!m) throw new Error("--switch takes NAME=value (e.g. MEMORY_OPEN_WORK=on)");
    switches[m[1]] = m[2];
  }
  const allowEmbeddings = argv.includes("--allow-embeddings");
  const leg = (arg("--leg") ?? "raw") as "raw" | "ideal" | "extracted";
  if (leg !== "raw" && leg !== "ideal" && leg !== "extracted") throw new Error("--leg must be raw, ideal or extracted");
  const extracted = leg === "extracted";
  const sizes = (arg("--sizes") ?? (extracted ? "50" : "50,500")).split(",").map((s) => parseInt(s, 10));
  const classesArg = arg("--classes") ?? (extracted ? "C6" : undefined);
  const classes = classesArg ? classesArg.split(",") : null;
  if (classes && classes.some((k) => !(k in CLASS_LABELS))) throw new Error("--classes must be a comma list of C1..C8");
  const maxModelCalls = parseInt(arg("--max-model-calls") ?? "6", 10);
  if (!Number.isInteger(maxModelCalls) || maxModelCalls < 0) throw new Error("--max-model-calls must be a non-negative integer");
  const window = (arg("--window") ?? "day") as ExtractionWindow;
  if (window !== "day" && window !== "clean") throw new Error("--window must be day or clean");
  if (arg("--window") !== undefined && !extracted) throw new Error("--window applies to --leg extracted only");
  if (sizes.some((n) => !Number.isInteger(n) || n < 0)) throw new Error("--sizes must be a comma list of integers");
  const maxEmbedCalls = parseInt(arg("--max-embed-calls") ?? "3000", 10);
  if (!Number.isInteger(maxEmbedCalls) || maxEmbedCalls < 0) throw new Error("--max-embed-calls must be a non-negative integer");
  return {
    mode: "run",
    leg,
    sizes,
    classes,
    run: argv.includes("--run"),
    dryRun: argv.includes("--dry-run"),
    maxModelCalls,
    window,
    corpus: resolve(arg("--corpus") ?? join(ROOT, `benchmarks/continuity/${extracted ? "corpus-v2.json" : "corpus-v1.json"}`)),
    out: arg("--out") ? resolve(arg("--out")!) : null,
    allowEmbeddings,
    maxEmbedCalls,
    embedCache: arg("--embed-cache") ? resolve(arg("--embed-cache")!) : null,
    switches,
  };
}

/**
 * Embedding calls production makes per probe, uncached by the bench (its own
 * 64-entry / 5-min cache can only lower this): memory_search recall (1),
 * enrichment's two recalls (2) and its semantic query (1), JME queryMemory on
 * the proactive and the asked surface (2).
 */
export const EMBED_CALLS_PER_PROBE = 6;
/** Per fact upsert, every time the ideal leg re-ingests it: upsertFact's dedup vector + writeFact's stored one. */
export const EMBED_CALLS_PER_UPSERT = 2;

export interface EmbedPlan {
  /** Distinct stored row texts not yet in the cache (each one embed call, through the bench cache). */
  rowTexts: number;
  /** Distinct fact and probe texts production code embeds itself (at least one call each). */
  otherTexts: number;
  /** rowTexts + otherTexts: a lower bound, for information. */
  unique: number;
  /** Probes × EMBED_CALLS_PER_PROBE. */
  probeCalls: number;
  /** Fact upserts (counted per re-ingest) × EMBED_CALLS_PER_UPSERT. */
  upsertCalls: number;
  /** rowTexts + probeCalls + upsertCalls: what --max-embed-calls is checked against. */
  upperBound: number;
}

/** Counts what an embeddings run would embed, before any call. */
export function embedPlan(
  corpus: Corpus,
  sizes: readonly number[],
  leg: "raw" | "ideal",
  content: (e: CorpusEvent) => string | null,
  cached: (text: string) => boolean = () => false,
): EmbedPlan {
  const rows = new Set<string>();
  const other = new Set<string>();
  let probes = 0;
  let upserts = 0;
  for (const s of corpus.scenarios.filter((x) => sizes.includes(x.fillerSize))) {
    const filler = generateFiller(corpus.fillerSpec, { seed: s.fillerSeed, size: s.fillerSize, fromT: s.fillerFromT, toT: s.fillerToT });
    const lastProbe = Math.max(...s.probes.map((p) => p.t));
    for (const e of s.events) {
      const raw = e.t < lastProbe ? content(e) : null;
      const c = raw === null ? null : scrubSecrets(raw);
      if (c && !cached(c)) rows.add(c);
      if (leg === "ideal" && (e.kind === "person_fact" || e.kind === "correction")) other.add(e.text);
    }
    for (const f of filler) {
      const c = scrubSecrets(`User: ${f.user}\nJarvis: ${f.assistant}`);
      if (f.t < lastProbe && !cached(c)) rows.add(c);
    }
    for (const p of s.probes) {
      other.add(p.text);
      probes++;
      if (leg === "ideal") upserts += s.events.filter((e) => e.t < p.t && (e.kind === "person_fact" || e.kind === "correction")).length;
    }
  }
  const probeCalls = probes * EMBED_CALLS_PER_PROBE;
  const upsertCalls = upserts * EMBED_CALLS_PER_UPSERT;
  return {
    rowTexts: rows.size,
    otherTexts: other.size,
    unique: rows.size + other.size,
    probeCalls,
    upsertCalls,
    upperBound: rows.size + probeCalls + upsertCalls,
  };
}

/** Null when the plan fits, else why the run is refused (checked against the UPPER BOUND, not the unique count). */
export function embedBudgetRefusal(plan: EmbedPlan, maxEmbedCalls: number): string | null {
  return plan.upperBound > maxEmbedCalls
    ? `upper bound ${plan.upperBound} embedding calls > --max-embed-calls ${maxEmbedCalls} (raise it, or pass smaller --sizes)`
    : null;
}

export function describePlan(plan: EmbedPlan): string {
  return (
    `embeddings on: upper bound ${plan.upperBound} calls = ${plan.rowTexts} stored rows not in the bench cache` +
    ` + ${plan.probeCalls} per-probe (${EMBED_CALLS_PER_PROBE} each: memory_search, 2 enrichment recalls, enrichment semantic, 2 JME queries)` +
    ` + ${plan.upsertCalls} per-upsert (${EMBED_CALLS_PER_UPSERT} each); ${plan.unique} unique texts.` +
    ` Every outbound fetch (cached or not) is metered and refused past the cap.`
  );
}

/**
 * Counts every outbound fetch of the run (the only network use with Hindsight
 * off is the embedding API: generateEmbedding → fetch) and refuses each call
 * past `cap` without sending it; `exceeded` then stops the run. Production
 * code is unchanged: the wrapper passes every call under the cap through.
 */
export class FetchMeter {
  calls = 0;
  refused = 0;
  private original: typeof fetch | null = null;

  constructor(readonly cap: number) {}

  get exceeded(): boolean {
    return this.refused > 0;
  }

  install(target: { fetch: typeof fetch } = globalThis): void {
    const original = target.fetch;
    this.original = original;
    target.fetch = ((...args: Parameters<typeof fetch>) => {
      if (this.calls >= this.cap) {
        this.refused++;
        return Promise.reject(new Error(`continuity-bench: embedding call cap ${this.cap} reached`));
      }
      this.calls++;
      return original(...args);
    }) as typeof fetch;
  }

  restore(target: { fetch: typeof fetch } = globalThis): void {
    if (this.original) target.fetch = this.original;
    this.original = null;
  }
}

function shortSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "nogit";
  }
}

/** Caveats every baseline carries (round-1 audit item 10). */
export const BASELINE_CAVEATS = [
  "**C3/C4** — the filler sits before the session, so the size axis says nothing about the thread; the axis is K, the primary-channel exchanges between the session end and the probe. The router hydrates the newest 15 rows of the base channel: K ≤ 14 keeps the open work in the thread, K ≥ 15 pushes it out, and only recall can bring it back. `hydrate` (a process that never held the thread), `live` (it held it) and `restart` (C4) are three different code paths; `interleave` adds 20 rows of another channel to a K = 5 gap and checks the channel filter.",
  "**C7** — 100 % means the recall returned nothing for a topic that never came up. An empty or broken adapter also scores 100 %, so C7 is shown only beside C1 from the same run, with the result cap next to the irrelevant-items mean.",
  "**Thread dominance** — when the target sits in the last 15 rows, the thread carries the hit whatever the memory layer does. The carried-by columns split hits into thread / recall (selected by the probe) / ambient (always-present blocks; not exclusive). Read memory quality from the recall share and the thread-only share, not from hit % alone.",
  "**Not scored** — a surface an adapter declares unmeasurable is shown as \"not scored\", never dropped.",
];

const c = (v: number | null | undefined, suffix = "") => (v === null || v === undefined ? "–" : `${v}${suffix}`);
const ms1 = (v: number | null | undefined) => (v === null || v === undefined ? "–" : v.toFixed(1));

function mainTable(rows: readonly Aggregate[]): string {
  const head =
    "| class | size | surface | n | hit % | hit % shared (n) | hit % disjoint (n) | stale-hit % | carried: thread / recall / ambient % | thread-only % | median chars | median ms |\n" +
    "| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |";
  const body = rows
    .filter((r) => !["C3", "C4", "C7"].includes(r.class))
    .map((r) =>
      r.n === 0
        ? `| ${r.class} ${r.label} | ${r.fillerSize} | ${r.surface} | 0 | not scored (${r.notScored ?? 0}) | | | | | | | |`
        : `| ${r.class} ${r.label} | ${r.fillerSize} | ${r.surface} | ${r.n} | ${c(r.hitPct)} | ${c(r.hitPctShared)} (${r.nShared ?? 0}) | ${c(r.hitPctDisjoint)} (${r.nDisjoint ?? 0}) | ${c(r.staleHitPct)} | ${c(r.carriedThreadPct)} / ${c(r.carriedRecallPct)} / ${c(r.carriedAmbientPct)} | ${c(r.threadOnlyPct)} | ${c(r.medianChars)} | ${ms1(r.medianMs)} |`,
    );
  return [head, ...body].join("\n");
}

function gapTable(rows: readonly GapAggregate[]): string {
  const head =
    "| class | variant | K | other-channel rows | surface | n | hit % | hit % shared | hit % disjoint | carried: thread % | carried: recall % |\n" +
    "| --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |";
  const body = rows.map((r) =>
    r.n === 0
      ? `| ${r.class} | ${r.variant} | ${c(r.gapRows)} | ${c(r.otherChannelRows)} | ${r.surface} | 0 | not scored (${r.notScored}) | | | | |`
      : `| ${r.class} | ${r.variant} | ${c(r.gapRows)} | ${c(r.otherChannelRows ?? 0)} | ${r.surface} | ${r.n} | ${c(r.hitPct)} | ${c(r.hitPctShared)} | ${c(r.hitPctDisjoint)} | ${c(r.carriedThreadPct)} | ${c(r.carriedRecallPct)} |`,
  );
  return [head, ...body].join("\n");
}

function authorTable(rows: readonly AuthorAggregate[]): string {
  const head =
    "| author case | size | surface | n | hit % | author-marked % (strict) | author-marked % (any occurrence) | attribution conflict % |\n" +
    "| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |";
  const body = rows.map((r) =>
    r.n === 0
      ? `| ${r.authorCase} | ${r.fillerSize} | ${r.surface} | 0 | not scored (${r.notScored}) | | | |`
      : `| ${r.authorCase} | ${r.fillerSize} | ${r.surface} | ${r.n} | ${c(r.hitPct)} | ${c(r.authorMarkedPct)} | ${c(r.authorMarkedAnyPct)} | ${c(r.attributionConflictPct)} |`,
  );
  return [head, ...body].join("\n");
}

function c7Table(rows: readonly Aggregate[], caps: Record<string, number | null> | undefined): string {
  const head =
    "| size | surface | C1 hit % (same run) | C7 n | C7 hit % | C7 mean irrelevant | C7 hit % shared / disjoint | result cap |\n" +
    "| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |";
  const capText = (surface: "proactive" | "asked") => {
    if (!caps) return "–";
    const names = surface === "asked" ? ["memory_search", "jme_query"] : Object.keys(caps).filter((n) => n !== "memory_search" && n !== "jme_query");
    return names.map((n) => `${n} ${caps[n] ?? "no count cap"}`).join(", ") || "–";
  };
  const body = rows
    .filter((r) => r.class === "C7")
    .map((r) => {
      const c1 = rows.find((x) => x.class === "C1" && x.fillerSize === r.fillerSize && x.surface === r.surface);
      if (r.n === 0) return `| ${r.fillerSize} | ${r.surface} | ${c(c1?.hitPct)} | 0 | not scored (${r.notScored ?? 0}) | | | |`;
      return `| ${r.fillerSize} | ${r.surface} | ${c(c1?.hitPct)} | ${r.n} | ${c(r.hitPct)} | ${c(r.meanIrrelevant)} | ${c(r.hitPctShared)} / ${c(r.hitPctDisjoint)} | ${capText(r.surface)} |`;
    });
  return [head, ...body].join("\n");
}

export function renderBaseline(results: RunResult[]): string {
  const version = results[0]?.meta.corpusVersion ?? "continuity-v1";
  const v2 = results.some((r) => r.gapAggregates);
  const parts: string[] = [
    `# Continuity Scorecard — Jarvis baseline (${version})`,
    "",
    `Generated by \`scripts/continuity-bench/run.ts --report\`. Corpus \`benchmarks/continuity/corpus-${version.replace("continuity-", "")}.json\`; method and limits in \`benchmarks/continuity/README.md\`.`,
    "",
    "Classes: " + Object.entries(CLASS_LABELS).map(([k, v]) => `${k} ${v}`).join(" · ") + ".",
    "",
    "Caveats:",
    "",
    ...BASELINE_CAVEATS.map((x) => `- ${x}`),
    "",
    "Columns: hit % = every expect needle reached the surface; shared / disjoint = the probe does / does not share a content word with its target under the documented neutral stop-word list (README §Wording; a system can still reach a disjoint target through function words, substring matching, a recency fallback, or meaning); stale-hit % = a forbid needle reached it; carried = share of hits whose needle sat in a thread / recall / ambient component (not exclusive).",
  ];
  for (const r of results) {
    parts.push(
      "",
      `## leg \`${r.meta.leg}\` · embeddings ${r.meta.embeddings} · commit ${r.meta.commit} · corpus ${r.meta.corpusVersion}${r.meta.switches ? ` · switches ${switchText(r)}` : ""}${r.meta.leg === "extracted" ? ` · ${PROVISIONAL}` : ""}`,
      "",
      `Run ${r.meta.startedAt}, ${(r.meta.durationMs / 1000).toFixed(1)} s.`,
      "",
    );
    if (r.extraction) parts.push(extractionTable(r), "");
    if (!v2 || !r.gapAggregates) {
      parts.push(markdownTable(r.aggregates));
    } else {
      parts.push(
        "### Recall classes (C1, C2, C5, C6, C8)",
        "",
        mainTable(r.aggregates),
        "",
        "### C3 / C4 by gap K (pooled over filler sizes)",
        "",
        gapTable(r.gapAggregates),
        "",
        "### C5 who-said-it by author case",
        "",
        "Strict: some surfaced occurrence of the figure is attributed to the expected author, and every occurrence is attributed (line marker → item marker → block heading) to a role that stated it in the events (`statedBy`; an echo passes when each copy carries its own author). Any occurrence: the v1 rule. Conflict: an occurrence on a line marked for one role inside a block whose heading attributes it to the other; for Jarvis no heading claims authorship, so it is 0 by construction, and whether recalled assistant lines are later treated as the person's evidence is not measured here.",
        "",
        authorTable(r.authorAggregates ?? []),
        "",
        "### C7 nothing-to-recall, beside C1 from the same run",
        "",
        c7Table(r.aggregates, r.caps),
      );
      const droppedProbes = r.probes.filter((p) => p.dropped && p.dropped.length > 0).length;
      parts.push("", `Prompt budget: ${droppedProbes} of ${r.probes.length} probes had a block dropped by buildJarvisSystemPrompt (checked with CORE_TOOLS only; production adds the scoped tools, so this is a lower bound).`);
    }
    parts.push(
      "",
      "Ingest and latency per filler size:",
      "",
      "| size | probes | rows written | ingest ms | rows/s | median proactive ms | median asked ms |",
      "| ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...r.ingest.map(
        (i) =>
          `| ${i.fillerSize} | ${i.probes} | ${i.rows} | ${i.ms} | ${i.rowsPerSec} | ${i.medianProactiveMs?.toFixed(1) ?? "–"} | ${i.medianAskedMs?.toFixed(1) ?? "–"} |`,
      ),
    );
  }
  return parts.join("\n") + "\n";
}

/** Every number from an `extracted` run carries this until the audit has read its JSON. */
export const PROVISIONAL = "PROVISIONAL (real model extraction; not audited)";

/** Per class and size: the real consolidator's calls, inserted facts and catches. */
function extractionTable(r: RunResult, limits = true): string {
  const x = r.meta.extraction;
  const rows = new Map<string, ExtractionStat[]>();
  for (const e of r.extraction ?? []) rows.set(`${e.class}|${e.fillerSize}`, [...(rows.get(`${e.class}|${e.fillerSize}`) ?? []), e]);
  const sum = (es: ExtractionStat[], f: (e: ExtractionStat) => number) => es.reduce((a, e) => a + f(e), 0);
  return [
    `### Extraction (${PROVISIONAL})`,
    "",
    ...(limits ? [EXTRACTION_LIMITS, ""] : []),
    x
      ? `Mode ${x.mode}, model ${x.model}, window ${windowLabel(x.window)}: ${x.calls} model calls${x.mode === "dry-run" ? " counted, none made" : ` made, cap ${x.maxModelCalls}`}. Cost estimate: ${extractionCostLine(x.window, x.calls)}. Caught = every probe of the scenario has a live extracted fact holding all its expect needles (folded substring, as the scorer).`
      : "",
    "",
    "| class | size | scenarios | model calls | turns | inserted | caught / total | failed calls |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...[...rows.entries()].map(([k, es]) => {
      const [cls, size] = k.split("|");
      return `| ${cls} | ${size} | ${es.length} | ${sum(es, (e) => e.calls)} | ${sum(es, (e) => e.turns)} | ${sum(es, (e) => e.inserted)} | ${es.filter((e) => e.caught).length} / ${es.length} | ${sum(es, (e) => e.failedCalls)} |`;
    }),
  ].join("\n");
}

/**
 * Port 4: ideal (perfect extraction) beside extracted (the real consolidator)
 * on the same classes and sizes; the gap is what real extraction loses.
 */
export function renderExtractionCompare(pairs: ReadonlyArray<readonly [RunResult, RunResult]>): string {
  const parts: string[] = [
    `# Port 4 — real extraction of stated facts: ideal / extracted (${PROVISIONAL})`,
    "",
    "Generated by `scripts/continuity-bench/run.ts --compare`; every figure below is computed from the result files named here. The extracted leg's facts come from one real model call per consolidation night; its numbers stay provisional until the audit has read the JSON.",
    "",
    EXTRACTION_LIMITS,
    "",
    `Cost per model call at the Haiku list price: window clean about ${usd(EXTRACTION_COST_PER_CALL.clean.typical)} typical / ${usd(EXTRACTION_COST_PER_CALL.clean.ceiling)} ceiling, window day ${usd(EXTRACTION_COST_PER_CALL.day.typical)} / ${usd(EXTRACTION_COST_PER_CALL.day.ceiling)}; one call can make up to ${BILLED_REQUESTS_PER_CALL}x billed requests (Haiku + its retry), so the worst case is ${BILLED_REQUESTS_PER_CALL}x the ceiling.`,
  ];
  for (const [ideal, extracted] of pairs) {
    if (ideal.meta.leg !== "ideal" || extracted.meta.leg !== "extracted") throw new Error("--compare for the extracted leg takes ideal,extracted pairs");
    parts.push(
      "",
      `## embeddings ${extracted.meta.embeddings} · corpus ${extracted.meta.corpusVersion}`,
      "",
      `- ideal: commit ${ideal.meta.commit}, run ${ideal.meta.startedAt}`,
      `- extracted: commit ${extracted.meta.commit}, run ${extracted.meta.startedAt}, ${extracted.meta.extraction ? `${extracted.meta.extraction.mode}, window ${windowLabel(extracted.meta.extraction.window)}, ${extracted.meta.extraction.calls} model calls (${extracted.meta.extraction.model})` : "no extraction meta"}`,
      "",
      "| class | size | surface | n | hit % ideal → extracted | gap (pp) | stale-hit % ideal → extracted |",
      "| --- | ---: | --- | ---: | ---: | ---: | ---: |",
    );
    for (const a of extracted.aggregates) {
      const b = ideal.aggregates.find((x) => x.class === a.class && x.fillerSize === a.fillerSize && x.surface === a.surface);
      const gap = b && a.hitPct !== null && b.hitPct !== null ? Math.round(10 * (a.hitPct - b.hitPct)) / 10 : null;
      parts.push(`| ${a.class} | ${a.fillerSize} | ${a.surface} | ${a.n} | ${c(b?.hitPct)} → ${c(a.hitPct)} | ${c(gap)} | ${c(b?.staleHitPct)} → ${c(a.staleHitPct)} |`);
    }
    parts.push("", extractionTable(extracted, false));
  }
  return parts.join("\n") + "\n";
}

type ProbeRow = RunResult["probes"][number];
const probeKey = (p: ProbeRow) => `${p.scenarioId}#${p.probeIndex}`;
const switchText = (r: RunResult) =>
  Object.entries(r.meta.switches ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(", ") || "none recorded (all off)";
const gapKey = (g: { class: string; variant: string; gapRows: number | null; otherChannelRows: number | null }) =>
  `${g.class}|${g.variant}|${g.gapRows ?? ""}|${g.otherChannelRows ?? ""}`;
const probeGapKey = (p: ProbeRow) => gapKey({ class: p.class, variant: p.variant ?? "none", gapRows: p.gapRows ?? null, otherChannelRows: p.otherChannelRows ?? null });

/** A probe's scores without timings: what a reproduction must match exactly. */
function scoreFingerprint(p: ProbeRow): string {
  const { ms: _a, ...proactive } = p.proactive;
  const { ms: _b, ...asked } = p.asked;
  return JSON.stringify({ ...p, proactive, asked });
}

function medianMax(xs: readonly number[]): string {
  if (xs.length === 0) return "–";
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const med = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return `median ${med}, max ${sorted[sorted.length - 1]}`;
}

const verdict = (ok: boolean) => (ok ? "PASS" : "FAIL");

/** Null test 1: `before` reproduces each reference run (same leg) probe for probe, timings aside. */
function reproductionLines(before: RunResult, references: readonly RunResult[]): string[] {
  const refs = references.filter((r) => r.meta.leg === before.meta.leg && r.meta.embeddings === before.meta.embeddings);
  if (refs.length === 0) return ["1. Reproduction: no reference run for this leg — not checked."];
  const beforeByKey = new Map(before.probes.map((p) => [probeKey(p), p]));
  return refs.map((ref) => {
    const missing = ref.probes.filter((p) => !beforeByKey.has(probeKey(p))).length;
    const differ = ref.probes.filter((p) => beforeByKey.has(probeKey(p)) && scoreFingerprint(p) !== scoreFingerprint(beforeByKey.get(probeKey(p))!));
    return `1. **${verdict(missing === 0 && differ.length === 0)}** — before reproduces reference commit ${ref.meta.commit} (switches ${switchText(ref)}) on its ${ref.probes.length} probes: ${differ.length} differ, ${missing} missing (timings excluded)${differ.length ? `; first: ${differ.slice(0, 5).map(probeKey).join(", ")}` : ""}.`;
  });
}

/**
 * Two Jarvis runs that differ only in their switches, side by side, with the
 * three null tests computed from the files (no hand-written figure):
 *   1. `before` reproduces each reference run (same leg) probe for probe on
 *      the reference's scenarios, timings aside;
 *   2. C4 (no idle gap between the session end and the gap rows) is unchanged;
 *   3. every class other than C3/C4 keeps its hit, stale-hit, wording,
 *      author and C7 cells, and payload chars change only on probes that
 *      carry the `open_work` component.
 */
export function renderCompare(pairs: ReadonlyArray<readonly [RunResult, RunResult]>, references: readonly RunResult[] = []): string {
  const parts: string[] = [
    "# Port 1 — session tail notes: before / after",
    "",
    "Generated by `scripts/continuity-bench/run.ts --compare`; every figure below is computed from the result files named here. Method and limits: `benchmarks/continuity/README.md` §Session tail notes.",
  ];
  for (const [before, after] of pairs) {
    parts.push(
      "",
      `## leg \`${before.meta.leg}\` · embeddings ${before.meta.embeddings} · corpus ${before.meta.corpusVersion}`,
      "",
      `- before: commit ${before.meta.commit}, switches ${switchText(before)}, run ${before.meta.startedAt}`,
      `- after: commit ${after.meta.commit}, switches ${switchText(after)}, run ${after.meta.startedAt}`,
    );
    const afterByKey = new Map(after.probes.map((p) => [probeKey(p), p]));

    // C3 / C4 side by side.
    const keys = [...new Map([...(before.gapAggregates ?? []), ...(after.gapAggregates ?? [])].filter((g) => g.surface === "proactive").map((g) => [gapKey(g), g])).values()];
    keys.sort((a, b) => a.class.localeCompare(b.class) || a.variant.localeCompare(b.variant) || (a.gapRows ?? 0) - (b.gapRows ?? 0) || (a.otherChannelRows ?? 0) - (b.otherChannelRows ?? 0));
    const cell = (g: GapAggregate | undefined) => (g ? `${c(g.hitPct)} (${c(g.hitPctShared)} / ${c(g.hitPctDisjoint)})` : "–");
    parts.push(
      "",
      "### C3 / C4 by variant and K (proactive, pooled over filler sizes)",
      "",
      "| class | variant | K | other-channel rows | n | before hit % (shared / disjoint) | after hit % (shared / disjoint) | after: hits carried by open_work % |",
      "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...keys.map((k) => {
        const find = (r: RunResult) => r.gapAggregates?.find((g) => g.surface === "proactive" && gapKey(g) === gapKey(k));
        const hits = after.probes.filter((p) => probeGapKey(p) === gapKey(k) && p.proactive.hit);
        const viaNotes = hits.filter((p) => p.proactive.carriedBy?.includes("open_work")).length;
        return `| ${k.class} | ${k.variant} | ${c(k.gapRows)} | ${c(k.otherChannelRows ?? 0)} | ${find(after)?.n ?? find(before)?.n ?? 0} | ${cell(find(before))} | ${cell(find(after))} | ${hits.length ? c(Math.round((1000 * viaNotes) / hits.length) / 10) : "–"} |`;
      }),
    );

    // C3 per filler size: the pooled cells above can hide a size where the notes do nothing.
    const sizes = [...new Set(after.probes.map((p) => p.fillerSize))].sort((a, b) => a - b);
    const sizeCell = (r: RunResult, k: GapAggregate, size: number) => {
      const ps = r.probes.filter((p) => p.fillerSize === size && probeGapKey(p) === gapKey(k));
      return ps.length ? c(Math.round((1000 * ps.filter((p) => p.proactive.hit).length) / ps.length) / 10) : "–";
    };
    parts.push(
      "",
      "### C3 by variant, K and filler size (proactive hit %, before → after)",
      "",
      `| variant | K | other-channel rows | ${sizes.map((z) => `size ${z}`).join(" | ")} |`,
      `| --- | ---: | ---: | ${sizes.map(() => "---:").join(" | ")} |`,
      ...keys
        .filter((k) => k.class === "C3")
        .map((k) => `| ${k.variant} | ${c(k.gapRows)} | ${c(k.otherChannelRows ?? 0)} | ${sizes.map((z) => `${sizeCell(before, k, z)} → ${sizeCell(after, k, z)}`).join(" | ")} |`),
    );

    // Null test 1.
    parts.push("", "### Null tests", "", ...reproductionLines(before, references));

    // Null test 2.
    const c4 = keys.filter((k) => k.class === "C4");
    const c4Changed = c4.filter((k) => {
      const find = (r: RunResult) => r.gapAggregates?.find((g) => g.surface === "proactive" && gapKey(g) === gapKey(k));
      return cell(find(before)) !== cell(find(after));
    });
    parts.push(
      `2. **${verdict(c4Changed.length === 0)}** — C4 (no idle gap between the session end and the gap rows) unchanged at every K: ${c4.length - c4Changed.length} of ${c4.length} rows identical${c4Changed.length ? `; changed K: ${c4Changed.map((k) => k.gapRows).join(", ")}` : ""}.`,
    );

    // Null test 3.
    const other = (a: Aggregate) => !["C3", "C4"].includes(a.class);
    const aggCells = (r: RunResult) =>
      new Map(
        r.aggregates.filter(other).map((a) => [
          `${a.class} size ${a.fillerSize} ${a.surface}`,
          JSON.stringify([a.n, a.hitPct, a.staleHitPct, a.hitPctShared, a.hitPctDisjoint, a.meanIrrelevant, a.authorMarkedPct]),
        ]),
      );
    const authCells = (r: RunResult) =>
      new Map((r.authorAggregates ?? []).map((a) => [`C5 ${a.authorCase} size ${a.fillerSize} ${a.surface}`, JSON.stringify([a.n, a.hitPct, a.authorMarkedPct, a.authorMarkedAnyPct, a.attributionConflictPct])]));
    const changedCells: string[] = [];
    for (const get of [aggCells, authCells]) {
      const b = get(before);
      const a = get(after);
      for (const k of new Set([...b.keys(), ...a.keys()])) if (b.get(k) !== a.get(k)) changedCells.push(k);
    }
    const flips = before.probes.filter((p) => {
      const q = afterByKey.get(probeKey(p));
      return !["C3", "C4"].includes(p.class) && q && (["proactive", "asked"] as const).some((s) => p[s].hit !== q[s].hit || p[s].staleHit !== q[s].staleHit);
    });
    const count = (s: "proactive" | "asked", f: "hit" | "staleHit", from: boolean) =>
      flips.filter((p) => p[s][f] === from && afterByKey.get(probeKey(p))![s][f] !== from).length;
    const direction = (["proactive", "asked"] as const)
      .map((s) => `${s}: hit +${count(s, "hit", false)} / −${count(s, "hit", true)}, stale-hit +${count(s, "staleHit", false)} / −${count(s, "staleHit", true)}`)
      .join("; ");
    parts.push(
      `3. **${verdict(changedCells.length === 0 && flips.length === 0)}** — C1, C2, C5, C6, C7, C8: ${changedCells.length} changed cells (hit, stale-hit, shared / disjoint, C7 irrelevant, C5 author), ${flips.length} probes with a hit or stale-hit flip (${direction})${changedCells.length ? `; changed: ${changedCells.join("; ")}` : ""}${flips.length ? `; flipped: ${flips.slice(0, 8).map(probeKey).join(", ")}${flips.length > 8 ? ", …" : ""}` : ""}.`,
    );

    // Payload size.
    const deltas = before.probes.flatMap((p) => {
      const q = afterByKey.get(probeKey(p));
      if (!q || q.proactive.chars === p.proactive.chars) return [];
      return [{ p, q, d: q.proactive.chars - p.proactive.chars, notes: q.components.proactive.some((x) => x.startsWith("open_work:")) }];
    });
    const unexplained = deltas.filter((x) => !x.notes || x.d < 0);
    const withNotes = after.probes.filter((p) => p.components.proactive.some((x) => x.startsWith("open_work:"))).length;
    parts.push(
      "",
      "### Proactive payload chars",
      "",
      `${deltas.length} of ${before.probes.length} probes changed size; ${withNotes} probes carry the open_work block; ${unexplained.length} changed without it or shrank (${verdict(unexplained.length === 0)}). Rise per changed probe: ${medianMax(deltas.map((x) => x.d))} chars.`,
      "",
      "| class | probes changed | rise (chars) |",
      "| --- | ---: | --- |",
      ...[...new Set(deltas.map((x) => x.p.class))].sort().map((cls) => {
        const ds = deltas.filter((x) => x.p.class === cls).map((x) => x.d);
        return `| ${cls} | ${ds.length} | ${medianMax(ds)} |`;
      }),
    );
  }
  return parts.join("\n") + "\n";
}

const pct = (num: number, den: number) => (den ? c(Math.round((1000 * num) / den) / 10) : "–");

/**
 * Port 2 (MEMORY_RECALL_FLOOR) before / after, every figure from the files:
 * C7 irrelevant items and hit and C1 hit (shared / disjoint) per filler size
 * and surface, the C1 hits lost or gained, null test 1 (reproduction), every
 * other class's cells, and the payload change on both surfaces.
 */
export function renderRecallFloorCompare(pairs: ReadonlyArray<readonly [RunResult, RunResult]>, references: readonly RunResult[] = []): string {
  const surfaces = ["proactive", "asked"] as const;
  const parts: string[] = [
    "# Port 2 — an honest empty recall: before / after",
    "",
    "Generated by `scripts/continuity-bench/run.ts --compare`; every figure below is computed from the result files named here. Method and limits: `benchmarks/continuity/README.md` §Recall floor.",
  ];
  for (const [before, after] of pairs) {
    parts.push(
      "",
      `## leg \`${before.meta.leg}\` · embeddings ${before.meta.embeddings} · corpus ${before.meta.corpusVersion}`,
      "",
      `- before: commit ${before.meta.commit}, switches ${switchText(before)}, run ${before.meta.startedAt}`,
      `- after: commit ${after.meta.commit}, switches ${switchText(after)}, run ${after.meta.startedAt}`,
    );
    const afterByKey = new Map(after.probes.map((p) => [probeKey(p), p]));
    const sizes = [...new Set(after.probes.map((p) => p.fillerSize))].sort((a, b) => a - b);
    const agg = (r: RunResult, cls: string, size: number, surface: string) =>
      r.aggregates.find((a) => a.class === cls && a.fillerSize === size && a.surface === surface);
    const arrow = (b: number | null | undefined, a: number | null | undefined) => `${c(b)} → ${c(a)}`;

    parts.push(
      "",
      "### C7 and C1 by filler size",
      "",
      "| size | surface | C7 n | C7 mean irrelevant | C7 hit % | C1 n (shared / disjoint) | C1 hit % | C1 hit % shared | C1 hit % disjoint |",
      "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...sizes.flatMap((z) =>
        surfaces.map((s) => {
          const [b7, a7, b1, a1] = [agg(before, "C7", z, s), agg(after, "C7", z, s), agg(before, "C1", z, s), agg(after, "C1", z, s)];
          return `| ${z} | ${s} | ${a7?.n ?? 0} | ${arrow(b7?.meanIrrelevant, a7?.meanIrrelevant)} | ${arrow(b7?.hitPct, a7?.hitPct)} | ${a1?.n ?? 0} (${a1?.nShared ?? 0} / ${a1?.nDisjoint ?? 0}) | ${arrow(b1?.hitPct, a1?.hitPct)} | ${arrow(b1?.hitPctShared, a1?.hitPctShared)} | ${arrow(b1?.hitPctDisjoint, a1?.hitPctDisjoint)} |`;
        }),
      ),
    );

    // C1 hits by direction: a disjoint hit that came by chance may drop.
    const c1 = before.probes.filter((p) => p.class === "C1" && afterByKey.has(probeKey(p)));
    const moved = (s: (typeof surfaces)[number], z: number, from: boolean, shared: boolean) =>
      c1.filter((p) => p.fillerSize === z && (p.wording === "shared") === shared && p[s].hit === from && afterByKey.get(probeKey(p))![s].hit !== from);
    parts.push(
      "",
      "### C1 hits lost / gained (probes)",
      "",
      "| size | surface | lost shared | lost disjoint | gained shared | gained disjoint | first lost |",
      "| ---: | --- | ---: | ---: | ---: | ---: | --- |",
      ...sizes.flatMap((z) =>
        surfaces.map((s) => {
          const lost = [...moved(s, z, true, true), ...moved(s, z, true, false)];
          return `| ${z} | ${s} | ${moved(s, z, true, true).length} | ${moved(s, z, true, false).length} | ${moved(s, z, false, true).length} | ${moved(s, z, false, false).length} | ${lost.slice(0, 4).map(probeKey).join(", ") || "–"} |`;
        }),
      ),
    );

    parts.push("", "### Null tests", "", ...reproductionLines(before, references));

    // Every class other than C1 / C7: the cells and probe flips that changed.
    const cellsOf = (r: RunResult) => {
      const m = new Map<string, string>();
      for (const a of r.aggregates.filter((x) => x.class !== "C1" && x.class !== "C7"))
        m.set(`${a.class} size ${a.fillerSize} ${a.surface}`, JSON.stringify([a.n, a.hitPct, a.staleHitPct, a.hitPctShared, a.hitPctDisjoint, a.authorMarkedPct]));
      for (const g of r.gapAggregates ?? []) m.set(`${g.class} ${g.variant} K ${c(g.gapRows)} other ${c(g.otherChannelRows ?? 0)} ${g.surface}`, JSON.stringify([g.n, g.hitPct, g.hitPctShared, g.hitPctDisjoint]));
      for (const a of r.authorAggregates ?? []) m.set(`C5 ${a.authorCase} size ${a.fillerSize} ${a.surface}`, JSON.stringify([a.n, a.hitPct, a.authorMarkedPct, a.authorMarkedAnyPct, a.attributionConflictPct]));
      return m;
    };
    const [bc, ac] = [cellsOf(before), cellsOf(after)];
    const changed = [...new Set([...bc.keys(), ...ac.keys()])].filter((k) => bc.get(k) !== ac.get(k));
    // A surface the class does not score (C3 / C4 / C6 asked) is in no cell; its flips are listed apart.
    const flipsOn = (scored: boolean) =>
      before.probes.filter((p) => {
        const q = afterByKey.get(probeKey(p));
        return p.class !== "C1" && p.class !== "C7" && q && surfaces.some((s) => p[s].scored === scored && (p[s].hit !== q[s].hit || p[s].staleHit !== q[s].staleHit));
      });
    const flips = flipsOn(true);
    const unscoredFlips = flipsOn(false).filter((p) => !flips.includes(p));
    const flipCount = (cls: string, s: (typeof surfaces)[number], f: "hit" | "staleHit", from: boolean) =>
      before.probes.filter((p) => p.class === cls && afterByKey.has(probeKey(p)) && p[s][f] === from && afterByKey.get(probeKey(p))![s][f] !== from).length;
    const unscored = (cls: string, s: (typeof surfaces)[number]) => before.probes.filter((p) => p.class === cls).every((p) => !p[s].scored);
    parts.push(
      `2. **${changed.length === 0 && flips.length === 0 ? "unchanged" : "changed"}** — C2, C3, C4, C5, C6, C8: ${bc.size} cells (hit, stale-hit, shared / disjoint, C3/C4 by variant and K, C5 author), ${changed.length} changed; ${flips.length} probes with a hit or stale-hit flip on a scored surface, ${unscoredFlips.length} on an unscored surface only (in no cell).`,
    );
    if (changed.length)
      parts.push(
        "",
        "| changed cell | before [n, hit %, …] | after |",
        "| --- | --- | --- |",
        ...changed.map((k) => `| ${k} | ${bc.get(k) ?? "–"} | ${ac.get(k) ?? "–"} |`),
      );
    const flipClasses = [...new Set([...flips, ...unscoredFlips].map((p) => p.class))].sort();
    if (flipClasses.length)
      parts.push(
        "",
        "| class | surface | hit + / − | stale-hit + / − |",
        "| --- | --- | ---: | ---: |",
        ...flipClasses.flatMap((cls) =>
          surfaces.map((s) => `| ${cls} | ${s}${unscored(cls, s) ? " (unscored)" : ""} | +${flipCount(cls, s, "hit", false)} / −${flipCount(cls, s, "hit", true)} | +${flipCount(cls, s, "staleHit", false)} / −${flipCount(cls, s, "staleHit", true)} |`),
        ),
      );

    // Payload: chars on both surfaces, per class.
    const classes = [...new Set(before.probes.map((p) => p.class))].sort();
    parts.push(
      "",
      "### Payload chars (sum over probes, before → after)",
      "",
      "| class | probes | proactive chars | proactive probes changed | asked chars | asked probes changed | asked probes now empty % |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...classes.map((cls) => {
        const ps = before.probes.filter((p) => p.class === cls && afterByKey.has(probeKey(p)));
        const sum = (rows: ProbeRow[], s: (typeof surfaces)[number]) => rows.reduce((t, p) => t + p[s].chars, 0);
        const qs = ps.map((p) => afterByKey.get(probeKey(p))!);
        const ch = (s: (typeof surfaces)[number]) => ps.filter((p) => afterByKey.get(probeKey(p))![s].chars !== p[s].chars).length;
        const emptyAfter = qs.filter((q) => q.asked.recallItems === 0).length;
        return `| ${cls} | ${ps.length} | ${sum(ps, "proactive")} → ${sum(qs, "proactive")} | ${ch("proactive")} | ${sum(ps, "asked")} → ${sum(qs, "asked")} | ${ch("asked")} | ${pct(emptyAfter, qs.length)} |`;
      }),
    );
  }
  return parts.join("\n") + "\n";
}


/**
 * Port 3 (MEMORY_TOMBSTONES): two runs that differ in that switch, side by
 * side, every figure computed from the files:
 *   - C2 (corrections) and C8 (expiry) hit and stale-hit by size and surface,
 *     and the components that carry the stale value;
 *   - null test 1 (`before` reproduces each reference run), with the probes
 *     that differ counted by class and by the components that changed;
 *   - every other class: changed cells, probe flips, and hits lost (a row the
 *     tombstones silenced that the probe needed);
 *   - payload chars per class.
 */
export function renderTombstoneCompare(pairs: ReadonlyArray<readonly [RunResult, RunResult]>, references: readonly RunResult[] = []): string {
  const surfaces = ["proactive", "asked"] as const;
  const target = (cls: string) => cls === "C2" || cls === "C8";
  const parts: string[] = [
    "# Port 3 — tombstones for corrected and expired facts: before / after",
    "",
    "Generated by `scripts/continuity-bench/run.ts --compare`; every figure below is computed from the result files named here. Method and limits: `benchmarks/continuity/README.md` §Tombstones.",
  ];
  for (const [before, after] of pairs) {
    parts.push(
      "",
      `## leg \`${before.meta.leg}\` · embeddings ${before.meta.embeddings} · corpus ${before.meta.corpusVersion}`,
      "",
      `- before: commit ${before.meta.commit}, switches ${switchText(before)}, run ${before.meta.startedAt}`,
      `- after: commit ${after.meta.commit}, switches ${switchText(after)}, run ${after.meta.startedAt}`,
    );
    if (before.meta.leg === "raw") {
      const scenarios = new Set(before.probes.map((p) => p.scenarioId)).size;
      const preSn = before.probes.some((p) => /-sn-s\d+$/.test(p.scenarioId)) ? "" : "pre-`sn`, ";
      parts.push(
        `- raw pair: ${scenarios} scenarios / ${before.probes.length.toLocaleString("en-US")} probes (${preSn}run ${before.meta.startedAt}); raw writes no tombstones, so \`on\` = \`off\` there.`,
      );
    }
    const afterByKey = new Map(after.probes.map((p) => [probeKey(p), p]));
    const sizes = [...new Set(after.probes.map((p) => p.fillerSize))].sort((a, b) => a - b);
    const agg = (r: RunResult, cls: string, size: number, surface: string) =>
      r.aggregates.find((a) => a.class === cls && a.fillerSize === size && a.surface === surface);
    const arrow = (b: number | null | undefined, a: number | null | undefined) => `${c(b)} → ${c(a)}`;

    parts.push(
      "",
      "### C2 and C8 by filler size",
      "",
      "| size | surface | C2 n | C2 hit % | C2 stale-hit % | C8 n | C8 hit % | C8 stale-hit % |",
      "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...sizes.flatMap((z) =>
        surfaces.map((s) => {
          const [b2, a2, b8, a8] = [agg(before, "C2", z, s), agg(after, "C2", z, s), agg(before, "C8", z, s), agg(after, "C8", z, s)];
          return `| ${z} | ${s} | ${a2?.n ?? 0} | ${arrow(b2?.hitPct, a2?.hitPct)} | ${arrow(b2?.staleHitPct, a2?.staleHitPct)} | ${a8?.n ?? 0} | ${arrow(b8?.hitPct, a8?.hitPct)} | ${arrow(b8?.staleHitPct, a8?.staleHitPct)} |`;
        }),
      ),
    );

    // Which component carries the stale value (a probe counts once per component).
    const carriers = (r: RunResult) => {
      const m = new Map<string, number>();
      for (const p of r.probes.filter((x) => target(x.class)))
        for (const s of surfaces)
          if (p[s].scored) for (const n of p[s].staleCarriedBy ?? []) m.set(`${p.class}|${p.fillerSize}|${s}|${n}`, (m.get(`${p.class}|${p.fillerSize}|${s}|${n}`) ?? 0) + 1);
      return m;
    };
    const [bk, ak] = [carriers(before), carriers(after)];
    const carrierKeys = [...new Set([...bk.keys(), ...ak.keys()])].sort();
    parts.push(
      "",
      "### Stale value carried by (scored probes, before → after)",
      "",
      "| class | size | surface | component | probes |",
      "| --- | ---: | --- | --- | ---: |",
      ...carrierKeys.map((k) => {
        const [cls, z, s, n] = k.split("|");
        return `| ${cls} | ${z} | ${s} | ${n} | ${bk.get(k) ?? 0} → ${ak.get(k) ?? 0} |`;
      }),
    );

    // Null test 1, with the differing probes counted by class and by changed component.
    parts.push("", "### Null tests", "", ...reproductionLines(before, references));
    for (const ref of references.filter((r) => r.meta.leg === before.meta.leg && r.meta.embeddings === before.meta.embeddings)) {
      const byKey = new Map(before.probes.map((p) => [probeKey(p), p]));
      const differ = ref.probes.filter((p) => byKey.has(probeKey(p)) && scoreFingerprint(p) !== scoreFingerprint(byKey.get(probeKey(p))!));
      if (differ.length === 0) continue;
      const byClass = new Map<string, number>();
      const fields = new Map<string, number>();
      for (const p of differ) {
        byClass.set(p.class, (byClass.get(p.class) ?? 0) + 1);
        const q = byKey.get(probeKey(p))!;
        for (const s of surfaces)
          for (const f of Object.keys(p[s]) as Array<keyof SurfaceScore>)
            if (f !== "ms" && JSON.stringify(p[s][f]) !== JSON.stringify(q[s][f])) fields.set(`${s}.${f}`, (fields.get(`${s}.${f}`) ?? 0) + 1);
      }
      const hitFlips = differ.filter((p) => surfaces.some((s) => p[s].hit !== byKey.get(probeKey(p))![s].hit || p[s].staleHit !== byKey.get(probeKey(p))![s].staleHit)).length;
      parts.push(
        `   - vs ${ref.meta.commit}: differing probes by class ${[...byClass].map(([k, n]) => `${k} ${n}`).join(", ")}; ${hitFlips} with a hit or stale-hit change; fields that changed: ${[...fields].map(([k, n]) => `${k} ${n}`).join(", ")}.`,
      );
      if (before.meta.leg === "ideal")
        parts.push(
          "   - why: the harness changed in Port 3, not the switch: with embeddings off a correction now supersedes its target through supersedeCluster in every mode (off included; it was plain-inserted before), so the corrected fact's JME components differ.",
        );
    }

    // Every class other than C2 / C8.
    const cellsOf = (r: RunResult) => {
      const m = new Map<string, string>();
      for (const a of r.aggregates.filter((x) => !target(x.class)))
        m.set(`${a.class} size ${a.fillerSize} ${a.surface}`, JSON.stringify([a.n, a.hitPct, a.staleHitPct, a.hitPctShared, a.hitPctDisjoint, a.authorMarkedPct]));
      for (const g of r.gapAggregates ?? []) m.set(`${g.class} ${g.variant} K ${c(g.gapRows)} other ${c(g.otherChannelRows ?? 0)} ${g.surface}`, JSON.stringify([g.n, g.hitPct, g.hitPctShared, g.hitPctDisjoint]));
      for (const a of r.authorAggregates ?? []) m.set(`C5 ${a.authorCase} size ${a.fillerSize} ${a.surface}`, JSON.stringify([a.n, a.hitPct, a.authorMarkedPct, a.authorMarkedAnyPct, a.attributionConflictPct]));
      return m;
    };
    const [bc, ac] = [cellsOf(before), cellsOf(after)];
    const changed = [...new Set([...bc.keys(), ...ac.keys()])].filter((k) => bc.get(k) !== ac.get(k));
    const others = before.probes.filter((p) => !target(p.class) && afterByKey.has(probeKey(p)));
    const flipCount = (rows: ProbeRow[], s: (typeof surfaces)[number], f: "hit" | "staleHit", from: boolean) =>
      rows.filter((p) => p[s][f] === from && afterByKey.get(probeKey(p))![s][f] !== from).length;
    const flipped = others.filter((p) => surfaces.some((s) => p[s].hit !== afterByKey.get(probeKey(p))![s].hit || p[s].staleHit !== afterByKey.get(probeKey(p))![s].staleHit));
    const lost = surfaces.reduce((t, s) => t + flipCount(others.filter((p) => p[s].scored), s, "hit", true), 0);
    const otherClasses = [...new Set(before.probes.map((p) => p.class))].filter((x) => !target(x)).sort();
    parts.push(
      `2. **${changed.length === 0 && flipped.length === 0 ? "unchanged" : "changed"}** — ${otherClasses.join(", ")}: ${bc.size} cells (hit, stale-hit, shared / disjoint, C3/C4 by variant and K, C5 author), ${changed.length} changed; ${flipped.length} probes with a hit or stale-hit flip; ${lost} scored hits lost (a needed row silenced).`,
    );
    if (changed.length)
      parts.push(
        "",
        "| changed cell | before [n, hit %, …] | after |",
        "| --- | --- | --- |",
        ...changed.map((k) => `| ${k} | ${bc.get(k) ?? "–"} | ${ac.get(k) ?? "–"} |`),
      );
    const flipClasses = [...new Set(flipped.map((p) => p.class))].sort();
    if (flipClasses.length)
      parts.push(
        "",
        "| class | surface | hit + / − | stale-hit + / − |",
        "| --- | --- | ---: | ---: |",
        ...flipClasses.flatMap((cls) => {
          const rows = others.filter((p) => p.class === cls);
          return surfaces.map((s) => `| ${cls} | ${s} | +${flipCount(rows, s, "hit", false)} / −${flipCount(rows, s, "hit", true)} | +${flipCount(rows, s, "staleHit", false)} / −${flipCount(rows, s, "staleHit", true)} |`);
        }),
      );

    // C2 / C8 hits lost: a correction or a durable fact the tombstones silenced.
    const targets = before.probes.filter((p) => target(p.class) && afterByKey.has(probeKey(p)));
    parts.push(
      "",
      "### C2 / C8 hits lost / gained (scored probes)",
      "",
      "| class | surface | hit lost | hit gained | stale-hit lost | stale-hit gained | first hit lost |",
      "| --- | --- | ---: | ---: | ---: | ---: | --- |",
      ...["C2", "C8"].flatMap((cls) =>
        surfaces.map((s) => {
          const rows = targets.filter((p) => p.class === cls && p[s].scored);
          const lostRows = rows.filter((p) => p[s].hit && !afterByKey.get(probeKey(p))![s].hit);
          return `| ${cls} | ${s} | ${lostRows.length} | ${flipCount(rows, s, "hit", false)} | ${flipCount(rows, s, "staleHit", true)} | ${flipCount(rows, s, "staleHit", false)} | ${lostRows.slice(0, 4).map(probeKey).join(", ") || "–"} |`;
        }),
      ),
    );

    // Payload: chars on both surfaces, per class.
    const classes = [...new Set(before.probes.map((p) => p.class))].sort();
    parts.push(
      "",
      "### Payload chars (sum over probes, before → after)",
      "",
      "| class | probes | proactive chars | proactive probes changed | asked chars | asked probes changed |",
      "| --- | ---: | ---: | ---: | ---: | ---: |",
      ...classes.map((cls) => {
        const ps = before.probes.filter((p) => p.class === cls && afterByKey.has(probeKey(p)));
        const qs = ps.map((p) => afterByKey.get(probeKey(p))!);
        const sum = (rows: ProbeRow[], s: (typeof surfaces)[number]) => rows.reduce((t, p) => t + p[s].chars, 0);
        const ch = (s: (typeof surfaces)[number]) => ps.filter((p) => afterByKey.get(probeKey(p))![s].chars !== p[s].chars).length;
        return `| ${cls} | ${ps.length} | ${sum(ps, "proactive")} → ${sum(qs, "proactive")} | ${ch("proactive")} | ${sum(ps, "asked")} → ${sum(qs, "asked")} | ${ch("asked")} |`;
      }),
    );
  }
  return parts.join("\n") + "\n";
}

/** Component name → item cap, from what the runs returned (null = a component with no count cap). */
export function capsOf(runs: readonly ProbeRun[]): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const r of runs)
    for (const s of [r.proactive, r.asked]) for (const comp of s.components) if (comp.queryDriven) out[comp.name] = comp.cap ?? null;
  return out;
}

/** Result-file name part for the switches that differ from their defaults ("" when none do). */
export function switchSuffix(switches: Readonly<Record<string, string>>, defaults: Readonly<Record<string, string>>): string {
  return Object.entries(switches)
    .filter(([name, value]) => defaults[name] !== value)
    .map(([name, value]) => `-${name.toLowerCase().replace(/_/g, "-")}-${value}`)
    .join("");
}

/** The default result file name; the extracted leg's also names its classes and window (`-c6-day`). */
export function resultFileName(r: {
  commit: string;
  leg: string;
  embeddings: string;
  suffix: string;
  switchTag: string;
  classes: string[] | null;
  window: ExtractionWindow;
  dryRun: boolean;
}): string {
  const extractionTag = r.leg === "extracted" ? `-${(r.classes ?? []).map((k) => k.toLowerCase()).join("")}-${r.window}` : "";
  return `jarvis-${r.commit}-${r.leg}-emb-${r.embeddings}${r.suffix}${r.switchTag}${extractionTag}${r.dryRun ? "-dry-run" : ""}.json`;
}

/** Returns the exit code: 0 done, 2 refused, 3 stopped at the embedding or model-call cap. */
export async function main(argv: readonly string[] = process.argv, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  requireOperatorContext("continuity-bench", { tty: false });
  const args = parseArgs(argv);

  if (args.mode === "report") {
    const results = args.report.map((p) => JSON.parse(readFileSync(resolve(p), "utf8")) as RunResult);
    writeFileSync(resolve(args.md), renderBaseline(results));
    console.log(`wrote ${args.md}`);
    return 0;
  }
  if (args.mode === "compare") {
    const load = (p: string) => JSON.parse(readFileSync(resolve(p), "utf8")) as RunResult;
    const runs = args.compare.map(load);
    const pairs: Array<[RunResult, RunResult]> = [];
    for (let i = 0; i < runs.length; i += 2) pairs.push([runs[i], runs[i + 1]]);
    const differs = (name: string) => pairs.some(([b, a]) => (b.meta.switches?.[name] ?? "off") !== (a.meta.switches?.[name] ?? "off"));
    const extractedPair = pairs.some(([b, a]) => b.meta.leg === "extracted" || a.meta.leg === "extracted");
    const render = extractedPair
      ? renderExtractionCompare
      : differs("MEMORY_TOMBSTONES")
        ? renderTombstoneCompare
        : differs("MEMORY_RECALL_FLOOR")
          ? renderRecallFloorCompare
          : renderCompare;
    writeFileSync(resolve(args.md), render(pairs, args.reference.map(load)));
    console.log(`wrote ${args.md}`);
    return 0;
  }

  const refused = refuseReason(env, args.allowEmbeddings) ?? (args.leg === "extracted" ? extractionRefusal(args, env) : null);
  if (refused) {
    console.error(`[continuity-bench] refusing: ${refused}`);
    return 2;
  }
  const embeddings = args.allowEmbeddings && (env.GEMINI_API_KEY || env.EMBEDDING_KEY) ? "on" : "off";
  const { leg, sizes, classes } = args;
  const corpus = JSON.parse(readFileSync(args.corpus, "utf8")) as Corpus;
  const commit = shortSha();
  const suffix = corpus.version === "continuity-v1" ? "" : `-${corpus.version.replace("continuity-", "")}`;
  const { DEFAULT_SWITCHES, resolveSwitches } = await import("./adapter-jarvis.js");
  const switches = resolveSwitches(args.switches);
  const out =
    args.out ??
    join(ROOT, "benchmarks/continuity/results", resultFileName({ commit, leg, embeddings, suffix, switchTag: switchSuffix(switches, DEFAULT_SWITCHES), classes, window: args.window, dryRun: args.dryRun }));

  // Scratch only: a fresh directory under TMPDIR, removed at exit.
  const scratch = mkdtempSync(join(tmpdir(), "continuity-bench-"));
  const cleanup = () => rmSync(scratch, { recursive: true, force: true });
  process.on("exit", cleanup);
  process.env.JARVIS_KB_MIRROR_DIR ??= join(scratch, "kbmirror");

  const { EmbedCache, JARVIS_MARKERS, EXTRACTION_MODEL_ID, JarvisAdapter, ModelCallBudget, ModelCallCapError, exchangeContent, scratchDbPath } = await import("./adapter-jarvis.js");
  const cache = new EmbedCache(embeddings === "on" ? (args.embedCache ?? join(scratch, "embed-cache.jsonl")) : null);
  let plan: EmbedPlan | null = null;
  const meter = new FetchMeter(args.maxEmbedCalls);
  if (embeddings === "on") {
    plan = embedPlan(corpus, sizes, leg === "ideal" ? "ideal" : "raw", exchangeContent, (t) => cache.has(t));
    console.log(`[continuity-bench] ${describePlan(plan)}`);
    const over = embedBudgetRefusal(plan, args.maxEmbedCalls);
    if (over) {
      console.error(`[continuity-bench] refusing: ${over}`);
      cleanup();
      return 2;
    }
    meter.install();
  }

  // The memory stack logs per recall; keep the run's own output readable.
  const log = console.log.bind(console);
  const quiet = () => {};
  console.log = quiet;
  console.warn = quiet;
  console.info = quiet;

  // A dry run counts every call it would make; only a real run is capped.
  const budget = new ModelCallBudget(args.dryRun ? Number.POSITIVE_INFINITY : args.maxModelCalls);
  const adapter = new JarvisAdapter(scratchDbPath(scratch), leg, {
    embeddings: embeddings === "on",
    embedCache: cache,
    switches,
    ...(leg === "extracted" ? { extraction: { budget, dryRun: args.dryRun, window: args.window } } : {}),
  });
  adapter.open();
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const runs: ProbeRun[] = [];
  try {
    for (const size of sizes) {
      const t0 = performance.now();
      const scenarios = corpus.scenarios.filter((s) => s.fillerSize === size && (!classes || classes.includes(s.class)));
      if (scenarios.length === 0) throw new Error(`corpus has no scenarios at size ${size}${classes ? ` in ${classes.join(",")}` : ""}`);
      for (const s of scenarios) {
        try {
          runs.push(...(await adapter.runScenario(s, corpus.fillerSpec)));
        } catch (err) {
          if (err instanceof ModelCallCapError) {
            console.error(`[continuity-bench] stopped: ${err.calls} model calls made, cap ${err.max} reached before the next call in ${err.scenarioId}; no result written`);
            return 3;
          }
          if (!meter.exceeded) throw err; // e.g. the embed cache's consecutive-failure stop
        }
        const x = leg === "extracted" ? adapter.extractions.at(-1) : undefined;
        if (x)
          log(`[continuity-bench] extracted ${s.id} (window ${windowLabel(args.window)}): ${budget.calls} model calls so far${args.dryRun ? " (dry run, none made)" : ` of ${args.maxModelCalls}`}; turns ${x.turns}, inserted ${x.inserted}, caught ${x.caught ? "yes" : "no"}, failed calls ${x.failedCalls}`);
        if (meter.exceeded) {
          console.error(`[continuity-bench] stopped: ${meter.calls} embedding calls made, cap ${args.maxEmbedCalls} reached in ${s.id}; no result written`);
          return 3;
        }
      }
      log(`[continuity-bench] leg=${leg} size=${size}: ${scenarios.length} scenarios in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    }
  } finally {
    adapter.close();
    meter.restore();
  }

  const scores = runs.map((r) => scoreProbeWith(r, JARVIS_MARKERS));
  const result: RunResult = {
    meta: {
      system: "jarvis",
      commit,
      leg,
      embeddings,
      corpusVersion: corpus.version,
      sizes,
      startedAt,
      durationMs: Math.round(performance.now() - started),
      notes: leg === "extracted" ? [...NOTES, EXTRACTED_NOTE] : NOTES,
      markers: JARVIS_MARKERS,
      switches: { ...adapter.switches },
      ...(classes ? { classes } : {}),
      ...(leg === "extracted"
        ? { extraction: { mode: args.dryRun ? ("dry-run" as const) : ("run" as const), calls: budget.calls, maxModelCalls: args.maxModelCalls, model: EXTRACTION_MODEL_ID, window: args.window } }
        : {}),
      ...(embeddings === "on"
        ? {
            embed: {
              uniqueRowTexts: cache.size,
              rowCalls: cache.calls,
              rowCacheHits: cache.hits,
              rowFailures: cache.failures,
              fetches: meter.calls,
              ...(plan ? { plan } : {}),
            },
          }
        : {}),
    },
    ingest: ingestStats(runs),
    aggregates: aggregate(scores),
    probes: scores.map((s, i) => ({
      ...s,
      text: runs[i].probe.text,
      components: {
        proactive: runs[i].proactive.components.map((comp) => `${comp.name}:${comp.items.length}`),
        asked: runs[i].asked.components.map((comp) => `${comp.name}:${comp.items.length}`),
      },
      ...(runs[i].proactive.dropped ? { dropped: runs[i].proactive.dropped } : {}),
    })),
    gapAggregates: aggregateByGap(scores),
    authorAggregates: aggregateAuthor(scores),
    caps: capsOf(runs),
    ...(leg === "extracted" ? { extraction: adapter.extractions } : {}),
  };
  writeFileSync(out, JSON.stringify(result, null, 1) + "\n");
  log(markdownTable(result.aggregates));
  log(`[continuity-bench] wrote ${out} (${(result.meta.durationMs / 1000).toFixed(1)} s)`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
