/**
 * Continuity Scorecard v1 — seeded filler generator (pure, no I/O).
 *
 * The algorithm is documented byte-for-byte in benchmarks/continuity/README.md
 * so an adapter in another language reproduces it exactly; the corpus embeds
 * FILLER_SPEC_V1 (`fillerSpec`), so a second implementation needs only the
 * corpus file. Golden output: benchmarks/continuity/filler-golden.json.
 *
 * Filler shares everyday words with the probes (mascota, presupuesto,
 * hermana, sister, budget, rent, work…) so keyword recall meets real noise,
 * but never contains a needle (generate.ts asserts it for every scenario).
 */

import type { FillerItem, FillerSpec } from "./types.js";

export const FILLER_SPEC_V1: FillerSpec = {
  algorithm: "xorshift32-template-v1",
  templates: {
    es: {
      user: [
        "¿Me ayudas a revisar el {doc} del {proj} antes de la {thing}?",
        "Oye, ¿qué opinas de cambiar el horario de la {thing}?",
        "Necesito un resumen corto del {doc} sobre {topic}.",
        "¿Cuánto llevamos gastado del presupuesto para {topic} este mes?",
        "Mi {relative} quiere que le recomiende algo para {topic}.",
        "¿Te acuerdas de lo que hablamos sobre {topic}? Quiero retomarlo.",
        "Ayúdame a redactar un correo para {person} sobre el {doc}.",
        "¿Cómo se llama la app que usamos para {topic}?",
        "Hoy tengo {thing} con {person}, ¿qué debería preparar?",
        "¿Dónde dejé las notas del {proj}?",
      ],
      assistant: [
        "Claro. Revisé el {doc} y hay {n} puntos por ajustar sobre {topic}.",
        "Sugiero mover la {thing} una hora más tarde; así queda libre la mañana.",
        "Listo, te dejo un resumen de {n} líneas sobre {topic}.",
        "Van {n} gastos registrados en {topic}; nada fuera de lo normal.",
        "Para tu {relative} buscaría opciones sencillas para {topic}, unas {n} para comparar.",
        "Sí, quedamos en revisar {topic} con calma y decidir después.",
        "Aquí va un borrador para {person}: breve, cordial y con el {doc} adjunto.",
        "Tengo anotadas {n} ideas para el {proj}; las vemos cuando quieras.",
      ],
    },
    en: {
      user: [
        "Can you check the {doc} for the {proj} before the {thing}?",
        "What do you think about moving the {thing} to next week?",
        "Remind me what we said about {topic} last time.",
        "My {relative} asked for a recommendation about {topic}.",
        "How much of the budget for {topic} is left this month?",
        "Write a quick note to {person} about the {doc}.",
        "Where did I put the notes for the {proj}?",
        "I have a {thing} with {person} today, what should I bring?",
        "What is the name of the app we use for {topic}?",
        "Give me {n} ideas to organize {topic} better.",
      ],
      assistant: [
        "Sure, the {doc} looks fine; {n} items still need a review on {topic}.",
        "Got it. I'd keep the {thing} where it is and revisit it later.",
        "Here is a short summary of {topic} in {n} lines.",
        "There are {n} expenses logged under {topic}; nothing unusual.",
        "For your {relative} I'd look at {n} simple options for {topic}.",
        "Draft for {person}: short, friendly, with the {doc} attached.",
        "I have {n} notes saved for the {proj}; we can go over them anytime.",
        "We agreed to look at {topic} again before deciding.",
      ],
    },
  },
  vocab: {
    es: {
      doc: ["informe", "reporte", "contrato", "borrador", "calendario", "presupuesto", "inventario"],
      proj: ["proyecto de la mudanza", "proyecto web", "proyecto escolar", "lanzamiento", "proyecto del jardín"],
      thing: ["reunión", "llamada", "cita", "clase", "entrega", "junta"],
      topic: [
        "el viaje", "la salud", "las finanzas", "la escuela", "el trabajo", "la casa", "el coche",
        "la mascota", "la renta", "el gimnasio", "los análisis de sangre", "el local", "la comida",
      ],
      relative: ["hermana", "hermano", "mamá", "primo", "hija", "sobrina", "tía"],
      person: ["el contador", "la maestra", "el proveedor", "el doctor", "la arquitecta", "el vecino"],
    },
    en: {
      doc: ["report", "contract", "draft", "budget sheet", "calendar", "checklist"],
      proj: ["moving project", "website project", "school project", "launch", "garden project"],
      thing: ["meeting", "call", "appointment", "class", "delivery", "review"],
      topic: [
        "travel", "health", "finances", "school", "work", "the house", "the car", "the pet",
        "rent", "the gym", "the blood test", "the office", "dinner plans",
      ],
      relative: ["sister", "brother", "mom", "cousin", "daughter", "aunt"],
      person: ["the accountant", "the teacher", "the supplier", "the doctor", "the architect", "the neighbor"],
    },
  },
};

/** xorshift32 over uint32 state; seed 0 is replaced by 0x9E3779B9. */
export function xorshift32(seed: number): () => number {
  let x = seed >>> 0 || 0x9e3779b9;
  return () => {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    return x;
  };
}

function fill(template: string, slots: Record<string, string[]>, next: () => number): string {
  return template.replace(/\{(\w+)\}/g, (_m, slot: string) => {
    if (slot === "n") return String(2 + (next() % 18));
    const options = slots[slot];
    if (!options) throw new Error(`filler: unknown slot {${slot}}`);
    return options[next() % options.length];
  });
}

/**
 * `size` filler exchanges with timestamps evenly spread over [fromT, toT):
 * item k gets t = fromT + 2*floor(k*span / (2*size)) + 1 (odd seconds; events
 * use even ones, so no two timeline items share a second). Random draws, in
 * order per item: language (next() % 2: 0 = es, 1 = en), user template, user
 * slots left to right, assistant template, assistant slots left to right.
 */
export function generateFiller(
  spec: FillerSpec,
  params: { seed: number; size: number; fromT: number; toT: number },
): FillerItem[] {
  const { seed, size, fromT, toT } = params;
  if (!Number.isInteger(fromT) || fromT % 2 !== 0) throw new Error("filler: fromT must be an even integer");
  const span = toT - fromT;
  if (!(span > 0)) throw new Error("filler: empty window");
  const next = xorshift32(seed);
  const out: FillerItem[] = [];
  for (let k = 0; k < size; k++) {
    const t = fromT + 2 * Math.floor((k * span) / (2 * size)) + 1;
    const lang = next() % 2 === 0 ? "es" : "en";
    const tpl = spec.templates[lang];
    const slots = spec.vocab[lang];
    const user = fill(tpl.user[next() % tpl.user.length], slots, next);
    const assistant = fill(tpl.assistant[next() % tpl.assistant.length], slots, next);
    out.push({ t, user, assistant });
  }
  return out;
}

/** Canonical text for golden hashing: one `t\tuser\tassistant` line per item, joined by "\n", UTF-8. */
export function canonicalFiller(items: readonly FillerItem[]): string {
  return items.map((i) => `${i.t}\t${i.user}\t${i.assistant}`).join("\n");
}
