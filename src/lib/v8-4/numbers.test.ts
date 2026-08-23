/**
 * V8.4 numbers-provenance audit (Phase 3 calibration): claim-class figures
 * are looked up in the run's tool-output corpus by digits OR by value in any
 * format; identifiers, years, times, list numbering and tiny bare counts are
 * not candidates; estimate/calculation lines and provenance-marked blocks are
 * not unverified; the collector is capped and freed per task.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  _resetToolEvidence,
  annotateUnverified,
  auditNumbers,
  blockAround,
  extractFigures,
  formatUnverifiedFooter,
  numbersAnnotateEnabled,
  peekToolEvidence,
  recordToolEvidence,
  takeToolEvidence,
} from "./numbers.js";

afterEach(() => _resetToolEvidence());

describe("auditNumbers", () => {
  it("verifies numbers present in the corpus (comma-insensitive) and flags the rest", () => {
    const text =
      "Se cargaron 1,741 hallazgos (436 marcas, 98.2% de cobertura) por $12,500 MXN; 34 filas nuevas.";
    const corpus = [
      '{"findings":1741,"marcas":436}',
      "coverage: 98.2%",
      "amount 12500",
    ];
    const audit = auditNumbers(text, corpus);
    expect(audit.found).toEqual(["1,741", "436", "98.2%", "$12,500 MXN", "34"]);
    expect(audit.unverified).toEqual(["34"]);
    expect(audit.unverifiedFigures[0]).toMatchObject({
      raw: "34",
      kind: "count",
      value: 34,
    });
  });

  it("skips identifiers, versions, dates/times, bare years and small bare numbers", () => {
    const text =
      "V8.4 shipped 2026-08-16 at 12:01; task #157, commit ec8d9dd, 3 tareas, año 2025, v0.3.1.\n| 11 | Puebla | ✅ |\n| 12 | Necaxa | ✅ |\nClub 23, multiplica por 1.5, proficiency 2.5 / 10, BMI 40+.";
    const audit = auditNumbers(text, []);
    expect(audit.found).toEqual([]);
  });

  it("keeps small numbers when they carry a unit ($, %)", () => {
    const audit = auditNumbers("subió 5% y costó $7", ["5%"]);
    expect(audit.found).toEqual(["5%", "$7"]);
    expect(audit.unverified).toEqual(["$7"]);
  });

  it("dedupes repeated numbers and normalizes units in the lookup", () => {
    const audit = auditNumbers("88 filas; again 88 filas; 21.5% share.", [
      "gmail_send: 88",
      "share=21.5",
    ]);
    expect(audit.found).toEqual(["88", "21.5%"]);
    expect(audit.unverified).toEqual([]);
  });

  it("accepts the same value written in another format (shadow FP class 1)", () => {
    const corpus = [
      "GSK to acquire Nuvalent for $7.8B",
      "volume 45,512,300",
      "score: 94",
      "ratio 0.4",
      "MXN 16.9 per USD",
    ];
    const audit = auditNumbers(
      "Adquisición por $7,800M; volumen 45.5M acciones; 94.0 registros; 40% del total; tipo de cambio 16.90 pesos.",
      corpus,
    );
    expect(audit.unverified).toEqual([]);
  });

  it("flags figures from memory: currency, magnitude, count nouns, percent, ≥4-digit plain", () => {
    const text =
      "Tubi tiene 80M+ usuarios; 71% de supervivencia; 7,000+ sucursales; multa de $200,000 USD diarios; 12000 en total.";
    const audit = auditNumbers(text, ["nothing relevant 2026"]);
    expect(audit.unverified).toEqual([
      "80M",
      "71%",
      "7,000",
      "$200,000 USD",
      "12000",
    ]);
    expect(audit.unverifiedFigures.map((f) => f.kind)).toEqual([
      "magnitude",
      "percent",
      "count",
      "currency",
      "plain",
    ]);
  });

  it("treats a block with fuente:/calc:/supuesto:/URL as sourced", () => {
    const text = [
      "Ventas Q2: $1,200,000 MXN.",
      "fuente: https://example.com/reporte-q2",
      "",
      "Margen 35% (calc: utilidad / ventas).",
      "",
      "| Región | Sucursales |",
      "| Norte | 7,000 |",
      "Fuente: DENUE 2026 vía shell_exec",
      "",
      "Usuarios activos: 80M",
    ].join("\n");
    const audit = auditNumbers(text, []);
    expect(audit.unverified).toEqual(["80M"]);
  });

  it("exempts estimate / proposal / shown-calculation lines and code fences", () => {
    const text = [
      "Presupuesto sugerido: $50,000 (aprox.)",
      "%Δ = (762.60 - 769.06) / 769.06 = -0.84%",
      "Propongo 20 tickers por sector, ~$2M de cap mínima",
      "```",
      "total = 12345 registros",
      "```",
      "Dato duro: $9,999 USD",
      "commit `5131739` y `total=99999`",
    ].join("\n");
    const audit = auditNumbers(text, []);
    expect(audit.unverified).toEqual(["$9,999 USD"]);
  });

  it("does not exempt a line because it contains a hyphenated date", () => {
    const audit = auditNumbers("El 2026-08-16 cerró en $1,234 USD.", []);
    expect(audit.unverified).toEqual(["$1,234 USD"]);
  });
});

describe("R1 audit calibration (2026-08-23 corpus classes)", () => {
  it("does not flag plan counts, ports/PIDs, thresholds, idiomatic 100%, deltas, spec ids, tech units, ranges' first half, ledger lines", () => {
    const text = [
      "¿Arrancamos con el Paso A — las 4 páginas faltantes? Top 5 empresas a seguir.",
      "El demo está corriendo en PID 776741 en el puerto 3001; HIPAA, GDPR, SOC 2, ISO 27001.",
      "Underperforming Skills (active, <40% success on 5+ uses); h-24 → h-36 (144px, +50%).",
      "tipografía 100% garantizada; el archivo tiene 10619 chars y 3,400 tokens.",
      "cotiza en $0.00–$0.01 y el rango 10–20% se mantiene.",
      "✔ Verificado: KB logs/x.md (sha d6474a8e, 10619 chars, 2026-08-23 05:31:19)",
      "los 4 archivos tienen:",
      "1. Nav viejo",
      "ver [ventas 8,900 unidades](notas.md)",
    ].join("\n");
    const audit = auditNumbers(text, []);
    expect(audit.unverified).toEqual(["$0.01", "20%"]);
  });

  it("parses Spanish separators and signed figures to their real values", () => {
    const figs = extractFigures(
      "Cayó 1,5 millones; hace 3.800 millones de años; perdió -45,000 pesos y −12% de margen; 1.234,56 euros; 1,234.5 USD.",
    );
    expect(figs.map((f) => [f.raw, f.value])).toEqual([
      ["1,5 millones", 1.5e6],
      ["3.800 millones", 3.8e9],
      ["-45,000 pesos", -45000],
      ["−12%", -12],
      ["1.234,56 euros", 1234.56],
      ["1,234.5 USD", 1234.5],
    ]);
    // Signed figures verify against their unsigned evidence.
    expect(
      auditNumbers("perdió -45,000 pesos y −12% de margen", ["loss: 45000; margin -12"]).unverified,
    ).toEqual([]);
  });

  it("0.35 in the text matches 35% in the evidence; 94 never matches inside 10.0.94.0", () => {
    expect(auditNumbers("margen 0.35 de 1,200 ventas", ["35%", "1200"]).unverified).toEqual([]);
    expect(auditNumbers("quedan 94 filas", ["host 10.0.94.0 reachable"]).unverified).toEqual(["94"]);
  });

  it("counts below 10 are not claims; a figure in backticks is still a figure; a hash in backticks is not", () => {
    expect(auditNumbers("3 hospitales y 12 hospitales", []).unverified).toEqual(["12"]);
    expect(auditNumbers("Ingresos `$9,400,000` confirmados; commit `5131739`.", []).unverified).toEqual(["$9,400,000"]);
  });

  it("requires CHECKABLE provenance: fuente: memoria, a URL elsewhere in the paragraph, and 'por ejemplo' do not source a figure", () => {
    const text = [
      "Ingresos: $9,400,000.",
      "fuente: memoria",
      "",
      "El mercado vale $5.16B y crecerá 42%.",
      "Ver https://google.com para más.",
      "",
      "Por ejemplo, cerramos con $7,700,000 confirmados.",
      "",
      "Ventas Q2: $1,200,000 MXN. fuente: shell_exec wc -l ventas.csv",
      "",
      "| Métrica | Valor | Fuente |",
      "| Usuarios | 80M | INEGI 2024 |",
    ].join("\n");
    expect(auditNumbers(text, []).unverified).toEqual(["$9,400,000", "$5.16B", "42%", "$7,700,000"]);
  });

  it("a figure already marked (sin verificar) stays unverified (artifacts) but is not re-marked (chat)", () => {
    const text = "Ventas de 45,000 unidades (sin verificar) y 12,000 clientes.";
    const audit = auditNumbers(text, []);
    expect(audit.unverified).toEqual(["45,000", "12,000"]);
    const out = annotateUnverified(text, audit);
    expect(out.text).toBe("Ventas de 45,000 unidades (sin verificar) y 12,000 clientes (sin verificar).");
    expect(out.annotated).toBe(1);
  });
});

describe("R2 audit folds", () => {
  it("C-5: the incident shape '| Filas | 34 |' is a claim (pipe = 'noun before'); a bare cell without a count noun is not (R3 W-2: 12/13 FP on the corpus); '1250 filas' is a count, 'Ventas | 2025' a year", () => {
    const text = "| Métrica | Valor |\n|---|---|\n| Filas | 34 |\n| Columnas | 12 |\n| Año | 2025 |\n| Nulos | 850 |\n| 1 | Jalisco | 2867 | $9,400,000 |";
    expect(auditNumbers(text, []).unverified).toEqual(["34", "$9,400,000"]);
    expect(auditNumbers("Procesamos 1250 filas.", []).unverified).toEqual(["1250"]);
    expect(auditNumbers("Ventas | 2025 | Norte", []).unverified).toEqual([]);
  });

  it("W-2: '2.500 clientes' is 2,500; MDP/MDD are currency magnitudes", () => {
    const figs = extractFigures("Tenemos 2.500 clientes activos y 9,4 MDP de ingresos; 1.2 MDD en deuda.");
    expect(figs.map((f) => [f.raw, f.value, f.kind])).toEqual([
      ["2.500", 2500, "count"],
      ["9,4 MDP", 9.4e6, "currency"],
      ["1.2 MDD", 1.2e6, "currency"],
    ]);
  });

  it("W-1: code blocks are audited for artifacts (includeCode) but not for chat", () => {
    const text = "Resultado:\n\n```json\n{\"ingresos\": 9400000}\n```\n";
    expect(auditNumbers(text, []).found).toEqual([]);
    expect(auditNumbers(text, [], { includeCode: true }).unverified).toEqual(["9400000"]);
  });

  it("W-4/W-5: 'fuente: a/b' and 'https://memoria' are not checkable; $0.35 never matches a bare 35", () => {
    expect(auditNumbers("Ingresos: $9,400,000.\nfuente: el equipo/ventas", []).unverified).toEqual(["$9,400,000"]);
    expect(auditNumbers("Ingresos: $9,400,000.\nfuente: https://memoria", []).unverified).toEqual(["$9,400,000"]);
    expect(auditNumbers("Ingresos: $9,400,000.\nfuente: /root/claude/x/ventas.csv", []).unverified).toEqual([]);
    expect(auditNumbers("$0.35 por acción", ["nada 35 aqui"]).unverified).toEqual(["$0.35"]);
    expect(auditNumbers("ratio 0.35 del total", ["35% share"]).unverified).toEqual([]);
  });
});

describe("R3/R4 pins", () => {
  it("C-2: an all-digit git SHA in backticks is never a figure, even in an artifact", () => {
    expect(auditNumbers("commit `6486327` y `3320604`; hash `9705377abc`", [], { includeCode: true }).found).toEqual([]);
    expect(auditNumbers("total `1234567` registros", [], { includeCode: true }).found).toEqual([]);
    expect(auditNumbers("total `$1,234,567`", [], { includeCode: true }).found).toEqual(["$1,234,567"]);
  });

  it("W-1: 'clientes: 2.500' in a tool result verifies '2.500 clientes' in the text (both readings)", () => {
    expect(auditNumbers("Tenemos 2.500 clientes.", ["clientes: 2.500"]).unverified).toEqual([]);
    expect(auditNumbers("Tenemos 2.500 clientes.", ["clientes: 2.5"]).unverified).toEqual(["2.500"]);
  });
});

describe("extractFigures / blockAround", () => {
  it("reports positions usable for inline edits", () => {
    const text = "Cap de $10,600 M y 94 filas.";
    const figs = extractFigures(text);
    expect(
      figs.map((f) => [f.raw, text.slice(f.index, f.index + f.raw.length)]),
    ).toEqual([
      ["$10,600 M", "$10,600 M"],
      ["94", "94"],
    ]);
    expect(figs[0]!.value).toBe(10.6e9);
  });

  it("returns the table plus one adjacent line for a figure in a table", () => {
    const text = "Intro\n\n| a | 1,500 |\n| b | 2,500 |\nfuente: x\n\nOutro";
    expect(blockAround(text, text.indexOf("2,500"))).toBe(
      "| a | 1,500 |\n| b | 2,500 |\nfuente: x",
    );
    expect(blockAround(text, 0)).toBe("Intro");
  });
});

describe("annotateUnverified", () => {
  it("marks the first occurrence inline, is idempotent, caps at 8 and counts the rest", () => {
    const text = "Tubi tiene 80M usuarios y 71% de retención; repito 80M.";
    const once = annotateUnverified(text, auditNumbers(text, []));
    expect(once.text).toBe(
      "Tubi tiene 80M usuarios (sin verificar) y 71% (sin verificar) de retención; repito 80M.",
    );
    expect(once.annotated).toBe(2);
    const twice = annotateUnverified(once.text, auditNumbers(once.text, []));
    expect(twice.text).toBe(once.text);
    expect(twice.annotated).toBe(0);

    const many = Array.from(
      { length: 11 },
      (_, i) => `$${i + 1},${100 + i} USD`,
    ).join("; ");
    const out = annotateUnverified(many, auditNumbers(many, []));
    expect(out.annotated).toBe(8);
    expect(out.text).toMatch(/⚠️ Y 3 cifras más sin respaldo/);
    expect(out.text.startsWith("$1,100 USD (sin verificar)")).toBe(true);
  });
});

describe("tool-evidence collector", () => {
  it("records per task, digests long items, caps the total, and frees on take", () => {
    recordToolEvidence("t1", "short");
    recordToolEvidence("t1", "x".repeat(20_000));
    recordToolEvidence("t2", "other");
    expect(peekToolEvidence("t1")).toHaveLength(2);
    const t1 = takeToolEvidence("t1");
    expect(t1).toHaveLength(2);
    expect(t1[1]!.length).toBeLessThan(20_000);
    expect(t1[1]).toContain(" … ");
    expect(takeToolEvidence("t1")).toEqual([]); // freed
    expect(peekToolEvidence("t1")).toEqual([]);
    expect(takeToolEvidence("t2")).toEqual(["other"]);
    // Cap: 256KB total per task — later items are dropped, earliest kept.
    for (let i = 0; i < 40; i++)
      recordToolEvidence("t3", `${i}:` + "y".repeat(8000));
    const t3 = takeToolEvidence("t3");
    expect(t3.length).toBeLessThan(40);
    expect(t3[0]!.startsWith("0:")).toBe(true);
    recordToolEvidence("", "ignored");
    recordToolEvidence("t4", "");
    expect(takeToolEvidence("t4")).toEqual([]);
  });
});

describe("footer + flag", () => {
  it("formats a Spanish footer capped at 8 items and reads the annotate flag (on by default)", () => {
    expect(formatUnverifiedFooter({ unverified: [] })).toBe("");
    const footer = formatUnverifiedFooter({
      unverified: Array.from({ length: 10 }, (_, i) => `${i + 10}%`),
    });
    expect(footer).toContain("10%, 11%, 12%, 13%, 14%, 15%, 16%, 17% (+2)");
    expect(numbersAnnotateEnabled({})).toBe(true);
    expect(
      numbersAnnotateEnabled({ TASK_GATES_NUMBERS_ANNOTATE: "true" }),
    ).toBe(true);
    expect(
      numbersAnnotateEnabled({ TASK_GATES_NUMBERS_ANNOTATE: "false" }),
    ).toBe(false);
  });
});
