# Jev / TypeSafe integration vs the vendor skill and live docs — review 2026-09-29

Read-only review of Jarvis's Jev integration against the `typesafe-ai` agent skill
(plugin `typesafe@typesafe-ai` 0.5.7, installed at user scope 2026-09-21, byte-identical
to upstream `main` on 2026-09-29) and the live docs it points to (`docs.typesafe.ai`,
read as `.md` on 2026-09-29: `api`, `models`, `sdk/javascript`, `primitives/noul`,
`confidence`, `concepts/state`, `patterns/fan-out`, `cookbooks/hierarchical_classification`,
`model-jaggedness/jev-1.13`, `legal`; `migrating-to-v1` 404s and is not in `llms.txt`).
Context: commit `6479254` (long_run withhold fix) moves Jev from ~10 % to ~86 % of Telegram
turns; deployed 2026-09-29 06:0x UTC.

## Verdicts

| # | Item | Verdict | Note |
|---|---|---|---|
| 1a | Endpoint `POST /v1/systemone`, Bearer, `{state, model, questions}` | compliant | `src/jev/client.ts` |
| 1b | Model pin `jev-1.13.0` | compliant | `jev-latest` → `jev-1.13.0`; docs say pin when thresholds are tuned; no deprecation date |
| 1c | Response: `answers[id].noul` read; `model` + `usage` ignored | gap | docs: log the response `model`; usage is billable input tokens |
| 1d | Errors: any non-2xx → `_failed` (no status), no retry, no breaker | gap | 401 (revoked key) is indistinguishable from 429/529 in `jev_shadow`; plan §C breaker never built |
| 1e | Limits (~5.8k tokens/request vs 64k) | compliant | |
| 2a | instructions + criteria, ids not sent, named state, backticked paths | compliant | `src/tuning/jev-scope-chain.ts` |
| 2b | "rules take precedence over the group description" sentence | drift | jaggedness #7: instructions vs criteria conflict confuses jev-1.13 |
| 2c | Cross-group exclusions live in the OTHER group's description | gap | questions are independent; an exclusion works only inside the question it suppresses |
| 2d | All rules + examples sent to every one of ~24 Nouls | drift | jaggedness #5: accuracy falls with unrelated state |
| 2e | No-match = empty set; `recent_context` flattened string | minor | docs: sequences as arrays |
| 2f | Shadow `feedback` instruction is a context statement, proposition only in criteria | drift | `src/jev/shadow.ts` |
| 3 | One request, all Nouls, same state | compliant | |
| 4a | `JEV_SCOPE_THRESHOLD = 0.7`, `p >= t`, no middle band | ruling | docs: lower when a missed yes is costly; operator ruled 89.5 % coverage enough (09-21) |
| 4b | Live calibration: `readout.ts` excludes scope (`ref IS NOT NULL`) | gap | live coverage at 0.70 is never measured |
| 5 | `DEADLINE_MS 1500` vs repo p95 ≈ 300 ms; no live p50/p95; cost not in ledger | telemetry gap | `jev_shadow.latency_ms` written, never summarized; ~$0.00024/turn |
| 6 | Privacy: not trained on requests; retention open-ended, ZDR enterprise-only | ruling | accepted misses of the withhold rule are retained on those terms |

## SDK `@typesafe-ai/sdk` 0.6.0 (2026-09-15)

Maintained, MIT, typed builders and error classes, retries with `retry-after`. Defaults work
against Jarvis (10 s per-attempt timeout, 2 retries, `jev-latest`, debug logs bodies). Saves
~15–20 lines of `askJev`; the withhold filter stays either way. Not adopted. Take one idea:
put the HTTP status in the `_failed` row.

## Act now (operator)

1. **Coverage watch.** Post-fix, Jev classifies ~86 % of turns at the offline-measured
   89.5 % group coverage (Spanish, n≈219; English 74 %, n=50). A missed group costs the
   #42 scope-ask re-run (~17 s vs ~5 s), not a failed turn. Summarize `jev_shadow` scope
   rows (`latency_ms`, `incumbent`) read-only after a day; decide whether 0.70 holds or a
   middle band (0.30–0.70 → union with Sonnet) is wanted. Ruling item.
2. **DPA retention.** The plan's "read the DPA first" is answered: no fixed retention
   period; ZDR is enterprise-only. Accept the two documented misses of the withhold rule
   on those terms, or not. Ruling item.

## Later (code, each small)

3. `_failed:<status>` in the `jev_shadow` item; log response `model` + `usage.input_tokens`.
4. Live scope readout: a scope bar in `src/jev/readout.ts` (or the deferred provider column).
5. Question design, then re-run the harness: drop the precedence sentence (2b); move each
   exclusion into the question it suppresses (2c); per-group structured `instructions`
   to shrink shared state (2d); reword the `feedback` shadow proposition (2f).
6. Plan §C leftovers: circuit breaker, cost-ledger row, `usage` logging.
7. Cheap speculative Nouls in the same request, shadow-only: fast-path gate
   ("answerable as small talk with no tool?") beside `isConversationalFastPath`;
   continuation ("does `message` continue `recent_context`?") beside the TTL prior.
8. Stale header comment in `src/messaging/scope-classifier-jev.ts` (guard reads whole
   turns, not the 150-char slice).
