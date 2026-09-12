/**
 * Tool-description lint (2026-09-12, agents-best-practices gap 8).
 *
 * ACI rule (CLAUDE.md): a description says when NOT to use the tool and
 * names the sibling to use instead. 78 of 162 registered builtin tools did
 * at the time of writing; the rest are pinned below as a RATCHET — a new
 * tool cannot ship without a not-for section, and backfilling one means
 * removing its name from the list (the second test fails otherwise, so the
 * list can only shrink).
 */

import { describe, expect, it } from "vitest";
import {
  BUILTIN_TOOLS,
  CRM_TOOLS,
  GWS_TOOLS,
  WP_TOOLS,
} from "./sources/builtin.js";

/** Phrases that count as a not-for section. Case-insensitive. */
export const NOT_FOR_RE =
  /DO NOT USE|DON'T USE|NOT FOR:|AVOID WHEN|DO NOT CALL|USE [^\n]* INSTEAD|NOT THIS/i;

/** Tools that predate the rule and still lack a not-for section. Shrink only. */
const LEGACY_WITHOUT_NOT_FOR = new Set([
  "alert_budget_status", "alpha_explain", "alpha_latest", "alpha_run",
  "backtest_explain", "backtest_latest", "dashboard_generate", "dashboard_list",
  "delete_schedule", "evolution_deactivate_skill", "file_delete", "file_read",
  "gemini_audio_overview", "gemini_research", "gh_create_pr", "gh_repo_create",
  "git_diff", "git_push", "git_status", "hf_spaces", "jarvis_apply_proposal",
  "jarvis_file_delete", "jarvis_file_read", "jarvis_file_search",
  "jarvis_file_update", "jarvis_propose_directive", "knowledge_map_expand",
  "learner_model_status", "learning_plan_advance", "learning_plan_explain_back",
  "learning_plan_quiz", "learning_plan_summarize", "macro_regime",
  "market_budget_stats", "market_calendar", "market_history", "market_indicators",
  "market_quote", "market_scan", "market_signals", "market_watchlist_add",
  "market_watchlist_list", "market_watchlist_remove", "market_watchlist_reseed",
  "paper_history", "paper_portfolio", "pm_alpha_latest", "pm_alpha_run",
  "prediction_markets", "project_get", "project_list", "project_update",
  "sentiment_snapshot", "submit_report", "user_fact_delete", "user_fact_list",
  "video_background_download", "video_brand_apply", "video_compose_manifest",
  "video_create", "video_image", "video_job_cancel", "video_job_cleanup",
  "video_list_profiles", "video_list_voices", "video_script", "video_status",
  "video_storyboard", "video_transition_preview", "video_tts", "vps_backup",
  "vps_deploy", "vps_logs", "vps_status", "whale_trades", "wp_categories",
  "wp_list_posts", "wp_media_upload", "wp_pages", "wp_plugins", "wp_publish",
  "wp_raw_api", "wp_read_post", "wp_settings",
]);

const ALL = [...BUILTIN_TOOLS, ...CRM_TOOLS, ...GWS_TOOLS, ...WP_TOOLS];

describe("tool descriptions — not-for section ratchet", () => {
  it("every tool outside the legacy list says when NOT to use it", () => {
    const offenders = ALL.filter(
      (t) =>
        !LEGACY_WITHOUT_NOT_FOR.has(t.name) &&
        !NOT_FOR_RE.test(t.definition.function.description),
    ).map((t) => t.name);
    expect(offenders, "add a 'DO NOT USE WHEN:' block naming the sibling tool").toEqual([]);
  });

  it("the legacy list only shrinks (remove a name once its tool is backfilled)", () => {
    const stale = ALL.filter(
      (t) =>
        LEGACY_WITHOUT_NOT_FOR.has(t.name) &&
        NOT_FOR_RE.test(t.definition.function.description),
    ).map((t) => t.name);
    expect(stale, "backfilled — delete from LEGACY_WITHOUT_NOT_FOR").toEqual([]);
    const gone = [...LEGACY_WITHOUT_NOT_FOR].filter((n) => !ALL.some((t) => t.name === n));
    expect(gone, "tool no longer registered — delete from LEGACY_WITHOUT_NOT_FOR").toEqual([]);
  });
});
