/**
 * Hindsight REST client — thin wrapper around native fetch.
 *
 * Covers the 5 Hindsight endpoints needed:
 * - retain (store observation)
 * - recall (semantic search)
 * - reflect (synthesize)
 * - bank CRUD (create/update)
 * - health check
 */

const DEFAULT_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HindsightRetainRequest {
  observation: string;
  tags?: string[];
  async?: boolean;
}

export interface HindsightRecallRequest {
  query: string;
  budget?: "low" | "mid" | "high";
  tags?: string[];
  max_results?: number;
}

export interface HindsightRecallResponse {
  memories: Array<{
    content: string;
    relevance: number;
    created_at?: string;
    type?: string;
  }>;
}

export interface HindsightReflectRequest {
  query: string;
  budget?: "low" | "mid" | "high";
  tags?: string[];
}

export interface HindsightReflectResponse {
  reflection: string;
}

export interface HindsightBankConfig {
  mission?: string;
  disposition?: string;
}

export interface HindsightHealthResponse {
  status: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class HindsightClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      h["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return h;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(),
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `Hindsight ${method} ${path}: ${response.status} ${text}`,
        );
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Store an observation in a memory bank. */
  async retain(bankId: string, req: HindsightRetainRequest): Promise<void> {
    await this.request(
      "POST",
      `/v1/default/banks/${bankId}/memories/retain`,
      req,
    );
  }

  /** Search memories by semantic similarity. */
  async recall(
    bankId: string,
    req: HindsightRecallRequest,
  ): Promise<HindsightRecallResponse> {
    return this.request<HindsightRecallResponse>(
      "POST",
      `/v1/default/banks/${bankId}/memories/recall`,
      req,
    );
  }

  /** Synthesize a reflection from stored memories. */
  async reflect(
    bankId: string,
    req: HindsightReflectRequest,
  ): Promise<HindsightReflectResponse> {
    return this.request<HindsightReflectResponse>(
      "POST",
      `/v1/default/banks/${bankId}/reflect`,
      req,
    );
  }

  /** Create or update a memory bank. */
  async upsertBank(bankId: string, config: HindsightBankConfig): Promise<void> {
    await this.request("PUT", `/v1/default/banks/${bankId}`, config);
  }

  /** Health check. */
  async health(): Promise<HindsightHealthResponse> {
    return this.request<HindsightHealthResponse>(
      "GET",
      "/v1/default/health",
      undefined,
      3000,
    );
  }
}
