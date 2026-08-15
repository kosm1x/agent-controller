/**
 * Rule of Two — V8.5 Phase 5.2 (2026-08-15).
 *
 * Meta's "Agents Rule of Two" (2025-10): within one agent SESSION hold at most
 * two of —
 *   [A] processes UNTRUSTED input          (`untrustedInputHint`)
 *   [B] touches SENSITIVE systems / data    (`sensitiveAccessHint`)
 *   [C] changes state / communicates out    (`!readOnlyHint`, already declared)
 * All three ⇒ human-in-the-loop, never autonomy. It is a COMPOSITION property:
 * a run that calls `gmail_read` (A+B) and later `gmail_send` (C) is the trifecta
 * even though no single tool holds all three. Two layers therefore:
 *
 *   Layer 1 — per-tool matrix. `getToolAnnotations` resolves A/B via
 *     `resolveRuleOfTwo` and applies the STRUCTURAL rule: a single tool holding
 *     all three is `riskTier:"high"` + `requiresConfirmation` (the resolver
 *     refuses the safe-looking value; there is no code path around it —
 *     `ToolRegistry.getEffectiveRiskTier` delegates here). Seed/promotion/
 *     pipeline cap a trifecta-BACKED V8.3 capability at L1.
 *   Layer 2 — run-level composition. `runToolContext` (AsyncLocalStorage,
 *     entered by the dispatcher around every IN-PROCESS runner execution —
 *     same propagation path `ritualContext` already proves through the SDK
 *     tool bridge; see the BOUNDARY note on `runToolContext` for what it does
 *     not see) accumulates the tool names invoked so far in the run; the V8.3
 *     pipeline evaluates `ruleOfTwoState(prior ∪ this)` and demotes a C
 *     capability to L1 (`autonomy_demoted` reason `rule_of_two`) when A∧B were
 *     already seen, and to L1 (`rule_of_two_no_context`) when the seam ran
 *     outside any run context. Dormant while everything is L1; live at first
 *     promotion.
 *
 * CLASSIFICATION RULES (auditable — the matrix generator prints these):
 *   A = the tool's INHERENT output is free text authored outside the
 *       operator/Jarvis boundary (mail, web, shared workspace docs, inbound
 *       messages, feeds with third-party prose, PDFs). Structured/numeric feeds
 *       (quotes, weather, FX, geocode) are NOT A. Content the LLM chooses to
 *       fetch through an unbounded verb (`shell_exec` + curl) is ARGS-BORNE,
 *       not inherent — named residual, mitigated by the shell scope gate.
 *   B = private operator data (KB, memories, facts, tasks, mail, workspace,
 *       CRM, engine state) or privileged host/system access (FS, shell, git,
 *       VPS, site admin, accounts). "Uses an API key" alone is NOT B.
 *   KB reads are TRUSTED tier (operator ruling 2026-08-15): B only, not A —
 *       untrusted content enters through the INGEST edges, which are A.
 *   Sub-agents / unbounded dispatchers (`skill_run`, `jarvis_dev`,
 *       `google_workspace_cli`, `wp_raw_api`) hold A by construction — their
 *       provenance is unknowable at the tool boundary ⇒ conservative.
 *   Unclassified ⇒ true/true (the file's standing "unknown = riskier" rule).
 *   In a personal agent B is nearly universal, so the rule collapses in
 *   practice to "A and C never share a run without a human gate".
 */

import { AsyncLocalStorage } from "async_hooks";
import type { Tool, ToolAnnotations } from "./types.js";

export interface RuleOfTwoClass {
  /** [A] inherent output carries third-party-authored free text. */
  readonly untrustedInput: boolean;
  /** [B] private operator data or privileged system access. */
  readonly sensitiveAccess: boolean;
}

const c = (
  untrustedInput: boolean,
  sensitiveAccess: boolean,
): RuleOfTwoClass => ({ untrustedInput, sensitiveAccess });

const A = c(true, false);
const B = c(false, true);
const AB = c(true, true);
const NONE = c(false, false);

/**
 * Explicit classification of every host-defined (builtin) tool by name.
 * `rule-of-two.test.ts` asserts BOTH directions against the real sources:
 * every registered builtin has an entry, and every entry names a real tool.
 * A rename therefore fails CI instead of silently falling to true/true.
 */
export const RULE_OF_TWO_CLASSIFICATION: Readonly<
  Record<string, RuleOfTwoClass>
> = {
  // ---- ads / seo / web analysis (third-party sites in, no private data) ----
  ads_audit: A,
  ads_brand_dna: A,
  ads_creative_gen: NONE,
  ai_overview_track: A,
  seo_content_brief: A,
  seo_keyword_research: A,
  seo_meta_generate: A,
  seo_page_audit: A,
  seo_robots_audit: A,
  seo_llms_txt_generate: A,
  seo_schema_generate: A,
  seo_telemetry: B,
  // ---- web / feeds ----
  web_search: A,
  web_read: A,
  http_fetch: A,
  exa_search: A,
  rss_read: A,
  screenshot_element: A,
  gemini_research: A,
  // ---- pure generators / utilities (no provenance, no private data) ----
  chart_generate: NONE,
  diagram_generate: NONE,
  infographic_generate: NONE,
  gemini_image: NONE,
  hf_generate: NONE,
  hf_spaces: NONE,
  humanize_text: NONE,
  currency_convert: NONE,
  geocode_address: NONE,
  weather_forecast: NONE,
  // ---- video pipeline (operator media, no third-party prose) ----
  video_background_download: NONE,
  video_brand_apply: NONE,
  video_compose_manifest: NONE,
  video_create: NONE,
  video_html_compose: NONE,
  video_image: NONE,
  video_job_cancel: NONE,
  video_job_cleanup: NONE,
  video_list_profiles: NONE,
  video_list_voices: NONE,
  video_script: NONE,
  video_status: NONE,
  video_storyboard: NONE,
  video_transition_preview: NONE,
  video_tts: NONE,
  // ---- market / trading (numeric feeds ≠ A; engine state = B) ----
  macro_regime: NONE,
  market_history: NONE,
  market_indicators: NONE,
  market_quote: NONE,
  market_scan: NONE,
  market_signals: NONE,
  sentiment_snapshot: NONE,
  market_calendar: NONE,
  market_chart_patterns: NONE,
  market_chart_render: NONE,
  prediction_markets: A, // market titles are third-party text
  whale_trades: A, // carries market titles
  market_budget_stats: B,
  alert_budget_status: B,
  market_watchlist_add: B,
  market_watchlist_list: B,
  market_watchlist_remove: B,
  market_watchlist_reseed: B,
  alpha_explain: B,
  alpha_latest: B,
  alpha_run: B,
  backtest_explain: B,
  backtest_latest: B,
  backtest_run: B,
  paper_history: B,
  paper_portfolio: B,
  paper_rebalance: B,
  pm_alpha_latest: B,
  pm_alpha_run: B,
  pm_paper_history: B,
  pm_paper_portfolio: B,
  pm_paper_rebalance: B,
  // ---- host FS / code / git / VPS (privileged system access) ----
  shell_exec: B, // args-borne fetches are a named residual (see header)
  file_read: B,
  file_write: B,
  file_delete: B,
  file_edit: B,
  file_convert: B,
  code_search: B,
  glob: B,
  grep: B,
  list_dir: B,
  git_status: B,
  git_diff: B,
  git_commit: B,
  git_push: B,
  gh_create_pr: B,
  gh_repo_create: B,
  vps_status: B,
  vps_backup: B,
  vps_deploy: B,
  vps_logs: AB, // journals echo inbound payloads (WA/Telegram text)
  jarvis_dev: AB, // sub-agent with its own tool loop — provenance unknowable
  jarvis_diagnose: AB, // reads logs
  jarvis_test_run: B,
  // ---- KB / memory / facts / projects / tasks (trusted tier, private) ----
  jarvis_file_list: B,
  jarvis_file_read: B,
  jarvis_file_search: B,
  jarvis_file_write: B,
  jarvis_file_update: B,
  jarvis_file_delete: B,
  jarvis_file_move: B,
  jarvis_files_batch_write: B,
  jarvis_files_batch_delete: B,
  jarvis_propose_directive: B,
  jarvis_apply_proposal: B,
  knowledge_map: B,
  knowledge_map_expand: B,
  kb_batch_insert: B, // rows are LLM-supplied args, not fetched
  kb_ingest_pdf_structured: AB, // ingest edge: third-party PDF → trusted store
  pdf_read: AB,
  memory_kg_query: B,
  memory_search: B,
  memory_store: B,
  memory_reflect: B,
  user_fact_set: B,
  user_fact_list: B,
  user_fact_delete: B,
  project_get: B,
  project_list: B,
  project_update: B,
  task_history: B,
  batch_decompose: B,
  submit_report: B,
  dashboard_generate: B,
  dashboard_list: B,
  evolution_get_data: B,
  evolution_deactivate_skill: B,
  northstar_sync: B,
  schedule_task: B,
  list_schedules: B,
  delete_schedule: B,
  learner_model_status: B,
  learning_plan_create: B,
  learning_plan_advance: B,
  learning_plan_explain_back: B,
  learning_plan_quiz: B,
  learning_plan_status: B,
  learning_plan_summarize: B,
  // ---- skills (stored procedures; skill_run = unbounded ⇒ A by construction) ----
  skill_list: B,
  skill_save: B,
  skill_describe: B,
  skill_load: B,
  skill_run: AB,
  // ---- Google Workspace (shared content is common ⇒ reads are A+B) ----
  gmail_send: B,
  gmail_search: AB,
  gmail_read: AB,
  gdrive_list: AB, // filenames on shared drives are attacker-controllable
  gdrive_download: AB,
  gdrive_create: B,
  gdrive_share: B,
  gdrive_delete: B,
  gdrive_move: B,
  gdrive_upload: B,
  calendar_list: AB, // invites from others carry free text
  calendar_create: B,
  calendar_update: B,
  gdocs_read: AB,
  gdocs_read_full: AB,
  gdocs_write: B,
  gdocs_replace: B,
  gsheets_read: AB,
  gsheets_write: B,
  gslides_read: AB,
  gslides_create: B,
  gtasks_create: B,
  google_workspace_cli: AB, // arbitrary gws verbs incl. reads
  gemini_upload: B,
  gemini_audio_overview: B, // uploaded private documents
  // ---- CRM / intel (ingested inbound content ⇒ A+B) ----
  crm_query: AB,
  intel_query: AB,
  intel_alert_history: AB,
  intel_baseline: B,
  intel_status: B,
  // ---- WordPress (own site admin) ----
  wp_categories: B,
  wp_list_posts: B,
  wp_read_post: B,
  wp_pages: B,
  wp_media_upload: B,
  wp_publish: B,
  wp_delete: B,
  wp_plugins: B,
  wp_settings: B,
  wp_raw_api: AB, // arbitrary REST verbs incl. reading comments
  // ---- X / Twitter ----
  tweet_mentions: AB,
  tweet_probe: A,
  tweet_post: B,
};

/**
 * Per-tool overrides for MCP-namespaced names (`serverId__tool`) that differ
 * from their server's prefix default. Checked BEFORE the prefix table.
 * `rule-of-two.test.ts` pins these against the live MCP name fixture.
 */
export const RULE_OF_TWO_MCP_OVERRIDES: Readonly<Record<string, RuleOfTwoClass>> =
  {
    // Triggers a pipeline run and returns job status — no Reddit prose comes
    // back through THIS tool (the reads do: topics/digest/history stay A+B).
    // Without this it would be the only MCP tool to flip to high/confirm
    // (qa C1 2026-08-15).
    xpoz__xpoz_trigger_run: B,
    xpoz__xpoz_get_job_status: B,
  };

/**
 * Per-source defaults for tools not host-defined, matched by MCP namespace
 * prefix (`serverId__tool`). Anything unmatched falls to true/true — a NEW
 * MCP server's non-readOnly tools are therefore high/confirm until a row is
 * added here (deliberate; the coverage test checks `mcp-servers.json` ids).
 */
export const RULE_OF_TWO_PREFIX_DEFAULTS: ReadonlyArray<
  readonly [prefix: string, cls: RuleOfTwoClass]
> = [
  ["browser__", A],
  ["playwright__", A],
  ["graphify-code__", B],
  ["xpoz__", AB],
];

const UNKNOWN: RuleOfTwoClass = c(true, true);

/** Own-key lookup — prototype-chain names (`constructor`, `toString`, …) must never classify. */
function own(
  table: Readonly<Record<string, RuleOfTwoClass>>,
  name: string,
): RuleOfTwoClass | undefined {
  return Object.hasOwn(table, name) ? table[name] : undefined;
}

/**
 * Resolve [A]/[B] for a tool: explicit fields on the tool win, then the
 * name-keyed classification, then the MCP per-tool override, then the MCP
 * prefix default, then true/true.
 */
export function resolveRuleOfTwo(
  tool: Pick<Tool, "name" | "untrustedInputHint" | "sensitiveAccessHint">,
): RuleOfTwoClass {
  const byName =
    own(RULE_OF_TWO_CLASSIFICATION, tool.name) ??
    own(RULE_OF_TWO_MCP_OVERRIDES, tool.name) ??
    RULE_OF_TWO_PREFIX_DEFAULTS.find(([p]) => tool.name.startsWith(p))?.[1] ??
    UNKNOWN;
  return {
    untrustedInput: tool.untrustedInputHint ?? byName.untrustedInput,
    sensitiveAccess: tool.sensitiveAccessHint ?? byName.sensitiveAccess,
  };
}

/** True when the classification came from an explicit source (not the true/true fallback). */
export function isRuleOfTwoClassified(name: string): boolean {
  return (
    Object.hasOwn(RULE_OF_TWO_CLASSIFICATION, name) ||
    Object.hasOwn(RULE_OF_TWO_MCP_OVERRIDES, name) ||
    RULE_OF_TWO_PREFIX_DEFAULTS.some(([p]) => name.startsWith(p))
  );
}

/** Static [A]∧[B] by tool name (C is assumed for a gated write — the seed cross-checks it). */
export function isTrifectaByName(name: string): boolean {
  const cls = resolveRuleOfTwo({ name });
  return cls.untrustedInput && cls.sensitiveAccess;
}

/** The three properties + the trifecta verdict over a set of annotations. */
export interface RuleOfTwoState {
  readonly untrustedInput: boolean;
  readonly sensitiveAccess: boolean;
  readonly stateChange: boolean;
  readonly trifecta: boolean;
}

/**
 * Compose the Rule-of-Two state over a run: OR each property across every tool
 * invoked. `resolve` returns the normalized annotations for a name, or
 * `undefined` for an unknown name — which counts as ALL THREE (fail toward
 * demotion; an unknown name at the gate is a wiring bug, and the safe answer
 * to a wiring bug is a human).
 */
export function ruleOfTwoState(
  toolNames: Iterable<string>,
  resolve: (name: string) => ToolAnnotations | undefined,
): RuleOfTwoState {
  let untrustedInput = false;
  let sensitiveAccess = false;
  let stateChange = false;
  for (const name of toolNames) {
    const a = resolve(name);
    if (!a) {
      untrustedInput = sensitiveAccess = stateChange = true;
      break;
    }
    untrustedInput ||= a.untrustedInputHint;
    sensitiveAccess ||= a.sensitiveAccessHint;
    stateChange ||= !a.readOnlyHint;
  }
  return {
    untrustedInput,
    sensitiveAccess,
    stateChange,
    trifecta: untrustedInput && sensitiveAccess && stateChange,
  };
}

// ---------------------------------------------------------------------------
// Layer 2 run context — which tools this run has invoked so far.
// ---------------------------------------------------------------------------

export interface RunToolContext {
  /**
   * Insertion-ordered set of tool names invoked so far in this SESSION — one
   * object shared by a run and every nested dispatch under it, so a child's
   * calls are visible to the parent AND to concurrent siblings (intended:
   * the doctrine is a session property, and a swarm IS one session).
   */
  readonly toolsSoFar: Set<string>;
}

/**
 * Entered by the dispatcher around `runner.execute()`. Tool calls that reach
 * `ToolRegistry.execute` inside it are recorded; the V8.3 seam reads the
 * prior set.
 *
 * BOUNDARY (qa W2 2026-08-15): the context is IN-PROCESS and follows the
 * async chain. Covered: host runners (fast/heavy-in-process/swarm) and swarm
 * sub-tasks — a nested `submitTask` from inside a run INHERITS the parent's
 * set (same session: ONE Set object, so a child's calls are visible to the
 * parent and to concurrent siblings). The container-queue drain explicitly
 * EXITS the ambient context (`outsideRunToolContext`) so an unrelated
 * dequeued task never inherits a finishing run's set. NOT covered: container
 * workers (`nanoclaw-worker`/`heavy-worker` are separate processes), the
 * reflection runner (`reflection/runner.ts` runs `fastRunner.execute` outside
 * the dispatcher) and the interactive confirm seam (router message handler).
 * Outside a run `priorRunTools()` returns `undefined` — and the pipeline
 * treats an UNKNOWN prior as all three (demote, fail closed), so a boundary
 * the context cannot see is handed to a human, never waved through.
 */
export const runToolContext = new AsyncLocalStorage<RunToolContext>();

export function enterRunToolContext<T>(taskId: string, fn: () => T): T {
  const parent = runToolContext.getStore();
  void taskId; // identity is the ambient store; the id is for call-site legibility
  return runToolContext.run(
    { toolsSoFar: parent ? parent.toolsSoFar : new Set() },
    fn,
  );
}

/**
 * Run `fn` OUTSIDE any run context. For queue drains and other places where
 * work for an UNRELATED task would otherwise inherit the ambient store (qa
 * W-A 2026-08-15: the container-queue drain fires from `releaseContainerSlot`
 * inside the finishing run's frame — without this, the dequeued task got the
 * finishing run's tool set as its prior, and its calls leaked back).
 */
export function outsideRunToolContext<T>(fn: () => T): T {
  return runToolContext.exit(fn);
}

/**
 * Snapshot of the tools invoked BEFORE the current call. `undefined` outside a
 * run (no context — the pipeline fails closed on it); `[]` inside a run with
 * no prior calls.
 */
export function priorRunTools(): readonly string[] | undefined {
  const store = runToolContext.getStore();
  return store ? Array.from(store.toolsSoFar) : undefined;
}

export function recordRunTool(name: string): void {
  runToolContext.getStore()?.toolsSoFar.add(name);
}
