/**
 * A2A RPC client for outbound delegation.
 *
 * Sends JSON-RPC requests to external A2A agents and caches their agent cards.
 * Used by the a2a-runner to delegate tasks to remote agents.
 */

import type {
  A2AAgentCard,
  A2ATask,
  A2AMessage,
  JsonRpcResponse,
} from "./types.js";

// ---------------------------------------------------------------------------
// Agent Card Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  card: A2AAgentCard;
  expiresAt: number;
}

export class AgentCardCache {
  private cache = new Map<string, CacheEntry>();

  /**
   * Fetch an agent card, returning cached version if still valid.
   * @param baseUrl The base URL of the remote A2A agent.
   * @param ttlMs Cache TTL in milliseconds (default 5 minutes).
   */
  async fetch(baseUrl: string, ttlMs = 300_000): Promise<A2AAgentCard> {
    const cached = this.cache.get(baseUrl);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.card;
    }

    const url = new URL("/.well-known/agent.json", baseUrl).toString();
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      throw new Error(
        `Failed to fetch agent card from ${url}: ${res.status} ${res.statusText}`,
      );
    }

    const card = (await res.json()) as A2AAgentCard;

    this.cache.set(baseUrl, {
      card,
      expiresAt: Date.now() + ttlMs,
    });

    return card;
  }

  /** Invalidate a cached agent card. */
  invalidate(baseUrl: string): void {
    this.cache.delete(baseUrl);
  }

  /** Clear the entire cache. */
  clear(): void {
    this.cache.clear();
  }
}

// Shared singleton
export const agentCardCache = new AgentCardCache();

// ---------------------------------------------------------------------------
// RPC Client
// ---------------------------------------------------------------------------

export class A2ARpcClient {
  private nextId = 1;

  constructor(
    private baseUrl: string,
    private apiKey?: string,
  ) {}

  /** Send a message to create a new task on the remote agent. */
  async sendMessage(message: A2AMessage, contextId?: string): Promise<A2ATask> {
    const params: Record<string, unknown> = { message };
    if (contextId) params.contextId = contextId;
    return this.rpc("sendMessage", params) as Promise<A2ATask>;
  }

  /** Get a task by ID from the remote agent. */
  async getTask(taskId: string): Promise<A2ATask> {
    return this.rpc("getTask", { taskId }) as Promise<A2ATask>;
  }

  /** Cancel a task on the remote agent. */
  async cancelTask(taskId: string): Promise<A2ATask> {
    return this.rpc("cancelTask", { taskId }) as Promise<A2ATask>;
  }

  /** Send a JSON-RPC request to the remote A2A endpoint. */
  private async rpc(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
      id,
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    // Support both X-Api-Key and Bearer auth
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
      headers["X-Api-Key"] = this.apiKey;
    }

    const url = new URL("/a2a", this.baseUrl).toString();
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      throw new Error(`A2A RPC failed: ${res.status} ${res.statusText}`);
    }

    const json = (await res.json()) as JsonRpcResponse;

    if (json.error) {
      throw new Error(
        `A2A RPC error [${json.error.code}]: ${json.error.message}`,
      );
    }

    return json.result;
  }
}
