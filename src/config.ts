/**
 * Environment-based configuration with defaults.
 * All config is read once at startup.
 */

export interface Config {
  /** API key for X-Api-Key authentication. */
  apiKey: string;
  /** Server port. */
  port: number;
  /** SQLite database file path. */
  dbPath: string;

  /** Primary inference provider URL. */
  inferencePrimaryUrl: string;
  /** Primary inference provider API key. */
  inferencePrimaryKey: string;
  /** Primary inference model name. */
  inferencePrimaryModel: string;

  /** Fallback inference provider URL (optional). */
  inferenceFallbackUrl?: string;
  /** Fallback inference provider API key (optional). */
  inferenceFallbackKey?: string;
  /** Fallback inference model name (optional). */
  inferenceFallbackModel?: string;

  /** Tertiary inference provider URL (optional, third-tier fallback). */
  inferenceTertiaryUrl?: string;
  /** Tertiary inference provider API key (optional). */
  inferenceTertiaryKey?: string;
  /** Tertiary inference model name (optional). */
  inferenceTertiaryModel?: string;

  /** LLM call timeout in milliseconds. */
  inferenceTimeoutMs: number;
  /** Max tokens per LLM response. */
  inferenceMaxTokens: number;

  /** Global orchestration timeout in milliseconds. */
  orchestratorTimeoutMs: number;
  /** Max LLM iterations per orchestration run. */
  orchestratorMaxIterations: number;
  /** Per-goal timeout in milliseconds. */
  goalTimeoutMs: number;

  /** Max retries per inference provider (reduce to 1 behind LiteLLM). */
  inferenceMaxRetries: number;

  /** Context window size for compression decisions. */
  inferenceContextLimit: number;
  /** Fraction of context window that triggers compression (0.0–1.0). */
  compressionThreshold: number;

  /** NanoClaw Docker image name. */
  nanoclawImage: string;
  /** Max simultaneous containers. */
  maxConcurrentContainers: number;

  /** Run heavy tasks inside a Docker container instead of in-process. */
  heavyRunnerContainerized: boolean;
  /** Docker image for containerized heavy runner. */
  heavyRunnerImage: string;
  /** Timeout for containerized heavy runner in milliseconds. */
  heavyRunnerTimeoutMs: number;

  /** Path to MCP servers config file (optional). */
  mcpConfigPath?: string;

  /** A2A agent name for discovery card (optional). */
  a2aName?: string;
  /** A2A agent base URL for discovery card (optional). */
  a2aUrl?: string;

  /** Enable budget enforcement (default: false). */
  budgetEnabled: boolean;
  /** Daily spend limit in USD (default: 10.0). */
  budgetDailyLimitUsd: number;
  /** Custom model pricing JSON (optional override). */
  budgetPricingJson?: string;
}

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

function optional(key: string): string | undefined {
  return process.env[key] || undefined;
}

function int(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function float(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = parseFloat(raw);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function loadConfig(): Config {
  return {
    apiKey: required("MC_API_KEY"),
    port: int("MC_PORT", 8080),
    dbPath: process.env.MC_DB_PATH ?? "./data/mc.db",

    inferencePrimaryUrl: required("INFERENCE_PRIMARY_URL"),
    inferencePrimaryKey: required("INFERENCE_PRIMARY_KEY"),
    inferencePrimaryModel: required("INFERENCE_PRIMARY_MODEL"),

    inferenceFallbackUrl: optional("INFERENCE_FALLBACK_URL"),
    inferenceFallbackKey: optional("INFERENCE_FALLBACK_KEY"),
    inferenceFallbackModel: optional("INFERENCE_FALLBACK_MODEL"),

    inferenceTertiaryUrl: optional("INFERENCE_TERTIARY_URL"),
    inferenceTertiaryKey: optional("INFERENCE_TERTIARY_KEY"),
    inferenceTertiaryModel: optional("INFERENCE_TERTIARY_MODEL"),

    inferenceTimeoutMs: int("INFERENCE_TIMEOUT_MS", 60000),
    inferenceMaxTokens: int("INFERENCE_MAX_TOKENS", 4096),
    inferenceMaxRetries: int("INFERENCE_MAX_RETRIES", 3),

    orchestratorTimeoutMs: int("ORCHESTRATOR_TIMEOUT_MS", 600_000),
    orchestratorMaxIterations: int("ORCHESTRATOR_MAX_ITERATIONS", 90),
    goalTimeoutMs: int("GOAL_TIMEOUT_MS", 120_000),

    inferenceContextLimit: int("INFERENCE_CONTEXT_LIMIT", 128_000),
    compressionThreshold: parseFloat(
      process.env.COMPRESSION_THRESHOLD ?? "0.85",
    ),

    nanoclawImage: process.env.NANOCLAW_IMAGE ?? "nanoclaw-agent:latest",
    maxConcurrentContainers: int("MAX_CONCURRENT_CONTAINERS", 5),

    heavyRunnerContainerized: process.env.HEAVY_RUNNER_CONTAINERIZED === "true",
    heavyRunnerImage:
      process.env.HEAVY_RUNNER_IMAGE ?? "mission-control:latest",
    heavyRunnerTimeoutMs: int("HEAVY_RUNNER_TIMEOUT_MS", 900_000),

    mcpConfigPath: optional("MC_MCP_CONFIG"),

    a2aName: optional("A2A_AGENT_NAME"),
    a2aUrl: optional("A2A_AGENT_URL"),

    budgetEnabled: process.env.BUDGET_ENABLED === "true",
    budgetDailyLimitUsd: float("BUDGET_DAILY_LIMIT_USD", 10.0),
    budgetPricingJson: optional("BUDGET_PRICING_JSON"),
  };
}

/** Singleton config instance. Loaded once at startup. */
let _config: Config | null = null;

export function getConfig(): Config {
  if (!_config) _config = loadConfig();
  return _config;
}
