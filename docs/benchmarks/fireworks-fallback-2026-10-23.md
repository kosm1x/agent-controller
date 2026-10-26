# Fireworks fallback benchmark — 2026-10-23

RECOMMENDED: qwen3p8-max

## Run config

- models: minimax-m3, minimax-m3p1-flash, glm-5p3-flash, glm-5p3, deepseek-v4p1-flash, kimi-k3, qwen3p8-max, gpt-oss-120b
- tool cases scored: 34 (unreachable, excluded: 4 — ts-wp-publish-01, ts-wp-status-01, ts-http-01, ts-batch-decompose-01)
- chat prompts: 5
- tool definitions registered: 193; per-case offered min/median/max: 30/43/78
- tool sources: builtin, builtin WP/CRM/GWS groups, google, skills, memory(backend_independent)
- concurrency 2 per model, models sequential; temperature 0; max_tokens 1024; system prompt: none (mirrors the eval gate's default probe)
- reasoning_effort: not sent
- vs the eval gate: probe rounds 1 (gate default 3); unweighted mean (gate weights by case weight)

## Scores

| rank | model | accuracy | scored | tool-call validity | p50 tool ms | p95 tool ms | p50 chat ms | p95 chat ms | `<think>` leaks | reasoning_content | errors | $/1M in/out | price src | run cost | note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | qwen3p8-max | 67.6% | 34 | 100.0% | 2296 | 4321 | 2162 | 6602 | 0 | 39 | 0/39 | 2.00 / 6.00 | builtin | $1.2341 |  |
| 2 | gpt-oss-120b | 61.8% | 34 | 100.0% | 1476 | 4043 | 1006 | 5796 | 0 | 39 | 0/39 | 0.15 / 0.60 | builtin | $0.0770 |  |
| 3 | glm-5p3-flash | 61.8% | 34 | 100.0% | 2146 | 4363 | 7939 | 8739 | 0 | 39 | 0/39 | 0.15 / 0.50 | builtin | $0.0904 |  |
| 4 | minimax-m3p1-flash | 58.8% | 34 | 100.0% | 1435 | 3062 | 3735 | 7901 | 0 | 28 | 0/39 | 0.15 / 0.60 | builtin | $0.0935 |  |
| 5 | minimax-m3 | 58.8% | 34 | 100.0% | 1454 | 4027 | 2483 | 4570 | 0 | 39 | 0/39 | 0.30 / 1.20 | builtin | $0.1838 |  |
| 6 | deepseek-v4p1-flash | 58.8% | 34 | 100.0% | 1675 | 2819 | 4461 | 10047 | 0 | 39 | 0/39 | 0.30 / 1.20 | builtin | $0.1880 |  |
| 7 | glm-5p3 | 58.8% | 34 | 100.0% | 2877 | 33969 | 11750 | 15857 | 0 | 39 | 0/39 | 1.40 / 4.40 | builtin | $0.8552 |  |
| 8 | kimi-k3 | 58.8% | 34 | 100.0% | 7047 | 13778 | 19333 | 30610 | 0 | 39 | 0/39 | 3.00 / 15.00 | builtin | $1.7732 |  |

Accuracy = mean eval-gate `scoreToolSelection` score over the scored cases (hit = any offered expected tool called; a forbidden tool called scores 0; an errored call scores 0). Ranking: accuracy desc, p50 tool latency asc, run cost asc. Unranked: any HTTP 404/401 during the run, or > 20% errors.

## Dropped candidates

none

## Catalog (serverless + tools, not deprecated)

| id | context | deprecation | $/1M in/out |
|---|---|---|---|
| deepseek-v4p1-flash | 1048576 | — | n/a |
| deepseek-v4p1-flash-1017 | 1048576 | — | n/a |
| ember-1 | 1048576 | — | n/a |
| glm-5p3 | 1048576 | — | n/a |
| glm-5p3-flash | 1048576 | — | n/a |
| gpt-oss-120b | 131072 | 2026-11-07 | n/a |
| inkling | 1048576 | 2026-11-07 | n/a |
| kimi-k3 | 1048576 | — | n/a |
| minimax-m3 | 512000 | — | n/a |
| minimax-m3p1-flash | 1048576 | — | n/a |
| muse-spark-open | 1048576 | — | n/a |
| nemotron-3-ultra-nvfp4 | 262144 | 2026-11-07 | n/a |
| nemotron-lightning-3p5-30b-a3b | 262144 | 2026-11-07 | n/a |
| qwen3p8-2p4t-a95b | 262144 | — | n/a |
| qwen3p8-max | 0 | — | n/a |

Note (added after this run): all 15 rows show `n/a` because this account's ListModels/GetModel return `serverlessModes: []` (verified 2026-10-23 18:31 UTC; the serverless-list endpoint answers 403), so the Scores prices came from the builtin table (`price src` column).
`qwen3p8-max` context `0` is the API's own value, not a parse error.
The renderer now prints a `price source` column here and maps a non-positive context to `n/a`.
