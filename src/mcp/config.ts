/**
 * MCP configuration loader — `mcp-servers.json` (operator-wide SERVICE
 * servers) merged with the `capabilities.mcp[]` entries of every active
 * project record (S6 WS3, spec docs/planning/s6-project-contract-spec-2026-10-11.md §3).
 */

import { readFileSync, existsSync, realpathSync } from "fs";
import { join, sep } from "path";
import { getConfig } from "../config.js";
import type { McpConfig, McpServerConfig, TrustClass } from "./types.js";
import { errMsg } from "../lib/err-msg.js";
import { listProjects } from "../db/projects.js";
import { ENV_NAME_RE } from "./env-deny.js";
import { resolveRecordEnv, type RecordEnvEntry } from "./record-env.js";
import { MCP_NAMESPACE_SEP } from "./types.js";
import { RULE_OF_TWO_PREFIX_DEFAULTS } from "../tools/rule-of-two.js";

/** One `capabilities.mcp[]` entry as the record schema validates it. */
export interface RecordMcpEntry {
  id?: string;
  command: string;
  args?: string[];
  repo?: string;
  cwd?: string;
  env?: RecordEnvEntry[];
  trust?: TrustClass;
  tools?: Record<string, { trust?: TrustClass; destructive?: boolean; read_only?: boolean }>;
  deferred?: string[];
}

/** One `repos[]` entry of a record. */
export interface RecordRepo {
  path: string;
  role: "primary" | "other";
}

/**
 * Pure (fs realpath only): a record's MCP entry → a server config, or the
 * reason it is refused. `id` defaults to the slug; `repo` names a `repos[]`
 * entry by path or role (default: the primary, else the single repo); `cwd`
 * resolves inside that repo after realpath (a symlink or `..` out of it is
 * refused). Relative `args` are left to the child: `cwd` governs them.
 */
export function recordToServerConfig(
  entry: RecordMcpEntry,
  slug: string,
  repos: readonly RecordRepo[],
  trusted: boolean,
  secrets: readonly string[] = [],
): { id: string; config: McpServerConfig } | { error: string } {
  const id = entry.id ?? slug;
  if (typeof entry.command !== "string" || !entry.command) {
    return { error: `${slug}/${id}: command must be a non-empty string` };
  }
  if (id.includes(MCP_NAMESPACE_SEP)) {
    return { error: `${slug}/${id}: id must not contain ${MCP_NAMESPACE_SEP}` };
  }
  const env = resolveRecordEnv(entry.env, secrets);
  if ("error" in env) return { error: `${slug}/${id}: ${env.error}` };
  let repo: RecordRepo | undefined;
  if (entry.repo !== undefined) {
    const byPath = repos.find((r) => r.path === entry.repo);
    const byRole = repos.filter((r) => r.role === entry.repo);
    repo = byPath ?? (byRole.length === 1 ? byRole[0] : undefined);
    if (!repo) return { error: `${slug}/${id}: repo "${entry.repo}" names no single repos[] entry` };
  } else {
    repo = repos.find((r) => r.role === "primary") ?? (repos.length === 1 ? repos[0] : undefined);
    if (!repo) return { error: `${slug}/${id}: no repo (the record needs a primary repo or exactly one)` };
  }
  let root: string;
  let cwd: string;
  try {
    root = realpathSync(repo.path);
    cwd = realpathSync(join(root, entry.cwd ?? "."));
  } catch {
    return { error: `${slug}/${id}: repo or cwd does not exist` };
  }
  if (cwd !== root && !cwd.startsWith(root + sep)) {
    return { error: `${slug}/${id}: cwd resolves outside its repo` };
  }
  const config: McpServerConfig = {
    command: entry.command,
    args: entry.args ?? [],
    cwd,
    source: { kind: "record", slug, trusted, ...(secrets.length > 0 && { secrets: [...secrets] }) },
  };
  if (env.spec.length > 0) config.envSpec = env.spec;
  if (entry.trust !== undefined) config.trust = entry.trust;
  if (entry.tools !== undefined) config.toolTrust = entry.tools;
  if (entry.deferred && entry.deferred.length > 0) config.deferredTools = [...entry.deferred];
  return { id, config };
}

/**
 * The record servers of every active project row whose (projected)
 * `config.capabilities.mcp` exists, merged after `service`. A duplicate id
 * (against a service server or an earlier record) is refused: logged once
 * and reported through `onRefused` (the caller's operator-alert path); the
 * entry already present wins. Untrusted entries are returned (the manager
 * does not spawn them).
 */
export function mergeRecordServers(
  service: McpConfig,
  rows: ReadonlyArray<{ slug: string; status: string; config: Record<string, unknown> }>,
  onRefused?: (msg: string) => void,
): McpConfig {
  const out: McpConfig = { ...service };
  // Prefixes a record id must not overlap (either direction): the service
  // ids, the static Rule-of-Two table (resolved before any record entry;
  // audit R1 W2) and every record prefix accepted so far (prefix
  // classification takes the first match; audit R2 W1). Value = owner label.
  const takenPrefixes = new Map<string, string>();
  for (const id of Object.keys(service)) takenPrefixes.set(id + MCP_NAMESPACE_SEP, "service");
  for (const [p] of RULE_OF_TWO_PREFIX_DEFAULTS) if (!takenPrefixes.has(p)) takenPrefixes.set(p, "service");
  // By slug, never by the row order (`listProjects` sorts by name, which a
  // rename changes): the earlier slug wins a duplicate id (audit R1 W5).
  const sorted = [...rows].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const row of sorted) {
    if (row.status !== "active") continue;
    const caps = row.config.capabilities as { mcp?: unknown } | undefined;
    if (!caps || !Array.isArray(caps.mcp)) continue;
    const repos = Array.isArray(row.config.repos) ? (row.config.repos as RecordRepo[]) : [];
    const trusted = row.config.trusted === true;
    const secrets = Array.isArray(row.config.secrets)
      ? (row.config.secrets as unknown[]).filter((n): n is string => typeof n === "string")
      : [];
    for (const entry of caps.mcp as RecordMcpEntry[]) {
      const r = recordToServerConfig(entry, row.slug, repos, trusted, secrets);
      if ("error" in r) {
        console.error(`[mcp] record server refused: ${r.error}`);
        onRefused?.(`[mcp] ⚠️ record server refused: ${r.error}`);
        continue;
      }
      const prefix = r.id + MCP_NAMESPACE_SEP;
      const shadowed = [...takenPrefixes.keys()].find((p) => p.startsWith(prefix) || prefix.startsWith(p));
      // The same id is the duplicate path below (its own message).
      if (shadowed !== undefined && !Object.hasOwn(out, r.id)) {
        const msg = `[mcp] ⚠️ record server ${row.slug}/${r.id} refused: prefix "${prefix}" overlaps ${takenPrefixes.get(shadowed)} prefix "${shadowed}"`;
        console.error(msg);
        onRefused?.(msg);
        continue;
      }
      if (Object.hasOwn(out, r.id)) {
        const msg = `[mcp] ⚠️ record server ${row.slug}/${r.id} refused: id "${r.id}" is already declared (${out[r.id]!.source?.kind === "record" ? "by another record" : "by mcp-servers.json"}); the existing entry wins`;
        console.error(msg);
        onRefused?.(msg);
        continue;
      }
      out[r.id] = r.config;
      takenPrefixes.set(prefix, `record ${row.slug}`);
    }
  }
  return out;
}

/**
 * Load MCP server configuration: `mcp-servers.json` merged with the active
 * records' servers. Returns null when neither declares a server (graceful).
 * Throws on a malformed JSON file. A database that cannot be read leaves the
 * service servers alone (logged).
 */
export function loadMcpConfig(
  opts: { onRefused?: (msg: string) => void } = {},
): McpConfig | null {
  const service = loadServiceConfig();
  let rows: ReturnType<typeof listProjects> = [];
  try {
    rows = listProjects("active");
  } catch (err) {
    console.warn(`[mcp] project records not read (${errMsg(err)}); service servers only`);
  }
  const merged = mergeRecordServers(service ?? {}, rows, opts.onRefused);
  return service === null && Object.keys(merged).length === 0 ? null : merged;
}

/** `mcp-servers.json`, each entry tagged `source: service`; null when the file is absent. */
function loadServiceConfig(): McpConfig | null {
  const configPath = getConfig().mcpConfigPath ?? "./mcp-servers.json";

  if (!existsSync(configPath)) {
    return null;
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to read MCP config at ${configPath}: ${errMsg(err)}`,
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in MCP config at ${configPath}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `MCP config must be a JSON object mapping server IDs to configs`,
    );
  }

  // Validate each entry
  for (const [serverId, entry] of Object.entries(parsed)) {
    const config = entry as McpServerConfig;
    if (!config || typeof config.command !== "string" || !config.command) {
      throw new Error(
        `MCP server "${serverId}": "command" must be a non-empty string`,
      );
    }
    // Validate lazy tool definitions
    if (config.lazy && config.tools) {
      for (const [i, tool] of config.tools.entries()) {
        if (!tool || typeof tool.name !== "string" || !tool.name) {
          throw new Error(
            `MCP server "${serverId}": tools[${i}].name must be a non-empty string`,
          );
        }
      }
    }
    if (
      config.envNames !== undefined &&
      (!Array.isArray(config.envNames) ||
        !config.envNames.every((n) => typeof n === "string" && ENV_NAME_RE.test(n)))
    ) {
      throw new Error(
        `MCP server "${serverId}": "envNames" must be an array of env names`,
      );
    }
    // Per-tool flags are record-only (audit R1 C1): a service entry never
    // declares its own tools read-only. Stripped, not refused: a throw here
    // would take every service server down for one stray key.
    if ("toolTrust" in config) {
      delete config.toolTrust;
      console.warn(`[mcp] ${serverId}: "toolTrust" is record-only; ignored for a service server`);
    }
    config.source = { kind: "service" };
  }

  return parsed as McpConfig;
}
