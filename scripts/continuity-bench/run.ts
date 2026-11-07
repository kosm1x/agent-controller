/**
 * Continuity Scorecard — runner (offline, no LLM, scratch db only).
 *
 *   npx tsx scripts/continuity-bench/run.ts --leg raw --sizes 50,500 \
 *     [--corpus benchmarks/continuity/corpus-v2.json] [--out <json>]
 *     [--allow-embeddings [--max-embed-calls 3000] [--embed-cache <file under TMPDIR>]]
 *     [--switch MEMORY_OPEN_WORK=on ...]
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
    /** Production switch states this run set in its process (absent on results from before switches existed = all off). */
    switches?: Record<string, string>;
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
  | { mode: "compare"; compare: string[]; reference: string[]; md: string }
  | {
      mode: "run";
      leg: "raw" | "ideal";
      sizes: number[];
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
      `## leg \`${r.meta.leg}\` · embeddings ${r.meta.embeddings} · commit ${r.meta.commit} · corpus ${r.meta.corpusVersion}${r.meta.switches ? ` · switches ${switchText(r)}` : ""}`,
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
  const verdict = (ok: boolean) => (ok ? "PASS" : "FAIL");
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
    parts.push("", "### Null tests", "");
    const refs = references.filter((r) => r.meta.leg === before.meta.leg && r.meta.embeddings === before.meta.embeddings);
    if (refs.length === 0) parts.push("1. Reproduction: no reference run for this leg — not checked.");
    for (const ref of refs) {
      const beforeByKey = new Map(before.probes.map((p) => [probeKey(p), p]));
      const missing = ref.probes.filter((p) => !beforeByKey.has(probeKey(p))).length;
      const differ = ref.probes.filter((p) => beforeByKey.has(probeKey(p)) && scoreFingerprint(p) !== scoreFingerprint(beforeByKey.get(probeKey(p))!));
      parts.push(
        `1. **${verdict(missing === 0 && differ.length === 0)}** — before reproduces reference commit ${ref.meta.commit} (switches ${switchText(ref)}) on its ${ref.probes.length} probes: ${differ.length} differ, ${missing} missing (timings excluded)${differ.length ? `; first: ${differ.slice(0, 5).map(probeKey).join(", ")}` : ""}.`,
      );
    }

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
  if (args.mode === "compare") {
    const load = (p: string) => JSON.parse(readFileSync(resolve(p), "utf8")) as RunResult;
    const runs = args.compare.map(load);
    const pairs: Array<[RunResult, RunResult]> = [];
    for (let i = 0; i < runs.length; i += 2) pairs.push([runs[i], runs[i + 1]]);
    writeFileSync(resolve(args.md), renderCompare(pairs, args.reference.map(load)));
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
  const { DEFAULT_SWITCHES, resolveSwitches } = await import("./adapter-jarvis.js");
  const switches = resolveSwitches(args.switches);
  const out =
    args.out ??
    join(ROOT, `benchmarks/continuity/results/jarvis-${commit}-${leg}-emb-${embeddings}${suffix}${switchSuffix(switches, DEFAULT_SWITCHES)}.json`);

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

  const adapter = new JarvisAdapter(scratchDbPath(scratch), leg, { embeddings: embeddings === "on", embedCache: cache, switches });
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
      switches: { ...adapter.switches },
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
