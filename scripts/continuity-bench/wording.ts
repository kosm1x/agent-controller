/**
 * Continuity Scorecard v2 — the mechanical "wording" label of a probe.
 *
 * A probe is "shared" when it has at least one CONTENT token in common with
 * its target events, else "disjoint". Content tokens: the text is
 * Unicode-NFC normalized and lower-cased, split into runs of letters/digits
 * (`[\p{L}\p{N}]+`), and the runs of 3+ characters that are not in STOPWORDS
 * are kept. No stemming ("pesa" and "pesaba" differ). Target events: those
 * whose text holds an expect needle; for a probe with no expect needle (C7),
 * every event. The label says whether word overlap alone could find the
 * target, so a table can split "findable by words" from "needs meaning".
 */

import type { Corpus, CorpusEvent, Probe, WordingAudit } from "./types.js";

/** Function words and greetings (es + en), NFC lower case. Kept short on purpose; listed in the README. */
export const STOPWORDS: ReadonlySet<string> = new Set(
  (
    // es
    "que qué cómo como cuál cual cuáles cuánto cuanto cuánta cuanta cuántos cuantos cuántas dónde donde cuándo cuando quién quien " +
    "para por con sin del los las una uno unos unas mis tus sus nos les este esta esto estos estas ese esa eso esos esas " +
    "era eran fue son está están estoy estás hay muy más pero porque pues también ahora aquí ahí allí hoy " +
    "recuerdas recuérdame oye hola dime sabes tengo tienes tiene tenemos dijiste dije dijo dijimos quedamos seguimos vamos " +
    "favor bueno buenos buenas bien todo toda todos todas algo nada otra otro cosa entonces sobre entre desde hasta cada " +
    "mismo misma solo sólo vez ser estar han has había hace hacer puedes puedo quiero necesito día días " +
    // en
    "the and for with without what which who whom whose where when how why does did was were are you your yours " +
    "mine our ours they them their this that these those there here have has had been being will would can could should " +
    "about again into from just any some all now then than too very not but also let lets tell remind please hey " +
    "okay yes quick check said say told know get got one its her him his she out like until"
  ).split(/\s+/),
);

export function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.normalize("NFC").toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    if (m[0].length >= 3 && !STOPWORDS.has(m[0])) out.add(m[0]);
  }
  return out;
}

/** Every text an event could contribute (the user and assistant sides, and the extracted text). */
function texts(e: CorpusEvent): string[] {
  return e.kind === "exchange" ? [e.user, e.assistant] : [e.asUser, e.asAssistant, "text" in e ? e.text : ""];
}

/** The events a probe's wording is judged against. */
export function targetEvents(events: readonly CorpusEvent[], probe: Pick<Probe, "expect">): CorpusEvent[] {
  if (probe.expect.length === 0) return [...events];
  const needles = probe.expect.map((n) => n.normalize("NFC").toLowerCase());
  return events.filter((e) => {
    const t = texts(e).join("\n").normalize("NFC").toLowerCase();
    return needles.some((n) => t.includes(n));
  });
}

export function wordingOf(events: readonly CorpusEvent[], probe: Pick<Probe, "expect" | "text">): "shared" | "disjoint" {
  const target = new Set(targetEvents(events, probe).flatMap((e) => [...contentTokens(texts(e).join("\n"))]));
  for (const tok of contentTokens(probe.text)) if (target.has(tok)) return "shared";
  return "disjoint";
}

/** Every run of 3+ letters/digits, stopwords included (the leak check: what a function-word match could use). */
export function anyTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.normalize("NFC").toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) if (m[0].length >= 3) out.add(m[0]);
  return out;
}

/**
 * C5: the roles whose turn holds an expect needle. An exchange's user side
 * (and a non-exchange event's `asUser`) is the person's; its assistant side
 * (`asAssistant`) is the assistant's. An extracted `text` is nobody's turn.
 */
export function statedByOf(events: readonly CorpusEvent[], expect: readonly string[]): Array<"person" | "assistant"> {
  const needles = expect.map((n) => n.normalize("NFC").toLowerCase());
  const has = (t: string) => needles.some((n) => t.normalize("NFC").toLowerCase().includes(n));
  const roles = new Set<"person" | "assistant">();
  for (const e of events) {
    const [user, assistant] = e.kind === "exchange" ? [e.user, e.assistant] : [e.asUser, e.asAssistant];
    if (has(user)) roles.add("person");
    if (has(assistant)) roles.add("assistant");
  }
  return (["person", "assistant"] as const).filter((r) => roles.has(r));
}

/** How many disjoint probes still share any 3+ token (stopwords included) with their target events. */
export function wordingAudit(corpus: Pick<Corpus, "scenarios">): WordingAudit {
  let disjointProbes = 0;
  let disjointSharingAnyToken3 = 0;
  const leaks = new Map<string, { class: string; text: string; tokens: string[] }>();
  for (const s of corpus.scenarios) {
    for (const p of s.probes) {
      if (wordingOf(s.events, p) !== "disjoint") continue;
      disjointProbes++;
      const target = new Set(targetEvents(s.events, p).flatMap((e) => [...anyTokens(texts(e).join("\n"))]));
      const tokens = [...anyTokens(p.text)].filter((t) => target.has(t));
      if (tokens.length === 0) continue;
      disjointSharingAnyToken3++;
      leaks.set(`${s.class}\t${p.text}`, { class: s.class, text: p.text, tokens });
    }
  }
  return { disjointProbes, disjointSharingAnyToken3, leaks: [...leaks.values()] };
}
