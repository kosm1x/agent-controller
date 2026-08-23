/**
 * V8.4 — numbers-provenance audit for delivered reports and artifact writes.
 *
 * unlazy's most reproducible finding: reports whose numbers were wrong while
 * their substance was right — "34 stat rows" written from memory where 17
 * exist. Jarvis already has a numbers rule (`mc-ctl audit-claim`, CLAUDE.md)
 * and the S2/V8.2 critics check numbers post-hoc with an LLM. This is the
 * free deterministic layer under both: every claim-class figure in the text
 * is looked up in the run's evidence corpus (read-class tool results + the
 * user's own message); figures found nowhere are UNVERIFIED.
 *
 * Usability plan Phase 3 (2026-08-23) armed it: an unverified figure in a
 * chat deliverable is annotated inline `(sin verificar)` (never rewritten,
 * never blocked); an unverified figure in an artifact write (KB / Sheets /
 * Docs) is REJECTED by the handler unless its block carries CHECKABLE
 * provenance (`fuente: <url|path|tool>`, `calc: <expr>`, `supuesto: …`) —
 * see provenance-gate.ts.
 *
 * Calibration (R1 audit 2026-08-23 over 189 real deliverables): a naive
 * "every number" rule marks half of all replies with a 23 % structural
 * false-positive floor. The claim rules below exist to cut exactly the
 * classes that replay surfaced — list/plan counts ("las 4 páginas"), ports
 * and PIDs, thresholds ("<40%"), idiomatic "100%", CSS deltas ("+50%"),
 * spec identifiers ("ISO 27001"), technical measurements ("10619 chars"),
 * range halves ("$0.00–$0.01"), ledger lines, code — and the value
 * equivalence exists for the same value in another format ($7.8B vs
 * $7,800M, 94 vs 94.0, 45.5M vs 45,512,300, 0.35 vs 35%). Spanish number
 * grammar (1,5 millones · 3.800 millones · 1.234,56) and signed figures
 * (−12 %, -45,000) parse to their real values.
 *
 * Corpus: `recordToolEvidence()` is called from `ToolRegistry.execute` for
 * READ-class tool results (never errors) and from the router with the
 * user's message; `takeToolEvidence()` hands it to the dispatcher at
 * completion and frees it; `peekToolEvidence()` lets a write handler read
 * it mid-run without freeing.
 */

import { isLedgerLine } from "./ledger-lines.js";

const MAX_ITEM_CHARS = 8 * 1024;
const MAX_TASK_CHARS = 256 * 1024;

const evidenceByTask = new Map<string, { chunks: string[]; size: number }>();

export function recordToolEvidence(taskId: string, text: string): void {
  if (!taskId || !text) return;
  const digest =
    text.length > MAX_ITEM_CHARS
      ? `${text.slice(0, MAX_ITEM_CHARS / 2)} … ${text.slice(-MAX_ITEM_CHARS / 2)}`
      : text;
  let entry = evidenceByTask.get(taskId);
  if (!entry) {
    entry = { chunks: [], size: 0 };
    evidenceByTask.set(taskId, entry);
  }
  if (entry.size + digest.length > MAX_TASK_CHARS) return; // cap: keep the earliest evidence
  entry.chunks.push(digest);
  entry.size += digest.length;
}

/** Returns the corpus recorded for the task and forgets it. */
export function takeToolEvidence(taskId: string): string[] {
  const entry = evidenceByTask.get(taskId);
  evidenceByTask.delete(taskId);
  writtenByTask.delete(taskId);
  return entry ? entry.chunks : [];
}

/** Returns the corpus recorded so far WITHOUT freeing it (mid-run readers). */
export function peekToolEvidence(taskId: string): string[] {
  return evidenceByTask.get(taskId)?.chunks ?? [];
}

/**
 * Artifacts this run WROTE (KB paths, file paths, doc/sheet ids): a read of
 * one of them is not evidence — the model would be sourcing its own claim
 * (R2 audit C-4). Keyed per task; freed with the corpus.
 */
const writtenByTask = new Map<string, Set<string>>();

export function recordRunWrite(taskId: string, key: string): void {
  if (!taskId || !key) return;
  let set = writtenByTask.get(taskId);
  if (!set) {
    set = new Set();
    writtenByTask.set(taskId, set);
  }
  set.add(key);
}

/**
 * Tools whose results are EVIDENCE for figures — tools that OBSERVE the
 * world (files, APIs, the shell, the web, databases). An allow-list by
 * name and nothing else: `readOnlyHint` is a side-effect annotation, so it
 * excludes `shell_exec` (can write) and includes `humanize_text` /
 * `video_script` / `memory_search` (no side effects, but they GENERATE or
 * recall model-authored text — R2 audit C-1, R3 audit C-5). MCP bridges
 * carry no hints; their reads count. Market WRITE tools are listed out.
 */
export const EVIDENCE_TOOL_RE =
  /^(shell_exec|http_fetch|file_read|list_dir|grep|glob|code_search|git_(?:status|diff|log)|vps_(?:status|logs)|jarvis_file_(?:read|list|search)|gsheets_read|gdocs_read(?:_full)?|gdrive_(?:list|download)|gslides_read|gmail_(?:search|read)|calendar_list|web_read|web_search|exa_search|pdf_read|data_summarize|gemini_research|market_(?:quote|history|indicators|scan|signals|watchlist_list|budget_stats|calendar)|prediction_markets|paper_(?:portfolio|history)|pm_(?:paper_portfolio|paper_history|alpha_latest)|whale_trades|macro_regime|sentiment_snapshot|alpha_(?:latest|explain)|backtest_latest|seo_(?:page_audit|robots_audit|telemetry)|tweet_(?:mentions|probe)|project_(?:get|list)|list_schedules|evolution_get_data|knowledge_map|learner_model_status|user_fact_list|dashboard_list|crm_query|intel_\w+|task_history|rss_\w+|weather\w*|currency\w*|geocod\w*|[\w-]+__\w+)$/;

/** Reads whose TARGET can be defaulted away (grep with no `path` = cwd): with a write on record they are not evidence (R4 W4-2). */
export const UNRESOLVED_TARGET_TOOL_RE = /^(grep|glob|code_search|list_dir)$/;

export function hasRunWrites(taskId: string): boolean {
  return (writtenByTask.get(taskId)?.size ?? 0) > 0;
}

export function isEvidenceTool(name: string): boolean {
  return EVIDENCE_TOOL_RE.test(name);
}

/** Path-like written key → its ancestors and stem, so a read of the parent or the stem is excluded too. */
function keyVariants(key: string): string[] {
  const out = new Set<string>([key]);
  if (key.includes("/") || key.includes(".")) {
    const parts = key.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("/"));
    const base = parts[parts.length - 1] ?? "";
    if (base) {
      out.add(base);
      const stem = base.replace(/\.[^.]+$/, "");
      if (stem.length >= 4) out.add(stem);
    }
  }
  return [...out];
}

/**
 * True when any artifact written earlier in this run — or its directory /
 * file stem — appears in `argText` (R3 audit C-4: containment must hold in
 * both directions; `grep proyectos` covers `proyectos/notas.md`).
 */
export function targetsRunWrite(taskId: string, argText: string): boolean {
  const set = writtenByTask.get(taskId);
  if (!set || !argText) return false;
  for (const key of set)
    for (const v of keyVariants(key)) if (argText.includes(v)) return true;
  return false;
}

/** @internal test hook */
export function _resetToolEvidence(): void {
  evidenceByTask.clear();
  writtenByTask.clear();
}

// ── number grammar ─────────────────────────────────────────────────────────

export type FigureKind =
  "currency" | "percent" | "magnitude" | "count" | "plain";

export interface Figure {
  /** As written, trimmed (e.g. `$7,800M`, `94`, `-12%`). */
  raw: string;
  /** Numeric value with sign and magnitude applied (`$7,800M` → 7.8e9). */
  value: number;
  kind: FigureKind;
  /** Offset of `raw` in the text. */
  index: number;
  /** Offset just past the count noun, when one follows — where a mark goes. */
  markAt: number;
}

/**
 * Token: optional sign (only after whitespace / start / opening bracket, so
 * `2026-08-16` and `10-20%` keep their hyphens), optional currency prefix,
 * digits with `,`/`.` groups, optional unit. Not part of an identifier
 * (`v8.4`, `G1`, `#12`), a clock time, a URL path or a version.
 */
const NUMBER_RE =
  /(?<![\w.#/:\-−])(?:(?<=^|[\s(«"'])([-−]))?(\$|USD\s?\$?|MXN\s?\$?|€|£)?\s?(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)\s?(%|k|K|MM|MDP|MDD|M|B|bn|mil\s+millones|millones|mil|billones|USD|MXN|d[oó]lares|pesos|euros)?(?![\w/:\-]|[.,]\d)/gm;

const MAGNITUDE: Record<string, number> = {
  k: 1e3,
  K: 1e3,
  mil: 1e3,
  M: 1e6,
  MM: 1e6,
  MDP: 1e6, // millones de pesos
  MDD: 1e6, // millones de dólares
  millones: 1e6,
  B: 1e9,
  bn: 1e9,
  "mil millones": 1e9,
  billones: 1e12,
};

const CURRENCY_SUFFIX = /^(USD|MXN|MDP|MDD|d[oó]lares|pesos|euros)$/i;

/**
 * Interpret separators: `1,234` / `1.234.567` / `1.234,56` are thousands
 * groups; a single `.ddd` group is thousands only with a unit (`3.800
 * millones`), else a decimal; `1,5` / `16,90` are decimal commas.
 */
export function parseDigits(digits: string, hasUnit: boolean): number {
  let s = digits;
  if (/^\d{1,3}(\.\d{3}){2,}(,\d+)?$/.test(s))
    s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(,\d{3}){2,}(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else if (/^\d{1,3}\.\d{3},\d+$/.test(s))
    s = s.replace(".", "").replace(",", ".");
  else if (/^\d{1,3},\d{3}\.\d+$/.test(s)) s = s.replace(",", "");
  else if (/^\d{1,3},\d{3}$/.test(s)) s = s.replace(",", "");
  else if (/^\d{1,3}\.\d{3}$/.test(s)) s = hasUnit ? s.replace(".", "") : s;
  else s = s.replace(",", ".");
  return Number(s);
}

function parseValue(
  sign: string | undefined,
  digits: string,
  unit: string | undefined,
  counted = false,
): number {
  const n = parseDigits(digits, Boolean(unit) || counted);
  const key = unit?.replace(/\s+/g, " ");
  const mult = key
    ? (MAGNITUDE[key] ?? MAGNITUDE[key.toLowerCase()])
    : undefined;
  const v = mult ? n * mult : n;
  return sign ? -v : v;
}

// ── claim rules ────────────────────────────────────────────────────────────

/**
 * Data-entity nouns that turn a bare count into a claim ("94 filas", "7,000
 * sucursales"). Time units are deliberately absent ("en 2 días" is a plan);
 * so are the model's own deliverable units (páginas, pasos, secciones).
 */
const COUNT_NOUNS =
  "(filas?|registros?|rows?|records?|usuari[oa]s?|sucursales?|emplead[oa]s?|empresas?|clientes?|personas?|tiendas?|unidades?|marcas?|anunciantes?|contratos?|mercados?|acciones|papers?|art[ií]culos?|estudios?|pacientes?|hospitales?|ciudades?|municipios?|pa[ií]ses|hallazgos?|resultados?|documentos?|archivos?|tweets?|posts?|mensajes?|correos?|leads?|ventas|pedidos?|[oó]rdenes|transacciones|visitas?|vistas?|descargas?|seguidores|suscriptores|miembros|socios|km|m2|m²|hect[aá]reas|toneladas|MW|GW|TWh|kWh|habitantes|votos|casos|muertes|defunciones|nacimientos|escuelas|alumnos|estudiantes|vacantes|puestos|camas|vuelos|viviendas|hogares|vehículos|autos|coches)";
const COUNT_NOUN_AFTER_RE = new RegExp(
  String.raw`^\+?[ \t]+(?:nuev[oa]s?[ \t]+|de[ \t]+)?${COUNT_NOUNS}\b`,
  "i",
);
/** The same nouns BEFORE the number on the same line: "filas procesadas: 94". */
const COUNT_NOUN_BEFORE_RE = new RegExp(
  String.raw`\b${COUNT_NOUNS}\b[^\n\d|]{0,25}[:=|][ \t]*$`,
  "i",
);

/** A count below this is a plan/list size, not a statistic ("las 4 páginas"). */
const MIN_COUNT = 10;

/** Identifier words before a number: the number names something, it does not measure. */
const IDENT_BEFORE_RE =
  /\b(pid|puerto|port|id|task|tarea|l[ií]nea|line|iso|soc|rfc|curp|c[oó]digo|code|folio|ref|version|versi[oó]n|commit|build|http|status|error|ticket|issue|pr|n[uú]mero|no\.|nº|tel|cel|ext|cve|clave|sku|orden|order|invoice|factura|ruta|route|serie|modelo|model)\s*[:#]?\s*$|#\s*$/i;
/** Technical measurement units after a number — harness/devops prose, not a world claim. */
const TECH_UNIT_AFTER_RE =
  /^[ \t]?(px|ms|s|seg|segundos?|min|chars?|caracteres|tokens?|bytes?|KB|MB|GB|l[ií]neas|lines|turnos?|rounds?|commits?|tests?|pruebas|iteraciones|retries|intentos|veces)\b/i;
/** A percent preceded by a comparison or delta operator is a threshold/delta, not a claim. */
const OPERATOR_BEFORE_RE = /[<>≥≤+±]\s?=?\s?$/;

interface Token {
  whole: string;
  sign?: string;
  currency?: string;
  digits: string;
  unit?: string;
  index: number;
}

function kindOf(n: Token, before: string, after: string): FigureKind | null {
  const { currency, unit, digits } = n;
  if (IDENT_BEFORE_RE.test(before)) return null;
  if (TECH_UNIT_AFTER_RE.test(after)) return null;
  if (/^0\d/.test(digits)) return null; // leading-zero code (zip, folio)
  if (currency || (unit && CURRENCY_SUFFIX.test(unit))) return "currency";
  if (unit === "%") {
    if (OPERATOR_BEFORE_RE.test(before)) return null;
    if (/^100$/.test(digits) && !/^[ \t]+de\b/.test(after)) return null; // idiomatic "100% garantizado"
    return "percent";
  }
  if (unit) return "magnitude";
  const countedAfter = COUNT_NOUN_AFTER_RE.test(after);
  const counted = countedAfter || COUNT_NOUN_BEFORE_RE.test(before);
  // "2.500 clientes": a single .ddd group before a count noun is thousands.
  const value = parseDigits(digits, counted);
  const integer = String(Math.trunc(Math.abs(value)));
  const separated = /[.,]\d{3}\b/.test(digits);
  // A bare 4-digit number in 1000–2099 is a year far more often than a figure
  // — unless a count noun FOLLOWS it ("1250 filas", R3 W-6); "Ventas | 2025"
  // keeps the year reading.
  const year =
    !separated && integer.length === 4 && /^(1\d|20)\d{2}$/.test(integer);
  if (counted) return Math.abs(value) >= MIN_COUNT && (countedAfter || !year) ? "count" : null;
  if (year) return null;
  if (separated && integer.length >= 4) return "plain";
  if (!separated && integer.length >= 5 && integer.length <= 7) return "plain";
  return null;
}

/** Every number in the text (claim-class or not) — used for the corpus side. */
function* allNumbers(text: string): Generator<Token> {
  for (const m of text.matchAll(NUMBER_RE)) {
    const [whole, sign, currency, digits, unit] = m;
    if (!digits) continue;
    yield { whole, sign, currency, digits, unit, index: m.index ?? 0 };
  }
}

/**
 * Ranges of fenced code, inline code, markdown links and ledger lines —
 * never claims in chat. For an ARTIFACT write (`includeCode`) code is not
 * exempt: a ```json block of figures written to the KB is still a claim
 * (R2 audit W-1).
 */
function exemptRanges(
  text: string,
  includeCode = false,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (!includeCode) {
    const fence = /^\s*(```|~~~)/gm;
    let open: number | null = null;
    for (const m of text.matchAll(fence)) {
      if (open === null) open = m.index ?? 0;
      else {
        out.push([open, (m.index ?? 0) + m[0].length]);
        open = null;
      }
    }
    if (open !== null) out.push([open, text.length]);
  }
  // Inline code: `5131739` is a commit hash — but a figure hidden in
  // backticks (`$9,400,000`) is still a figure (R1 audit C5).
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const i = m.index ?? 0;
    if (/[$%€£]|\b(?:M|MM|B|bn|mil|millones|USD|MXN)\b/.test(m[1]!)) continue;
    // A git short/long SHA (3.7 % are all-digit) is never a figure (R3 C-2).
    if (/^[0-9a-f]{7,40}$/i.test(m[1]!.trim())) {
      if (!inRanges(out, i)) out.push([i, i + m[0].length]);
      continue;
    }
    if (includeCode && /\d{2,}/.test(m[1]!)) continue;
    if (!inRanges(out, i)) out.push([i, i + m[0].length]);
  }
  // Markdown links: label and URL.
  for (const m of text.matchAll(/\[[^\]\n]*\]\([^)\n]*\)/g)) {
    const i = m.index ?? 0;
    if (!inRanges(out, i)) out.push([i, i + m[0].length]);
  }
  let offset = 0;
  for (const line of text.split("\n")) {
    if (isLedgerLine(line)) out.push([offset, offset + line.length]);
    offset += line.length + 1;
  }
  return out;
}

function inRanges(ranges: Array<[number, number]>, i: number): boolean {
  return ranges.some(([a, b]) => i >= a && i < b);
}

function lineStart(text: string, index: number): number {
  return text.lastIndexOf("\n", index - 1) + 1;
}

/** Claim-class figures in `text`, in text order. */
export function extractFigures(text: string, includeCode = false): Figure[] {
  const out: Figure[] = [];
  const exempt = exemptRanges(text, includeCode);
  for (const n of allNumbers(text)) {
    const start = n.index + (n.whole.length - n.whole.trimStart().length);
    if (inRanges(exempt, start)) continue;
    const end = n.index + n.whole.length;
    const after = text.slice(end, end + 40);
    const before = text.slice(
      Math.max(lineStart(text, start), start - 40),
      start,
    );
    // First half of a range ("$0.00–$0.01", "10–20%"): the second half carries the claim.
    if (/^[ \t]?[–—-][ \t]?[$€£]?\d/.test(after)) continue;
    const kind = kindOf(n, before, after);
    if (!kind) continue;
    const value = parseValue(n.sign, n.digits, n.unit, kind === "count");
    if (!Number.isFinite(value)) continue;
    const noun = COUNT_NOUN_AFTER_RE.exec(after);
    out.push({
      raw: n.whole.trim(),
      value,
      kind,
      index: start,
      markAt: noun ? end + noun[0].length : end,
    });
  }
  return out;
}

// ── provenance ─────────────────────────────────────────────────────────────

/**
 * A provenance value a stranger could check: a URL, a file path, or a
 * read-class tool / data source name (optionally with its query).
 * "memoria", "análisis propio" or "yo" are not provenance (R1 audit C5).
 */
export const CHECKABLE_SOURCE_RE =
  /https?:\/\/[\w.-]+\.[a-z]{2,}(?:[/?#]\S*)?|(?:^|[\s(`*])(?:\/|~\/|\.\/)[\w./-]+|\b[\w-]+\.(?:csv|xlsx?|json|jsonl|md|pdf|txt|tsv|sql|docx?)\b|\b(?:shell_exec|gsheets_read|gdocs_read(?:_full)?|gdrive_\w+|web_read|web_search|exa_search|file_read|data_summarize|pdf_read|http_fetch|market_\w+|prediction_markets|crm_query|intel_\w+|jarvis_file_read|task_history|code_search|[\w-]+__\w+)\b/i;

const SOURCE_LINE_RE = /\b(fuentes?|sources?)\s*:\s*([^\n|]+)/gi;
const CALC_LINE_RE = /\b(calc|c[aá]lculo)\s*:\s*([^\n|]+)/gi;
const ASSUMPTION_LINE_RE = /\bsupuestos?\s*:\s*[^\n|]{4,}/i;
/** A table whose header names a source/calc column. */
const SOURCE_COLUMN_RE =
  /^\s*\|[^\n]*\|\s*(fuentes?|sources?|calc|c[aá]lculo|supuestos?)\s*\|/im;

/** Does a block carry checkable provenance for the figure on `figureLine`? */
export function blockHasProvenance(
  block: string,
  figureLine: string,
  sourceOk: (value: string) => boolean = (v) => CHECKABLE_SOURCE_RE.test(v),
): boolean {
  for (const m of block.matchAll(SOURCE_LINE_RE)) {
    if (sourceOk(m[2]!)) return true;
  }
  for (const m of block.matchAll(CALC_LINE_RE)) {
    if (
      /[=+\-×*/÷%]|\b(suma|promedio|sum|avg|mean|count|conteo|total)\b/i.test(
        m[2]!,
      )
    )
      return true;
  }
  if (ASSUMPTION_LINE_RE.test(block)) return true;
  if (SOURCE_COLUMN_RE.test(block)) return true;
  // A URL on the figure's own line attributes the figure (weak but visible).
  return /https?:\/\/\S+/.test(figureLine);
}

/**
 * Markers within a short window before/after the figure that present it as
 * an estimate, proposal or a shown calculation — not a factual claim. A
 * window, not the line: "Por ejemplo, cerramos con $9,400,000" no longer
 * exempts the figure because the line holds a soft word (R1 audit C5).
 */
const ESTIMATE_BEFORE_RE =
  /(\b(aprox\w*|estimad\w*|estimaci[oó]n|propuest\w*|propongo|sugier\w*|sugerid\w*|supuesto\w*|hip[oó]tesis|hipot[eé]tic\w*|escenario\w*)\b|[≈~])[^\n]{0,25}$/i;
const ESTIMATE_AFTER_RE = /^[^\n]{0,20}\b(aprox\w*|estimad\w*|supuest\w*)\b/i;
const CALC_AFTER_RE =
  /^[^\n]{0,40}(\d\s*[+×÷*/]\s*\d|\)\s*\/\s*\d|=\s*-?\$?\d)/;
const CALC_BEFORE_RE = /(\d\s*[+×÷*/]\s*\d|\)\s*\/\s*\d)[^\n]{0,40}$/;

/** Paragraph around an index, or the table plus one adjacent line. */
export function blockAround(text: string, index: number): string {
  const lines = text.split("\n");
  let offset = 0;
  let li = 0;
  for (; li < lines.length; li++) {
    const len = lines[li]!.length + 1;
    if (index < offset + len) break;
    offset += len;
  }
  const isTable = (s: string) => s.trimStart().startsWith("|");
  const blank = (s: string) => s.trim() === "";
  let a = li;
  let b = li;
  if (isTable(lines[li] ?? "")) {
    while (a > 0 && isTable(lines[a - 1]!)) a--;
    while (b < lines.length - 1 && isTable(lines[b + 1]!)) b++;
    if (a > 0 && !blank(lines[a - 1]!)) a--;
    if (b < lines.length - 1 && !blank(lines[b + 1]!)) b++;
  } else {
    while (a > 0 && !blank(lines[a - 1]!)) a--;
    while (b < lines.length - 1 && !blank(lines[b + 1]!)) b++;
  }
  return lines.slice(a, b + 1).join("\n");
}

// ── audit ──────────────────────────────────────────────────────────────────

export interface NumbersAudit {
  /** Every claim-class figure found (as written, deduped by value). */
  found: string[];
  /** Figures with no corpus support and no provenance in their block. */
  unverified: string[];
  /** The same, with positions — for inline annotation. */
  unverifiedFigures: Figure[];
}

function decimalsOf(fig: Figure): number {
  const m = /\.(\d+)/.exec(String(Math.abs(fig.value)));
  return m ? m[1]!.length : 0;
}

/** Every numeric value in the corpus, with and without magnitudes applied. */
function corpusValues(corpus: readonly string[]): number[] {
  const vals: number[] = [];
  for (const chunk of corpus) {
    for (const n of allNumbers(chunk)) {
      const bare = parseDigits(n.digits, Boolean(n.unit));
      if (!Number.isFinite(bare)) continue;
      vals.push(bare);
      // "clientes: 2.500" in a tool result is 2,500 as often as 2.5 (R3 W-1).
      if (!n.unit && /^\d{1,3}\.\d{3}$/.test(n.digits)) vals.push(parseDigits(n.digits, true));
      if (n.unit && n.unit !== "%") {
        const withMag = parseValue(undefined, n.digits, n.unit);
        if (withMag !== bare) vals.push(withMag);
      }
    }
  }
  return vals;
}

function valueSupported(fig: Figure, vals: readonly number[]): boolean {
  const v0 = Math.abs(fig.value);
  const candidates =
    fig.kind === "percent"
      ? [v0, v0 / 100]
      : v0 < 1 && v0 !== 0 && fig.kind !== "currency"
        ? [v0, v0 * 100] // 0.35 in the text, "35%" in the evidence — never for $0.35
        : [v0];
  const dec = decimalsOf(fig);
  const sig = significantDigits(fig.raw);
  for (const v of candidates) {
    if (v === 0) continue;
    for (const w of vals) {
      if (w === v) return true;
      // The corpus value ROUNDED to the figure's own precision: 45.5M vs
      // 45,512,300 ✓, 0.84% vs 0.8372 ✓ — but 1,742 vs 1,741 ✗ (an
      // off-by-one count is exactly the fabrication class; R4 fold).
      if (sig > 0 && roundSig(w, sig) === roundSig(v, sig) && Math.abs(w - v) / v < 0.05) return true;
      if (dec > 0 && Math.abs(w - v) < 0.5 * 10 ** -dec) return true;
    }
  }
  return false;
}

/** Significant digits of a figure as written ("45.5M" → 3, "1,742" → 4, "$7,800M" → 4). */
function significantDigits(raw: string): number {
  const m = /\d[\d,.]*/.exec(raw);
  if (!m) return 0;
  const digits = m[0].replace(/[^\d]/g, "").replace(/^0+/, "");
  return digits.length;
}

function roundSig(x: number, sig: number): number {
  if (x === 0) return 0;
  const mag = Math.floor(Math.log10(Math.abs(x)));
  const factor = 10 ** (sig - 1 - mag);
  return Math.round(x * factor) / factor;
}

/** Digits of the figure as a token in the corpus — `94` never matches inside `10.0.94.0`. */
function digitsSupported(fig: Figure, haystack: string): boolean {
  const key = String(Math.abs(fig.value));
  if (!/^\d+(\.\d+)?$/.test(key) || key.length < 2) return false;
  const re = new RegExp(`(?<![\\d.])${key.replace(".", "\\.")}(?![\\d.])`);
  return re.test(haystack);
}

/**
 * Audit claim-class figures in `text` against the run's evidence corpus. A
 * figure is verified when an equal value appears in the corpus in any
 * format, when its digits appear as a token, or when its block carries
 * checkable provenance. Estimates, shown calculations, code, links and
 * ledger lines are not claims.
 */
export function auditNumbers(
  text: string,
  corpus: readonly string[],
  opts: {
    includeCode?: boolean;
    /** Artifact gate: a `fuente:` naming a tool must name one that ran (R3 C-3). */
    sourceOk?: (value: string) => boolean;
  } = {},
): NumbersAudit {
  const haystack = corpus.join("\n").replace(/(\d),(\d{3})\b/g, "$1$2");
  const vals = corpusValues(corpus);
  const found: string[] = [];
  const unverified: string[] = [];
  const unverifiedFigures: Figure[] = [];
  const seen = new Set<string>();
  for (const fig of extractFigures(text, opts.includeCode)) {
    const ls = lineStart(text, fig.index);
    const before = text.slice(ls, fig.index);
    const after = text.slice(
      fig.index + fig.raw.length,
      fig.index + fig.raw.length + 60,
    );
    if (ESTIMATE_BEFORE_RE.test(before) || ESTIMATE_AFTER_RE.test(after))
      continue;
    if (CALC_BEFORE_RE.test(before) || CALC_AFTER_RE.test(after)) continue;
    const key = `${fig.value}${fig.kind === "percent" ? "%" : ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(fig.raw);
    let le = text.indexOf("\n", fig.index);
    if (le < 0) le = text.length;
    const supported =
      digitsSupported(fig, haystack) ||
      valueSupported(fig, vals) ||
      blockHasProvenance(
        blockAround(text, fig.index),
        text.slice(ls, le),
        opts.sourceOk,
      );
    if (!supported) {
      unverified.push(fig.raw);
      unverifiedFigures.push(fig);
    }
  }
  return { found, unverified, unverifiedFigures };
}

// ── rendering ──────────────────────────────────────────────────────────────

export const UNVERIFIED_MARK = "(sin verificar)";
const MAX_INLINE = 8;

/**
 * Inline annotation: each unverified figure's first occurrence gets
 * ` (sin verificar)` after it (after its count noun, so "7,000 clientes
 * (sin verificar)") — the reader sees the doubt where the number is.
 * Idempotent by position; beyond MAX_INLINE the rest is counted in one
 * footer line.
 */
export function annotateUnverified(
  text: string,
  audit: NumbersAudit,
): { text: string; annotated: number } {
  const figs = [...audit.unverifiedFigures].sort((a, b) => b.markAt - a.markAt);
  const inline = figs.slice(Math.max(0, figs.length - MAX_INLINE));
  let out = text;
  let annotated = 0;
  for (const fig of inline) {
    if (out.slice(fig.index, fig.index + fig.raw.length) !== fig.raw) continue;
    if (
      out
        .slice(fig.markAt, fig.markAt + 24)
        .trimStart()
        .startsWith(UNVERIFIED_MARK)
    )
      continue;
    out = `${out.slice(0, fig.markAt)} ${UNVERIFIED_MARK}${out.slice(fig.markAt)}`;
    annotated++;
  }
  const rest = figs.length - inline.length;
  if (rest > 0) {
    out += `\n\n⚠️ Y ${rest} cifra${rest === 1 ? "" : "s"} más sin respaldo en las herramientas de esta corrida.`;
  }
  return { text: out, annotated };
}

/** Footer listing unverified figures — used where inline edits are not possible. */
export function formatUnverifiedFooter(
  audit: Pick<NumbersAudit, "unverified">,
): string {
  if (audit.unverified.length === 0) return "";
  const list = audit.unverified.slice(0, 8).join(", ");
  const more =
    audit.unverified.length > 8 ? ` (+${audit.unverified.length - 8})` : "";
  return `\n\n⚠️ Cifras sin respaldo en las herramientas de esta corrida (no verificadas): ${list}${more}`;
}

/** Phase 3 armed the annotation by default; `TASK_GATES_NUMBERS_ANNOTATE=false` disarms. */
export function numbersAnnotateEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.TASK_GATES_NUMBERS_ANNOTATE !== "false";
}
