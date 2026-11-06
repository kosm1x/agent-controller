/**
 * Continuity Scorecard — pure scorer + aggregation + Markdown tables.
 *
 * Rules (also in benchmarks/continuity/README.md):
 *   - text matching: both sides Unicode-NFC normalized and lower-cased;
 *     diacritics stay significant ("líquida" ≠ "liquida").
 *   - payload = the surface's component texts joined by "\n\n".
 *   - hit: every `expect` needle is a substring of the payload. A probe with
 *     no `expect` (C7) hits when the query-driven components return zero
 *     items; that count is `irrelevantCount`.
 *   - staleHit: SOME `forbid` needle is in the payload.
 *   - carriedBy: the components whose text holds an expect needle.
 *   - authorMarked (probes with `expectAuthor`), strict: EVERY occurrence of
 *     every expect needle inside the surface's items is attributed to the
 *     expected role, and there is at least one. Attribution of one occurrence,
 *     using the adapter's AuthorMarkerSpec: the nearest line marker at or
 *     before it in the same item (a turn runs until the next marker) → else
 *     an item-level marker → else the nearest heading above the item in its
 *     component → else none. A heading decides only for unmarked items.
 *   - attributionConflict: an occurrence on a line marked for one role sits
 *     in a block whose heading attributes it to the other role.
 */

import type {
  AuthorCase,
  ComponentKind,
  Corpus,
  ProbeRun,
  ProbeScore,
  ScenarioClass,
  ScenarioVariant,
  SurfaceComponent,
  SurfaceResult,
  SurfaceScore,
} from "./types.js";
import { CLASS_LABELS, SCENARIO_CLASSES } from "./types.js";

export type Role = "person" | "assistant";

/**
 * How a system marks authorship in what it returns. JSON-serializable so an
 * adapter in any language can declare it next to its results.
 */
export interface AuthorMarkerSpec {
  /** Labels that open a line, after optional indentation and a list prefix (`-` `•` `*` `1.`), as `Label:` or `[label]`; case-insensitive. */
  lineLabels: Record<Role, string[]>;
  /** Regex sources (case-insensitive) tested against the whole item (anchor with `^` / `$`); a match attributes the whole item (a single-author item). */
  itemPatterns?: Partial<Record<Role, string[]>>;
  /** Regex sources (case-insensitive) tested against each line of a component's text; the last match above an item attributes it when it carries no marker. */
  headings?: Array<{ pattern: string; role: Role }>;
  /**
   * Optional, reported apart: an occurrence no marker attributes counts as this role in
   * `authorMarkedWithDefault` only. The strict `authorMarked` never uses it.
   */
  defaultRole?: Role;
}

/** v1 marker set; the default when an adapter declares none. */
export const DEFAULT_MARKERS: AuthorMarkerSpec = {
  lineLabels: { person: ["user", "person", "human"], assistant: ["assistant", "jarvis", "ai", "bot"] },
};

const PERSON = new Set(["user", "person", "human"]);
const ASSISTANT = new Set(["assistant", "jarvis", "ai", "bot"]);
const MARKER_RE =
  /^[ \t]*(?:(?:[-•*]|\d+\.)[ \t]+)?(?:\[(user|person|human|assistant|jarvis|ai|bot)\]|(user|person|human|assistant|jarvis|ai|bot)[ \t]*:)/gim;

/** NFC + lower case; diacritics are kept. */
export function fold(s: string): string {
  return s.normalize("NFC").toLowerCase();
}

export function payloadText(s: SurfaceResult): string {
  return s.components.map((c) => c.text).join("\n\n");
}

const contains = (hay: string, needle: string) => fold(hay).includes(fold(needle));

/** v1 helper: role of the nearest default marker at or before `index` in `item`, or null. */
export function authorAt(item: string, index: number): Role | null {
  let role: Role | null = null;
  for (const m of item.matchAll(MARKER_RE)) {
    if ((m.index ?? 0) > index) break;
    const word = (m[1] ?? m[2]).toLowerCase();
    role = PERSON.has(word) ? "person" : ASSISTANT.has(word) ? "assistant" : null;
  }
  return role;
}

/** v1 helper (lenient): some item carries every needle with `role` as the nearest preceding marker. */
export function authorMarked(items: readonly string[], needles: readonly string[], role: Role): boolean {
  return items.some((item) =>
    needles.every((n) => {
      const lower = fold(item);
      const needle = fold(n);
      for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, i + 1)) {
        if (authorAt(item, i) === role) return true;
      }
      return false;
    }),
  );
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface CompiledMarkers {
  line: RegExp;
  roleOf: Map<string, Role>;
  item: Array<{ re: RegExp; role: Role }>;
  headings: Array<{ re: RegExp; role: Role }>;
}

const compiledCache = new WeakMap<AuthorMarkerSpec, CompiledMarkers>();

function compile(spec: AuthorMarkerSpec): CompiledMarkers {
  const hit = compiledCache.get(spec);
  if (hit) return hit;
  const roleOf = new Map<string, Role>();
  for (const role of ["person", "assistant"] as const) for (const l of spec.lineLabels[role]) roleOf.set(fold(l), role);
  const alt = [...roleOf.keys()].map(escapeRe).join("|");
  const c: CompiledMarkers = {
    line: new RegExp(`^[ \\t]*(?:(?:[-•*]|\\d+\\.)[ \\t]+)?(?:\\[(${alt})\\]|(${alt})[ \\t]*:)`, "gimu"),
    roleOf,
    item: (["person", "assistant"] as const).flatMap((role) =>
      (spec.itemPatterns?.[role] ?? []).map((p) => ({ re: new RegExp(p, "iu"), role })),
    ),
    headings: (spec.headings ?? []).map((h) => ({ re: new RegExp(h.pattern, "iu"), role: h.role })),
  };
  compiledCache.set(spec, c);
  return c;
}

function lineRoleAt(item: string, index: number, c: CompiledMarkers): Role | null {
  let role: Role | null = null;
  for (const m of item.normalize("NFC").matchAll(c.line)) {
    if ((m.index ?? 0) > index) break;
    role = c.roleOf.get(fold(m[1] ?? m[2])) ?? null;
  }
  return role;
}

function itemRole(item: string, c: CompiledMarkers): Role | null {
  for (const { re, role } of c.item) if (re.test(item)) return role;
  return null;
}

/** Heading role for the item that starts at `at` in the component text (-1 = not found: every line counts). */
function headingRole(component: SurfaceComponent, at: number, c: CompiledMarkers): Role | null {
  if (c.headings.length === 0) return null;
  const above = (at === -1 ? component.text : component.text.slice(0, at)).split("\n");
  let role: Role | null = null;
  for (const line of above) for (const h of c.headings) if (h.re.test(line)) role = h.role;
  return role;
}

export interface Attribution {
  /** Occurrences of the needles inside items. */
  occurrences: number;
  /**
   * Strict: some occurrence is attributed to `role`, none is unattributed,
   * and none is attributed to a role outside `statedBy` (default: `role`
   * alone). An echo (both sides stated the figure) passes when every
   * occurrence carries its own author.
   */
  marked: boolean;
  /** Some occurrence attributed to `role` (the v1, lenient rule). */
  anyMarked: boolean;
  /** Some occurrence's line role differs from its block heading's role. */
  conflict: boolean;
  /** The strict rule with unattributed occurrences counted as `spec.defaultRole`; null when the spec sets none. */
  markedWithDefault: boolean | null;
}

/** Strict attribution of `needles` to `role` across a surface's components. */
export function attribute(
  components: readonly SurfaceComponent[],
  needles: readonly string[],
  role: Role,
  spec: AuthorMarkerSpec = DEFAULT_MARKERS,
  statedBy: readonly Role[] = [role],
): Attribution {
  const c = compile(spec);
  let occurrences = 0;
  let clean = true;
  let anyMatch = false;
  let conflict = false;
  let cleanD = true;
  let anyMatchD = false;
  for (const comp of components) {
    let cursor = 0;
    for (const item of comp.items) {
      // The item's own position (a repeated item is not its first copy).
      const found = comp.text.indexOf(item, cursor);
      const at = found === -1 ? comp.text.indexOf(item) : found;
      if (found !== -1) cursor = found + item.length;
      const lower = fold(item);
      for (const n of needles) {
        const needle = fold(n);
        for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, i + 1)) {
          occurrences++;
          const line = lineRoleAt(item, i, c);
          const heading = headingRole(comp, at, c);
          const who = line ?? itemRole(item, c) ?? heading;
          if (who === null || !statedBy.includes(who)) clean = false;
          if (who === role) anyMatch = true;
          if (line && heading && line !== heading) conflict = true;
          const whoD = who ?? spec.defaultRole ?? null;
          if (whoD === null || !statedBy.includes(whoD)) cleanD = false;
          if (whoD === role) anyMatchD = true;
        }
      }
    }
  }
  return {
    occurrences,
    marked: anyMatch && clean,
    anyMarked: anyMatch,
    conflict,
    markedWithDefault: spec.defaultRole ? anyMatchD && cleanD : null,
  };
}

export function componentKind(c: SurfaceComponent): ComponentKind {
  return c.kind ?? (c.queryDriven ? "recall" : "ambient");
}

export function scoreSurface(
  run: ProbeRun,
  which: "proactive" | "asked",
  markers: AuthorMarkerSpec = DEFAULT_MARKERS,
): SurfaceScore {
  const s = run[which];
  const p = run.probe;
  const declared = p.surface === "both" || p.surface === which;
  const scored = s.measurable && declared;
  const text = payloadText(s);
  const recall = s.components.filter((c) => c.queryDriven);
  const recallItems = recall.reduce((n, c) => n + c.items.length, 0);
  const nothingExpected = p.expect.length === 0;
  // A carrier holds EVERY expect needle (a hit split across components has no single carrier).
  const carriers = nothingExpected ? [] : s.components.filter((c) => p.expect.every((n) => contains(c.text, n)));
  const attribution = p.expectAuthor ? attribute(s.components, p.expect, p.expectAuthor, markers, p.statedBy ?? [p.expectAuthor]) : null;
  return {
    scored,
    hit: nothingExpected ? recallItems === 0 : p.expect.every((n) => contains(text, n)),
    staleHit: p.forbid.some((n) => contains(text, n)),
    chars: text.length,
    ms: s.ms,
    recallItems,
    irrelevantCount: nothingExpected ? recallItems : null,
    authorMarked: attribution ? attribution.marked : null,
    attributionConflict: attribution ? attribution.conflict : null,
    authorMarkedAny: attribution ? attribution.anyMarked : null,
    ...(attribution && attribution.markedWithDefault !== null ? { authorMarkedWithDefault: attribution.markedWithDefault } : {}),
    notMeasurable: declared && !s.measurable,
    carriedBy: carriers.map((c) => c.name),
    carriedKinds: [...new Set(carriers.map(componentKind))],
    staleCarriedBy: s.components.filter((c) => p.forbid.some((n) => contains(c.text, n))).map((c) => c.name),
    recallCap: recall.every((c) => typeof c.cap === "number") ? recall.reduce((n, c) => n + (c.cap ?? 0), 0) : null,
  };
}

/** v1 signature (safe as an Array.map callback): default author markers. */
export function scoreProbe(run: ProbeRun): ProbeScore {
  return scoreProbeWith(run, DEFAULT_MARKERS);
}

/** Scores one probe with the adapter's declared author markers. */
export function scoreProbeWith(run: ProbeRun, markers: AuthorMarkerSpec): ProbeScore {
  return {
    scenarioId: run.scenarioId,
    class: run.class,
    fillerSize: run.fillerSize,
    probeIndex: run.probeIndex,
    day: run.probe.day,
    ...(run.probe.wording ? { wording: run.probe.wording } : {}),
    ...(run.probe.authorCase ? { authorCase: run.probe.authorCase } : {}),
    ...(run.gapRows !== undefined ? { gapRows: run.gapRows } : {}),
    ...(run.variant ? { variant: run.variant } : {}),
    ...(run.otherChannelRows !== undefined ? { otherChannelRows: run.otherChannelRows } : {}),
    proactive: scoreSurface(run, "proactive", markers),
    asked: scoreSurface(run, "asked", markers),
  };
}

/** Fills each run's scenario metadata (gapRows, variant, otherChannelRows) from the corpus. */
export function withScenarioMeta(runs: readonly ProbeRun[], corpus: Corpus): ProbeRun[] {
  const byId = new Map(corpus.scenarios.map((s) => [s.id, s]));
  return runs.map((r) => {
    const s = byId.get(r.scenarioId);
    if (!s) return r;
    return {
      ...r,
      ...(s.gapRows !== undefined ? { gapRows: s.gapRows } : {}),
      ...(s.variant ? { variant: s.variant } : {}),
      ...(s.otherChannelRows !== undefined ? { otherChannelRows: s.otherChannelRows } : {}),
    };
  });
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const pctOf = (xs: ReadonlyArray<boolean | null | undefined>) => {
  const b = xs.filter((x): x is boolean => typeof x === "boolean");
  return b.length ? pct(b.filter(Boolean).length, b.length) : null;
};
const pct = (k: number, n: number) => (n === 0 ? null : Math.round((1000 * k) / n) / 10);
const mean1 = (xs: readonly number[]) => (xs.length ? Math.round((10 * xs.reduce((a, b) => a + b, 0)) / xs.length) / 10 : null);

export interface Aggregate {
  class: ScenarioClass;
  label: string;
  fillerSize: number;
  surface: "proactive" | "asked";
  n: number;
  hitPct: number | null;
  staleHitPct: number | null;
  medianChars: number | null;
  medianMs: number | null;
  /** C7: mean query-driven items returned for a topic that never appeared. */
  meanIrrelevant: number | null;
  /** C5: share of probes whose needle is attributed (strictly) to the expected role. */
  authorMarkedPct: number | null;
  /** v2 */
  notScored?: number;
  nShared?: number;
  hitPctShared?: number | null;
  nDisjoint?: number;
  hitPctDisjoint?: number | null;
  /** Shares of HITS whose needle was carried by a thread / recall / ambient component (not exclusive). */
  carriedThreadPct?: number | null;
  carriedRecallPct?: number | null;
  carriedAmbientPct?: number | null;
  /** Hits carried by the thread and nothing else. */
  threadOnlyPct?: number | null;
  attributionConflictPct?: number | null;
  /** C7: the result cap (sum of query-driven caps; null = uncapped or mixed). */
  recallCap?: number | null;
}

function summarize(
  rows: readonly SurfaceScore[],
  wordings: ReadonlyArray<"shared" | "disjoint" | undefined>,
): Omit<Aggregate, "class" | "label" | "fillerSize" | "surface" | "n" | "notScored"> {
  const hits = rows.filter((r) => r.hit);
  const kinds = (r: SurfaceScore) => r.carriedKinds ?? [];
  const irr = rows.map((r) => r.irrelevantCount).filter((x): x is number => x !== null);
  const auth = rows.map((r) => r.authorMarked).filter((x): x is boolean => x !== null);
  const conf = rows.map((r) => r.attributionConflict).filter((x): x is boolean => x !== null && x !== undefined);
  const caps = [...new Set(rows.map((r) => r.recallCap ?? null))];
  const by = (w: "shared" | "disjoint") => rows.filter((_, i) => wordings[i] === w);
  const shared = by("shared");
  const disjoint = by("disjoint");
  const expectHits = hits.filter((r) => r.irrelevantCount === null);
  return {
    hitPct: pct(hits.length, rows.length),
    staleHitPct: pct(rows.filter((r) => r.staleHit).length, rows.length),
    medianChars: median(rows.map((r) => r.chars)),
    medianMs: median(rows.map((r) => r.ms)),
    meanIrrelevant: irr.length ? mean1(irr) : null,
    authorMarkedPct: auth.length ? pct(auth.filter(Boolean).length, auth.length) : null,
    nShared: shared.length,
    hitPctShared: pct(shared.filter((r) => r.hit).length, shared.length),
    nDisjoint: disjoint.length,
    hitPctDisjoint: pct(disjoint.filter((r) => r.hit).length, disjoint.length),
    carriedThreadPct: pct(expectHits.filter((r) => kinds(r).includes("thread")).length, expectHits.length),
    carriedRecallPct: pct(expectHits.filter((r) => kinds(r).includes("recall")).length, expectHits.length),
    carriedAmbientPct: pct(expectHits.filter((r) => kinds(r).includes("ambient")).length, expectHits.length),
    threadOnlyPct: pct(expectHits.filter((r) => kinds(r).length === 1 && kinds(r)[0] === "thread").length, expectHits.length),
    attributionConflictPct: conf.length ? pct(conf.filter(Boolean).length, conf.length) : null,
    recallCap: caps.length === 1 ? caps[0] : null,
  };
}

function group(
  scores: readonly ProbeScore[],
  surface: "proactive" | "asked",
  pick: (s: ProbeScore) => boolean,
): { rows: SurfaceScore[]; wordings: Array<"shared" | "disjoint" | undefined>; notScored: number } {
  const chosen = scores.filter(pick);
  const kept = chosen.filter((s) => s[surface].scored);
  return {
    rows: kept.map((s) => s[surface]),
    wordings: kept.map((s) => s.wording),
    notScored: chosen.filter((s) => s[surface].notMeasurable).length,
  };
}

/**
 * One row per class × size × surface that has a scored probe, or that the
 * adapter could not measure (n 0, notScored > 0 — rendered "not scored").
 */
export function aggregate(scores: readonly ProbeScore[]): Aggregate[] {
  const out: Aggregate[] = [];
  const sizes = [...new Set(scores.map((s) => s.fillerSize))].sort((a, b) => a - b);
  for (const cls of SCENARIO_CLASSES) {
    for (const size of sizes) {
      for (const surface of ["proactive", "asked"] as const) {
        const g = group(scores, surface, (s) => s.class === cls && s.fillerSize === size);
        if (g.rows.length === 0 && g.notScored === 0) continue;
        out.push({ class: cls, label: CLASS_LABELS[cls], fillerSize: size, surface, n: g.rows.length, notScored: g.notScored, ...summarize(g.rows, g.wordings) });
      }
    }
  }
  return out;
}

export interface GapAggregate {
  class: ScenarioClass;
  variant: ScenarioVariant | "none";
  gapRows: number | null;
  otherChannelRows: number | null;
  surface: "proactive" | "asked";
  n: number;
  notScored: number;
  hitPct: number | null;
  hitPctShared: number | null;
  hitPctDisjoint: number | null;
  carriedThreadPct: number | null;
  carriedRecallPct: number | null;
}

/** C3/C4 by variant × gap (K), pooled over filler sizes (filler sits before the session, so size is not an axis). */
export function aggregateByGap(scores: readonly ProbeScore[]): GapAggregate[] {
  const out: GapAggregate[] = [];
  const keyOf = (s: ProbeScore) => `${s.class}|${s.variant ?? "none"}|${s.gapRows ?? ""}|${s.otherChannelRows ?? ""}`;
  const keys = [...new Set(scores.filter((s) => s.class === "C3" || s.class === "C4").map(keyOf))];
  keys.sort((a, b) => {
    const [ca, va, ga] = a.split("|");
    const [cb, vb, gb] = b.split("|");
    return ca.localeCompare(cb) || va.localeCompare(vb) || Number(ga) - Number(gb);
  });
  for (const key of keys) {
    const [cls, variant, gap, other] = key.split("|");
    for (const surface of ["proactive", "asked"] as const) {
      const g = group(scores, surface, (s) => keyOf(s) === key);
      if (g.rows.length === 0 && g.notScored === 0) continue;
      const sum = summarize(g.rows, g.wordings);
      out.push({
        class: cls as ScenarioClass,
        variant: variant as ScenarioVariant | "none",
        gapRows: gap === "" ? null : Number(gap),
        otherChannelRows: other === "" ? null : Number(other),
        surface,
        n: g.rows.length,
        notScored: g.notScored,
        hitPct: sum.hitPct,
        hitPctShared: sum.hitPctShared ?? null,
        hitPctDisjoint: sum.hitPctDisjoint ?? null,
        carriedThreadPct: sum.carriedThreadPct ?? null,
        carriedRecallPct: sum.carriedRecallPct ?? null,
      });
    }
  }
  return out;
}

export interface AuthorAggregate {
  authorCase: AuthorCase | "unspecified";
  fillerSize: number;
  surface: "proactive" | "asked";
  n: number;
  notScored: number;
  hitPct: number | null;
  authorMarkedPct: number | null;
  /** Lenient (v1) rule: some occurrence is attributed to the expected role. */
  authorMarkedAnyPct: number | null;
  attributionConflictPct: number | null;
  /** Only when the spec sets `defaultRole`: the strict rule with unattributed occurrences counted as that role. */
  authorMarkedWithDefaultPct?: number | null;
}

/** C5 by author case × size × surface. */
export function aggregateAuthor(scores: readonly ProbeScore[]): AuthorAggregate[] {
  const out: AuthorAggregate[] = [];
  const c5 = scores.filter((s) => s.class === "C5");
  const cases = [...new Set(c5.map((s) => s.authorCase ?? "unspecified"))];
  const sizes = [...new Set(c5.map((s) => s.fillerSize))].sort((a, b) => a - b);
  for (const ac of cases) {
    for (const size of sizes) {
      for (const surface of ["proactive", "asked"] as const) {
        const g = group(c5, surface, (s) => (s.authorCase ?? "unspecified") === ac && s.fillerSize === size);
        if (g.rows.length === 0 && g.notScored === 0) continue;
        const sum = summarize(g.rows, g.wordings);
        const withDefault = g.rows.some((r) => r.authorMarkedWithDefault !== undefined);
        out.push({
          authorCase: ac,
          fillerSize: size,
          surface,
          n: g.rows.length,
          notScored: g.notScored,
          hitPct: sum.hitPct,
          authorMarkedPct: sum.authorMarkedPct,
          authorMarkedAnyPct: pctOf(g.rows.map((r) => r.authorMarkedAny)),
          attributionConflictPct: sum.attributionConflictPct ?? null,
          ...(withDefault ? { authorMarkedWithDefaultPct: pctOf(g.rows.map((r) => r.authorMarkedWithDefault)) } : {}),
        });
      }
    }
  }
  return out;
}

export interface IngestStat {
  fillerSize: number;
  probes: number;
  rows: number;
  ms: number;
  rowsPerSec: number;
  medianProactiveMs: number | null;
  medianAskedMs: number | null;
}

export function ingestStats(runs: readonly ProbeRun[]): IngestStat[] {
  const sizes = [...new Set(runs.map((r) => r.fillerSize))].sort((a, b) => a - b);
  return sizes.map((size) => {
    const rs = runs.filter((r) => r.fillerSize === size);
    const rows = rs.reduce((n, r) => n + r.ingestedRows, 0);
    const ms = rs.reduce((n, r) => n + r.ingestMs, 0);
    return {
      fillerSize: size,
      probes: rs.length,
      rows,
      ms: Math.round(ms),
      rowsPerSec: ms > 0 ? Math.round((rows * 1000) / ms) : 0,
      medianProactiveMs: median(rs.filter((r) => r.proactive.measurable).map((r) => r.proactive.ms)),
      medianAskedMs: median(rs.filter((r) => r.asked.measurable).map((r) => r.asked.ms)),
    };
  });
}

const cell = (v: number | null | undefined, suffix = "") => (v === null || v === undefined ? "–" : `${v}${suffix}`);
const ms1 = (v: number | null) => (v === null ? "–" : v.toFixed(1));

/** v1 Markdown table for one result file's aggregates (kept for compatibility). */
export function markdownTable(rows: readonly Aggregate[]): string {
  const head =
    "| class | size | surface | n | hit % | stale-hit % | median chars | median ms | C7 mean irrelevant | C5 author-marked % |\n" +
    "| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |";
  const body = rows.map((r) =>
    r.n === 0
      ? `| ${r.class} ${r.label} | ${r.fillerSize} | ${r.surface} | 0 | not scored | | | | | |`
      : `| ${r.class} ${r.label} | ${r.fillerSize} | ${r.surface} | ${r.n} | ${cell(r.hitPct)} | ${cell(r.staleHitPct)} | ${cell(r.medianChars)} | ${ms1(r.medianMs)} | ${cell(r.meanIrrelevant)} | ${cell(r.authorMarkedPct)} |`,
  );
  return [head, ...body].join("\n");
}
