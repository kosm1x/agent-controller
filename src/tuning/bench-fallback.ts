/**
 * Fireworks fallback benchmark — pure logic (no database, no env, no files).
 *
 * The CLI (`scripts/bench-fireworks-fallback.ts`) measures which Fireworks
 * serverless model should back the OpenAI-compatible `fallback` provider
 * (`INFERENCE_FALLBACK_*`) that runs when both Claude Agent SDK legs fail.
 * Everything here is deterministic or goes through an injected `fetch`:
 * catalog filter, candidate normalisation, per-case tool scoping (the eval
 * gate's exact call), request shaping, per-call records, scoring (the eval
 * gate's `scoreToolSelection`), ranking, pricing and report rendering.
 *
 * Probe system prompt: the eval gate's DEFAULT probe sends NO system message
 * (`SandboxConfig.probeSystemPrompt` is set only by `--probe-system=jarvis`),
 * so the bench sends none either — the tool-case messages are the gate's:
 * the case's conversation history, then the user message.
 *
 * The API key travels only inside `BenchConfig.apiKey` and the request
 * headers. Every recorded error string is redacted, and both renderers strip
 * the key again before returning (defence in depth).
 */

import type { ToolDefinition } from "../inference/adapter.js";
import type { TestCaseExpected, TestCaseInput } from "./types.js";
import { scoreToolSelection } from "./scorer.js";
import {
  scopeToolsForMessage,
  CODE_SCOPE_PATTERNS,
} from "../messaging/scope.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const FIREWORKS_INFERENCE_URL = "https://api.fireworks.ai/inference/v1";
export const FIREWORKS_CATALOG_URL =
  "https://api.fireworks.ai/v1/accounts/fireworks/models";
export const FIREWORKS_MODEL_PREFIX = "accounts/fireworks/models/";

export const DEFAULT_CANDIDATES: readonly string[] = [
  "minimax-m3",
  "minimax-m3p1-flash",
  "glm-5p3-flash",
  "glm-5p3",
  "deepseek-v4p1-flash",
  "kimi-k3",
  "qwen3p8-max",
  "gpt-oss-120b",
];

/** USD per 1M tokens, used when the catalog price is not parseable. */
export const BUILTIN_PRICES: Readonly<Record<string, Price>> = {
  "minimax-m3": { in: 0.3, out: 1.2 },
  "minimax-m3p1-flash": { in: 0.15, out: 0.6 },
  "glm-5p3-flash": { in: 0.15, out: 0.5 },
  "glm-5p3": { in: 1.4, out: 4.4 },
  "deepseek-v4p1-flash": { in: 0.3, out: 1.2 },
  "kimi-k3": { in: 3.0, out: 15.0 },
  "qwen3p8-max": { in: 2.0, out: 6.0 },
  "gpt-oss-120b": { in: 0.15, out: 0.6 },
  "ember-1": { in: 3.0, out: 15.0 },
};

export const CONCURRENCY = 2;
export const REQUEST_TIMEOUT_MS = 90_000;
export const RETRY_DELAY_MS = 2_000;
export const MAX_TOKENS = 1024;
/** Unranked when more than this share of a model's calls errored. */
export const MAX_ERROR_RATE = 0.2;
/** Dry-run estimate only: assumed completion tokens per call. */
export const EST_COMPLETION_TOKENS = 200;
const MAX_BODY_SNIPPET = 200;
/** How these numbers differ from the eval gate's (not directly comparable). */
export const GATE_COMPARABILITY =
  "probe rounds 1 (gate default 3); unweighted mean (gate weights by case weight)";
const MAX_CATALOG_PAGES = 20;

/** No tools offered: latency, finish_reason and thinking leakage. */
export const CHAT_PROMPTS: readonly { id: string; input: string }[] = [
  {
    id: "chat-01",
    input: "Resume en tres líneas qué es un presupuesto base cero.",
  },
  {
    id: "chat-02",
    input:
      "Redacta un mensaje breve y cordial para reprogramar una reunión del martes al jueves.",
  },
  {
    id: "chat-03",
    input: "Explica la diferencia entre margen bruto y margen neto con un ejemplo.",
  },
  {
    id: "chat-04",
    input:
      "Dame tres ideas concretas para mejorar la tasa de respuesta de una campaña de correo.",
  },
  {
    id: "chat-05",
    input: "¿Qué es una tasa de interés compuesta? Responde en un párrafo.",
  },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Price {
  in: number;
  out: number;
}

export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface FetchResponseLike {
  status: number;
  ok: boolean;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: FetchInit,
) => Promise<FetchResponseLike>;

export interface BenchArgs {
  run: boolean;
  models?: string[];
  cases?: number;
  out?: string;
  reasoningEffort?: string;
}

export interface CatalogSku {
  sku?: string;
  amount?: unknown;
  unit?: string;
}

export interface ServerlessMode {
  skuInfos?: CatalogSku[];
  usageIdentifier?: string;
  serviceTier?: string;
}

export interface CatalogModel {
  name: string;
  displayName?: string;
  supportsServerless?: boolean;
  supportsTools?: boolean;
  contextLength?: number;
  deprecationDate?: unknown;
  state?: string;
  serverlessModes?: ServerlessMode[];
}

export interface CatalogRow {
  id: string;
  contextLength: number | null;
  deprecation: string | null;
  price: Price | null;
  usageIdentifier: string | null;
}

export interface SeedCase {
  case_id: string;
  category: string;
  input: TestCaseInput;
  expected: TestCaseExpected;
}

/** A tool_selection case after the gate's per-message scoping. */
export interface ScopedCase {
  caseId: string;
  input: TestCaseInput;
  expected: TestCaseExpected;
  tools: ToolDefinition[];
}

export interface DefinitionSource {
  getDefinitions(names?: string[]): ToolDefinition[];
}

export interface CallRecord {
  model: string;
  caseId: string;
  kind: "tool" | "chat";
  latencyMs: number;
  httpStatus: number | null;
  errorClass: string | null;
  error: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  finishReason: string | null;
  toolCalls: string[];
  argsParseOk: boolean[];
  reasoningContent: boolean;
  thinkInContent: boolean;
  /** Tool cases only: the gate scorer's 0..1 score (an error scores 0). */
  score?: number;
}

export interface ModelScore {
  model: string;
  scoredCases: number;
  accuracy: number;
  toolCallValidity: number | null;
  p50ToolMs: number | null;
  p95ToolMs: number | null;
  p50ChatMs: number | null;
  p95ChatMs: number | null;
  thinkingLeaks: number;
  reasoningContentCalls: number;
  errors: number;
  calls: number;
  http404or401: boolean;
  price: Price | null;
  priceSource: "catalog" | "builtin" | "n/a";
  costUsd: number | null;
  unrankedReason: string | null;
  /** Set when the run used the catalog `usageIdentifier` (name path 404'd). */
  routedVia: string | null;
}

export interface DroppedModel {
  model: string;
  stage: "catalog" | "probe";
  reason: string;
}

export interface BenchConfig {
  apiKey: string;
  models: string[];
  reasoningEffort?: string;
  date: string;
  toolCount: number;
  toolSources: { registered: string[]; skipped: string[] };
}

export interface BenchResult {
  config: Omit<BenchConfig, "apiKey"> & {
    caseCount: number;
    unreachableCases: string[];
    chatPrompts: number;
    concurrency: number;
    maxTokens: number;
    temperature: number;
    systemPrompt: string;
    gateComparability: string;
    perCaseToolCount: ToolCountRange;
  };
  catalog: { loaded: boolean; warning: string | null; rows: CatalogRow[] };
  dropped: DroppedModel[];
  scores: ModelScore[];
  ranking: string[];
  recommended: string | null;
  records: CallRecord[];
}

export interface ToolCountRange {
  min: number;
  median: number;
  max: number;
}

export type BenchOutcome =
  | { kind: "bad_key"; message: string }
  | { kind: "all_dropped"; result: BenchResult }
  | { kind: "complete"; result: BenchResult };

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

export function parseBenchArgs(
  argv: string[],
): { ok: true; args: BenchArgs } | { ok: false; error: string } {
  const args: BenchArgs = { run: false };
  for (const a of argv) {
    if (a === "--run") {
      args.run = true;
    } else if (a.startsWith("--models=")) {
      const list = a
        .slice("--models=".length)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (list.length === 0) return { ok: false, error: "--models is empty" };
      args.models = [...new Set(list.map(normalizeModelId))];
    } else if (a.startsWith("--cases=")) {
      const raw = a.slice("--cases=".length);
      const n = Number(raw);
      if (!/^\d+$/.test(raw) || n < 1) {
        return { ok: false, error: `--cases takes a positive integer (got "${raw}")` };
      }
      args.cases = n;
    } else if (a.startsWith("--out=")) {
      const out = a.slice("--out=".length);
      if (!out.endsWith(".md")) {
        return { ok: false, error: `--out must end in .md (got "${out}")` };
      }
      args.out = out;
    } else if (a.startsWith("--reasoning-effort=")) {
      const v = a.slice("--reasoning-effort=".length);
      if (!["none", "low", "medium", "high"].includes(v)) {
        return {
          ok: false,
          error: `--reasoning-effort takes none|low|medium|high (got "${v}")`,
        };
      }
      args.reasoningEffort = v;
    } else {
      return { ok: false, error: `unknown argument "${a}"` };
    }
  }
  return { ok: true, args };
}

// ---------------------------------------------------------------------------
// Model ids + catalog
// ---------------------------------------------------------------------------

/** Bare id for Fireworks' own models; other accounts keep their full path. */
export function normalizeModelId(raw: string): string {
  const s = raw.trim();
  return s.startsWith(FIREWORKS_MODEL_PREFIX)
    ? s.slice(FIREWORKS_MODEL_PREFIX.length)
    : s;
}

export function toModelPath(id: string): string {
  return id.startsWith("accounts/") ? id : `${FIREWORKS_MODEL_PREFIX}${id}`;
}

/** ISO date string (or `{year,month,day}`) → YYYY-MM-DD, else null. */
export function deprecationOf(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value.slice(0, 10);
  if (value && typeof value === "object") {
    const { year, month, day } = value as Record<string, unknown>;
    if (typeof year === "number" && year > 0) {
      const mm = String(typeof month === "number" ? month : 1).padStart(2, "0");
      const dd = String(typeof day === "number" ? day : 1).padStart(2, "0");
      return `${year}-${mm}-${dd}`;
    }
  }
  return null;
}

/** Serverless + tools + no deprecation date on or before `today`. */
export function filterCatalog(
  models: CatalogModel[],
  today: string,
): CatalogModel[] {
  return models.filter((m) => {
    if (m.supportsServerless !== true || m.supportsTools !== true) return false;
    const dep = deprecationOf(m.deprecationDate);
    return dep === null || dep > today;
  });
}

/**
 * A sku amount: Google `typeMoney` `{currencyCode, units: "<int64 string>",
 * nanos: <int32>}` (the documented catalog shape) = units + nanos / 1e9, or a
 * plain number / numeric string. Anything else is null.
 */
function amountOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v < 0 ? null : v;
  if (typeof v === "string" && /^\s*\$?\d+(\.\d+)?\s*$/.test(v)) {
    return Number(v.replace("$", ""));
  }
  if (v && typeof v === "object") {
    const { units, nanos } = v as Record<string, unknown>;
    if (units === undefined && nanos === undefined) return null;
    const u =
      units === undefined
        ? 0
        : (typeof units === "string" && /^-?\d+$/.test(units)) ||
            (typeof units === "number" && Number.isInteger(units))
          ? Number(units)
          : null;
    const n =
      nanos === undefined
        ? 0
        : typeof nanos === "number" && Number.isInteger(nanos)
          ? nanos
          : null;
    if (u === null || n === null || Math.abs(n) >= 1e9) return null;
    const total = u + n / 1e9;
    return total < 0 ? null : total;
  }
  return null;
}

/** Multiplier from the sku unit to "per 1M tokens", null when unknown. */
function perMillionFactor(unit: string | undefined): number | null {
  const u = (unit ?? "").toLowerCase().replace(/\s+/g, "");
  if (!u.includes("token")) return null;
  if (/(1m|million|1000000|1,000,000)/.test(u)) return 1;
  if (/(1k|thousand|1000)/.test(u)) return 1_000;
  return 1_000_000; // per token
}

/**
 * The ONE serverless mode a model's price and usageIdentifier are read from:
 * the mode whose usageIdentifier is the name path, else a standard tier
 * (`serviceTier` empty or "standard"), else the first. A priority/fast tier
 * is never picked while a standard one exists.
 */
export function pickServerlessMode(model: CatalogModel): ServerlessMode | null {
  const modes = model.serverlessModes ?? [];
  return (
    modes.find(
      (m) => typeof m.usageIdentifier === "string" && toModelPath(m.usageIdentifier) === model.name,
    ) ??
    modes.find((m) => !m.serviceTier || m.serviceTier.toLowerCase() === "standard") ??
    modes[0] ??
    null
  );
}

/** $/1M in/out from the picked mode's `skuInfos[]`, null when not parseable. */
export function parseSkuPrice(model: CatalogModel): Price | null {
  let pin: number | null = null;
  let pout: number | null = null;
  const mode = pickServerlessMode(model);
  if (mode) {
    for (const s of mode.skuInfos ?? []) {
      const amount = amountOf(s.amount);
      const factor = perMillionFactor(s.unit);
      if (amount === null || factor === null) continue;
      const sku = (s.sku ?? "").toLowerCase();
      const value = amount * factor;
      if (/(input|prompt)/.test(sku) && pin === null) pin = value;
      else if (/(output|completion|generated)/.test(sku) && pout === null)
        pout = value;
    }
  }
  return pin !== null && pout !== null ? { in: pin, out: pout } : null;
}

export function catalogRows(models: CatalogModel[]): CatalogRow[] {
  return models.map((m) => ({
    id: normalizeModelId(m.name),
    // Fireworks returns contextLength 0 for some live models: unknown, not a size.
    contextLength:
      typeof m.contextLength === "number" && Number.isInteger(m.contextLength) && m.contextLength > 0
        ? m.contextLength
        : null,
    deprecation: deprecationOf(m.deprecationDate),
    price: parseSkuPrice(m),
    usageIdentifier: pickServerlessMode(m)?.usageIdentifier ?? null,
  }));
}

export function priceFor(
  id: string,
  catalogPrices: ReadonlyMap<string, Price | null>,
): { price: Price | null; source: "catalog" | "builtin" | "n/a" } {
  const fromCatalog = catalogPrices.get(id);
  if (fromCatalog) return { price: fromCatalog, source: "catalog" };
  const builtin = BUILTIN_PRICES[id];
  if (builtin) return { price: builtin, source: "builtin" };
  return { price: null, source: "n/a" };
}

/** Candidates ∩ catalog (by full path); the rest are reported as dropped. */
export function intersectCandidates(
  candidates: string[],
  catalog: CatalogModel[] | null,
): { kept: string[]; dropped: DroppedModel[] } {
  if (catalog === null) return { kept: [...candidates], dropped: [] };
  const paths = new Set(catalog.map((m) => m.name));
  const kept: string[] = [];
  const dropped: DroppedModel[] = [];
  for (const id of candidates) {
    if (paths.has(toModelPath(id))) kept.push(id);
    else
      dropped.push({
        model: id,
        stage: "catalog",
        reason: "not in filtered catalog (serverless+tools, not deprecated)",
      });
  }
  return { kept, dropped };
}

// ---------------------------------------------------------------------------
// Cases + scoping (the eval gate's exact call)
// ---------------------------------------------------------------------------

/**
 * The tool_selection cases (first `limit`), each with the tools the eval gate
 * would offer it: `scopeToolsForMessage` with the same args as
 * `src/tuning/eval-runner.ts` evalToolSelection, then the registry's
 * definitions. A case with nothing checkable offered is unreachable.
 */
export function scopeCases(
  seed: SeedCase[],
  registry: DefinitionSource,
  limit?: number,
): { cases: ScopedCase[]; unreachable: string[] } {
  const selected = seed
    .filter((c) => c.category === "tool_selection")
    .slice(0, limit);
  const cases: ScopedCase[] = [];
  const unreachable: string[] = [];
  for (const c of selected) {
    const recent = (c.input.conversationHistory ?? [])
      .filter((t) => t.role === "user")
      .map((t) => t.content);
    const names = scopeToolsForMessage(
      c.input.message,
      recent,
      [...CODE_SCOPE_PATTERNS],
      { hasGoogle: true, hasWordpress: true, hasMemory: false, hasCrm: true },
    );
    const tools = registry.getDefinitions(names);
    const offered = new Set(tools.map((d) => d.function.name));
    if (scoreToolSelection(c.expected, [], offered).excluded) {
      unreachable.push(c.case_id);
      continue;
    }
    cases.push({
      caseId: c.case_id,
      input: c.input,
      expected: c.expected,
      tools,
    });
  }
  return { cases, unreachable };
}

export function toolCountRange(cases: ScopedCase[]): ToolCountRange {
  const counts = cases.map((c) => c.tools.length).sort((a, b) => a - b);
  if (counts.length === 0) return { min: 0, median: 0, max: 0 };
  const mid = Math.floor(counts.length / 2);
  const median =
    counts.length % 2 === 1 ? counts[mid] : (counts[mid - 1] + counts[mid]) / 2;
  return { min: counts[0], median, max: counts[counts.length - 1] };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface ChatBody {
  model: string;
  messages: Array<{ role: string; content: string }>;
  tools?: ToolDefinition[];
  tool_choice?: "auto";
  temperature: number;
  max_tokens: number;
  stream: false;
  reasoning_effort?: string;
}

/** OpenAI chat-completions body. `ToolDefinition` is already the OpenAI
 *  function-tool shape, sent unchanged as `adapter-openai.ts` does. */
export function buildChatBody(
  modelId: string,
  input: TestCaseInput,
  tools: ToolDefinition[],
  reasoningEffort?: string,
): ChatBody {
  const messages = [
    ...(input.conversationHistory ?? []).map((t) => ({
      role: t.role,
      content: t.content,
    })),
    { role: "user", content: input.message },
  ];
  return {
    model: toModelPath(modelId),
    messages,
    ...(tools.length > 0 && { tools, tool_choice: "auto" as const }),
    temperature: 0,
    max_tokens: MAX_TOKENS,
    stream: false,
    ...(reasoningEffort !== undefined && { reasoning_effort: reasoningEffort }),
  };
}

export function redact(text: string, apiKey: string): string {
  return apiKey.length > 0 ? text.split(apiKey).join("[REDACTED]") : text;
}

function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function errorClassOf(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return "timeout";
    return err.name === "Error" ? "network" : err.name;
  }
  return "network";
}

/** Message + `cause.code` (undici hides it behind "fetch failed"), redacted. */
function errorMessageOf(err: unknown, apiKey: string): string {
  let msg = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined;
  if (cause && typeof cause.code === "string") msg += ` (${cause.code})`;
  return redact(msg, apiKey).slice(0, MAX_BODY_SNIPPET);
}

interface ParsedChoice {
  promptTokens: number | null;
  completionTokens: number | null;
  finishReason: string | null;
  toolCalls: string[];
  argsParseOk: boolean[];
  reasoningContent: boolean;
  thinkInContent: boolean;
}

/** Leak signals + tool calls from a chat-completions JSON response. */
export function parseCompletion(json: unknown): ParsedChoice {
  const root = (json && typeof json === "object" ? json : {}) as Record<
    string,
    unknown
  >;
  const usage = (root.usage ?? {}) as Record<string, unknown>;
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const choice = (choices[0] ?? {}) as Record<string, unknown>;
  const message = (choice.message ?? {}) as Record<string, unknown>;
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls: string[] = [];
  const argsParseOk: boolean[] = [];
  for (const tc of rawCalls) {
    const fn = ((tc ?? {}) as Record<string, unknown>).function as
      | Record<string, unknown>
      | undefined;
    toolCalls.push(typeof fn?.name === "string" ? fn.name : "");
    let ok = false;
    if (typeof fn?.arguments === "string") {
      try {
        const parsed: unknown = JSON.parse(fn.arguments || "{}");
        ok = parsed !== null && typeof parsed === "object";
      } catch {
        ok = false;
      }
    }
    argsParseOk.push(ok);
  }
  const reasoning = message.reasoning_content;
  const content = typeof message.content === "string" ? message.content : "";
  return {
    promptTokens:
      typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null,
    completionTokens:
      typeof usage.completion_tokens === "number"
        ? usage.completion_tokens
        : null,
    finishReason:
      typeof choice.finish_reason === "string" ? choice.finish_reason : null,
    toolCalls,
    argsParseOk,
    reasoningContent: typeof reasoning === "string" && reasoning.length > 0,
    thinkInContent: /<think>/i.test(content),
  };
}

export interface CallDeps {
  fetch: FetchLike;
  apiKey: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const retryable = (status: number) => status === 429 || status >= 500;

type CallMeta = { model: string; caseId: string; kind: "tool" | "chat" };

function emptyRecord(meta: CallMeta): CallRecord {
  return {
    ...meta,
    latencyMs: 0,
    httpStatus: null,
    errorClass: null,
    error: null,
    promptTokens: null,
    completionTokens: null,
    finishReason: null,
    toolCalls: [],
    argsParseOk: [],
    reasoningContent: false,
    thinkInContent: false,
  };
}

/** One chat completion, one retry on 429/5xx after 2 s. Never throws. */
export async function callChat(
  deps: CallDeps,
  body: ChatBody,
  meta: { model: string; caseId: string; kind: "tool" | "chat" },
): Promise<CallRecord> {
  const base = emptyRecord(meta);
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = deps.now();
    try {
      const res = await deps.fetch(`${FIREWORKS_INFERENCE_URL}/chat/completions`, {
        method: "POST",
        headers: headers(deps.apiKey),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await res.text();
      const latencyMs = deps.now() - started;
      if (!res.ok) {
        if (attempt === 0 && retryable(res.status)) {
          await deps.sleep(RETRY_DELAY_MS);
          continue;
        }
        return {
          ...base,
          latencyMs,
          httpStatus: res.status,
          errorClass: `http_${res.status}`,
          error: redact(text, deps.apiKey).slice(0, MAX_BODY_SNIPPET),
        };
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return {
          ...base,
          latencyMs,
          httpStatus: res.status,
          errorClass: "bad_json",
          error: redact(text, deps.apiKey).slice(0, MAX_BODY_SNIPPET),
        };
      }
      return { ...base, ...parseCompletion(json), latencyMs, httpStatus: res.status };
    } catch (err) {
      return {
        ...base,
        latencyMs: deps.now() - started,
        errorClass: errorClassOf(err),
        error: errorMessageOf(err, deps.apiKey),
      };
    }
  }
  return base; // unreachable: the second attempt always returns
}

/** Deployment probe: `max_tokens: 1`; one retry on 429/5xx after 2 s. */
export async function probeModel(
  deps: CallDeps,
  modelId: string,
): Promise<{ status: number | null; error: string | null }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await deps.fetch(`${FIREWORKS_INFERENCE_URL}/chat/completions`, {
        method: "POST",
        headers: headers(deps.apiKey),
        body: JSON.stringify({
          model: toModelPath(modelId),
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          stream: false,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await res.text();
      if (!res.ok && attempt === 0 && retryable(res.status)) {
        await deps.sleep(RETRY_DELAY_MS);
        continue;
      }
      return {
        status: res.status,
        error: res.ok ? null : redact(text, deps.apiKey).slice(0, MAX_BODY_SNIPPET),
      };
    } catch (err) {
      return { status: null, error: errorMessageOf(err, deps.apiKey) };
    }
  }
}

/** All pages of the account's model list. Throws (redacted) on failure. */
export async function fetchCatalog(deps: CallDeps): Promise<CatalogModel[]> {
  const out: CatalogModel[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
    const url =
      `${FIREWORKS_CATALOG_URL}?pageSize=200` +
      (token ? `&pageToken=${encodeURIComponent(token)}` : "");
    let res: FetchResponseLike;
    try {
      res = await deps.fetch(url, {
        method: "GET",
        headers: headers(deps.apiKey),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`catalog request failed: ${errorMessageOf(err, deps.apiKey)}`);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `catalog HTTP ${res.status}: ${redact(text, deps.apiKey).slice(0, MAX_BODY_SNIPPET)}`,
      );
    }
    const json = JSON.parse(text) as { models?: CatalogModel[]; nextPageToken?: string };
    out.push(...(json.models ?? []));
    token = json.nextPageToken || undefined;
    if (!token) break;
  }
  return out;
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep order. */
export async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Scoring + ranking
// ---------------------------------------------------------------------------

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

/** Gate scorer on one tool case; an errored call scores 0. */
export function scoreCase(c: ScopedCase, rec: CallRecord): number {
  if (rec.errorClass !== null) return 0;
  const offered = new Set(c.tools.map((d) => d.function.name));
  return scoreToolSelection(c.expected, rec.toolCalls, offered).score;
}

export function scoreModel(
  model: string,
  records: CallRecord[],
  priceInfo: { price: Price | null; source: "catalog" | "builtin" | "n/a" },
  routedVia: string | null = null,
): ModelScore {
  const tool = records.filter((r) => r.kind === "tool");
  const chat = records.filter((r) => r.kind === "chat");
  const ok = (r: CallRecord) => r.errorClass === null;
  const scored = tool.filter((r) => r.score !== undefined);
  const accuracy =
    scored.length === 0
      ? 0
      : scored.reduce((s, r) => s + (r.score ?? 0), 0) / scored.length;
  const args = tool.flatMap((r) => r.argsParseOk);
  const errors = records.filter((r) => !ok(r)).length;
  const http404or401 = records.some(
    (r) => r.httpStatus === 404 || r.httpStatus === 401,
  );
  let costUsd: number | null = null;
  if (priceInfo.price) {
    const p = priceInfo.price;
    costUsd = records.reduce(
      (s, r) =>
        s + ((r.promptTokens ?? 0) * p.in + (r.completionTokens ?? 0) * p.out) / 1e6,
      0,
    );
  }
  const unrankedReason = http404or401
    ? "HTTP 404/401 during the run"
    : records.length > 0 && errors / records.length > MAX_ERROR_RATE
      ? `errors ${errors}/${records.length} > ${MAX_ERROR_RATE * 100}%`
      : null;
  return {
    model,
    scoredCases: scored.length,
    accuracy,
    toolCallValidity:
      args.length === 0 ? null : args.filter(Boolean).length / args.length,
    p50ToolMs: percentile(tool.filter(ok).map((r) => r.latencyMs), 50),
    p95ToolMs: percentile(tool.filter(ok).map((r) => r.latencyMs), 95),
    p50ChatMs: percentile(chat.filter(ok).map((r) => r.latencyMs), 50),
    p95ChatMs: percentile(chat.filter(ok).map((r) => r.latencyMs), 95),
    thinkingLeaks: records.filter((r) => r.thinkInContent).length,
    reasoningContentCalls: records.filter((r) => r.reasoningContent).length,
    errors,
    calls: records.length,
    http404or401,
    price: priceInfo.price,
    priceSource: priceInfo.source,
    costUsd,
    unrankedReason,
    routedVia,
  };
}

/** accuracy desc → p50 tool latency asc → run cost asc (unknown last). */
export function rankModels(scores: ModelScore[]): string[] {
  const inf = (v: number | null) => (v === null ? Number.POSITIVE_INFINITY : v);
  return scores
    .filter((s) => s.unrankedReason === null)
    .sort(
      (a, b) =>
        b.accuracy - a.accuracy ||
        inf(a.p50ToolMs) - inf(b.p50ToolMs) ||
        inf(a.costUsd) - inf(b.costUsd),
    )
    .map((s) => s.model);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface RunInputs {
  config: BenchConfig;
  cases: ScopedCase[];
  unreachable: string[];
  deps: Omit<CallDeps, "apiKey">;
  log?: (line: string) => void;
}

export async function runBenchmark(inputs: RunInputs): Promise<BenchOutcome> {
  const { config, cases, unreachable } = inputs;
  const log = inputs.log ?? (() => {});
  const deps: CallDeps = { ...inputs.deps, apiKey: config.apiKey };
  const dropped: DroppedModel[] = [];

  let catalog: CatalogModel[] | null = null;
  let warning: string | null = null;
  try {
    catalog = filterCatalog(await fetchCatalog(deps), config.date);
    log(`[bench] catalog: ${catalog.length} serverless+tools models`);
  } catch (err) {
    warning = redact(err instanceof Error ? err.message : String(err), config.apiKey);
    if (/HTTP 401/.test(warning)) {
      return { kind: "bad_key", message: "Fireworks rejected the key (catalog HTTP 401)" };
    }
    log(`[bench] WARN catalog not loaded (${warning}); using the candidate list as-is`);
  }
  const rows = catalog ? catalogRows(catalog) : [];
  const catalogPrices = new Map<string, Price | null>(rows.map((r) => [r.id, r.price]));
  const usageIds = new Map(rows.map((r) => [r.id, r.usageIdentifier]));

  const inter = intersectCandidates(config.models, catalog);
  dropped.push(...inter.dropped);

  // `path` = the model string sent; the catalog `usageIdentifier` replaces
  // the name path when the name 404s and the identifier differs.
  const live: Array<{ id: string; path: string; routedVia: string | null }> = [];
  for (const id of inter.kept) {
    let p = await probeModel(deps, id);
    let path = toModelPath(id);
    let routedVia: string | null = null;
    const usage = usageIds.get(id);
    if (p.status === 404 && usage && toModelPath(usage) !== path) {
      log(`[bench] probe ${id}: 404 on ${path}, retrying with usageIdentifier ${usage}`);
      p = await probeModel(deps, usage);
      path = toModelPath(usage);
      routedVia = usage;
    }
    if (p.status === 401) {
      return { kind: "bad_key", message: `Fireworks rejected the key (probe ${id} HTTP 401)` };
    }
    if (p.status !== null && p.status >= 200 && p.status < 300) {
      live.push({ id, path, routedVia });
      log(`[bench] probe ${id}: ok${routedVia ? ` via usageIdentifier ${routedVia}` : ""}`);
    } else {
      const reason =
        p.status === 404
          ? "retired/undeployed (HTTP 404)"
          : p.status === null
            ? `probe failed: ${p.error ?? "unknown"}`
            : `HTTP ${p.status}${p.error ? `: ${p.error}` : ""}`;
      dropped.push({
        model: id,
        stage: "probe",
        reason: routedVia ? `${reason} (also via usageIdentifier ${routedVia})` : reason,
      });
      log(`[bench] probe ${id}: dropped — ${reason}`);
    }
  }

  const records: CallRecord[] = [];
  const scores: ModelScore[] = [];
  for (const { id: model, path, routedVia } of live) {
    log(`[bench] ${model}: ${cases.length} tool cases + ${CHAT_PROMPTS.length} chat prompts`);
    // A throw outside callChat (body shaping, scoring) becomes an errored
    // record for that call; it never rejects the model's batch.
    const guard =
      (meta: CallMeta, job: () => Promise<CallRecord>) =>
      async (): Promise<CallRecord> => {
        try {
          return await job();
        } catch (err) {
          return {
            ...emptyRecord(meta),
            errorClass: "harness_error",
            error: errorMessageOf(err, config.apiKey),
            ...(meta.kind === "tool" && { score: 0 }),
          };
        }
      };
    const jobs: Array<() => Promise<CallRecord>> = [
      ...cases.map((c) => {
        const meta: CallMeta = { model, caseId: c.caseId, kind: "tool" };
        return guard(meta, async () => {
          const rec = await callChat(
            deps,
            buildChatBody(path, c.input, c.tools, config.reasoningEffort),
            meta,
          );
          return { ...rec, score: scoreCase(c, rec) };
        });
      }),
      ...CHAT_PROMPTS.map((p) => {
        const meta: CallMeta = { model, caseId: p.id, kind: "chat" };
        return guard(meta, () =>
          callChat(deps, buildChatBody(path, { message: p.input }, [], config.reasoningEffort), meta),
        );
      }),
    ];
    const modelRecords = await pool(jobs, CONCURRENCY, (job) => job());
    records.push(...modelRecords);
    scores.push(scoreModel(model, modelRecords, priceFor(model, catalogPrices), routedVia));
  }

  const ranking = rankModels(scores);
  const { apiKey: _omit, ...publicConfig } = config;
  const result: BenchResult = {
    config: {
      ...publicConfig,
      caseCount: cases.length,
      unreachableCases: unreachable,
      chatPrompts: CHAT_PROMPTS.length,
      concurrency: CONCURRENCY,
      maxTokens: MAX_TOKENS,
      temperature: 0,
      systemPrompt: "none (mirrors the eval gate's default probe)",
      gateComparability: GATE_COMPARABILITY,
      perCaseToolCount: toolCountRange(cases),
    },
    catalog: {
      loaded: catalog !== null,
      warning,
      rows,
    },
    dropped,
    scores,
    ranking,
    recommended: ranking[0] ?? null,
    records,
  };
  return live.length === 0
    ? { kind: "all_dropped", result }
    : { kind: "complete", result };
}

// ---------------------------------------------------------------------------
// Dry-run estimate
// ---------------------------------------------------------------------------

/** Prompt tokens ≈ request chars / 4; completion = EST_COMPLETION_TOKENS. */
export function estimateCost(
  models: string[],
  cases: ScopedCase[],
): Array<{ model: string; promptTokens: number; costUsd: number | null }> {
  return models.map((model) => {
    const bodies = [
      ...cases.map((c) => buildChatBody(model, c.input, c.tools)),
      ...CHAT_PROMPTS.map((p) => buildChatBody(model, { message: p.input }, [])),
    ];
    const promptTokens = bodies.reduce(
      (s, b) => s + Math.ceil(JSON.stringify(b).length / 4),
      0,
    );
    const { price } = priceFor(model, new Map());
    const costUsd = price
      ? (promptTokens * price.in + bodies.length * EST_COMPLETION_TOKENS * price.out) / 1e6
      : null;
    return { model, promptTokens, costUsd };
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const fmtMs = (v: number | null) => (v === null ? "n/a" : `${Math.round(v)}`);
const fmtUsd = (v: number | null) => (v === null ? "n/a" : `$${v.toFixed(4)}`);
const fmtPrice = (p: Price | null) =>
  p === null ? "n/a" : `${p.in.toFixed(2)} / ${p.out.toFixed(2)}`;
const fmtPct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);

export function renderScoreTable(result: BenchResult): string {
  const rankOf = new Map(result.ranking.map((m, i) => [m, i + 1]));
  const lines = [
    "| rank | model | accuracy | scored | tool-call validity | p50 tool ms | p95 tool ms | p50 chat ms | p95 chat ms | `<think>` leaks | reasoning_content | errors | $/1M in/out | price src | run cost | note |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  const ordered = [...result.scores].sort(
    (a, b) =>
      (rankOf.get(a.model) ?? Number.POSITIVE_INFINITY) -
      (rankOf.get(b.model) ?? Number.POSITIVE_INFINITY),
  );
  for (const s of ordered) {
    lines.push(
      `| ${rankOf.get(s.model) ?? "—"} | ${s.model} | ${fmtPct(s.accuracy)} | ${s.scoredCases} | ${fmtPct(s.toolCallValidity)} | ${fmtMs(s.p50ToolMs)} | ${fmtMs(s.p95ToolMs)} | ${fmtMs(s.p50ChatMs)} | ${fmtMs(s.p95ChatMs)} | ${s.thinkingLeaks} | ${s.reasoningContentCalls} | ${s.errors}/${s.calls} | ${fmtPrice(s.price)} | ${s.priceSource} | ${fmtUsd(s.costUsd)} | ${[s.unrankedReason ? `unranked: ${s.unrankedReason}` : "", s.routedVia ? `via usageIdentifier ${s.routedVia}` : ""].filter(Boolean).join("; ")} |`,
    );
  }
  return lines.join("\n");
}

export function renderMarkdown(result: BenchResult, apiKey: string): string {
  const c = result.config;
  const out: string[] = [
    `# Fireworks fallback benchmark — ${c.date}`,
    "",
    `RECOMMENDED: ${result.recommended ?? "none"}`,
    "",
    "## Run config",
    "",
    `- models: ${c.models.join(", ")}`,
    `- tool cases scored: ${c.caseCount} (unreachable, excluded: ${c.unreachableCases.length}${c.unreachableCases.length ? ` — ${c.unreachableCases.join(", ")}` : ""})`,
    `- chat prompts: ${c.chatPrompts}`,
    `- tool definitions registered: ${c.toolCount}; per-case offered min/median/max: ${c.perCaseToolCount.min}/${c.perCaseToolCount.median}/${c.perCaseToolCount.max}`,
    `- tool sources: ${c.toolSources.registered.join(", ")}${c.toolSources.skipped.length ? `; SKIPPED (needs a database): ${c.toolSources.skipped.join(", ")}` : ""}`,
    `- concurrency ${c.concurrency} per model, models sequential; temperature ${c.temperature}; max_tokens ${c.maxTokens}; system prompt: ${c.systemPrompt}`,
    `- reasoning_effort: ${c.reasoningEffort ?? "not sent"}`,
    `- vs the eval gate: ${c.gateComparability}`,
    "",
    "## Scores",
    "",
    renderScoreTable(result),
    "",
    "Accuracy = mean eval-gate `scoreToolSelection` score over the scored cases (hit = any offered expected tool called; a forbidden tool called scores 0; an errored call scores 0). Ranking: accuracy desc, p50 tool latency asc, run cost asc. Unranked: any HTTP 404/401 during the run, or > 20% errors.",
    "",
    "## Dropped candidates",
    "",
  ];
  if (result.dropped.length === 0) out.push("none");
  for (const d of result.dropped) out.push(`- ${d.model} (${d.stage}): ${d.reason}`);
  out.push("", "## Catalog (serverless + tools, not deprecated)", "");
  if (!result.catalog.loaded) {
    out.push(`not loaded: ${result.catalog.warning ?? "unknown"}`);
  } else {
    out.push(
      "| id | context | deprecation | $/1M in/out | price source |",
      "|---|---|---|---|---|",
    );
    const catalogPrices = new Map(result.catalog.rows.map((r) => [r.id, r.price]));
    for (const r of result.catalog.rows) {
      const p = priceFor(r.id, catalogPrices);
      out.push(
        `| ${r.id} | ${r.contextLength ?? "n/a"} | ${r.deprecation ?? "—"} | ${fmtPrice(p.price)} | ${p.source} |`,
      );
    }
    const unpriced = result.catalog.rows.filter((r) => r.price === null).length;
    if (unpriced > 0) {
      out.push(
        "",
        `\`${unpriced}/${result.catalog.rows.length}\` catalog rows had no parseable \`skuInfos\` (Fireworks fills serverless prices on its serverless-models list, not on ListModels/GetModel); the \`price source\` column says which of them fell back to the builtin table`,
      );
    }
  }
  const errs = result.records.filter((r) => r.errorClass !== null);
  if (errs.length > 0) {
    out.push("", "## Errors", "");
    for (const r of errs) {
      out.push(
        `- ${r.model} ${r.caseId}: ${r.errorClass}${r.error ? ` — ${r.error.replace(/\s+/g, " ")}` : ""}`,
      );
    }
  }
  out.push("");
  return redact(out.join("\n"), apiKey);
}

export function renderJson(result: BenchResult, apiKey: string): string {
  return redact(JSON.stringify(result, null, 2), apiKey);
}
