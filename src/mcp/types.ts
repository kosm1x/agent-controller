/**
 * MCP integration types — configuration schema and constants.
 */

/** Single MCP server configuration entry. */
export interface McpServerConfig {
  /** Command to spawn the MCP server process. */
  command: string;
  /** Arguments to pass to the command. */
  args?: string[];
  /** Environment variables for the subprocess. */
  env?: Record<string, string>;
  /** Whether this server is enabled (default: true). */
  enabled?: boolean;
}

/** Full MCP configuration file schema: serverId → config. */
export interface McpConfig {
  [serverId: string]: McpServerConfig;
}

/** Separator used for namespacing MCP tools: serverId__toolName. */
export const MCP_NAMESPACE_SEP = "__";
