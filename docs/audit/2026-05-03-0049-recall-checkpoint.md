# Recall Tuning Validation — 24h Checkpoint

_Generated: 2026-05-03T00:49:18Z UTC by recall-checkpoint.timer_
_Window: last 24h (post 2026-05-03 Path-1 tune)_

Baseline to compare:
- May 2 aggregate utility: **22.2%** (n=108, hid 88% mc-op + 7% mc-jarvis)
- May 3 30-query A/B post-tune: Hindsight 19/30 (63%); mc-operational 15/15 (100%); mc-jarvis 4/15 (27%)
- H/D/R hypothesis: HARDEN mc-operational + DEMOTE mc-jarvis

---

## 1. `mc-ctl recall-utility 24h`

```
=== Recall Utility (last 24h) ===

  Total recalls:    179
  Matched (marked): 118
  Pending (NULL):   61

Utility by source:
  source                  n   used     pct%  dropped   avg_ms
  sqlite-fallback        64     18     28.1       57   5372.0
  hindsight              47      9     19.1       47   3235.0
  circuit-open            7      0      0.0        0    254.0

Utility by bank:
  bank                    n   used     pct%
  mc-operational         58      9     15.5
  mc-jarvis              57     18     31.6
  mc-system               3      0      0.0

Utility by match type:
  match_type              n  avg_score
  none                   91       0.28
  token-overlap          27       0.79

```

## 2. Bank × source breakdown

```
BANK               SOURCE             TOTAL  USED  ERR%  AVG_LAT
----               ------             -----  ----  ----  -------
mc-jarvis          sqlite-fallback       82    16   1.0   5322.0
mc-jarvis          hindsight              4     2   0.0   4049.0
mc-operational     hindsight             70     7   0.0   2881.0
mc-operational     sqlite-fallback       13     2   8.0   5113.0
mc-operational     circuit-open           7     0   0.0    271.0
mc-system          circuit-open           2     0   0.0    208.0
mc-system          sqlite-fallback        1     0   0.0    267.0
```

## 3. `was_used` match-type distribution

```
MATCH_TYPE           N  AVG_SCORE
----------           -  ---------
none                91      0.279
token-overlap       27      0.794
```

## 4. Circuit breaker activity (last 24h)

```
May 02 15:02:41 srv1369957 mission-control[1770722]: [memory] Circuit breaker: half-open, retrying Hindsight
May 02 15:02:41 srv1369957 mission-control[1770722]: [memory] Hindsight circuit open — recall falling back to SQLite
May 02 18:30:17 srv1369957 mission-control[1770722]: [memory] Circuit breaker OPEN after 3 failures. Cooldown: 60s. Last error: fetch failed
May 02 20:19:54 srv1369957 mission-control[1770722]: [memory] Circuit breaker: half-open, retrying Hindsight
May 02 20:19:54 srv1369957 mission-control[1770722]: [memory] Hindsight circuit open — recall falling back to SQLite
May 02 20:19:59 srv1369957 mission-control[1770722]: [memory] Circuit breaker OPEN after 4 failures. Cooldown: 60s. Last error: This operation was aborted
May 02 20:21:11 srv1369957 mission-control[1770722]: [memory] Circuit breaker: half-open, retrying Hindsight
May 02 20:21:11 srv1369957 mission-control[1770722]: [memory] Hindsight circuit open — recall falling back to SQLite
May 02 20:21:16 srv1369957 mission-control[1770722]: [memory] Circuit breaker OPEN after 5 failures. Cooldown: 60s. Last error: This operation was aborted
May 02 20:22:33 srv1369957 mission-control[1770722]: [memory] Circuit breaker: half-open, retrying Hindsight
May 02 20:22:33 srv1369957 mission-control[1770722]: [memory] Hindsight circuit open — recall falling back to SQLite
May 02 20:22:38 srv1369957 mission-control[1770722]: [memory] Circuit breaker OPEN after 6 failures. Cooldown: 60s. Last error: This operation was aborted
May 02 20:28:28 srv1369957 mission-control[1770722]: [memory] Circuit breaker: half-open, retrying Hindsight
May 02 20:28:28 srv1369957 mission-control[1770722]: [memory] Hindsight circuit open — recall falling back to SQLite
May 02 20:28:33 srv1369957 mission-control[1770722]: [memory] Circuit breaker OPEN after 7 failures. Cooldown: 60s. Last error: This operation was aborted
May 02 20:30:12 srv1369957 mission-control[1770722]: [memory] Circuit breaker: half-open, retrying Hindsight
May 03 00:25:53 srv1369957 mission-control[1770722]: [memory] Circuit breaker OPEN after 3 failures. Cooldown: 60s. Last error: This operation was aborted
May 03 00:25:53 srv1369957 mission-control[1770722]: [memory] Circuit breaker OPEN after 4 failures. Cooldown: 60s. Last error: This operation was aborted
May 03 00:27:03 srv1369957 mission-control[1770722]: [memory] Circuit breaker: half-open, retrying Hindsight
May 03 00:27:03 srv1369957 mission-control[1770722]: [memory] Hindsight circuit open — recall falling back to SQLite
```

## 5. Hindsight bank sizes (latest from monitor)

```
mc-operational  77    green  2026-05-03 00:36:13
mc-jarvis       1735  red    2026-05-03 00:36:13
mc-operational  69    green  2026-05-03 00:21:10
mc-jarvis       1705  red    2026-05-03 00:21:10
```

## 6. Verdict for the 5/13 H/D/R decision

- **Aggregate utility (24h)**: 22.9% (n=118) — baseline May 2 was 22.2% (n=108)
- **mc-operational Hindsight utility**: 15.9% (n=44)
- **mc-jarvis Hindsight utility**: INSUFFICIENT DATA — n=3, need ≥10

**Hypothesis check** (thresholds: HARDEN ≥15%, DEMOTE ≤20%):
- HARDEN mc-operational → 15.9% ≥ 15%, **supports HARDEN**.
- DEMOTE mc-jarvis → INSUFFICIENT DATA (n=3, need ≥10). No verdict.

_Raw verdict — mechanical comparison against documented thresholds. Operator must confirm against bank size growth (currently ~7 mems/hr on mc-jarvis), latency cost, and qualitative top-3 quality from the next `mc-ctl recall-compare` run._
