/**
 * Compile-time sync test — ensures WRITE_TOOLS in fast-runner.ts stays
 * in sync with the write-capable tools defined in scope.ts.
 *
 * From v4.0.18 QA audit: 11 phantom Google tool names went undetected
 * because there was no automated cross-reference. This test prevents
 * that class of bug from recurring.
 */

import { describe, it, expect } from "vitest";
import { WRITE_TOOLS } from "./fast-runner.js";
import {
  GOOGLE_TOOLS,
  WORDPRESS_TOOLS,
  CODING_TOOLS,
  FINANCE_TOOLS,
  KB_INGEST_TOOLS,
  ALPHA_TOOLS,
  BACKTEST_TOOLS,
  PAPER_TOOLS,
  MARKET_RITUAL_TOOLS,
  PM_ALPHA_TOOLS,
  PM_PAPER_TOOLS,
  UTILITY_TOOLS,
  DIAGRAM_TOOLS,
} from "../messaging/scope.js";

/** Google tools that are read-only (not expected in WRITE_TOOLS). */
const GOOGLE_READ_ONLY = new Set([
  "gmail_search",
  "gmail_read",
  "gsheets_read",
  "gdocs_read",
  "gdocs_read_full",
  "gslides_read",
  "gdrive_list",
  "calendar_list",
]);

/** WordPress tools that are read-only. */
const WP_READ_ONLY = new Set([
  "wp_list_posts",
  "wp_read_post",
  "wp_categories",
  "wp_pages",
]);

describe("WRITE_TOOLS sync", () => {
  it("includes all write-capable Google tools", () => {
    const googleWriteTools = GOOGLE_TOOLS.filter(
      (t) => !GOOGLE_READ_ONLY.has(t),
    );
    for (const tool of googleWriteTools) {
      expect(WRITE_TOOLS.has(tool), `Missing from WRITE_TOOLS: ${tool}`).toBe(
        true,
      );
    }
  });

  it("includes all write-capable WordPress tools", () => {
    const wpWriteTools = WORDPRESS_TOOLS.filter((t) => !WP_READ_ONLY.has(t));
    for (const tool of wpWriteTools) {
      expect(WRITE_TOOLS.has(tool), `Missing from WRITE_TOOLS: ${tool}`).toBe(
        true,
      );
    }
  });

  it("includes all write-capable coding tools", () => {
    const CODING_READ_ONLY = new Set([
      "shell_exec",
      "grep",
      "glob",
      "list_dir",
      "git_status",
      "git_diff",
      "code_search",
      "jarvis_diagnose",
      "jarvis_test_run",
      "vps_status",
      "vps_backup",
      "vps_logs",
      "jarvis_propose_directive",
    ]);
    const codingWriteTools = CODING_TOOLS.filter(
      (t) => !CODING_READ_ONLY.has(t),
    );
    for (const tool of codingWriteTools) {
      expect(WRITE_TOOLS.has(tool), `Missing from WRITE_TOOLS: ${tool}`).toBe(
        true,
      );
    }
  });

  it("every WRITE_TOOLS entry follows tool naming convention", () => {
    for (const tool of WRITE_TOOLS) {
      expect(tool).toMatch(/^[a-z][a-z0-9_]+$/);
    }
  });

  it("includes all write-capable finance tools", () => {
    // F1/F2/F3/F4/F5 finance: market_watchlist_add/remove are writes;
    // quote/history/list/budget/indicators/scan/macro_regime/market_signals are reads.
    const FINANCE_READ_ONLY = new Set([
      "market_quote",
      "market_history",
      "market_watchlist_list",
      "market_budget_stats",
      "market_indicators",
      "market_scan",
      "macro_regime",
      "market_signals",
      "prediction_markets",
      "whale_trades",
      "sentiment_snapshot",
    ]);
    const financeWriteTools = FINANCE_TOOLS.filter(
      (t) => !FINANCE_READ_ONLY.has(t),
    );
    for (const tool of financeWriteTools) {
      expect(WRITE_TOOLS.has(tool), `Missing from WRITE_TOOLS: ${tool}`).toBe(
        true,
      );
    }
  });

  it("includes all write-capable kb ingestion tools (v7.13 S5)", () => {
    // KB_INGEST_TOOLS: both tools persist to pgvector (writes). None are read-only.
    const KB_INGEST_READ_ONLY = new Set<string>([]);
    const kbWriteTools = KB_INGEST_TOOLS.filter(
      (t) => !KB_INGEST_READ_ONLY.has(t),
    );
    for (const tool of kbWriteTools) {
      expect(WRITE_TOOLS.has(tool), `Missing from WRITE_TOOLS: ${tool}`).toBe(
        true,
      );
    }
  });

  it("includes all write-capable alpha combination tools (F7 Phase β S6)", () => {
    // alpha_run persists to signal_weights + signal_isq (write).
    // alpha_latest + alpha_explain are read-only.
    const ALPHA_READ_ONLY = new Set<string>(["alpha_latest", "alpha_explain"]);
    const alphaWriteTools = ALPHA_TOOLS.filter((t) => !ALPHA_READ_ONLY.has(t));
    for (const tool of alphaWriteTools) {
      expect(WRITE_TOOLS.has(tool), `Missing from WRITE_TOOLS: ${tool}`).toBe(
        true,
      );
    }
  });

  it("includes all write-capable backtester tools (F7.5 Phase β S10)", () => {
    // backtest_run persists to backtest_runs/paths/overfit (write).
    // backtest_latest + backtest_explain are read-only.
    const BACKTEST_READ_ONLY = new Set<string>([
      "backtest_latest",
      "backtest_explain",
    ]);
    const backtestWriteTools = BACKTEST_TOOLS.filter(
      (t) => !BACKTEST_READ_ONLY.has(t),
    );
    for (const tool of backtestWriteTools) {
      expect(WRITE_TOOLS.has(tool), `Missing from WRITE_TOOLS: ${tool}`).toBe(
        true,
      );
    }
  });

  it("includes all write-capable paper-trading tools (F8 Phase β S11)", () => {
    // paper_rebalance persists to paper_fills/portfolio/balance + trade_theses (write).
    // paper_portfolio + paper_history are read-only.
    const PAPER_READ_ONLY = new Set<string>([
      "paper_portfolio",
      "paper_history",
    ]);
    const paperWriteTools = PAPER_TOOLS.filter((t) => !PAPER_READ_ONLY.has(t));
    for (const tool of paperWriteTools) {
      expect(WRITE_TOOLS.has(tool), `Missing from WRITE_TOOLS: ${tool}`).toBe(
        true,
      );
    }
  });

  it("F9 market-ritual helpers are all read-only (Phase β S12)", () => {
    // market_calendar + alert_budget_status are pure reads — must NOT appear
    // in WRITE_TOOLS. Regression guard against accidental promotion.
    for (const tool of MARKET_RITUAL_TOOLS) {
      expect(
        WRITE_TOOLS.has(tool),
        `Should NOT be in WRITE_TOOLS: ${tool}`,
      ).toBe(false);
    }
  });

  it("includes all write-capable pm-alpha tools (F8.1a β-addendum)", () => {
    // pm_alpha_run persists to pm_signal_weights (write).
    // pm_alpha_latest is read-only.
    const PM_ALPHA_READ_ONLY = new Set<string>(["pm_alpha_latest"]);
    const pmAlphaWriteTools = PM_ALPHA_TOOLS.filter(
      (t) => !PM_ALPHA_READ_ONLY.has(t),
    );
    for (const tool of pmAlphaWriteTools) {
      expect(WRITE_TOOLS.has(tool), `Missing from WRITE_TOOLS: ${tool}`).toBe(
        true,
      );
    }
  });

  it("includes all write-capable pm-paper trading tools (F8.1b β-addendum)", () => {
    // pm_paper_rebalance persists to pm_paper_fills/portfolio/balance + trade_theses (write).
    // pm_paper_portfolio + pm_paper_history are read-only.
    const PM_PAPER_READ_ONLY = new Set<string>([
      "pm_paper_portfolio",
      "pm_paper_history",
    ]);
    const pmPaperWriteTools = PM_PAPER_TOOLS.filter(
      (t) => !PM_PAPER_READ_ONLY.has(t),
    );
    for (const tool of pmPaperWriteTools) {
      expect(WRITE_TOOLS.has(tool), `Missing from WRITE_TOOLS: ${tool}`).toBe(
        true,
      );
    }
  });

  it("includes all write-capable utility tools (v7.10)", () => {
    // v7.10 file_convert writes converted output to /tmp or /workspace.
    // weather_forecast / currency_convert / geocode_address are pure reads.
    // Audit M1: this assertion was absent pre-v7.10 — UTILITY_TOOLS was
    // all-read so the sync test skipped it. Now one write has landed.
    const UTILITY_READ_ONLY = new Set<string>([
      "weather_forecast",
      "currency_convert",
      "geocode_address",
    ]);
    const utilityWriteTools = UTILITY_TOOLS.filter(
      (t) => !UTILITY_READ_ONLY.has(t),
    );
    for (const tool of utilityWriteTools) {
      expect(WRITE_TOOLS.has(tool), `Missing from WRITE_TOOLS: ${tool}`).toBe(
        true,
      );
    }
  });

  it("includes all write-capable diagram tools (v7.12)", () => {
    // v7.12 diagram_generate writes an SVG/HTML output to /tmp or /workspace.
    // No read-only counterparts; every entry in DIAGRAM_TOOLS must be in
    // WRITE_TOOLS to defeat "I drew the diagram" hallucination without a
    // tool call.
    for (const tool of DIAGRAM_TOOLS) {
      expect(WRITE_TOOLS.has(tool), `Missing from WRITE_TOOLS: ${tool}`).toBe(
        true,
      );
    }
  });
});
