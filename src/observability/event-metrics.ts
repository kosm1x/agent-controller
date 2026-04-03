/**
 * Event webhook response metrics — count by table, response latency.
 *
 * Rolling window (last 200 entries). Resets on restart.
 * NOTE: Latency measures webhook response time only (parsing + DB insert +
 * handler setup), NOT the async reaction processing time (fire-and-forget).
 */

interface EventEntry {
  table: string;
  latencyMs: number;
  timestamp: number;
}

const WINDOW_SIZE = 200;

class EventMetrics {
  private readonly entries: EventEntry[] = [];

  /** Record an event webhook response. */
  record(table: string, latencyMs: number): void {
    this.entries.push({ table, latencyMs, timestamp: Date.now() });
    if (this.entries.length > WINDOW_SIZE) {
      this.entries.splice(0, this.entries.length - WINDOW_SIZE);
    }
  }

  /** Get summary for health endpoint. */
  getSummary(): {
    totalProcessed: number;
    avgWebhookLatencyMs: number;
    byTable: Record<string, { count: number; avgLatencyMs: number }>;
  } {
    const byTable: Record<string, { count: number; totalLatencyMs: number }> =
      {};
    let totalLatency = 0;

    for (const e of this.entries) {
      if (!byTable[e.table]) {
        byTable[e.table] = { count: 0, totalLatencyMs: 0 };
      }
      byTable[e.table].count++;
      byTable[e.table].totalLatencyMs += e.latencyMs;
      totalLatency += e.latencyMs;
    }

    const result: Record<string, { count: number; avgLatencyMs: number }> = {};
    for (const [table, m] of Object.entries(byTable)) {
      result[table] = {
        count: m.count,
        avgLatencyMs: m.count > 0 ? Math.round(m.totalLatencyMs / m.count) : 0,
      };
    }

    return {
      totalProcessed: this.entries.length,
      avgWebhookLatencyMs:
        this.entries.length > 0
          ? Math.round(totalLatency / this.entries.length)
          : 0,
      byTable: result,
    };
  }
}

export const eventMetrics = new EventMetrics();
