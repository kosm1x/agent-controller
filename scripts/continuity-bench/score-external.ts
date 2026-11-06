/**
 * Continuity Scorecard — score surfaces produced by an EXTERNAL adapter
 * (another system's own process, e.g. benchmarks/continuity/adapters/mnemos)
 * with the same scorer the Jarvis runner uses (score.ts), and put results of
 * two systems side by side.
 *
 *   npx tsx scripts/continuity-bench/score-external.ts --in <surfaces.json> --out <result.json> \
 *       [--markers <spec.json>] [--corpus <corpus.json>]
 *   npx tsx scripts/continuity-bench/score-external.ts --report <a.json,b.json> --md <out.md> --title "<system>"
 *   npx tsx scripts/continuity-bench/score-external.ts --compare <a.json,b.json,...> --md <out.md>
 *
 * Input: `{ meta: { system, commit, leg, embeddings, ... }, runs: ProbeRun[] }`.
 * Output: the input's meta and runs (kept as `surfaces`) plus the same
 * `ingest` / `aggregates` / `probes` / `gapAggregates` / `authorAggregates`
 * fields run.ts writes. `--compare` reads any mix of these and run.ts results.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireOperatorContext } from "../../src/lib/operator-gate.js";
import {
  aggregate,
  aggregateAuthor,
  aggregateByGap,
  DEFAULT_MARKERS,
  ingestStats,
  scoreProbeWith,
  withScenarioMeta,
  type Aggregate,
  type AuthorAggregate,
  type AuthorMarkerSpec,
  type GapAggregate,
  type IngestStat,
} from "./score.js";
import type { Corpus, ProbeRun, ProbeScore } from "./types.js";
import { CLASS_LABELS, SCENARIO_CLASSES } from "./types.js";

export interface ExternalSurfaces {
  meta: { system: string; commit: string; leg: string; embeddings: string; durationMs?: number; [k: string]: unknown };
  runs: ProbeRun[];
}

export interface ExternalResult {
  meta: ExternalSurfaces["meta"] & { scoredBy: string; markers: AuthorMarkerSpec };
  ingest: IngestStat[];
  aggregates: Aggregate[];
  gapAggregates: GapAggregate[];
  authorAggregates: AuthorAggregate[];
  /** Per surface, query-driven component name → item cap (null = no count cap). */
  caps: Record<"proactive" | "asked", Record<string, number | null>>;
  probes: Array<ProbeScore & { text: string; components: { proactive: string[]; asked: string[] } }>;
  surfaces: ProbeRun[];
}

/** What --compare needs from a result file (run.ts RunResult or ExternalResult). */
export interface Comparable {
  meta: { system: string; leg: string; commit: string; embeddings: string };
  probes: ProbeScore[];
}

/** Throws unless `doc` has the shape the scorer reads. */
export function assertSurfaces(doc: unknown): asserts doc is ExternalSurfaces {
  const d = doc as Partial<ExternalSurfaces> | null;
  if (!d || typeof d !== "object" || !d.meta || !Array.isArray(d.runs)) throw new Error("expected { meta, runs[] }");
  for (const [i, r] of d.runs.entries()) {
    for (const s of [r?.proactive, r?.asked]) {
      if (!s || typeof s.measurable !== "boolean" || !Array.isArray(s.components) || typeof s.ms !== "number")
        throw new Error(`runs[${i}]: surface needs { measurable, components[], ms }`);
      for (const c of s.components)
        if (typeof c.text !== "string" || !Array.isArray(c.items) || typeof c.queryDriven !== "boolean")
          throw new Error(`runs[${i}]: component needs { name, queryDriven, text, items[] }`);
    }
    if (!r.probe || !Array.isArray(r.probe.expect) || !Array.isArray(r.probe.forbid))
      throw new Error(`runs[${i}]: probe needs expect[] and forbid[]`);
  }
}

export function scoreExternal(doc: ExternalSurfaces, markers: AuthorMarkerSpec = DEFAULT_MARKERS, corpus?: Corpus): ExternalResult {
  const runs = corpus ? withScenarioMeta(doc.runs, corpus) : doc.runs;
  const scores = runs.map((r) => scoreProbeWith(r, markers));
  const caps: ExternalResult["caps"] = { proactive: {}, asked: {} };
  for (const r of runs)
    for (const surface of ["proactive", "asked"] as const)
      for (const c of r[surface].components) if (c.queryDriven) caps[surface][c.name] = c.cap ?? null;
  return {
    meta: { ...doc.meta, scoredBy: "scripts/continuity-bench/score.ts (scoreProbeWith, aggregate, aggregateByGap, aggregateAuthor)", markers },
    ingest: ingestStats(runs),
    aggregates: aggregate(scores),
    gapAggregates: aggregateByGap(scores),
    authorAggregates: aggregateAuthor(scores),
    caps,
    probes: scores.map((s, i) => ({
      ...s,
      text: runs[i].probe.text,
      components: {
        proactive: runs[i].proactive.components.map((c) => `${c.name}:${c.items.length}`),
        asked: runs[i].asked.components.map((c) => `${c.name}:${c.items.length}`),
      },
    })),
    surfaces: runs,
  };
}

const c = (v: number | null | undefined) => (v === null || v === undefined ? "–" : `${v}`);
const ms1 = (v: number | null | undefined) => (v === null || v === undefined ? "–" : v.toFixed(1));

const COLUMNS =
  "Columns: hit % = every expect needle reached the surface; shared / disjoint = the probe does / does not share a content word with its target under the documented neutral stop-word list (README §Wording); stale-hit % = a forbid needle reached it; carried = share of hits whose needle sat in a thread / recall / ambient component (not exclusive).";

function mainTable(rows: readonly Aggregate[]): string {
  const head =
    "| class | size | surface | n | hit % | hit % shared (n) | hit % disjoint (n) | stale-hit % | carried: thread / recall / ambient % | median chars | median ms |\n" +
    "| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |";
  const body = rows
    .filter((r) => !["C3", "C4", "C7"].includes(r.class))
    .map((r) =>
      r.n === 0
        ? `| ${r.class} ${r.label} | ${r.fillerSize} | ${r.surface} | 0 | not scored (${r.notScored ?? 0}) | | | | | | |`
        : `| ${r.class} ${r.label} | ${r.fillerSize} | ${r.surface} | ${r.n} | ${c(r.hitPct)} | ${c(r.hitPctShared)} (${r.nShared ?? 0}) | ${c(r.hitPctDisjoint)} (${r.nDisjoint ?? 0}) | ${c(r.staleHitPct)} | ${c(r.carriedThreadPct)} / ${c(r.carriedRecallPct)} / ${c(r.carriedAmbientPct)} | ${c(r.medianChars)} | ${ms1(r.medianMs)} |`,
    );
  return [head, ...body].join("\n");
}

function gapTable(rows: readonly GapAggregate[]): string {
  const head =
    "| class | variant | K | other-channel rows | surface | n | hit % | hit % shared | hit % disjoint | carried: thread % | carried: recall % |\n" +
    "| --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |";
  const body = rows.map((r) =>
    r.n === 0
      ? `| ${r.class} | ${r.variant} | ${c(r.gapRows)} | ${c(r.otherChannelRows ?? 0)} | ${r.surface} | 0 | not scored (${r.notScored}) | | | | |`
      : `| ${r.class} | ${r.variant} | ${c(r.gapRows)} | ${c(r.otherChannelRows ?? 0)} | ${r.surface} | ${r.n} | ${c(r.hitPct)} | ${c(r.hitPctShared)} | ${c(r.hitPctDisjoint)} | ${c(r.carriedThreadPct)} | ${c(r.carriedRecallPct)} |`,
  );
  return [head, ...body].join("\n");
}

function authorTable(rows: readonly AuthorAggregate[]): string {
  const head =
    "| author case | size | surface | n | hit % | author-marked % (strict) | author-marked % (with default role) | author-marked % (any occurrence) | attribution conflict % |\n" +
    "| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |";
  const body = rows.map((r) =>
    r.n === 0
      ? `| ${r.authorCase} | ${r.fillerSize} | ${r.surface} | 0 | not scored (${r.notScored}) | | | | |`
      : `| ${r.authorCase} | ${r.fillerSize} | ${r.surface} | ${r.n} | ${c(r.hitPct)} | ${c(r.authorMarkedPct)} | ${c(r.authorMarkedWithDefaultPct)} | ${c(r.authorMarkedAnyPct)} | ${c(r.attributionConflictPct)} |`,
  );
  return [head, ...body].join("\n");
}

function c7Table(rows: readonly Aggregate[], caps: ExternalResult["caps"]): string {
  const head =
    "| size | surface | C1 hit % (same run) | C7 n | C7 hit % | C7 mean irrelevant | C7 hit % shared / disjoint | result cap |\n" +
    "| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |";
  const capText = (surface: "proactive" | "asked") =>
    Object.entries(caps[surface]).map(([n, v]) => `${n} ${v ?? "no count cap"}`).join(", ") || "–";
  const body = rows
    .filter((r) => r.class === "C7")
    .map((r) => {
      const c1 = rows.find((x) => x.class === "C1" && x.fillerSize === r.fillerSize && x.surface === r.surface);
      if (r.n === 0) return `| ${r.fillerSize} | ${r.surface} | ${c(c1?.hitPct)} | 0 | not scored (${r.notScored ?? 0}) | | | |`;
      return `| ${r.fillerSize} | ${r.surface} | ${c(c1?.hitPct)} | ${r.n} | ${c(r.hitPct)} | ${c(r.meanIrrelevant)} | ${c(r.hitPctShared)} / ${c(r.hitPctDisjoint)} | ${capText(r.surface)} |`;
    });
  return [head, ...body].join("\n");
}

/** v2 baseline layout (the sections of results/jarvis-baseline-v2.md) for an external system. */
export function renderReport(title: string, results: ExternalResult[]): string {
  const version = String(results[0]?.meta.corpusVersion ?? "continuity-v2");
  const parts: string[] = [
    `# Continuity Scorecard — ${title} baseline (${version})`,
    "",
    `Generated by \`scripts/continuity-bench/score-external.ts --report\` from surfaces an external adapter produced. Corpus \`benchmarks/continuity/corpus-${version.replace("continuity-", "")}.json\`; method and limits in \`benchmarks/continuity/README.md\`.`,
    "",
    "Classes: " + Object.entries(CLASS_LABELS).map(([k, v]) => `${k} ${v}`).join(" · ") + ".",
    "",
    "Caveats:",
    "",
    "- **C3/C4** — the filler sits before the session, so the size axis says nothing about the thread; the axis is K, the primary-channel exchanges between the session end and the probe.",
    "- **C7** — 100 % means the recall returned nothing for a topic that never came up. An empty or broken adapter also scores 100 %, so C7 is shown only beside C1 from the same run, with the result cap.",
    '- **Not scored** — a surface an adapter declares unmeasurable is shown as "not scored", never dropped.',
    "",
    COLUMNS,
  ];
  const notes = notesFor(results);
  if (notes.length) parts.push("", "Notes:", "", ...notes.map((n) => `- ${n}`));
  for (const r of results) {
    const secs = typeof r.meta.durationMs === "number" ? `${(r.meta.durationMs / 1000).toFixed(1)} s` : "duration not recorded";
    parts.push(
      "",
      `## leg \`${r.meta.leg}\` · embeddings ${r.meta.embeddings} · commit ${r.meta.commit} · corpus ${String(r.meta.corpusVersion ?? "?")}`,
      "",
      `Run ${String(r.meta.startedAt ?? "?")}, ${secs}.`,
      "",
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
      "Strict: some surfaced occurrence of the figure is attributed to the expected author, and every occurrence is attributed (line marker → item marker → block heading) to a role that stated it in the events (`statedBy`). With default role: the same rule, an occurrence no marker attributes counted as the marker spec's `defaultRole` (shown only when the spec sets one; never part of the strict figure). Any occurrence: the v1 rule.",
      "",
      authorTable(r.authorAggregates),
      "",
      "### C7 nothing-to-recall, beside C1 from the same run",
      "",
      c7Table(r.aggregates, r.caps),
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

// ---------------------------------------------------------------------------
// Side by side
// ---------------------------------------------------------------------------

/** The filler sizes of corpus-v2 (README §Classes). */
const V2_FILLER_SIZES = [50, 500, 5000];

/** Notes that hold for one system's results, keyed by `meta.system`. */
export const SYSTEM_NOTES: Record<string, string[]> = {
  mnemos: [
    "mnemos `raw` is 0 everywhere because mnemos writes nothing by itself: it has no automatic capture, and neither installed hook stores a memory.",
    "mnemos C3/C4: the hits come from the session-end hand-off in the wake packet. mnemos shows the newest hand-off plus any others no older than 72 h (`LIVE_HANDOFF_HOURS`), and hand-offs sit outside the 8,000-char packet budget, so nothing evicts them. In these timelines the open-work hand-off is the only one (the later gap session ends without writing one), which is why K has no effect. A newer hand-off on another topic, with the open-work note older than 72 h at the probe, would hide it; the corpus has no such case.",
    "mnemos C3 `live` scores the packet delivered at session start and assumes the host keeps it in context; mnemos does not hold the conversation itself.",
    'mnemos\'s strict who-said-it is 0 on the assistant cases because it marks only the person\'s words. The "with default role" column is the reading under its own convention (an unmarked memory is the agent\'s own).',
  ],
};

/** The notes of every system present that has notes, then one line per such system on what was not measured. */
export function notesFor(results: ReadonlyArray<{ meta: { system: string; embeddings: string }; probes: ReadonlyArray<{ fillerSize: number }> }>): string[] {
  const systems = [...new Set(results.map((r) => r.meta.system))].filter((s) => s in SYSTEM_NOTES);
  const out = systems.flatMap((s) => SYSTEM_NOTES[s] ?? []);
  for (const s of systems) {
    const mine = results.filter((r) => r.meta.system === s);
    const have = new Set(mine.flatMap((r) => r.probes.map((p) => p.fillerSize)));
    const missing = V2_FILLER_SIZES.filter((n) => !have.has(n));
    const what = [
      ...(missing.length ? [`filler sizes ${missing.join(" and ")}`] : []),
      ...(mine.every((r) => r.meta.embeddings === "off") ? ["embeddings (every leg in these results ran with embeddings off)"] : []),
    ];
    if (what.length) out.push(`Not measured for ${s}: ${what.join(", and ")}.`);
  }
  return out;
}

export const COMPARISON_NOTES = [
  "Keyword search only on both sides: every run here has embeddings off (no key, no model download, no network).",
  "The mnemos legs are a best case: the adapter saves what each leg says the agent was told to save (`ideal-selective`: the extracted facts, standing preferences, corrections and session-end hand-offs; `ideal-full`: also every turn), through mnemos's own write methods. Jarvis `raw` is automatic: it stores the conversation rows with no model in the loop; Jarvis `ideal` adds perfect extraction.",
  "Latency is NOT comparable: mnemos ran in a 1.5-CPU container, Jarvis on the host; median ms columns are left out on purpose.",
  "No model in the loop on either side: the figures say what REACHES the model, not what it answers.",
];

interface Leg {
  label: string;
  agg: Aggregate[];
  gap: GapAggregate[];
  author: AuthorAggregate[];
}

/** The filler sizes every result has probes for. */
export function commonSizes(results: readonly Comparable[]): number[] {
  const sets = results.map((r) => new Set(r.probes.map((p) => p.fillerSize)));
  return [...(sets[0] ?? [])].filter((s) => sets.every((x) => x.has(s))).sort((a, b) => a - b);
}

function legOf(r: Comparable, sizes: readonly number[]): Leg {
  const probes = r.probes.filter((p) => sizes.includes(p.fillerSize));
  return { label: `${r.meta.system} ${r.meta.leg}`, agg: aggregate(probes), gap: aggregateByGap(probes), author: aggregateAuthor(probes) };
}

const NUMERIC = new Set(["n", "K", "size", "other-channel rows"]);

/** Value cell, with the row's n when it differs from the reference n. */
const cellN = (v: string, n: number | undefined, ref: number | undefined) => (n === undefined ? "–" : n !== ref ? `${v} (n ${n})` : v);

export function renderComparison(results: Comparable[]): string {
  const sizes = commonSizes(results);
  const legs = results.map((r) => legOf(r, sizes));
  const header = (lead: string[]) =>
    `| ${[...lead, ...legs.map((l) => l.label)].join(" | ")} |\n| ${[...lead.map((l) => (NUMERIC.has(l) ? "---:" : "---")), ...legs.map(() => "---:")].join(" | ")} |`;
  const classRows = (pick: (a: Aggregate) => string, filter: (cls: string) => boolean) => {
    const out: string[] = [];
    for (const cls of SCENARIO_CLASSES.filter(filter))
      for (const size of sizes)
        for (const surface of ["proactive", "asked"] as const) {
          const rows = legs.map((l) => l.agg.find((a) => a.class === cls && a.fillerSize === size && a.surface === surface));
          if (rows.every((x) => !x)) continue;
          const ref = rows.find(Boolean)?.n;
          out.push(`| ${cls} ${CLASS_LABELS[cls]} | ${size} | ${surface} | ${ref ?? "–"} | ${rows.map((x) => cellN(x ? (x.n === 0 ? "not scored" : pick(x)) : "–", x?.n, ref)).join(" | ")} |`);
        }
    return out;
  };
  const gapKeys = [...new Map(legs.flatMap((l) => l.gap).map((g) => [`${g.class}|${g.variant}|${g.gapRows}|${g.otherChannelRows}|${g.surface}`, g])).values()];
  gapKeys.sort(
    (a, b) =>
      a.class.localeCompare(b.class) || a.variant.localeCompare(b.variant) || (a.gapRows ?? 0) - (b.gapRows ?? 0) || a.surface.localeCompare(b.surface),
  );
  const gapRows = gapKeys.map((k) => {
    const rows = legs.map((l) =>
      l.gap.find((g) => g.class === k.class && g.variant === k.variant && g.gapRows === k.gapRows && g.otherChannelRows === k.otherChannelRows && g.surface === k.surface),
    );
    const ref = rows.find(Boolean)?.n;
    return `| ${k.class} | ${k.variant} | ${c(k.gapRows)} | ${c(k.otherChannelRows ?? 0)} | ${k.surface} | ${ref ?? "–"} | ${rows
      .map((g) => cellN(g ? `${c(g.hitPct)} (${c(g.hitPctShared)} / ${c(g.hitPctDisjoint)})` : "–", g?.n, ref))
      .join(" | ")} |`;
  });
  const authorKeys = [...new Map(legs.flatMap((l) => l.author).map((a) => [`${a.authorCase}|${a.fillerSize}|${a.surface}`, a])).values()];
  const authorRows = authorKeys.map((k) => {
    const rows = legs.map((l) => l.author.find((a) => a.authorCase === k.authorCase && a.fillerSize === k.fillerSize && a.surface === k.surface));
    const ref = rows.find(Boolean)?.n;
    return `| ${k.authorCase} | ${k.fillerSize} | ${k.surface} | ${ref ?? "–"} | ${rows
      .map((a) => cellN(a ? `${c(a.hitPct)} / ${c(a.authorMarkedPct)} / ${c(a.authorMarkedWithDefaultPct)} / ${c(a.authorMarkedAnyPct)}` : "–", a?.n, ref))
      .join(" | ")} |`;
  });
  const c7Rows = sizes.flatMap((size) =>
    (["proactive", "asked"] as const).map((surface) => {
      const find = (l: Leg, cls: string) => l.agg.find((a) => a.class === cls && a.fillerSize === size && a.surface === surface);
      return `| ${size} | ${surface} | ${legs
        .map((l) => {
          const c7 = find(l, "C7");
          const c1 = find(l, "C1");
          return c7 ? `${c(c1?.hitPct)} / ${c(c7.hitPct)} / ${c(c7.meanIrrelevant)} / ${c(c7.recallCap)}` : "–";
        })
        .join(" | ")} |`;
    }),
  );
  const parts = [
    "# Continuity Scorecard — side by side (continuity-v2)",
    "",
    "Generated by `scripts/continuity-bench/score-external.ts --compare` from the result files of each leg; every figure is recomputed from the per-probe scores with `score.ts`. Corpus `benchmarks/continuity/corpus-v2.json`; method and limits in `benchmarks/continuity/README.md`.",
    "",
    "Legs: " + results.map((r) => `${r.meta.system} \`${r.meta.leg}\` (commit ${r.meta.commit}, embeddings ${r.meta.embeddings})`).join(" · ") + ".",
    "",
    `Filler sizes compared: ${sizes.join(", ") || "none in common"} (the sizes every leg has). C3/C4 rows are pooled over these sizes only.`,
    "",
    "## Notes",
    "",
    ...[...COMPARISON_NOTES, ...notesFor(results)].map((n) => `- ${n}`),
    "",
    "## Hit % per class and surface",
    "",
    header(["class", "size", "surface", "n"]),
    ...classRows((a) => c(a.hitPct), (cls) => !["C3", "C4", "C7"].includes(cls)),
    "",
    "## Hit % shared / disjoint wording",
    "",
    header(["class", "size", "surface", "n"]),
    ...classRows((a) => `${c(a.hitPctShared)} / ${c(a.hitPctDisjoint)}`, (cls) => !["C3", "C4", "C7"].includes(cls)),
    "",
    "## Stale-hit % (a forbid needle reached the surface)",
    "",
    header(["class", "size", "surface", "n"]),
    ...classRows((a) => c(a.staleHitPct), (cls) => cls === "C2" || cls === "C8"),
    "",
    "## Carried by: thread / recall / ambient % of hits",
    "",
    header(["class", "size", "surface", "n"]),
    ...classRows((a) => `${c(a.carriedThreadPct)} / ${c(a.carriedRecallPct)} / ${c(a.carriedAmbientPct)}`, (cls) => cls !== "C7"),
    "",
    "## C3 / C4 by gap K: hit % (shared / disjoint)",
    "",
    header(["class", "variant", "K", "other-channel rows", "surface", "n"]),
    ...gapRows,
    "",
    "## C5 who-said-it: hit % / strict % / with default role % / any occurrence %",
    "",
    "Strict marks only; \"with default role\" counts an unmarked occurrence as the marker spec's `defaultRole` (– where the spec sets none).",
    "",
    header(["author case", "size", "surface", "n"]),
    ...authorRows,
    "",
    "## C7 nothing-to-recall: C1 hit % (same run) / C7 hit % / C7 mean irrelevant / result cap",
    "",
    header(["size", "surface"]),
    ...c7Rows,
  ];
  return parts.join("\n") + "\n";
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const readJson = (p: string): unknown => JSON.parse(readFileSync(resolve(p), "utf8"));

function main(): void {
  requireOperatorContext("continuity-bench", { tty: false });
  const md = arg("--md");
  const compare = arg("--compare");
  if (compare) {
    if (!md) throw new Error("--compare needs --md <path>");
    writeFileSync(resolve(md), renderComparison(compare.split(",").map((p) => readJson(p) as Comparable)));
    console.log(`wrote ${md}`);
    return;
  }
  const report = arg("--report");
  if (report) {
    if (!md) throw new Error("--report needs --md <path>");
    const results = report.split(",").map((p) => readJson(p) as ExternalResult);
    writeFileSync(resolve(md), renderReport(arg("--title") ?? results[0]?.meta.system ?? "external", results));
    console.log(`wrote ${md}`);
    return;
  }
  const input = arg("--in");
  const out = arg("--out");
  if (!input || !out) throw new Error("usage: --in <surfaces.json> --out <result.json> | --report <a,b> --md <out.md> | --compare <a,b> --md <out.md>");
  const doc = readJson(input);
  assertSurfaces(doc);
  const markersPath = arg("--markers");
  const corpusPath = arg("--corpus");
  const markers = markersPath ? (readJson(markersPath) as AuthorMarkerSpec) : DEFAULT_MARKERS;
  const result = scoreExternal(doc, markers, corpusPath ? (readJson(corpusPath) as Corpus) : undefined);
  writeFileSync(resolve(out), JSON.stringify(result) + "\n");
  console.log(`wrote ${out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
