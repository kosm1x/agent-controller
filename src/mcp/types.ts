/**
 * MCP integration types — configuration schema and constants.
 */

import type { EnvSpecEntry } from "./record-env.js";

/** Rule-of-Two trust class a record declares (spec §3): A, B, both, or neither. */
export type TrustClass = "A" | "B" | "AB" | "NONE";

/** Where a server entry came from: `mcp-servers.json` or a project record. */
export type McpServerSource =
  | { kind: "service" }
  | {
      kind: "record";
      slug: string;
      trusted: boolean;
      /** The record's `secrets` NAMES (`SECRET_<NAME>`); values stay in `projects.credentials`. */
      secrets?: string[];
    };

/** Single MCP server configuration entry. */
export interface McpServerConfig {
  /** Command to spawn the MCP server process. */
  command: string;
  /** Arguments to pass to the command. */
  args?: string[];
  /**
   * Fixed environment values (service servers only), applied onto the SDK
   * default env — never onto the service's own `process.env`.
   */
  env?: Record<string, string>;
  /**
   * Service servers only (S6 WS3, names only): names read from the service
   * env and passed to the child; a name with no value is omitted. A record
   * server uses `envSpec` instead — the service env never reaches it.
   */
  envNames?: string[];
  /**
   * Record servers only (S6 WS3a): the normalised record `env` entries — a
   * credential reference (`SECRET_…` from the record's `secrets`) or a literal
   * non-secret value, each delivered to the child under `name`. A record
   * server ignores `env` and `envNames`.
   */
  envSpec?: EnvSpecEntry[];
  /** Working directory of the child (record servers: inside their repo). */
  cwd?: string;
  /** Set by the loader; absent in `mcp-servers.json` (= service). */
  source?: McpServerSource;
  /** Server-wide Rule-of-Two class from the record. */
  trust?: TrustClass;
  /** Per-tool flags from the record, keyed by the server's own tool name. */
  toolTrust?: Record<string, { trust?: TrustClass; destructive?: boolean }>;
  /** Whether this server is enabled (default: true). */
  enabled?: boolean;
  /** Lazy-load: register placeholder tools at startup, connect on first call. */
  lazy?: boolean;
  /** Tool definitions for lazy-loaded servers (avoids spawning process to discover). */
  tools?: Array<{
    name: string;
    description: string;
    inputSchema?: Record<string, unknown>;
  }>;
  /** Tool names to mark as deferred (name + description only, full schema on first call). */
  deferredTools?: string[];
}

/** Full MCP configuration file schema: serverId → config. */
export interface McpConfig {
  [serverId: string]: McpServerConfig;
}

/** Separator used for namespacing MCP tools: serverId__toolName. */
export const MCP_NAMESPACE_SEP = "__";
