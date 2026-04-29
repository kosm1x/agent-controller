# Hindsight: Strategic Options Discussion

> **Status:** discussion document, not a plan. Drafted 2026-04-29 Session 114 after the
> operator asked: _"Why is Hindsight falling short of its initial promise?"_
>
> **Constraints stated by the operator:**
>
> 1. **Context is king** — Jarvis remembering effectively is non-negotiable for product quality.
> 2. **Semantic retrieval is of utmost priority** — keyword/regex fallbacks are insufficient.
>
> **Decision sought:** change, demote, or harden. This doc lays out what each path looks like,
> what it would cost, and what the open questions are. **No commitments here** —
> the freeze (2026-04-22 → 2026-05-22) still stands; this is for the post-freeze conversation.

---

## 1. Quick correction: we are already on pgvector

A premise of the operator's prompt — _"investigate options beside SQLite"_ — is based on a
misconception worth surfacing first. Hindsight (Vectorize-io v0.4.18, the vendor product we
run as `crm-hindsight`) is **not on SQLite**. It runs an **embedded PostgreSQL 18.1.0
instance with pgvector** inside the container, mounted at
`/root/claude/crm-azteca/data/hindsight`. Its actual stack is:

- `asyncpg` + `psycopg2-binary` + `sqlalchemy` + `alembic` for the data layer
- `pgvector` v0.4.1 for vector ops (HNSW or IVFFlat depending on bank config)
- `tiktoken` + `langchain-text-splitters` for chunking
- `openai` SDK for embedding + cross-encoder reranker calls (or our DashScope-compatible primary)
- `fastapi[standard]` + `uvicorn` for the HTTP surface

So the real question isn't "should we move off SQLite" — it's "is this stack the right
shape for our memory needs, and if not, what's better?" That's what the rest of this doc
addresses.

---

## 2. The promise vs what we observed

### The pitch (initial promise)

> _"Jarvis remembers."_ When the user says something Jarvis has heard before, when a
> situation rhymes with a past one, Jarvis recalls relevant context automatically and
> incorporates it into the current response. No manual `jarvis_file_read`, no operator
> reminders. Long-term memory that compounds.

### What we actually observed (Session 113-114)

Three concrete failure modes, all from the past 72 hours:

**Failure mode 1 — outcome-blind retrieval.** A `status='completed'` task from 2026-04-27
contained the failure narrative _"Las herramientas de Drive están bloqueadas en este
entorno. Uso el MCP de Google Drive de Jarvis directamente para exportar... [PDF exportado
es solo 8.8KB — probablemente vacío]... Hay también un documento de análisis ya existente.
Leo el documento de análisis primero..."_ — Jarvis hit blockages, found a secondary
document, summarized that, marked the task `completed`. The body of that task was
auto-persisted into the conversations bank and embedded for recall. **The next day** when
the user asked the same task again, recall pulled this row in as relevant context. The
model read its own past output, took the failure narrative as a recipe, and re-ran the
dead-end chain — even though the live tools (`gdrive_download`, `gemini_upload`) were
sitting right there in scope. We had to surgically purge 9 rows from the conversations
bank to break the loop. Memory of this captured at
`feedback_completed_task_failure_narrative.md`.

**Failure mode 2 — latency tax compounded with timeout cliff.** Cross-encoder reranker is
~99% of recall latency, scaling linearly with candidate pool size (~55ms per candidate).
At 60-candidate cap (current setting): avg 3 s, p95 ~4.4 s, max ~7 s. The mc-side timeout
is 5 s, so 17–32% of recalls today timed out. When they timeout, mc falls back to SQLite
FTS gracefully — but that means **roughly a third of the time, Hindsight contributes
nothing to a turn yet still cost 5 s of wall time**.

**Failure mode 3 — silent bank growth without consolidation.** As of this snapshot:

| bank           | memories | alert    |
| -------------- | -------- | -------- |
| mc-jarvis      | 385      | 🔴 red   |
| mc-operational | 56       | 🟢 green |

`mc-jarvis` ratcheted from 91 → 385 over the day. No consolidation drop visible in 24h.
Either the consolidator skipped a cycle (qwen3-coder-plus failed?) or our consolidation
trigger conditions aren't matching reality. Without consolidation, the candidate pool
grows, the reranker gets slower, and we either pay more latency or shrink the cap and lose
recall coverage.

### The gap, named honestly

The initial promise was _"Jarvis remembers."_ What we built is _"Jarvis pattern-matches on
similar-looking past text."_ Those overlap a lot, but they're not the same thing — and the
gap shows up exactly when surface text matches a failure narrative, when the latency
budget gets tight, or when the bank grows past what the reranker can chew through in 5 s.

---

## 3. The three honest paths

Each path is internally consistent. They are mutually exclusive at the architecture level
(though some hardening work is shared by HARDEN and DEMOTE). Order is by ambition, not by
preference.

### Path A — HARDEN

**Premise:** Hindsight's architecture is fundamentally fine; we just haven't tuned and
augmented it enough. Keep the vendor stack, fix the failure modes within it.

**The work, in priority order:**

1. **Outcome-aware storage.** At task-completion time, tag the conversation row with
   `task_status` (success / failed / completed_with_concerns) and a 1-3 sentence outcome
   summary derived from the task result. Push these as Hindsight `metadata` so they're
   queryable. **Bias retrieval toward `success`; deprioritize `concerns`.** Closes the
   poison-source class entirely. Shape: ~1-2 days of work; touches the auto-persist
   pipeline + the recall client + Hindsight bank config.

2. **Drop the cross-encoder for hot-path recalls.** Two-stage retrieval today:
   pgvector cosine (fast) + cross-encoder reranker (slow, the bottleneck). For latency-
   sensitive turns, **skip the reranker** and rely on cosine + metadata filters
   (recency, outcome, task_type, scope). Use the reranker only for high-stakes recalls
   (e.g., explicit `recall_with_rerank: true` for analysis tasks). 5-10× headroom.
   Hindsight exposes a per-call config knob for this in `bank_config_api`.

3. **Active consolidation triggers.** Today the consolidator runs on a schedule and
   sometimes silently no-ops. Add an explicit trigger when `memory_count > 200` for any
   bank — proactive, not reactive. Surface the consolidator's per-run summary
   (memories merged / discarded / kept) to the dashboard so we know when it skips.

4. **Recall feedback loop.** Today there's no signal back from "this recall was useful /
   misled me." Add a lightweight reaction: when a task ends `completed_with_concerns` AND
   referenced specific recall IDs, downvote those rows' `trust_tier`. After enough
   downvotes, the row falls out of recall ranking. Doesn't delete — preserves audit trail.

5. **Out-of-tree audit DB schema upgrade.** The current `recall_audit` only logs
   latency + n_results + source. Add: `query_text`, `top_k_ids`, `was_used` (did the LLM's
   response cite the recall?). Lets us measure recall _quality_, not just speed.

**Cost:** roughly 2-3 weeks engineering work spread across mc + Hindsight bank config +
some wrapper logic. No new infrastructure.

**Pros:** smallest blast radius, freeze-aligned (mostly hardening of existing paths),
keeps the vendor product so we don't take on memory-product ownership ourselves.

**Cons:** assumes Hindsight's core architecture is the right shape. If the cross-encoder
and consolidator are fundamentally mismatched to our use pattern, hardening just kicks the
can. We've already tuned three knobs (consolidation LLM swap, candidate cap, client
timeout) — the next set of knobs may be inside the vendor's code, not exposed.

---

### Path B — DEMOTE

**Premise:** Hindsight's architecture is fine for "fuzzy long-term memory" but wrong for
"primary recall layer." Stop relying on it as the load-bearing memory; treat it as one
signal among several.

**What this looks like:**

Re-architect Jarvis's memory as a **layered cake** where each layer has a clear job and
clear quality bar:

| Layer                                | What it stores                                                                     | Retrieval                                                                              | Quality bar                                          |
| ------------------------------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **L1 — User facts**                  | Structured key/value (name, prefs, role, dates)                                    | direct lookup by key                                                                   | 100% precision (it's hand-curated)                   |
| **L2 — Jarvis KB**                   | Hand-curated + auto-persisted markdown (directives, projects, day-logs, decisions) | scope-conditional injection, explicit `jarvis_file_read`, FTS via `jarvis_file_search` | High precision, low recall (relies on author intent) |
| **L3 — Skills**                      | Repeatable patterns Jarvis discovered/saved                                        | semantic match on user message → skill descriptor                                      | High precision (skill triggers are tight)            |
| **L4 — Local convos FTS+embedding**  | mc.db `conversations` + `conversation_embeddings` (already built)                  | hybrid keyword + cosine, < 100 ms p95                                                  | Medium precision, fast                               |
| **L5 — Hindsight (fuzzy long-term)** | Cross-thread, cross-day patterns                                                   | cross-encoder reranker, slow but high-quality                                          | High precision, slow                                 |

Today **L5 is doing the job of L4** because L4's hybrid retrieval was never wired up
fully. The fix is: **build L4 properly, demote L5 to "I think I've seen something like
this before, take it as a hint."**

L4 is the load-bearing change. We already have:

- `conversations` table (5,942 rows) with full content, bank, source, tags
- `conversations_fts` FTS5 index (auto-maintained via triggers)
- `conversation_embeddings` table (5,926 rows, embeddings already populated)

We _don't_ have:

- A retrieval client that does hybrid search (cosine + FTS + recency + outcome)
- Outcome tagging (same gap as Path A)
- Integration into the fast-runner system prompt assembly

Build that, and L4 handles 80% of "Jarvis remembers" cases at < 100 ms with no vendor
dependency. L5 (Hindsight) becomes a slower second pass for cases where L4 returns no good
match — or runs in parallel and merges results.

**Cost:** ~2 weeks for L4 wiring, plus the outcome-tagging work shared with Path A.

**Pros:** removes Hindsight from the critical path, makes the system resilient to
Hindsight outages, drops avg recall latency dramatically. The "context is king" goal is
served by the _layered_ memory, not by any single recall call.

**Cons:** more moving parts. We own more code (L4 client logic). Hindsight's
"observations" feature (the differentiator that motivated picking it originally — emergent
patterns the model surfaces autonomously) becomes harder to access if it's not the primary
layer.

**Sub-question for the operator:** how much do we value the _autonomous_ recall behavior
(Hindsight injects context without the LLM asking) vs _deliberate_ recall (LLM calls
`memory_recall("topic X")` explicitly)? Path B leans deliberate. If autonomous recall is a
hard requirement, Path B reduces but doesn't eliminate Hindsight.

---

### Path C — REPLACE

**Premise:** Hindsight is the wrong tool. Our use pattern (single user, conversational +
operational, ~100 turns/day, multi-month memory horizon) doesn't justify its architectural
choices (cross-encoder reranker, observation-extraction, mental-models). We'd be better
served by a different memory product or a custom-built one.

**The market right now (2026):**

| Option                       | Backing                          | Strengths                                                                      | Weaknesses for our use                                                                          |
| ---------------------------- | -------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| **Mem0**                     | OSS + cloud                      | Lighter retrieval, native fact extraction, well-documented Python SDK          | Less mature on "long memory" — better for short-term facts                                      |
| **Letta** (formerly MemGPT)  | OSS                              | Hierarchical memory (working / archival), explicit memory-management LLM calls | Heavier orchestration, optimized for "memory-as-tool" pattern with per-turn LLM overhead        |
| **Zep** (Cloud Memory)       | OSS + cloud                      | Knowledge-graph-aware, temporal reasoning, fast semantic                       | Cloud-leaning, our data is sensitive                                                            |
| **Cognee**                   | OSS                              | Graph + vector hybrid, ontology extraction                                     | Heavier on the graph side, immature                                                             |
| **Turbopuffer**              | Cloud-only                       | Crazy fast vector search, cheap                                                | Not a memory product per se — vector store only                                                 |
| **Custom (DIY on pgvector)** | Our existing Supabase + pgvector | Full control, no vendor lock, can match our exact use pattern                  | We own all the memory-product engineering — outcome tagging, consolidation, decay, observations |

**The two real candidates for "replace":**

1. **DIY on Supabase pgvector** (our existing data layer). We already have pgvector running
   on the Supabase stack (port 8100). The mc.db `conversations` table could move to
   Supabase + pgvector with a small migration. We get:
   - Our existing data shape, no vendor schema mismatch
   - Native SQL queries (no API calls — psycopg2 directly)
   - Outcome-aware retrieval is trivial to add (just a WHERE clause)
   - No reranker overhead by default; add one as a config knob if we want it
   - Direct integration with our existing `task_outcomes`, `task_provenance` tables

   **Cost:** ~3-4 weeks for a real implementation including consolidation logic,
   recall API surface, mc client, and migration of existing data. Pgvector v0.7+ gives us
   HNSW with reasonable tuning.

2. **Mem0 self-hosted**. Lighter than Hindsight, similar conceptual model, less
   orchestration overhead. Drop-in if we accept different bank semantics. Active
   development, decent maintainership.

   **Cost:** ~1.5-2 weeks for migration + recall client rewrite. Less of a step-change
   than DIY.

**Pros of REPLACE:** opportunity to design memory around our actual use pattern instead
of inheriting a generic one. The Vectorize-io product is being built for many
customers — its design choices (cross-encoder, observations, mental-models) trade flexibility
for a feature surface we don't all use.

**Cons:** highest risk. Memory is hard. Real memory products fail in subtle ways — the
"completed_task_failure_narrative" failure mode would have happened on any vector-recall
system; we'd have to build outcome-aware retrieval ourselves. Also: data migration is
non-trivial; we'd have to re-embed thousands of conversations.

---

## 4. Storage architecture options (the operator's "investigate options beside SQLite")

Since the actual storage backend is already pgvector (not SQLite), this section is about
the broader vector-store landscape, not "moving off SQLite." Pgvector is a strong
default — the question is whether any alternative is _materially_ better for our use pattern.

### Comparison

| Store                            | Latency p95 (1M vectors) | Recall@10 vs cosine ground truth | Operational                                    | Cost                      |
| -------------------------------- | ------------------------ | -------------------------------- | ---------------------------------------------- | ------------------------- |
| **pgvector (HNSW)** ← we're here | 50–100 ms                | ~95%                             | Embedded in vendor; we don't touch it directly | Included in container     |
| **pgvector (HNSW) on Supabase**  | 50–100 ms                | ~95%                             | Already running, we manage                     | $0 (existing infra)       |
| **Qdrant**                       | 5–30 ms                  | ~98%                             | Separate service, Docker                       | $0 (self-hosted)          |
| **Weaviate**                     | 10–50 ms                 | ~97%                             | Heavier, has built-in modules                  | $0 (self-hosted)          |
| **Turbopuffer**                  | 5–20 ms                  | ~95%                             | Cloud-only                                     | ~$5–20/month at our scale |
| **MongoDB Atlas Vector Search**  | 30–80 ms                 | ~96%                             | Cloud-only                                     | Pricey                    |
| **LanceDB**                      | 5–30 ms                  | ~97%                             | Embedded, file-based                           | $0                        |

**The honest read:** pgvector is good enough. None of the alternatives offer a step-change
for our scale (today's mc-jarvis bank is 385 memories; even at 100k memories pgvector
handles it). The real bottleneck isn't vector search — **it's the cross-encoder reranker
running sequentially on each candidate**. Switching vector stores doesn't fix that.

**Where storage WOULD matter:** if we go DIY (Path C option 1), moving from Hindsight's
embedded Postgres to our existing Supabase pgvector lets us reuse infrastructure, query
across `task_outcomes` and `conversations` in one transaction, and avoid a second
container's worth of operational surface.

---

## 5. Retrieval architecture options (the actual lever)

This is where the real gains are. Vector store is solved; reranker + outcome-awareness +
recall-pipeline-shape are not.

### 5a. Cross-encoder reranker — keep, replace, drop?

**Today:** every recall passes the cosine top-N candidates through a cross-encoder
(Hindsight uses a transformer-based reranker — likely BAAI/bge-reranker-large or
similar). 55 ms × N candidates, sequential.

**Options:**

- **Drop entirely** (cosine only): 5-10× faster. Quality drop measured roughly at 5-10%
  on academic benchmarks but could be more or less for our domain.
- **ColBERT-style late interaction** (instead of cross-encoder): 5-10× faster than CE,
  ~95% of CE quality. Embeddings get larger (~100x) but for our scale that's fine.
- **LLM-as-reranker for the top-K** (call qwen3-coder-plus on top 5-10): higher quality
  than cross-encoder for _reasoning_ recalls (e.g., "find me a past task where the same
  approach failed"), but adds another LLM call per recall.
- **Two-tier**: cheap reranker by default (cosine + metadata + recency boost), explicit
  expensive-rerank flag for analysis tasks.

**Best fit for "context is king + semantic priority":** ColBERT or two-tier. Both
preserve semantic depth while removing the linear-cost cliff.

### 5b. Outcome-aware ranking

**The fix for failure mode 1.** Every conversation row gets metadata at storage time:

```python
{
  "task_status": "success" | "failed" | "completed_with_concerns",
  "outcome_summary": "Read PDF via Drive download, summarized 5 bullets, accurate.",
  "tools_used": ["gdrive_download", "gemini_upload", "gemini_research"],
  "failed_tools": [],  # populated if any tool errored
}
```

Recall ranking applies an explicit penalty to `failed` rows and `concerns` rows. The
poisoned-thread failure mode becomes structurally impossible — the model never sees the
"Drive blocked, fall back" narrative as a positive precedent because it's tagged as
`failed`.

**Cost:** tagging is cheap (one LLM call at task end, or a deterministic classifier
based on `task.status` + `task.error`). Storage and recall changes are small. This is
the highest-leverage fix in the whole document and lands cleanly in any of the three
paths.

### 5c. Iterative / scaffolded retrieval

**Today:** Hindsight injects context once at task start. The LLM sees the recall before
it knows what it's doing, can't say "actually, I need different context for what I just
discovered." This is the one-shot retrieval limitation.

**Alternative — recall as a tool, not as injection.** Expose `memory_recall(query, k)`
as a tool the LLM calls explicitly when it needs context. Combined with the LLM's
own reasoning ("I should check if I've handled a similar situation before"), this is
how Anthropic's "Building Effective Agents" essay frames memory.

**Tradeoff:** requires the LLM to be deliberate about recall. Not all models are. Sonnet
4.6 / Opus are; some smaller models aren't.

---

## 6. Decision matrix

For each of the three paths, scored on the operator's stated priorities + our practical
constraints:

| Dimension                             | HARDEN                                            | DEMOTE                                                  | REPLACE                                     |
| ------------------------------------- | ------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------- |
| **Context is king** (recall coverage) | ★★★★ — keeps Hindsight's full feature set         | ★★★ — Hindsight as backup, primary moves to L4          | ★★★★ if DIY done well, ★★★ if Mem0          |
| **Semantic retrieval priority**       | ★★★★★ — full cross-encoder kept                   | ★★★★ — hybrid with cosine-first L4                      | ★★★★ if we keep reranker, ★★★ if we drop it |
| **Latency** (avg per recall)          | ~3 s today, ~1 s if we drop reranker for hot path | < 100 ms (L4) + Hindsight on slow path                  | depends on choices                          |
| **Outcome-blind retrieval bug fix**   | ✓ via metadata tagging                            | ✓ same fix                                              | ✓ same fix (and easier to design in)        |
| **Operational complexity**            | Same as today                                     | More moving parts, more code we own                     | Most code we own                            |
| **Freeze-fit**                        | Mostly fits (hardening)                           | Mostly fits (new layer is hardening of existing tables) | Doesn't fit (new vendor or major rewrite)   |
| **Cost (eng time)**                   | 2-3 weeks                                         | 2 weeks + outcome tagging                               | 2-4 weeks                                   |
| **Vendor risk**                       | Stays with Vectorize-io (one product, one team)   | Reduced — Hindsight failure doesn't break recall        | Eliminates Hindsight risk; introduces new   |
| **Reversibility**                     | High                                              | High (can re-promote)                                   | Low (migration cost)                        |

---

## 7. Open questions to answer before deciding

These are the questions I can't answer from inside the system; they need either
measurement or operator judgment:

1. **What % of Jarvis's "good" responses today actually used Hindsight recall?** Today we
   measure recall _latency_ but not recall _utility_. Without `was_used` tracking
   (proposed in Path A item 5), we can't tell if 32% timeout rate is hurting quality
   or merely consuming budget. **This is the single most important measurement** —
   gates whether HARDEN is worth the work or whether DEMOTE is the right call.

2. **How often does outcome-blind retrieval cause user-visible failures?** Tonight was
   one. Was it the only one this week? This month? Audit the last 30 days of
   `completed_with_concerns` tasks — how many recalled prior failures-as-precedents?

3. **What's the consolidation no-op rate?** Today's bank growth (91 → 385) suggests
   consolidator skipped at least one cycle. Need to instrument and count.

4. **Is the operator's "autonomous recall is critical" preference firm?** Path B's
   strongest version makes recall _deliberate_ (LLM-asks-for-it). If autonomous is a
   firm requirement, Path B's pure form is off the table.

5. **What's the longest-horizon memory we actually need?** If the answer is "this week,"
   simple FTS over recent conversations gets us 80% there. If it's "everything Jarvis
   has ever heard since session 1," that's a different architectural problem.

6. **Cross-encoder vs ColBERT vs cosine-only on our domain.** Need a small benchmark:
   take 50 representative recall queries from production, measure recall@10 and
   judgment-quality across the three approaches. Otherwise we're choosing on academic
   benchmark numbers that may not apply.

---

## 8. Recommendation framework

**My read** (engineering opinion, not a decision):

- **If outcome-blind retrieval is the dominant pain** (and tonight's incident suggests it
  is): outcome-aware metadata tagging is the highest-leverage single change. It lands in
  any of the three paths and is cheap. Do this regardless of which path is chosen.

- **If latency tax is the dominant pain**: drop the cross-encoder for hot-path recalls
  (Path A item 2) or move to two-tier retrieval. Massive headroom for very little risk.

- **If "Jarvis remembers" is conceptually the wrong frame**: DEMOTE (Path B). Build L4
  hybrid local retrieval as the primary "remember" layer, treat Hindsight as fuzzy
  long-term. The mental model shift is the actual win — recall stops being a single
  service and becomes a _layered system_.

- **If we believe Hindsight's architecture is fundamentally wrong for our use pattern**:
  REPLACE (Path C, DIY-on-Supabase-pgvector preferred over a new vendor). Highest risk,
  highest control. Don't take this path until we've measured #1, #2, #6 above.

**The honest order of investigation:**

1. Add the `was_used` audit and measure for 2 weeks → answers the "is Hindsight earning
   its keep" question definitively.
2. Ship outcome-aware metadata tagging (cheap, high leverage, lands in all paths) — the
   sub-piece of HARDEN that's safe to do during freeze if framed as hardening.
3. Run the cross-encoder vs cosine-only A/B for 2 weeks → answers the "do we need the
   reranker" question.
4. **Then** make the change/demote/harden decision with data, not vibes.

The freeze ends 2026-05-22. That's enough time to do steps 1-3 and have real numbers
before we decide. If steps 1-3 reveal that Hindsight is contributing < 20% of recall
quality but > 50% of recall latency, the decision writes itself.

---

## 9. What this doc is NOT

- A commitment to do any of this
- A criticism of Hindsight as a product (it's clearly built for a broader use case than
  ours and does many things we don't even use — observations, mental-models, graph)
- A statement that semantic retrieval should be deprioritized (the operator was clear it
  shouldn't; this doc preserves that as a hard constraint)
- An endorsement of a specific vendor (Mem0/Letta/Zep are listed for completeness; choosing
  one would need its own evaluation)

This doc exists to surface the options clearly so the post-freeze conversation can start
from the same factual baseline.

---

## 10. Appendix — current Hindsight knobs we've already tuned

For context (Session 112 work, captured in `feedback_hindsight_rehab.md`):

- `HINDSIGHT_API_RERANKER_MAX_CANDIDATES = 60` (was vendor default 300) — drops avg recall
  from ~10 s to ~3.8 s, p95 ~4.4 s, at the cost of recall coverage on a 220-mem bank
- Consolidation LLM swap: `qwen3.5-plus` (60 s/call) → `qwen3-coder-plus` (10 s/call)
- mc client `HINDSIGHT_RECALL_TIMEOUT_MS = 5000` (was 1500), NaN-guarded
- Out-of-tree audit DB at `/root/claude/ops/hindsight-monitor/audit.db` with 2-min recall
  scrape + 15-min bank scrape via systemd timers

Knobs we have NOT yet tuned (Path A surface):

- `bank_config_api` per-bank reranker disable / metadata schema / decay rules
- Embedding model swap (BAAI/bge-large-en vs OpenAI text-embedding-3-large vs Cohere)
- Index parameters (HNSW M, ef_construction, ef_search)
- Per-recall `top_k` and `min_score` thresholds

Each of these is an experiment we could run inside the HARDEN path before committing to
DEMOTE or REPLACE.
