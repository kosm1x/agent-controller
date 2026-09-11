/**
 * email-verify — bounded TTL cache. One instance per concern (MX per domain,
 * catch-all per domain, result per address) so a batch over N addresses at
 * the same domain costs one MX lookup and one catch-all probe, not N.
 */

export class TtlCache<V> {
  private readonly map = new Map<string, { value: V; expires: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 5000,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): void {
    if (this.map.size >= this.maxEntries && !this.map.has(key)) {
      // Map preserves insertion order: drop the oldest entry.
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.delete(key);
    this.map.set(key, { value, expires: this.now() + this.ttlMs });
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
