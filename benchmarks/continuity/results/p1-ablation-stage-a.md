# Continuity Scorecard: ablation report (P1 Stage A, post-hoc)

Computed from committed result JSONs by `scripts/continuity-bench/ablation.ts`; no run, no model.

| file | commit | leg | switches |
| --- | --- | --- | --- |
| jarvis-acee7f13-raw-emb-off-v2.json | acee7f13 | raw | MEMORY_OPEN_WORK=off, MEMORY_RECALL_FLOOR=off, MEMORY_TOMBSTONES=off |
| jarvis-acee7f13-ideal-emb-off-v2.json | acee7f13 | ideal | MEMORY_OPEN_WORK=off, MEMORY_RECALL_FLOOR=off, MEMORY_TOMBSTONES=off |
| jarvis-acee7f13-ideal-emb-off-v2-memory-tombstones-on.json | acee7f13 | ideal | MEMORY_OPEN_WORK=off, MEMORY_RECALL_FLOOR=off, MEMORY_TOMBSTONES=on |
| jarvis-4914f668-ideal-emb-off-v2-memory-recall-floor-on.json | 4914f668 | ideal | MEMORY_OPEN_WORK=off, MEMORY_RECALL_FLOOR=on |
| jarvis-4fc2fcf3-raw-emb-off-v2-memory-open-work-on.json | 4fc2fcf3 | raw | MEMORY_OPEN_WORK=on |

## jarvis-acee7f13-raw-emb-off-v2.json

Groups with no effect in this file (0 lost, 0 cleared, 0 C7 items): `essentials`, `jme`, `user_facts`, `open_work`.

### Without thread (thread, precedent)

| class | surface | size | hits | lost w/o G | stale | cleared w/o G |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | proactive | all | 172/288 | 12 | 0 | 0 |
| C1 | asked | all | 134/288 | 0 | 0 | 0 |
| C2 | proactive | all | 27/54 | 1 | 32 | 6 |
| C2 | asked | all | 14/54 | 0 | 24 | 0 |
| C3 | proactive | all | 396/612 | 36 | 0 | 0 |
| C4 | proactive | all | 180/252 | 18 | 0 | 0 |
| C5 | proactive | all | 68/96 | 0 | 0 | 0 |
| C5 | asked | all | 55/96 | 0 | 0 | 0 |
| C6 | proactive | all | 12/36 | 0 | 0 | 0 |
| C8 | proactive | all | 34/66 | 0 | 33 | 0 |
| C8 | asked | all | 34/66 | 0 | 33 | 0 |

### Without conv-recall (enrichment:Contexto relevante del usuario, memory_search)

| class | surface | size | hits | lost w/o G | stale | cleared w/o G |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | proactive | all | 172/288 | 76 | 0 | 0 |
| C1 | asked | all | 134/288 | 134 | 0 | 0 |
| C2 | proactive | all | 27/54 | 9 | 32 | 16 |
| C2 | asked | all | 14/54 | 14 | 24 | 24 |
| C3 | proactive | all | 396/612 | 216 | 0 | 0 |
| C4 | proactive | all | 180/252 | 72 | 0 | 0 |
| C5 | proactive | all | 68/96 | 36 | 0 | 0 |
| C5 | asked | all | 55/96 | 55 | 0 | 0 |
| C6 | proactive | all | 12/36 | 12 | 0 | 0 |
| C8 | proactive | all | 34/66 | 34 | 33 | 33 |
| C8 | asked | all | 34/66 | 34 | 33 | 33 |

### Without conversations* (thread, precedent, enrichment:Contexto relevante del usuario, memory_search, essentials, open_work)

| class | surface | size | hits | lost w/o G | stale | cleared w/o G |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | proactive | all | 172/288 | 172 | 0 | 0 |
| C1 | asked | all | 134/288 | 134 | 0 | 0 |
| C2 | proactive | all | 27/54 | 27 | 32 | 32 |
| C2 | asked | all | 14/54 | 14 | 24 | 24 |
| C3 | proactive | all | 396/612 | 396 | 0 | 0 |
| C4 | proactive | all | 180/252 | 180 | 0 | 0 |
| C5 | proactive | all | 68/96 | 68 | 0 | 0 |
| C5 | asked | all | 55/96 | 55 | 0 | 0 |
| C6 | proactive | all | 12/36 | 12 | 0 | 0 |
| C8 | proactive | all | 34/66 | 34 | 33 | 33 |
| C8 | asked | all | 34/66 | 34 | 33 | 33 |

### C7 noise (72 scored probe-surfaces; 148 proactive + 148 asked items)

| group | items (proactive) | items (asked) | share |
| --- | --- | --- | --- |
| thread | 0 | 0 | 0.0 % |
| conv-recall | 148 | 148 | 100.0 % |
| conversations* | 148 | 148 | 100.0 % |

### Ungrouped components

none (every component name in this file is in a group)

### Not attributable

none (0 split hits, 0 dropped blocks, 0 C7 count mismatches): the subset rule is exact for this file.

## jarvis-acee7f13-ideal-emb-off-v2.json

Groups with no effect in this file (0 lost, 0 cleared, 0 C7 items): `essentials`, `open_work`.

### Without thread (thread, precedent)

| class | surface | size | hits | lost w/o G | stale | cleared w/o G |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | proactive | all | 192/288 | 12 | 0 | 0 |
| C1 | asked | all | 156/288 | 0 | 0 | 0 |
| C2 | proactive | all | 36/54 | 1 | 32 | 6 |
| C2 | asked | all | 27/54 | 0 | 24 | 0 |
| C3 | proactive | all | 396/612 | 36 | 0 | 0 |
| C4 | proactive | all | 180/252 | 18 | 0 | 0 |
| C5 | proactive | all | 68/96 | 0 | 0 | 0 |
| C5 | asked | all | 55/96 | 0 | 0 | 0 |
| C6 | proactive | all | 36/36 | 0 | 0 | 0 |
| C8 | proactive | all | 34/66 | 0 | 33 | 0 |
| C8 | asked | all | 34/66 | 0 | 33 | 0 |

### Without conv-recall (enrichment:Contexto relevante del usuario, memory_search)

| class | surface | size | hits | lost w/o G | stale | cleared w/o G |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | proactive | all | 192/288 | 0 | 0 | 0 |
| C1 | asked | all | 156/288 | 12 | 0 | 0 |
| C2 | proactive | all | 36/54 | 2 | 32 | 16 |
| C2 | asked | all | 27/54 | 3 | 24 | 24 |
| C3 | proactive | all | 396/612 | 216 | 0 | 0 |
| C4 | proactive | all | 180/252 | 72 | 0 | 0 |
| C5 | proactive | all | 68/96 | 36 | 0 | 0 |
| C5 | asked | all | 55/96 | 55 | 0 | 0 |
| C6 | proactive | all | 36/36 | 0 | 0 | 0 |
| C8 | proactive | all | 34/66 | 1 | 33 | 33 |
| C8 | asked | all | 34/66 | 1 | 33 | 33 |

### Without jme (jme, jme_query)

| class | surface | size | hits | lost w/o G | stale | cleared w/o G |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | proactive | all | 192/288 | 20 | 0 | 0 |
| C1 | asked | all | 156/288 | 22 | 0 | 0 |
| C2 | proactive | all | 36/54 | 9 | 32 | 0 |
| C2 | asked | all | 27/54 | 13 | 24 | 0 |
| C3 | proactive | all | 396/612 | 0 | 0 | 0 |
| C4 | proactive | all | 180/252 | 0 | 0 | 0 |
| C5 | proactive | all | 68/96 | 0 | 0 | 0 |
| C5 | asked | all | 55/96 | 0 | 0 | 0 |
| C6 | proactive | all | 36/36 | 0 | 0 | 0 |
| C8 | proactive | all | 34/66 | 0 | 33 | 0 |
| C8 | asked | all | 34/66 | 0 | 33 | 0 |

### Without user_facts (profile, relevant_facts)

| class | surface | size | hits | lost w/o G | stale | cleared w/o G |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | proactive | all | 192/288 | 0 | 0 | 0 |
| C1 | asked | all | 156/288 | 0 | 0 | 0 |
| C2 | proactive | all | 36/54 | 0 | 32 | 0 |
| C2 | asked | all | 27/54 | 0 | 24 | 0 |
| C3 | proactive | all | 396/612 | 0 | 0 | 0 |
| C4 | proactive | all | 180/252 | 0 | 0 | 0 |
| C5 | proactive | all | 68/96 | 0 | 0 | 0 |
| C5 | asked | all | 55/96 | 0 | 0 | 0 |
| C6 | proactive | all | 36/36 | 24 | 0 | 0 |
| C8 | proactive | all | 34/66 | 0 | 33 | 0 |
| C8 | asked | all | 34/66 | 0 | 33 | 0 |

### Without conversations* (thread, precedent, enrichment:Contexto relevante del usuario, memory_search, essentials, open_work)

| class | surface | size | hits | lost w/o G | stale | cleared w/o G |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | proactive | all | 192/288 | 48 | 0 | 0 |
| C1 | asked | all | 156/288 | 12 | 0 | 0 |
| C2 | proactive | all | 36/54 | 12 | 32 | 32 |
| C2 | asked | all | 27/54 | 3 | 24 | 24 |
| C3 | proactive | all | 396/612 | 396 | 0 | 0 |
| C4 | proactive | all | 180/252 | 180 | 0 | 0 |
| C5 | proactive | all | 68/96 | 68 | 0 | 0 |
| C5 | asked | all | 55/96 | 55 | 0 | 0 |
| C6 | proactive | all | 36/36 | 0 | 0 | 0 |
| C8 | proactive | all | 34/66 | 1 | 33 | 33 |
| C8 | asked | all | 34/66 | 1 | 33 | 33 |

### C7 noise (72 scored probe-surfaces; 148 proactive + 148 asked items)

| group | items (proactive) | items (asked) | share |
| --- | --- | --- | --- |
| thread | 0 | 0 | 0.0 % |
| conv-recall | 148 | 148 | 100.0 % |
| jme | 0 | 0 | 0.0 % |
| user_facts | 0 | 0 | 0.0 % |
| conversations* | 148 | 148 | 100.0 % |

### Ungrouped components

none (every component name in this file is in a group)

### Not attributable

none (0 split hits, 0 dropped blocks, 0 C7 count mismatches): the subset rule is exact for this file.

## jarvis-acee7f13-ideal-emb-off-v2-memory-tombstones-on.json

Groups with no effect in this file (0 lost, 0 cleared, 0 C7 items): `essentials`, `open_work`.

### Without thread (thread, precedent)

| class | surface | size | hits | lost w/o G | stale | cleared w/o G |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | proactive | all | 192/288 | 12 | 0 | 0 |
| C1 | asked | all | 156/288 | 0 | 0 | 0 |
| C2 | proactive | all | 36/54 | 1 | 22 | 9 |
| C2 | asked | all | 27/54 | 0 | 9 | 0 |
| C3 | proactive | all | 396/612 | 36 | 0 | 0 |
| C4 | proactive | all | 180/252 | 18 | 0 | 0 |
| C5 | proactive | all | 68/96 | 0 | 0 | 0 |
| C5 | asked | all | 55/96 | 0 | 0 | 0 |
| C6 | proactive | all | 36/36 | 0 | 0 | 0 |
| C8 | proactive | all | 34/66 | 0 | 23 | 0 |
| C8 | asked | all | 34/66 | 0 | 23 | 0 |

### Without conv-recall (enrichment:Contexto relevante del usuario, memory_search)

| class | surface | size | hits | lost w/o G | stale | cleared w/o G |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | proactive | all | 192/288 | 0 | 0 | 0 |
| C1 | asked | all | 156/288 | 12 | 0 | 0 |
| C2 | proactive | all | 36/54 | 2 | 22 | 6 |
| C2 | asked | all | 27/54 | 3 | 9 | 9 |
| C3 | proactive | all | 396/612 | 216 | 0 | 0 |
| C4 | proactive | all | 180/252 | 72 | 0 | 0 |
| C5 | proactive | all | 68/96 | 36 | 0 | 0 |
| C5 | asked | all | 55/96 | 55 | 0 | 0 |
| C6 | proactive | all | 36/36 | 0 | 0 | 0 |
| C8 | proactive | all | 34/66 | 1 | 23 | 23 |
| C8 | asked | all | 34/66 | 1 | 23 | 23 |

### Without jme (jme, jme_query)

| class | surface | size | hits | lost w/o G | stale | cleared w/o G |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | proactive | all | 192/288 | 20 | 0 | 0 |
| C1 | asked | all | 156/288 | 22 | 0 | 0 |
| C2 | proactive | all | 36/54 | 9 | 22 | 0 |
| C2 | asked | all | 27/54 | 13 | 9 | 0 |
| C3 | proactive | all | 396/612 | 0 | 0 | 0 |
| C4 | proactive | all | 180/252 | 0 | 0 | 0 |
| C5 | proactive | all | 68/96 | 0 | 0 | 0 |
| C5 | asked | all | 55/96 | 0 | 0 | 0 |
| C6 | proactive | all | 36/36 | 0 | 0 | 0 |
| C8 | proactive | all | 34/66 | 0 | 23 | 0 |
| C8 | asked | all | 34/66 | 0 | 23 | 0 |

### Without user_facts (profile, relevant_facts)

| class | surface | size | hits | lost w/o G | stale | cleared w/o G |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | proactive | all | 192/288 | 0 | 0 | 0 |
| C1 | asked | all | 156/288 | 0 | 0 | 0 |
| C2 | proactive | all | 36/54 | 0 | 22 | 0 |
| C2 | asked | all | 27/54 | 0 | 9 | 0 |
| C3 | proactive | all | 396/612 | 0 | 0 | 0 |
| C4 | proactive | all | 180/252 | 0 | 0 | 0 |
| C5 | proactive | all | 68/96 | 0 | 0 | 0 |
| C5 | asked | all | 55/96 | 0 | 0 | 0 |
| C6 | proactive | all | 36/36 | 24 | 0 | 0 |
| C8 | proactive | all | 34/66 | 0 | 23 | 0 |
| C8 | asked | all | 34/66 | 0 | 23 | 0 |

### Without conversations* (thread, precedent, enrichment:Contexto relevante del usuario, memory_search, essentials, open_work)

| class | surface | size | hits | lost w/o G | stale | cleared w/o G |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | proactive | all | 192/288 | 48 | 0 | 0 |
| C1 | asked | all | 156/288 | 12 | 0 | 0 |
| C2 | proactive | all | 36/54 | 12 | 22 | 22 |
| C2 | asked | all | 27/54 | 3 | 9 | 9 |
| C3 | proactive | all | 396/612 | 396 | 0 | 0 |
| C4 | proactive | all | 180/252 | 180 | 0 | 0 |
| C5 | proactive | all | 68/96 | 68 | 0 | 0 |
| C5 | asked | all | 55/96 | 55 | 0 | 0 |
| C6 | proactive | all | 36/36 | 0 | 0 | 0 |
| C8 | proactive | all | 34/66 | 1 | 23 | 23 |
| C8 | asked | all | 34/66 | 1 | 23 | 23 |

### C7 noise (72 scored probe-surfaces; 148 proactive + 148 asked items)

| group | items (proactive) | items (asked) | share |
| --- | --- | --- | --- |
| thread | 0 | 0 | 0.0 % |
| conv-recall | 148 | 148 | 100.0 % |
| jme | 0 | 0 | 0.0 % |
| user_facts | 0 | 0 | 0.0 % |
| conversations* | 148 | 148 | 100.0 % |

### Ungrouped components

none (every component name in this file is in a group)

### Not attributable

none (0 split hits, 0 dropped blocks, 0 C7 count mismatches): the subset rule is exact for this file.

## jarvis-4914f668-ideal-emb-off-v2-memory-recall-floor-on.json

Groups with no effect in this file (0 lost, 0 cleared, 0 C7 items): `essentials`, `open_work`.

### Without thread (thread, precedent)

| class | surface | size | hits | lost w/o G | stale | cleared w/o G |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | proactive | all | 192/288 | 12 | 0 | 0 |
| C1 | asked | all | 144/288 | 0 | 0 | 0 |
| C2 | proactive | all | 23/36 | 0 | 24 | 6 |
| C2 | asked | all | 17/36 | 0 | 18 | 0 |
| C3 | proactive | all | 396/612 | 36 | 0 | 0 |
| C4 | proactive | all | 180/252 | 18 | 0 | 0 |
| C5 | proactive | all | 60/96 | 0 | 0 | 0 |
| C5 | asked | all | 43/96 | 0 | 0 | 0 |
| C6 | proactive | all | 36/36 | 0 | 0 | 0 |
| C8 | proactive | all | 18/36 | 0 | 18 | 0 |
| C8 | asked | all | 18/36 | 0 | 18 | 0 |

### Without conv-recall (enrichment:Contexto relevante del usuario, memory_search)

| class | surface | size | hits | lost w/o G | stale | cleared w/o G |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | proactive | all | 192/288 | 0 | 0 | 0 |
| C1 | asked | all | 144/288 | 0 | 0 | 0 |
| C2 | proactive | all | 23/36 | 1 | 24 | 0 |
| C2 | asked | all | 17/36 | 2 | 18 | 0 |
| C3 | proactive | all | 396/612 | 216 | 0 | 0 |
| C4 | proactive | all | 180/252 | 72 | 0 | 0 |
| C5 | proactive | all | 60/96 | 28 | 0 | 0 |
| C5 | asked | all | 43/96 | 43 | 0 | 0 |
| C6 | proactive | all | 36/36 | 0 | 0 | 0 |
| C8 | proactive | all | 18/36 | 0 | 18 | 18 |
| C8 | asked | all | 18/36 | 0 | 18 | 18 |

### Without jme (jme, jme_query)

| class | surface | size | hits | lost w/o G | stale | cleared w/o G |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | proactive | all | 192/288 | 18 | 0 | 0 |
| C1 | asked | all | 144/288 | 27 | 0 | 0 |
| C2 | proactive | all | 23/36 | 4 | 24 | 0 |
| C2 | asked | all | 17/36 | 6 | 18 | 0 |
| C3 | proactive | all | 396/612 | 0 | 0 | 0 |
| C4 | proactive | all | 180/252 | 0 | 0 | 0 |
| C5 | proactive | all | 60/96 | 0 | 0 | 0 |
| C5 | asked | all | 43/96 | 0 | 0 | 0 |
| C6 | proactive | all | 36/36 | 0 | 0 | 0 |
| C8 | proactive | all | 18/36 | 0 | 18 | 0 |
| C8 | asked | all | 18/36 | 0 | 18 | 0 |

### Without user_facts (profile, relevant_facts)

| class | surface | size | hits | lost w/o G | stale | cleared w/o G |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | proactive | all | 192/288 | 0 | 0 | 0 |
| C1 | asked | all | 144/288 | 0 | 0 | 0 |
| C2 | proactive | all | 23/36 | 0 | 24 | 0 |
| C2 | asked | all | 17/36 | 0 | 18 | 0 |
| C3 | proactive | all | 396/612 | 0 | 0 | 0 |
| C4 | proactive | all | 180/252 | 0 | 0 | 0 |
| C5 | proactive | all | 60/96 | 0 | 0 | 0 |
| C5 | asked | all | 43/96 | 0 | 0 | 0 |
| C6 | proactive | all | 36/36 | 26 | 0 | 0 |
| C8 | proactive | all | 18/36 | 0 | 18 | 0 |
| C8 | asked | all | 18/36 | 0 | 18 | 0 |

### Without conversations* (thread, precedent, enrichment:Contexto relevante del usuario, memory_search, essentials, open_work)

| class | surface | size | hits | lost w/o G | stale | cleared w/o G |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | proactive | all | 192/288 | 48 | 0 | 0 |
| C1 | asked | all | 144/288 | 0 | 0 | 0 |
| C2 | proactive | all | 23/36 | 8 | 24 | 6 |
| C2 | asked | all | 17/36 | 2 | 18 | 0 |
| C3 | proactive | all | 396/612 | 396 | 0 | 0 |
| C4 | proactive | all | 180/252 | 180 | 0 | 0 |
| C5 | proactive | all | 60/96 | 60 | 0 | 0 |
| C5 | asked | all | 43/96 | 43 | 0 | 0 |
| C6 | proactive | all | 36/36 | 0 | 0 | 0 |
| C8 | proactive | all | 18/36 | 0 | 18 | 18 |
| C8 | asked | all | 18/36 | 0 | 18 | 18 |

### C7 noise (72 scored probe-surfaces; 47 proactive + 47 asked items)

| group | items (proactive) | items (asked) | share |
| --- | --- | --- | --- |
| thread | 0 | 0 | 0.0 % |
| conv-recall | 47 | 47 | 100.0 % |
| jme | 0 | 0 | 0.0 % |
| user_facts | 0 | 0 | 0.0 % |
| conversations* | 47 | 47 | 100.0 % |

### Ungrouped components

none (every component name in this file is in a group)

### Not attributable

none (0 split hits, 0 dropped blocks, 0 C7 count mismatches): the subset rule is exact for this file.

## jarvis-4fc2fcf3-raw-emb-off-v2-memory-open-work-on.json

Groups with no effect in this file (0 lost, 0 cleared, 0 C7 items): `essentials`, `jme`, `user_facts`.

### Without thread (thread, precedent)

| class | surface | size | hits | lost w/o G | stale | cleared w/o G |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | proactive | all | 172/288 | 12 | 0 | 0 |
| C1 | asked | all | 134/288 | 0 | 0 | 0 |
| C2 | proactive | all | 24/36 | 0 | 24 | 6 |
| C2 | asked | all | 11/36 | 0 | 18 | 0 |
| C3 | proactive | all | 540/612 | 36 | 0 | 0 |
| C4 | proactive | all | 180/252 | 18 | 0 | 0 |
| C5 | proactive | all | 70/96 | 0 | 0 | 0 |
| C5 | asked | all | 55/96 | 0 | 0 | 0 |
| C6 | proactive | all | 12/36 | 0 | 0 | 0 |
| C8 | proactive | all | 18/36 | 0 | 19 | 0 |
| C8 | asked | all | 18/36 | 0 | 19 | 0 |

### Without conv-recall (enrichment:Contexto relevante del usuario, memory_search)

| class | surface | size | hits | lost w/o G | stale | cleared w/o G |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | proactive | all | 172/288 | 76 | 0 | 0 |
| C1 | asked | all | 134/288 | 134 | 0 | 0 |
| C2 | proactive | all | 24/36 | 4 | 24 | 12 |
| C2 | asked | all | 11/36 | 11 | 18 | 18 |
| C3 | proactive | all | 540/612 | 72 | 0 | 0 |
| C4 | proactive | all | 180/252 | 72 | 0 | 0 |
| C5 | proactive | all | 70/96 | 34 | 0 | 0 |
| C5 | asked | all | 55/96 | 55 | 0 | 0 |
| C6 | proactive | all | 12/36 | 12 | 0 | 0 |
| C8 | proactive | all | 18/36 | 18 | 19 | 19 |
| C8 | asked | all | 18/36 | 18 | 19 | 19 |

### Without open_work (open_work)

| class | surface | size | hits | lost w/o G | stale | cleared w/o G |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | proactive | all | 172/288 | 0 | 0 | 0 |
| C1 | asked | all | 134/288 | 0 | 0 | 0 |
| C2 | proactive | all | 24/36 | 5 | 24 | 0 |
| C2 | asked | all | 11/36 | 0 | 18 | 0 |
| C3 | proactive | all | 540/612 | 144 | 0 | 0 |
| C4 | proactive | all | 180/252 | 0 | 0 | 0 |
| C5 | proactive | all | 70/96 | 2 | 0 | 0 |
| C5 | asked | all | 55/96 | 0 | 0 | 0 |
| C6 | proactive | all | 12/36 | 0 | 0 | 0 |
| C8 | proactive | all | 18/36 | 0 | 19 | 0 |
| C8 | asked | all | 18/36 | 0 | 19 | 0 |

### Without conversations* (thread, precedent, enrichment:Contexto relevante del usuario, memory_search, essentials, open_work)

| class | surface | size | hits | lost w/o G | stale | cleared w/o G |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | proactive | all | 172/288 | 172 | 0 | 0 |
| C1 | asked | all | 134/288 | 134 | 0 | 0 |
| C2 | proactive | all | 24/36 | 24 | 24 | 24 |
| C2 | asked | all | 11/36 | 11 | 18 | 18 |
| C3 | proactive | all | 540/612 | 540 | 0 | 0 |
| C4 | proactive | all | 180/252 | 180 | 0 | 0 |
| C5 | proactive | all | 70/96 | 70 | 0 | 0 |
| C5 | asked | all | 55/96 | 55 | 0 | 0 |
| C6 | proactive | all | 12/36 | 12 | 0 | 0 |
| C8 | proactive | all | 18/36 | 18 | 19 | 19 |
| C8 | asked | all | 18/36 | 18 | 19 | 19 |

### C7 noise (72 scored probe-surfaces; 148 proactive + 148 asked items)

| group | items (proactive) | items (asked) | share |
| --- | --- | --- | --- |
| thread | 0 | 0 | 0.0 % |
| conv-recall | 148 | 148 | 100.0 % |
| open_work | 0 | 0 | 0.0 % |
| conversations* | 148 | 148 | 100.0 % |

### Ungrouped components

none (every component name in this file is in a group)

### Not attributable

none (0 split hits, 0 dropped blocks, 0 C7 count mismatches): the subset rule is exact for this file.

**How to read.** A hit is lost without G iff every component that carried it (held every expect needle) is in G; a stale hit is cleared without G iff every component that carried a forbidden needle is in G. Co-carried hits survive single-group ablations, so a single group's loss is a floor and `conversations*` shows the joint loss of every conversations reader. C7 items are the query-driven items each group returned for a topic that never appeared (the scorer's irrelevantCount). Stores the corpus never writes (mc-operational / `enrichment:Aprendizajes previos`, KG, KB, day-logs) move nothing here: they are not measured by this corpus, never "no value".
