/**
 * Continuity Scorecard v1 — writes benchmarks/continuity/corpus-v1.json and
 * benchmarks/continuity/filler-golden.json. Deterministic: the same seed
 * gives the same bytes (no clock, no randomness outside the seeded filler).
 *
 *   npx tsx scripts/continuity-bench/generate.ts [--check]
 *   npx tsx scripts/continuity-bench/generate.ts --corpus-version continuity-v2 [--out <path>] [--check]
 *
 * `--check` regenerates in memory and exits 1 if the committed files differ.
 * All content is synthetic (made-up names, places, figures).
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireOperatorContext } from "../../src/lib/operator-gate.js";
import { FILLER_SPEC_V1, canonicalFiller, generateFiller } from "./filler.js";
import type { AuthorCase, Corpus, CorpusEvent, Probe, Scenario, ScenarioClass, WordingAudit } from "./types.js";
import { SCENARIO_CLASSES } from "./types.js";
import { statedByOf, wordingAudit, wordingOf } from "./wording.js";

export const CORPUS_VERSION = "continuity-v1";
export const CORPUS_SEED = 20261106;
export const FILLER_SIZES = [50, 500, 5000];

const DAY = 86_400;
export const eventT = (day: number, i: number) => day * DAY + 9 * 3600 + i * 120;
export const probeT = (day: number, j: number) => day * DAY + 18 * 3600 + j * 60;
export const ACK_ES = "Entendido, lo tendré presente de aquí en adelante.";
export const ACK_EN = "Understood, I'll keep that in mind from now on.";

// ---------------------------------------------------------------------------
// Content tables (synthetic)
// ---------------------------------------------------------------------------

export interface FactTopic {
  lang: "es" | "en";
  say: string;
  ack: string;
  text: string;
  needle: string;
  /** Four phrasings for days 1 / 7 / 30 / 90, none repeating the fact's wording. */
  ask: [string, string, string, string];
  fixSay: string;
  fixAck: string;
  fixText: string;
  fixNeedle: string;
  askAfterFix: string;
}

export const FACTS: FactTopic[] = [
  {
    lang: "es",
    say: "Por cierto, a mi perro le puse Corvalino.",
    ack: "¡Qué buen nombre! Lo anoto.",
    text: "El perro de la persona se llama Corvalino.",
    needle: "Corvalino",
    ask: [
      "¿Cómo se llama mi mascota?",
      "Oye, ¿recuerdas el nombre que le puse al perrito?",
      "Mi sobrina me preguntó el nombre de mi mascota, ¿me lo recuerdas?",
      "¿Cuál era el nombre de mi can?",
    ],
    fixSay: "Corrección: al final el perro se quedó con el nombre Fermindo.",
    fixAck: "Anotado, ahora se llama Fermindo.",
    fixText: "El perro de la persona se llama Fermindo.",
    fixNeedle: "Fermindo",
    askAfterFix: "¿Cómo se llama mi mascota ahora?",
  },
  {
    lang: "en",
    say: "My sister just moved to Quillmarsh for her new job.",
    ack: "That's a big move, good luck to her.",
    text: "The person's sister lives in Quillmarsh.",
    needle: "Quillmarsh",
    ask: [
      "Where does my sister live these days?",
      "Which town did my sibling relocate to?",
      "Remind me where my sister is based now.",
      "I'm mailing my sister a parcel, what city do I write?",
    ],
    fixSay: "Update: her company changed plans, my sister is living in Brindlecove now.",
    fixAck: "Noted, Brindlecove it is.",
    fixText: "The person's sister lives in Brindlecove.",
    fixNeedle: "Brindlecove",
    askAfterFix: "What city is my sister in?",
  },
  {
    lang: "es",
    say: "El presupuesto aprobado para la remodelación es de 3.847.215 pesos.",
    ack: "Perfecto, lo tomo como referencia.",
    text: "El presupuesto aprobado para la remodelación de la persona es de 3.847.215 pesos.",
    needle: "3.847.215",
    ask: [
      "¿De cuánto es el presupuesto de la remodelación?",
      "¿Qué monto nos autorizaron para remodelar?",
      "Recuérdame la cifra aprobada para la obra de la casa.",
      "¿Con cuánto dinero contamos para la remodelación?",
    ],
    fixSay: "Ojo, el comité recortó el monto: ahora es de 2.960.400 pesos.",
    fixAck: "Entendido, ajusto la referencia a 2.960.400.",
    fixText: "El presupuesto aprobado para la remodelación de la persona es de 2.960.400 pesos.",
    fixNeedle: "2.960.400",
    askAfterFix: "¿Cuál es el presupuesto vigente de la remodelación?",
  },
  {
    lang: "en",
    say: "Just so you know, I'm allergic to penicillin.",
    ack: "Thanks for telling me, I'll keep that in mind.",
    text: "The person is allergic to penicillin.",
    needle: "penicillin",
    ask: [
      "What medication should doctors avoid giving me?",
      "Do I have any drug allergies?",
      "My doctor asked about allergies, what am I allergic to?",
      "Which antibiotic gives me a reaction?",
    ],
    fixSay: "Correction from my doctor: the allergy is actually to sulfonamides.",
    fixAck: "Got it, sulfonamides.",
    fixText: "The person is allergic to sulfonamides.",
    fixNeedle: "sulfonamides",
    askAfterFix: "What am I allergic to?",
  },
  {
    lang: "es",
    say: "Mi hija va a entrar a la escuela Arrayanes en agosto.",
    ack: "¡Qué emoción! Lo anoto.",
    text: "La hija de la persona entra a la escuela Arrayanes.",
    needle: "Arrayanes",
    ask: [
      "¿En qué colegio va a estudiar mi hija?",
      "¿Cómo se llamaba la escuela de la niña?",
      "Tengo que llenar un formulario, ¿a qué escuela entra mi hija?",
      "Recuérdame el nombre del colegio nuevo de mi hija.",
    ],
    fixSay: "Cambio de planes: mi hija va a ir al colegio Tamarindos.",
    fixAck: "Anotado: Tamarindos.",
    fixText: "La hija de la persona va al colegio Tamarindos.",
    fixNeedle: "Tamarindos",
    askAfterFix: "¿A qué escuela va mi hija?",
  },
  {
    lang: "en",
    say: "The gate code for the new office is 5821.",
    ack: "Got it, saved.",
    text: "The office gate code is 5821.",
    needle: "5821",
    ask: [
      "What's the code to open the office gate?",
      "I'm at the office entrance, what are the digits again?",
      "Remind me how to get through the building gate.",
      "What number do I punch in at the office door?",
    ],
    fixSay: "They reset it, the office gate code is 7394 now.",
    fixAck: "Updated to 7394.",
    fixText: "The office gate code is 7394.",
    fixNeedle: "7394",
    askAfterFix: "What's the current office gate code?",
  },
  {
    lang: "es",
    say: "Reservé la cena de aniversario en el restaurante Lumbrella.",
    ack: "¡Excelente elección! Lo anoto.",
    text: "La cena de aniversario de la persona es en el restaurante Lumbrella.",
    needle: "Lumbrella",
    ask: [
      "¿Dónde es la cena de aniversario?",
      "¿En qué lugar reservé para el aniversario?",
      "¿Cómo se llama el restaurante que elegí para celebrar?",
      "Recuérdame dónde vamos a cenar por el aniversario.",
    ],
    fixSay: "Cambié la reservación: ahora la cena es en Casa Nopalera.",
    fixAck: "Listo, Casa Nopalera.",
    fixText: "La cena de aniversario de la persona es en Casa Nopalera.",
    fixNeedle: "Casa Nopalera",
    askAfterFix: "¿Dónde quedó la cena de aniversario?",
  },
  {
    lang: "en",
    say: "My new car's plate number is KVX-482.",
    ack: "Noted.",
    text: "The person's car plate number is KVX-482.",
    needle: "KVX-482",
    ask: [
      "What's my license plate?",
      "The parking form wants my registration, what is it?",
      "Remind me the tag on my vehicle.",
      "What plate did they give my new car?",
    ],
    fixSay: "The DMV reissued it, my plate is now JRT-915.",
    fixAck: "Updated: JRT-915.",
    fixText: "The person's car plate number is JRT-915.",
    fixNeedle: "JRT-915",
    askAfterFix: "What's my car's plate number now?",
  },
];

export interface OpenWorkTopic {
  lang: "es" | "en";
  turns: Array<[string, string]>;
  wrapSay: string;
  openWork: string;
  needle: string;
  greetLater: string;
  greetAfterRestart: string;
}

export const OPEN_WORK: OpenWorkTopic[] = [
  {
    lang: "es",
    turns: [
      ["Vamos a avanzar con el informe trimestral de Valdoria.", "Va. Ya tengo la estructura con ventas y gastos."],
      ["Bien, agrega la parte de inventario.", "Listo, agregué inventario con el cierre del mes."],
    ],
    wrapSay: "Ok, lo dejamos aquí por hoy.",
    openWork: "falta el anexo de proveedores del informe de Valdoria y mandarlo a revisión",
    needle: "anexo de proveedores",
    greetLater: "Hola, ¿seguimos?",
    greetAfterRestart: "Ya volví, ¿seguimos?",
  },
  {
    lang: "en",
    turns: [
      ["Let's keep building the slide deck for the Merriton pitch.", "Sure. The intro and the problem slides are done."],
      ["Good, now the market slide.", "Done, the market slide has the three segments."],
    ],
    wrapSay: "Let's stop here for today.",
    openWork: "the pricing slide for Merriton still needs the competitor table",
    needle: "competitor table",
    greetLater: "hey, where were we?",
    greetAfterRestart: "I'm back, where were we?",
  },
  {
    lang: "es",
    turns: [
      ["Organicemos el viaje a Zacatlán del puente.", "Va. Ya reservé el hotel dos noches."],
      ["¿Y el transporte de ida?", "Listo, la ida queda en autobús el viernes temprano."],
    ],
    wrapSay: "Va, seguimos luego.",
    openWork: "falta comprar los boletos de regreso desde Zacatlán",
    needle: "boletos de regreso",
    greetLater: "Buenos días, ¿en qué íbamos?",
    greetAfterRestart: "Aquí estoy de nuevo, ¿en qué íbamos?",
  },
  {
    lang: "en",
    turns: [
      ["Help me write the cover letter for the Pellham Foundation grant.", "Sure, I drafted the opening and the mission paragraph."],
      ["Add a paragraph about last year's results.", "Added, with the two outcomes you mentioned."],
    ],
    wrapSay: "That's enough for today.",
    openWork: "the closing paragraph of the Pellham cover letter is still unwritten",
    needle: "closing paragraph",
    greetLater: "I'm back. What's next?",
    greetAfterRestart: "Back again. What's next?",
  },
  {
    lang: "es",
    turns: [
      ["Sigamos con la migración de contactos al sistema Tilapo.", "Va. Ya importé los del primer semestre."],
      ["¿Quedaron bien los teléfonos?", "Sí, revisé los teléfonos y quedaron con lada."],
    ],
    wrapSay: "Lo dejamos aquí.",
    openWork: "faltan los contactos del segundo semestre por importar a Tilapo",
    needle: "segundo semestre",
    greetLater: "¿Continuamos?",
    greetAfterRestart: "Ya regresé, ¿continuamos?",
  },
  {
    lang: "en",
    turns: [
      ["Let's get my tax filing in order.", "Sure, I listed the income documents you already have."],
      ["Add the deductible expenses.", "Added the deductible expenses we have receipts for."],
    ],
    wrapSay: "Ok, pausing here.",
    openWork: "the receipts from the dental clinic still need to be scanned",
    needle: "dental clinic",
    greetLater: "Morning! Let's pick up again.",
    greetAfterRestart: "Back now, let's pick up again.",
  },
];

export interface AssertedFigure {
  lang: "es" | "en";
  ask: string;
  claim: string;
  needle: string;
  later: string;
}

export const FIGURES: AssertedFigure[] = [
  {
    lang: "es",
    ask: "¿Cuánto crees que cueste la renta del local en Plaza Ombú?",
    claim: "Por la zona, calculo que la renta ronda los 18.450 pesos al mes.",
    needle: "18.450",
    later: "¿Cuánto quedamos que era la renta del local?",
  },
  {
    lang: "en",
    ask: "How long is the drive to the Fenwick cabin?",
    claim: "I'd estimate about 3 hours 40 minutes without traffic.",
    needle: "3 hours 40",
    later: "How long did we say the trip to the cabin takes?",
  },
  {
    lang: "es",
    ask: "¿Cuántos invitados caben en el salón Jacarandas?",
    claim: "Por lo que suele haber en esos salones, caben unas 135 personas.",
    needle: "135 personas",
    later: "¿Cuánta gente dijimos que entra en el salón?",
  },
  {
    lang: "en",
    ask: "What's the interest rate on the Halvorsen loan offer?",
    claim: "It's probably around 11.75% a year.",
    needle: "11.75%",
    later: "What rate did we settle on for the loan?",
  },
  {
    lang: "es",
    ask: "¿Cuánto pesa la caja que mandamos a Mérida?",
    claim: "Calculo que unos 23,6 kilos con todo y empaque.",
    needle: "23,6 kilos",
    later: "¿Cuánto pesaba el paquete del envío?",
  },
  {
    lang: "en",
    ask: "When does the Corbett warranty run out?",
    claim: "Most likely in September 2027.",
    needle: "September 2027",
    later: "When did we say the warranty expires?",
  },
];

export interface StandingPref {
  lang: "es" | "en";
  say: string;
  text: string;
  needle: string;
  later: string;
}

export const STANDING: StandingPref[] = [
  {
    lang: "es",
    say: "A partir de ahora respóndeme siempre en viñetas cortas, nada de párrafos largos.",
    text: "Responder siempre en viñetas cortas, sin párrafos largos.",
    needle: "viñetas",
    later: "Explícame cómo funciona el interés compuesto.",
  },
  {
    lang: "en",
    say: "From now on, always give me temperatures in Celsius.",
    text: "Always give temperatures in Celsius.",
    needle: "celsius",
    later: "What will the weather be like for my trip this weekend?",
  },
  {
    lang: "es",
    say: "Nunca me agendes nada antes de las diez de la mañana, por favor.",
    text: "No agendar nada antes de las diez de la mañana.",
    needle: "diez de la mañana",
    later: "Agéndame una llamada con el contador para mañana.",
  },
  {
    lang: "en",
    say: "Please always address me as Captain Rook.",
    text: "Address the person as Captain Rook.",
    needle: "Captain Rook",
    later: "Draft a short note to my team about the Friday plan.",
  },
  {
    lang: "es",
    say: "Cuando hablemos de mi salud, dímelo directo y sin rodeos.",
    text: "Temas de salud: hablar directo y sin rodeos.",
    needle: "sin rodeos",
    later: "Me salieron altos los triglicéridos, ¿qué significa?",
  },
  {
    lang: "en",
    say: "Keep every summary you write me under five sentences.",
    text: "Keep summaries under five sentences.",
    needle: "five sentences",
    later: "Summarize the main points of the article I sent you.",
  },
];

export const NEVER_MENTIONED: Array<{ lang: "es" | "en"; warmup: Array<[string, string]>; probe: string }> = [
  {
    lang: "es",
    warmup: [["¿Me recomiendas una serie para el fin?", "Te sugiero una de misterio corta, de seis capítulos."]],
    probe: "¿Qué te conté sobre el viaje de mi sobrino al torneo de ajedrez?",
  },
  {
    lang: "en",
    warmup: [["Any idea for a quick lunch?", "A grain bowl with whatever vegetables you have."]],
    probe: "What did I tell you about my cousin's beekeeping hobby?",
  },
  {
    lang: "es",
    warmup: [["¿Qué hora es en Madrid ahora?", "Son siete horas más que aquí."]],
    probe: "¿Recuerdas lo que te dije del contrato del velero?",
  },
  {
    lang: "en",
    warmup: [["Give me a word that rhymes with orange.", "Nothing rhymes perfectly; door hinge is the classic joke."]],
    probe: "What was the name of the violin teacher I mentioned?",
  },
  {
    lang: "es",
    warmup: [["¿Cuántos litros tiene un galón?", "Un galón estadounidense tiene unos 3,79 litros."]],
    probe: "¿Qué te comenté de la clase de cerámica de mi mamá?",
  },
  {
    lang: "en",
    warmup: [["How do I boil an egg soft?", "Six minutes in boiling water, then cold water."]],
    probe: "Remind me what I said about the rooftop garden at work.",
  },
];

export interface DurableVsTemporary {
  lang: "es" | "en";
  durableSay: string;
  durableText: string;
  durableNeedle: string;
  tempSay: string;
  tempText: string;
  tempNeedle: string;
  probe: string;
}

export const FORGETTING: DurableVsTemporary[] = [
  {
    lang: "es",
    durableSay: "Mi tipo de sangre es AB negativo.",
    durableText: "El tipo de sangre de la persona es AB negativo.",
    durableNeedle: "AB negativo",
    tempSay: "Esta semana nada más estoy trabajando desde Cuernavaca.",
    tempText: "Esta semana la persona trabaja desde Cuernavaca (solo esta semana).",
    tempNeedle: "Cuernavaca",
    probe: "Para el formulario médico: ¿qué tipo de sangre tengo y desde dónde estoy trabajando?",
  },
  {
    lang: "en",
    durableSay: "My middle name is Thornbury, by the way.",
    durableText: "The person's middle name is Thornbury.",
    durableNeedle: "Thornbury",
    tempSay: "Only this week I'm using the spare phone, the one ending in 7781.",
    tempText: "This week only, the person uses the spare phone ending in 7781.",
    tempNeedle: "7781",
    probe: "Quick check: what's my middle name, and which phone am I using?",
  },
  {
    lang: "es",
    durableSay: "Soy vegetariano desde hace diez años.",
    durableText: "La persona es vegetariana desde hace diez años.",
    durableNeedle: "vegetarian",
    tempSay: "Solo por esta semana estoy en dieta líquida por lo del dentista.",
    tempText: "Solo esta semana la persona sigue una dieta líquida.",
    tempNeedle: "dieta líquida",
    probe: "Voy a pedir comida: ¿qué restricciones de alimentación tengo?",
  },
  {
    lang: "en",
    durableSay: "My company is called Orrinvale Labs.",
    durableText: "The person's company is Orrinvale Labs.",
    durableNeedle: "Orrinvale",
    tempSay: "This week only, I'm covering for my manager at the Duxbury branch.",
    tempText: "This week only, the person covers for their manager at the Duxbury branch.",
    tempNeedle: "Duxbury",
    probe: "Quick check: where do I work and which branch am I at?",
  },
  {
    lang: "es",
    durableSay: "Mi número de cliente del banco es 44-9182.",
    durableText: "El número de cliente bancario de la persona es 44-9182.",
    durableNeedle: "44-9182",
    tempSay: "Esta semana nada más, el coche está en el taller Rinconada.",
    tempText: "Esta semana el coche de la persona está en el taller Rinconada.",
    tempNeedle: "Rinconada",
    probe: "¿Cuál es mi número de cliente del banco y dónde está el coche?",
  },
  {
    lang: "en",
    durableSay: "My daughter's birthday is March 14.",
    durableText: "The person's daughter's birthday is March 14.",
    durableNeedle: "March 14",
    tempSay: "Just for this week, school pickup is at 2:40 instead of the usual time.",
    tempText: "This week only, school pickup is at 2:40.",
    tempNeedle: "2:40",
    probe: "When is my daughter's birthday, and what time is school pickup?",
  },
];

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export type Draft = Omit<Scenario, "id" | "fillerSize" | "fillerSeed">;

function exchange(day: number, i: number, user: string, assistant: string): CorpusEvent {
  return { day, t: eventT(day, i), session: `d${day}`, kind: "exchange", user, assistant };
}

function probe(day: number, j: number, text: string, rest: Omit<Probe, "day" | "t" | "session" | "text">): Probe {
  return { day, t: probeT(day, j), session: `d${day}`, text, ...rest };
}

export const FROM_MINUS_30 = -30 * DAY;

function buildC1(f: FactTopic, base: number): Draft {
  const events: CorpusEvent[] = [
    { day: 0, t: eventT(0, 0), session: "d0", kind: "person_fact", text: f.text, durable: true, asUser: f.say, asAssistant: f.ack },
  ];
  const probes = [1, 7, 30, 90].map((day, j) =>
    probe(day, j, f.ask[j], { expect: [f.needle], forbid: [], surface: "both" }),
  );
  return { class: "C1", base, lang: f.lang, fillerFromT: FROM_MINUS_30, fillerToT: probes[3].t, events, probes };
}

function buildC2(f: FactTopic, base: number): Draft {
  const events: CorpusEvent[] = [
    { day: 0, t: eventT(0, 0), session: "d0", kind: "person_fact", text: f.text, durable: true, asUser: f.say, asAssistant: f.ack },
    { day: 5, t: eventT(5, 1), session: "d5", kind: "correction", targetEventIndex: 0, text: f.fixText, asUser: f.fixSay, asAssistant: f.fixAck },
  ];
  const probes = [probe(10, 0, f.askAfterFix, { expect: [f.fixNeedle], forbid: [f.needle], surface: "both" })];
  return { class: "C2", base, lang: f.lang, fillerFromT: FROM_MINUS_30, fillerToT: probes[0].t, events, probes };
}

export function openWorkEvents(w: OpenWorkTopic): CorpusEvent[] {
  const events: CorpusEvent[] = w.turns.map(([u, a], i) => exchange(0, i, u, a));
  const lead = w.lang === "es" ? "De acuerdo. Queda pendiente:" : "Sure. Still open:";
  events.push({
    day: 0,
    t: eventT(0, events.length),
    session: "d0",
    kind: "session_end",
    openWork: w.openWork,
    asUser: w.wrapSay,
    asAssistant: `${lead} ${w.openWork}.`,
  });
  return events;
}

function buildC3(w: OpenWorkTopic, base: number): Draft {
  const events = openWorkEvents(w);
  const probes = [probe(3, 0, w.greetLater, { expect: [w.needle], forbid: [], surface: "proactive" })];
  return { class: "C3", base, lang: w.lang, fillerFromT: FROM_MINUS_30, fillerToT: 0, events, probes };
}

function buildC4(w: OpenWorkTopic, base: number): Draft {
  const events = openWorkEvents(w);
  events.push({ day: 0, t: eventT(0, events.length), session: "d0", kind: "restart", asUser: "", asAssistant: "" });
  const probes = [probe(0, 0, w.greetAfterRestart, { expect: [w.needle], forbid: [], surface: "proactive" })];
  return { class: "C4", base, lang: w.lang, fillerFromT: FROM_MINUS_30, fillerToT: 0, events, probes };
}

function buildC5(f: AssertedFigure, base: number): Draft {
  const events = [exchange(0, 0, f.ask, f.claim)];
  const probes = [probe(2, 0, f.later, { expect: [f.needle], forbid: [], surface: "both", expectAuthor: "assistant" })];
  return { class: "C5", base, lang: f.lang, fillerFromT: FROM_MINUS_30, fillerToT: probes[0].t, events, probes };
}

function buildC6(p: StandingPref, base: number): Draft {
  const events: CorpusEvent[] = [
    { day: 0, t: eventT(0, 0), session: "d0", kind: "standing", text: p.text, asUser: p.say, asAssistant: p.lang === "es" ? ACK_ES : ACK_EN },
  ];
  const probes = [probe(30, 0, p.later, { expect: [p.needle], forbid: [], surface: "proactive" })];
  // Filler only after the preference ("then N filler exchanges").
  return { class: "C6", base, lang: p.lang, fillerFromT: 10 * 3600, fillerToT: probes[0].t, events, probes };
}

function buildC7(n: (typeof NEVER_MENTIONED)[number], base: number): Draft {
  const events = n.warmup.map(([u, a], i) => exchange(0, i, u, a));
  const probes = [probe(14, 0, n.probe, { expect: [], forbid: [], surface: "both" })];
  return { class: "C7", base, lang: n.lang, fillerFromT: FROM_MINUS_30, fillerToT: probes[0].t, events, probes };
}

function buildC8(f: DurableVsTemporary, base: number): Draft {
  const events: CorpusEvent[] = [
    { day: 0, t: eventT(0, 0), session: "d0", kind: "person_fact", text: f.durableText, durable: true, asUser: f.durableSay, asAssistant: f.lang === "es" ? "Anotado." : "Noted." },
    { day: 0, t: eventT(0, 1), session: "d0", kind: "person_fact", text: f.tempText, durable: false, asUser: f.tempSay, asAssistant: f.lang === "es" ? "Va, lo tomo en cuenta esta semana." : "Ok, noted for this week." },
  ];
  const probes = [probe(120, 0, f.probe, { expect: [f.durableNeedle], forbid: [f.tempNeedle], surface: "both" })];
  return { class: "C8", base, lang: f.lang, fillerFromT: FROM_MINUS_30, fillerToT: probes[0].t, events, probes };
}

function drafts(): Draft[] {
  const out: Draft[] = [];
  for (let b = 0; b < 6; b++) out.push(buildC1(FACTS[b], b + 1));
  for (let b = 0; b < 6; b++) out.push(buildC2(FACTS[b + 2], b + 1));
  for (let b = 0; b < 6; b++) out.push(buildC3(OPEN_WORK[b], b + 1));
  for (let b = 0; b < 6; b++) out.push(buildC4(OPEN_WORK[b], b + 1));
  for (let b = 0; b < 6; b++) out.push(buildC5(FIGURES[b], b + 1));
  for (let b = 0; b < 6; b++) out.push(buildC6(STANDING[b], b + 1));
  for (let b = 0; b < 6; b++) out.push(buildC7(NEVER_MENTIONED[b], b + 1));
  for (let b = 0; b < 6; b++) out.push(buildC8(FORGETTING[b], b + 1));
  return out;
}

export function fillerSeedFor(cls: ScenarioClass, base: number): number {
  const c = SCENARIO_CLASSES.indexOf(cls) + 1;
  return (CORPUS_SEED ^ Math.imul(c, 0x9e3779b1) ^ Math.imul(base, 0x85ebca6b)) >>> 0;
}

/** All text an adapter could ingest from a scenario's events. */
export function eventTexts(e: CorpusEvent): string[] {
  return e.kind === "exchange" ? [e.user, e.assistant] : [e.asUser, e.asAssistant, "text" in e ? e.text : ""];
}

const fold = (x: string) => x.normalize("NFC").toLowerCase();

/**
 * Throws when a needle is unreachable, a forbid needle is absent, or filler
 * contains a needle (plus the v2 checks below). Returns the measured wording
 * audit: how many disjoint probes still share any 3+ token (stopwords
 * included) with their target; a corpus that stores one must match it.
 */
export function validateCorpus(corpus: Corpus): WordingAudit {
  for (const s of corpus.scenarios) {
    const lower = fold(s.events.flatMap(eventTexts).join("\n"));
    const needles: string[] = [];
    let lastProbeT = -Infinity;
    for (const p of s.probes) {
      for (const n of p.expect) {
        if (!lower.includes(fold(n))) throw new Error(`${s.id}: expect needle "${n}" never appears in its events`);
        needles.push(n);
      }
      for (const n of p.forbid) {
        if (!lower.includes(fold(n))) throw new Error(`${s.id}: forbid needle "${n}" never appears in its events`);
        needles.push(n);
      }
      if (p.t <= s.events[s.events.length - 1].t) throw new Error(`${s.id}: probe precedes the last event`);
      if (p.t <= lastProbeT) throw new Error(`${s.id}: probes are not in time order`);
      lastProbeT = p.t;
      if (s.class === "C7" && lower.includes(fold(p.text))) throw new Error(`${s.id}: C7 probe text appears in events`);
      if (p.wording !== undefined && p.wording !== wordingOf(s.events, p))
        throw new Error(`${s.id}: probe "${p.text}" is labelled ${p.wording}, the rule says ${wordingOf(s.events, p)}`);
      if (p.authorCase !== undefined) checkAuthorCase(s, p.expect, p.authorCase);
      if (p.statedBy !== undefined) {
        const want = statedByOf(s.events, p.expect);
        if (JSON.stringify(p.statedBy) !== JSON.stringify(want)) throw new Error(`${s.id}: statedBy ${p.statedBy.join("+")} but the events say ${want.join("+")}`);
        if (p.expectAuthor && !p.statedBy.includes(p.expectAuthor)) throw new Error(`${s.id}: expectAuthor ${p.expectAuthor} never states the figure`);
      }
    }
    if (s.gapRows !== undefined) checkGap(s);
    const filler = fold(
      generateFiller(corpus.fillerSpec, {
        seed: s.fillerSeed,
        size: s.fillerSize,
        fromT: s.fillerFromT,
        toT: s.fillerToT,
      })
        .map((i) => `${i.user}\n${i.assistant}`)
        .join("\n"),
    );
    for (const n of needles) {
      if (filler.includes(fold(n))) throw new Error(`${s.id}: filler contains needle "${n}"`);
    }
  }
  const audit = wordingAudit(corpus);
  if (corpus.wordingAudit !== undefined && JSON.stringify(corpus.wordingAudit) !== JSON.stringify(audit))
    throw new Error(`wordingAudit in the corpus header (${corpus.wordingAudit.disjointSharingAnyToken3}/${corpus.wordingAudit.disjointProbes}) does not match the measured ${audit.disjointSharingAnyToken3}/${audit.disjointProbes}`);
  return audit;
}

/** v2 C3/C4: the gap rows sit after the last session end (and before a restart), on the declared channels, and carry no needle. */
function checkGap(s: Scenario): void {
  const end = s.events.map((e) => e.kind).lastIndexOf("session_end");
  if (end === -1) throw new Error(`${s.id}: gapRows without a session_end`);
  const restart = s.events.findIndex((e) => e.kind === "restart");
  const gap = s.events.slice(end + 1, restart === -1 ? undefined : restart);
  const primary = gap.filter((e) => e.kind === "exchange" && (e.channel ?? "primary") === "primary").length;
  const other = gap.filter((e) => e.channel === "secondary").length;
  if (primary !== s.gapRows) throw new Error(`${s.id}: gapRows ${s.gapRows} but ${primary} primary exchanges after the session end`);
  if (other !== (s.otherChannelRows ?? 0)) throw new Error(`${s.id}: otherChannelRows ${s.otherChannelRows ?? 0} but ${other} secondary exchanges`);
  if (gap.length !== primary + other || gap.some((e) => e.kind !== "exchange")) throw new Error(`${s.id}: the gap holds a non-exchange event`);
  const needles = s.probes.flatMap((p) => p.expect).map(fold);
  for (const e of gap) {
    if (needles.some((n) => fold(eventTexts(e).join("\n")).includes(n))) throw new Error(`${s.id}: a gap row carries an expect needle`);
  }
  for (const p of s.probes) if (gap.some((e) => e.t >= p.t)) throw new Error(`${s.id}: gap row at or after a probe`);
}

/** v2 C5: the needle is in the text of the side(s) the author case names, and only there. */
function checkAuthorCase(s: Scenario, expect: readonly string[], c: AuthorCase): void {
  const sides = (pick: "user" | "assistant") =>
    fold(s.events.map((e) => (e.kind === "exchange" ? e[pick] : pick === "user" ? e.asUser : e.asAssistant)).join("\n"));
  const inUser = expect.every((n) => sides("user").includes(fold(n)));
  const inAssistant = expect.every((n) => sides("assistant").includes(fold(n)));
  const want = c === "person" ? [true, false] : c === "assistant" ? [false, true] : [true, true];
  if (inUser !== want[0] || inAssistant !== want[1]) throw new Error(`${s.id}: author case ${c} but the needle is in user=${inUser} assistant=${inAssistant}`);
  const first = s.events.find((e) => e.kind === "exchange" && expect.some((n) => fold(e.user + "\n" + e.assistant).includes(fold(n))));
  if (c.startsWith("echo") && first?.kind === "exchange") {
    const personFirst = expect.some((n) => fold(first.user).includes(fold(n)));
    if (personFirst !== (c === "echo-person-first")) throw new Error(`${s.id}: ${c} but the other side states the figure first`);
  }
}

export function buildCorpus(): Corpus {
  const scenarios: Scenario[] = [];
  for (const size of FILLER_SIZES) {
    for (const d of drafts()) {
      scenarios.push({
        id: `${d.class}-${String(d.base).padStart(2, "0")}-s${size}`,
        class: d.class,
        base: d.base,
        lang: d.lang,
        fillerSize: size,
        fillerSeed: fillerSeedFor(d.class, d.base),
        fillerFromT: d.fillerFromT,
        fillerToT: d.fillerToT,
        events: d.events,
        probes: d.probes,
      });
    }
  }
  return { version: CORPUS_VERSION, seed: CORPUS_SEED, fillerSizes: FILLER_SIZES, fillerSpec: FILLER_SPEC_V1, scenarios };
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** Golden cases a second implementation must reproduce byte for byte. */
export function buildGolden(corpus: Corpus) {
  const pick = (id: string) => {
    const s = corpus.scenarios.find((x) => x.id === id);
    if (!s) throw new Error(`golden: no scenario ${id}`);
    return { scenarioId: id, seed: s.fillerSeed, size: s.fillerSize, fromT: s.fillerFromT, toT: s.fillerToT };
  };
  const cases = [
    { scenarioId: null, seed: 1, size: 12, fromT: 0, toT: 86_400 },
    { scenarioId: null, seed: 0, size: 5, fromT: -172_800, toT: -86_400 },
    pick("C1-01-s50"),
    pick("C6-03-s500"),
    pick("C8-06-s5000"),
  ];
  return {
    version: CORPUS_VERSION,
    note: "sha256 is over canonicalFiller(items): one `t<TAB>user<TAB>assistant` line per item joined by LF, UTF-8. `items` lists every item when size <= 12, else the first 3 and the last.",
    cases: cases.map((c) => {
      const items = generateFiller(corpus.fillerSpec, c);
      return {
        ...c,
        sha256: sha256(canonicalFiller(items)),
        items: items.length <= 12 ? items : [...items.slice(0, 3), items[items.length - 1]],
      };
    }),
  };
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CORPUS_PATH = join(ROOT, "benchmarks/continuity/corpus-v1.json");
const GOLDEN_PATH = join(ROOT, "benchmarks/continuity/filler-golden.json");

export function serialize(obj: unknown): string {
  return JSON.stringify(obj, null, 1) + "\n";
}

/**
 * Outputs for a corpus version. v1 (default): corpus-v1.json + the golden.
 * v2: only the corpus, at `--out` (default benchmarks/continuity/corpus-v2.json);
 * the golden is a property of the filler, which v2 does not change.
 */
export async function outputsFor(version: string, out?: string): Promise<Array<[string, string]>> {
  if (version === CORPUS_VERSION) {
    const corpus = buildCorpus();
    validateCorpus(corpus);
    return [
      [out ? resolve(out) : CORPUS_PATH, serialize(corpus)],
      [GOLDEN_PATH, serialize(buildGolden(corpus))],
    ];
  }
  const { CORPUS_VERSION_V2, buildCorpusV2 } = await import("./corpus-v2.js");
  if (version !== CORPUS_VERSION_V2) throw new Error(`unknown --corpus-version ${version} (want ${CORPUS_VERSION} or ${CORPUS_VERSION_V2})`);
  const corpus = buildCorpusV2();
  const audit = validateCorpus(corpus);
  console.log(
    `[continuity-generate] ${version}: ${audit.disjointSharingAnyToken3} of ${audit.disjointProbes} disjoint probes share a 3+ token (stopwords included) with their target`,
  );
  return [[out ? resolve(out) : join(ROOT, "benchmarks/continuity/corpus-v2.json"), serialize(corpus)]];
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const outputs = await outputsFor(flag("--corpus-version") ?? CORPUS_VERSION, flag("--out"));
  if (check) {
    const stale = outputs.filter(([p, s]) => {
      try {
        return readFileSync(p, "utf8") !== s;
      } catch {
        return true;
      }
    });
    for (const [p] of stale) console.error(`stale: ${p}`);
    process.exit(stale.length ? 1 : 0);
  }
  requireOperatorContext("continuity-generate", { tty: false });
  for (const [p, s] of outputs) {
    writeFileSync(p, s);
    console.log(`wrote ${p} (${(s.length / 1024).toFixed(0)} KB)`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
