/**
 * Continuity Scorecard — runner (offline, no LLM, scratch db only).
 *
 *   npx tsx scripts/continuity-bench/run.ts --leg raw --sizes 50,500 \
 *     [--corpus benchmarks/continuity/corpus-v2.json] [--out <json>]
 *     [--allow-embeddings [--max-embed-calls 3000] [--embed-cache <file under TMPDIR>]]
 *   npx tsx scripts/continuity-bench/run.ts --report <a.json,b.json,...> --md <out.md>
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
import type { Corpus, CorpusEvent, ProbeRun, ProbeScore } from "./types.js";
import { CLASS_LABELS } from "./types.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface RunResult {
  meta: {
    system: "jarvis";
    commit: string;
    leg: "raw" | "ideal";
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
}

const NOTES = [
  "No model in the loop: scores what REACHES the model, not what it answers.",
  "Embeddings off is the HARNESS configuration (no key, no network): every recall falls back to SQLite FTS5 / LIKE. A keyed production instance also ranks by vectors, supersedes JME facts and runs temporal dedup.",
  "raw leg = conversations rows only; ideal leg adds perfect extraction to jme_facts (upsertFact) and user_facts (user_fact_set).",
  "Thread: `hydrate` probes read a thread key this process never used (`telegram:p<n>`, same base channel, so the router hydrates the newest 15 rows); C3 `live` pushes the timeline through the router's push seam into an already-held thread; C4 restarts for real (db reopened, router module re-imported, caches and backend reset).",
  "Profile, relevant facts and enrichment pass through the production prompt budget (buildJarvisSystemPrompt with CORE_TOOLS, owner channel); a dropped block is listed under `dropped` and is not in the payload. Production passes CORE_TOOLS plus the scoped groups' tools, whose sections take more room, so the dropped count is a lower bound.",
  "Proactive ms is the sequential sum of the components; production runs enrichment and the scope classifier in parallel.",
  "JME block text replicates the fast-runner template (fast-runner.ts:1126-1139, pinned by a test); the facts come from the real queryMemory/orderForInjection.",
];

export function refuseReason(env: NodeJS.ProcessEnv, allowEmbeddings: boolean): string | null {
  if (env.COMMIT_DB_KEY) return "COMMIT_DB_KEY is set (pgvector reads and writes a live remote store) — refused even with --allow-embeddings";
  if (allowEmbeddings) return null;
  const set = ["GEMINI_API_KEY", "EMBEDDING_KEY"].filter((k) => env[k]);
  if (env.HINDSIGHT_ENABLED === "true") set.push("HINDSIGHT_ENABLED=true");
  return set.length ? `${set.join(", ")} set — pass --allow-embeddings to run with embeddings` : null;
}

export type CliArgs =
  | { mode: "report"; report: string[]; md: string }
  | {
      mode: "run";
      leg: "raw" | "ideal";
      sizes: number[];
      corpus: string;
      out: string | null;
      allowEmbeddings: boolean;
      maxEmbedCalls: number;
      embedCache: string | null;
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
  const allowEmbeddings = argv.includes("--allow-embeddings");
  const leg = (arg("--leg") ?? "raw") as "raw" | "ideal";
  if (leg !== "raw" && leg !== "ideal") throw new Error("--leg must be raw or ideal");
  const sizes = (arg("--sizes") ?? "50,500").split(",").map((s) => parseInt(s, 10));
  if (sizes.some((n) => !Number.isInteger(n) || n < 0)) throw new Error("--sizes must be a comma list of integers");
  const maxEmbedCalls = parseInt(arg("--max-embed-calls") ?? "3000", 10);
  if (!Number.isInteger(maxEmbedCalls) || maxEmbedCalls < 0) throw new Error("--max-embed-calls must be a non-negative integer");
  return {
    mode: "run",
    leg,
    sizes,
    corpus: resolve(arg("--corpus") ?? join(ROOT, "benchmarks/continuity/corpus-v1.json")),
    out: arg("--out") ? resolve(arg("--out")!) : null,
    allowEmbeddings,
    maxEmbedCalls,
    embedCache: arg("--embed-cache") ? resolve(arg("--embed-cache")!) : null,
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
      `## leg \`${r.meta.leg}\` · embeddings ${r.meta.embeddings} · commit ${r.meta.commit} · corpus ${r.meta.corpusVersion}`,
      "",
      `Run ${r.meta.startedAt}, ${(r.meta.durationMs / 1000).toFixed(1)} s.`,
      "",
    );
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

/** Component name → item cap, from what the runs returned (null = a component with no count cap). */
export function capsOf(runs: readonly ProbeRun[]): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const r of runs)
    for (const s of [r.proactive, r.asked]) for (const comp of s.components) if (comp.queryDriven) out[comp.name] = comp.cap ?? null;
  return out;
}

/** Returns the exit code: 0 done, 2 refused, 3 stopped at the embedding cap. */
export async function main(argv: readonly string[] = process.argv, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  requireOperatorContext("continuity-bench", { tty: false });
  const args = parseArgs(argv);

  if (args.mode === "report") {
    const results = args.report.map((p) => JSON.parse(readFileSync(resolve(p), "utf8")) as RunResult);
    writeFileSync(resolve(args.md), renderBaseline(results));
    console.log(`wrote ${args.md}`);
    return 0;
  }

  const refused = refuseReason(env, args.allowEmbeddings);
  if (refused) {
    console.error(`[continuity-bench] refusing: ${refused}`);
    return 2;
  }
  const embeddings = args.allowEmbeddings && (env.GEMINI_API_KEY || env.EMBEDDING_KEY) ? "on" : "off";
  const { leg, sizes } = args;
  const corpus = JSON.parse(readFileSync(args.corpus, "utf8")) as Corpus;
  const commit = shortSha();
  const suffix = corpus.version === "continuity-v1" ? "" : `-${corpus.version.replace("continuity-", "")}`;
  const out = args.out ?? join(ROOT, `benchmarks/continuity/results/jarvis-${commit}-${leg}-emb-${embeddings}${suffix}.json`);

  // Scratch only: a fresh directory under TMPDIR, removed at exit.
  const scratch = mkdtempSync(join(tmpdir(), "continuity-bench-"));
  const cleanup = () => rmSync(scratch, { recursive: true, force: true });
  process.on("exit", cleanup);
  process.env.JARVIS_KB_MIRROR_DIR ??= join(scratch, "kbmirror");

  const { EmbedCache, JARVIS_MARKERS, JarvisAdapter, exchangeContent, scratchDbPath } = await import("./adapter-jarvis.js");
  const cache = new EmbedCache(embeddings === "on" ? (args.embedCache ?? join(scratch, "embed-cache.jsonl")) : null);
  let plan: EmbedPlan | null = null;
  const meter = new FetchMeter(args.maxEmbedCalls);
  if (embeddings === "on") {
    plan = embedPlan(corpus, sizes, leg, exchangeContent, (t) => cache.has(t));
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

  const adapter = new JarvisAdapter(scratchDbPath(scratch), leg, { embeddings: embeddings === "on", embedCache: cache });
  adapter.open();
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const runs: ProbeRun[] = [];
  try {
    for (const size of sizes) {
      const t0 = performance.now();
      const scenarios = corpus.scenarios.filter((s) => s.fillerSize === size);
      if (scenarios.length === 0) throw new Error(`corpus has no scenarios at size ${size}`);
      for (const s of scenarios) {
        try {
          runs.push(...(await adapter.runScenario(s, corpus.fillerSpec)));
        } catch (err) {
          if (!meter.exceeded) throw err; // e.g. the embed cache's consecutive-failure stop
        }
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
      notes: NOTES,
      markers: JARVIS_MARKERS,
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
