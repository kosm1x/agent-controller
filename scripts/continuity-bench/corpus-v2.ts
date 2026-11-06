/**
 * Continuity Scorecard v2 corpus (benchmarks/continuity/corpus-v2.json).
 *
 * Same filler algorithm, seeds and spec as v1 (filler-golden.json is
 * unchanged). What v2 changes, per the round-1 audit:
 *   - C1 asks the SAME four phrasings at every age (day 1/7/30/90): age and
 *     wording are separate axes.
 *   - C3/C4 put K primary-channel exchanges BETWEEN the session end and the
 *     probe (`gapRows`), so the open work can fall out of a bounded history.
 *     C3 runs three variants: `hydrate` (a process that never saw the
 *     thread), `live` (the same process saw every exchange) and `interleave`
 *     (another channel's rows mixed into the gap). C4 restarts for real.
 *   - C5 covers figures the assistant stated, figures the person stated, and
 *     echoes (one side states, the other repeats).
 *   - every probe carries a mechanical `wording` label (wording.ts) and each
 *     class is roughly half "shared", half "disjoint".
 * All content is synthetic (made-up names, places, figures).
 */

import { FILLER_SPEC_V1, generateFiller } from "./filler.js";
import {
  ACK_EN,
  ACK_ES,
  CORPUS_SEED,
  FACTS,
  FIGURES,
  FILLER_SIZES,
  FORGETTING,
  FROM_MINUS_30,
  NEVER_MENTIONED,
  OPEN_WORK,
  STANDING,
  eventT,
  fillerSeedFor,
  openWorkEvents,
  probeT,
  type Draft,
} from "./generate.js";
import type { AuthorCase, Corpus, CorpusEvent, EventChannel, Probe, Scenario, ScenarioVariant } from "./types.js";
import { statedByOf, wordingAudit, wordingOf } from "./wording.js";

export const CORPUS_VERSION_V2 = "continuity-v2";

/** Gap sizes for C3/C4: around the router's 15-row thread buffer (router.ts THREAD_BUFFER_SIZE): 14 keeps the open work, 15 is the first K that drops it. */
export const GAP_ROWS = [0, 5, 14, 15, 16, 20, 60];
export const LIVE_GAP_ROWS = [5, 16];
export const INTERLEAVE = { gapRows: 5, otherChannelRows: 20 };

type P = Omit<Probe, "day" | "t" | "session" | "wording">;

function probe(day: number, j: number, rest: P): Probe {
  return { day, t: probeT(day, j), session: `d${day}`, ...rest };
}

function exchange(day: number, i: number, user: string, assistant: string, channel?: EventChannel): CorpusEvent {
  return { day, t: eventT(day, i), session: `d${day}`, kind: "exchange", user, assistant, ...(channel ? { channel } : {}) };
}

// ---------------------------------------------------------------------------
// C1 — four phrasings per fact (shared, disjoint, shared, disjoint), asked at every age.
// ---------------------------------------------------------------------------

const C1_ASK: Array<[string, string, string, string]> = [
  [
    "¿Cómo se llama mi perro?",
    "¿Recuerdas el apodo de mi can?",
    "Mi sobrina quiere saber el nombre de mi perro, ¿me lo dices?",
    "¿Cómo le decimos a la mascota de la casa?",
  ],
  [
    "Where does my sister live these days?",
    "Which town did my sibling relocate to?",
    "Remind me which city my sister moved to.",
    "I'm mailing a parcel to my sibling, what city do I write?",
  ],
  [
    "¿De cuánto es el presupuesto de la remodelación?",
    "¿Qué monto nos autorizaron en la obra?",
    "Recuérdame el presupuesto que nos dieron para la casa.",
    "¿Con cuánto dinero contamos en la obra de la casa?",
  ],
  [
    "Am I allergic to any medicine?",
    "What medication should doctors avoid giving me?",
    "My doctor asked what I'm allergic to, can you remind me?",
    "Which antibiotic gives me a reaction?",
  ],
  [
    "¿A qué escuela va a entrar mi hija?",
    "¿En cuál colegio va a estudiar la niña?",
    "Tengo que llenar un formulario, ¿cómo se llama la escuela de mi hija?",
    "Recuérdame el nombre del colegio nuevo de la niña.",
  ],
  [
    "What's the code to open the office gate?",
    "I'm at our building entrance, what are those digits again?",
    "Remind me the office gate number.",
    "What number do I punch in at our front door at work?",
  ],
];

function buildC1(b: number): Draft {
  const f = FACTS[b];
  const events: CorpusEvent[] = [
    { day: 0, t: eventT(0, 0), session: "d0", kind: "person_fact", text: f.text, durable: true, asUser: f.say, asAssistant: f.ack },
  ];
  const probes = [1, 7, 30, 90].flatMap((day) =>
    C1_ASK[b].map((text, j) => probe(day, j, { text, expect: [f.needle], forbid: [], surface: "both" })),
  );
  return { class: "C1", base: b + 1, lang: f.lang, fillerFromT: FROM_MINUS_30, fillerToT: probes[probes.length - 1].t, events, probes };
}

// ---------------------------------------------------------------------------
// C2 — the corrected value, asked with shared and with disjoint words.
// ---------------------------------------------------------------------------

/** For FACTS[2..7]. */
const C2_DISJOINT = [
  "¿Con cuánto dinero contamos ya en la obra de la casa?",
  "Which medicines must a pharmacist never hand me?",
  "¿Dónde va a estudiar la niña este año?",
  "I'm at our building entrance, what digits do I punch in?",
  "¿A qué lugar vamos a celebrar los años de casados?",
  "A parking form wants my registration tag, what is it?",
];

function buildC2(b: number): Draft {
  const f = FACTS[b + 2];
  const events: CorpusEvent[] = [
    { day: 0, t: eventT(0, 0), session: "d0", kind: "person_fact", text: f.text, durable: true, asUser: f.say, asAssistant: f.ack },
    { day: 5, t: eventT(5, 1), session: "d5", kind: "correction", targetEventIndex: 0, text: f.fixText, asUser: f.fixSay, asAssistant: f.fixAck },
  ];
  const probes = [f.askAfterFix, C2_DISJOINT[b]].map((text, j) =>
    probe(10, j, { text, expect: [f.fixNeedle], forbid: [f.needle], surface: "both" }),
  );
  return { class: "C2", base: b + 1, lang: f.lang, fillerFromT: FROM_MINUS_30, fillerToT: probes[1].t, events, probes };
}

// ---------------------------------------------------------------------------
// C3 / C4 — open work, then K unrelated exchanges, then the probe.
// ---------------------------------------------------------------------------

/** A greeting that names the task (shared words); the bare greeting is the disjoint probe. */
const C3_TOPICAL = [
  "Hola, ¿seguimos con el informe de Valdoria?",
  "hey, can we get back to the Merriton slides?",
  "Buenos días, ¿cómo va lo del viaje a Zacatlán?",
  "I'm back. Shall we finish the Pellham letter?",
  "¿Continuamos con lo de Tilapo?",
  "Morning! Can we finish the receipts?",
];

/** Deterministic unrelated exchanges for a gap: the v1 filler generator under a derived seed. */
function gapTexts(seed: number, n: number): Array<{ user: string; assistant: string }> {
  if (n === 0) return [];
  return generateFiller(FILLER_SPEC_V1, { seed: (seed ^ 0x5bd1e995) >>> 0, size: n, fromT: 0, toT: 2 * n }).map((i) => ({
    user: i.user,
    assistant: i.assistant,
  }));
}

/**
 * Gap exchanges starting at slot `from` of `day`: `primary` rows on the
 * probe's channel and `other` secondary-channel rows; with both, every
 * (other / primary)-th slot run is secondary, then one primary.
 */
function gapEvents(seed: number, day: number, from: number, primary: number, other: number): CorpusEvent[] {
  const texts = gapTexts(seed, primary + other);
  const out: CorpusEvent[] = [];
  const perPrimary = primary > 0 ? Math.floor(other / primary) : other;
  let p = 0;
  let o = 0;
  while (p + o < primary + other) {
    const slot = from + p + o;
    const takeOther = o < other && (p >= primary || o < (p + 1) * perPrimary);
    const { user, assistant } = texts[p + o];
    out.push(exchange(day, slot, user, assistant, takeOther ? "secondary" : undefined));
    if (takeOther) o++;
    else p++;
  }
  return out;
}

function buildOpenWork(cls: "C3" | "C4", b: number, variant: ScenarioVariant, gapRows: number, otherChannelRows = 0): Draft {
  const w = OPEN_WORK[b];
  const events = openWorkEvents(w);
  const seed = fillerSeedFor(cls, b + 1) ^ Math.imul(gapRows + 1, 0x27d4eb2f) ^ otherChannelRows;
  let probeDay: number;
  if (cls === "C3") {
    events.push(...gapEvents(seed, 1, 0, gapRows, otherChannelRows));
    probeDay = 3;
  } else {
    events.push(...gapEvents(seed, 0, events.length, gapRows, 0));
    events.push({ day: 0, t: eventT(0, events.length), session: "d0", kind: "restart", asUser: "", asAssistant: "" });
    probeDay = 0;
  }
  const greet = cls === "C3" ? w.greetLater : w.greetAfterRestart;
  const probes = [greet, C3_TOPICAL[b]].map((text, j) =>
    probe(probeDay, j, { text, expect: [w.needle], forbid: [], surface: "proactive" }),
  );
  return {
    class: cls,
    base: b + 1,
    lang: w.lang,
    fillerFromT: FROM_MINUS_30,
    fillerToT: 0,
    events,
    probes,
    gapRows,
    variant,
    ...(otherChannelRows ? { otherChannelRows } : {}),
  };
}

// ---------------------------------------------------------------------------
// C5 — who said the figure.
// ---------------------------------------------------------------------------

interface AuthorTopic {
  lang: "es" | "en";
  authorCase: AuthorCase;
  /** Exchanges in order; the needle sits where `authorCase` says. */
  turns: Array<[string, string]>;
  needle: string;
  shared: string;
  disjoint: string;
}

const C5_ASSISTANT_SHARED = [
  "¿Cuánto quedamos que era la renta del local?",
  "How long did we say the trip to the cabin takes?",
  "¿Cuántos invitados dijimos que caben en el salón?",
  "What rate did we settle on for the loan?",
  "¿Cuánto pesaba la caja del envío?",
  "When did we say the warranty expires?",
];

const C5_ASSISTANT_DISJOINT = [
  "¿Qué cifra me diste para alquilar el changarro de la esquina?",
  "What travel time did you give me for our lake getaway?",
  "¿Para cuánta gente alcanza el lugar de la fiesta?",
  "How much will my bank charge me to borrow, per your estimate?",
  "¿Qué peso le calculaste al paquete enviado?",
  "Through which month is our fridge covered?",
];

const C5_TOPICS: AuthorTopic[] = [
  ...FIGURES.map((f, i): AuthorTopic => ({
    lang: f.lang,
    authorCase: "assistant",
    turns: [[f.ask, f.claim]],
    needle: f.needle,
    shared: C5_ASSISTANT_SHARED[i],
    disjoint: C5_ASSISTANT_DISJOINT[i],
  })),
  {
    lang: "es",
    authorCase: "person",
    turns: [["Me cotizaron la mudanza en 14.780 pesos con la empresa Tlacuache.", "Va, lo tomo en cuenta para el presupuesto."]],
    needle: "14.780",
    shared: "¿En cuánto me cotizaron la mudanza?",
    disjoint: "¿Qué precio me pasaron por cambiarme de casa?",
  },
  {
    lang: "en",
    authorCase: "person",
    turns: [["The contractor quoted me 26 working days for the Ashgrove kitchen.", "Okay, I'll plan around that."]],
    needle: "26 working days",
    shared: "How long did the contractor quote for the kitchen?",
    disjoint: "When should our renovation crew be finished, going by their estimate?",
  },
  {
    lang: "es",
    authorCase: "person",
    turns: [["El médico me indicó tomar 850 miligramos cada doce horas.", "Entendido, te lo recuerdo cuando haga falta."]],
    needle: "850 miligramos",
    shared: "¿Cuántos miligramos me indicó el médico?",
    disjoint: "¿Qué dosis me toca de la pastilla?",
  },
  {
    lang: "en",
    authorCase: "person",
    turns: [["My landlord says the deposit will be 2,350 dollars.", "Thanks, noted for the move."]],
    needle: "2,350",
    shared: "What deposit did my landlord ask for?",
    disjoint: "How much money must I pay up front on that flat?",
  },
  {
    lang: "es",
    authorCase: "person",
    turns: [["La reunión con el notario quedó para el 17 de marzo.", "Perfecto, lo agendo."]],
    needle: "17 de marzo",
    shared: "¿Cuándo es la reunión con el notario?",
    disjoint: "¿Qué fecha firmamos las escrituras?",
  },
  {
    lang: "en",
    authorCase: "person",
    turns: [["The vet said the dog should weigh 31 kilos at most.", "Good to know, I'll keep an eye on it."]],
    needle: "31 kilos",
    shared: "What weight did the vet give for the dog?",
    disjoint: "How heavy is our puppy allowed to get?",
  },
  {
    lang: "es",
    authorCase: "echo-person-first",
    turns: [["El vuelo sale a las 6:35 de la mañana.", "Anotado: el vuelo sale a las 6:35, conviene salir de casa con tiempo."]],
    needle: "6:35",
    shared: "¿A qué hora sale el vuelo?",
    disjoint: "¿Cuándo despega el avión?",
  },
  {
    lang: "en",
    authorCase: "echo-person-first",
    turns: [["My passport number ends in 4417.", "Got it, passport ending 4417."]],
    needle: "4417",
    shared: "What does my passport number end in?",
    disjoint: "Which digits close out my travel document ID?",
  },
  {
    lang: "es",
    authorCase: "echo-assistant-first",
    turns: [
      ["¿Cuánto mide de largo la sala?", "Según el plano, la sala mide 5,20 metros."],
      ["Va, 5,20 metros entonces.", "Exacto."],
    ],
    needle: "5,20 metros",
    shared: "¿Cuánto mide la sala?",
    disjoint: "¿Qué dimensión tiene la estancia?",
  },
  {
    lang: "en",
    authorCase: "echo-assistant-first",
    turns: [
      ["How far is the trailhead from the parking lot?", "The map shows about 2.8 miles."],
      ["Okay, 2.8 miles, noted.", "Right."],
    ],
    needle: "2.8 miles",
    shared: "How far is the trailhead?",
    disjoint: "What distance did we figure to reach our hike's start?",
  },
];


/** The role whose statement the probe asks about: the first one to state the figure. */
function expectedAuthor(c: AuthorCase): "person" | "assistant" {
  return c === "person" || c === "echo-person-first" ? "person" : "assistant";
}

function buildC5(b: number): Draft {
  const a = C5_TOPICS[b];
  const events = a.turns.map(([u, r], i) => exchange(0, i, u, r));
  const probes = [a.shared, a.disjoint].map((text, j) =>
    probe(2, j, {
      text,
      expect: [a.needle],
      forbid: [],
      surface: "both",
      expectAuthor: expectedAuthor(a.authorCase),
      authorCase: a.authorCase,
      statedBy: statedByOf(events, [a.needle]),
    }),
  );
  return { class: "C5", base: b + 1, lang: a.lang, fillerFromT: FROM_MINUS_30, fillerToT: probes[1].t, events, probes };
}

/**
 * v2 rewordings of probe texts that v1 shares with v2 (v1 keeps the original):
 * the same request without a function word its target events also use, so
 * the disjoint label is not undercut by "the" / "you" / "que" matches.
 */
const V2_REWORD: Record<string, string> = {
  "Draft a short note to my team about the Friday plan.": "Draft a short note to my team about our Friday plan.",
  "Summarize the main points of the article I sent you.": "Summarize the main points of my last article upload.",
  "What did I tell you about my cousin's beekeeping hobby?": "What did I mention about my cousin's beekeeping hobby?",
  "¿Recuerdas lo que te dije del contrato del velero?": "¿Recuerdas lo dicho sobre el contrato del velero?",
  "What was the name of the violin teacher I mentioned?": "Which violin teacher did I mention, and her name?",
};
const v2Text = (t: string) => V2_REWORD[t] ?? t;

// ---------------------------------------------------------------------------
// C6 — a standing preference, then a request it applies to.
// ---------------------------------------------------------------------------

/** Second request per preference; with STANDING[i].later one of the pair shares words with the preference. */
const C6_SECOND = [
  "Escríbeme unos párrafos sobre el interés compuesto.",
  "What temperatures should I expect in the mountains this weekend?",
  "Ponme una llamada con el contador el jueves temprano.",
  "Draft a note to my team, and sign it the way I always ask.",
  "Tengo una duda de salud: me salió alta la presión, ¿qué hago?",
  "Write me a summary of the article I sent you.",
];

function buildC6(b: number): Draft {
  const p = STANDING[b];
  const events: CorpusEvent[] = [
    { day: 0, t: eventT(0, 0), session: "d0", kind: "standing", text: p.text, asUser: p.say, asAssistant: p.lang === "es" ? ACK_ES : ACK_EN },
  ];
  const probes = [v2Text(p.later), C6_SECOND[b]].map((text, j) => probe(30, j, { text, expect: [p.needle], forbid: [], surface: "proactive" }));
  return { class: "C6", base: b + 1, lang: p.lang, fillerFromT: 10 * 3600, fillerToT: probes[1].t, events, probes };
}

// ---------------------------------------------------------------------------
// C7 — a topic that never came up; the second probe baits with a word from the warm-up.
// ---------------------------------------------------------------------------

const C7_BAIT = [
  "¿Qué te conté de la serie de ajedrez que vio mi sobrino?",
  "What did I tell you about my cousin's vegetables from the beehive farm?",
  "¿Recuerdas lo que te dije del velero que compré en Madrid?",
  "What was the name of the violin teacher with the orange door?",
  "¿Qué te comenté de los litros de esmalte para la cerámica de mi mamá?",
  "Remind me what I said about the water tank for the rooftop garden at work.",
];

function buildC7(b: number): Draft {
  const n = NEVER_MENTIONED[b];
  const events = n.warmup.map(([u, a], i) => exchange(0, i, u, a));
  const probes = [v2Text(n.probe), C7_BAIT[b]].map((text, j) => probe(14, j, { text, expect: [], forbid: [], surface: "both" }));
  return { class: "C7", base: b + 1, lang: n.lang, fillerFromT: FROM_MINUS_30, fillerToT: probes[1].t, events, probes };
}

// ---------------------------------------------------------------------------
// C8 — a durable and a temporary fact; the second probe avoids the durable fact's words or uses them.
// ---------------------------------------------------------------------------

const C8_SECOND = [
  "Para la transfusión, ¿qué grupo sanguíneo pongo y desde dónde estoy trabajando?",
  "For a passport form: what goes between my first and last names, and which phone am I on?",
  "Llevo años con una dieta especial, ¿qué restricciones de comida tengo?",
  "What's the name of my company, and which branch am I covering?",
  "Para la sucursal: ¿con qué folio me identifico y dónde dejé el auto?",
  "When do we throw our girl's party, and what time do I collect her from class?",
];

function buildC8(b: number): Draft {
  const f = FORGETTING[b];
  const events: CorpusEvent[] = [
    { day: 0, t: eventT(0, 0), session: "d0", kind: "person_fact", text: f.durableText, durable: true, asUser: f.durableSay, asAssistant: f.lang === "es" ? "Anotado." : "Noted." },
    { day: 0, t: eventT(0, 1), session: "d0", kind: "person_fact", text: f.tempText, durable: false, asUser: f.tempSay, asAssistant: f.lang === "es" ? "Va, lo tomo en cuenta esta semana." : "Ok, noted for this week." },
  ];
  const probes = [f.probe, C8_SECOND[b]].map((text, j) =>
    probe(120, j, { text, expect: [f.durableNeedle], forbid: [f.tempNeedle], surface: "both" }),
  );
  return { class: "C8", base: b + 1, lang: f.lang, fillerFromT: FROM_MINUS_30, fillerToT: probes[1].t, events, probes };
}

// ---------------------------------------------------------------------------

interface DraftV2 extends Draft {
  /** Scenario id stem after the base number (C3/C4 variants). */
  tag?: string;
}

function draftsV2(): DraftV2[] {
  const out: DraftV2[] = [];
  for (let b = 0; b < 6; b++) out.push(buildC1(b));
  for (let b = 0; b < 6; b++) out.push(buildC2(b));
  for (let b = 0; b < 6; b++) {
    for (const k of GAP_ROWS) out.push({ ...buildOpenWork("C3", b, "hydrate", k), tag: `h${k}` });
    for (const k of LIVE_GAP_ROWS) out.push({ ...buildOpenWork("C3", b, "live", k), tag: `l${k}` });
    out.push({
      ...buildOpenWork("C3", b, "interleave", INTERLEAVE.gapRows, INTERLEAVE.otherChannelRows),
      tag: `i${INTERLEAVE.gapRows}x${INTERLEAVE.otherChannelRows}`,
    });
  }
  for (let b = 0; b < 6; b++) for (const k of GAP_ROWS) out.push({ ...buildOpenWork("C4", b, "restart", k), tag: `r${k}` });
  for (let b = 0; b < C5_TOPICS.length; b++) out.push(buildC5(b));
  for (let b = 0; b < 6; b++) out.push(buildC6(b));
  for (let b = 0; b < 6; b++) out.push(buildC7(b));
  for (let b = 0; b < 6; b++) out.push(buildC8(b));
  return out;
}

export function buildCorpusV2(version = CORPUS_VERSION_V2): Corpus {
  const scenarios: Scenario[] = [];
  for (const size of FILLER_SIZES) {
    for (const d of draftsV2()) {
      const { tag, ...rest } = d;
      const s: Scenario = {
        ...rest,
        id: `${d.class}-${String(d.base).padStart(2, "0")}${tag ? `-${tag}` : ""}-s${size}`,
        fillerSize: size,
        fillerSeed: fillerSeedFor(d.class, d.base),
        probes: d.probes.map((p) => ({ ...p, wording: wordingOf(d.events, p) })),
      };
      // Stable key order: the v1 keys first, then the v2 ones.
      scenarios.push({
        id: s.id,
        class: s.class,
        base: s.base,
        lang: s.lang,
        fillerSize: s.fillerSize,
        fillerSeed: s.fillerSeed,
        fillerFromT: s.fillerFromT,
        fillerToT: s.fillerToT,
        events: s.events,
        probes: s.probes,
        ...(s.gapRows !== undefined ? { gapRows: s.gapRows } : {}),
        ...(s.variant ? { variant: s.variant } : {}),
        ...(s.otherChannelRows !== undefined ? { otherChannelRows: s.otherChannelRows } : {}),
      });
    }
  }
  return { version, seed: CORPUS_SEED, fillerSizes: FILLER_SIZES, fillerSpec: FILLER_SPEC_V1, wordingAudit: wordingAudit({ scenarios }), scenarios };
}
