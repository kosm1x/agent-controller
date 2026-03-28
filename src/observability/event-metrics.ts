/**
 * COMMIT event processing metrics — count by table, latency, suggestion stats.
 *
 * In-memory counters reset on restart. Exposed via /health.
 */

interface TableMetrics {
  count: number;
  totalLatencyMs: number;
  lastEventAt: string | null;
}

class EventMetrics {
  private readonly tables = new Map<string, TableMetrics>();
  private totalProcessed = 0;

  /** Record a COMMIT event received and its processing time. */
  record(table: string, latencyMs: number): void {
    this.totalProcessed++;

    if (!this.tables.has(table)) {
      this.tables.set(table, {
        count: 0,
        totalLatencyMs: 0,
        lastEventAt: null,
      });
    }
    const m = this.tables.get(table)!;
    m.count++;
    m.totalLatencyMs += latencyMs;
    m.lastEventAt = new Date().toISOString();
  }

  /** Get summary for health endpoint. */
  getSummary(): {
    totalProcessed: number;
    avgLatencyMs: number;
    byTable: Record<string, { count: number; avgLatencyMs: number }>;
  } {
    const byTable: Record<string, { count: number; avgLatencyMs: number }> = {};
    let totalLatency = 0;

    for (const [table, m] of this.tables) {
      byTable[table] = {
        count: m.count,
        avgLatencyMs: m.count > 0 ? Math.round(m.totalLatencyMs / m.count) : 0,
      };
      totalLatency += m.totalLatencyMs;
    }

    return {
      totalProcessed: this.totalProcessed,
      avgLatencyMs:
        this.totalProcessed > 0
          ? Math.round(totalLatency / this.totalProcessed)
          : 0,
      byTable,
    };
  }
}

export const eventMetrics = new EventMetrics();
