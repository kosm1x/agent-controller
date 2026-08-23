/**
 * data_summarize: counts and stats are computed, not estimated — CSV with
 * quoted fields, TSV sniffing, JSONL, markdown tables, group-by, filter,
 * and the read denylist on `path`.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  dataSummarizeTool,
  parseDelimited,
  summarizeText,
} from "./data-summarize.js";

describe("parseDelimited", () => {
  it("handles quoted fields, doubled quotes, CRLF and trailing newline", () => {
    const rows = parseDelimited(
      'id,name,amount\r\n1,"Pérez, Ana","1,200"\r\n2,"He said ""hi""",3\n',
      ",",
    );
    expect(rows).toEqual([
      ["id", "name", "amount"],
      ["1", "Pérez, Ana", "1,200"],
      ["2", 'He said "hi"', "3"],
    ]);
  });
});

describe("summarizeText", () => {
  const csv = [
    "estado,sucursales,ventas",
    "CDMX,12,1500.5",
    "Jalisco,7,900",
    "CDMX,3,100",
    "Nuevo León,5,",
  ].join("\n");

  it("counts rows exactly and computes numeric stats for all-numeric columns only", () => {
    const s = summarizeText(csv, undefined, {});
    expect(s.rows).toBe(4);
    expect(s.format).toBe("csv");
    expect(s.header).toEqual(["estado", "sucursales", "ventas"]);
    expect(s.column_stats[1]).toEqual({
      column: "sucursales",
      non_empty: 4,
      distinct: 4,
      numeric: { count: 4, sum: 27, min: 3, max: 12, mean: 6.75 },
    });
    // `ventas` has an empty cell — still numeric over the non-empty values.
    expect(s.column_stats[2]!.numeric).toEqual({
      count: 3,
      sum: 2500.5,
      min: 100,
      max: 1500.5,
      mean: 833.5,
    });
    expect(s.column_stats[0]!.numeric).toBeUndefined();
  });

  it("group_by counts per value (sorted by count) and filter applies first", () => {
    const s = summarizeText(csv, "csv", { groupBy: "estado" });
    expect(s.group_by).toEqual({
      column: "estado",
      groups: [
        { value: "CDMX", count: 2 },
        { value: "Jalisco", count: 1 },
        { value: "Nuevo León", count: 1 },
      ],
      truncated: false,
    });
    const f = summarizeText(csv, "csv", {
      filterColumn: "estado",
      filterEquals: "cdmx",
    });
    expect(f.rows).toBe(2);
    expect(f.filter).toEqual({ column: "estado", equals: "cdmx", matched: 2 });
    expect(f.column_stats[1]!.numeric?.sum).toBe(15);
    expect(() => summarizeText(csv, "csv", { groupBy: "nope" })).toThrow(
      /not found/,
    );
  });

  it("sniffs TSV, parses JSONL and markdown tables, honours has_header=false", () => {
    const tsv = "a\tb\n1\t2\n3\t4";
    expect(summarizeText(tsv, undefined, {})).toMatchObject({
      rows: 2,
      format: "tsv",
    });
    const jsonl = '{"x":1,"y":"a"}\n{"x":2,"y":"b"}\n{"x":3}';
    const j = summarizeText(jsonl, undefined, {});
    expect(j).toMatchObject({ rows: 3, format: "json", header: ["x", "y"] });
    expect(j.column_stats[0]!.numeric?.sum).toBe(6);
    const md = "| k | v |\n|---|---|\n| a | 10 |\n| b | 20 |";
    expect(summarizeText(md, undefined, {})).toMatchObject({
      rows: 2,
      format: "markdown",
      header: ["k", "v"],
    });
    const noHeader = summarizeText("5,6\n7,8", "csv", { hasHeader: false });
    expect(noHeader.rows).toBe(2);
    expect(noHeader.header).toEqual(["col1", "col2"]);
  });
});

describe("data_summarize tool", () => {
  it("reads a local file, refuses denylisted paths, and errors without input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ds-"));
    const file = join(dir, "t.csv");
    writeFileSync(file, "n\n1\n2\n3\n");
    const out = JSON.parse(await dataSummarizeTool.execute({ path: file }));
    expect(out).toMatchObject({ source: file, rows: 3 });
    expect(out.column_stats[0].numeric.sum).toBe(6);

    const blocked = JSON.parse(
      await dataSummarizeTool.execute({
        path: "/root/.claude/.credentials.json",
      }),
    );
    expect(blocked.error).toMatch(/blocked/);

    expect(JSON.parse(await dataSummarizeTool.execute({})).error).toMatch(
      /Provide/,
    );
  });
});
