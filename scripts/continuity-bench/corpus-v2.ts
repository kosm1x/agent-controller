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
 *   - Port 1 (appended; the scenarios before them are unchanged): C3
 *     `handoff`, `crowded` and `closer` (buildTailVariant), then, appended
 *     after those, `single` and `longcloser` (the reader's known limits).
 *   - Port 3 (appended after those; tombstones, qa R1 W4): C2 corrections
 *     whose row repeats the old figure (`rp`, with the new one; `nf`, no new
 *     figure yet), a correction that only rewords a durable fact (`rw`), and
 *     a C8 temporary fact sharing its figure with the live durable one (`lv`),
 *     then (qa R2 W2) four C8 temporary facts with a TRANSIENT_FACT_RE
 *     snapshot marker and a figure (`sn`).
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
// Port 1 (session tail notes) — C3 variants with later sessions / a closer.
// ---------------------------------------------------------------------------

/** handoff / crowded gap sizes; closer, longcloser and single run at K = 16 (a closer is the first of the 16). */
export const HANDOFF_GAP_ROWS = [15, 20];
export const CLOSER_GAP_ROWS = 16;

/**
 * Complete later sessions on other topics, per language: two exchanges (the
 * second is the session's last substantive one) and a short wrap. No two
 * sessions, and no session and an OPEN_WORK wrap, share two 5+-letter words.
 */
const LATER_SESSIONS: Record<"es" | "en", Array<Array<[string, string]>>> = {
  es: [
    [
      ["Ayúdame a elegir el menú para la cena del sábado.", "Propongo crema de calabaza, pollo al horno y flan de postre."],
      ["Perfecto, cambia el flan por pastel de elote.", "Hecho, el menú lleva pastel de elote."],
    ],
    [
      ["Necesito una rutina corta de estiramientos para la mañana.", "Te armé cinco movimientos de cuello, hombros y espalda baja."],
      ["Agrega uno para las muñecas.", "Agregué círculos de muñeca, ya son seis movimientos."],
    ],
    [
      ["Revisa mi lista de lectura para diciembre.", "Tienes cuatro novelas y un ensayo; el orden por extensión funciona."],
      ["Quita el ensayo, prefiero solo ficción.", "Quitado, quedan las cuatro novelas en orden."],
    ],
  ],
  en: [
    [
      ["Plan a short birthday picnic for my nephew.", "Sure: sandwiches, lemonade and a kite at the riverside park."],
      ["Swap the lemonade for juice boxes.", "Swapped, the picnic list now has juice boxes."],
    ],
    [
      ["Suggest a weekly watering schedule for my balcony plants.", "Water the ferns Monday and Thursday, the cactus every other Sunday."],
      ["Add the basil pot near the window too.", "Added basil: a little water every morning before noon."],
    ],
    [
      ["Sort my podcast queue for the commute.", "I grouped it into history, science and comedy episodes."],
      ["Put the science episodes first in the queue.", "Moved them, science episodes now lead the commute queue."],
    ],
  ],
};
const LATER_WRAP: Record<"es" | "en", { asUser: string; asAssistant: string; openWork: string }> = {
  es: { asUser: "Gracias, es todo.", asAssistant: "Listo, nada pendiente.", openWork: "nada pendiente" },
  en: { asUser: "Thanks, that's all.", asAssistant: "Done, nothing open.", openWork: "nothing open" },
};
const CLOSER: Record<"es" | "en", [string, string]> = {
  es: ["Gracias.", "De nada, hasta luego."],
  en: ["Thanks a lot!", "Anytime, talk soon."],
};
/** Small talk long enough (8+ content tokens) to read as substantive. */
const LONG_CLOSER: Record<"es" | "en", [string, string]> = {
  es: [
    "Gracias, mañana temprano salgo a correr al parque con mi hermana y luego desayunamos.",
    "Qué buen plan, disfruta la carrera por el parque y el desayuno con tu hermana.",
  ],
  en: [
    "Thanks, tomorrow morning I am jogging around the lake with my sister before breakfast.",
    "Sounds lovely, enjoy the jog around the lake and breakfast with your sister.",
  ],
};

/**
 * handoff: open work (day 0), one complete session on another topic (day 4),
 * K gap rows (day 5), probes day 5 — the open work is then over 72 h old.
 * crowded: the same with three later sessions (days 2, 3, 4). closer: the
 * hydrate timeline with one short closing exchange right after the open-work
 * row (same session), counted as the first of the K rows. longcloser: the
 * same with small talk of 8+ content tokens as the closer. single: the
 * hydrate timeline with the open work stated in a one-exchange session (the
 * session_end row alone).
 */
function buildTailVariant(
  b: number,
  variant: "handoff" | "crowded" | "closer" | "longcloser" | "single",
  gapRows: number,
): Draft {
  const w = OPEN_WORK[b];
  const events = openWorkEvents(w);
  const seed = fillerSeedFor("C3", b + 1) ^ Math.imul(gapRows + 1, 0x27d4eb2f);
  let probeDay: number;
  if (variant === "closer" || variant === "longcloser") {
    events.push(exchange(0, events.length, ...(variant === "closer" ? CLOSER : LONG_CLOSER)[w.lang]));
    events.push(...gapEvents(seed, 1, 0, gapRows - 1, 0));
    probeDay = 3;
  } else if (variant === "single") {
    const end = events[events.length - 1];
    events.splice(0, events.length, { ...end, t: eventT(0, 0) });
    events.push(...gapEvents(seed, 1, 0, gapRows, 0));
    probeDay = 3;
  } else {
    const days = variant === "handoff" ? [4] : [2, 3, 4];
    for (const [i, day] of days.entries()) {
      const turns = LATER_SESSIONS[w.lang][variant === "handoff" ? b % 3 : i];
      const later = turns.map(([u, a], j) => exchange(day, j, u, a));
      const wrap = LATER_WRAP[w.lang];
      later.push({ day, t: eventT(day, later.length), session: `d${day}`, kind: "session_end", ...wrap });
      events.push(...later);
    }
    events.push(...gapEvents(seed, 5, 0, gapRows, 0));
    probeDay = 5;
  }
  const probes = [w.greetLater, C3_TOPICAL[b]].map((text, j) =>
    probe(probeDay, j, { text, expect: [w.needle], forbid: [], surface: "proactive" }),
  );
  return { class: "C3", base: b + 1, lang: w.lang, fillerFromT: FROM_MINUS_30, fillerToT: 0, events, probes, gapRows, variant };
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
// Port 3 — the tombstone cases (qa R1 W4), on FACTS[2] (the budget) and new topics.
// ---------------------------------------------------------------------------

/** C2 on the budget whose correction row repeats the old figure: with the new one (`rp`) or none yet (`nf`). */
function buildC2Repeat(kind: "rp" | "nf"): Draft {
  const f = FACTS[2];
  const fix =
    kind === "rp"
      ? {
          text: "El presupuesto aprobado para la remodelación de la persona es de 4.120.000 pesos.",
          asUser: "Ya no es 3.847.215, ahora es 4.120.000.",
          asAssistant: "Entendido, ajusto la referencia a 4.120.000.",
          needle: "4.120.000",
        }
      : {
          text: "El presupuesto de la remodelación de la persona cambió; el monto nuevo llega luego.",
          asUser: "Ya no es 3.847.215, te paso el monto nuevo luego.",
          asAssistant: "Entendido, quedo pendiente del monto nuevo.",
          needle: "monto nuevo",
        };
  const events: CorpusEvent[] = [
    { day: 0, t: eventT(0, 0), session: "d0", kind: "person_fact", text: f.text, durable: true, asUser: f.say, asAssistant: f.ack },
    { day: 5, t: eventT(5, 1), session: "d5", kind: "correction", targetEventIndex: 0, text: fix.text, asUser: fix.asUser, asAssistant: fix.asAssistant },
  ];
  const probes = [f.askAfterFix, C2_DISJOINT[0]].map((text, j) =>
    probe(10, j, { text, expect: [fix.needle], forbid: [f.needle], surface: "both" }),
  );
  return { class: "C2", base: 1, lang: f.lang, fillerFromT: FROM_MINUS_30, fillerToT: probes[1].t, events, probes };
}

/** A correction that only rewords a durable fact, dropping a word the probe still asks for: nothing is stale. */
function buildC2Reword(): Draft {
  const events: CorpusEvent[] = [
    {
      day: 0,
      t: eventT(0, 0),
      session: "d0",
      kind: "person_fact",
      text: "Rocío, la prima de la persona, vive en Monterrey con su hermana.",
      durable: true,
      asUser: "Mi prima Rocío vive en Monterrey con su hermana.",
      asAssistant: "Qué bien, lo anoto.",
    },
    {
      day: 5,
      t: eventT(5, 1),
      session: "d5",
      kind: "correction",
      targetEventIndex: 0,
      text: "Rocío, la prima de la persona, vive con su hermana.",
      asUser: "Rocío sigue viviendo con su hermana, por cierto.",
      asAssistant: "Anotado.",
    },
  ];
  const probes = ["¿En qué ciudad vive mi prima Rocío?", "Le mando un regalo a mi familiar, ¿a cuál zona del país lo envío?"].map((text, j) =>
    probe(10, j, { text, expect: ["Monterrey"], forbid: [], surface: "both" }),
  );
  return { class: "C2", base: 1, lang: "es", fillerFromT: FROM_MINUS_30, fillerToT: probes[1].t, events, probes };
}

/** C8 whose temporary fact shares its figure with the durable one: its expiry must not silence the durable figure. */
function buildC8Live(): Draft {
  const events: CorpusEvent[] = [
    {
      day: 0,
      t: eventT(0, 0),
      session: "d0",
      kind: "person_fact",
      text: "El gafete de empleado de la persona es el 6614.",
      durable: true,
      asUser: "Mi gafete de empleado es el 6614.",
      asAssistant: "Anotado.",
    },
    {
      day: 0,
      t: eventT(0, 1),
      session: "d0",
      kind: "person_fact",
      text: "Esta semana la persona estaciona en el cajón 6614 del sótano (solo esta semana).",
      durable: false,
      asUser: "Esta semana me tocó el cajón 6614 del sótano, igual que mi gafete.",
      asAssistant: "Va, lo tomo en cuenta esta semana.",
    },
  ];
  const probes = ["¿Cuál es mi número de gafete?", "En la recepción me piden mi identificación laboral, ¿qué cifra doy?"].map((text, j) =>
    probe(120, j, { text, expect: ["6614"], forbid: ["sótano"], surface: "both" }),
  );
  return { class: "C8", base: 1, lang: "es", fillerFromT: FROM_MINUS_30, fillerToT: probes[1].t, events, probes };
}

/**
 * C8 whose temporary fact carries a snapshot marker TRANSIENT_FACT_RE accepts
 * ("semana 14", "Day 3", "W22", "roster") and a figure (qa R2 W2): the one
 * kind of expiry that writes a tombstone. One per C8 figure type (a phone
 * ending, a time, a locker number, a code); the second probe avoids the
 * durable fact's words.
 */
const SNAPSHOT: Array<{
  lang: "es" | "en";
  durableText: string;
  durableSay: string;
  durableNeedle: string;
  tempText: string;
  tempSay: string;
  tempNeedle: string;
  probes: [string, string];
}> = [
  {
    lang: "es",
    durableText: "El tipo de sangre de la persona es B negativo.",
    durableSay: "Mi tipo de sangre es B negativo.",
    durableNeedle: "B negativo",
    tempText: "En la semana 14 la persona usa el teléfono de repuesto que termina en 5307.",
    tempSay: "En la semana 14 traigo el teléfono de repuesto, el que termina en 5307.",
    tempNeedle: "5307",
    probes: [
      "Para el formulario médico: ¿qué tipo de sangre tengo y a qué teléfono me marcan?",
      "Para la transfusión, ¿qué grupo sanguíneo pongo y a qué número me localizan?",
    ],
  },
  {
    lang: "en",
    durableText: "The person's son's birthday is July 9.",
    durableSay: "My son's birthday is July 9.",
    durableNeedle: "July 9",
    tempText: "On Day 3 of the camp, the person picks up their son at 4:15.",
    tempSay: "It's Day 3 of the camp, so I pick my son up at 4:15.",
    tempNeedle: "4:15",
    probes: ["When is my son's birthday, and what time do I pick him up?", "When do we throw our boy's party, and what time do I collect him?"],
  },
  {
    lang: "es",
    durableText: "El número de socio del gimnasio de la persona es 77-3051.",
    durableSay: "Mi número de socio del gimnasio es 77-3051.",
    durableNeedle: "77-3051",
    tempText: "En la W22 la persona usa el casillero 818 del gimnasio.",
    tempSay: "En la W22 me dieron el casillero 818 del gimnasio.",
    tempNeedle: "818",
    probes: [
      "¿Cuál es mi número de socio del gimnasio y qué casillero uso?",
      "Para entrar al club deportivo, ¿con qué membresía me identifico y en cuál taquilla dejo mis cosas?",
    ],
  },
  {
    lang: "en",
    durableText: "The person's team is the Harbor Owls.",
    durableSay: "I play for the Harbor Owls.",
    durableNeedle: "Harbor Owls",
    tempText: "On this week's roster the person has kit code KT-5124.",
    tempSay: "On this week's roster my kit code is KT-5124.",
    tempNeedle: "KT-5124",
    probes: ["Which team do I play for, and what's my kit code?", "Filling in a league sign-up: which club am I with, and which uniform code is mine?"],
  },
];

function buildC8Snapshot(b: number): Draft {
  const f = SNAPSHOT[b];
  const events: CorpusEvent[] = [
    { day: 0, t: eventT(0, 0), session: "d0", kind: "person_fact", text: f.durableText, durable: true, asUser: f.durableSay, asAssistant: f.lang === "es" ? "Anotado." : "Noted." },
    { day: 0, t: eventT(0, 1), session: "d0", kind: "person_fact", text: f.tempText, durable: false, asUser: f.tempSay, asAssistant: f.lang === "es" ? "Va, lo tomo en cuenta." : "Ok, noted." },
  ];
  const probes = f.probes.map((text, j) => probe(120, j, { text, expect: [f.durableNeedle], forbid: [f.tempNeedle], surface: "both" }));
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
  // Port 1 additions, appended so the scenarios above keep their order and bytes.
  for (let b = 0; b < 6; b++) {
    for (const k of HANDOFF_GAP_ROWS) out.push({ ...buildTailVariant(b, "handoff", k), tag: `ho${k}` });
    out.push({ ...buildTailVariant(b, "closer", CLOSER_GAP_ROWS), tag: `cl${CLOSER_GAP_ROWS}` });
    for (const k of HANDOFF_GAP_ROWS) out.push({ ...buildTailVariant(b, "crowded", k), tag: `cr${k}` });
  }
  // Port 1 fold: the reader's known limits, appended after the rows above.
  for (let b = 0; b < 6; b++) {
    out.push({ ...buildTailVariant(b, "single", CLOSER_GAP_ROWS), tag: `sg${CLOSER_GAP_ROWS}` });
    out.push({ ...buildTailVariant(b, "longcloser", CLOSER_GAP_ROWS), tag: `lc${CLOSER_GAP_ROWS}` });
  }
  // Port 3: the tombstone cases, appended after the rows above.
  out.push({ ...buildC2Repeat("rp"), tag: "rp" }, { ...buildC2Repeat("nf"), tag: "nf" }, { ...buildC2Reword(), tag: "rw" }, { ...buildC8Live(), tag: "lv" });
  // Port 3 R2 fold: C8 snapshot expiries, appended after the rows above.
  for (let b = 0; b < SNAPSHOT.length; b++) out.push({ ...buildC8Snapshot(b), tag: "sn" });
  return out;
}

/**
 * Ruling B (queue 4bo i, 2026-11-08): the English rendering of each Spanish
 * scenario's expect needle, as the consolidator writes facts in English
 * (read only by the extracted leg's `caught`, adapter factCatches). Names
 * stay as they are; figures take the English separators (3.847.215 →
 * 3,847,215; 23,6 → 23.6; 5,20 → 5.2, which also matches 5.20) and lose their
 * unit (kilos / kg, miligramos / mg, personas / people vary); a date reads
 * month first; a phrase keeps the words a rendering of it shares (checked
 * against the archived 62edad61 / 7610bb8e extracted facts for C2 / C6 / C8:
 * "short bullet points", "before 10:00 AM", "direct ... when discussing
 * health"). An English scenario's needle is its own rendering.
 */
export const EXPECT_EN_ES: Readonly<Record<string, string[]>> = {
  Corvalino: ["Corvalino"],
  "3.847.215": ["3,847,215"],
  Arrayanes: ["Arrayanes"],
  "2.960.400": ["2,960,400"],
  Tamarindos: ["Tamarindos"],
  "Casa Nopalera": ["Casa Nopalera"],
  "4.120.000": ["4,120,000"],
  "monto nuevo": ["new amount"],
  Monterrey: ["Monterrey"],
  "anexo de proveedores": ["supplier annex"],
  "boletos de regreso": ["return tickets"],
  "segundo semestre": ["second semester"],
  "18.450": ["18,450"],
  "135 personas": ["135"],
  "23,6 kilos": ["23.6"],
  "14.780": ["14,780"],
  "850 miligramos": ["850"],
  "17 de marzo": ["March 17"],
  "6:35": ["6:35"],
  "5,20 metros": ["5.2"],
  viñetas: ["bullet"],
  "diez de la mañana": ["before 10"],
  "sin rodeos": ["direct"],
  "AB negativo": ["AB negative"],
  vegetarian: ["vegetarian"],
  "44-9182": ["44-9182"],
  "6614": ["6614"],
  "B negativo": ["B negative"],
  "77-3051": ["77-3051"],
};

/** `expectEn` of one probe: none without an expect needle (C7); a Spanish scenario's needles through EXPECT_EN_ES (a needle missing from it throws), an English one's as they are. */
export function expectEnFor(lang: "es" | "en", expect: readonly string[]): string[] | undefined {
  if (expect.length === 0) return undefined;
  if (lang === "en") return [...expect];
  return expect.flatMap((n) => {
    const en = EXPECT_EN_ES[n];
    if (!en) throw new Error(`corpus v2: no English rendering of the needle "${n}" (EXPECT_EN_ES)`);
    return en;
  });
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
        probes: d.probes.map((p) => {
          const expectEn = expectEnFor(d.lang, p.expect);
          return { ...p, wording: wordingOf(d.events, p), ...(expectEn ? { expectEn } : {}) };
        }),
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
