/**
 * Inference Adapter — OpenAI-compatible multi-provider LLM client.
 *
 * Adapted from NanoClaw's production inference adapter. Raw fetch() to any
 * OpenAI-compatible /v1/chat/completions endpoint. Zero vendor SDK.
 *
 * Features:
 *   - Primary + fallback provider with automatic failover
 *   - Exponential backoff on 429/5xx
 *   - SSE streaming with delta accumulation
 *   - Truncation detection (unclosed braces)
 *   - Parallel tool execution via Promise.all
 *   - Model-specific guards (Qwen enable_thinking)
 */

import { getConfig } from "../config.js";
import { toolRegistry } from "../tools/registry.js";
import { shouldCompress, compress } from "../prometheus/context-compressor.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InferenceProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  priority: number;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type ChatContent =
  | string
  | null
  | Array<{ type: string; [key: string]: unknown }>;

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: ChatContent;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface InferenceRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  max_tokens?: number;
}

export interface InferenceResponse {
  content: string | null;
  tool_calls?: ToolCall[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  provider: string;
  latency_ms: number;
}

export interface ToolExecutor {
  (name: string, args: Record<string, unknown>): Promise<string>;
}

export type OnTextChunk = (text: string) => void;

// ---------------------------------------------------------------------------
// Provider latency tracking — rolling window for health + preemptive failover
// ---------------------------------------------------------------------------

interface LatencyEntry {
  timestamp: number;
  latencyMs: number;
  success: boolean;
  promptTokens: number;
  completionTokens: number;
}

interface ProviderStats {
  count: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  successRate: number;
}

class ProviderMetrics {
  private entries = new Map<string, LatencyEntry[]>();
  private readonly windowSize = 50;

  record(provider: string, entry: LatencyEntry): void {
    let list = this.entries.get(provider);
    if (!list) {
      list = [];
      this.entries.set(provider, list);
    }
    list.push(entry);
    // Evict oldest when window exceeded
    if (list.length > this.windowSize) {
      list.splice(0, list.length - this.windowSize);
    }
  }

  getStats(provider: string): ProviderStats | null {
    const list = this.entries.get(provider);
    if (!list || list.length === 0) return null;

    const latencies = list.map((e) => e.latencyMs).sort((a, b) => a - b);
    const successes = list.filter((e) => e.success).length;
    const p95Idx = Math.min(
      Math.floor(latencies.length * 0.95),
      latencies.length - 1,
    );

    return {
      count: list.length,
      avgLatencyMs: Math.round(
        latencies.reduce((a, b) => a + b, 0) / latencies.length,
      ),
      p95LatencyMs: latencies[p95Idx],
      successRate: successes / list.length,
    };
  }

  getAllStats(): Record<string, ProviderStats> {
    const result: Record<string, ProviderStats> = {};
    for (const [name] of this.entries) {
      const stats = this.getStats(name);
      if (stats) result[name] = stats;
    }
    return result;
  }

  /**
   * True if provider avg latency exceeds threshold AND has enough recent samples.
   * Only considers entries within `windowMs` (default 10 min) so degraded providers
   * automatically get retried after the window expires — prevents permanent death spiral.
   */
  isDegraded(
    provider: string,
    thresholdMs = 15_000,
    minSamples = 10,
    windowMs = 600_000,
  ): boolean {
    const list = this.entries.get(provider);
    if (!list || list.length === 0) return false;

    const cutoff = Date.now() - windowMs;
    const recent = list.filter((e) => e.timestamp >= cutoff);
    if (recent.length < minSamples) return false;

    const latencies = recent.map((e) => e.latencyMs).sort((a, b) => a - b);
    const successes = recent.filter((e) => e.success).length;
    const avgLatencyMs = Math.round(
      latencies.reduce((a, b) => a + b, 0) / latencies.length,
    );
    const successRate = successes / recent.length;

    return avgLatencyMs > thresholdMs || successRate < 0.5;
  }
}

export const providerMetrics = new ProviderMetrics();

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------

function loadProviders(): InferenceProvider[] {
  const config = getConfig();
  const providers: InferenceProvider[] = [];

  if (config.inferencePrimaryUrl && config.inferencePrimaryModel) {
    providers.push({
      name: "primary",
      baseUrl: config.inferencePrimaryUrl.replace(/\/+$/, ""),
      apiKey: config.inferencePrimaryKey,
      model: config.inferencePrimaryModel,
      priority: 0,
    });
  }

  if (config.inferenceFallbackUrl && config.inferenceFallbackModel) {
    providers.push({
      name: "fallback",
      baseUrl: config.inferenceFallbackUrl.replace(/\/+$/, ""),
      apiKey: config.inferenceFallbackKey ?? "",
      model: config.inferenceFallbackModel,
      priority: 1,
    });
  }

  if (config.inferenceTertiaryUrl && config.inferenceTertiaryModel) {
    providers.push({
      name: "tertiary",
      baseUrl: config.inferenceTertiaryUrl.replace(/\/+$/, ""),
      apiKey: config.inferenceTertiaryKey ?? "",
      model: config.inferenceTertiaryModel,
      priority: 2,
    });
  }

  return providers.sort((a, b) => a.priority - b.priority);
}

// ---------------------------------------------------------------------------
// HTTP call to a single provider
// ---------------------------------------------------------------------------

interface OpenAIResponse {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

async function callProvider(
  provider: InferenceProvider,
  request: InferenceRequest,
  onTextChunk?: OnTextChunk,
  externalSignal?: AbortSignal,
): Promise<InferenceResponse> {
  const config = getConfig();
  const url = `${provider.baseUrl}/chat/completions`;
  const start = Date.now();
  const streaming = !!onTextChunk;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (provider.apiKey) {
    headers["Authorization"] = `Bearer ${provider.apiKey}`;
  }

  const body: Record<string, unknown> = {
    model: provider.model,
    messages: request.messages,
    max_tokens: request.max_tokens ?? config.inferenceMaxTokens,
    stream: streaming,
    // Request usage stats in the final SSE chunk (OpenAI-compatible standard).
    // Without this, streaming responses report 0 prompt/completion tokens.
    ...(streaming && { stream_options: { include_usage: true } }),
  };
  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools;
    body.tool_choice = "auto";
  }
  // Disable reasoning/thinking mode for faster responses (Qwen 3.5+, GLM-5+)
  if (provider.model.startsWith("qwen3") || provider.model.startsWith("glm-")) {
    body.enable_thinking = false;
  }

  // Dynamic timeout: scale with tool count. Base timeout is insufficient for
  // large prompts with many tools — LLM providers need more time to process
  // 20K+ token tool-augmented prompts. Add 1s per tool definition.
  const toolCount = request.tools?.length ?? 0;
  const effectiveTimeout = config.inferenceTimeoutMs + toolCount * 1000;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), effectiveTimeout);

  // Compose external abort signal with timeout controller
  const combinedSignal = externalSignal
    ? AbortSignal.any([controller.signal, externalSignal])
    : controller.signal;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: combinedSignal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    let result: InferenceResponse;

    if (streaming && response.body) {
      result = await parseSSEStream(
        response.body,
        provider,
        start,
        onTextChunk,
      );
    } else {
      const data = (await response.json()) as OpenAIResponse;
      const choice = data.choices?.[0];
      if (!choice) throw new Error("Empty response: no choices returned");
      result = {
        content: choice.message.content,
        tool_calls: choice.message.tool_calls,
        usage: data.usage ?? {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
        provider: provider.name,
        latency_ms: Date.now() - start,
      };
    }

    console.log(
      `[inference] ${provider.name}/${provider.model} ${result.latency_ms}ms prompt=${result.usage.prompt_tokens} completion=${result.usage.completion_tokens} tools=${result.tool_calls?.length ?? 0}`,
    );

    // Record success metrics
    providerMetrics.record(provider.name, {
      timestamp: Date.now(),
      latencyMs: result.latency_ms,
      success: true,
      promptTokens: result.usage.prompt_tokens,
      completionTokens: result.usage.completion_tokens,
    });

    return result;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// SSE stream parser
// ---------------------------------------------------------------------------

async function parseSSEStream(
  body: ReadableStream<Uint8Array>,
  provider: InferenceProvider,
  startTime: number,
  onTextChunk: OnTextChunk,
): Promise<InferenceResponse> {
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const toolCalls: Map<number, ToolCall> = new Map();
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 2);

        for (const line of event.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") continue;

          try {
            const chunk = JSON.parse(data);
            const delta = chunk.choices?.[0]?.delta;
            if (!delta) continue;

            if (delta.content) {
              content += delta.content;
              onTextChunk(delta.content);
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                const existing = toolCalls.get(idx);
                if (!existing) {
                  toolCalls.set(idx, {
                    id: tc.id ?? "",
                    type: "function",
                    function: {
                      name: tc.function?.name ?? "",
                      arguments: tc.function?.arguments ?? "",
                    },
                  });
                } else {
                  if (tc.id) existing.id = tc.id;
                  if (tc.function?.name)
                    existing.function.name += tc.function.name;
                  if (tc.function?.arguments)
                    existing.function.arguments += tc.function.arguments;
                }
              }
            }

            if (chunk.usage) usage = chunk.usage;
          } catch {
            /* skip malformed chunks */
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return {
    content: content || null,
    tool_calls: toolCalls.size > 0 ? Array.from(toolCalls.values()) : undefined,
    usage,
    provider: provider.name,
    latency_ms: Date.now() - startTime,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a single inference request with automatic failover.
 * Tries providers in priority order; retries on 429/5xx with exponential backoff.
 */
export async function infer(
  request: InferenceRequest,
  onTextChunk?: OnTextChunk,
  signal?: AbortSignal,
  providerName?: string, // TODO: refactor infer/inferWithTools to use options object
): Promise<InferenceResponse> {
  const config = getConfig();
  const providers = loadProviders();

  // If providerName specified, try that provider first
  if (providerName) {
    const idx = providers.findIndex((p) => p.name === providerName);
    if (idx > 0) {
      const [preferred] = providers.splice(idx, 1);
      providers.unshift(preferred);
    }
  }
  if (providers.length === 0) {
    throw new Error(
      "No inference providers configured. Set INFERENCE_PRIMARY_URL and INFERENCE_PRIMARY_MODEL.",
    );
  }

  let lastError: Error | undefined;

  for (let pi = 0; pi < providers.length; pi++) {
    const provider = providers[pi];

    // Preemptive failover: skip degraded providers if alternatives remain
    if (
      pi < providers.length - 1 &&
      providerMetrics.isDegraded(provider.name)
    ) {
      console.warn(
        `[inference] Skipping degraded provider ${provider.name}, trying next`,
      );
      continue;
    }

    for (let attempt = 0; attempt < config.inferenceMaxRetries; attempt++) {
      const attemptStart = Date.now();
      try {
        const toolCount = request.tools?.length ?? 0;
        const effectiveTimeoutLog =
          config.inferenceTimeoutMs + toolCount * 1000;
        console.log(
          `[inference] Attempting ${provider.name}/${provider.model} (provider ${pi + 1}/${providers.length}, attempt ${attempt + 1}/${config.inferenceMaxRetries}, timeout=${effectiveTimeoutLog}ms, tools=${toolCount})`,
        );
        return await callProvider(provider, request, onTextChunk, signal);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const statusMatch = lastError.message.match(/HTTP (\d+)/);
        const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
        const isAbort =
          lastError.name === "AbortError" ||
          lastError.message.includes("aborted");
        console.warn(
          `[inference] ${provider.name} attempt ${attempt + 1} failed: ${lastError.message}${isAbort ? " (timeout)" : ""} status=${status}`,
        );

        // Record failure metrics
        providerMetrics.record(provider.name, {
          timestamp: Date.now(),
          latencyMs: Date.now() - attemptStart,
          success: false,
          promptTokens: 0,
          completionTokens: 0,
        });

        if (status === 429 || (status >= 500 && status < 600)) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
          console.warn(
            `[inference] ${provider.name} backoff ${delay}ms before retry`,
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        break; // non-retryable → skip to next provider
      }
    }
    console.warn(
      `[inference] ${provider.name} exhausted: ${lastError?.message}, trying next provider`,
    );
  }

  console.error(
    `[inference] All ${providers.length} providers failed. Last: ${lastError?.message}`,
  );
  throw new Error(
    `All inference providers failed. Last error: ${lastError?.message}`,
  );
}

/**
 * Run a full multi-turn conversation with tool execution.
 *
 * Loops: send messages → LLM returns tool_calls → execute tools → append results → repeat.
 * Stops when LLM returns a text response with no tool calls, or maxRounds is hit.
 */
// Constants imported from centralized config
import {
  MAX_TOOL_RESULT_CHARS,
  WRAPUP_TOOL_RESULT_CHARS,
  MAX_CONSECUTIVE_REPEATS,
  STALE_LOOP_THRESHOLD,
  ANALYSIS_PARALYSIS_THRESHOLD,
  PERSISTENT_FAILURE_THRESHOLD,
} from "../config/constants.js";

// ---------------------------------------------------------------------------
// Loop guard constants
// ---------------------------------------------------------------------------

/** Tools that are purely observational. Used by the analysis paralysis guard. */
const READ_ONLY_TOOLS = new Set([
  // Filesystem
  "file_read",
  "grep",
  "glob",
  "list_dir",
  // Web & documents
  "web_search",
  "web_read",
  "exa_search",
  "rss_read",
  "pdf_read",
  "hf_spaces",
  // Memory & facts
  "memory_search",
  "user_fact_list",
  "skill_list",
  // Google (read-only subset)
  "gmail_search",
  "gsheets_read",
  "gdocs_read",
  "gdrive_list",
  "calendar_list",
  // WordPress (read-only subset)
  "wp_list_posts",
  "wp_read_post",
  "wp_categories",
  "wp_pages",
  "wp_plugins",
  "wp_settings",
  // COMMIT (read-only subset)
  "commit__get_daily_snapshot",
  "commit__get_hierarchy",
  "commit__list_tasks",
  "commit__list_goals",
  "commit__list_objectives",
  "commit__search_journal",
  "commit__list_ideas",
  // Projects & evolution
  "project_list",
  "project_get",
  "evolution_get_data",
  // Gemini (read-only subset)
  "gemini_research",
  // Browser observation — click/fill/scroll/evaluate are action tools
  "browser__goto",
  "browser__markdown",
  "browser__links",
  "browser__semantic_tree",
  "browser__structuredData",
  "browser__interactiveElements",
]);

/** Regex matching common error indicators in tool results. */
const ERROR_RESULT_RE =
  /\b(?:error|failed|failure|not found|denied|unauthorized|forbidden|does not exist|no such file|ENOENT|EACCES|EPERM|timed?\s?out)\b|"(?:error|status)":\s*(?:4\d{2}|5\d{2})\b/i;

function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name);
}

/** Check if all tool calls in a round are read-only (for testing). */
export function allToolCallsReadOnly(
  toolCalls: Array<{ function: { name: string } }>,
): boolean {
  return toolCalls.every((tc) => isReadOnlyTool(tc.function.name));
}

/** Check if all tool results contain error indicators (for testing). */
export function allResultsAreErrors(
  results: Array<{ content: string | unknown }>,
): boolean {
  return results.every(
    (r) => typeof r.content === "string" && ERROR_RESULT_RE.test(r.content),
  );
}

// ---------------------------------------------------------------------------
// Turn-scoped signal cleanup (Hermes v0.5 pattern)
// ---------------------------------------------------------------------------

/** Prefixes of user messages that are turn-scoped signals — useful for one
 *  round but harmful when replayed in subsequent turns. */
const STALE_SIGNAL_PREFIXES = [
  "ALTO: Respondiste sin llamar herramientas",
  "SYSTEM: Multiple consecutive tool failures",
];

/**
 * Remove stale turn-scoped signals from conversation in-place.
 * Called at the top of each inferWithTools round to prevent
 * nudges from leaking into subsequent LLM calls.
 */
export function stripStaleSignals(messages: ChatMessage[]): number {
  let removed = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (
      m.role === "user" &&
      typeof m.content === "string" &&
      STALE_SIGNAL_PREFIXES.some((p) => (m.content as string).startsWith(p))
    ) {
      messages.splice(i, 1);
      removed++;
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Think-block handling (Hermes v0.5 pattern)
// ---------------------------------------------------------------------------

/** Matches reasoning/thinking XML blocks emitted by models with extended thinking. */
const THINK_BLOCK_RE =
  /<(?:think|thinking|reasoning|REASONING_SCRATCHPAD)>[\s\S]*?<\/(?:think|thinking|reasoning|REASONING_SCRATCHPAD)>/gi;

/**
 * Strip reasoning/thinking blocks from LLM content.
 * Returns the content with think blocks removed, trimmed.
 */
export function stripThinkBlocks(content: string): string {
  return content.replace(THINK_BLOCK_RE, "").trim();
}

// ---------------------------------------------------------------------------

/**
 * Attempt lenient parse of malformed JSON from LLM tool calls.
 * Tries common repairs: trailing commas, trailing garbage, unquoted keys.
 * Returns parsed object on success, null on failure. Logs repairs.
 */
export function tryRepairJson(
  raw: string,
  toolName: string,
): Record<string, unknown> | null {
  let cleaned = raw;

  // Fix 1: trailing commas before } or ]
  cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");
  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed === "object" && parsed !== null) {
      console.log(
        `[inference] Repaired JSON for ${toolName}: removed trailing commas`,
      );
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* next */
  }

  // Fix 2: trailing garbage after last }
  const lastBrace = cleaned.lastIndexOf("}");
  if (lastBrace > 0) {
    try {
      const parsed = JSON.parse(cleaned.slice(0, lastBrace + 1));
      if (typeof parsed === "object" && parsed !== null) {
        console.log(
          `[inference] Repaired JSON for ${toolName}: truncated trailing garbage`,
        );
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* next */
    }
  }

  // Fix 3: unquoted keys
  const quoted = cleaned.replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":');
  try {
    const parsed = JSON.parse(quoted);
    if (typeof parsed === "object" && parsed !== null) {
      console.log(
        `[inference] Repaired JSON for ${toolName}: quoted bare keys`,
      );
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* all failed */
  }

  return null;
}

/**
 * Normalize common parameter name aliases in-place.
 * LLMs frequently use camelCase or prefixed variants of snake_case params.
 * Only copies if the canonical name is missing — never overwrites.
 */
const ARG_ALIASES: Record<string, string> = {
  file_path: "path",
  filepath: "path",
  oldString: "old_string",
  newString: "new_string",
  replaceAll: "replace_all",
  postId: "post_id",
  post_ID: "post_id",
  contentFile: "content_file",
  imageUrl: "image_url",
  altText: "alt_text",
  fileName: "filename",
  file_name: "filename",
};

function normalizeArgAliases(args: Record<string, unknown>): void {
  for (const [alias, canonical] of Object.entries(ARG_ALIASES)) {
    if (args[alias] !== undefined && args[canonical] === undefined) {
      args[canonical] = args[alias];
      delete args[alias];
    }
  }
}

/**
 * Build a condensed conversation for wrap-up calls.
 * Keeps system + first user message + last few tool exchanges (truncated) + wrap-up instruction.
 */
function buildWrapUpContext(
  conversation: ChatMessage[],
  instruction: string,
): ChatMessage[] {
  const system = conversation.find((m) => m.role === "system");

  // Find the LAST user message before tool calls started — this is the actual
  // current question. In chat tasks, firstUser may be from thread history and
  // completely unrelated to the current request.
  let lastUserBeforeTools: ChatMessage | undefined;
  for (let i = conversation.length - 1; i >= 0; i--) {
    if (
      conversation[i].role === "user" &&
      typeof conversation[i].content === "string"
    ) {
      lastUserBeforeTools = conversation[i];
      break;
    }
  }
  // Fallback to first user message if no user message found (shouldn't happen)
  if (!lastUserBeforeTools) {
    lastUserBeforeTools = conversation.find((m) => m.role === "user");
  }

  // Take last 6 messages (3 tool exchanges) and aggressively truncate tool results
  const recentMessages = conversation.slice(-6).map((m) => {
    if (
      m.role === "tool" &&
      typeof m.content === "string" &&
      m.content.length > WRAPUP_TOOL_RESULT_CHARS
    ) {
      return {
        ...m,
        content:
          m.content.slice(0, WRAPUP_TOOL_RESULT_CHARS) +
          "\n...(truncated for wrap-up)",
      };
    }
    return m;
  });

  const condensed: ChatMessage[] = [];
  if (system) condensed.push(system);
  if (lastUserBeforeTools) condensed.push(lastUserBeforeTools);
  condensed.push(...recentMessages);
  condensed.push({ role: "user", content: instruction });
  return condensed;
}

export interface InferWithToolsOptions {
  maxRounds?: number;
  onTextChunk?: OnTextChunk;
  signal?: AbortSignal;
  providerName?: string;
  /**
   * Per-round prompt token ceiling. If any single round's prompt_tokens
   * exceeds this, the loop wraps up before the next round. This prevents
   * individual requests from hitting the DashScope ~30K token ceiling.
   *
   * Note: this checks the LAST round's prompt_tokens, not the cumulative
   * total, because prompt_tokens includes the full conversation each time
   * (system prompt + history are repeated every round).
   */
  tokenBudget?: number;
  /**
   * Context injected into compression summaries when context compression fires.
   * Use to preserve critical state (e.g. active goal description) across compressions.
   * Keeps the compressor generic — callers define what matters.
   */
  compressionContext?: string;
}

export async function inferWithTools(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  executor: ToolExecutor,
  options?: InferWithToolsOptions,
): Promise<{
  content: string;
  messages: ChatMessage[];
  totalUsage: { prompt_tokens: number; completion_tokens: number };
  toolRepairs: Array<{ original: string; repaired: string }>;
}> {
  const maxRounds = options?.maxRounds ?? 10;
  const onTextChunk = options?.onTextChunk;
  const signal = options?.signal;
  const providerName = options?.providerName;
  const tokenBudget = options?.tokenBudget ?? Infinity;
  const toolRepairs: Array<{ original: string; repaired: string }> = [];

  let conversation = [...messages];
  let totalPrompt = 0;
  let totalCompletion = 0;
  let exitReason = "max_rounds";
  let has413Retried = false;
  let lastToolSig = "";
  let consecutiveRepeats = 0;
  let consecutiveSmallResults = 0;
  let consecutiveReadOnlyRounds = 0;
  let consecutiveErrorRounds = 0;

  // Track which tools have been called across rounds, so the analysis
  // paralysis guard can distinguish "gathering data before acting" from
  // "endlessly exploring without acting".
  const calledToolNames = new Set<string>();
  const availableNonReadOnly = new Set(
    tools.map((t) => t.function.name).filter((n) => !READ_ONLY_TOOLS.has(n)),
  );

  for (let round = 0; round < maxRounds; round++) {
    // Strip stale turn-scoped signals before the next LLM call.
    // Nudges and advisories from prior rounds should not leak into replay.
    if (round > 0) stripStaleSignals(conversation);

    // Compress context if approaching limit
    const config = getConfig();
    if (
      shouldCompress(
        conversation,
        config.inferenceContextLimit,
        config.compressionThreshold,
      )
    ) {
      console.log(
        `[inference] Context compression triggered at round ${round} (${conversation.length} messages)`,
      );
      conversation = await compress(
        conversation,
        3,
        4,
        options?.compressionContext,
      );
    }

    // Check abort before each round
    if (signal?.aborted) {
      const lastContent = [...conversation]
        .reverse()
        .find((m) => m.role === "assistant" && typeof m.content === "string");
      return {
        content:
          (typeof lastContent?.content === "string"
            ? lastContent.content
            : null) ?? "[aborted]",
        messages: conversation,
        totalUsage: {
          prompt_tokens: totalPrompt,
          completion_tokens: totalCompletion,
        },
        toolRepairs,
      };
    }

    let response: InferenceResponse;
    try {
      response = await infer(
        { messages: conversation, tools },
        onTextChunk,
        signal,
        providerName,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      // 413 auto-compression: force-compress and retry once
      if (errMsg.includes("413") && !has413Retried) {
        has413Retried = true;
        console.log(
          `[inference] 413 payload too large at round ${round}, force-compressing`,
        );
        conversation = await compress(
          conversation,
          3,
          4,
          options?.compressionContext,
        );
        continue;
      }

      // Mid-loop inference failure — attempt toolless wrap-up instead of crashing
      console.log(
        `[inference] Round ${round + 1}/${maxRounds} failed, attempting wrap-up: ${errMsg}`,
      );
      try {
        // Collect tools called so far for honest wrap-up
        const midLoopTools = new Set<string>();
        for (const msg of conversation) {
          if (msg.role === "assistant" && msg.tool_calls) {
            for (const tc of msg.tool_calls) {
              midLoopTools.add(tc.function.name);
            }
          }
        }
        const midToolList =
          midLoopTools.size > 0 ? [...midLoopTools].join(", ") : "NINGUNA";

        const leanContext = buildWrapUpContext(
          conversation,
          `The system encountered an error continuing tool execution. Tools you called before the error: [${midToolList}]. Do NOT claim success for any action whose tool is NOT in that list. Provide your final response based ONLY on actual tool results. End with: STATUS: DONE_WITH_CONCERNS — [brief note on what went wrong]`,
        );
        const wrapUp = await infer(
          { messages: leanContext },
          onTextChunk,
          signal,
        );
        totalPrompt += wrapUp.usage.prompt_tokens;
        totalCompletion += wrapUp.usage.completion_tokens;
        const content = wrapUp.content ?? "[inference failed mid-loop]";
        conversation.push({ role: "assistant", content });
        return {
          content,
          messages: conversation,
          totalUsage: {
            prompt_tokens: totalPrompt,
            completion_tokens: totalCompletion,
          },
          toolRepairs,
        };
      } catch {
        // Wrap-up also failed — propagate original error
        throw err;
      }
    }
    totalPrompt += response.usage.prompt_tokens;
    totalCompletion += response.usage.completion_tokens;

    // No tool calls — check for think-block exhaustion, then tool-skip guard.
    if (!response.tool_calls || response.tool_calls.length === 0) {
      const content = response.content ?? "";

      // Think-block exhaustion: if the model spent all output on reasoning
      // with no actionable content, retrying is useless. Force wrap-up.
      const stripped = stripThinkBlocks(content);
      if (
        stripped.length === 0 &&
        content.length > 0 &&
        tools.length > 0 &&
        round > 0
      ) {
        console.warn(
          `[inference] Think-block exhaustion at round ${round}: all output consumed by reasoning. Forcing wrap-up.`,
        );
        exitReason = "think_exhaustion";
        break;
      }

      // First-round tool-skip guard: if the LLM claims success (✅) without
      // calling ANY tools on the very first round, it's lazily responding from
      // conversation context instead of executing. Nudge it to use tools.
      // Only fires once (round === 0) to avoid infinite loops.
      // Skip for short replies (<500 chars) — those are genuine conversational
      // responses that don't need tool execution.
      if (
        round === 0 &&
        tools.length > 0 &&
        content.includes("✅") &&
        content.length > 500
      ) {
        console.log(
          "[inference] First-round tool skip detected (✅ without tool calls). Nudging.",
        );
        // Don't add the LLM's planning text — it wastes tokens in all
        // subsequent rounds. Just inject the correction as a user message.
        conversation.push({
          role: "user",
          content:
            "ALTO: Respondiste sin llamar herramientas. EJECUTA con tool calls AHORA.",
        });
        continue;
      }

      // Return with think blocks stripped from content (raw stays in conversation)
      conversation.push({ role: "assistant", content });
      return {
        content: stripped || content,
        messages: conversation,
        totalUsage: {
          prompt_tokens: totalPrompt,
          completion_tokens: totalCompletion,
        },
        toolRepairs,
      };
    }

    // Append assistant message with tool calls.
    // Strip narration text — only tool_calls matter for the loop.
    // The LLM often generates verbose reasoning alongside tool calls
    // (1000-2000 tokens), which inflates every subsequent round's prompt.
    conversation.push({
      role: "assistant",
      content: null,
      tool_calls: response.tool_calls,
    });

    // Execute tool calls in parallel
    const toolResults = await Promise.all(
      response.tool_calls.map(async (toolCall) => {
        let result: string;
        try {
          const rawArgs = toolCall.function.arguments;
          // Detect truncation: unclosed braces/brackets
          const opens = (rawArgs.match(/[{[]/g) || []).length;
          const closes = (rawArgs.match(/[}\]]/g) || []).length;
          if (opens > closes) {
            result = JSON.stringify({
              error:
                "Tool call truncated (max_tokens hit). For large content, write it to a file first with file_write, then pass the file path.",
            });
            console.warn(
              `[inference] Tool ${toolCall.function.name} args truncated (${rawArgs.length} chars)`,
            );
            // Sanitize the truncated args in conversation history so the
            // malformed JSON doesn't cause HTTP 400 on subsequent rounds.
            // response.tool_calls was pushed by reference, so mutating here
            // fixes the conversation array too.
            toolCall.function.arguments = JSON.stringify({
              _truncated: true,
              _original_length: rawArgs.length,
            });
          } else {
            let args: Record<string, unknown>;
            try {
              args = JSON.parse(rawArgs) as Record<string, unknown>;
            } catch {
              const repaired = tryRepairJson(rawArgs, toolCall.function.name);
              if (repaired) {
                args = repaired;
              } else {
                throw new Error(
                  `Invalid JSON in tool arguments: ${rawArgs.slice(0, 200)}`,
                );
              }
            }
            // Attempt tool call repair if name not in registry
            let toolName = toolCall.function.name;
            if (!toolRegistry.has(toolName)) {
              const closest = toolRegistry.findClosest(toolName);
              if (closest) {
                console.log(
                  `[inference] Tool call repaired: "${toolName}" → "${closest}"`,
                );
                toolRepairs.push({ original: toolName, repaired: closest });
                toolName = closest;
                // Update the tool_call object so downstream code (hallucination
                // detector, tools_used tracking) sees the correct name.
                toolCall.function.name = closest;
              }
            }
            // Normalize common parameter aliases before validation.
            // LLMs frequently confuse "path" vs "file_path" vs "filepath",
            // "old_string" vs "oldString", etc.
            normalizeArgAliases(args);

            // Validate args against tool schema before execution
            const validation = toolRegistry.validate(toolName, args);
            if (!validation.success) {
              console.warn(
                `[inference] Tool ${toolName} args validation failed: ${validation.error}`,
              );
              result = JSON.stringify({
                error: `Invalid arguments for ${toolName}: ${validation.error}`,
                hint: "Fix the argument values and try again.",
              });
            } else {
              result = await executor(toolName, args);
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result = JSON.stringify({ error: message });
          console.error(
            `[inference] Tool ${toolCall.function.name} failed: ${message}`,
          );
          // Sanitize malformed args so conversation history stays valid JSON.
          // Without this, providers reject the entire thread with HTTP 400.
          try {
            JSON.parse(toolCall.function.arguments);
          } catch {
            toolCall.function.arguments = JSON.stringify({
              _error: "malformed_args",
            });
          }
        }
        // Large result eviction: write oversized results to temp file,
        // return head + tail preview with file path reference so the LLM
        // can read specific sections with file_read if needed.
        if (result.length > MAX_TOOL_RESULT_CHARS) {
          const previewHead = result.slice(
            0,
            Math.floor(MAX_TOOL_RESULT_CHARS * 0.7),
          );
          const previewTail = result.slice(
            -Math.floor(MAX_TOOL_RESULT_CHARS * 0.2),
          );
          result = `${previewHead}\n\n... (${result.length} chars total — middle section omitted) ...\n\n${previewTail}`;
        }
        return {
          role: "tool" as const,
          content: result,
          tool_call_id: toolCall.id,
        };
      }),
    );
    conversation.push(...toolResults);

    // Loop detection: break if the same tool calls repeat consecutively
    // Track all tools called across rounds for the paralysis guard
    for (const tc of response.tool_calls) {
      calledToolNames.add(tc.function.name);
    }

    const currentToolSig = response.tool_calls
      .map((tc) => `${tc.function.name}:${tc.function.arguments}`)
      .sort()
      .join("|");
    if (currentToolSig === lastToolSig) {
      consecutiveRepeats++;
      if (consecutiveRepeats >= MAX_CONSECUTIVE_REPEATS) {
        console.warn(
          `[inference] Loop detected: identical tool calls repeated ${consecutiveRepeats + 1}x`,
        );
        exitReason = "loop_detected";
        break;
      }
    } else {
      consecutiveRepeats = 0;
    }
    lastToolSig = currentToolSig;

    // Stale-loop detection: if all tool results in this round are small
    // error-sized responses (< 300 chars each), count consecutive error rounds.
    // The LLM may be trying different args (so tool sig differs) but getting
    // the same error every time (e.g., 404s on sequential IDs).
    const allResultsSmall = toolResults.every(
      (r) => typeof r.content === "string" && r.content.length < 300,
    );
    if (allResultsSmall && response.tool_calls.length === 1) {
      consecutiveSmallResults += 1;
      if (consecutiveSmallResults >= STALE_LOOP_THRESHOLD) {
        console.warn(
          `[inference] Stale loop detected: ${consecutiveSmallResults} consecutive rounds with small/error tool results. Breaking.`,
        );
        exitReason = "stale_loop";
        break;
      }
    } else {
      consecutiveSmallResults = 0;
    }

    // Analysis paralysis: all tool calls are read-only for N consecutive rounds.
    // Catches LLM endlessly exploring without acting (different tool sigs each round,
    // large results — so repeat detector and stale-loop breaker both miss it).
    //
    // Exception: if non-read-only tools are available but haven't been called yet,
    // the LLM is still gathering data before acting — not stuck. Skip the counter.
    if (
      response.tool_calls.length > 0 &&
      allToolCallsReadOnly(response.tool_calls)
    ) {
      const hasUncalledActionTools =
        availableNonReadOnly.size > 0 &&
        [...availableNonReadOnly].some((t) => !calledToolNames.has(t));
      if (!hasUncalledActionTools) {
        consecutiveReadOnlyRounds++;
      }
      if (consecutiveReadOnlyRounds >= ANALYSIS_PARALYSIS_THRESHOLD) {
        console.warn(
          `[inference] Analysis paralysis: ${consecutiveReadOnlyRounds} consecutive read-only rounds. Breaking.`,
        );
        exitReason = "analysis_paralysis";
        break;
      }
    } else {
      consecutiveReadOnlyRounds = 0;
    }

    // Persistent failure: all tool results contain error indicators for N rounds.
    // Catches retry loops with large errors (>300 chars) that bypass the stale-loop
    // breaker, and multi-tool rounds where every tool fails.
    // Advisory only — don't break, let the LLM pivot.
    if (toolResults.length > 0 && allResultsAreErrors(toolResults)) {
      consecutiveErrorRounds++;
      if (consecutiveErrorRounds >= PERSISTENT_FAILURE_THRESHOLD) {
        console.warn(
          `[inference] Persistent failure: ${consecutiveErrorRounds} consecutive all-error rounds. Injecting advisory.`,
        );
        conversation.push({
          role: "user" as const,
          content:
            "SYSTEM: Multiple consecutive tool failures detected. Your current approach is not working. Try a completely different approach, use different tools, or proceed with what you have and report what you could not accomplish.",
        });
        consecutiveErrorRounds = 0;
      }
    } else {
      consecutiveErrorRounds = 0;
    }

    // Token budget check — if this round's prompt exceeded the ceiling,
    // the next round will be even larger (more tool results). Wrap up now.
    if (response.usage.prompt_tokens >= tokenBudget) {
      exitReason = "token_budget";
      console.log(
        `[inference] Token budget exceeded (round prompt=${response.usage.prompt_tokens} >= ${tokenBudget}), forcing wrap-up`,
      );
      break;
    }
  }

  // Force one final toolless call to synthesize results
  console.log(
    `[inference] Wrap-up triggered: ${exitReason} (totalTokens=${totalPrompt + totalCompletion}${tokenBudget < Infinity ? `, ceiling=${tokenBudget}` : ""})`,
  );
  try {
    // Collect tools actually called so the LLM knows what it did vs didn't do
    const wrapUpToolNames = new Set<string>();
    for (const msg of conversation) {
      if (msg.role === "assistant" && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          wrapUpToolNames.add(tc.function.name);
        }
      }
    }
    const toolInventory =
      wrapUpToolNames.size > 0
        ? [...wrapUpToolNames].join(", ")
        : "NINGUNA — no llamaste ninguna herramienta";

    const leanContext = buildWrapUpContext(
      conversation,
      `You have used all available tool rounds.

CRITICAL: You ONLY called these tools: [${toolInventory}]. Do NOT claim to have performed any action whose tool is NOT in that list. If the user asked you to write/update/create/send/delete something but you did NOT call the corresponding tool (gsheets_write, wp_publish, gmail_send, file_write, etc.), you MUST say: "No alcancé a ejecutar [acción] — se agotaron las rondas de herramientas."

Provide your final response based ONLY on actual tool results. Do not request any more tools. End with: STATUS: DONE_WITH_CONCERNS — [what was incomplete]`,
    );
    const wrapUp = await infer({ messages: leanContext }, onTextChunk, signal);
    totalPrompt += wrapUp.usage.prompt_tokens;
    totalCompletion += wrapUp.usage.completion_tokens;
    const content = wrapUp.content ?? "[max tool rounds reached]";
    conversation.push({ role: "assistant", content });
    return {
      content,
      messages: conversation,
      totalUsage: {
        prompt_tokens: totalPrompt,
        completion_tokens: totalCompletion,
      },
      toolRepairs,
    };
  } catch {
    // Wrap-up call failed — fall back to last assistant content
    const lastAssistant = [...conversation]
      .reverse()
      .find((m) => m.role === "assistant");
    return {
      content:
        (typeof lastAssistant?.content === "string"
          ? lastAssistant.content
          : null) ?? "[max tool rounds reached]",
      messages: conversation,
      totalUsage: {
        prompt_tokens: totalPrompt,
        completion_tokens: totalCompletion,
      },
      toolRepairs,
    };
  }
}
