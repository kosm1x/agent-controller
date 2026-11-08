/**
 * Continuity Scorecard, P1 Stage A: post-hoc ablation report over committed
 * result JSONs. No run, no model, no db. For each store group G it counts the
 * hits that would be lost (every carrier in G) and the stale hits that would be
 * cleared (every stale carrier in G) if G were removed, and the C7 noise items
 * G contributes. Exact only while every hit has a single carrier and no prompt
 * block was dropped; such probes are listed as "not attributable" (--strict
 * refuses instead, exit 3).
 *
 *   npx tsx scripts/continuity-bench/ablation.ts --results a.json[,b.json] --md out.md [--json out.json] [--by-size] [--strict]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireOperatorContext } from "../../src/lib/operator-gate.js";
import type { ProbeScore } from "./types.js";

const BASE: Record<string, string[]> = {
  thread: ["thread", "precedent"],
  "conv-recall": ["enrichment:Contexto relevante del usuario", "memory_search"],
  essentials: ["essentials"],
  jme: ["jme", "jme_query"],
  user_facts: ["profile", "relevant_facts"],
  open_work: ["open_work"],
};
/** Store groups; the first six are disjoint, `conversations*` is every conversations-table reader. */
export const GROUPS: Record<string, string[]> = {
  ...BASE,
  "conversations*": [...BASE.thread, ...BASE["conv-recall"], ...BASE.essentials, ...BASE.open_work],
};

const SURFACES = ["proactive", "asked"] as const;
type Surface = (typeof SURFACES)[number];
type Caps = Record<string, number | null | Record<string, number | null>>;

export interface AblationInput {
  meta: { commit: string; leg: string; switches?: Record<string, string> };
  probes: Array<ProbeScore & { components: Record<Surface, string[]>; dropped?: string[] }>;
  /** Query-driven component names → cap: Jarvis flat (`run.ts` capsOf), external adapters per surface. */
  caps?: Caps;
}

/** Fallback when a result has no `caps`: adapter-jarvis's `queryDriven: true` components. */
const jarvisRecall = (name: string): boolean =>
  ["relevant_facts", "jme", "memory_search", "jme_query"].includes(name) || (name.startsWith("enrichment:") && name !== "enrichment:other");

/** The components the scorer's C7 irrelevantCount sums on this surface: the names the result's `caps` records. */
function recallTest(caps: Caps | undefined, surface: Surface): (name: string) => boolean {
  if (!caps) return jarvisRecall;
  const perSurface = Object.values(caps).some((v) => v !== null && typeof v === "object");
  const own = perSurface ? caps[surface] : caps;
  const names = new Set(own && typeof own === "object" ? Object.keys(own) : []);
  return (name) => names.has(name);
}
export interface Row { cls: string; surface: Surface; size: number | "all"; n: number; hits: number; lost: number; stale: number; cleared: number }
export interface NoiseRow { group: string; proactive: number; asked: number; share: number }
export interface AblationReport {
  source: string;
  meta: AblationInput["meta"];
  groups: Array<{ group: string; rows: Row[] }>;
  noise: { probes: number; proactive: number; asked: number; rows: NoiseRow[] };
  ungrouped: string[];
  /** Probe-surface ids (`scenarioId#probeIndex/surface`) the subset rule cannot attribute, by reason. */
  notAttributable: { split: string[]; dropped: string[]; c7: string[] };
}

const parse = (entry: string): [string, number] => {
  const i = entry.lastIndexOf(":");
  return [entry.slice(0, i), Number(entry.slice(i + 1))];
};
const within = (names: string[], g: Set<string>): boolean => names.length > 0 && names.every((n) => g.has(n));
const sizeOrder = (s: number | "all"): number => (s === "all" ? -1 : s);

export function ablate(result: AblationInput, groups: Record<string, string[]> = GROUPS, source = ""): AblationReport {
  const grouped = new Set(Object.values(groups).flat());
  const seen = new Set<string>();
  const na: AblationReport["notAttributable"] = { split: [], dropped: [], c7: [] };
  const keyed = new Map<string, Row[]>(Object.keys(groups).map((g) => [g, []]));
  const noiseBy: Record<string, Record<Surface, number>> = {}; // by component name
  const noise = { probes: 0, proactive: 0, asked: 0 };
  const isRecall = { proactive: recallTest(result.caps, "proactive"), asked: recallTest(result.caps, "asked") };

  for (const p of result.probes) {
    if (p.dropped?.length) na.dropped.push(`${p.scenarioId}#${p.probeIndex}`);
    for (const surface of SURFACES) {
      const s = p[surface];
      const comps = (p.components?.[surface] ?? []).map(parse);
      for (const [name] of comps) seen.add(name);
      if (!s.scored) continue;
      const id = `${p.scenarioId}#${p.probeIndex}/${surface}`;
      if (s.irrelevantCount !== null) {
        noise.probes++;
        const recall = comps.filter(([name]) => isRecall[surface](name));
        if (recall.reduce((a, [, c]) => a + c, 0) !== s.irrelevantCount) na.c7.push(id);
        for (const [name, count] of recall) {
          noise[surface] += count;
          (noiseBy[name] ??= { proactive: 0, asked: 0 })[surface] += count;
        }
        continue;
      }
      const carriers = s.carriedBy ?? [];
      if (s.hit && carriers.length === 0) na.split.push(id);
      for (const [group, names] of Object.entries(groups)) {
        const g = new Set(names);
        const rows = keyed.get(group)!;
        for (const size of ["all", p.fillerSize] as const) {
          let row = rows.find((r) => r.cls === p.class && r.surface === surface && r.size === size);
          if (!row) rows.push((row = { cls: p.class, surface, size, n: 0, hits: 0, lost: 0, stale: 0, cleared: 0 }));
          row.n++;
          if (s.hit) row.hits++;
          if (s.hit && within(carriers, g)) row.lost++;
          if (s.staleHit) row.stale++;
          if (s.staleHit && within(s.staleCarriedBy ?? [], g)) row.cleared++;
        }
      }
    }
  }
  const total = noise.proactive + noise.asked;
  const rowsFor: Array<[string, string[]]> = [
    ...Object.entries(groups),
    ...Object.keys(noiseBy).filter((n) => !grouped.has(n)).map((n): [string, string[]] => [`ungrouped: ${n}`, [n]]),
  ];
  const noiseRows = rowsFor.map(([group, names]) => {
    const sum = (surface: Surface): number => names.reduce((a, n) => a + (noiseBy[n]?.[surface] ?? 0), 0);
    const [pr, as] = [sum("proactive"), sum("asked")];
    return { group, proactive: pr, asked: as, share: total ? (pr + as) / total : 0 };
  });
  const order = (r: Row): string => `${r.cls}|${r.surface === "proactive" ? 0 : 1}`;
  return {
    source,
    meta: result.meta,
    groups: [...keyed].map(([group, rows]) => ({
      group,
      // pooled rows first, then class, surface, size
      rows: rows.sort((a, b) => sizeOrder(a.size) - sizeOrder(b.size) || order(a).localeCompare(order(b), "en", { numeric: true })),
    })),
    noise: { ...noise, rows: noiseRows },
    ungrouped: [...seen].filter((n) => !grouped.has(n)).sort(),
    notAttributable: na,
  };
}

/** --strict: throws with every probe the subset rule cannot attribute. */
export function assertExact(reports: AblationReport[]): void {
  const bad = reports.flatMap((r) => [...r.notAttributable.split, ...r.notAttributable.dropped, ...r.notAttributable.c7].map((id) => `${r.source}: ${id}`));
  if (bad.length) throw new Error(`ablation not exact (split hit / dropped block / C7 count mismatch):\n${bad.join("\n")}`);
}

const pct = (x: number): string => `${(100 * x).toFixed(1)} %`;
const switchesOf = (s?: Record<string, string>): string => (s ? Object.entries(s).map(([k, v]) => `${k}=${v}`).join(", ") : "(none recorded = all off)");

export const FOOTER =
  "**How to read.** A hit is lost without G iff every component that carried it (held every expect needle) is in G; a stale hit is cleared without G iff every component that carried a forbidden needle is in G. Co-carried hits survive single-group ablations, so a single group's loss is a floor and `conversations*` shows the joint loss of every conversations reader. C7 items are the query-driven items each group returned for a topic that never appeared (the scorer's irrelevantCount). Stores the corpus never writes (mc-operational / `enrichment:Aprendizajes previos`, KG, KB, day-logs) move nothing here: they are not measured by this corpus, never \"no value\".";

/** `bySize`: also the per-fillerSize rows (the JSON always has them). Groups that move nothing are named in one line, not tabled. */
export function renderAblation(reports: AblationReport[], opts: { bySize?: boolean } = {}): string {
  const out = [
    "# Continuity Scorecard: ablation report (P1 Stage A, post-hoc)",
    "",
    "Computed from committed result JSONs by `scripts/continuity-bench/ablation.ts`; no run, no model.",
    "",
    "| file | commit | leg | switches |",
    "| --- | --- | --- | --- |",
    ...reports.map((r) => `| ${r.source} | ${r.meta.commit} | ${r.meta.leg} | ${switchesOf(r.meta.switches)} |`),
  ];
  for (const r of reports) {
    out.push("", `## ${r.source}`);
    const noiseOf = (g: string): number => r.noise.rows.filter((n) => n.group === g).reduce((a, n) => a + n.proactive + n.asked, 0);
    const inert = r.groups.filter((g) => g.rows.every((x) => x.lost === 0 && x.cleared === 0) && noiseOf(g.group) === 0).map((g) => g.group);
    out.push("", inert.length ? `Groups with no effect in this file (0 lost, 0 cleared, 0 C7 items): ${inert.map((g) => `\`${g}\``).join(", ")}.` : "Every group moves something in this file.");
    for (const { group, rows } of r.groups.filter((g) => !inert.includes(g.group))) {
      out.push("", `### Without ${group} (${(GROUPS[group] ?? []).join(", ")})`, "", "| class | surface | size | hits | lost w/o G | stale | cleared w/o G |", "| --- | --- | --- | --- | --- | --- | --- |");
      for (const x of rows.filter((x) => opts.bySize || x.size === "all")) out.push(`| ${x.cls} | ${x.surface} | ${x.size} | ${x.hits}/${x.n} | ${x.lost} | ${x.stale} | ${x.cleared} |`);
    }
    out.push("", `### C7 noise (${r.noise.probes} scored probe-surfaces; ${r.noise.proactive} proactive + ${r.noise.asked} asked items)`, "");
    const noiseRows = r.noise.rows.filter((n) => !inert.includes(n.group));
    if (!noiseRows.length) out.push("none");
    else out.push("| group | items (proactive) | items (asked) | share |", "| --- | --- | --- | --- |", ...noiseRows.map((n) => `| ${n.group} | ${n.proactive} | ${n.asked} | ${pct(n.share)} |`));
    out.push("", `### Ungrouped components`, "", r.ungrouped.length ? r.ungrouped.map((n) => `- \`${n}\``).join("\n") : "none (every component name in this file is in a group)");
    const na = r.notAttributable;
    const byClass = (ids: string[]): string => {
      const m = new Map<string, string[]>();
      for (const id of ids) {
        const cls = id.split("-")[0];
        m.set(cls, [...(m.get(cls) ?? []), id]);
      }
      return [...m].map(([c, xs]) => `- ${c}: ${xs.join(", ")}`).join("\n");
    };
    out.push("", "### Not attributable", "");
    if (!na.split.length && !na.dropped.length && !na.c7.length) out.push("none (0 split hits, 0 dropped blocks, 0 C7 count mismatches): the subset rule is exact for this file.");
    else for (const [label, ids] of [["split hit (no single carrier)", na.split], ["dropped block", na.dropped], ["C7 count mismatch", na.c7]] as const) if (ids.length) out.push(`${label}: ${ids.length}`, byClass(ids), "");
  }
  out.push("", FOOTER);
  return out.join("\n") + "\n";
}

const USAGE = "usage: --results <a.json>[,<b.json>] --md <out.md> [--json <out.json>] [--by-size] [--strict]";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`${name} needs a value; ${USAGE}`);
  return v;
}

function main(): void {
  requireOperatorContext("continuity-bench", { tty: false });
  const results = arg("--results");
  const md = arg("--md");
  const json = arg("--json");
  const strict = process.argv.includes("--strict");
  const bySize = process.argv.includes("--by-size");
  if (!results || !md) throw new Error(USAGE);
  const reports = results.split(",").filter((p) => p.trim()).map((p) => ablate(JSON.parse(readFileSync(resolve(p), "utf8")) as AblationInput, GROUPS, basename(p)));
  if (strict) {
    try {
      assertExact(reports);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(3); // 2 is the operator-gate refusal
    }
  }
  writeFileSync(resolve(md), renderAblation(reports, { bySize }));
  console.log(`wrote ${md}`);
  if (json) {
    writeFileSync(resolve(json), JSON.stringify(reports, null, 1) + "\n");
    console.log(`wrote ${json}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
