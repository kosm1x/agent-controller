# Screenwriting corpus — distillation and verification log (2026-09-12)

Plan: `screenwriting-corpus-adoption-plan.md` Phase 1. Source: jtydhr88/screenwriting-skills v2.0.0 (Chinese bodies), cloned read-only into the session scratchpad and deleted once the verification pass and the R1 audit folds were complete (operator ruling 4; deletion recorded in PROJECT-STATUS 2026-09-12c).

## Distillation

12 parallel agents, one per source skill, under a shared brief (`seed/knowledge/screenwriting/DISTILL-BRIEF.md`): English only, method not text, no quotations, same sections and checklist counts as the source, original English craft vocabulary, correct attribution, byte cap per doc. Two docs could not meet their cap without dropping mandated tables and were accepted larger (the KB already holds 20 KB docs):

| Doc | Cap | Landed | Checklists (source = output) |
|---|---|---|---|
| 01 workflow + story bible | 12 K | 12.0 K | self-check 6 |
| 02 premise / theme / logline | 14 K | 14.0 K | 12-step procedure, 5-item self-check, Hicks 5, ailments 8 |
| 03 story structure | 16 K | 16.0 K | diagnostic 13, workflow 12, BS2 15 beats |
| 04 character and conflict | 16 K | 15.9 K | diagnostic 14, eight musts 8, workflow 10 |
| 05 dialogue | 14 K | 13.9 K | diagnostic 13 (the plan said 14; the source has 13) |
| 06 scene craft | 14 K | 14.0 K | diagnostic 13, workflow 9 |
| 07 format / Fountain / adaptation | 14 K | 13.9 K | general 12 + spec 7 (Asian formats dropped by instruction) |
| 08 series structure | 16 K | **20.9 K** (accepted) | diagnostic 19, Story Map 18, workflow 14, training 14 |
| 09 series engine and bible | 16 K | 16.0 K | engine 10, web 10, pilot/docs 10, reader 1, debt 2 |
| 10 writers' room and notes | 12 K | **14.9 K** (accepted) | diagnostic 35 in six groups, workflow 12, exercises 10 |
| 11 half-hour comedy | 12 K | 12.0 K | diagnostic 29 in five groups |
| 12 terms | 8 K | 7.3 K | 84 terms, all from the source table |

Authored (not distilled): 00 index, 13 short-form commercial, 14 promo piece 20 s.

## Verification (bilingual, 4 agents × 3 docs)

Method: 10 substantive claims per doc (15 for docs 10 and 12), each located in the Chinese source and classed CONFIRMED / MISATTRIBUTED / INVENTED / DISTORTED / QUOTED; checklist counts re-counted; CJK scan; attribution-without-source scan. Verifiers fixed local items in place (≤300 bytes per doc).

| Doc | Sampled | Confirmed | Misattributed | Invented | Distorted | Quoted | All fixed |
|---|---|---|---|---|---|---|---|
| 01 | 10 | 10 | 0 | 0 | 0 | 0 | — |
| 02 | 10 | 7 | 0 | 0 | 1 (three vs five moves ahead) | 2 (Lu Xun, Tolstoy maxims) | yes |
| 03 | 10 | 10 | 0 | 0 | 0 | 0 | — |
| 04 | 12 | 10 | 1 (Hauge → Hoxter, 3 sites) | 0 | 1 (Nora's arc missing a step) | 0 | yes |
| 05 | 13 | 10 | 0 | 0 | 0 | 3 (McKee maxims paraphrased) | yes |
| 06 | 13 | 10 | 1 (Lao She's example, not Lu Jun's) | 1 (step-outline line format: it comes from sw-workflow, re-sourced to doc 01) | 1 (Molière formula missing a step) | 0 | yes |
| 07 | 10 | 9 | 0 | 0 | 1 (page one → first pages) | 0 | yes |
| 08 | 10 | 7 | 0 | 0 | 3 (Story Map 17→18; a shifted act-table row; tally 5→6) | 0 | yes |
| 09 | 10 | 10 | 0 | 0 | 0 | 0 | — |
| 10 | 15 | 15 | 0 | 0 | 0 | 0 | — |
| 11 | 15 | 13 | 1 (Prebble, not Armstrong) | 0 | 1 (scene range flattened) | 0 | yes |
| 12 | 15 | 14 | 1 ("the board" credited to Snyder; source leaves it uncredited) | 0 | 0 | 0 | yes |

Totals: 143 claims sampled · 125 confirmed · 4 misattributed · 1 cross-sourced · 8 distorted · 5 quoted · 0 unresolved. Every checklist count matches its source. No CJK characters remain in any doc.

Notes carried forward, not changed: Hicks' "ten elements" lists 11 items in source and output alike; Landau's "11-item" pitch recipe lists 10 in both.

## Registration

KB docs are registered through `scripts/seed-screenwriting.ts` MODE=kb (upsertFile → `jarvis_files` `knowledge/screenwriting/NN-*.md` + FS mirror) after the R1 audit folds; skills through MODE=skills (critic gate, version rows, test-runner certification). The live counts at ship time are in PROJECT-STATUS 2026-09-12c.
