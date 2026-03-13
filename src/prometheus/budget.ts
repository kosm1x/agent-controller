/**
 * IterationBudget — Shared counter for limiting total LLM calls across
 * an orchestration run. Node is single-threaded, so no locking needed.
 */

export class IterationBudget {
  private _consumed = 0;

  constructor(private readonly max: number) {}

  /** Try to consume one iteration. Returns false if budget exhausted. */
  consume(): boolean {
    if (this._consumed >= this.max) return false;
    this._consumed++;
    return true;
  }

  /** Refund one iteration (e.g., on retry that shouldn't count). */
  refund(): void {
    if (this._consumed > 0) this._consumed--;
  }

  /** Remaining iterations. */
  get remaining(): number {
    return Math.max(0, this.max - this._consumed);
  }

  /** Total consumed so far. */
  get consumed(): number {
    return this._consumed;
  }
}
