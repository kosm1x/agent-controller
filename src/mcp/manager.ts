/**
 * MCP client manager — connects to MCP servers and registers their tools.
 *
 * Includes automatic reconnection for servers that fail on startup or
 * disconnect later, with Telegram alerts on degradation and recovery.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpConfig, McpServerConfig } from "./types.js";
import { MCP_NAMESPACE_SEP } from "./types.js";
import { createMcpTool, resolveMcpToolHints } from "./bridge.js";
import type { McpCallResult } from "./bridge.js";
import { getToolAnnotations } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { Tool } from "../tools/types.js";
import { errMsg } from "../lib/err-msg.js";
import { getProject } from "../db/projects.js";
import { projectCredentialByName } from "../lib/secret-refs.js";
import { applyDeferredHeadRule } from "../projects/scope-groups.js";
import { ENV_NAME_RE, isDeniedEnvName } from "./env-deny.js";
import { ENV_VALUE_FORBIDDEN_RE } from "./record-env.js";
import { cachedProjectStatus } from "../lib/project-status-cache.js";

/**
 * S6 WS3 (names-only env, queue 3a): the child's environment is the SDK's
 * default safe set plus what the config declares. A service server: its
 * fixed `env` values and `envNames` read from the service env. A record
 * server (WS3a): its `envSpec` ONLY — a credential reference resolved from
 * its own project (`projectCredentialByName`; the reference must be in the
 * record's `secrets`) or a literal non-secret value; a reference miss, an
 * unlisted reference or a reserved name (env-deny.ts) is omitted — the
 * service env never reaches a record child. Warnings carry NAMES only.
 * Never the whole service env.
 */
export function buildSpawnEnv(
  serverId: string,
  config: McpServerConfig,
): Record<string, string> {
  const env: Record<string, string> = { ...getDefaultEnvironment() };
  const source = config.source;
  if (source?.kind === "record") {
    for (const entry of config.envSpec ?? []) {
      const name = entry.name;
      if (!ENV_NAME_RE.test(name)) {
        console.warn(`[mcp] ${serverId}: an env name does not match ${ENV_NAME_RE.source} — omitted`);
        continue;
      }
      // Defence in depth behind the record schema and the loader (audit R1 W3).
      if (isDeniedEnvName(name)) {
        console.warn(`[mcp] ${serverId}: env ${name} is reserved — omitted`);
        continue;
      }
      if ("value" in entry) {
        if (ENV_VALUE_FORBIDDEN_RE.test(entry.value)) {
          warnOnce(`${serverId}\0${name}`, `[mcp] ${serverId}: env ${name} has a newline or NUL; omitted`);
          continue;
        }
        env[name] = entry.value;
        continue;
      }
      // Secrets only: from the project's own credentials or not at all
      // (audit R1 W4, R2 W2).
      if (!source.secrets?.includes(entry.secret)) {
        warnOnce(
          `${serverId}\0${name}`,
          `[mcp] ${serverId}: env ${name} is not in project ${source.slug}'s secrets (${entry.secret}); omitted`,
        );
        continue;
      }
      const secret = projectCredentialByName(source.slug, entry.secret);
      if (secret === undefined) {
        warnOnce(
          `${serverId}\0${name}`,
          `[mcp] ${serverId}: env ${name} — ${entry.secret} has no credential in project ${source.slug}; omitted`,
        );
        continue;
      }
      // Node's spawn error echoes a value with NUL: never let it fire.
      if (ENV_VALUE_FORBIDDEN_RE.test(secret)) {
        warnOnce(`${serverId}\0${name}`, `[mcp] ${serverId}: env ${name} has a newline or NUL; omitted`);
        continue;
      }
      env[name] = secret;
    }
    return env;
  }
  if (config.env) Object.assign(env, config.env);
  for (const name of config.envNames ?? []) {
    if (!ENV_NAME_RE.test(name)) {
      console.warn(`[mcp] ${serverId}: an env name does not match ${ENV_NAME_RE.source} — omitted`);
      continue;
    }
    const value = process.env[name];
    if (value === undefined) {
      console.warn(`[mcp] ${serverId}: env ${name} has no value — omitted`);
      continue;
    }
    env[name] = value;
  }
  return env;
}

const warned = new Set<string>();
/** One warn per key for the process lifetime (reconnects respawn the child). */
function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(msg);
}

/** Internal state for a connected MCP server. */
interface ServerEntry {
  client: Client;
  transport: StdioClientTransport;
  toolNames: string[];
  /** Date.now() when this connection was established. */
  connectedAt: number;
  /** Attempt count of the outage this connection recovered from (0 = fresh). */
  priorAttempts: number;
}

/** State for a lazy server pending first tool call. */
interface LazyServerEntry {
  config: McpServerConfig;
  toolNames: string[];
  connecting?: Promise<void>;
}

const CONNECT_TIMEOUT_MS = 10_000;
const RECONNECT_INTERVAL_MS = 60_000; // retry failed servers every 60s
const MAX_RECONNECT_ATTEMPTS = 10; // stop retrying after 10 failures
// A reconnected server that dies again sooner than this is flapping: its
// attempt count carries over (so the give-up cap is reachable) and it alerts
// no further DEGRADED/reconnected pairs.
const STABLE_CONNECTION_MS = 5 * 60_000;
// The 3rd+ death of one server inside a rolling hour (closed: a death exactly
// 60:00 ago still counts) is also flapping, so a server that always dies just
// past STABLE_CONNECTION_MS converges too. A boot connect failure counts as a
// death. Net bound per server: at most 2 DEGRADED alerts in any rolling hour,
// each followed by at most one "reconnected" alert (which can trail its
// DEGRADED by up to ~10 min), then silence until a clean hour or the single
// "giving up" alert. Deliberately NOT silenced: a steady rate of <= 2 deaths
// per hour (e.g. every 30 min 01 s) never counts as flapping and never gives
// up — it alerts on every death (~95 alerts/24 h), a recurring outage the
// operator should see.
const FLAP_WINDOW_MS = 60 * 60_000;
const FLAP_DEATHS_IN_WINDOW = 3;

export class McpManager {
  private servers = new Map<string, ServerEntry>();
  private lazyServers = new Map<string, LazyServerEntry>();
  private failedServers = new Map<
    string,
    { config: McpServerConfig; attempts: number; quiet?: boolean }
  >();
  private registry: ToolRegistry | null = null;
  private reconnectTimer: ReturnType<typeof setInterval> | null = null;
  /** A reconnect tick is still running (a tick can outlast the interval). */
  private reconnectInFlight = false;
  /** Per-server death timestamps inside the rolling FLAP_WINDOW_MS. */
  private deathTimes = new Map<string, number[]>();
  /** Servers the reconnect loop gave up on (dead until service restart). */
  private abandonedServers = new Set<string>();
  private alertFn: ((msg: string) => void) | null = null;
  /** Boot DEGRADED alert raised before any alertFn was wired (delivered on setAlertFn). */
  private pendingBootAlert: string | null = null;
  private isShutdown = false;
  /**
   * A record server's project status ("missing" for no row), cached
   * (src/lib/project-status-cache.ts; `updateProject` invalidates). A db
   * error propagates (the call fails).
   */
  private currentProjectStatus(slug: string): string {
    return cachedProjectStatus(slug, () => {
      const row = getProject(slug);
      return row && row.slug === slug ? row.status : "missing";
    });
  }

  /** Set alert callback for degradation/recovery notifications. */
  setAlertFn(fn: (msg: string) => void): void {
    this.alertFn = fn;
    // init() runs before messaging is up, so the boot alert would otherwise
    // reach the journal only. Deliver it once, now that there is a channel.
    const pending = this.pendingBootAlert;
    this.pendingBootAlert = null;
    if (pending) this.deliver(pending);
  }

  private deliver(msg: string): void {
    if (!this.alertFn) return;
    try {
      this.alertFn(msg);
    } catch {
      /* non-fatal */
    }
  }

  private alert(msg: string): void {
    console.warn(msg);
    this.deliver(msg);
  }

  /**
   * Connect to all configured MCP servers and register their tools.
   * Each server is independent — one failure doesn't block others.
   * Failed servers are queued for automatic reconnection.
   */
  async init(config: McpConfig, registry: ToolRegistry): Promise<void> {
    this.registry = registry;
    const serverIds = Object.keys(config);
    let connected = 0;
    let totalTools = 0;

    let lazyCount = 0;

    for (const serverId of serverIds) {
      const serverConfig = config[serverId];
      if (serverConfig.enabled === false) {
        console.log(`[mcp] ${serverId}: skipped (disabled)`);
        continue;
      }
      // S6 WS3 (spec §3): nothing from an untrusted record loads before WS7.
      if (
        serverConfig.source?.kind === "record" &&
        !serverConfig.source.trusted
      ) {
        console.warn(
          `[mcp] ${serverId}: not loaded — record ${serverConfig.source.slug} is not trusted`,
        );
        continue;
      }

      // Lazy servers: register proxy tools without spawning the process
      if (serverConfig.lazy && serverConfig.tools?.length) {
        const toolNames = this.registerLazyServer(
          serverId,
          serverConfig,
          registry,
        );
        lazyCount++;
        totalTools += toolNames.length;
        continue;
      }

      try {
        const { toolCount } = await this.connectServer(
          serverId,
          serverConfig,
          registry,
        );
        connected++;
        totalTools += toolCount;
      } catch (err) {
        const msg = errMsg(err);
        console.warn(`[mcp] ${serverId}: failed to connect — ${msg}`);
        this.failedServers.set(serverId, { config: serverConfig, attempts: 1 });
        this.recordDeath(serverId); // the boot DEGRADED alert counts too
      }
    }

    const loadable = serverIds.filter(
      (id) =>
        config[id].enabled !== false &&
        !(config[id].source?.kind === "record" && !config[id].source.trusted),
    );
    const total = loadable.length;
    const fromRecords = loadable.filter((id) => config[id].source?.kind === "record").length;
    const parts = [`${connected}/${total - lazyCount} servers`];
    if (lazyCount > 0) parts.push(`${lazyCount} lazy`);
    if (fromRecords > 0) parts.push(`${fromRecords} from records`);
    parts.push(`${totalTools} tools registered`);
    console.log(`[mcp] ${parts.join(", ")}`);

    // Alert on startup degradation
    if (this.failedServers.size > 0) {
      const failed = Array.from(this.failedServers.keys()).join(", ");
      const msg = `[mcp] ⚠️ DEGRADED: ${this.failedServers.size} MCP server(s) failed to connect (${failed}). Auto-reconnect started.`;
      if (!this.alertFn) this.pendingBootAlert = msg;
      this.alert(msg);
    }

    // Start reconnection loop if any servers failed
    this.startReconnectLoop();
  }

  /** Connect a single MCP server and register its tools. */
  private async connectServer(
    serverId: string,
    config: McpServerConfig,
    registry: ToolRegistry,
    priorAttempts = 0,
  ): Promise<{ toolCount: number }> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: buildSpawnEnv(serverId, config),
      ...(config.cwd !== undefined && { cwd: config.cwd }),
    });

    const client = new Client({
      name: `mc-${serverId}`,
      version: "1.0.0",
    });

    let tools: Awaited<ReturnType<Client["listTools"]>>["tools"];
    const toolNames: string[] = [];

    // Create callFn bound to this client. Once this client is no longer the
    // live one for serverId (it died, or shutdown ran), fail fast with an
    // error that names the server instead of the SDK's bare "Not connected".
    const isLive = () => this.servers.get(serverId)?.client === client;
    const downError = () =>
      new Error(
        `MCP server ${serverId} is down${
          this.failedServers.has(serverId)
            ? " (auto-reconnect pending)"
            : this.abandonedServers.has(serverId)
              ? " (reconnect abandoned — restart required)"
              : ""
        }`,
      );
    const source = config.source;
    const callFn = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<McpCallResult> => {
      // S6 WS3: no runtime unregister — a project that left `active` keeps
      // its tools registered until restart, and every call is refused.
      if (source?.kind === "record") {
        const status = this.currentProjectStatus(source.slug);
        if (status !== "active") {
          throw new Error(
            `project ${source.slug} is ${status}; its server is unloaded at the next restart`,
          );
        }
      }
      if (!isLive()) throw downError();
      try {
        const result = await client.callTool({ name, arguments: args });
        return result as McpCallResult;
      } catch (err) {
        // In-flight call rejected by the SDK because the server died mid-call.
        if (!isLive()) throw downError();
        throw err;
      }
    };

    // Register each tool in the global registry
    let deferSet: ReadonlySet<string> = new Set(config.deferredTools ?? []);
    const unannotatedTools: string[] = [];
    const trifectaTools: string[] = [];

    // Connect with timeout (cleared either way so no timer outlives the
    // attempt), discover tools and register them. Any failure — or a shutdown
    // that ran while we awaited — closes the client so the spawned child is
    // not leaked and no half-registered server lands in `servers`.
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.connect(transport),
        new Promise<never>((_, reject) => {
          connectTimer = setTimeout(
            () =>
              reject(new Error(`Connection timeout (${CONNECT_TIMEOUT_MS}ms)`)),
            CONNECT_TIMEOUT_MS,
          );
        }),
      ]);
      ({ tools } = await client.listTools());
      if (this.isShutdown) throw new Error("MCP manager shut down");
      // Deferred-head rule (CLAUDE.md §Infrastructure) for a record server:
      // its group has no call distribution yet, so it never defers ALL tools.
      if (source?.kind === "record") {
        const kept = applyDeferredHeadRule(
          tools.map((t) => t.name),
          deferSet,
        );
        if (kept.size !== deferSet.size) {
          console.warn(
            `[mcp] ${serverId}: every tool was deferred — ${tools[0]?.name} stays eager (deferred-head rule)`,
          );
        }
        deferSet = kept;
      }

      for (const mcpTool of tools) {
        const tool = createMcpTool(
          serverId,
          {
            name: mcpTool.name,
            description: mcpTool.description,
            inputSchema: mcpTool.inputSchema as Record<string, unknown>,
            // Server annotations are trusted for RECORD servers only; a
            // service server keeps the curated name table (audit R1 W1).
            annotations:
              source?.kind === "record" ? mcpTool.annotations : undefined,
          },
          callFn,
          deferSet.has(mcpTool.name),
          config.toolTrust?.[mcpTool.name],
        );
        registry.register(tool);
        toolNames.push(tool.name);
        // v7.6 Spine 4 W4 audit W3 (2026-05-09): track tools whose names
        // didn't match any pattern in `getMcpToolHints`. They register with
        // undefined hints, which collapses to conservative-unknown defaults
        // (destructive: true) — re-polluting the very metric this fix
        // closes. Surfacing the gap at startup lets operators see which
        // verbs need to be added to the lookup.
        if (
          tool.readOnlyHint === undefined &&
          tool.destructiveHint === undefined
        ) {
          unannotatedTools.push(tool.name);
        }
        // Rule of Two (V8.5 Phase 5.2, qa R2 W-C 2026-08-15): a NEW tool under
        // an A∧B prefix (`xpoz__`) with a destructive/unknown verb resolves as
        // a single-tool trifecta ⇒ structural high/confirm — an unsigned flip
        // the test fixture cannot see (it IS the input). Detect it at boot.
        if (getToolAnnotations(tool).ruleOfTwoTrifecta) {
          trifectaTools.push(tool.name);
        }
      }
    } catch (err) {
      try {
        await client.close();
      } catch {
        /* already closed */
      }
      throw err;
    } finally {
      clearTimeout(connectTimer);
    }

    this.servers.set(serverId, {
      client,
      transport,
      toolNames,
      connectedAt: Date.now(),
      priorAttempts,
    });
    // Fires on stdio child exit (and on our own close() at shutdown, which
    // handleServerClosed ignores). Without it a dead server keeps its tools
    // registered and every call fails until a manual service restart.
    client.onclose = () => this.handleServerClosed(serverId, client, config);
    console.log(
      `[mcp] ${serverId}: connected, ${tools.length} tools (${toolNames.join(", ")})`,
    );
    if (unannotatedTools.length > 0) {
      console.warn(
        `[mcp] ${serverId}: ${unannotatedTools.length} tool(s) without hint overrides — will fall back to conservative-destructive defaults: ${unannotatedTools.join(", ")}`,
      );
    }
    if (trifectaTools.length > 0) {
      console.warn(
        `[mcp] ${serverId}: ${trifectaTools.length} tool(s) resolve as a Rule-of-Two TRIFECTA (untrusted-input ∧ sensitive-access ∧ state-change ⇒ forced high/confirm): ${trifectaTools.join(", ")} — classify in src/tools/rule-of-two.ts (RULE_OF_TWO_MCP_OVERRIDES) if that is not intended`,
      );
    }

    return { toolCount: tools.length };
  }

  /** Record a death in the rolling FLAP_WINDOW_MS; returns the window. */
  private recordDeath(serverId: string): number[] {
    const now = Date.now();
    const deaths = (this.deathTimes.get(serverId) ?? []).filter(
      (t) => now - t <= FLAP_WINDOW_MS,
    );
    deaths.push(now);
    this.deathTimes.set(serverId, deaths);
    return deaths;
  }

  /**
   * A connected server's transport closed. Outside shutdown that is a death:
   * move it to failedServers, alert once, and start the reconnect loop.
   * The identity check makes repeat close events for the same death (and
   * closes of a superseded client) no-ops.
   */
  private handleServerClosed(
    serverId: string,
    client: Client,
    config: McpServerConfig,
  ): void {
    if (this.isShutdown) return;
    const entry = this.servers.get(serverId);
    if (!entry || entry.client !== client) return;
    this.servers.delete(serverId);
    const now = Date.now();
    const deaths = this.recordDeath(serverId);
    const flapping =
      deaths.length >= FLAP_DEATHS_IN_WINDOW ||
      (entry.priorAttempts > 0 &&
        now - entry.connectedAt < STABLE_CONNECTION_MS);
    this.failedServers.set(serverId, {
      config,
      attempts: flapping ? entry.priorAttempts : 0,
      quiet: flapping,
    });
    if (flapping) {
      console.warn(
        `[mcp] ${serverId}: disconnected again ${Math.round((now - entry.connectedAt) / 1000)}s after connect, ${deaths.length} deaths in the last hour (flapping, attempt ${entry.priorAttempts}/${MAX_RECONNECT_ATTEMPTS})`,
      );
    } else {
      this.alert(
        `[mcp] ⚠️ DEGRADED: MCP server ${serverId} disconnected (${entry.toolNames.length} tools unavailable). Auto-reconnect started.`,
      );
    }
    this.startReconnectLoop();
  }

  /**
   * Register proxy tools for a lazy server without spawning its process.
   * The actual connection happens on first tool invocation.
   */
  private registerLazyServer(
    serverId: string,
    config: McpServerConfig,
    registry: ToolRegistry,
  ): string[] {
    const toolDefs = config.tools ?? [];
    const toolNames: string[] = [];
    const deferSet = new Set(config.deferredTools ?? []);

    for (const toolDef of toolDefs) {
      const namespacedName = `${serverId}${MCP_NAMESPACE_SEP}${toolDef.name}`;
      // Tag proxy tools so we can detect self-referencing after activation
      const proxyMarker = Symbol("lazy-proxy");
      // v7.6 Spine 4 W4 (shipped 2026-05-09): apply name-pattern hint
      // overrides to lazy proxies too, so the deferred-catalog view sees
      // the same hint cohort as eager tools. Without this, lazy tools
      // would default to destructive even after the bridge gets
      // activated. INVARIANT: this lookup must produce the same result
      // as `createMcpTool`'s lookup at activation time (resolveMcpToolHints;
      // server annotations are unknown until the server is spawned),
      // since both pass the same namespaced name to `getMcpToolHints`.
      // If a future split-lookup is introduced, both call sites must
      // remain in agreement or the proxy and post-activation tool will
      // disagree on hints — surface as a regression test before splitting.
      const hints = resolveMcpToolHints(
        namespacedName,
        undefined,
        config.toolTrust?.[toolDef.name],
      );
      const tool: Tool = {
        name: namespacedName,
        deferred: deferSet.has(toolDef.name),
        ...(hints && {
          readOnlyHint: hints.readOnlyHint,
          destructiveHint: hints.destructiveHint,
          idempotentHint: hints.idempotentHint,
          openWorldHint: hints.openWorldHint,
        }),
        definition: {
          type: "function",
          function: {
            name: namespacedName,
            description: toolDef.description,
            parameters: toolDef.inputSchema ?? {
              type: "object",
              properties: {},
            },
          },
        },
        execute: async (args: Record<string, unknown>): Promise<string> => {
          if (this.isShutdown) {
            return JSON.stringify({
              error: `MCP server ${serverId} is shut down`,
            });
          }
          // Connect the server on first call
          await this.activateLazyServer(serverId);
          if (this.isShutdown) {
            return JSON.stringify({
              error: `MCP server ${serverId} is shut down`,
            });
          }
          const realTool = registry.get(namespacedName);
          // Guard against infinite recursion: if the tool is still a proxy, fail
          if (
            !realTool ||
            (realTool as unknown as Record<symbol, boolean>)[proxyMarker]
          ) {
            return JSON.stringify({
              error: `Tool ${namespacedName} not available after lazy activation (server may expose different tool names)`,
            });
          }
          return realTool.execute(args);
        },
      };
      // Attach the proxy marker
      (tool as unknown as Record<symbol, boolean>)[proxyMarker] = true;
      registry.register(tool);
      toolNames.push(namespacedName);
    }

    this.lazyServers.set(serverId, { config, toolNames });
    console.log(
      `[mcp] ${serverId}: lazy-registered ${toolDefs.length} tools (will connect on first use)`,
    );
    return toolNames;
  }

  /**
   * Activate a lazy server: connect and replace proxy tools with real ones.
   * Safe for concurrent calls — only connects once.
   */
  private async activateLazyServer(serverId: string): Promise<void> {
    const lazy = this.lazyServers.get(serverId);
    if (!lazy) return; // already activated or not lazy

    // Deduplicate concurrent activations
    if (lazy.connecting) {
      await lazy.connecting;
      return;
    }

    const doConnect = async () => {
      console.log(`[mcp] ${serverId}: lazy activation — connecting...`);
      try {
        await this.connectServer(serverId, lazy.config, this.registry!);
        this.lazyServers.delete(serverId);
        console.log(`[mcp] ${serverId}: lazy activation complete`);
      } catch (err) {
        if (this.isShutdown) return; // shutdown raced the activation: quiet
        // Reset so next call retries instead of replaying cached rejection
        lazy.connecting = undefined;
        const msg = errMsg(err);
        this.alert(`[mcp] ⚠️ ${serverId}: lazy activation failed — ${msg}`);
        throw err;
      }
    };

    lazy.connecting = doConnect();
    await lazy.connecting;
  }

  /**
   * Periodically retry failed MCP server connections.
   * Stops when all servers are connected or max attempts exhausted.
   */
  private startReconnectLoop(): void {
    if (this.reconnectTimer) return; // already running
    if (this.failedServers.size === 0) return; // nothing to retry

    this.reconnectTimer = setInterval(async () => {
      if (this.reconnectInFlight) return; // previous tick still connecting
      if (this.failedServers.size === 0 || !this.registry) {
        this.stopReconnectLoop();
        return;
      }

      this.reconnectInFlight = true;
      try {
        await this.reconnectTick(this.registry);
      } finally {
        this.reconnectInFlight = false;
      }

      if (this.failedServers.size === 0) {
        this.stopReconnectLoop();
      }
    }, RECONNECT_INTERVAL_MS);
  }

  private async reconnectTick(registry: ToolRegistry): Promise<void> {
    // shutdown() clears failedServers, which ends this iteration.
    for (const [serverId, state] of this.failedServers) {
      if (state.attempts >= MAX_RECONNECT_ATTEMPTS) {
        // `attempts` counts failed reconnects plus reconnects that did not
        // stay up (carried over from flapping deaths).
        this.alert(
          `[mcp] ❌ ${serverId}: giving up after ${state.attempts} reconnect attempts that failed or did not stay up. Manual restart required.`,
        );
        this.failedServers.delete(serverId);
        this.deathTimes.delete(serverId);
        this.abandonedServers.add(serverId);
        continue;
      }

      // S6 WS3: a record server whose project left `active` is not respawned.
      const src = state.config.source;
      if (src?.kind === "record") {
        let status: string;
        try {
          status = this.currentProjectStatus(src.slug);
        } catch (err) {
          // Transient (e.g. SQLITE_BUSY): stay in the failed set, retry next tick.
          console.warn(`[mcp] ${serverId}: project ${src.slug} status unreadable (${errMsg(err)}); retrying next tick`);
          continue;
        }
        if (status !== "active") {
          console.warn(
            `[mcp] ${serverId}: not reconnected — project ${src.slug} is ${status}; unloaded until restart`,
          );
          this.failedServers.delete(serverId);
          this.deathTimes.delete(serverId);
          continue;
        }
      }

      try {
        const { toolCount } = await this.connectServer(
          serverId,
          state.config,
          registry,
          state.attempts + 1,
        );
        this.failedServers.delete(serverId);
        // Recovered before the boot alert could be delivered: drop it.
        if (this.failedServers.size === 0) this.pendingBootAlert = null;
        const msg = `[mcp] ✅ ${serverId}: reconnected (${toolCount} tools recovered, attempt ${state.attempts + 1})`;
        if (state.quiet) console.warn(msg);
        else this.alert(msg);
      } catch {
        if (this.isShutdown) return; // shutdown raced the attempt: quiet
        state.attempts++;
        console.warn(
          `[mcp] ${serverId}: reconnect attempt ${state.attempts}/${MAX_RECONNECT_ATTEMPTS} failed`,
        );
      }
    }
  }

  private stopReconnectLoop(): void {
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** Disconnect all MCP servers gracefully. */
  async shutdown(): Promise<void> {
    this.isShutdown = true;
    this.stopReconnectLoop();
    for (const [serverId, entry] of this.servers) {
      try {
        await entry.client.close();
      } catch (err) {
        console.warn(
          `[mcp] ${serverId}: close failed — ${errMsg(err)}`,
        );
      }
    }
    this.servers.clear();
    this.lazyServers.clear();
    this.failedServers.clear();
    this.deathTimes.clear();
    this.pendingBootAlert = null;
    console.log("[mcp] All servers disconnected");
  }

  /** Get connected server IDs (includes lazy-registered). */
  getServerIds(): string[] {
    return [
      ...Array.from(this.servers.keys()),
      ...Array.from(this.lazyServers.keys()),
    ];
  }

  /** Get failed server IDs (pending reconnection). */
  getFailedServerIds(): string[] {
    return Array.from(this.failedServers.keys());
  }

  /** Get total number of MCP tools registered (connected + lazy). */
  getToolCount(): number {
    let count = 0;
    for (const entry of this.servers.values()) {
      count += entry.toolNames.length;
    }
    for (const entry of this.lazyServers.values()) {
      count += entry.toolNames.length;
    }
    return count;
  }
}
