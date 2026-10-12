/**
 * MCP integration types — configuration schema and constants.
 */

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
   * Names passed through to the child (S6 WS3, names only): a service server
   * reads each from the service env; a record server ONLY from its project's
   * credentials (`SECRET_<NAME>` in the record's `secrets`) — secrets only, the
   * service env never reaches a record child. A name with no value is omitted.
   */
  envNames?: string[];
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
