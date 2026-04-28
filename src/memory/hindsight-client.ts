/**
 * Hindsight REST client — thin wrapper around native fetch.
 *
 * Covers the 5 Hindsight endpoints needed:
 * - retain (store observation)
 * - recall (semantic search)
 * - reflect (synthesize)
 * - bank CRUD (create/update)
 * - health check
 *
 * Aligned with Hindsight API v2 (ghcr.io/vectorize-io/hindsight:latest as of 2026-03).
 */

const DEFAULT_TIMEOUT_MS = 5000;
/**
 * Per-method timeout for recall — user-facing path must fail fast.
 * Hindsight's agentic recall empirically takes ~9s under load (2026-04-22
 * measurement), which is 100% timeout fire at DEFAULT_TIMEOUT_MS. Shortening
 * lets us fail to SQLite fallback (~300ms) sooner. See
 * `docs/audit/2026-04-22-speed.md` S7.
 */
// Bumped 2026-04-28 from 1500 → env-configurable, default 3000ms.
// Production data: at 1500ms cap, 4/6 recall calls were timing out (1501-1527ms,
// classic timeout-jitter signature). Hindsight successful calls clustered at
// 895-1341ms, so a 3000ms ceiling captures the slow tail without inflating
// the dead-tax. Override via HINDSIGHT_RECALL_TIMEOUT_MS env var if tuning needed.
const RECALL_TIMEOUT_MS = parseInt(
  process.env.HINDSIGHT_RECALL_TIMEOUT_MS ?? "3000",
  10,
);

// ---------------------------------------------------------------------------
// Types (matching Hindsight API v2 schemas)
// ---------------------------------------------------------------------------

export interface HindsightRetainRequest {
  content: string;
  tags?: string[];
  async?: boolean;
}

export interface HindsightRecallRequest {
  query: string;
  budget?: "low" | "mid" | "high";
  tags?: string[];
}

export interface HindsightRecallResponse {
  results: Array<{
    id: string;
    text: string;
    type?: string;
  }>;
}

export interface HindsightReflectRequest {
  query: string;
  budget?: "low" | "mid" | "high";
}

export interface HindsightReflectResponse {
  text: string;
}

export interface HindsightBankConfig {
  reflect_mission?: string;
  retain_mission?: string;
  observations_mission?: string;
}

export interface HindsightHealthResponse {
  status: string;
}

export interface MentalModelCreateRequest {
  id?: string;
  name: string;
  source_query: string;
  tags?: string[];
  max_tokens?: number;
  trigger?: { refresh_after_consolidation?: boolean };
}

export interface MentalModelResponse {
  id: string;
  bank_id: string;
  name: string;
  source_query: string;
  content: string;
  tags: string[];
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
    await this.request("POST", `/v1/default/banks/${bankId}/memories`, {
      items: [{ content: req.content, tags: req.tags }],
      async: req.async ?? true,
    });
  }

  /** Search memories by semantic similarity. */
  async recall(
    bankId: string,
    req: HindsightRecallRequest,
  ): Promise<HindsightRecallResponse> {
    return this.request<HindsightRecallResponse>(
      "POST",
      `/v1/default/banks/${bankId}/memories/recall`,
      { query: req.query, budget: req.budget, tags: req.tags },
      RECALL_TIMEOUT_MS,
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
      { query: req.query, budget: req.budget },
    );
  }

  /** Create or update a memory bank. */
  async upsertBank(bankId: string, config: HindsightBankConfig): Promise<void> {
    await this.request("PUT", `/v1/default/banks/${bankId}`, config);
  }

  // -------------------------------------------------------------------------
  // Mental Models
  // -------------------------------------------------------------------------

  /** Create a mental model in a bank. Idempotent if ID already exists. */
  async createMentalModel(
    bankId: string,
    model: MentalModelCreateRequest,
  ): Promise<MentalModelResponse> {
    return this.request<MentalModelResponse>(
      "POST",
      `/v1/default/banks/${bankId}/mental-models`,
      model,
    );
  }

  /** Get a mental model's current content. */
  async getMentalModel(
    bankId: string,
    modelId: string,
  ): Promise<MentalModelResponse> {
    return this.request<MentalModelResponse>(
      "GET",
      `/v1/default/banks/${bankId}/mental-models/${modelId}`,
      undefined,
      3000,
    );
  }

  /** Trigger a refresh of a mental model's content. */
  async refreshMentalModel(bankId: string, modelId: string): Promise<void> {
    await this.request(
      "POST",
      `/v1/default/banks/${bankId}/mental-models/${modelId}/refresh`,
    );
  }

  /** Health check. */
  async health(): Promise<HindsightHealthResponse> {
    return this.request<HindsightHealthResponse>(
      "GET",
      "/health",
      undefined,
      3000,
    );
  }
}
