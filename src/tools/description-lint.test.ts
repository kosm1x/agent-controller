/**
 * Tool-description lint (2026-09-12, agents-best-practices gap 8).
 *
 * ACI rule (CLAUDE.md): a description says when NOT to use the tool and
 * names the sibling to use instead. The tools that predate the rule are
 * pinned below as a RATCHET — a new tool cannot ship without a not-for
 * section, and backfilling one means removing its name from the list (the
 * shrink-only test fails otherwise). Coverage: every statically exported
 * tool — the four builtin arrays plus the Google and memory sources (qa-audit
 * C W-1). Skills are minted at runtime and MCP tools are dynamic: out of
 * reach for a static lint, by design.
 */

import { describe, expect, it } from "vitest";
import type { Tool } from "./types.js";
import {
  BUILTIN_TOOLS,
  CRM_TOOLS,
  GWS_TOOLS,
  WP_TOOLS,
} from "./sources/builtin.js";
import { gmailSendTool, gmailSearchTool, gmailReadTool } from "./builtin/google-gmail.js";
import {
  gdriveListTool,
  gdriveCreateTool,
  gdriveShareTool,
  gdriveDeleteTool,
  gdriveMoveTool,
  gdriveUploadTool,
  gdriveDownloadTool,
} from "./builtin/google-drive.js";
import { calendarListTool, calendarCreateTool, calendarUpdateTool } from "./builtin/google-calendar.js";
import {
  gsheetsReadTool,
  gsheetsWriteTool,
  gdocsReadTool,
  gdocsReadFullTool,
  gdocsWriteTool,
  gdocsReplaceTool,
  gslidesReadTool,
  gslidesCreateTool,
  gtasksCreateTool,
} from "./builtin/google-docs.js";
import {
  memorySearchTool,
  memoryStoreTool,
  memoryReflectTool,
  memoryKgQueryTool,
  memoryForgetTool,
} from "./builtin/memory.js";

/**
 * Phrases that count as a not-for section. "DO NOT USE / DON'T USE / DO NOT
 * CALL" anywhere (several tools put it mid-sentence: "THIS is the X path.
 * Do NOT use shell_exec"); "NOT FOR:" / "AVOID WHEN" as a heading; and
 * "use X instead" — but never "use IT instead", which recommends the tool
 * itself (qa-audit C W-2: jarvis_file_move passed on that alone).
 */
export const NOT_FOR_RE =
  /\b(?:DO NOT USE|DON'T USE|DO NOT CALL)\b|^\s*(?:NOT FOR|AVOID WHEN)\b|\bUSE (?!IT\b)[^\n]* INSTEAD\b/im;

/** Tools that predate the rule and still lack a not-for section. Shrink only. */
const LEGACY_WITHOUT_NOT_FOR = new Set([
  "alert_budget_status", "alpha_explain", "alpha_latest", "alpha_run",
  "backtest_explain", "backtest_latest", "dashboard_generate", "dashboard_list",
  "delete_schedule", "evolution_deactivate_skill", "file_delete", "file_read",
  "gdocs_replace", "gdocs_write", "gdrive_create", "gdrive_delete", "gdrive_move",
  "gdrive_share", "gdrive_upload", "gemini_audio_overview", "gemini_research",
  "gh_create_pr", "gh_repo_create", "git_diff", "git_push", "git_status",
  "gmail_search", "gsheets_write", "gslides_create", "gtasks_create", "hf_spaces",
  "jarvis_apply_proposal", "jarvis_file_delete", "jarvis_file_move",
  "jarvis_file_read", "jarvis_file_search", "jarvis_file_update",
  "jarvis_propose_directive", "knowledge_map_expand", "learner_model_status",
  "learning_plan_advance", "learning_plan_explain_back", "learning_plan_quiz",
  "learning_plan_summarize", "macro_regime", "market_budget_stats",
  "market_calendar", "market_history", "market_indicators", "market_quote",
  "market_scan", "market_signals", "market_watchlist_add", "market_watchlist_list",
  "market_watchlist_remove", "market_watchlist_reseed", "memory_kg_query",
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

const ALL: Tool[] = [
  ...BUILTIN_TOOLS, ...CRM_TOOLS, ...GWS_TOOLS, ...WP_TOOLS,
  gmailSendTool, gmailSearchTool, gmailReadTool,
  gdriveListTool, gdriveCreateTool, gdriveShareTool, gdriveDeleteTool, gdriveMoveTool, gdriveUploadTool, gdriveDownloadTool,
  calendarListTool, calendarCreateTool, calendarUpdateTool,
  gsheetsReadTool, gsheetsWriteTool, gdocsReadTool, gdocsReadFullTool, gdocsWriteTool, gdocsReplaceTool, gslidesReadTool, gslidesCreateTool, gtasksCreateTool,
  memorySearchTool, memoryStoreTool, memoryReflectTool, memoryKgQueryTool, memoryForgetTool,
];
const NAMES = new Set(ALL.map((t) => t.name));

const desc = (t: Tool): string => t.definition.function.description;

/**
 * snake_case words inside pre-existing not-for blocks that are not tools:
 * a table (`user_facts`), a tool FAMILY written without the wildcard
 * (`user_fact`), and sibling parameter / value names (`brief_id`, `svg_html`).
 */
const NON_TOOL_TOKENS = new Set(["user_facts", "user_fact", "brief_id", "svg_html"]);

describe("tool descriptions — not-for section ratchet", () => {
  it("covers the statically exported surface (builtin + Google + memory)", () => {
    expect(ALL.length).toBeGreaterThan(180);
    expect(NAMES.size).toBe(ALL.length);
  });

  it("every tool outside the legacy list says when NOT to use it", () => {
    const offenders = ALL.filter(
      (t) => !LEGACY_WITHOUT_NOT_FOR.has(t.name) && !NOT_FOR_RE.test(desc(t)),
    ).map((t) => t.name);
    expect(offenders, "add a 'DO NOT USE WHEN:' block naming the sibling tool").toEqual([]);
  });

  it("the legacy list only shrinks (remove a name once its tool is backfilled)", () => {
    const stale = ALL.filter(
      (t) => LEGACY_WITHOUT_NOT_FOR.has(t.name) && NOT_FOR_RE.test(desc(t)),
    ).map((t) => t.name);
    expect(stale, "backfilled — delete from LEGACY_WITHOUT_NOT_FOR").toEqual([]);
    const gone = [...LEGACY_WITHOUT_NOT_FOR].filter((n) => !NAMES.has(n));
    expect(gone, "tool no longer registered — delete from LEGACY_WITHOUT_NOT_FOR").toEqual([]);
  });

  it("'use it instead' does not count as a not-for section", () => {
    expect(NOT_FOR_RE.test("THIS IS A TRANSPORT OPERATION — use it instead of X when…")).toBe(false);
    expect(NOT_FOR_RE.test("For contents use grep instead.")).toBe(true);
    expect(NOT_FOR_RE.test("Only path. Do NOT use shell_exec for this.")).toBe(true);
  });

  /**
   * qa-audit C R-2 / C-1 / C-2: a sibling named in a not-for block must be a
   * registered tool. Two backfilled lines pointed at names that do not exist;
   * one of them (`northstar_index`) was within the fuzzy-repair distance of
   * the destructive `northstar_sync`. Wildcards (`gmail_*`) resolve by prefix;
   * a tool's own parameter names are not siblings.
   */
  it("every snake_case sibling named in a DO NOT USE block is a registered tool", () => {
    const bad: string[] = [];
    for (const t of ALL) {
      // From the first not-for phrase (any spelling) to the next ALL-CAPS
      // heading line or the end — multi-paragraph blocks included (R2 W-N4).
      const block = desc(t).match(
        /(?:\b(?:DO NOT USE|DON'T USE|DO NOT CALL)\b|^\s*(?:NOT FOR|AVOID WHEN)\b|\bUSE (?!IT\b)[^\n]* INSTEAD\b)[\s\S]*?(?=\n[A-Z][A-Z /()-]{3,}:|$)/im,
      );
      if (!block) continue;
      const params = Object.keys(
        ((t.definition.function.parameters as { properties?: Record<string, unknown> })
          .properties ?? {}),
      );
      for (const tok of block[0].match(/\b[a-z][a-z0-9]*(?:_[a-z0-9*]+)+\b/g) ?? []) {
        if (params.includes(tok) || NON_TOOL_TOKENS.has(tok)) continue;
        const ok = tok.endsWith("_*")
          ? [...NAMES].some((n) => n.startsWith(tok.slice(0, -1)))
          : NAMES.has(tok);
        if (!ok) bad.push(`${t.name} → ${tok}`);
      }
    }
    expect(bad, "not-for line names a tool that is not registered").toEqual([]);
  });
});
