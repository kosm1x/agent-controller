/**
 * Tool-description lint (2026-09-12, agents-best-practices gap 8).
 *
 * ACI rule (CLAUDE.md): a description says when NOT to use the tool and
 * names the sibling to use instead. The tools that predate the rule are
 * pinned below as a RATCHET — a new tool cannot ship without a not-for
 * section, and backfilling one means removing its name from the list (the
 * shrink-only test fails otherwise). Coverage: every host-defined tool the
 * registry can hold. The list is read back from a fresh `ToolRegistry` filled
 * by every road a host-defined tool takes into it (the four builtin arrays,
 * env-gated groups included, and the Google, memory and skills sources), so
 * a tool a source registers is checked without anybody adding an import here,
 * and the list is the same on every host. Saved skills are database rows run
 * through `skill_run`, not tools of their own: the skills source registers a
 * fixed set. Out of reach: MCP tools, which are created at run time from each
 * server's own listing.
 */

import { describe, expect, it } from "vitest";
import type { Tool } from "./types.js";
import { ToolRegistry } from "./registry.js";
import {
  BUILTIN_TOOLS,
  CRM_TOOLS,
  GWS_TOOLS,
  WP_TOOLS,
} from "./sources/builtin.js";
import { GoogleToolSource } from "./sources/google.js";
import { MemoryToolSource } from "./sources/memory.js";
import { SkillsToolSource } from "./sources/skills.js";

/**
 * Phrases that count as a not-for section. "DO NOT USE / DON'T USE / DO NOT
 * CALL" anywhere (several tools put it mid-sentence: "THIS is the X path.
 * Do NOT use shell_exec"); "NOT FOR:" / "AVOID WHEN" / "NOT WHEN" /
 * "WHEN NOT TO USE" as a heading; and
 * "use X instead" — but never "use IT instead", which recommends the tool
 * itself (qa-audit C W-2: jarvis_file_move passed on that alone).
 */
export const NOT_FOR_RE =
  /\b(?:DO NOT USE|DON'T USE|DO NOT CALL)\b|^\s*(?:NOT FOR|AVOID WHEN|NOT WHEN|WHEN NOT TO USE)\b|\bUSE (?!IT\b)[^\n]* INSTEAD\b/im;

/** Tools that predate the rule and still lack a not-for section. Shrink only. */
const LEGACY_WITHOUT_NOT_FOR = new Set([
  "alert_budget_status", "alpha_explain",
  "dashboard_generate", "dashboard_list",
  "evolution_deactivate_skill", "file_delete", "file_read",
  "gdocs_replace", "gdocs_write", "gdrive_create", "gdrive_delete", "gdrive_move",
  "gdrive_share",
  "gh_create_pr", "gh_repo_create", "git_diff", "git_push", "git_status",
  "gmail_search", "gsheets_write", "gslides_create", "gtasks_create",
  "jarvis_file_delete", "jarvis_file_move",
  "jarvis_file_read", "jarvis_file_search", "jarvis_file_update",
  "learner_model_status",
  "learning_plan_advance", "learning_plan_explain_back", "learning_plan_quiz",
  "learning_plan_summarize", "macro_regime", "market_budget_stats",
  "market_history",
  "market_signals", "market_watchlist_list",
  "market_watchlist_remove", "memory_kg_query",
  "paper_history", "pm_alpha_latest",
  "project_get", "project_list", "project_update",
  "sentiment_snapshot", "submit_report",
  "video_background_download", "video_brand_apply", "video_compose_manifest",
  "video_create", "video_image", "video_job_cancel", "video_job_cleanup",
  "video_list_profiles", "video_list_voices", "video_script", "video_status",
  "video_storyboard", "video_transition_preview", "video_tts", "vps_backup",
  "vps_logs", "vps_status", "whale_trades", "wp_categories",
  "wp_list_posts", "wp_media_upload", "wp_pages", "wp_plugins", "wp_publish",
  "wp_raw_api", "wp_read_post", "wp_settings",
]);

type Road = (registry: ToolRegistry) => Promise<unknown>;
const each = (tools: Tool[]): Road => async (r) => tools.forEach((t) => r.register(t));

/**
 * Every road a host-defined tool takes into the registry. The builtin source
 * registers the last three arrays only when their env is set; all are taken
 * here. Each source runs exactly as at boot; the memory source in its widest
 * mode (the narrow one is a subset).
 */
const ROADS: Record<string, Road> = {
  BUILTIN_TOOLS: each(BUILTIN_TOOLS),
  CRM_TOOLS: each(CRM_TOOLS),
  GWS_TOOLS: each(GWS_TOOLS),
  WP_TOOLS: each(WP_TOOLS),
  GoogleToolSource: (r) => new GoogleToolSource().registerTools(r),
  MemoryToolSource: (r) => new MemoryToolSource().registerTools(r),
  SkillsToolSource: (r) => new SkillsToolSource().registerTools(r),
};

/**
 * One tool per road that ONLY that road provides: a road dropped from ROADS,
 * or a source that stops registering, fails by name, not only by count.
 */
const SENTINELS: Record<string, string> = {
  BUILTIN_TOOLS: "shell_exec",
  CRM_TOOLS: "crm_query",
  GWS_TOOLS: "google_workspace_cli",
  WP_TOOLS: "wp_publish",
  GoogleToolSource: "gmail_send",
  MemoryToolSource: "memory_search",
  SkillsToolSource: "skill_list",
};

/**
 * Guards a dropped road together with the sentinels: set four below the real
 * count, so a road of five or more tools that drops out fails here even if its
 * sentinel went with it. A single tool removed on purpose is a legitimate
 * change and stays above the floor; lower it only when tools are retired.
 */
const FLOOR = 193;

/** The tools the roads leave in a fresh registry, and how many register calls they made. */
async function registered(roads: Road[]): Promise<{ tools: Tool[]; calls: number }> {
  const registry = new ToolRegistry();
  let calls = 0;
  const register = registry.register.bind(registry);
  registry.register = (t) => (calls++, register(t));
  for (const road of roads) await road(registry);
  return { tools: registry.list().map((n) => registry.get(n)!), calls };
}

const { tools: ALL, calls: REGISTER_CALLS } = await registered(Object.values(ROADS));
const NAMES = new Set(ALL.map((t) => t.name));
/** The names each road provides on its own. */
const BY_ROAD = new Map(
  await Promise.all(
    Object.entries(ROADS).map(
      async ([road, add]) => [road, new Set((await registered([add])).tools.map((t) => t.name))] as const,
    ),
  ),
);

const desc = (t: Tool): string => t.definition.function.description;

/**
 * snake_case words in a tool's not-for blocks that are not tools, per tool:
 * an entry hides a word only in the description it was proven for. A block
 * can run on into a following section that has no heading line (a pipeline,
 * the result's fields, a catalog), which is why table, column and field names
 * appear here; the per-tool key keeps that contained. Two-way like the legacy
 * list: an entry whose tool is not registered, or whose word that tool's
 * blocks no longer use, fails; no word may be a registered tool name.
 */
const NON_TOOL_WORDS: Record<string, Record<string, string>> = {
  ads_brand_dna: { brief_id: "a parameter of ads_creative_gen and a field of this tool's result" },
  alpha_latest: { run_id: "a parameter of alpha_explain and a field of this tool's result" },
  exa_search: { user_fact: "the user_fact_* tool family, written without the wildcard" },
  infographic_generate: { svg_html: "a format value of diagram_generate" },
  kb_batch_insert: {
    parent_doc_id: "a field of each entry (nested parameter)",
    section_path: "a field of each entry (nested parameter)",
    chunk_position: "a field of each entry (nested parameter)",
  },
  memory_forget: { valid_to: "column of knowledge_triples" },
  pm_paper_rebalance: {
    ship_gate: "the backtest ship gate paper_rebalance checks",
    entry_signal: "column of trade_theses",
    pm_daily_rebalance: "an entry_signal value",
  },
  seo_page_audit: { seo_audits: "table" },
  skill_run: { consecutive_failures: "column of skills" },
  task_history: { total_matched: "a field of this tool's result" },
  tweet_mentions: {
    user_facts: "table",
    tweet_id: "a field of this tool's result items",
    created_at: "a field of this tool's result items",
    in_reply_to: "a field of this tool's result items",
  },
  tweet_post: { user_facts: "table", auth_token: "the X session cookie the model must never look up" },
  tweet_probe: { user_facts: "table" },
};

/**
 * A not-for block runs from a not-for phrase to the next heading line or the
 * end of the text; every not-for phrase outside an earlier block opens one,
 * so a late "DO NOT USE WHEN:" section is read even after an early "use X
 * instead" line. A heading line opens with a word and ends its label with a
 * colon, in any case ("WHAT IT RETURNS:", "Examples:"): what follows such a
 * line is another section, not a not-for line.
 */
const HEADING_RE = /\n[A-Z][A-Z /()-]{3,}:/i;

function notForBlocks(text: string): string[] {
  const blocks: string[] = [];
  let from = 0;
  for (const m of text.matchAll(new RegExp(NOT_FOR_RE.source, "gim"))) {
    if (m.index < from) continue;
    const after = text.slice(m.index + m[0].length);
    const end = after.search(HEADING_RE);
    const block = m[0] + (end < 0 ? after : after.slice(0, end));
    blocks.push(block);
    from = m.index + block.length;
  }
  return blocks;
}

/**
 * snake_case words in the tool's not-for blocks that name no registered tool.
 * Wildcards (`gmail_*`) resolve by prefix, underscore included; the tool's
 * own parameter names are not siblings. Each NON_TOOL_WORDS entry that was
 * needed goes into `used` as `tool:word`.
 */
function unknownSiblings(t: Tool, used = new Set<string>()): string[] {
  const params = Object.keys(
    ((t.definition.function.parameters as { properties?: Record<string, unknown> })
      .properties ?? {}),
  );
  const words = NON_TOOL_WORDS[t.name] ?? {};
  const bad: string[] = [];
  for (const block of notForBlocks(desc(t))) {
    // `\b` cannot follow `*`, so a wildcard has its own ending.
    for (const tok of block.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)*_(?:\*|[a-z0-9]+\b)/g) ?? []) {
      if (params.includes(tok)) continue;
      if (Object.hasOwn(words, tok)) {
        used.add(`${t.name}:${tok}`);
        continue;
      }
      const ok = tok.endsWith("_*")
        ? [...NAMES].some((n) => n.startsWith(tok.slice(0, -1)))
        : NAMES.has(tok);
      if (!ok) bad.push(tok);
    }
  }
  return bad;
}

/** A synthetic tool for the rule's own cases; never registered. */
const synthetic = (description: string): Tool => ({
  name: "syn_lint_case",
  definition: {
    type: "function",
    function: {
      name: "syn_lint_case",
      description,
      parameters: { type: "object", properties: { syn_param: { type: "string" } } },
    },
  },
  execute: async () => "{}",
});

/** Tools outside the legacy list whose description has no not-for section. */
const withoutNotFor = (tools: Tool[]): string[] =>
  tools
    .filter((t) => !LEGACY_WITHOUT_NOT_FOR.has(t.name) && !NOT_FOR_RE.test(desc(t)))
    .map((t) => t.name);

describe("tool descriptions — not-for section ratchet", () => {
  it("covers every road into the registry: a sentinel only that road provides, and the count floor", () => {
    expect(Object.keys(SENTINELS)).toEqual(Object.keys(ROADS));
    for (const [road, sentinel] of Object.entries(SENTINELS)) {
      const providers = [...BY_ROAD].filter(([, names]) => names.has(sentinel)).map(([r]) => r);
      expect(providers, `sentinel ${sentinel}`).toEqual([road]);
      expect(NAMES.has(sentinel), sentinel).toBe(true);
    }
    expect(ALL.length).toBeGreaterThanOrEqual(FLOOR);
  });

  it("no tool name is registered twice, within a road or across roads (the registry keeps only the last, silently)", () => {
    expect(REGISTER_CALLS).toBe(NAMES.size);
  });

  it("every tool outside the legacy list says when NOT to use it", () => {
    expect(withoutNotFor(ALL), "add a 'DO NOT USE WHEN:' block naming the sibling tool").toEqual([]);
  });

  it("a registered tool that loses its not-for section is reported (in-memory copy)", () => {
    const t = ALL.find((x) => x.name === "skill_run")!;
    const fn = t.definition.function;
    const cut = {
      ...t,
      definition: { ...t.definition, function: { ...fn, description: desc(t).split("DO NOT USE WHEN:")[0] } },
    };
    expect(withoutNotFor([t])).toEqual([]);
    expect(withoutNotFor([cut])).toEqual(["skill_run"]);
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
   * the destructive NorthStar sync tool (retired 2026-10-06). Wildcards (`gmail_*`) resolve by prefix;
   * a tool's own parameter names are not siblings.
   */
  it("every snake_case sibling named in a DO NOT USE block is a registered tool", () => {
    const bad = ALL.flatMap((t) => unknownSiblings(t).map((tok) => `${t.name} → ${tok}`));
    expect(bad, "not-for line names a tool that is not registered").toEqual([]);
  });

  it("every NON_TOOL_WORDS entry is a registered tool whose not-for block still uses the word", () => {
    const used = new Set<string>();
    for (const t of ALL) unknownSiblings(t, used);
    const entries = Object.entries(NON_TOOL_WORDS).flatMap(([tool, words]) => Object.keys(words).map((w) => `${tool}:${w}`));
    const unused = entries.filter((e) => !used.has(e));
    expect(unused, "tool not registered or word no longer in its block — delete from NON_TOOL_WORDS").toEqual([]);
  });

  it("no NON_TOOL_WORDS word is a registered tool name", () => {
    const tools = Object.values(NON_TOOL_WORDS).flatMap((words) => Object.keys(words)).filter((w) => NAMES.has(w));
    expect(tools, "a tool name is never a non-tool word").toEqual([]);
  });

  it("the block reaches past its first line and stops at the next heading or the end of the text", () => {
    const headed = synthetic(
      "Does a thing.\n\nDO NOT USE WHEN:\n- a list is wanted — syn_missing_sibling\n\nEXAMPLES:\n- syn_after_caps_heading",
    );
    expect(unknownSiblings(headed)).toEqual(["syn_missing_sibling"]);
    const mixed = synthetic("DO NOT USE WHEN:\n- lists\nReturns: syn_after_mixed_heading");
    expect(unknownSiblings(mixed)).toEqual([]);
    const tail = synthetic("Does a thing. Do NOT use it for lists.\n\n- for lists\n- see syn_last_line_sibling");
    expect(unknownSiblings(tail)).toEqual(["syn_last_line_sibling"]);
  });

  it("a wildcard sibling and the tool's own parameter are not reported", () => {
    const t = synthetic("Does a thing.\n\nDO NOT USE WHEN:\n- mail — use the gmail_* tools\n- set syn_param instead");
    expect(unknownSiblings(t)).toEqual([]);
    expect(unknownSiblings(synthetic("DO NOT USE WHEN:\n- mail — use the syn_nothing_* tools"))).toEqual([
      "syn_nothing_*",
    ]);
    // the prefix keeps its underscore: `gmai_*` is not the gmail family
    expect(unknownSiblings(synthetic("DO NOT USE WHEN:\n- mail — use the gmai_* tools"))).toEqual(["gmai_*"]);
  });

  it("every not-for phrase opens a block: an early 'use X instead' line and a later DO NOT USE section are both read", () => {
    const t = synthetic(
      "Does a thing. For lists use syn_early_missing instead.\n\nDO NOT USE WHEN:\n- a report is wanted — syn_late_missing",
    );
    expect(unknownSiblings(t)).toEqual(["syn_early_missing", "syn_late_missing"]);
  });

  it("the NOT WHEN and WHEN NOT TO USE headings count as not-for sections", () => {
    expect(NOT_FOR_RE.test("Does a thing.\n\nNOT WHEN:\n- lists")).toBe(true);
    expect(NOT_FOR_RE.test("Does a thing.\n\nWHEN NOT TO USE:\n- lists")).toBe(true);
    expect(NOT_FOR_RE.test("Does a thing, but not when it rains.")).toBe(false);
  });

});

/**
 * Paths (from `path`) of the properties in a JSON schema that have no
 * non-empty description, at every depth: each `properties` entry, the object
 * an array's `items` holds, and every `anyOf` / `oneOf` branch. An array's
 * `items` and a branch are schemas, not properties, so they need none.
 */
function undescribed(schema: unknown, path: string): string[] {
  if (!schema || typeof schema !== "object") return [];
  const s = schema as {
    properties?: Record<string, unknown>;
    items?: unknown;
    anyOf?: unknown[];
    oneOf?: unknown[];
  };
  const out: string[] = [];
  for (const [key, prop] of Object.entries(s.properties ?? {})) {
    const at = `${path}.${key}`;
    const d = (prop as { description?: unknown } | null)?.description;
    if (typeof d !== "string" || d.trim() === "") out.push(at);
    out.push(...undescribed(prop, at));
  }
  out.push(...undescribed(s.items, `${path}[]`));
  for (const k of ["anyOf", "oneOf"] as const) {
    (s[k] ?? []).forEach((b, i) => out.push(...undescribed(b, `${path}.${k}[${i}]`)));
  }
  return out;
}

describe("tool schemas — every property is described", () => {
  it("every property of every registered tool, at every depth, has a non-empty description", () => {
    const bad = ALL.flatMap((t) => undescribed(t.definition.function.parameters, t.name));
    expect(bad, "property without a description (tool.path)").toEqual([]);
  });

  it("the walk reports nested items, anyOf and oneOf properties and a blank text; scalar items need none", () => {
    const schema = {
      type: "object",
      properties: {
        top: { type: "string" },
        list: {
          type: "array",
          description: "d",
          items: {
            type: "object",
            properties: { inner: { type: "string" }, named: { type: "string", description: "d" } },
          },
        },
        tags: { type: "array", description: "d", items: { type: "string" } },
        either: {
          description: "d",
          anyOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "string" }],
        },
        one: {
          description: "d",
          oneOf: [{ type: "string" }, { type: "object", properties: { b: { type: "string", description: " " } } }],
        },
      },
    };
    expect(undescribed(schema, "syn")).toEqual([
      "syn.top",
      "syn.list[].inner",
      "syn.either.anyOf[0].a",
      "syn.one.oneOf[1].b",
    ]);
  });
});
