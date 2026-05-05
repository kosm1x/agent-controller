# Recall Tuning Validation — 24h Checkpoint

_Generated: 2026-05-04T01:00:01Z UTC by recall-checkpoint.timer_
_Window: last 24h (post 2026-05-03 Path-1 tune)_

Baseline to compare:
- May 2 aggregate utility: **22.2%** (n=108, hid 88% mc-op + 7% mc-jarvis)
- May 3 30-query A/B post-tune: Hindsight 19/30 (63%); mc-operational 15/15 (100%); mc-jarvis 4/15 (27%)
- H/D/R hypothesis: HARDEN mc-operational + DEMOTE mc-jarvis

---

## 1. `mc-ctl recall-utility 24h`

```
=== Recall Utility (last 24h) ===

  Total recalls:    216
  Matched (marked): 136
  Pending (NULL):   80

Utility by source:
  source                  n   used     pct%  dropped   avg_ms
  hindsight              91     14     15.4      270   2879.0
  sqlite-fallback        45      9     20.0       19   7695.0

Utility by bank:
  bank                    n   used     pct%
  mc-jarvis              69     21     30.4
  mc-operational         67      2      3.0

Utility by match type:
  match_type              n  avg_score
  none                  113        0.2
  token-overlap          22       0.64
  verbatim                1        1.0

```

## 2. Bank × source breakdown

```
BANK               SOURCE             TOTAL  USED  ERR%  AVG_LAT
----               ------             -----  ----  ----  -------
mc-jarvis          sqlite-fallback       56     7  89.0   7975.0
mc-jarvis          hindsight             49    14   2.0   4520.0
mc-operational     hindsight             84     0   0.0   2225.0
mc-operational     sqlite-fallback       26     2  77.0   6606.0
mc-system          hindsight              1     0   0.0    110.0
```

## 3. `was_used` match-type distribution

```
MATCH_TYPE           N  AVG_SCORE
----------           -  ---------
none               113        0.2
token-overlap       22      0.644
verbatim             1        1.0
```

## 4. Circuit breaker activity (last 24h)

```
May 03 05:46:17 srv1369957 mission-control[1802665]: │   │   ├── circuit-breaker.ts     # Reusable circuit breaker
May 03 06:49:26 srv1369957 mission-control[1802665]: [memory] Circuit breaker OPEN after 3 failures. Cooldown: 60s. Last error: This operation was aborted
```

## 5. Hindsight bank sizes (latest from monitor)

```
mc-operational  41    green  2026-05-04 00:55:23
mc-jarvis       1589  red    2026-05-04 00:55:23
mc-operational  41    green  2026-05-04 00:25:20
mc-jarvis       1448  red    2026-05-04 00:25:20
```

## 6. Verdict for the 5/13 H/D/R decision

- **Aggregate utility (24h)**: 16.9% (n=136) — baseline May 2 was 22.2% (n=108)
- **mc-operational Hindsight utility**: 0.0% (n=52)
- **mc-jarvis Hindsight utility**: 35.9% (n=39)

**Hypothesis check** (thresholds: HARDEN ≥15%, DEMOTE ≤20%):
- HARDEN mc-operational → 0.0% < 15%, **does NOT support HARDEN**. Re-investigate.
- DEMOTE mc-jarvis → 35.9% > 20%, **does NOT support DEMOTE**. Hindsight is earning its keep here.

_Raw verdict — mechanical comparison against documented thresholds. Operator must confirm against bank size growth (currently ~7 mems/hr on mc-jarvis), latency cost, and qualitative top-3 quality from the next `mc-ctl recall-compare` run._
