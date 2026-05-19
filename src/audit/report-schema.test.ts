/**
 * V8 substrate S2 — report schema + invariants tests.
 *
 * Pure-data tests; no DB / no LLM. Covers:
 *   - Each of the 8 DataSourceCitation variants validates
 *   - Missing/required fields rejected
 *   - Cross-field invariants (window ordering, citation freshness,
 *     evidence-index bounds) caught by validateReportInvariants
 */

import { describe, it, expect } from "vitest";
import {
  DataSourceCitationSchema,
  ReportDraftSchema,
  validateReportInvariants,
  type ReportDraft,
} from "./report-schema.js";

const T0 = "2026-05-19T00:00:00.000Z";
const T1 = "2026-05-19T01:00:00.000Z";
const T2 = "2026-05-19T02:00:00.000Z";
const SHA256 = "a".repeat(64);
const SHA1 = "b".repeat(40);

describe("DataSourceCitationSchema — variant coverage", () => {
  it("accepts cost_ledger", () => {
    const r = DataSourceCitationSchema.safeParse({
      type: "cost_ledger",
      query_sha: SHA256,
      row_count: 42,
      window_start: T0,
      window_end: T1,
      queried_at: T2,
    });
    expect(r.success).toBe(true);
  });

  it("accepts journal", () => {
    const r = DataSourceCitationSchema.safeParse({
      type: "journal",
      pid: 1234,
      window_start: T0,
      window_end: T1,
      line_count: 100,
      queried_at: T2,
    });
    expect(r.success).toBe(true);
  });

  it("accepts git with optional path", () => {
    const r = DataSourceCitationSchema.safeParse({
      type: "git",
      sha: SHA1,
      queried_at: T2,
    });
    expect(r.success).toBe(true);
  });

  it("accepts sqlite", () => {
    const r = DataSourceCitationSchema.safeParse({
      type: "sqlite",
      table: "tasks",
      query_sha: SHA256,
      row_count: 5,
      queried_at: T2,
    });
    expect(r.success).toBe(true);
  });

  it("accepts recall_audit", () => {
    const r = DataSourceCitationSchema.safeParse({
      type: "recall_audit",
      query_sha: SHA256,
      row_count: 10,
      window_start: T0,
      window_end: T1,
      queried_at: T2,
    });
    expect(r.success).toBe(true);
  });

  it("accepts file", () => {
    const r = DataSourceCitationSchema.safeParse({
      type: "file",
      path: "/etc/passwd",
      sha256: SHA256,
      queried_at: T2,
    });
    expect(r.success).toBe(true);
  });

  it("accepts http", () => {
    const r = DataSourceCitationSchema.safeParse({
      type: "http",
      url: "https://api.example.com/x",
      status: 200,
      fetched_at: T0,
      body_sha256: SHA256,
      queried_at: T2,
    });
    expect(r.success).toBe(true);
  });

  it("accepts tool_output", () => {
    const r = DataSourceCitationSchema.safeParse({
      type: "tool_output",
      tool_name: "intel_query",
      call_id: "call-123",
      output_sha256: SHA256,
      queried_at: T2,
    });
    expect(r.success).toBe(true);
  });

  it("rejects unknown type", () => {
    const r = DataSourceCitationSchema.safeParse({
      type: "made_up",
      queried_at: T2,
    });
    expect(r.success).toBe(false);
  });

  it("rejects wrong hash length", () => {
    const r = DataSourceCitationSchema.safeParse({
      type: "cost_ledger",
      query_sha: "tooshort",
      row_count: 1,
      window_start: T0,
      window_end: T1,
      queried_at: T2,
    });
    expect(r.success).toBe(false);
  });

  it("rejects negative row_count", () => {
    const r = DataSourceCitationSchema.safeParse({
      type: "sqlite",
      table: "x",
      query_sha: SHA256,
      row_count: -1,
      queried_at: T2,
    });
    expect(r.success).toBe(false);
  });

  it("rejects malformed URL", () => {
    const r = DataSourceCitationSchema.safeParse({
      type: "http",
      url: "not-a-url",
      status: 200,
      fetched_at: T0,
      body_sha256: SHA256,
      queried_at: T2,
    });
    expect(r.success).toBe(false);
  });
});

const validDraft = (): ReportDraft => ({
  report_id: "00000000-0000-4000-8000-000000000001",
  started_at: T0,
  surface: "morning_brief",
  verified_against: [
    {
      type: "cost_ledger",
      query_sha: SHA256,
      row_count: 42,
      window_start: T0,
      window_end: T1,
      queried_at: T1,
    },
  ],
  sample_n: 42,
  window: { start: T0, end: T1 },
  claims: [
    {
      statement: "headline claim with enough characters",
      evidence_index: [0],
    },
  ],
  concerns: [],
});

describe("ReportDraftSchema", () => {
  it("accepts a valid draft", () => {
    const r = ReportDraftSchema.safeParse(validDraft());
    expect(r.success).toBe(true);
  });

  it("rejects missing verified_against", () => {
    const draft = validDraft();
    // @ts-expect-error — deliberately corrupt
    delete draft.verified_against;
    const r = ReportDraftSchema.safeParse(draft);
    expect(r.success).toBe(false);
  });

  it("rejects empty verified_against array (min 1)", () => {
    const draft = { ...validDraft(), verified_against: [] };
    const r = ReportDraftSchema.safeParse(draft);
    expect(r.success).toBe(false);
  });

  it("rejects unknown surface", () => {
    const draft = { ...validDraft(), surface: "weird" as never };
    const r = ReportDraftSchema.safeParse(draft);
    expect(r.success).toBe(false);
  });

  it("rejects too-short claim statement (<10 chars)", () => {
    const draft = validDraft();
    draft.claims[0].statement = "tiny";
    const r = ReportDraftSchema.safeParse(draft);
    expect(r.success).toBe(false);
  });

  it("rejects non-UUID report_id", () => {
    const draft = { ...validDraft(), report_id: "not-a-uuid" };
    const r = ReportDraftSchema.safeParse(draft);
    expect(r.success).toBe(false);
  });

  it("rejects non-ISO started_at", () => {
    const draft = { ...validDraft(), started_at: "yesterday" };
    const r = ReportDraftSchema.safeParse(draft);
    expect(r.success).toBe(false);
  });

  it("defaults concerns to []", () => {
    const draft = validDraft();
    // @ts-expect-error — deliberately omit
    delete draft.concerns;
    const r = ReportDraftSchema.safeParse(draft);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.concerns).toEqual([]);
  });
});

describe("validateReportInvariants", () => {
  it("returns empty array on valid draft", () => {
    expect(validateReportInvariants(validDraft())).toEqual([]);
  });

  it("flags window.end before window.start", () => {
    const d = validDraft();
    d.window = { start: T1, end: T0 };
    const issues = validateReportInvariants(d);
    expect(
      issues.some((i) => i.includes("window.end is before window.start")),
    ).toBe(true);
  });

  it("flags stale citation (queried_at < started_at)", () => {
    const d = validDraft();
    d.started_at = T1;
    d.verified_against[0].queried_at = T0; // before started_at
    const issues = validateReportInvariants(d);
    expect(issues.some((i) => i.includes("stale citation"))).toBe(true);
  });

  it("flags evidence_index out of bounds", () => {
    const d = validDraft();
    d.claims[0].evidence_index = [5]; // only 1 citation, max idx = 0
    const issues = validateReportInvariants(d);
    expect(
      issues.some(
        (i) => i.includes("evidence_index=5") && i.includes("only 1"),
      ),
    ).toBe(true);
  });

  it("accumulates multiple issues", () => {
    const d = validDraft();
    d.window = { start: T1, end: T0 };
    d.started_at = T1;
    d.verified_against[0].queried_at = T0;
    const issues = validateReportInvariants(d);
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });
});
