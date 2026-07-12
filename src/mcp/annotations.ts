/**
 * MCP-tool annotation lookup — assigns the four MCP-spec hints
 * (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) to
 * tools registered via the MCP source by name pattern.
 *
 * Why this exists: MCP servers don't currently ship hints with their tool
 * schemas (the spec is permissive — hints are optional). Without overrides,
 * every MCP-registered tool falls back to `getToolAnnotations` defaults
 * (`{readOnly:false, destructive:true, idempotent:false, openWorld:true}`)
 * — the conservative-unknown stance. That's safe but it pollutes the
 * destructive-cohort metric `mc-ctl audit-claim` reports: a 4-tool
 * read-only Reddit-intel server registers as "4 destructive tools."
 *
 * Spine 4 W4 (2026-05-08) deferred this work; this module ships it. When
 * upstream MCP servers begin supplying their own hints (the spec encourages
 * it), the override becomes redundant — at that point, prefer the upstream
 * hint over our pattern lookup. For now, our pattern lookup IS the source
 * of truth for these tools.
 *
 * Format: namespaced names match `serverId__toolName`. Patterns operate on
 * the post-namespace name where possible so a single pattern catches
 * `playwright__browser_click` AND `browser__click` if both servers expose
 * the same verb. Unknown tools fall through to undefined hints — callers
 * should preserve `getToolAnnotations`'s conservative-unknown defaults
 * rather than guessing.
 *
 * The classification matches the four canonical hint sets used elsewhere
 * in mission-control:
 *   r — read-only / pure transform / safe retry
 *   w — write / side-effecting / not idempotent
 *   d — destructive / irreversible / requires confirmation
 *   x — explicitly mixed / unsafe to default
 */
import { MCP_NAMESPACE_SEP } from "./types.js";

/** Hint overrides for an MCP tool — all four required when classified. */
export interface McpToolHintOverride {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

const READ_ONLY: McpToolHintOverride = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const WRITE_NETWORKED: McpToolHintOverride = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

const DESTRUCTIVE: McpToolHintOverride = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

/**
 * Strip the `serverId__` prefix from a namespaced MCP tool name. Returns
 * the original name if no separator is present (callers can pass either
 * form). The separator is a double underscore (`__`) per `MCP_NAMESPACE_SEP`.
 */
function stripNamespace(namespacedName: string): string {
  const idx = namespacedName.indexOf(MCP_NAMESPACE_SEP);
  return idx === -1
    ? namespacedName
    : namespacedName.slice(idx + MCP_NAMESPACE_SEP.length);
}

/**
 * Read-only verb whitelist — operations that fetch/observe state without
 * mutating it. Tested against the post-namespace tool name.
 *
 * Notes:
 *  - `evaluate` / `run_code` are EXCLUDED — JS execution can mutate the
 *    page's DOM and trigger XHRs. Strict-readers should treat them as
 *    write-class. They land in the WRITE_VERBS list below.
 *  - `screenshot` / `snapshot` write to disk via the upstream tool but
 *    only as observed-state artifacts — we treat the tool surface as
 *    read-side. Callers wanting strict no-disk semantics should rely on
 *    `openWorldHint:true` rather than `readOnlyHint:false`.
 */
const READ_VERBS: ReadonlyArray<string> = [
  "goto",
  "markdown",
  "links",
  "semantic_tree",
  "interactiveElements",
  "structuredData",
  "browser_navigate",
  "browser_navigate_back",
  "browser_snapshot",
  "browser_take_screenshot",
  "browser_console_messages",
  "browser_network_requests",
  "browser_tabs",
  "browser_wait_for",
];

/**
 * Read-only PER-SERVER prefix patterns. Tools whose post-namespace name
 * starts with these get read-only hints. Per-server scoping (rather than
 * a bare `get_` / `list_` prefix) prevents accidental classification of
 * future verbs like `get_credentials` or `list_and_delete` whose names
 * suggest reads but whose handlers mutate. Audit W2 (2026-05-09):
 * tightened from `["xpoz_get_", "get_", "list_"]`.
 */
const READ_PREFIXES: ReadonlyArray<string> = ["xpoz_get_", "xpoz_list_"];

/**
 * Graphify-code server — read-only graph query tools. Added 2026-05-09
 * after the W3 startup-warning surfaced them as unannotated. These
 * answer "what does the codebase look like" queries (community
 * detection, neighbor traversal, stats); none mutate the graph.
 */
const GRAPHIFY_READ_VERBS: ReadonlyArray<string> = [
  "query_graph",
  "get_node",
  "get_neighbors",
  "get_community",
  "god_nodes",
  "graph_stats",
  "shortest_path",
];

/**
 * Write-class but reversible verbs — UI interactions, form fills,
 * navigation that mutate browser/session state but don't delete user
 * data. Not idempotent (a second click is not a no-op).
 */
const WRITE_VERBS: ReadonlyArray<string> = [
  "click",
  "fill",
  "scroll",
  "evaluate",
  "browser_click",
  "browser_fill_form",
  "browser_press_key",
  "browser_type",
  "browser_drag",
  "browser_hover",
  "browser_select_option",
  "browser_resize",
  "browser_handle_dialog",
  "browser_run_code_unsafe",
  "browser_evaluate",
  "browser_file_upload",
];

/**
 * Destructive verbs — irreversible session/state-loss operations.
 * These should align with the `destructiveHint` semantics: a careful
 * caller would want to confirm before invoking.
 */
const DESTRUCTIVE_VERBS: ReadonlyArray<string> = [
  "browser_close",
  "xpoz_trigger_run",
];

/**
 * Look up MCP-tool hint overrides by namespaced tool name.
 *
 * Returns undefined when the tool name doesn't match any known pattern —
 * callers should preserve `getToolAnnotations`'s conservative-unknown
 * defaults (`{readOnly:false, destructive:true, idempotent:false,
 * openWorld:true}`) rather than guessing for unmatched tools. The defaults
 * already err destructive; a falsy lookup result is the right signal to
 * stay conservative.
 *
 * Pattern precedence (most specific wins):
 *  1. Exact match in DESTRUCTIVE_VERBS → destructive
 *  2. Exact match in READ_VERBS → read-only
 *  3. Exact match in WRITE_VERBS → write
 *  4. Prefix match against READ_PREFIXES → read-only
 *  5. No match → undefined (preserve caller's defaults)
 */
export function getMcpToolHints(
  namespacedName: string,
): McpToolHintOverride | undefined {
  const local = stripNamespace(namespacedName);

  if (DESTRUCTIVE_VERBS.includes(local)) return DESTRUCTIVE;
  if (READ_VERBS.includes(local)) return READ_ONLY;
  if (GRAPHIFY_READ_VERBS.includes(local)) return READ_ONLY;
  if (WRITE_VERBS.includes(local)) return WRITE_NETWORKED;
  if (READ_PREFIXES.some((p) => local.startsWith(p))) return READ_ONLY;

  return undefined;
}
