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

  /** LLM call timeout in milliseconds. */
  inferenceTimeoutMs: number;
  /** Max tokens per LLM response. */
  inferenceMaxTokens: number;

  /** NanoClaw Docker image name. */
  nanoclawImage: string;
  /** Max simultaneous containers. */
  maxConcurrentContainers: number;

  /** Path to MCP servers config file (optional). */
  mcpConfigPath?: string;

  /** A2A agent name for discovery card (optional). */
  a2aName?: string;
  /** A2A agent base URL for discovery card (optional). */
  a2aUrl?: string;
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

    inferenceTimeoutMs: int("INFERENCE_TIMEOUT_MS", 30000),
    inferenceMaxTokens: int("INFERENCE_MAX_TOKENS", 4096),

    nanoclawImage: process.env.NANOCLAW_IMAGE ?? "nanoclaw-agent:latest",
    maxConcurrentContainers: int("MAX_CONCURRENT_CONTAINERS", 5),

    mcpConfigPath: optional("MC_MCP_CONFIG"),

    a2aName: optional("A2A_AGENT_NAME"),
    a2aUrl: optional("A2A_AGENT_URL"),
  };
}

/** Singleton config instance. Loaded once at startup. */
let _config: Config | null = null;

export function getConfig(): Config {
  if (!_config) _config = loadConfig();
  return _config;
}
