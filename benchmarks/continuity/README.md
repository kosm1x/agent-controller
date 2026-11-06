# Continuity Scorecard (v1, v2)

A repeatable, offline, no-LLM test of agent memory continuity. A memory system
ingests a scripted conversation history, then answers probes. Each probe is
scored on what **reaches the model**: whether the right fact is there, whether a
stale or forbidden one is there too, which kind of context carried it, how many
characters it costs, and how long it takes. Any system can be scored on the same
corpus file by writing an adapter. Jarvis's adapter is
`scripts/continuity-bench/adapter-jarvis.ts`.

```bash
V2=benchmarks/continuity/corpus-v2.json
npx tsx scripts/continuity-bench/run.ts --leg raw   --sizes 50,500,5000 --corpus $V2
npx tsx scripts/continuity-bench/run.ts --leg ideal --sizes 50,500,5000 --corpus $V2
npx tsx scripts/continuity-bench/run.ts --report results/a.json,results/b.json --md results/jarvis-baseline-v2.md
npx tsx scripts/continuity-bench/generate.ts [--check]                          # v1 corpus + golden
npx tsx scripts/continuity-bench/generate.ts --corpus-version continuity-v2 [--check]   # v2 corpus
```

v2 has 444 scenarios and 1140 probes (380 per filler size). A leg takes about
150 s on the VPS, most of it at size 5000. The default output name is
`results/jarvis-<sha>-<leg>-emb-<on|off>-v2.json`.

**v1 vs v2.** `corpus-v1.json`, `filler-golden.json`, the filler algorithm and
the v1 results are frozen. v2 is a new corpus file built on the same filler. It
adds a gap axis for C3/C4, author cases for C5, a wording label on every probe,
and paired probes in C2, C6, C7 and C8. Every v2 field is optional, so a v1
reader still parses v2 and a v1 result still scores.

## What is measured

Each probe has two surfaces.

- **proactive** is what the system injects at turn start without being asked:
  thread history, profile, essentials, enrichment and fact injection.
- **asked** is what an explicit memory search with the probe text returns.

A probe declares which surfaces it is scored on (`surface`: `both` |
`proactive` | `asked`). Each scored surface gets these fields:

| field | meaning |
| --- | --- |
| `hit` | every `expect` needle appears in the surface. For C7 (empty `expect`) it means no **query-driven** item came back. |
| `staleHit` | any `forbid` needle appears |
| `chars` / `ms` | total characters (component texts joined by `\n\n`) and wall time to assemble the surface |
| `recallItems` / `irrelevantCount` | items from query-driven components. For C7 every one is irrelevant. |
| `authorMarked` | C5, strict: some occurrence is attributed to `expectAuthor`, and every occurrence is attributed to a role in `statedBy` (rule below) |
| `authorMarkedAny` | C5: at least one occurrence is (the v1 rule) |
| `attributionConflict` | C5: an occurrence sits on a line marked for one role inside a block whose heading names the other |
| `carriedBy` / `carriedKinds` | names and kinds (`thread` / `recall` / `ambient`) of the components that held an expect needle |
| `staleCarriedBy` | the components that held a forbid needle |
| `notMeasurable` | the adapter declared the surface `measurable: false`. It is shown as "not scored", never as a miss. |

**Matching.** Needle and text are both Unicode NFC normalized and lower-cased.
Diacritics are significant: "cancion" does not match "canción". The corpus
writes every needle exactly as its events do, so nothing in it needed accent
folding.

**Aggregation.** Results are aggregated per class × filler size × surface. Each
row reports:

- hit %, also split by wording (shared / disjoint)
- stale-hit %
- carried-by shares (thread / recall / ambient) and the thread-only share
- median chars and median ms

C3/C4 are aggregated per variant × K, pooled over sizes. C5 is aggregated per
author case. C7 is reported only beside C1 from the same run.

### Classes (6 bases each; v2 at filler sizes 50, 500, 5000)

| class | what it asks | v2 probes |
| --- | --- | --- |
| C1 old-fact | a person fact stated once on day 0 | the same 4 phrasings (2 shared, 2 disjoint) at days 1, 7, 30, 90, so age and wording are separate axes |
| C2 correction-wins | fact on day 0, correction on day 5 | day 10, one shared + one disjoint question; expect the new value, forbid the old one |
| C3 where-were-we | open work left at a session end, then K gap exchanges | day 3, a greeting (disjoint) and a topical question (shared); proactive only |
| C4 restart-mid-thread | as C3, the gap on the same day, then a real restart | same day, after the restart; proactive only |
| C5 who-said-it | a figure stated by the assistant, by the person, or by both (echo, either order) | day 2, two probes; `expectAuthor` = who stated it first |
| C6 standing-preference-under-volume | a standing instruction, then filler | day 30, two unrelated questions; proactive only |
| C7 nothing-to-recall | a topic never mentioned | day 14, two probes; anything query-driven returned is noise |
| C8 forgetting-done-right | a durable fact and a "this week only" fact | day 120, two probes; expect the durable one, forbid the temporary one |

**C3/C4 gap axis (K).** The filler sits before the session, so filler size says
nothing about the thread. In v2 the axis is **K**, the number of primary-channel
exchanges between the `session_end` and the probe. They are explicit `exchange`
events drawn from the filler generator, and none of them holds a needle. The
values are `K ∈ {0, 5, 14, 15, 16, 20, 60}`. They straddle Jarvis's 15-row
thread buffer (`THREAD_BUFFER_SIZE`, router.ts): K = 14 still holds the open
work, and K = 15 is the first K that pushes it out.

Variants (`scenario.variant`):

- `hydrate`: a process that never held the thread loads it from the store.
- `live`: the process held the thread as it happened. K = 5 and 16 only.
- `interleave`: K = 5 plus 20 exchanges on a second channel (`channel: "secondary"`).
- `restart`: C4 only. A real process restart comes after the gap.

The size axis still runs, so the K numbers are pooled over the three sizes.

**C5 author cases (`probe.authorCase`).**

| case | probes per size |
| --- | --- |
| `assistant` | 12 |
| `person` | 12 |
| `echo-person-first` | 4 |
| `echo-assistant-first` | 4 |

At least half the C5 probes share no content word with the person's own turns,
so a search on the question's words cannot simply re-find the user line.

## Wording rule (`wording.ts`)

`probe.wording` is `"shared"` or `"disjoint"`. It is computed mechanically by
`wordingOf` and checked on every build.

1. **Content tokens.** NFC-normalize and lower-case the text. Take the runs of
   `[\p{L}\p{N}]+` that are at least 3 characters long and are not in
   `STOPWORDS`. There is no stemming.
   - `STOPWORDS` is a short es + en list of function words, greetings and
     memory verbs ("recuerdas", "dijiste", "remind", "told").
   - The full list is in `wording.ts`.
2. **Target events.** These are the events whose user, assistant or extracted
   text contains an expect needle. For C7 (no needle), every event is a target.
3. **Label.** A probe is `shared` if any of its content tokens appears in a
   target event. Otherwise it is `disjoint`.

"Disjoint" means the probe shares no content word with the target under this
documented, system-neutral list. It is not computed with any system's own
tokenizer or search. A system can still reach a disjoint target through
function words, substring matching, a recency fallback, or meaning.

**How clean the split is.** `validateCorpus` also measures how many disjoint
probes share *any* token of 3+ characters with their target, stopwords
included. The generator prints that figure and stores it in the corpus header
as `wordingAudit` (`disjointProbes`, `disjointSharingAnyToken3`, `leaks`).
- v2 started at 38 of 178 disjoint probes per size (before K = 15 was added),
  mostly "the", "para", "que" and "you".
- The disjoint phrasings were reworded, and five v1 probe texts got v2-only
  rewordings, keeping each request's meaning.
- It is now **0 of 570**: no disjoint probe shares a word of 3+ characters
  with its target, function words included.
- Substring matches (LIKE) and a recency fallback can still reach the target. Every class is between 40 % and 60 % shared, and at
size 50 every class is exactly 50 / 50.

## Corpus format

```ts
{ version: "continuity-v1" | "continuity-v2", seed, fillerSizes: [50, 500, 5000],
  fillerSpec: { algorithm: "xorshift32-template-v1", templates, vocab },
  scenarios: [{ id, class, base, lang: "es"|"en", fillerSize, fillerSeed, fillerFromT, fillerToT,
                gapRows?, variant?, otherChannelRows?,              // v2, C3/C4
                events: Event[], probes: Probe[] }] }
```

v2 ids: `C1-01-s500` and similar; C3 `C3-01-h14-s500` (hydrate K 14), `C3-01-l16-…` (live),
`C3-01-i5x20-…` (interleave); C4 `C4-01-r14-…`.

- **Time.** `t` is in seconds since day 0 00:00 UTC (it can be negative), and `day` is `floor(t / 86400)`.
  Events use even `t` and filler uses odd `t`, so no two timeline items share a second.
- **Event** has the fields `{ day, t, session, kind, channel?, ... }`. `channel` is
  `"primary"` (the default) or `"secondary"`. A secondary row belongs to
  another chat channel of the same person.
  - `exchange` has `{ user, assistant }`.
  - `person_fact` has `{ text, durable, asUser, asAssistant }`. `text` is the third-person fact, the form a
    perfect extractor would store. `durable: false` marks a temporary fact.
  - `correction` has `{ targetEventIndex, text, asUser, asAssistant }`.
  - `session_end` has `{ openWork, asUser, asAssistant }`.
  - `standing` has `{ text, asUser, asAssistant }`.
  - `restart` has `{ asUser: "", asAssistant: "" }`. Restart the process before the next probe.

  Every non-exchange kind carries `asUser` / `asAssistant`: how the event looked as a
  chat exchange. A system that stores only transcripts stores that.
- **Probe** has the fields `{ day, t, session, text, expect[], forbid[], surface, expectAuthor?, wording?, authorCase? }`.
- **Timeline for a probe.** It is every event and every filler item with `t < probe.t`. Each probe sees
  only its own past.
- **Guarantees.** `generate.ts` checks these on every build (`validateCorpus`):
  - every needle occurs in the events, and no filler item holds one
  - probes come after the last event, in time order
  - no C7 probe topic occurs in its events
  - every wording label equals `wordingOf`
  - each C5 needle sits on the side its `authorCase` says (user only, assistant only, or both in the stated order)
  - C3/C4: exactly `gapRows` primary and `otherChannelRows` secondary exchanges sit between `session_end` and the probe, none holds a needle, and none comes after the restart

## Filler algorithm (`xorshift32-template-v1`, unchanged)

The filler is regenerated from `fillerSpec` + `fillerSeed` + `fillerSize` +
`[fillerFromT, fillerToT)`. It is not stored in the corpus.

1. **PRNG.** Use xorshift32 on uint32 state. Seed 0 is replaced by `0x9E3779B9`. Each draw runs:
   `x ^= x << 13; x ^= x >>> 17; x ^= x << 5` (each step mod 2^32) and returns `x`.
   For seed 1 the first three draws are `270369, 67634689, 2647435461`.
2. **Timestamps.** `span = toT - fromT`. Item `k` (0-based) gets `t = fromT + 2*floor(k*span / (2*size)) + 1`.
   `fromT` is always even.
3. **Draws per item, in this order:**
   1. language: `next() % 2` (0 = `es`, 1 = `en`)
   2. user template: `next() % len`
   3. the user template's slots, left to right
   4. assistant template: `next() % len`
   5. the assistant template's slots, left to right
4. **Slots.** A `{slot}` is replaced by `vocab[lang][slot][next() % len]`. `{n}` is `2 + next() % 18`.
5. **Canonical text for hashing.** Each item becomes one line, `t<TAB>user<TAB>assistant`. Lines are joined
   by LF and encoded as UTF-8, then hashed with sha256. `filler-golden.json` holds 5 cases (sizes 5 to 5000)
   with their hashes.

Reference implementation in Python. It reproduces all golden hashes:

```python
import re, hashlib
M = 0xFFFFFFFF
def rng(seed):
    x = (seed & M) or 0x9E3779B9
    def nxt():
        nonlocal x
        x ^= (x << 13) & M; x ^= x >> 17; x ^= (x << 5) & M
        return x
    return nxt
def fill(tpl, slots, nxt):
    return re.sub(r"\{(\w+)\}", lambda m: str(2 + nxt() % 18) if m.group(1) == "n"
                  else slots[m.group(1)][nxt() % len(slots[m.group(1)])], tpl)
def filler(spec, seed, size, fromT, toT):
    nxt, span, out = rng(seed), toT - fromT, []
    for k in range(size):
        t = fromT + 2 * ((k * span) // (2 * size)) + 1
        lang = "es" if nxt() % 2 == 0 else "en"
        tp, sl = spec["templates"][lang], spec["vocab"][lang]
        u = fill(tp["user"][nxt() % len(tp["user"])], sl, nxt)
        a = fill(tp["assistant"][nxt() % len(tp["assistant"])], sl, nxt)
        out.append((t, u, a))
    return out
sha = lambda items: hashlib.sha256("\n".join(f"{t}\t{u}\t{a}" for t, u, a in items).encode()).hexdigest()
```

The filler deliberately shares everyday words with the probes (mascota,
presupuesto, renta, hermana, sister, budget, rent, work, the blood test...), so
keyword recall meets real noise. The templates are few, so the filler repeats
itself: at size 5000 about 3 % of a scenario's exchanges are exact user + assistant
duplicates of an earlier one (measured on four C1 scenarios). The Round-1 audit
put duplicates at ~12 %; that figure counts a looser match and was not re-measured.

## Scoring rules an adapter must respect

- **Components.** An adapter returns each surface as named components:
  `{ name, queryDriven, kind?, cap?, text, items[] }`.
  - `queryDriven` is true when the content was selected by the probe text (a
    search, a scored recall). It is false for ambient context.
  - `kind` is one of:
    - `thread`: recent turns of this conversation
    - `recall`: query-driven
    - `ambient`: always-present blocks such as a profile, essentials or standing preferences

    When `kind` is omitted it is inferred: query-driven means `recall`, a name
    containing "thread" means `thread`, anything else is `ambient`.
  - `cap` is the component's result-count limit (`null` = no count limit).
    The report prints it next to C7.
  - C7 counts only query-driven items, because ambient context is not a recall.
  - A surface may also carry `dropped: string[]`, the blocks a prompt budget
    removed before the model would see them.
- **Author markers (C5).** An adapter declares how it marks authorship as a JSON
  `AuthorMarkerSpec` and scores with `scoreProbeWith(run, spec)`:

  ```json
  { "lineLabels": { "person": ["user"], "assistant": ["jarvis"] },
    "itemPatterns": { "assistant": ["^\\[assistant-note\\]"] },
    "headings": [ { "pattern": "^## Notes the user dictated", "role": "person" } ] }
  ```

  - `lineLabels` open a line, after optional indentation and a list prefix
    (`-` `•` `*` `1.`), as `Label:` or `[label]`. Matching is case-insensitive.
  - `itemPatterns` are regex sources tested against the whole item (anchor
    them with `^` or `$`; the example above anchors at the start). A match
    makes the whole item single-author.
  - `headings` are regex sources tested against the lines of a component's
    text. The last matching heading above an item applies to that item.
  - `defaultRole` (optional) is the role a system's unmarked text belongs to by
    its own convention. It never enters `authorMarked`; it feeds a separate
    figure, `authorMarkedWithDefault`: the strict rule with every unattributed
    occurrence counted as `defaultRole`. Jarvis sets none.

  To attribute one occurrence of the needle, take the first of these that
  applies:
  1. the nearest line label before the occurrence in the same item
  2. the item pattern
  3. the heading

  **Strict rule.** `authorMarked` holds when two conditions are met:
  1. At least one occurrence of the needle is attributed to `expectAuthor`.
  2. No occurrence is unattributed, and no occurrence is attributed to a role
     outside `probe.statedBy`.

  `statedBy` is the set of roles whose turns hold the figure in the events.
  The generator computes it, and `validateCorpus` checks it. Without
  `statedBy`, the set is `[expectAuthor]`.

  A heading counts only for unmarked items. A line label that disagrees with
  its block heading raises `attributionConflict`.

  Without a spec, `DEFAULT_MARKERS` applies (person `user|person|human`,
  assistant `assistant|jarvis|ai|bot`, no headings).

  In an echo case both roles stated the figure. It passes strict when every
  copy carries its own author. It fails when a copy is unmarked or sits only
  under the wrong author.

  `scoreProbe(run)` keeps the v1 signature and uses the default markers.
- **Time without a clock shim.** Ingest each probe's timeline aged relative to the real clock:
  `stored_time = now − (probe.t − item.t)`. Re-ingest per probe if needed (the Jarvis adapter clears and
  re-ingests for every probe).
- **Embeddings.** Every result carries `embeddings: off|on`. An `off` run is words-only. Do not compare
  an `on` run with an `off` one.

## Adding an adapter

1. Read the corpus file. Regenerate each scenario's filler with the algorithm above, and check one
   golden hash first.
2. For each probe:
   1. Start from an empty store.
   2. Ingest the timeline: events and filler with `t < probe.t`, sorted by `t`.
      Store `channel: "secondary"` events under a second channel of the same person.
   3. On a `restart` event, restart for real.
   4. For `variant: "live"`, feed the thread as it happened instead of reloading it.
   5. Collect the proactive and asked surfaces as components, with `kind` and `cap` set.
3. Emit one record per probe, `{ scenarioId, class, fillerSize, probeIndex, probe, proactive, asked,
   ingestedRows, ingestMs, gapRows?, variant?, otherChannelRows? }`.
   - Each surface is `{ measurable, note?, components, ms, dropped? }`.
   - Set `measurable: false` with a note when your system has no such surface.
4. Score with `scripts/continuity-bench/score.ts`:
   - per probe, `scoreProbeWith` with your marker spec
   - then `aggregate`, `aggregateByGap` (after `withScenarioMeta`) and `aggregateAuthor`

   Alternatively, reimplement the rules above exactly.
5. Say which leg you ran:
   - `raw` means the system ingests only the chat exchanges, as it would in production with no model.
   - `ideal` means it is also handed the extracted facts (`text`) through its own write path.

## Jarvis adapter choices

- **Author markers.** `JARVIS_MARKERS` declares line labels only: `User:` for
  the person and `Jarvis:` for the assistant.
  - No Jarvis heading claims authorship. "Contexto relevante del usuario"
    means context *about* the user and wraps `User:`/`Jarvis:` exchanges.
  - The profile and relevant-facts headings name the subject of a fact, not
    who stated it.
  - So `attributionConflict` is 0 for Jarvis by construction. The metric stays
    in the scorer for systems whose headings do claim authorship.
  - The round-1 baseline reported 66–75 % conflict. That came from mapping the
    enrichment heading to the person, and is retracted.
  - Not measured: whether a recalled assistant line is later treated as the
    person's own evidence. That is a downstream question.

- **Storage.** Each exchange (and each `asUser`/`asAssistant` rendering) becomes one `conversations`
  row, exactly as the router stores a chat:
  - content `User: ...\nJarvis: ...`
  - bank `mc-jarvis`, tier 2, source `router`
  - tags `["telegram","conversation","outcome:success"]`, or `["whatsapp",…]` for a secondary-channel row
  - `created_at` aged as above

  The rows are inserted by SQL, and an FTS self-check confirms the trigger indexed them.
- **Ideal leg.** Extracted facts are written through the production write paths:
  - A durable `person_fact` (and its corrections) goes to `upsertFact` as `preference`, confidence 0.9.
    That is JME's only permanent kind; JME has no identity category.
  - A temporary fact goes in as `event` with a 7-day expiry.
  - A `standing` instruction goes to `user_fact_set` (category `preferences`).

  No handoff or session summary is written: Jarvis has no such write path today.
- **Proactive surface.** These are the real functions the router and fast runner call:
  - thread hydration (`_testThreadTurns` → `getThreadTurns`)
  - `buildPrecedentBlock`, `getEssentialFacts`
  - the always-injected profile + projects
  - `formatRelevantUserFactsBlock`, `enrichContext`
  - the JME `jmeRecallQuery → queryMemory → orderForInjection` chain

  The JME block's text template is replicated from `fast-runner.ts`, and a test
  pins it to that source.

  The profile, relevant-facts and enrichment blocks pass through the
  production budget loop (`buildJarvisSystemPrompt` with `CORE_TOOLS`). A block
  that loop drops is removed from the surface and listed in `dropped`.
  The check passes `CORE_TOOLS`. Production passes `CORE_TOOLS` plus the
  scoped groups' tools, and their conditional sections take more room, so
  "0 dropped" is a lower bound.
- **Asked surface.** `memory_search` (bank `jarvis`) plus `queryMemory`. No tool
  exposes the latter. The memory_search output is split into items on its
  numbered boundaries, anchored after ` (relevance: x.xx)`, so a numbered line
  inside a stored row does not split it.
- **Threads.** The thread variants differ in setup:
  - A `hydrate` probe uses a fresh thread key with the same base channel, so it
    hydrates from the store.
  - A `live` probe seeds an empty hydrated thread and pushes the primary rows
    through the router's `_testPushToThread` seam. That seam runs the same
    15-row cap, scrub and filter as the live path.
  - C4 restarts for real:
    - the database is reopened
    - the router module is re-imported
    - the memory service, essentials and embedding caches are reset
    - the base-channel thread is then hydrated by the fresh process

  Tests fail if the restart is skipped or if the thread key is hard-coded.
- **Safety.** The run refuses any database other than a scratch one:
  - The db is a fresh file under `os.tmpdir()`, with its parent and final
    component realpathed. It refuses `data/`, `*mc.db`, a symlink to either,
    and any existing file.
  - It refuses embedding or remote-memory keys unless `--allow-embeddings` is
    passed. `COMMIT_DB_KEY` is refused always.
  - `MEMORY_PRECEDENTS_MODE=off`.

### Embeddings leg (`--allow-embeddings`)

This leg is not run in the baseline. It costs real embedding calls.

- **Stored rows** are embedded the way `retain()` embeds them: `embed()` →
  `conversation_embeddings`. Each vector goes through a content-hash cache, a
  JSONL file that must be under `TMPDIR`.
  - The default cache lives in the run's scratch directory and is deleted at
    exit. To reuse vectors across runs, pass `--embed-cache <file under TMPDIR>`.
- **JME** embeds its own fact and query texts through `generateEmbedding` and
  its in-process cache. The harness does not cache those.
- **Corrections.** With vectors, JME may absorb a correction as `skipped`
  (cos ≥ 0.95, the stored row takes the new wording) or as `superseded`
  (≥ 0.85). Both are accepted. Without vectors only `inserted` is accepted.
- **Call budget.** Before any call, the run prints an **upper bound** on
  every embedding call it can make, broken down by source:
  - stored rows not yet in the bench cache
  - 6 uncached production calls per probe: memory_search, two enrichment
    recalls, enrichment's semantic query, and the proactive and asked JME
    queries
  - 2 per fact upsert, counted on every re-ingest

  It refuses when that bound exceeds `--max-embed-calls` (default 3000). The
  default sizes are 50,500.

  At run time a fetch meter counts every outbound call, cached by the bench or
  not, and refuses any call past the cap without sending it. The run then
  stops with exit 3 and writes no result.

  A failed embed is not retried within the run, and 5 consecutive failures
  stop the run.

  Bounds on v2:

  | sizes | raw | ideal |
  | --- | ---: | ---: |
  | 50 | 6,823 | 7,111 |
  | 50,500 | 31,403 | 31,979 |

  Both exceed the default cap, so the limit has to be raised on purpose.
- **Stored text.** Rows are stored and embedded as `scrubSecrets(content)`,
  exactly as `retain()` does (sqlite-backend.ts:215).

## Limits

- **Words-only is the harness configuration, not production's.** With embeddings off every recall is
  FTS5 or LIKE. A disjoint probe shares no content word with its target under the neutral list, so it
  hits through ambient or thread context, or through what the list does not cover: substring (LIKE)
  matches, a newest-rows fallback, or a word shorter than 3 characters (v2's `wordingAudit` is 0, so no
  longer shared word remains). It never hits through meaning.
  Production with a key runs hybrid recall, and:
  - **JME supersede and temporal dedup need vectors** (`src/memory/jme.ts` ~531, ~692, ~887). With them
    off, a correction is inserted beside the old fact instead of replacing it. C2 and C8 stale-hit
    figures under `emb-off` therefore differ from a keyed production.
- **The day-log is not written or searched.** It is the record of work done, not a chat memory, and no
  probe targets it.
- **Consolidation is not run.** The nightly dedupe/consolidation passes never execute. The filler's
  repeats (about 3 % exact; see the filler section) stay as separate rows,
  where a consolidated store would have merged them.
- **No model in the loop.** The scorecard measures what reaches the model, not what the model answers.
  A hit means the fact was available. It does not mean the model would use it. A stale hit means the
  model also saw the wrong value.
- **Ideal legs assume perfect extraction.** The ideal leg is an upper bound on what the write path can
  serve, not a measure of the extractor.
- **Proactive time is sequential.** Proactive `ms` sums the components in order; production runs some of
  them in parallel.
- **Thread dominance.** A target inside the last 15 rows is carried by the thread, whatever the memory
  layer does. Read memory quality from the recall share and the thread-only share, and from the
  K ≥ 15 rows of the C3/C4 table.
- **C7 rewards emptiness.** 100 % means nothing query-driven came back for a never-mentioned topic. An
  empty or broken adapter also scores 100 %. C7 is therefore shown only beside C1 from the same run,
  with each recall component's cap.
- **v1 C3/C4 were vacuous.** In v1 the open work was the last exchange before the probe, so a 15-turn
  thread held it at every size. v1 numbers for those classes prove hydration and restart only. Use the
  v2 K axis.
