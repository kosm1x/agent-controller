/**
 * Continuity Scorecard v1 — shared types.
 *
 * The corpus (benchmarks/continuity/corpus-v1.json) is the neutral contract
 * every adapter reads; see benchmarks/continuity/README.md for the prose
 * version of these shapes.
 */

export type ScenarioClass = "C1" | "C2" | "C3" | "C4" | "C5" | "C6" | "C7" | "C8";

export const SCENARIO_CLASSES: readonly ScenarioClass[] = ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8"];

export const CLASS_LABELS: Record<ScenarioClass, string> = {
  C1: "old-fact",
  C2: "correction-wins",
  C3: "where-were-we",
  C4: "restart-mid-thread",
  C5: "who-said-it",
  C6: "standing-preference-under-volume",
  C7: "nothing-to-recall",
  C8: "forgetting-done-right",
};

/** Seconds since day 0, 00:00:00 UTC of the synthetic timeline (may be negative). */
export type TimelineSeconds = number;

interface EventBase {
  day: number;
  /** Seconds since day 0 00:00 UTC; the ordering key (events are even, filler odd). */
  t: TimelineSeconds;
  session: string;
  /** Conversation channel the event happened on. Absent = "primary" (the channel probes arrive on). */
  channel?: EventChannel;
}

/** "primary" = the person's main chat (probes arrive here); "secondary" = another chat of the same person. */
export type EventChannel = "primary" | "secondary";

/** Natural-language rendering for systems with no native equivalent of the kind. */
interface Rendered {
  asUser: string;
  asAssistant: string;
}

export interface ExchangeEvent extends EventBase {
  kind: "exchange";
  user: string;
  assistant: string;
}
export interface PersonFactEvent extends EventBase, Rendered {
  kind: "person_fact";
  /** The fact as a perfect extractor would store it. */
  text: string;
  durable: boolean;
}
export interface CorrectionEvent extends EventBase, Rendered {
  kind: "correction";
  /** Index (in this scenario's `events`) of the person_fact it corrects. */
  targetEventIndex: number;
  text: string;
}
export interface SessionEndEvent extends EventBase, Rendered {
  kind: "session_end";
  openWork: string;
}
export interface StandingEvent extends EventBase, Rendered {
  kind: "standing";
  text: string;
}
/** Process restart. Its rendering is empty: nothing to ingest. */
export interface RestartEvent extends EventBase, Rendered {
  kind: "restart";
}

export type CorpusEvent =
  | ExchangeEvent
  | PersonFactEvent
  | CorrectionEvent
  | SessionEndEvent
  | StandingEvent
  | RestartEvent;

export type ProbeSurface = "both" | "proactive" | "asked";

export interface Probe {
  day: number;
  t: TimelineSeconds;
  session: string;
  text: string;
  /** Every needle must be present (case-insensitive substring). Empty = C7: nothing may be recalled. */
  expect: string[];
  /**
   * Optional English rendering of `expect`, read only by the extracted leg's
   * `caught` (the consolidator writes facts in English): a fact catches the
   * probe when it holds every `expect` needle or, failing that, every
   * `expectEn` needle with accents and case folded. The scorer's hit / stale
   * never read it. Corpus v2 carries it on every probe with an expect needle
   * (corpus-v2.ts EXPECT_EN_ES, operator ruling B); v1 does not.
   */
  expectEn?: string[];
  /** Any needle present = stale hit. */
  forbid: string[];
  surface: ProbeSurface;
  /** C5: every occurrence of the expect needle must be attributed to this role. */
  expectAuthor?: "assistant" | "person";
  /**
   * v2: "shared" when the probe has at least one content token in common with
   * its target events (the events holding an expect needle; all events when
   * there is none), "disjoint" otherwise. Rule in README §Wording.
   */
  wording?: "shared" | "disjoint";
  /** v2, C5: who stated the figure, and whether the other side repeated it. */
  authorCase?: AuthorCase;
  /**
   * v2, C5: every role whose turn (user side = person, assistant side =
   * assistant) holds an expect needle, computed from the events. Strict
   * attribution fails an occurrence attributed to a role outside this set.
   */
  statedBy?: Array<"person" | "assistant">;
}

export type AuthorCase = "assistant" | "person" | "echo-person-first" | "echo-assistant-first";

export interface Scenario {
  id: string;
  class: ScenarioClass;
  /** Base scenario number within its class (same content across filler sizes). */
  base: number;
  lang: "es" | "en";
  fillerSize: number;
  fillerSeed: number;
  /** Filler window [fillerFromT, fillerToT) in timeline seconds; fillerFromT is even. */
  fillerFromT: TimelineSeconds;
  fillerToT: TimelineSeconds;
  events: CorpusEvent[];
  probes: Probe[];
  /** v2, C3/C4: primary-channel exchanges between the LAST session end and the probe (C4: before the restart). */
  gapRows?: number;
  /**
   * v2, C3/C4: "hydrate" = the probe arrives in a process that has not seen the
   * thread (load it from the store); "live" = the same process saw every
   * exchange as it happened (no reload); "interleave" = like hydrate, with
   * `otherChannelRows` secondary-channel exchanges mixed into the gap;
   * "restart" = C4, a real process restart after the gap.
   * Port 1 (session tail notes): "handoff" = like hydrate, with one complete
   * later session on another topic between the open work and the gap;
   * "crowded" = three such sessions; "closer" = like hydrate, with one short
   * closing exchange right after the open-work row in the same session (it
   * counts as the first of the K rows); "longcloser" = the same with small
   * talk of 8+ content tokens as the closer; "single" = like hydrate, with the
   * open work stated in a one-exchange session.
   */
  variant?: ScenarioVariant;
  otherChannelRows?: number;
}

export type ScenarioVariant =
  | "hydrate"
  | "live"
  | "interleave"
  | "restart"
  | "handoff"
  | "crowded"
  | "closer"
  | "longcloser"
  | "single";

export interface FillerSpec {
  algorithm: "xorshift32-template-v1";
  /** Per language: user templates, assistant templates; `{slot}` names index `vocab[lang]`. `{n}` = 2 + next() % 18. */
  templates: Record<"es" | "en", { user: string[]; assistant: string[] }>;
  vocab: Record<"es" | "en", Record<string, string[]>>;
}

export interface Corpus {
  version: string;
  seed: number;
  fillerSizes: number[];
  fillerSpec: FillerSpec;
  scenarios: Scenario[];
  /** v2: how clean the shared/disjoint split is (wording.ts `wordingAudit`, checked by validateCorpus). */
  wordingAudit?: WordingAudit;
}

export interface WordingAudit {
  /** Disjoint probes in the corpus (all sizes). */
  disjointProbes: number;
  /** Disjoint probes that share ANY token of 3+ letters/digits (stopwords included) with a target event. */
  disjointSharingAnyToken3: number;
  /** The shared tokens per leaking probe text (one entry per distinct probe text). */
  leaks: Array<{ class: string; text: string; tokens: string[] }>;
}

export interface FillerItem {
  t: TimelineSeconds;
  user: string;
  assistant: string;
}

// ---------------------------------------------------------------------------
// Adapter output (what the scorer reads)
// ---------------------------------------------------------------------------

/** One block the model would see (proactive) or one search result list (asked). */
export interface SurfaceComponent {
  name: string;
  /** True when the component's content depends on the probe text (a recall). C7 counts these items. */
  queryDriven: boolean;
  /** Exact text this component contributes to the payload. */
  text: string;
  /** Separable entries (one memory row, one turn, one fact) — used for counts and author markers. */
  items: string[];
  /** v2: "thread" (conversation history), "recall" (selected by the probe text), "ambient" (always-present block). Absent: queryDriven ? "recall" : "ambient". */
  kind?: ComponentKind;
  /** v2: the most items this component can return (a recall's maxResults). */
  cap?: number;
}

export type ComponentKind = "thread" | "recall" | "ambient";

export interface SurfaceResult {
  /** False when the adapter cannot assemble this surface faithfully; the scorer skips it. */
  measurable: boolean;
  note?: string;
  components: SurfaceComponent[];
  ms: number;
  /** v2: components the system built but its own prompt budget dropped (not in `components`). */
  dropped?: string[];
}

export interface ProbeRun {
  scenarioId: string;
  class: ScenarioClass;
  fillerSize: number;
  probeIndex: number;
  probe: Probe;
  proactive: SurfaceResult;
  asked: SurfaceResult;
  /** Rows written for this probe's timeline (conversations + facts). */
  ingestedRows: number;
  ingestMs: number;
  /** v2: copied from the scenario (withScenarioMeta fills them from the corpus). */
  gapRows?: number;
  variant?: ScenarioVariant;
  otherChannelRows?: number;
}

export interface SurfaceScore {
  scored: boolean;
  hit: boolean;
  staleHit: boolean;
  chars: number;
  ms: number;
  /** Items in queryDriven components. */
  recallItems: number;
  /** C7 only: query-driven items returned for a topic that never appeared. */
  irrelevantCount: number | null;
  /** Probes with expectAuthor only: EVERY occurrence of every expect needle is attributed to that role (strict). */
  authorMarked: boolean | null;
  /** v2, probes with expectAuthor: a needle sits on a line marked for one role inside a block whose heading attributes it to the other. */
  attributionConflict?: boolean | null;
  /** v2, probes with expectAuthor: SOME occurrence is attributed to that role (the v1 lenient rule). */
  authorMarkedAny?: boolean | null;
  /** v2, only when the marker spec sets `defaultRole`: the strict rule with unattributed occurrences counted as that role. */
  authorMarkedWithDefault?: boolean;
  /** v2: the probe declares this surface but the adapter could not measure it ("not scored"). */
  notMeasurable?: boolean;
  /** v2: components whose text carries at least one expect needle. */
  carriedBy?: string[];
  /** v2: kinds of those components (thread / recall / ambient). */
  carriedKinds?: ComponentKind[];
  /** v2: components whose text carries a forbid needle. */
  staleCarriedBy?: string[];
  /** v2: sum of the query-driven components' caps (null if any is uncapped). */
  recallCap?: number | null;
}

export interface ProbeScore {
  scenarioId: string;
  class: ScenarioClass;
  fillerSize: number;
  probeIndex: number;
  day: number;
  /** v2 metadata (absent on v1 corpora). */
  wording?: "shared" | "disjoint";
  authorCase?: AuthorCase;
  gapRows?: number;
  variant?: ScenarioVariant;
  otherChannelRows?: number;
  proactive: SurfaceScore;
  asked: SurfaceScore;
}
