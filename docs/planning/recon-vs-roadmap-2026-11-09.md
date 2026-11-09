# Recon vs roadmap (2026-11-09)

Source: `origin/main` e2df31cf (66 commits after the 11-06 recon base 3b397f1) and `docs/ROADMAP.md` (60 lines, at its cap). Production figures this time come from the VPS itself (live build 68991e63, read-only `mc.db`), not from roadmap claims.

## Beta tests

| Test | 11-06 | 11-09 | Movement |
| --- | --- | --- | --- |
| Replicability | no commits on profile, WS4, WS6 or the synthetic-operator suite | same: 0 of the 66 commits touch them | None since 10-18 (22 days) |
| Teachability | onboarding guide and transfer attempt not started | same | None |
| Scalability | language, identity, timezone, paths still behind the unbuilt profile | same | None |
| Credibility | W1 `enforce` armed 02:10 UTC 11-06, unproven | W1 `enforce` graded 3 nightly roots (05:01 UTC 11-06, 11-07, 11-08: 7/7, 8/8, 8/8 criteria met) → grading PROVEN; the demotion path (a failed criterion in enforce) is still unexercised. Eval gate PASS 11-07 (78.68 vs 78.63). W3 unchanged, next readout ≈ 11-13 | Step: the proof the 11-06 recon asked for arrived |

## Workstreams
- W1: enforce proven on grading; still owed: the first failed criterion under enforce, then the cause of the one false positive (queue 4bi).
- W3: step 2 live, weekly `./mc-ctl eval 7` by hand (last 11-06, next ≈ 11-13); the two rituals that always end with concerns stay open (queue 4bj); 60 tasks `completed_with_concerns` since 11-06.
- W2, W4, W6, L4: no code. L3 A2A: no consumer date.
- Pending from the monthly review (11-01), none started: MCP v2 ruling and date; SDK bump (still 0.3.285 at recon time; 0.3.316 is the newest past the 7-day release-age rule, 0.3.319 refused by it — DEPLOYED 06:21 UTC `f12bc403`, gate PASS 78.90 vs 78.63); memory duplicate-rate readout.

## Operator work since 11-06 (66 commits, 1 of them the weekly durability commit)
Memory ports 1–4 built dormant and armed shadow/shadow/record 11-07 (readout ≈ 11-14); SDK auto-memory leak into every call fixed (gate PASS); overnight event-loop blocks diagnosed and the canary fixed; Telegram poll observer; leaked Supabase service key rotated and all alerts closed 11-08; every `projects` write attributed (schema v15/v16); tombstone lifecycle; watchdog yields to the KB janitor; thread hydration bounded; weekly review rewritten and re-enabled (first run Sun 11-15 20:00 MX); continuity bench calibrated on the real nightly ledger; 6 GB memory fence on agent test runs. 14,444 tests (14,213 on 11-06).

## Reading
Credibility keeps moving and now carries the proof it lacked three days ago. Every one of the 66 commits since 11-06 went to memory, operations or security; none to the operator profile. Replicability and Teachability, which decide whether Beta 1.0 is more than "works for the first operator", have been still for 22 days. Same gap as on 11-06, three days older.

## Next (same order as 11-06; item 1a is done, the rest has not started)
1. Operator: (a) first enforce-mode grade review DONE 11-09 (3 grades, all met); (b) rule on the MCP v2 date and the A2A consumer date.
2. Operator: SDK bump 0.3.285 → 0.3.316 with `npm run eval:gate -- --run` — DONE 11-09 06:21 UTC (`f12bc403`, gate PASS 78.90 vs 78.63; tool-search validation PASS 5/5).
3. A session for the operator profile (the first S6 step that moves Replicability and Scalability together), then the onboarding guide.
