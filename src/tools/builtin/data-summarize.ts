/**
 * data_summarize — deterministic counts and column statistics over tabular
 * data (usability plan Phase 3.1, 2026-08-23).
 *
 * The 2026-08-22 review found stats estimated by the model from a file it
 * had only skimmed ("94 rows" reported as 100, #11898). Any count, sum, mean
 * or group-by over a CSV/TSV/JSONL/markdown table is computed HERE, by code,
 * and the result lands in the run's tool-evidence corpus — so the figures
 * the model then writes pass the provenance gate.
 *
 * Core tool (always in scope): it is the deterministic companion of
 * file_read, and shell_exec is scope-gated.
 */

import { readFileSync, statSync } from "node:fs";
import { defineTool } from "../define-tool.js";
import { validatePathSafety } from "./immutable-core.js";

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_GROUPS = 25;
const MAX_COLUMNS = 60;

type Row = string[];

function detectDelimiter(head: string): string {
  const counts = [",", "\t", ";", "|"].map((d) => ({
    d,
    n: head
      .split("\n")
      .slice(0, 5)
      .reduce((acc, l) => acc + l.split(d).length - 1, 0),
  }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0]!.n > 0 ? counts[0]!.d : ",";
}

/** RFC-4180-ish CSV parser: quoted fields, doubled quotes, CRLF. */
export function parseDelimited(text: string, delimiter: string): Row[] {
  const rows: Row[] = [];
  let row: Row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((f) => f.trim() !== "")) rows.push(row);
  }
  return rows;
}

function parseMarkdownTable(text: string): Row[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"))
    .filter((l) => !/^\|\s*:?-{2,}/.test(l))
    .map((l) =>
      l
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim()),
    );
}

function parseJsonl(text: string): { header: string[]; rows: Row[] } {
  const objs: Record<string, unknown>[] = [];
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed) as unknown[];
    for (const o of arr)
      if (o && typeof o === "object") objs.push(o as Record<string, unknown>);
  } else {
    for (const line of trimmed.split("\n")) {
      const l = line.trim();
      if (!l) continue;
      const o = JSON.parse(l) as unknown;
      if (o && typeof o === "object") objs.push(o as Record<string, unknown>);
    }
  }
  const header: string[] = [];
  for (const o of objs)
    for (const k of Object.keys(o)) if (!header.includes(k)) header.push(k);
  const rows = objs.map((o) =>
    header.map((k) => {
      const v = o[k];
      return v === null || v === undefined
        ? ""
        : typeof v === "object"
          ? JSON.stringify(v)
          : String(v);
    }),
  );
  return { header, rows };
}

const NUMERIC_RE = /^-?\$?\s?\(?[\d,]*\.?\d+\)?\s?%?$/;

function toNumber(s: string): number | null {
  const t = s.trim();
  if (!t || !NUMERIC_RE.test(t)) return null;
  const neg = /^\(.*\)$/.test(t);
  const n = Number(t.replace(/[$,%()\s]/g, ""));
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

export interface ColumnStats {
  column: string;
  non_empty: number;
  distinct: number;
  numeric?: {
    count: number;
    sum: number;
    min: number;
    max: number;
    mean: number;
  };
}

export interface Summary {
  rows: number;
  columns: number;
  header: string[];
  format: string;
  column_stats: ColumnStats[];
  group_by?: {
    column: string;
    groups: Array<{ value: string; count: number }>;
    truncated: boolean;
  };
  filter?: { column: string; equals: string; matched: number };
  sample: Row[];
}

export function summarizeTable(
  header: string[],
  rows: Row[],
  format: string,
  opts: { groupBy?: string; filterColumn?: string; filterEquals?: string } = {},
): Summary {
  const colIndex = (name: string): number => {
    const byName = header.findIndex(
      (h) => h.trim().toLowerCase() === name.trim().toLowerCase(),
    );
    if (byName >= 0) return byName;
    const n = Number(name);
    return Number.isInteger(n) && n >= 0 && n < header.length ? n : -1;
  };
  let data = rows;
  let filter: Summary["filter"];
  if (opts.filterColumn !== undefined && opts.filterEquals !== undefined) {
    const ci = colIndex(opts.filterColumn);
    if (ci < 0)
      throw new Error(
        `filter_column "${opts.filterColumn}" not found; columns: ${header.join(", ")}`,
      );
    const want = opts.filterEquals.trim().toLowerCase();
    data = rows.filter((r) => (r[ci] ?? "").trim().toLowerCase() === want);
    filter = {
      column: header[ci]!,
      equals: opts.filterEquals,
      matched: data.length,
    };
  }
  const column_stats: ColumnStats[] = header
    .slice(0, MAX_COLUMNS)
    .map((column, ci) => {
      const values = data
        .map((r) => (r[ci] ?? "").trim())
        .filter((v) => v !== "");
      const nums = values.map(toNumber).filter((n): n is number => n !== null);
      const stats: ColumnStats = {
        column,
        non_empty: values.length,
        distinct: new Set(values).size,
      };
      if (values.length > 0 && nums.length === values.length) {
        const sum = nums.reduce((a, b) => a + b, 0);
        stats.numeric = {
          count: nums.length,
          sum: Number(sum.toFixed(6)),
          min: Math.min(...nums),
          max: Math.max(...nums),
          mean: Number((sum / nums.length).toFixed(6)),
        };
      }
      return stats;
    });
  let group_by: Summary["group_by"];
  if (opts.groupBy !== undefined) {
    const ci = colIndex(opts.groupBy);
    if (ci < 0)
      throw new Error(
        `group_by "${opts.groupBy}" not found; columns: ${header.join(", ")}`,
      );
    const counts = new Map<string, number>();
    for (const r of data) {
      const v = (r[ci] ?? "").trim();
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const groups = [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    group_by = {
      column: header[ci]!,
      groups: groups.slice(0, MAX_GROUPS),
      truncated: groups.length > MAX_GROUPS,
    };
  }
  return {
    rows: data.length,
    columns: header.length,
    header,
    format,
    column_stats,
    group_by,
    filter,
    sample: data.slice(0, 3),
  };
}

export function summarizeText(
  text: string,
  formatHint: string | undefined,
  opts: {
    hasHeader?: boolean;
    groupBy?: string;
    filterColumn?: string;
    filterEquals?: string;
  },
): Summary {
  const hint = (formatHint ?? "auto").toLowerCase();
  const trimmed = text.replace(/^﻿/, "");
  let format = hint;
  let header: string[];
  let rows: Row[];
  const looksJson = /^\s*[[{]/.test(trimmed);
  const looksMd = /^\s*\|/.test(trimmed);
  if (hint === "json" || hint === "jsonl" || (hint === "auto" && looksJson)) {
    ({ header, rows } = parseJsonl(trimmed));
    format = "json";
  } else if (hint === "markdown" || (hint === "auto" && looksMd)) {
    const all = parseMarkdownTable(trimmed);
    header = all[0] ?? [];
    rows = all.slice(1);
    format = "markdown";
  } else {
    const delimiter =
      hint === "tsv"
        ? "\t"
        : hint === "csv"
          ? ","
          : detectDelimiter(trimmed.slice(0, 4000));
    const all = parseDelimited(trimmed, delimiter);
    format =
      delimiter === "\t"
        ? "tsv"
        : delimiter === ","
          ? "csv"
          : `delimited(${delimiter})`;
    if (opts.hasHeader === false) {
      header = (all[0] ?? []).map((_, i) => `col${i + 1}`);
      rows = all;
    } else {
      header = all[0] ?? [];
      rows = all.slice(1);
    }
  }
  return summarizeTable(header, rows, format, opts);
}

export const dataSummarizeTool = defineTool({
  name: "data_summarize",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  description: `Deterministic row counts and column statistics over tabular data (CSV, TSV, JSONL/JSON array, or a markdown table). Computed by code, never estimated.

USE WHEN the answer contains a COUNT, SUM, MEAN, MIN/MAX or a group-by breakdown over a file or a table you were given ("cuántas filas tiene", "cuántos registros por estado", "total de la columna ventas", "promedio de edad"). Run it BEFORE quoting any figure from a file — a number you read off a preview is an estimate and will be marked "(sin verificar)" or rejected when written to a Sheet/KB.

DO NOT use for: free text, PDFs (use pdf_read, then pass the extracted table as \`text\`), or spreadsheets in Google Drive (use gsheets_read, then pass the rows as \`text\` in CSV form).

INPUT: either \`path\` (a local file, max 20 MB) or \`text\` (paste the data). Header row assumed unless \`has_header=false\`.
OUTPUT: rows, columns, header, per-column non-empty/distinct counts, numeric stats for all-numeric columns (count/sum/min/max/mean), optional \`group_by\` counts (top 25) and an optional \`filter_column\`/\`filter_equals\` applied before everything else. Report the figures exactly as returned and cite "fuente: data_summarize <path>" when you write them anywhere.`,
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Absolute path of a local CSV/TSV/JSONL/JSON/markdown file.",
      },
      text: {
        type: "string",
        description:
          "The data itself, when it is not in a local file (e.g. rows from gsheets_read as CSV).",
      },
      format: {
        type: "string",
        enum: ["auto", "csv", "tsv", "json", "markdown"],
        description:
          "Force a parser. Default auto: JSON if it starts with [ or {, markdown if it starts with |, else delimiter sniffing (, tab ; |).",
      },
      has_header: {
        type: "boolean",
        description:
          "false when the first row is data, not column names (columns become col1..colN). Default true.",
      },
      group_by: {
        type: "string",
        description:
          "Column name (or 0-based index) to count rows per distinct value. Top 25 groups returned.",
      },
      filter_column: {
        type: "string",
        description:
          "Column name to filter on before computing anything (exact, case-insensitive match with filter_equals).",
      },
      filter_equals: {
        type: "string",
        description: "Value the filter_column must equal.",
      },
    },
    required: [],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const path = typeof args.path === "string" ? args.path : "";
    let text = typeof args.text === "string" ? args.text : "";
    if (!path && !text) {
      return JSON.stringify({
        error: "Provide `path` (local file) or `text` (the data).",
      });
    }
    try {
      if (path) {
        const safety = validatePathSafety(path, "read");
        if (!safety.safe)
          return JSON.stringify({ error: `path blocked: ${safety.reason}` });
        // Size check BEFORE the read — never allocate a 1.5 GB CSV just to
        // refuse it (R1 audit W8).
        const size = statSync(path).size;
        if (size > MAX_BYTES) {
          return JSON.stringify({
            error: `File too large (${size} bytes > ${MAX_BYTES}). Use shell_exec (wc -l, awk) for files this size.`,
          });
        }
        text = readFileSync(path, "utf-8");
      }
      const summary = summarizeText(
        text,
        typeof args.format === "string" ? args.format : undefined,
        {
          hasHeader: args.has_header === false ? false : true,
          groupBy:
            typeof args.group_by === "string" ? args.group_by : undefined,
          filterColumn:
            typeof args.filter_column === "string"
              ? args.filter_column
              : undefined,
          filterEquals:
            typeof args.filter_equals === "string"
              ? args.filter_equals
              : undefined,
        },
      );
      return JSON.stringify({ source: path || "text", ...summary });
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});
