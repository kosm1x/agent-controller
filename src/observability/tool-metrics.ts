/**
 * Per-tool execution metrics — call count, success/failure, latency.
 *
 * In-memory rolling window (last 100 entries per tool). Exposed via /health.
 * Pattern mirrors providerMetrics in inference/adapter.ts.
 */

interface ToolEntry {
  timestamp: number;
  latencyMs: number;
  success: boolean;
}

interface ToolStats {
  calls: number;
  successes: number;
  failures: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  lastCalledAt: string | null;
}

const WINDOW_SIZE = 100;

class ToolMetrics {
  private readonly entries = new Map<string, ToolEntry[]>();

  /** Record a tool execution result. */
  record(name: string, latencyMs: number, success: boolean): void {
    if (!this.entries.has(name)) {
      this.entries.set(name, []);
    }
    const arr = this.entries.get(name)!;
    arr.push({ timestamp: Date.now(), latencyMs, success });
    if (arr.length > WINDOW_SIZE) {
      arr.splice(0, arr.length - WINDOW_SIZE);
    }
  }

  /** Get stats for a single tool. */
  getStats(name: string): ToolStats | null {
    const arr = this.entries.get(name);
    if (!arr || arr.length === 0) return null;

    const successes = arr.filter((e) => e.success).length;
    const latencies = arr.map((e) => e.latencyMs).sort((a, b) => a - b);
    const avg = latencies.reduce((s, v) => s + v, 0) / latencies.length;
    const p95Idx = Math.min(
      Math.floor(latencies.length * 0.95),
      latencies.length - 1,
    );

    return {
      calls: arr.length,
      successes,
      failures: arr.length - successes,
      avgLatencyMs: Math.round(avg),
      p95LatencyMs: latencies[p95Idx],
      lastCalledAt: new Date(arr[arr.length - 1].timestamp).toISOString(),
    };
  }

  /** Get summary for health endpoint: total calls, top by latency, top by errors. */
  getSummary(): {
    totalCalls: number;
    toolCount: number;
    topByLatency: Array<{ name: string; avgLatencyMs: number }>;
    topByErrors: Array<{ name: string; failures: number }>;
  } {
    let totalCalls = 0;
    const allStats: Array<{ name: string; stats: ToolStats }> = [];

    for (const name of this.entries.keys()) {
      const stats = this.getStats(name);
      if (stats) {
        totalCalls += stats.calls;
        allStats.push({ name, stats });
      }
    }

    const topByLatency = allStats
      .sort((a, b) => b.stats.avgLatencyMs - a.stats.avgLatencyMs)
      .slice(0, 5)
      .map((s) => ({ name: s.name, avgLatencyMs: s.stats.avgLatencyMs }));

    const topByErrors = allStats
      .filter((s) => s.stats.failures > 0)
      .sort((a, b) => b.stats.failures - a.stats.failures)
      .slice(0, 5)
      .map((s) => ({ name: s.name, failures: s.stats.failures }));

    return {
      totalCalls,
      toolCount: allStats.length,
      topByLatency,
      topByErrors,
    };
  }
}

export const toolMetrics = new ToolMetrics();
