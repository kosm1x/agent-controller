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
npx tsx scripts/continuity-bench/run.ts --leg raw --sizes 50,500,5000 --corpus $V2 --switch MEMORY_OPEN_WORK=on
npx tsx scripts/continuity-bench/run.ts --compare before.json,after.json[,before2,after2] [--reference ref.json[,ref2]] --md results/port1-open-work.md
npx tsx scripts/continuity-bench/generate.ts [--check]                          # v1 corpus + golden
npx tsx scripts/continuity-bench/generate.ts --corpus-version continuity-v2 [--check]   # v2 corpus
```

v2 has 594 scenarios and 1440 probes (480 per filler size): the 444 scenarios
and 1140 probes of the first v2 build, byte-identical (a test pins their hash),
then the 90 scenarios of the Port 1 variants below, then the 36 scenarios of
the two known-limit variants (`single`, `longcloser`), then the 24 Port 3
scenarios (§Tombstones). A second hash pins the 534 scenarios before the
known-limit variants, a third the 570 before the Port 3 ones, a fourth the
582 before the C8 snapshot cases. A leg takes
about 155 to 185 s on the VPS, most of it at size 5000. The default output name is
`results/jarvis-<sha>-<leg>-emb-<on|off>-v2.json`; a switch set away from its
default adds `-<switch-name>-<value>` (e.g. `-memory-open-work-on`).

**v1 vs v2.** `corpus-v1.json`, `filler-golden.json`, the filler algorithm and
the v1 results are frozen. v2 is a new corpus file built on the same filler. It
adds a gap axis for C3/C4, author cases for C5, a wording label on every probe,
and paired probes in C2, C6, C7 and C8. Every v2 field is optional, so a v1
reader still parses v2 and a v1 result still scores. `run.ts` reads v2 by
default on every leg; `--corpus v1` (or `--corpus v2`) names a committed file,
any other value is a path, so `--corpus v1` reproduces the archived v1
baseline.

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
- `handoff` (K 15, 20): the open work ends a session on day 0, one complete
  session on another topic (two exchanges and a short `session_end` with
  nothing open) follows on day 4, then K gap exchanges on day 5, and the probe
  on day 5.
- `crowded` (K 15, 20): as `handoff` with three complete sessions on days 2, 3
  and 4. Under Jarvis's cap of three session notes it is expected to miss the
  open work; the row is there to show the cap.
- `closer` (K 16): as `hydrate` K 16, but the first of the K rows is a short
  closing exchange ("Gracias." / "De nada, hasta luego.") in the same session
  as the open work, so the open work is no longer the session's last row.
- `longcloser` (K 16): as `closer`, with small talk of 8+ content tokens as
  the closer. Session tail notes are expected to miss it (known limit B
  below); the row is there to show the limit.
- `single` (K 16): as `hydrate` K 16, with the open work stated in a
  one-exchange session (the `session_end` row alone). Expected to miss for
  the same reason (known limit A below).

The gap K is counted from the **last** `session_end` of a scenario.

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
- It is now **0 of 660**: no disjoint probe shares a word of 3+ characters
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
`C3-01-i5x20-…` (interleave), `C3-01-ho15-…` (handoff), `C3-01-cr15-…` (crowded),
`C3-01-cl16-…` (closer); C4 `C4-01-r14-…`.

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
  - With embeddings off, a correction replaces its target through `supersedeCluster` at the
    first nightly consolidation after it, and `pruneExpiredFacts()` runs once the timeline
    is in (§Tombstones).
  - A `standing` instruction goes to `user_fact_set` (category `preferences`).

  No handoff or session summary is written: Jarvis has no such write path today.
- **Proactive surface.** These are the real functions the router and fast runner call:
  - thread hydration (`_testThreadTurns` → `getThreadTurns`)
  - `buildPrecedentBlock`, `getEssentialFacts`
  - the always-injected profile + projects
  - `formatRelevantUserFactsBlock`, `enrichContext`
  - the JME `jmeRecallQuery → queryMemory → orderForInjection` chain
  - the session tail notes (`_testOpenWorkBlock`, component `open_work`,
    ambient), only when `MEMORY_OPEN_WORK=on`

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
  - `MEMORY_PRECEDENTS_MODE=off`, and every switch in `SWITCHES`
    (adapter-jarvis.ts) is set explicitly in the harness process: its
    default, or the value given with `--switch NAME=value`. The states are
    recorded in the result's `meta.switches`.

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
  (≥ 0.85). Both are accepted. Without vectors the harness supersedes the
  correction's target itself through `supersedeCluster` (§Tombstones).
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

## Session tail notes (Port 1, `MEMORY_OPEN_WORK`)

`src/messaging/open-work.ts` derives up to three notes at turn start from the
existing `conversations` rows of the base channel. No new table, no writer, no
model call.

- **Only the first turn after a gap reads the store.** The router keeps, per
  channel and in memory, the time of the last inbound message or stored
  exchange. A turn within `SESSION_IDLE_THRESHOLD_MS` (20 min) of it runs no
  query, adds nothing to the prompt and emits no trace. A channel not seen
  since the process started runs the query once; the query then also checks
  that the channel's newest stored row is at least the threshold old.
  Two quick messages after a gap: the first gets the notes, the second gets
  none. A turn the router answers before the pipeline (a greeting on the fast
  path) does not count as activity, and the query skips rows tagged
  `fast-path`, so in "Buenos días" then the real question two minutes later,
  the question gets the notes. The scorecard never sends a greeting, so it
  cannot see this path; the router and unit tests cover it.
- **One bounded query**: the newest 3000 rows of the bank inside the last 14
  days are scanned (`idx_conversations_bank_created`), the channel tag is
  filtered outside that scan, and at most 400 rows come back.
- Rows are split into sessions at gaps of the threshold; a session needs two
  exchanges. Its note is its last substantive row: walking back at most three
  rows, the first with six content tokens, else the last row.
- A note is dropped when its row is in the thread buffer, when it is a
  poisoned exchange, or when its user line shares two 5+ character content
  tokens with a newer note's user line (one note per topic). Assistant lines
  are not compared, and a short list of request and acknowledgement words
  ("necesito", "perfecto", "gracias", …) does not count. At most 3 notes of
  600 characters; only the chosen rows are scrubbed.
- Operator threads only (a non-owner sender in a WhatsApp group gets none).
  The block goes after the cache break, so the stable half of the prompt is
  unchanged.

The switch is `MEMORY_OPEN_WORK=off|shadow|on`, default `off`. `shadow`
computes the notes and traces `memory.open_work` (counts only) but injects
nothing. The harness sets it in its own process with `--switch`.

**The harness takes the cold path.** The bench writes each probe's rows into
the store behind the router, so the router has seen no activity and
`_testOpenWorkBlock` always runs the query; the gap is the age of the newest
stored row. The in-memory activity check is covered by the router unit tests,
not by the scorecard.

`results/port1-open-work.md` is generated by `run.ts --compare` from a run with
the switch off and one with it on, per leg, with the committed v2 runs as the
reference. It reports C3/C4 per variant and K (pooled over sizes and per
size), and three null tests:

1. with the switch off, the run reproduces the reference probe for probe
   (timings aside);
2. C4 does not move, since the gap rows follow the session end with no idle
   gap, so the session tail is in the buffer and dropped;
3. C1, C2, C5, C6, C7 and C8 keep their hit, stale-hit, wording, author and
   C7 cells, and payload chars change only on probes that carry the block.

**Why null test 3 fails at size 500, and what size 5000 does instead.** The
filler rows are evenly spaced over the scenario's filler window, so their
density decides what the reader finds:

- At size 50 the filler rows are hours apart. Each is its own one-row session
  and is dropped, and the C2 and C5 facts are still in the thread buffer.
- At size 500 one filler row lands 413 s before the C2 correction, inside the
  idle threshold, so the two form a session that ends on the correction, and
  the correction is the note. The same happens to 4 C5 probes (a stated
  figure that ends its session). These are the C2 / C5 cells that move at
  500, all misses that became hits.
- At size 5000 the newest filler row is 645 s before the C2 probe, so the
  gap check says `active` and no note is shown in C2, C5, C6, C7 or half of
  C1. Where the gap holds, the filler is one long session whose last row is
  an unrelated note: 24 of the 96 C1 probes, 60 of the 84 C4 probes, and 132
  of the 204 C3 probes carry it at size 5000. In C3 it sits next to the
  open-work note in 108 of them; in 24 (`hydrate` K 14, where the open work
  is still in the thread, and `single`) it is the only note; in `crowded` the
  cap of three keeps it out. The C3 figures per size are in the per-size
  table of `port1-open-work.md`.

Limits of this port:

- **A note is where a session stopped.** It cannot tell finished work from
  open work: a session that ended on a settled fact produces a note too
  (the size-500 C2 / C5 moves above).
- **The base channel is shared by every conversation on it.** On WhatsApp
  every group and DM has the tag `whatsapp`, so the operator can be shown the
  tail of a session held in another group or with another sender, and the
  block says so. Activity by anyone on the channel also counts as "no gap",
  so a message from another group within 20 min suppresses the notes.
- **The scan reads the bank's newest 3000 rows in the window.** A channel
  whose rows all fall outside them (a quiet channel next to a busy one) gets
  no notes.
- **Known limit A**: open work stated in a one-exchange session gives no
  note (a session needs two exchanges); the `single` rows show it.
- **Known limit B**: small talk of six or more content tokens after the open
  work is substantive, so it becomes the note; the `longcloser` rows show it.
- **Known limit D**: when the same sitting continues for 16 or more
  exchanges with no pause, the session's last row is in the buffer and the
  open work from its start is never shown.
- **C4 is unchanged by design**: without an idle gap there is no earlier
  session to note.
- **Whether the model uses the note is not measured.** As everywhere in the
  scorecard, a hit means the text reached the model.

## Recall floor (Port 2, `MEMORY_RECALL_FLOOR`)

C7 asks about a topic that never came up. With the switch off, both
surfaces return 3.7 to 4.3 unrelated rows per probe: the enrichment block
"Contexto relevante del usuario" and `memory_search`.

**Step 0: which layer the C7 rows come from.** Every recalled item was
labelled by the layer that produced it, from a scratch run with the switch
off (raw leg, embeddings off):

| class, size | probes | items | FTS5 | LIKE | newest-rows fallback |
| --- | ---: | ---: | ---: | ---: | ---: |
| C7, 50 | 12 | 44 | 44 | 0 | 0 |
| C7, 500 | 12 | 52 | 52 | 0 | 0 |
| C7, 5000 | 12 | 52 | 52 | 0 | 0 |
| C1, 50 | 96 | 312 | 212 | 0 | 100 |
| C1, 500 | 96 | 442 | 382 | 0 | 60 |
| C1, 5000 | 96 | 448 | 388 | 0 | 60 |

The counts are the same on both surfaces.

- **The fallback gives C7 nothing at any size.** Every C7 row is an FTS5
  match. The cause is how `recallHybrid` scores matches: each layer is
  normalised by its own best score, so the top FTS row of any query gets 0.5
  and clears the 0.12 relevance threshold. That holds however common the
  shared word is, such as "sobre", "what" or "about".
- **The fallback does carry rows in other classes.** In C1 it supplies 100 of
  312 items at size 50 and 60 at 500 and 5000. It also supplies about 255 of
  870 items per size in C3 and 105 of 357 in C4.
- **Twelve C1 hits at size 50 are chance hits from the fallback.** They are
  disjoint asked hits, carried only by `memory_search`.

**The rule (`src/memory/sqlite-backend.ts`).** It applies when the switch is
`on`:

- **Rare keywords.** A query keyword is rare when the FTS index finds it in at
  least one and at most `max(1, ceil(0.02 × bank rows))` rows of the bank.
  The keyword is counted the way the index tokenises: case and accents
  folded.
- **Which keywords count.** Two kinds of query term are candidates:
  - Words of 4 or more characters that are not stop-words, by the token rule
    of `extractContentTokens` in `recall-utility.ts`.
  - Codes, figures and acronyms: a whitespace-separated chunk that holds a
    digit or is written in capitals, with 3 or more letters and digits, such
    as "KVX-482", "3.847.215" or "IVA". The chunk is kept whole and counted
    as an FTS phrase of its tokens ("kvx 482", "3 847 215"), so a figure is
    judged as itself, not by its 3-digit parts, and a row survives only when
    it holds the whole run. A one-token chunk that is a stop-word ("THE")
    does not count; at most six such chunks count per query.
- **Which rows survive.** An FTS5 or LIKE row survives only when it contains
  a rare query keyword.
- **Embedding rows.** A row the embedding layer found is kept.
- **The fallback.** The newest-rows fallback is not run: when nothing
  matches, the recall is empty.
- **Unchanged.** Ranking, the relevance threshold, `was_used` and outcome
  bias are untouched, and there is no new column.
- **Reusable helpers.** `rareTermCandidates(query)` returns the candidate
  terms by the rule above, and `keywordDocFrequency(query, bank, cap?)`
  returns each one's document count. Port 3 can reuse both.

**The switch.** `MEMORY_RECALL_FLOOR=off|shadow|on`, default `off`; any other
value counts as `off`.

- **`off`.** The recall path is the one before this port: no extra query and
  no trace.
- **`shadow`.** Returns today's results and adds a trace event,
  `memory.recall_floor`, with counts only: `{mode, bank, returned,
  wouldDrop, rareTerms}`.
  - `wouldDrop` counts the rows the floor would remove, fallback rows
    included.
  - The trace goes under the task key `memory-recall`, since a recall
    carries no task id.
  - Shadow exists to measure, on live traffic, how often the floor would
    empty a recall before anyone switches it on.
  - If the rare-term lookup fails, the floor is skipped for that recall and
    the trace carries `{mode, bank, error: true}`. Shadow then returns what
    `off` returns, and `on` behaves as `off` for that recall.
- **`on`.** Applies the floor and emits the same trace.
- **Cost.** With `shadow` or `on`, each recall adds one `COUNT` over the
  bank and one capped FTS count per candidate term: at most six words and
  six codes. The count is written as `conversations_fts CROSS JOIN
  conversations`, so the FTS match is always the outer loop. With a plain
  join, an older SQLite (3.45.1) walked the bank index and probed FTS once
  per row, about 150 ms per term on a 12,604-row bank.
- **In the harness.** The harness sets the switch with
  `--switch MEMORY_RECALL_FLOOR=on`.

Every caller of `recall()` already handles an empty array:

- `memory_search` answers "No relevant memories found.".
- Enrichment adds no block for either bank.
- The prometheus planner and executor add no learnings.
- The MCP `jarvis_memory_query` returns `count: 0`.
- `recall-compare` reports zero results.
- The Hindsight SQLite fallback goes through the same backend.

**Results.** `results/port2-recall-floor.md` is generated by `run.ts
--compare` from one run with the switch off and one with it on, per leg, at
sizes 50, 500 and 5000, embeddings off. The committed `4fc2fcf3` runs are the
reference.

With the switch off, both legs reproduce that reference probe for probe:
1392 probes, 0 differ.

No probe in the corpus asks with a figure, a code or a capitalised acronym
(the figures are in the stored rows the probes look for), so the code and
figure rule changes no cell here. The unit tests in
`src/memory/sqlite-backend.test.ts` carry that case.

Raw leg, the same on both surfaces:

| size | C7 mean irrelevant | C7 hit % | C1 hit %, asked (shared / disjoint) | C1 hit %, proactive (shared / disjoint) |
| ---: | --- | --- | --- | --- |
| 50 | 3.7 → 0.7 | 0 → 33.3 | 97.9 / 25 → 81.3 / 0 | 97.9 / 75 → 95.8 / 75 |
| 500 | 4.3 → 2.0 | 0 → 33.3 | 77.1 / 0 → 83.3 / 0 | 81.3 / 25 → 87.5 / 25 |
| 5000 | 4.3 → 1.3 | 0 → 41.7 | 79.2 / 0 → 79.2 / 0 | 79.2 / 0 → 79.2 / 0 |

The prediction was about 0.5 irrelevant items and about 50 % hit. C7 lands
above it on irrelevant items and below it on hit, for two reasons:

- **Shared C7 probes keep their own event row.** Each shared probe shares a
  word with the scenario's own event ("serie", "Madrid", "litros", …). That
  event is a single row, so the word is rare and the row stays. Shared C7
  stays at 0 % hit by construction; the residual 1.0 item per probe at size
  50 is this row.
- **Some C7 probes keep filler rows.** A probe word from the filler
  vocabulary ("cousin" in C7-02; "clase" and "mamá" in C7-05; "garden" and
  "work" in C7-06) can sit under the 2 % line.
  - At size 50 the disjoint C7-05 and C7-06 probes return 1 filler row each.
  - At size 500 both probes of C7-02 and C7-05 return 5.
  - At 5000 both probes of C7-05 still return 5.
  - The disjoint C7 hit rises from 0 to 66.7 % at sizes 50 and 500, and to
    83.3 % at 5000.

What the floor costs, reported as measured and not tuned:

- **C1, raw leg, asked, size 50.**
  - The 12 disjoint chance hits from the fallback are gone.
  - 8 shared hits are lost too. Their only shared word is also a filler word
    ("presupuesto", "sister"), so at size 50, where the threshold is one row,
    the target's word is not rare.
  - At size 500 the shared hits gain more than they lose (+5 / −2 asked,
    +4 / −1 proactive): the common-word rows no longer crowd the target out
    of the top 5.
- **C1, ideal leg.** The shared cells do not move; the JME facts carry them.
  Only the 12 disjoint fallback hits drop.
- **C3 and C4 asked.** These surfaces are not scored, so no cell moves; the
  compare lists 9 unscored hits lost on each, all from the newest-rows
  fallback. The proactive cells do not move.
- **C5.**
  - Raw leg: proactive loses 8 hits (4 shared, 4 disjoint) and asked loses 12
    (5 shared, 7 disjoint).
  - The rows carrying those hits matched on common words only. One asked
    disjoint hit came from the fallback.
- **C6.** Loses 2 shared proactive hits on the raw leg, for the same reason.
  C6 asked is not scored; the compare lists 2 unscored hits lost on it on
  both legs.
- **C8 stale-hit.** Moves both ways: +3 / −4 per surface. The hit cells do
  not move.

**Payload.** The asked payload falls by 66 to 85 % per class; for example,
C1 raw goes from 178,047 to 41,193 characters over 288 probes. The proactive
payload falls by 9 to 15 % per class. Between 28 % (C8) and 64 % (C6) of the
asked probes return no recall item at all.

Limits of this port:

- **Embeddings are untouched.** With a key in production, recall is hybrid.
  The embedding layer keeps its nearest neighbours above cosine 0.3 and the
  floor keeps them, so unrelated rows keep flowing on that path. Closing it
  needs a cosine calibration against labelled pairs, which means paid
  embedding calls. The scorecard runs with embeddings off and does not show
  this.
- **Rare is relative to the bank.** A relevant row whose only matching word
  is common in the bank is dropped. This is the size-50 C1 and the C5 / C6
  loss. A word that is rare by accident keeps an unrelated row: the shared
  C7 rows and the filler words above.
- **Codes match as written.** A code is a phrase of its FTS tokens, so
  "3.847.215" and "3847215" are different terms, and a row that wrote the
  figure the other way is not kept by it. A short acronym typed in lower
  case ("iva") is not a code and, under 4 characters, not a word either.
- **Small banks.** The threshold never goes below one row. In a bank of 50
  or fewer rows, a word found in two rows is already common.
- **LIKE rows.** LIKE runs only when FTS finds nothing. A rare keyword then
  needs an FTS match of its own, so a LIKE row survives only when a tag
  filter hid that FTS match.
- **Nothing is learned from use.** `was_used`, the outcome bias and the
  ranking are unchanged.

## Tombstones (Port 3, `MEMORY_TOMBSTONES`)

C2 corrects a fact and C8 lets a temporary one expire. JME supersedes,
rewords and expires its own facts, but the `conversations` rows that carried
the old value stay. With the switch off they still reach the model on 44.4 %
of the C2 probes from size 500 and on 40.9 to 59.1 % of the C8 probes,
through the enrichment block and `memory_search`.

**What the harness had to change first.** With embeddings off, `upsertFact`
cannot take its cosine decision and plain-inserts a correction, so neither
leg ever superseded anything. The ideal leg now takes that decision from the
corpus (a correction replaces its target's live row) and calls the
production step after it, `supersedeCluster` in `src/memory/jme.ts`, which
`upsertFact` itself calls. The supersede is dated at the first nightly
consolidation after the correction: the `jme-consolidate` cron runs at 02:45
local time and takes only turns at least 30 minutes old
(`nextConsolidationT` in `adapter-jarvis.ts`), so a correction stated at
09:00 on day 5 is superseded at 02:45 on day 6, before any probe. After the
ingest the leg runs the production `pruneExpiredFacts()`, in place of the
nightly cron. Both happen with the switch off too, since a keyed production
instance supersedes: the ideal-leg `off` run therefore differs from the
Port 2 commit on 18 C2 probes, all in the `jme` / `jme_query` components
(the old fact is no longer a live JME row), with one hit gained at size
5000. The raw leg reproduces the Port 2 commit on all 1,392 probes they
share.

**The write side (`src/memory/tombstones.ts`).** When a fact stops being
true, `recordTombstone` writes a row to `memory_tombstones` (schema v13):

- **When.** At two JME sites: a supersede (each replaced row), and the prune
  for the transient class only: a `jme_facts` row with `category` `'event'`
  or `'project'` whose text matches `TRANSIENT_FACT_RE` (the 30-day snapshot
  class: a week marker, a day number, a count of tests or players), read
  before the delete in the same transaction and dated at its `expires_at`.
  A reword writes none: it restates the fact and its value stands. Any other
  expired fact writes none either: a plain event lives a flat 30 days from
  extraction, so it ages out without its value being shown false ("your
  flight to Madrid is AM-0412" expiring must not silence "the AM-0412 leaves
  at 7"). Both trace `{mode, reason: "reworded" | "expired", skipped:
  true}`. A low-confidence row pruned before it expires gets nothing.
- **Terms.** Codes and figures only: a chunk of 3 or more letters or digits
  that holds a digit or is an all-capitals acronym, kept whole (the Port 2
  code rule, `codeTermCandidates`). A word is never a term: JME facts carry
  no bank, so there is no bank in which a word could be measured as rare.
  `terms` are the old text's codes the new text does not hold; `new_terms`
  the new text's codes the old text does not hold.
- **Rare in the bank.** A code, on either side, is kept only when it is rare
  in `mc-jarvis` by the Port 2 rule: held as a phrase (so "KVX-482" counts as
  itself) by at least one and at most `max(1, ceil(0.02 × bank rows))` rows,
  through Port 2's `keywordDocFrequency`. A common code ("2026", "CDMX")
  would silence rows that have nothing to do with the fact. The check is a
  bank row count plus one capped count per candidate of the fact's text, per
  tombstone write: on a 12,600-row bank with 400 live facts, a supersede
  write took a median of 2.8 ms (p95 4.5 ms) with both checks.
- **Still held is not gone.** A term that a live `jme_facts` row still holds
  (another row, confidence above 0, not expired at the write) is dropped, so
  an expired weekly slot does not silence a durable fact that shares its
  number. Reject markers (confidence 0) do not count as live: a rejected
  value is not a claim. The check is one `SELECT` of the live facts per
  tombstone write; writes happen only in the nightly consolidation and the
  prune. Measured per write: a median of 1.4 ms with 400 live facts, 5.6 ms
  with 2,000, 27.1 ms with 10,000 (p95 3.6, 8.7, 37.1 ms).
- **Never a secret.** Stored secret values and bracketed placeholders are
  blanked before the terms are cut, so no term is a value the scrubber would
  mask, or a piece of one.
- **Not written.** A tombstone with no term filters nothing and is not
  written (the trace still counts it), except a supersede, whose row marks
  the fact so the prune does not add a second, `expired`, tombstone for it.

**The read side (`SqliteMemoryBackend.recall`).** Only a recall on bank
`mc-jarvis` is filtered (`TOMBSTONE_BANK`): JME's episodes come from the
operator exchange the router also retains there, so a tombstone speaks for
that bank and no other. On every path (FTS5, embeddings, LIKE, the
newest-rows fallback), before the final slice, a row is dropped when, for
one tombstone, all three hold:

1. the row was created before the tombstone;
2. it holds one of the tombstone's terms, as a contiguous run of folded FTS
   tokens;
3. it holds none of the tombstone's new terms (a row that names the new
   value is the correction itself, or newer news).

The 500 newest tombstones that carry a term are loaded once and cached until
the next write.

**The switch.** `MEMORY_TOMBSTONES=off|record|on`, default `off`; any other
value counts as `off`.

- **`off`.** No table write, no load, no filter, no trace, and the prune runs
  only its `DELETE`: the recall result is the one before this port.
- **`record`.** Writes tombstones and traces, filters nothing. It exists to
  build up the table and to count, on live traffic, how many recalled rows
  `on` would drop before anyone turns it on.
- **`on`.** Writes and filters.
- **Traces** (`memory.tombstone`, counts only): on write `{mode, reason,
  terms, newTerms}` under the task key `memory-tombstones` (a reword or a
  non-transient expiry: `{mode, reason, skipped: true}`); on recall `{mode, bank,
  returned, wouldDrop}` (record) or `{..., dropped}` (on) under
  `memory-recall`, or `{mode, bank, error: true}` when the load failed, in
  which case nothing is filtered.
- **Cost.** On a scratch bank of 12,600 rows with 500 tombstones, a recall
  went from a median of 5.7 to 5.9 ms with the switch off to 7.1 to 7.4 ms
  with it on (p95 8.4 to 8.9 ms → 9.9 to 10.3 ms; `record` 7.7 ms, p95
  10.6 ms); loading the 500 tombstones once took 4.0 ms.

**The Port 3 corpus items** (24 scenarios, 48 probes; ids end `-rp`, `-nf`,
`-rw`, `-lv`, `-sn` and the size):

- **`rp`.** A C2 correction whose row repeats the old value and names the new
  one ("Ya no es 3.847.215, ahora es 4.120.000.").
- **`nf`.** The same with no new figure ("Ya no es 3.847.215, te paso el
  monto nuevo luego.").
- **`rw`.** A durable fact reworded so that it drops a word; the value must
  still be recalled.
- **`lv`.** A C8 temporary fact whose number a durable fact also holds; the
  durable value must still be recalled.
- **`sn`.** Four C8 temporary facts whose text carries a snapshot marker
  `TRANSIENT_FACT_RE` accepts ("semana 14", "Day 3", "W22", "roster") and a
  figure (a phone ending, a time, a locker number, a code): the one kind of
  expiry that writes a tombstone. The second probe avoids the durable
  fact's words.

**Results** (`results/port3-tombstones.md`, embeddings off, sizes 50, 500,
5000):

- **Ideal leg, C2.** Stale-hit drops from 44.4 % to 16.7 % on both surfaces
  at 500 and 5000, and on the asked surface at 50; hit stays at 50 %. At
  size 50 the proactive surface stays at 88.9 % stale: the hydrated thread
  still holds the exchange that stated the old value, and the thread is out
  of scope.
- **Ideal leg, C8.** Stale-hit drops from 50 / 40.9 / 59.1 % to 36.4 /
  27.3 / 40.9 % on both surfaces; hit stays at 50 / 50 / 54.5 %. Every
  probe that moved is an `sn` probe: the other C8 temporary facts say "this
  week", not "semana 2", so each one ages out as a plain event and writes no
  tombstone, and their cells are as with the switch off.
- **The new items.** `rp` and `nf`: the stale value leaves `memory_search`
  at every size and the enrichment block at 500 and 5000, and the hit is
  kept. `rw`: unchanged, hits kept (a reword silences nothing). `lv`:
  unchanged, the durable number is still recalled; its temporary fact is a
  plain event, so its stale value stays. `sn`: stale-hit drops from 37.5 /
  37.5 / 50 % to 0 at every size on both surfaces (3, 3 and 4 of 8 probes),
  hit stays at 50 %.
- **Raw leg.** Unchanged on every probe: without extraction there is no JME
  fact to supersede or expire, so no tombstone is written.
- **Other classes.** C1, C3, C4, C5, C6 and C7 do not move on either leg (0
  of 75 cells, 0 probe flips); no hit is lost in any class.

Limits of this port:

- **Only rare codes and figures are silenced.** A value stated in words (a
  drug, a neighbourhood, a city, a name) leaves no term, and neither does a
  code common in the bank, so their rows stay: that is the residual C2
  stale-hit above.
- **Only a transient fact's expiry is silenced.** A plain event or a
  durable fact that ages out leaves its rows in recall: the residual C8
  stale-hit above. A temporary fact JME stores as a plain event ("this
  week only") is covered only if its wording carries a snapshot marker.
- **A correction with no new figure is silenced too.** The `nf` row holds
  the old figure and no new term, so it is dropped like any older mention:
  on the corpus probes it never ranks into `memory_search` or a 10-item
  recall in either mode, and on two probes written to reach it ("¿Sigue
  siendo 3.847.215 el presupuesto?", "¿Ya llegó el monto nuevo?") it was
  recalled on 6 of 6 recalls with the switch off and 0 of 6 with it on. The
  JME fact still carries the news, and the `rp` row, which names the new
  figure, is kept on every recall.
- **A correction whose new value is common is silenced too.** A new figure
  held by more than 2 % of the bank's rows is dropped from `new_terms`, so
  the correction row that names it gets no protecting term and is silenced
  like the `nf` row.
- **Only the 500 newest tombstones apply.** The load is capped at 500; an
  older tombstone stops filtering once 500 newer ones exist (open question).
- **The thread is untouched.** Rows already in the hydrated thread are not
  filtered, as the size-50 C2 proactive cell shows.
- **The raw leg and an extractor that misses.** Only a fact JME superseded
  or expired leaves a tombstone. What extraction never stored, no tombstone
  covers.
- **A later mention of the old value survives.** A row created after the
  tombstone is kept even when it repeats the old value.

## Extracted leg (Port 4, `--leg extracted`, PROVISIONAL)

The ideal leg assumes perfect extraction. The extracted leg measures the real
one: it ingests like `raw`, writes the stated-fact exchanges (standing,
person_fact, correction) to `jme_turns` through the router's own
`writeEpisodic`, runs the production nightly consolidator
(`consolidateAll()` in `src/memory/jme.ts`, one Haiku call per run), then
`pruneExpiredFacts()`, then probes. Nothing is hand-inserted into
`jme_facts`; the consolidator's rows are dated at the night that wrote them
and copied onto each probe's timeline with their TTL kept.

- **One call per consolidation night.** The turns of one scenario are grouped
  by the 02:45 run that would first see them (`nextConsolidationT`). C6 and
  C8 take one call per scenario; C2 takes two, because its fact and its
  correction are five days apart and production consolidates them on
  different nights.
- **Window.** `--window day` (the default) writes each night's stated turns
  among seeded ordinary exchanges (`--day-turns` / 2 of them, below; 30 of
  the corpus's filler generator in the archived window; seed fixed per
  scenario and night, spread over the 24 hours that night consolidates),
  plus the scenario's own filler dated in that window, in timeline order and
  aged past the 30-minute settle window. An ordinary exchange that holds a
  probe needle (expect or forbid) stops the run. `--window clean` writes the
  stated turns alone and is an upper bound. The window is recorded in
  `meta.extraction.window`; each scenario's `extraction` entry records
  `calls`, `turns`, `cutTurns`, `inserted`, the consolidator's own counts
  (`consolidator`: extracted, skipped, superseded, dropped), `caught`,
  `failedCalls` and the `facts` the consolidator left, each with its
  `category`, `night`, `ttlMs` and `expiresAtT` (corpus seconds; null =
  permanent).
- **Window limit.** A night's call sees its oldest `CONSOLIDATOR_MAX_TURNS`
  (400) turns, as `consolidateAll` reads them (`ORDER BY ts ASC, id ASC
  LIMIT 400`; stated turns are not privileged): the bench writes exactly
  those and counts the newer ones in `cutTurns`. One divergence is left:
  production keeps the newer turns for the next night (and prunes them after
  7 days), while the bench, which makes one call per night that holds a
  stated turn and simulates no other night, drops them. Until 2026-11-08 the
  bench kept the stated turns plus the newest ordinary ones instead (audit R1
  W1). The stated turns sit at 09:00, about 6 h into the 24 h window; the
  oldest 400 turns of a default night run from 02:45 to about 10:30, so they
  hold them (every C2 / C6 / C8 night at size 50). A day large enough to push
  the oldest 400 before 09:00 (about 1,500 seeded turns) would cut the stated
  turns too: `cutTurns` counts turns, not which ones.
- **Day size, mix and turn length (`--window day` only).** `--day-turns <n>`
  (an even integer) is the seeded ordinary turns per night, `--day-mix` what
  they are and `--day-turn-tokens <n>` (0 to 120) the tokens each seeded
  turn is padded to. The defaults are calibrated from the live ledger
  (MEASURED 2026-11-08, queue 4bo(h)): 30 nightly consolidator calls
  (`agent_type` `sdk:unattributed`, model `claude-haiku-4-5-20251001`) had a
  median input of 20,951 tokens, about 19,951 of transcript after the
  ~1,000-token prompt.
  - `MEASURED_DAY_TURNS` = 1190: 19,951 / 16.77 tokens per unpadded `mixed`
    turn (rendered chars / 4). The call sees only 400 of them (Window
    limit), oldest first, so this count sets how much of the day is cut,
    not the load.
  - `MEASURED_DAY_TURN_TOKENS` = 50: 19,951 / 400 = 49.9 (operator ruling
    A). Each seeded turn (filler and pool items, not the stated turns or the
    scenario's own filler) is padded with whole sentences of the corpus
    filler: the templates of the turn's language (a pool item's from its
    scenario, generator filler's from its text) and role, slots from the
    filler vocabulary, in a seeded order, each at most once per turn,
    stopping nearest the target (adapter `padTurn`). A default night's call
    then carries about 21k input tokens (pinned by a test within 5 % of the
    median). Jarvis turns are cut at 500 characters in the transcript, hence
    the 120 ceiling; padding never grows a Jarvis turn past 500.
  - `--day-turns 60 --day-mix smalltalk --day-turn-tokens 0` reproduces the
    archived results (`DAY_TURNS_ARCHIVED`, no padding).

  `mixed` seeds `DAY_MIX_SHARES` (40 % work, 10 % durable facts, an
  assumption) from the corpus, the rest filler. Work = every exchange of a
  session before its `session_end`, plus that `session_end` (32 distinct
  exchanges: the C3/C4 task threads; the corpus has no tool output, and
  `jme_turns` holds only the final reply). Facts = the standing and durable
  `person_fact` renderings of every scenario. Pool items are drawn without
  replacement: a pool smaller than its share gives each item once a night
  and the filler makes up the rest (the filler itself can repeat a sentence
  by chance). A pool item holding one of the scenario's probe needles is left
  out, and so is a fact sharing a content token with the scenario's probed
  events (see Limit 3). The draws are deterministic for a seed and a pool;
  the pool follows the corpus order, so editing the corpus moves them. Any
  day setting other than the archived one is recorded in
  `meta.extraction.day` and named in the output file
  (`-c6-day-t1190-mixed-p50`) and in the report lines.
- **Prompt date.** The consolidator's prompt carries "today"; the leg passes
  each consolidation night's date (as the last probe sees it) through
  `consolidateAll({ today })`, so relative dates resolve on the timeline.
  Production passes nothing and keeps the real date.
- **`caught` (lexical, live at probe)** = every probe of the scenario has an
  extracted fact live at the probe's time that holds all its expect needles
  (folded substring, as the scorer), or all of the probe's optional
  `expectEn` needles (an English rendering of `expect`, matched with accents
  and case folded on both sides). v2 carries `expectEn` on each of its 1,404
  probes with an expect needle (operator ruling B; C7's 36 have none): a
  Spanish scenario's needle through `EXPECT_EN_ES` in `corpus-v2.ts` (names
  as they are, figures in English separators without their unit, dates
  month first, phrases by the words a rendering shares), an English one's
  as it is. v1 carries none. Hit / stale never read it. It says nothing
  about whether recall surfaces that fact.
- **`surfaced n/N`** (compare page) = probes of a row whose JME recall layers
  (`jme`, `jme_query`) returned at least one item on that surface.

### Limits

1. **English facts, Spanish needles.** The consolidator writes facts in
   English while many corpus needles are Spanish, so `caught` and hit %
   understate what was extracted. The per-scenario `facts` are in the JSON
   for a human read. v2's `expectEn` lists lift `caught` (not hit %); the
   archived C6 runs recompute from 3 / 6 to 6 / 6 with them (C6-01, C6-03,
   C6-05). The C2 + C8 run is stored 6 / 20 (live at probe: C8 facts expired
   before it); without liveness (that file stores bare fact strings) it
   recomputes 14 → 16 (C8-01, C8-01-sn). The stored `caught` of those files
   is left as it was computed. Known looseness: a short anchor such as
   "direct" or a bare figure can match a fact that states something else, and
   "B negative" is a substring of "AB negative", so a C8-01-sn fact naming
   the rival blood type would also count.
2. **Embeddings off.** There is no cosine supersede, so in C2 the old and the
   new value both stay live, and part of the ideal → extracted stale-hit gap
   is the harness, not the extractor.
3. **Window.** `clean` is an upper bound (the stated turns alone); `day` is
   seeded ordinary exchanges, not the operator's real day. Its input is
   calibrated to the measured median (400 turns padded to 50 tokens), but the
   padding is filler sentences, its mix is an assumption, and the facts it
   seeds are other scenarios' answer keys: a fact sharing a content token
   (wording.ts `contentTokens`) with the scenario's probed events (those
   holding an expect or forbid needle) is left out, so a day never states a
   rival value of a probed attribute (C2 / C8 attributes, the AB / B negative
   blood-type pair, the two birthdays).

The `--report` extraction table and the `--compare ideal,extracted` page
print these three limits under their headings, and every heading carries
PROVISIONAL until an audit has read the result JSON.

### Consent, cap and refusals

| Condition | Result |
| --- | --- |
| Neither `--run` nor `--dry-run` | exit 2; the message names the model, the per-call cost of both windows and the cost at the cap |
| Both `--run` and `--dry-run` | exit 2 |
| `--allow-embeddings` | exit 2 (the leg's embedding calls are not budgeted) |
| `--run` without `INFERENCE_PRIMARY_PROVIDER=claude-sdk` | exit 2 |
| `--run` with `INFERENCE_SDK_LASTLINE_ENABLED=true` | exit 2 (a failed Haiku call would reach the fallback provider) |
| `--run` without `MC_API_KEY` | exit 2 (the config loader requires it; any placeholder) |
| The next call would exceed `--max-model-calls` (default 6) | exit 3 before that call, the calls made printed, no result written |
| `--dry-run` | no model call; the turns are written and the calls counted, uncapped |
| `--window` on another leg | refused by the argument parser |

Defaults for this leg: `--classes C6`, `--sizes 50`, `--window day`,
`--day-turns 1190 --day-mix mixed --day-turn-tokens 50`, `--corpus v2`, and
`--out` named after the classes, the window and the day settings
(`jarvis-<sha>-extracted-emb-off-v2-c6-day-t1190-mixed-p50.json`; the
archived `-c6-day` name with `--day-turns 60 --day-mix smalltalk
--day-turn-tokens 0`).

### Cost

The cap counts `infer()` calls. One call can make up to 2 billed requests
(the Haiku attempt, then its retry), so the worst case is twice the ceiling.
Haiku 4.5 list price, $1 / $5 per million input / output tokens. Input: the
3,276-character extraction prompt plus the transcript; `clean` sends 2 to 4
short turns (about 1,000 tokens in all), `day` adds about 4,150 to 4,560
characters of ordinary exchanges per night (C2 / C6 / C8 at size 50, about
1,300 tokens more). Typical assumes a short JSON reply; ceiling assumes the
full 1,024-token output. With subscription credentials the calls draw on
the plan's quota instead. The table is the archived 60-turn window; another
day setting scales the day − clean increment per call linearly in seeded
tokens: at most the 400 turns a call can see, at `--day-turn-tokens` each
(17 unpadded, measured), against the archived 60 × 17 (an estimate; the
default is about $0.031 typical / $0.032 ceiling a call). The refusal names
the per-call price of the configured day setting.

| Window | Calls | Typical | Ceiling | Worst case (2× billed) |
| --- | ---: | ---: | ---: | ---: |
| clean | 1 | $0.0015 | $0.0063 | $0.013 |
| clean | 6 | $0.009 | $0.038 | $0.076 |
| clean | 29 | $0.044 | $0.18 | $0.37 |
| day | 1 | $0.0030 | $0.0076 | $0.015 |
| day | 6 | $0.018 | $0.046 | $0.091 |
| day | 29 | $0.087 | $0.22 | $0.44 |

C6 at size 50 is 6 calls; C2 + C8 at size 50 is 29 (C2 9 × 2, C8 11 × 1).

### Running it

The operator runs it, from the repository root, after the commit so
`meta.commit` matches the code. No key is typed: the Claude Agent SDK reads
its own stored credentials, and `MC_API_KEY` is a placeholder. The embedding
and remote-memory keys and the last-line switch are unset, and so is
`ANTHROPIC_API_KEY`, so the SDK uses the stored credentials rather than a key.

1. Smoke, nothing billed: the same line once with `HOME` set to an empty
   directory (and no token or config-dir override). The SDK finds no credentials and both attempts of every call
   fail before a billed request; expect `failed calls 1` on each scenario
   line, `inserted 0`, and `failedCalls` equal to `calls` in the JSON.

   ```bash
   env -u GEMINI_API_KEY -u EMBEDDING_KEY -u COMMIT_DB_KEY -u INFERENCE_SDK_LASTLINE_ENABLED -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN \
     -u CLAUDE_CODE_OAUTH_TOKEN -u CLAUDE_CONFIG_DIR HOME="$(mktemp -d)" INFERENCE_PRIMARY_PROVIDER=claude-sdk MC_API_KEY=bench-placeholder \
     ./node_modules/.bin/tsx scripts/continuity-bench/run.ts --leg extracted --run --max-model-calls 6 \
     --out /tmp/continuity-extracted-smoke.json
   ```

2. C6, size 50, 6 calls:

   ```bash
   env -u GEMINI_API_KEY -u EMBEDDING_KEY -u COMMIT_DB_KEY -u INFERENCE_SDK_LASTLINE_ENABLED -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN \
     INFERENCE_PRIMARY_PROVIDER=claude-sdk MC_API_KEY=bench-placeholder \
     npx tsx scripts/continuity-bench/run.ts --leg extracted --run --max-model-calls 6 --classes C6 --sizes 50
   ```

3. C2 + C8, size 50, 29 calls: the same line with
   `--max-model-calls 29 --classes C2,C8`.

Each scenario prints one progress line (calls so far against the cap, turns,
inserted, caught, failed calls). Render with
`--compare <ideal.json>,<extracted.json> --md <out.md>`.

## Ablation report (P1 Stage A, post-hoc)

`scripts/continuity-bench/ablation.ts` reads local result JSONs (no run, no
model) and answers "which store does the work, and which carries the stale and
the noise". For each store group G, per class × surface (× size), over scored
probes that expect something, it counts the hits lost and stale hits cleared
without G; for C7, the query-driven items (`irrelevantCount`) G returned.

**Rule.** A hit is lost iff every component in `carriedBy` (those holding every
expect needle) is in G. A stale hit is cleared iff every component in
`staleCarriedBy` is in G. The rule is exact only while every hit has a single
carrier and no prompt block was dropped. A split hit (a hit with an empty
`carriedBy`), a `dropped` block, or a C7 probe whose recall counts (the names in
the result's `caps`) do not sum to `irrelevantCount` is listed under "Not
attributable". With `--strict` the reporter prints those ids and exits 3 without
writing (2 is the operator-gate refusal). The local Jarvis result files have 0 of
each. A component name in no group is listed as "ungrouped", never dropped.

| group | components |
| --- | --- |
| `thread` | `thread`, `precedent` |
| `conv-recall` | `enrichment:Contexto relevante del usuario`, `memory_search` |
| `essentials` | `essentials` |
| `jme` | `jme`, `jme_query` |
| `user_facts` | `profile`, `relevant_facts` |
| `open_work` | `open_work` |
| `conversations*` | thread ∪ conv-recall ∪ essentials ∪ open_work |

```bash
npx tsx scripts/continuity-bench/ablation.ts --results <a.json>[,<b.json>] --md <out.md> [--json <out.json>] [--by-size] [--strict]
```

The markdown has pooled rows only; `--by-size` adds the per-size rows (`--json`
always has them). Groups that move nothing in a file are named in one line.
Report on the all-off raw and ideal runs plus the three switch-on runs: `results/p1-ablation-stage-a.md` (committed; the result JSONs are gitignored).

- **Co-carried hits survive single ablations.** A single group's loss is a floor; `conversations*` shows the joint loss.
- **Unwritten stores are unmeasured, not worthless.** The corpus never writes
  mc-operational (`enrichment:Aprendizajes previos`), KG, KB or day-logs.

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
- **Consolidation is not run** (outside the extracted leg, which runs `consolidateAll()` on the stated-fact turns only). The nightly dedupe/consolidation passes never execute. The filler's
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
