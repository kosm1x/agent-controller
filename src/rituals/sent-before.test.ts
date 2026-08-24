import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

const mem = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../db/index.js", () => ({ getDatabase: () => mem.db }));

import {
  ensureSentItemsTable,
  extractItems,
  filterSentBefore,
  isRepeat,
  itemKey,
  itemTitle,
  recordSentItems,
  recentSentItems,
  sentBeforeBlock,
} from "./sent-before.js";

const DIGEST_DAY1 = `**Señales de Inteligencia — 2026-08-20**

🔴 **Señales Críticas**
- Anthropic lanza Claude Agent SDK 2.0 con memoria persistente | Relevancia: 9/10
  → Acción: evaluar migración del runner
  → Fuente: https://example.com/agent-sdk-2
- Meta abre WhatsApp Business Calling API en LATAM | Relevancia: 8/10
  → Fuente: https://example.com/wa-calling

🟡 **Señales Medias**
- Tudriqev recibe aprobación FDA para cáncer de pulmón — https://fda.example.com/tudriqev

📊 **Meta**: 12 fuentes escaneadas, 9 señales encontradas, 3 retenidas.`;

describe("extractItems / itemKey", () => {
  it("picks bullets, numbered lines, bold titles and URL lines; skips meta/footer lines", () => {
    const items = extractItems(DIGEST_DAY1);
    const heads = items.map((i) => i.head);
    expect(heads.some((h) => h.startsWith("- Anthropic lanza"))).toBe(true);
    expect(heads.some((h) => h.startsWith("- Meta abre"))).toBe(true);
    expect(heads.some((h) => h.startsWith("- Tudriqev"))).toBe(true);
    expect(heads.some((h) => h.includes("Señales de Inteligencia"))).toBe(true);
    // Sub-lines and the Meta footer are never items.
    expect(heads.some((h) => h.includes("Acción"))).toBe(false);
    expect(heads.some((h) => h.includes("fuentes escaneadas"))).toBe(false);
    // The "→ Fuente: url" continuation lines carry URLs but are meta.
    expect(heads.some((h) => h.startsWith("→ Fuente"))).toBe(false);
  });

  it("a URL is the identity: reworded headline, same link → same key", () => {
    const a = itemKey("- Anthropic lanza Claude Agent SDK 2.0 — https://example.com/agent-sdk-2");
    const b = itemKey("- Claude Agent SDK 2.0 ya está disponible (https://example.com/agent-sdk-2).");
    expect(a).toBe(b);
  });

  it("text identity is Unicode-normalised and accent/punctuation-insensitive", () => {
    const a = itemKey("- Tudriqev recibe aprobación FDA para cáncer de pulmón");
    const b = itemKey("-   TUDRIQEV recibe aprobación FDA, para cáncer de pulmón!");
    expect(a).toBe(b);
    // A different URL for the same wording is a different item.
    expect(itemKey("- x https://a.example/1")).not.toBe(itemKey("- x https://a.example/2"));
  });

  it("R1 W1: the enumerator, bold and score tails are not part of the identity", () => {
    const a = "5. **AI in WhatsApp Business: Level 4 Autonomous Agents Standard** — 30-60% lead qualification improvement. Relevance: 9, Risk: HIGH → Priority: **13.5**";
    const b = "- AI in WhatsApp Business: Level 4 Autonomous Agents Standard — 30-60% lead qualification improvement | Relevancia: 8/10";
    expect(itemTitle(a)).toBe("AI in WhatsApp Business: Level 4 Autonomous Agents Standard — 30-60% lead qualification improvement.");
    expect(itemKey("1. Tudriqev recibe aprobación FDA para cáncer de pulmón")).toBe(itemKey("- Tudriqev recibe aprobación FDA para cáncer de pulmón"));
    expect(itemKey(a)).toBe(itemKey(b)); // score tails and punctuation are not identity
  });

  it("R1 W1: a renumbered, reworded repeat is a near-duplicate (Jaccard ≥ 0.6 on ≥4-char tokens)", () => {
    const [old] = extractItems("6. **AI WhatsApp Business Level 4 autonomous agents** — 30-60% improvement in lead qualification, 40-70% faster first response");
    const [fresh] = extractItems("5. **AI in WhatsApp Business: Level 4 Autonomous Agents Standard** — 30-60% lead qualification improvement, 40-70% faster first response");
    expect(isRepeat(fresh, [{ key: old.key, tokens: old.tokens.split(" "), head: old.head }])).toBe(true);
    const [other] = extractItems("7. **Voice AI Platform Benchmark: Retell AI resolving 40-70% of inbound calls** — Competitive bar for Pipesong");
    expect(isRepeat(other, [{ key: old.key, tokens: old.tokens.split(" "), head: old.head }])).toBe(false);
  });

  it("R1 W1: Pharma table rows are items (header and separator rows are not); a reworded Tudriqev row repeats", () => {
    const table = `| Evento | Quién | Qué | Cuándo |
|---|---|---|---|
| 💊 FDA | Replimune | Tudriqev (vacuna oncolítica viral) + nivolumab para melanoma avanzado | 06-ago-2026 |
| 💰 M&A | GSK → Nuvalent | $10,600M por precision oncology en NSCLC (zidesamtinib/neladalkib) | Jun-2026 |`;
    const items = extractItems(table);
    expect(items).toHaveLength(2);
    expect(items[0].head.startsWith("| 💊 FDA | Replimune")).toBe(true);
    expect(items[1].head.startsWith("| 💰 M&A | GSK")).toBe(true);
    const [tud] = items;
    const [again] = extractItems("| 💊 FDA | Replimune | Tudriqev + nivolumab (vacuna oncolítica viral) aprobado para melanoma avanzado | 20-ago-2026 |");
    expect(isRepeat(again, [{ key: tud.key, tokens: tud.tokens.split(" "), head: tud.head }])).toBe(true);
  });

  it("corpus replay: the daily meta-count line and table headers are never repeats", () => {
    const [a] = extractItems("- **18 fuentes escaneadas** | **22 señales encontradas** | **8 retenidas**");
    const [b] = extractItems("- **12 fuentes escaneadas** | **19 señales encontradas** | **7 retenidas**");
    expect(isRepeat(b, [{ key: a.key, tokens: a.tokens.split(" "), head: a.head }])).toBe(false);
    const items = extractItems("| # | Compañía | Molécula | Tipo de Cáncer | Fecha Clave |\n|---|---|---|---|---|\n| 1 | Bristol Myers Squibb | Iberdomide (CELMoD) | Mieloma múltiple RRMM | PDUFA: 17-ago-2026 |");
    expect(items).toHaveLength(1);
    expect(items[0].head.startsWith("| 1 | Bristol")).toBe(true);
  });

  it("very short lines are not items", () => {
    expect(itemKey("- Meta")).toBeNull();
    expect(itemKey("1. ok")).toBeNull();
  });

  it("numbered items and dash variants count", () => {
    const items = extractItems("1. Primer hallazgo relevante del día\n• Segundo hallazgo con viñeta\n– Tercero con guion largo");
    expect(items).toHaveLength(3);
  });
});

describe("filterSentBefore (ledger)", () => {
  beforeEach(() => {
    mem.db = new Database(":memory:");
    ensureSentItemsTable();
  });
  afterEach(() => {
    (mem.db as Database.Database).close();
    vi.restoreAllMocks();
  });

  it("first delivery: nothing dropped; items recorded", () => {
    const r = filterSentBefore("signal-intelligence", DIGEST_DAY1);
    expect(r.dropped).toBe(0);
    expect(r.text).toBe(DIGEST_DAY1);
    expect(recordSentItems("signal-intelligence", "t1", DIGEST_DAY1)).toBeGreaterThanOrEqual(4);
  });

  it("second day: already-sent bullets AND their indented continuation lines go; new ones stay; footer survives", () => {
    recordSentItems("signal-intelligence", "t1", DIGEST_DAY1);
    const day2 = DIGEST_DAY1.replace("2026-08-20", "2026-08-21").replace(
      "- Meta abre WhatsApp Business Calling API en LATAM | Relevancia: 8/10\n  → Fuente: https://example.com/wa-calling",
      "- OpenAI publica Realtime API v2 con SIP nativo | Relevancia: 7/10\n  → Fuente: https://example.com/realtime-v2",
    );
    const r = filterSentBefore("signal-intelligence", day2);
    expect(r.dropped).toBe(2); // Anthropic + Tudriqev
    // The bold digest title repeats daily but is structure — never cut.
    expect(r.text).toContain("**Señales de Inteligencia — 2026-08-21**");
    expect(r.text).not.toContain("Anthropic lanza");
    expect(r.text).not.toContain("evaluar migración"); // continuation of a dropped bullet
    expect(r.text).not.toContain("Tudriqev");
    expect(r.text).toContain("OpenAI publica Realtime API v2");
    expect(r.text).toContain("→ Fuente: https://example.com/realtime-v2");
    expect(r.text).toContain("📊 **Meta**");
    expect(r.text).toContain("🔴 **Señales Críticas**");
  });

  it("every finding already sent → dropped === items (the seam silences); the title does not count", () => {
    recordSentItems("signal-intelligence", "t1", DIGEST_DAY1);
    const r = filterSentBefore("signal-intelligence", DIGEST_DAY1.replace("2026-08-20", "2026-08-22"));
    expect(r.items).toBe(3);
    expect(r.dropped).toBe(3);
  });

  it("the window expires: an item sent 15 days ago is new again", () => {
    recordSentItems("signal-intelligence", "t1", DIGEST_DAY1);
    (mem.db as Database.Database)
      .prepare("UPDATE ritual_sent_items SET created_at = datetime('now', '-15 days')")
      .run();
    const r = filterSentBefore("signal-intelligence", DIGEST_DAY1);
    expect(r.dropped).toBe(0);
  });

  it("the seam drops a reworded repeat, not just an identical one", () => {
    recordSentItems("signal-intelligence", "t1", "6. **AI WhatsApp Business Level 4 autonomous agents** — 30-60% improvement in lead qualification, 40-70% faster first response");
    const r = filterSentBefore("signal-intelligence", "1. **AI in WhatsApp Business: Level 4 Autonomous Agents Standard** — 30-60% lead qualification improvement, 40-70% faster first response\n2. **Mexico Programmatic Advertising: $5.16B, 80% of digital spend** — retail media emerging");
    expect(r.dropped).toBe(1);
    expect(r.text).toContain("Mexico Programmatic");
    expect(r.text).not.toContain("WhatsApp");
    expect(recentSentItems("signal-intelligence")[0].tokens.length).toBeGreaterThanOrEqual(3);
  });

  it("ledgers are per ritual", () => {
    recordSentItems("schedule:pharma", "t1", DIGEST_DAY1);
    expect(filterSentBefore("signal-intelligence", DIGEST_DAY1).dropped).toBe(0);
  });

  it("sentBeforeBlock lists the heads once, newest first, and is empty when nothing was sent", () => {
    expect(sentBeforeBlock("schedule:pharma")).toBe("");
    recordSentItems("schedule:pharma", "t1", DIGEST_DAY1);
    recordSentItems("schedule:pharma", "t2", DIGEST_DAY1);
    const block = sentBeforeBlock("schedule:pharma");
    expect(block).toContain("YA ENVIADO en los últimos 14 días");
    expect(block.match(/Tudriqev/g)).toHaveLength(1);
    expect(block).toContain("- - Anthropic lanza");
  });
});
