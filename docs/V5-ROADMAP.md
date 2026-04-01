# v5.0 Roadmap — Agent Controller

> Preliminary plan based on deferred v4.0 items, CRITICAL-ASSESSMENT gaps, and operational learnings from the v4.0 session marathon (39 commits, 6 QA audits).
>
> Last updated: 2026-04-01 — DRAFT, will evolve over sessions
>
> External pattern sources: Crucix (delta engine, alert tiers), aden-hive/hive (compaction pipeline, doom-loop fingerprinting, quality gate), PraisonAI (ping-pong detector, content-chanting, escalation ladder, circuit breaker), OpenFang (outcome-aware loops, session repair, pair-aware trimming, phantom action detection, spending quotas)

## Guiding principle

v4.0 was about reliability — making Jarvis work correctly with existing models and tools. v5.0 is about scalability — making the architecture handle more users, more concurrent work, and smarter routing without accumulating complexity.

---

## Carried from v4.0

These were scoped but deferred during v4.0:

| Source   | Item                                                     | Why deferred                                                                                               |
| -------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| CRIT 1.1 | Worker threads for inference concurrency                 | Needs architecture change — single event loop blocks all work during 30s inference calls                   |
| CRIT 2.2 | Paired message pruning (tool_call + tool_result as unit) | Low urgency after token budget guards landed                                                               |
| CRIT 5.3 | Embedding-based tool scoping (replace keyword regex)     | Complex regex proved fragile (v4.0.6 catastrophic backtracking). Embeddings would eliminate regex entirely |
| CRIT 8.1 | Classifier weight calibration from task_outcomes         | Adaptive classifier adjustments exist but thresholds are untested                                          |
| CRIT 8.2 | Lower adaptive adjustment thresholds                     | Coupled to 8.1                                                                                             |
| CRIT 7.3 | Credential detection (only from user messages)           | Low incident rate                                                                                          |

### Known issues from v4.0.18 QA audit (2026-04-01)

Resolved in v4.0.18: WRITE_TOOLS phantom names (H1), fullCount diagnostic (H2), meta scope missing commit_journal (W1), case-miner missing research group (W3), SPECIALTY_TOOLS partial test coverage (W4), zero detectActiveGroups tests (W5). Two items carry into v5:

| Issue                                                                                                                                                                                                                                               | Impact                                                                                       | Resolution path                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **detectActiveGroups diverges from scopeToolsForMessage** — no short-message follow-up inheritance, no imperative verb detection. Eval runner and router logging produce wrong scope accuracy for follow-up patterns ("Procede", "Dale", "Ejecuta") | Eval scope_accuracy scores systematically wrong for ~30% of real messages (short follow-ups) | S3 (embedding scoping) replaces both functions. If S3 is delayed, extract shared two-phase + follow-up logic into a helper consumed by both                                 |
| **No compile-time sync between WRITE_TOOLS (fast-runner) and registered tool names** — phantom names went undetected until audit                                                                                                                    | Hallucination guard blind to renamed/added tools                                             | Add cross-reference test in S1 (guards): assert every WRITE_TOOLS entry exists in toolRegistry, and every write tool in GOOGLE_TOOLS / COMMIT_WRITE_TOOLS is in WRITE_TOOLS |

---

## New themes from v4.0 learnings

### Theme 1: Inference concurrency

**Problem**: One LLM call blocks everything. Playwright browsing tasks take 2+ minutes of inference rounds — during which no other Telegram message is processed.

**Direction**: Move inference calls to worker threads. The fast-runner's `inferWithTools` loop is CPU-idle (waiting on network). Worker threads would allow true concurrency without additional cores.

**Open questions**:

- How to share tool registry across threads (it's a singleton with MCP connections)?
- Worker pool size? Memory budget is ~3GB free.
- Does streaming (onTextChunk callback) work across thread boundaries?

---

### Theme 2: Smarter tool scoping

**Problem**: Keyword regex for scope is fragile (catastrophic backtracking, Spanish morphology, clitic pronouns). The v4.0.6 fix was to merge scopes — but this loads more tools per message (~40 tokens each).

**Direction**: Replace keyword regex with embedding similarity. Compute a vector for the user message, compare against pre-computed scope group vectors, activate groups above a threshold.

**Benefits**: No regex, no language-specific patterns, handles synonyms and rephrases naturally.

**Open questions**:

- Latency? Embedding call adds ~200ms. Acceptable for Telegram but not for fast-path.
- Cache? Most messages in a conversation share scope — cache the last scope decision.
- Hybrid? Keep simple keyword triggers for core groups (COMMIT nouns), use embeddings for finer-grained groups.

---

### Theme 3: Memory architecture + Multi-level compaction

**Problem**: Thread buffer (15 entries) is a ring buffer — high-value outputs get evicted alongside greetings. The v4.0.10 fix (auto-persist prompt) is soft — depends on LLM compliance. The current `context-compressor.ts` uses a single-level PRESERVE+ADD strategy — when it fails, the fallback is to drop messages without summary.

**Direction**: Two improvements stacked together:

1. **Mechanical auto-persist** — detect output characteristics (length > N chars, tool_calls > M, Playwright browsing involved) and automatically call memory_store with a structured summary.

2. **Multi-level compaction pipeline** (adapted from aden-hive/hive's `compaction.py`) — replace the single PRESERVE+ADD with a 4-level fallback chain:
   - **Level 0**: Prune old tool results (free, fast — already partially done via `MAX_TOOL_RESULT_CHARS`)
   - **Level 1**: Structure-preserving compaction with paired message pruning (CRIT 2.2 — tool_call + tool_result as unit)
   - **Level 2**: LLM recursive summary — when conversation exceeds the compaction LLM's own context, binary-split messages, summarize each half, concatenate. Recurse up to 5 levels.
   - **Level 3**: Emergency deterministic summary (no LLM — extract last user question + tool names called + final assistant response). Current drop-without-summary fallback is replaced by this.

   Each level fires only when the previous level's output still exceeds the target. This eliminates the "compressor itself runs out of context" failure mode.

**Related**: The v4.0 S9 tool_chain attribution needs more data before the self-tuning system can learn from it. Implicit feedback detection is live but needs production validation.

**Open questions**:

- What constitutes "high-value"? Length alone is insufficient (long error messages aren't valuable).
- Should auto-persist be mechanical (post-hoc in fast-runner) or LLM-driven (prompt instruction)?
- Memory consolidation: how to merge overlapping memories over time?
- Level 2 recursive split: use the same model as the main inference, or a cheaper/faster one?

---

### Theme 4: Multi-user architecture

**Problem**: Everything is single-user (Fede). Thread buffer, user_facts, conversation history, Hindsight bank — all assume one user.

**Direction**: Per-user isolation. PostgreSQL migration for concurrent writes, Redis for session state, user_id column on all tables.

**Dependencies**: Only worth building when there's a second user. Currently premature.

---

### Theme 5: A2A agent mesh

**Problem**: CRM (crm-azteca) and agent-controller are separate systems. Cross-system workflows (e.g., CRM prospect data → Jarvis analysis → COMMIT task creation) require manual coordination.

**Direction**: A2A protocol already implemented (v2.2). Need to deploy CRM as an A2A agent and wire bidirectional task delegation. Plan exists at `docs/PLAN-A2A-AGENT-MESH.md`.

---

### Theme 6: Guard upgrades — doom-loop detection + escalation + circuit breaker

**Problem 1**: The current `buildToolSignature()` in `guards.ts` concatenates `name:arguments` as raw strings and sorts. This misses three classes of loops:

- **Reordered JSON keys** — `{"a":1,"b":2}` vs `{"b":2,"a":1}` produce different strings but are identical calls.
- **Ping-pong patterns** (from PraisonAI) — LLM alternates between tool A and tool B (e.g., `web_search` → `exa_search` → `web_search` → `exa_search`). Each consecutive pair is "different" so the repeat guard doesn't fire, but the agent is stuck.
- **Content chanting** (from PraisonAI) — LLM's _text responses_ become repetitive even when tool calls vary. Sliding-window chunk hashing catches this cheaply.

**Direction**:

- **Canonical JSON fingerprinting** (from hive): Parse arguments as JSON, sort keys recursively, re-serialize, then SHA-256. Catches reordered keys, whitespace differences, trivial variations.
- **Outcome-aware escalation** (from OpenFang): Track `(callHash, resultHash)` pairs, not just `callHash`. Same call + same result = definitely stuck → escalate faster. Same call + different result = might be legitimate retry → slower escalation. One field addition to fingerprint tracking.
- **Ping-pong cycle detector** (from PraisonAI): Track last N fingerprints as a sequence. Detect period-2 (A-B-A-B) and period-3 (A-B-C-A-B-C) cycles. ~30 lines of pure logic.
- **Content-chanting detector** (from PraisonAI): 50-char sliding window segments, hash each, trigger when 8+ repeated hashes in LLM text output. Faster/lighter check than pairwise n-gram — fires first as Level-0.
- **N-gram Jaccard similarity** (from hive): Pairwise 3-gram comparison on text responses. Fires as Level-1 after content-chanting check passes.
- All pure functions, testable in isolation.

**Problem 2**: Wrap-up delivery sometimes fires when required tools were called but the actual output is low quality — "checkbox checking." Additionally, the LLM sometimes _claims_ to have performed actions (sent email, posted message) without calling the corresponding tool.

**Direction**:

- **Quality gate** (from hive): After mechanical checks pass (STATUS line parsed, required tools called), one fast LLM call to verify the response actually answers the user's question. Only on `DONE` status. Cheapest model, YES/NO + reason.
- If NO: inject nudge, grant 2 more rounds. Gate fires at most once per task.
- **Phantom action detection** (from OpenFang): Post-response heuristic — if response text contains action verbs ("sent", "posted", "emailed", "delivered") + channel references ("telegram", "whatsapp", "email") but no matching tool call was made that round, flag as phantom action and inject correction nudge. Complements the existing tool-skip guard in adapter.ts which catches round-0 claims, by catching mid-conversation phantoms too.

**Problem 3**: Guard break → wrap-up is a binary decision. No intermediate recovery steps.

**Direction** — **Graduated escalation ladder** (from PraisonAI): Formalize the implicit recovery chain into an explicit `EscalationLevel` enum:

```
Level 1: RETRY_DIFFERENT  — inject nudge, suggest different approach (current behavior)
Level 2: ESCALATE_MODEL   — switch to a stronger/different model if available
Level 3: FORCE_WRAPUP     — forced wrap-up with quality gate (S1.4)
Level 4: ABORT            — deliver BLOCKED status, no retry
```

Currently, guards jump directly from nudge (Level 1) to forced wrap-up (Level 3). Adding Level 2 (model escalation) gives the agent one more chance before giving up — particularly useful when a cheaper model is stuck but a stronger one could solve it.

**Problem 4**: External service failures are detected reactively via `checkPersistentFailure()` (after N failures in one inference loop). A provider outage burns rounds and tokens across _all_ tasks before each independently discovers it's broken.

**Direction** — **Circuit breaker registry** (from PraisonAI): CLOSED/OPEN/HALF_OPEN state machine per service, shared across all tasks.

- Registry keyed by service identifier (`google`, `openai`, `wordpress`, etc.)
- Tool sources report failures to the breaker on each error
- **CLOSED** → **OPEN**: trips at 5 failures within 60 seconds
- **OPEN** → **HALF_OPEN**: after 30-second cooldown, allows 1 probe call
- **HALF_OPEN** → **CLOSED**: probe succeeds → reset failure count
- **HALF_OPEN** → **OPEN**: probe fails → restart cooldown
- When OPEN, tool calls return a fast structured error: `"Service {name} is temporarily unavailable (circuit breaker open). Try again later or use an alternative."`

This prevents cascading failures across tasks and gives the LLM clear feedback to try alternatives instead of retrying broken tools.

**Problem 5**: Conversation history can contain orphaned ToolResults (no matching ToolUse), unmatched ToolUse blocks (no result), and duplicate ToolResults. These inconsistencies trigger LLM hallucinations — the model sees a function call with no result and invents one, or sees a result with no call and gets confused. Currently `sanitizeToolPairs()` in `context-compressor.ts` handles this, but only during compaction — not before every LLM call.

**Direction** — **Session repair pass** (from OpenFang's `session_repair.rs`): Run validation before every inference call, not just during compaction:

- Remove orphaned ToolResult blocks (no matching ToolUse)
- Insert synthetic error results for unmatched ToolUse blocks: `"Error: tool execution result was not received"`
- Deduplicate ToolResults with the same `tool_use_id`
- Merge consecutive same-role messages
- Return `RepairStats` for observability (Prometheus counter)
- **Pair-aware drain boundary** (from OpenFang's `context_overflow.rs`): When trimming messages to fit context, never split a ToolUse from its ToolResult. Adjust the drain point backward to keep pairs intact. Directly applicable to S1.2 Level 1 paired pruning.

**Problem 6**: No aggregate spending caps. Per-round token budgets (`TOKEN_BUDGET_FAST=28K`) exist but no hourly/daily/monthly cost tracking. As intelligence depot (S6-S8) adds continuous LLM calls for signal classification, aggregate cost could silently grow.

**Direction** — **Three-window spending quotas** (from OpenFang's `metering.rs`): Per-agent and global enforcement at hourly/daily/monthly windows. Pre-call gating: before each LLM call, check if quota is available at all three windows. If any is exhausted, block and return a structured error. Configurable per runner type (fast runner gets smaller hourly budget than Prometheus).

**Open questions**:

- Quality gate adds one LLM call (~200ms + cost). Worth it for every forced wrap-up, or only specific guard triggers?
- N-gram window size: how many consecutive responses to compare? Hive uses 5, PraisonAI uses 8 chunks. Our rounds are more tool-heavy — likely 4 is sufficient.
- Circuit breaker: should tool sources auto-register, or explicit mapping in config?
- Escalation Level 2 (model switch): which models are valid escalation targets? Need a model capability tier list.
- Session repair: should synthetic error insertion count toward the persistent failure guard, or be excluded?
- Spending quotas: what are reasonable hourly/daily limits? Need production baseline data first.

---

### Theme 7: Breadth-first knowledge acquisition for Prometheus

**Source**: HyperGraph (hyperbrowserai/hyperbrowser-app-examples) — adapted from their breadth-first-then-expand pattern.

**Problem**: When Prometheus encounters an unfamiliar domain (e.g., "analyze Mexican telecom regulation trends"), it dives straight into tool calls without understanding the domain structure. This leads to shallow or misguided plans — the planner doesn't know what it doesn't know.

**Direction**: A `knowledge_map` tool that generates a structured domain overview before deep execution. Two-phase:

1. **Map phase** (during `plan()`): Given a topic, scrape 3-5 top sources (web_search + web_read), send to LLM to produce a 8-12 node concept map stored in SQLite. Each node has: id, label, type (`concept | pattern | gotcha`), one-paragraph summary, and links to related nodes with justification ("follow this if X is relevant to the task").
2. **Expand phase** (during `execute()`): When a goal requires deeper domain knowledge, expand a specific node — scrape topic-specific sources, generate 3-6 child nodes. Parent summary is updated with links to children.

**Key design constraints**:

- Nodes stored in SQLite (`knowledge_nodes` table), reusable across tasks. A map on "Mexican telecom" persists for future queries.
- Progressive depth: initial retrieval returns broad overviews. Deeper nodes fetched only when the reflector identifies a knowledge gap.
- Links carry semantic justification (wikilink-in-prose pattern) — not "see also: spectrum_auction" but "if the task involves pricing, [[spectrum_auction]] explains how IFT allocates bandwidth, which drives carrier costs."
- Budget cap: max 60 nodes per topic, max depth 5. Expansion costs ~1 LLM call + 2-3 scrapes per node.
- Not a replacement for web_search — complementary. web_search answers specific questions; knowledge_map builds domain understanding.

**Integration with Prometheus**:

- Planner checks if a relevant knowledge map exists before generating goals. If not, first goal is "build domain overview."
- Reflector scores goal outcomes against knowledge map: "did the execution address the key concepts and gotchas?"
- Executor can request node expansion mid-execution when it hits a knowledge gap.

**Open questions**:

- Should maps expire? Domain knowledge gets stale. TTL per topic, or user-triggered refresh?
- How to detect "unfamiliar domain"? Heuristic: if the planner's first attempt produces vague goals with no specific tool calls, trigger map generation.
- Overlap with Hindsight memory: knowledge maps are structured, Hindsight is freeform. Keep separate or merge retrieval?

---

### Theme 8: Research verification + provenance

**Source**: Feynman (getcompanion-ai/feynman) — adapted from their 3-layer prompt-based verification pipeline (researcher → verifier → reviewer) and provenance sidecar pattern.

**Problem**: When Jarvis performs research tasks (web_search + exa_search + web_read), there's no mechanical verification that cited sources actually support the claims, no record of what was consulted vs. accepted vs. rejected, and no structured distinction between verified facts and inferences. The 7-layer hallucination detection catches fabricated tool calls but not fabricated citations or unsupported claims within legitimate tool results.

**Direction**: Four improvements that extend the Prometheus reflect phase with research-specific verification:

1. **Provenance records** — After every Prometheus task completion, write a structured provenance record to a `task_provenance` SQLite table:
   - `task_id` (FK to tasks), `sources_consulted` (JSON array of URLs/tools), `sources_accepted` (subset actually cited), `sources_rejected` (consulted but not used, with reason), `verification_passes` (which checks ran and their outcomes), `intermediate_artifacts` (file paths, knowledge map node IDs)
   - Lightweight audit trail — one INSERT per completed task, no ongoing cost.

2. **Mechanical source anchoring** — During the Prometheus reflect phase, for research-heavy tasks: extract claimed URLs from the assistant's response, verify each URL appears in the content actually fetched by web_read/exa_search during execution. Flag any URL that wasn't fetched as `unverified`. This is the code-level equivalent of Feynman's "URL or it didn't happen" rule.
   - Implementation: compare claimed URLs against `tool_calls` history for the task. If a URL is cited but no `web_read(url)` or `exa_search` result contains it, mark the claim as unverified and inject a correction nudge.

3. **Source status tagging** — Extend the evidence model with a 3-state classification: `verified` (URL fetched + content confirms claim), `inferred` (URL fetched but claim is the agent's interpretation), `unverified` (no supporting tool call). The reflector uses this to score research quality and decide whether to replan.

4. **Search result condensation** — When web_search returns results from multiple queries (>2), pass them through a cheap LLM call to extract key findings before returning to the main inference loop. Reduces token bloat from raw search results without losing signal.
   - Implementation: optional `condense: true` parameter on web_search tool. When enabled, calls `infer()` with a condensation prompt on the combined results. Budget: ~500 tokens output.

**Integration with existing systems**:

- Provenance records feed into the scope telemetry / outcome attribution pipeline (v4.0 S9). The `sources_accepted` list links to `tool_chain` entries.
- Source anchoring complements Layer 2 (tool inventory check) of the hallucination guard — Layer 2 catches "no tool called", source anchoring catches "tool called but claim doesn't match content."
- Condensation reduces the prompt bloat problem (documented in `feedback_prompt_bloat.md`) at the tool-result level.

**Also adopted from Feynman** (convention-level, no code):

- **Source integrity rules** for research-scoped prompts: "URL or it didn't happen", "read before you summarize", "mark status honestly (verified/inferred/unverified)", "never extrapolate details you haven't read." Added to Prometheus executor prompt template when research tools are in scope.
- **Slug-based artifact namespacing** for long-running research: derive a slug from the topic, use consistently across intermediate files and knowledge map nodes. Prevents collision in concurrent tasks.

**Open questions**:

- Source anchoring adds latency (URL extraction + comparison). Run it only on Prometheus tasks, or also on fast-runner research?
- Condensation LLM call cost vs. token savings — need production data to validate the tradeoff.
- Should provenance records be user-visible (via Telegram summary) or internal-only (for telemetry)?

---

### Theme 9: Video production — clean-room TypeScript reimplementation

**Inspiration**: OpenMontage (calesthio/OpenMontage) — architecture, provider cascade, and Remotion composer approach. We reimplement the capability in TypeScript from scratch rather than wrapping or porting the AGPLv3 Python codebase. OpenMontage's tools are thin wrappers around provider APIs (fal.ai, ElevenLabs, Pexels) and FFmpeg CLI — the logic is dictated by the providers, not by OpenMontage's code.

**Goal**: Give Jarvis the ability to produce short videos on demand via Telegram — explainers, social clips (TikTok/Reels/Shorts), product ads, trailers. User says "hazme un video de 60 segundos explicando redes neuronales" and gets back an MP4.

**Why TypeScript, not Python sidecar**:

| Concern           | Python sidecar                               | TS reimplementation                  |
| ----------------- | -------------------------------------------- | ------------------------------------ |
| Language friction | HTTP bridge, JSON serialization, 2 processes | Zero — same process, same ToolSource |
| License           | AGPLv3 contained behind HTTP boundary        | Clean-room — no AGPLv3 at all        |
| Ops overhead      | Extra systemd service, health checks         | None — deploys with agent-controller |
| Tool integration  | Custom job polling pattern                   | Standard ToolSource, direct registry |
| Maintenance       | Track upstream Python + our wrapper          | We own it, evolve freely             |
| Scope             | All 57 tools (most unused)                   | Only the ~10 we need                 |

**Architecture**: All-TypeScript, in-process. Video tools register as a `VideoToolSource` implementing our existing `ToolSource` interface. Remotion is already TypeScript/React. FFmpeg and Piper are invoked via `child_process.exec()`.

```
User (Telegram)
  → Jarvis (agent-controller, TS)
    → video_create tool (in-process)
      → Pipeline (all TypeScript):
         1. video_script — LLM generates timestamped narration via infer()
         2. image_generate — fal.ai FLUX / Pexels stock via fetch()
         3. tts_generate — Piper CLI / ElevenLabs API via exec() / fetch()
         4. audio_mix — FFmpeg ducking + overlay via exec()
         5. video_compose — Remotion render via npx exec()
         6. video_stitch — FFmpeg concat + H.264 encode via exec()
      → Returns: video_path, duration, cost, thumbnail
    → Telegram: send video file
```

**Tool inventory** (~10 tools, new `video` scope group):

| Tool                  | What                                                          | Implementation                                 | Complexity |
| --------------------- | ------------------------------------------------------------- | ---------------------------------------------- | ---------- |
| `video_create`        | Orchestrate full pipeline: script → assets → compose → encode | Pure TS, calls other tools sequentially        | Medium     |
| `video_status`        | Track long-running job (queued/rendering/done/failed)         | SQLite `video_jobs` table                      | Low        |
| `video_script`        | LLM generates timestamped narration with scene descriptions   | `infer()` with structured output (Zod schema)  | Low        |
| `video_tts`           | Text-to-speech: Piper (local, free) or ElevenLabs (API)       | `exec('piper ...')` or `fetch(elevenlabs_url)` | Low        |
| `video_image`         | Generate scene images: fal.ai FLUX (~$0.03) or Pexels (free)  | `fetch()` to provider API                      | Low        |
| `video_compose`       | Render image sequence + audio via Remotion                    | `exec('npx remotion render ...')`              | Medium     |
| `video_stitch`        | FFmpeg concat, encode H.264/AAC, platform profile             | `exec('ffmpeg ...')`                           | Low        |
| `video_audio_mix`     | FFmpeg: layer narration + music with ducking                  | `exec('ffmpeg -filter_complex ...')`           | Low        |
| `video_subtitle`      | Generate SRT/VTT from script timestamps                       | Pure TS string builder                         | Trivial    |
| `video_list_profiles` | List available styles and platform render profiles            | Pure TS, static data                           | Trivial    |

**ToolSource implementation** (`src/tools/sources/video-source.ts`):

```typescript
class VideoToolSource implements ToolSource {
  name = "video";

  async initialize(): Promise<void> {
    // Check FFmpeg available: exec('ffmpeg -version')
    // Check Remotion installed: exec('npx remotion --version')
    // Check Piper available: exec('piper --version')
    // Detect API keys: FAL_KEY, ELEVENLABS_API_KEY, PEXELS_API_KEY
  }

  async registerTools(registry: ToolRegistry): Promise<void> {
    // Register all video_* tools with Zod schemas + .describe()
    // Scope group: "video" — keyword-gated on video/explainer/clip/TikTok/Reels
  }

  async healthCheck(): Promise<HealthStatus> {
    // Report: FFmpeg ok, Remotion ok, providers available (tier 0/1/2/3)
  }
}
```

**Provider cascade** (zero-key to premium):

- **Tier 0 (free, no API keys)**: Pexels stock images + Piper TTS + FFmpeg compose. Functional but generic.
- **Tier 1 (~$0.30-0.50/video)**: fal.ai FLUX images (~$0.03/image) + Piper TTS. Custom AI visuals.
- **Tier 2 (~$1-3/video)**: fal.ai FLUX + ElevenLabs TTS + background music. Quality narration.
- **Tier 3 (~$3-10/video)**: FLUX + ElevenLabs + AI video clips (Kling/Veo via fal.ai). Motion video.

Provider selection is automatic based on available API keys. User can override via tool parameters.

**Remotion composer** (`src/tools/video/remotion-composer/`):

Minimal React project — reusable across renders:

- `Explainer.tsx` — main composition: image sequence + text overlays + transitions
- `Subtitle.tsx` — burned-in subtitle component
- `TitleCard.tsx` — intro/outro cards
- Video rendered via `npx remotion render Explainer --props <json>` into the output directory
- Pre-installed at deploy time (`npm install` in the remotion-composer dir)

**Pipeline orchestration** (inside `video_create` tool handler):

```typescript
async function executeVideoJob(params: VideoCreateInput): Promise<VideoResult> {
  const job = await createJob(params); // SQLite insert, returns job_id

  // 1. Script — LLM generates structured narration
  const script = await infer(scriptPrompt(params), { schema: scriptSchema });

  // 2. Assets — parallel: images + TTS + music
  const [images, narration, music] = await Promise.all([
    generateImages(script.scenes, params.image_provider),
    generateTTS(script.narration, params.voice_provider),
    params.music_enabled ? fetchMusic(script.mood) : null,
  ]);

  // 3. Audio mix — layer narration + music with ducking
  const audioPath = await mixAudio(narration, music);

  // 4. Compose — Remotion render (image sequence + audio + subtitles)
  const rawVideoPath = await renderRemotionVideo(
    images,
    audioPath,
    script,
    params,
  );

  // 5. Encode — FFmpeg final encode to platform profile
  const finalPath = await encodeForPlatform(rawVideoPath, params.platform);

  return { video_path: finalPath, duration: script.duration, cost: job.cost };
}
```

Asset generation (step 2) runs in parallel via `Promise.all` — images, TTS, and music are independent. This is the main time savings vs. sequential execution.

**Task routing**: Video creation is long-running (5-20 min). Two modes:

1. **Fast runner** — For simple requests. `video_create` runs the full pipeline in a single tool call. The fast runner's existing round-based loop handles it — the tool call just takes longer. User gets a "generating video..." Telegram message, then the result.
2. **Heavy runner (Prometheus)** — For complex requests needing research first. Planner decomposes: research topic → write script → generate assets → compose video. Each goal maps to tool calls. Reflector verifies output quality.

The classifier routes based on complexity: "hazme un video corto de gatos" → fast runner. "Produce a 90-second explainer on quantum computing with real research data" → Prometheus.

**Scope integration**:

New `video` scope group in `scope.ts`:

```typescript
export const VIDEO_TOOLS = [
  "video_create",
  "video_status",
  "video_script",
  "video_tts",
  "video_image",
  "video_compose",
  "video_stitch",
  "video_audio_mix",
  "video_subtitle",
  "video_list_profiles",
];
```

Scope pattern: `/\b(video|clip|explainer|tiktok|reels?|shorts?|trailer|anima(ción|tion)|produci?r?\s+.*video|graba|render)/i`

**Budget governance**:

- CONFIRMATION_REQUIRED on `video_create` — user must confirm before spending
- Per-job cost tracking in `video_jobs` SQLite table
- Default budget: $2/video, configurable via parameter
- Cost estimated before execution, checked against spending quotas (S1.7)
- Provider tier auto-selected to stay within budget

**SQLite schema** (additive — no DB reset):

```sql
CREATE TABLE IF NOT EXISTS video_jobs (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  status TEXT NOT NULL DEFAULT 'queued',  -- queued | scripting | generating | composing | encoding | done | failed
  prompt TEXT NOT NULL,
  style TEXT,
  platform TEXT DEFAULT 'youtube_landscape',
  duration_target INTEGER,
  duration_actual REAL,
  cost_usd REAL DEFAULT 0,
  video_path TEXT,
  thumbnail_path TEXT,
  subtitle_path TEXT,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);
```

**VPS requirements** (no Python needed):

- FFmpeg: `apt install ffmpeg` (~50MB)
- Node.js 18+: already have
- Remotion: `cd remotion-composer && npm install` (~200MB)
- Piper TTS: download binary + voice model (~150MB)
- Disk: ~400MB base + workspace for rendered videos
- RAM: +1-2GB during Remotion renders (within our 8GB VPS budget)
- No GPU, no Python

**Scope constraints**:

- Video duration: 15-120s (short-form only)
- Resolution: 1080p max
- Concurrent renders: 1 at a time (memory constraint — enforced via semaphore)
- Budget default: $2/video, configurable per request
- Auto-cleanup: rendered videos deleted after 24h via cron (disk constraint)

**Platform render profiles** (static config, adapted from OpenMontage's `media_profiles.py`):

| Profile           | Resolution | Aspect | FPS | CRF | Max Duration |
| ----------------- | ---------- | ------ | --- | --- | ------------ |
| youtube_landscape | 1920x1080  | 16:9   | 30  | 23  | unlimited    |
| youtube_shorts    | 1080x1920  | 9:16   | 30  | 23  | 60s          |
| instagram_reels   | 1080x1920  | 9:16   | 30  | 23  | 90s          |
| instagram_feed    | 1080x1080  | 1:1    | 30  | 23  | 60s          |
| tiktok            | 1080x1920  | 9:16   | 30  | 23  | 180s         |
| linkedin          | 1920x1080  | 16:9   | 30  | 23  | 600s         |

**Open questions**:

- Remotion render is CPU-intensive (~30-120s for 60s video). May need `nice -n 19` on the child process to avoid starving agent-controller. Test under load.
- Piper TTS quality vs. ElevenLabs — is Piper good enough for tier 0? Need to A/B test with real users.
- Should `video_create` be a single mega-tool or should Jarvis call the sub-tools individually? Lean: mega-tool for fast runner, individual tools for Prometheus.
- Music sourcing: Suno API is pay-per-use via third-party wrapper (sunoapi.org). Alternatives: royalty-free library, or skip music for tier 0/1.
- Subtitle burn-in vs. sidecar SRT — burn-in is simpler but prevents language switching. Start with burn-in, add sidecar later.

---

## Tentative session structure

| Session | Theme                   | Scope                                                                                                                                                                    | Source                      |
| ------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| S1      | Memory + Guards         | 8 sub-items: auto-persist, 4-level compaction, 5-layer doom-loop, escalation ladder + quality gate + phantom detection, circuit breaker, session repair, spending quotas | hive + PraisonAI + OpenFang |
| S2      | Inference workers       | Move inferWithTools to worker_threads. Pool of 2-3 workers.                                                                                                              | v4 carry                    |
| S3      | Embedding-based scoping | Replace keyword regex with vector similarity for scope groups.                                                                                                           | v4 carry                    |
| S4      | A2A mesh                | CRM ↔ Jarvis bidirectional task delegation.                                                                                                                              | v4 carry                    |
| S5      | Classifier calibration  | Outcome-driven weight tuning, lower thresholds, negative feedback loop.                                                                                                  | v4 carry                    |
| S5b     | Knowledge maps          | `knowledge_map` tool for Prometheus: breadth-first domain overview (8-12 nodes), expand-on-demand, SQLite persistence, reflector integration.                            | HyperGraph                  |
| S5c     | Research verification   | Provenance records (`task_provenance` table), mechanical source anchoring, source status tagging (verified/inferred/unverified), search condensation.                    | Feynman                     |
| S5d     | Video production        | Clean-room TS reimplementation: VideoToolSource (~10 tools), Remotion composer, FFmpeg, provider cascade (Pexels/FLUX/ElevenLabs/Piper), budget governance, video scope. | OpenMontage (inspiration)   |
| S6      | Intel Depot: Foundation | 30-source collector adapters + signal store (SQLite) + delta engine. See `V5-INTELLIGENCE-DEPOT.md`                                                                      | Crucix                      |
| S7      | Intel Depot: Streaming  | WebSocket hub (Finnhub, Bluesky), alert router (FLASH/PRIORITY/ROUTINE), remaining adapters                                                                              | Crucix                      |
| S8      | Intel Depot: Prediction | Statistical baselines, anomaly detection, trend analysis, Jarvis tools + ritual integration                                                                              | Crucix                      |
| S9+     | Multi-user              | PostgreSQL, Redis, per-user isolation. Only if needed.                                                                                                                   | —                           |

---

## Metrics to track

| Metric                   | v4.0 baseline         | v5.0 target                                                        |
| ------------------------ | --------------------- | ------------------------------------------------------------------ |
| Feedback signal rate     | 5/603 explicit (0.8%) | >15% with implicit signals                                         |
| Tool chain attribution   | New (S9)              | Self-tuning proposes mutations based on chain success rates        |
| Concurrent task handling | 1 (sequential)        | 3 (worker threads)                                                 |
| Scope false positives    | Unknown (no tracking) | <5% (embedding-based)                                              |
| Memory recall precision  | Unknown               | Track via scope_telemetry + feedback loop                          |
| Avg response time        | ~15s (full pipeline)  | <10s (with worker concurrency)                                     |
| Doom-loop detection      | String-match only     | Canonical JSON + ping-pong cycle + content-chanting + n-gram       |
| Wrap-up quality          | No verification       | Quality gate on forced wrap-ups (cheapest model, YES/NO)           |
| Compaction fallback hits | No tracking           | Track L0/L1/L2/L3 invocations via Prometheus counter               |
| Circuit breaker trips    | None (no breaker)     | Track trips per service, prevent cascading failures                |
| Escalation events        | Binary (nudge→wrap)   | 4-level ladder with per-level Prometheus counters                  |
| Session repairs          | Compaction-only       | Pre-inference: orphan removal, synthetic errors, dedup             |
| Phantom actions caught   | None                  | Post-response heuristic (action verb + channel, no tool)           |
| Spending (aggregate)     | Per-round only        | Three-window (hourly/daily/monthly) with pre-call gating           |
| Signal sources active    | 0 (manual web search) | 25+ (automated polling + 3 WebSocket streams)                      |
| Signal-to-alert latency  | ~24h (daily ritual)   | <5 min (delta engine + alert router)                               |
| FLASH alerts/week        | 0                     | <3 (high-value, low-noise)                                         |
| Anomaly detection        | None                  | z-score baselines at 5 windows, auto-escalation on z>3             |
| Knowledge maps           | None                  | Persistent domain maps in SQLite, breadth-first + expand-on-demand |
| Research provenance      | None                  | Per-task audit trail: sources consulted/accepted/rejected          |
| Source anchoring         | None                  | Mechanical URL-in-content check during reflect phase               |
| Unverified claims        | No tracking           | <10% of research task claims tagged as unverified                  |
| Videos produced          | None                  | On-demand short video creation via Telegram (15-120s)              |
| Video cost per unit      | N/A                   | $0.30-3.00 per video depending on provider tier                    |
| Video render time        | N/A                   | <20 min for 60s video (cloud APIs)                                 |

---

## S1 Detailed Scope: Memory + Guards

S1 bundles eight improvements into one session. They share no code dependencies but all target the same failure class: Jarvis losing context or delivering garbage after long inference chains. Given the scope, S1 may split into S1a (guards: S1.1, S1.4, S1.5, S1.6) and S1b (memory: S1.2, S1.3, S1.7) at execution time.

### S1.1 — Multi-layer doom-loop detection

**Files**: `src/inference/guards.ts`, `src/inference/guards.test.ts`

Replace `buildToolSignature()` with a 4-layer detection stack. Each layer catches a different failure pattern, ordered cheapest-first:

**Layer 0 — Content-chanting detector** (from PraisonAI)
Catches: LLM text responses becoming repetitive even when tool calls vary.

```typescript
function isContentChanting(
  text: string,
  chunkSize = 50,
  threshold = 8,
): boolean {
  const hashes = new Map<string, number>();
  for (let i = 0; i <= text.length - chunkSize; i++) {
    const h = simpleHash(text.slice(i, i + chunkSize));
    hashes.set(h, (hashes.get(h) ?? 0) + 1);
    if (hashes.get(h)! >= threshold) return true;
  }
  return false;
}
```

**Layer 1 — Canonical JSON fingerprinting + outcome-aware tracking** (from hive + OpenFang)
Catches: Identical tool calls with reordered JSON keys, whitespace differences. Outcome-aware: tracks `(callHash, resultHash)` pairs — same call + same result escalates 2x faster than same call + different result.

```typescript
function canonicalize(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonicalize).join(",") + "]";
  return (
    "{" +
    Object.keys(obj as Record<string, unknown>)
      .sort()
      .map(
        (k) =>
          JSON.stringify(k) +
          ":" +
          canonicalize((obj as Record<string, unknown>)[k]),
      )
      .join(",") +
    "}"
  );
}

function fingerprintToolCalls(calls: ToolCall[]): string {
  const normalized = calls
    .map((tc) => {
      let args: unknown;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        args = tc.function.arguments;
      }
      return tc.function.name + ":" + canonicalize(args);
    })
    .sort();
  return createHash("sha256")
    .update(normalized.join("|"))
    .digest("hex")
    .slice(0, 16);
}

// Outcome-aware: hash the result too (from OpenFang)
function fingerprintOutcome(callHash: string, results: string[]): string {
  const resultHash = createHash("sha256")
    .update(results.join("|").slice(0, 2000)) // cap to avoid hashing huge results
    .digest("hex")
    .slice(0, 16);
  return callHash + ":" + resultHash;
}
```

**Layer 2 — Ping-pong cycle detector** (from PraisonAI)
Catches: Alternating A-B-A-B or A-B-C-A-B-C patterns where no consecutive pair is identical.

```typescript
function detectCycle(fingerprints: string[], maxPeriod = 3): number | null {
  if (fingerprints.length < 4) return null;
  for (let period = 2; period <= maxPeriod; period++) {
    if (fingerprints.length < period * 2) continue;
    const tail = fingerprints.slice(-period * 2);
    const first = tail.slice(0, period);
    const second = tail.slice(period);
    if (first.every((f, i) => f === second[i])) return period;
  }
  return null;
}
```

**Layer 3 — N-gram Jaccard similarity** (from hive)
Catches: Near-identical (not exact) text responses. Pairwise comparison, more expensive.

```typescript
function ngramSimilarity(a: string, b: string, n = 3): number {
  const ngrams = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i <= s.length - n; i++) set.add(s.slice(i, i + n));
    return set;
  };
  const setA = ngrams(a),
    setB = ngrams(b);
  const intersection = [...setA].filter((g) => setB.has(g)).length;
  return intersection / (setA.size + setB.size - intersection);
}

function isTextStalled(
  responses: string[],
  window = 4,
  threshold = 0.85,
): boolean {
  if (responses.length < window) return false;
  const recent = responses.slice(-window);
  for (let i = 0; i < recent.length; i++)
    for (let j = i + 1; j < recent.length; j++)
      if (ngramSimilarity(recent[i], recent[j]) < threshold) return false;
  return true;
}
```

**Exit criteria**: existing guard tests pass + new tests for reordered JSON keys, ping-pong A-B-A-B, content chanting, n-gram edge cases.

### S1.2 — Multi-level compaction pipeline

**Files**: `src/prometheus/context-compressor.ts` (refactor), new `src/prometheus/compaction-levels.ts`

Replace the single PRESERVE+ADD with a 4-level chain:

| Level | Strategy                                                                                                                                                                                 | Cost         | When invoked             |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------ |
| L0    | Prune tool results older than N rounds to first 200 chars                                                                                                                                | Zero         | Always first             |
| L1    | Paired message pruning (tool_call + tool_result as unit, CRIT 2.2). Pair-aware drain boundary (from OpenFang) — never split ToolUse/ToolResult. Drop oldest pairs, keep first 3 + last 4 | Zero         | If L0 output > target    |
| L2    | LLM recursive summary with binary splitting. If messages > compactor's context, split in half, summarize each, concatenate. Max 5 recursion levels                                       | 1+ LLM calls | If L1 output > target    |
| L3    | Emergency deterministic: extract {last user question, tool names called, final assistant text, STATUS line}. No LLM                                                                      | Zero         | If L2 fails or times out |

Add Prometheus counters: `compaction_level_total{level="L0|L1|L2|L3"}`.

**Exit criteria**: compaction tests at all 4 levels, counter increments verified, existing compress() tests still pass.

### S1.3 — Mechanical auto-persist

**Files**: `src/runners/fast-runner.ts` (or new `src/intelligence/auto-persist.ts`)

After each completed task (STATUS: DONE), mechanically evaluate:

- Response length > 2000 chars AND tool_calls > 3 → persist
- Playwright browsing was used → persist (always, browsing results are irreproducible)
- User explicitly asked a question containing "how", "why", "explain" + response > 1000 chars → persist

Persist via `memory_store` tool call (not LLM-driven — mechanical post-hoc).

**Exit criteria**: auto-persist fires on qualifying responses, doesn't fire on short acknowledgments.

### S1.4 — Graduated escalation ladder + quality gate

**Files**: `src/inference/adapter.ts` (guard break handling), new `src/inference/escalation.ts`, new `src/inference/quality-gate.ts`

Replace the current binary guard break → wrap-up with a 4-level escalation state machine (adapted from PraisonAI):

```typescript
const enum EscalationLevel {
  RETRY_DIFFERENT = 1, // inject nudge, suggest different approach
  ESCALATE_MODEL = 2, // switch to stronger model if available
  FORCE_WRAPUP = 3, // forced wrap-up with quality gate
  ABORT = 4, // deliver BLOCKED, no retry
}
```

**Escalation flow in adapter.ts**:

1. First guard trigger → Level 1: inject nudge ("Try a different approach"), continue loop.
2. Second guard trigger (same guard type) → Level 2: if a stronger model is available (e.g., current is Qwen, escalate to Claude), switch model and retry with remaining budget. If no stronger model available, skip to Level 3.
3. Third guard trigger → Level 3: forced wrap-up. After `buildWrapUpContext()` produces STATUS: DONE, run quality gate:
   - Fast LLM call (cheapest model): "The user asked: {question}. The agent responded: {summary}. Did the agent actually answer? YES/NO + reason."
   - If NO: inject nudge, grant 2 more rounds (one-time only).
   - If YES or gate fails: deliver as-is.
4. Quality gate exhausted or STATUS: BLOCKED → Level 4: deliver with BLOCKED status.

**Phantom action detection** (from OpenFang): After every non-empty assistant response (not just wrap-up), check for action verb + channel reference without matching tool call:

```typescript
function isPhantomAction(text: string, toolsCalled: string[]): boolean {
  const actionVerbs = [
    "sent ",
    "posted ",
    "emailed ",
    "delivered ",
    "published ",
  ];
  const channels = ["telegram", "whatsapp", "slack", "email", "gmail"];
  const hasAction = actionVerbs.some((v) => text.toLowerCase().includes(v));
  const hasChannel = channels.some((c) => text.toLowerCase().includes(c));
  if (!hasAction || !hasChannel) return false;
  const sendTools = [
    "telegram_send",
    "gmail_send",
    "wp_create_post",
    "wp_update_post",
  ];
  return !sendTools.some((t) => toolsCalled.includes(t));
}
```

If phantom detected: inject correction nudge (reuses existing narration-strip pattern).

Prometheus counters: `escalation_total{level="1|2|3|4"}`, `phantom_actions_total`.

**Exit criteria**: escalation state machine progresses correctly through levels in tests. Quality gate catches mock garbage. Phantom detection catches "I sent the email" without gmail_send. Model escalation uses the provider tier list from adapter config. **WRITE_TOOLS sync test**: assert every entry in WRITE_TOOLS exists as a registered tool name, and every write-capable tool from GOOGLE_TOOLS / COMMIT_WRITE_TOOLS / WORDPRESS_TOOLS is in WRITE_TOOLS (from v4.0.18 audit).

### S1.5 — Circuit breaker registry for tools

**Files**: new `src/tools/circuit-breaker.ts`, `src/tools/circuit-breaker.test.ts`

Standard CLOSED/OPEN/HALF_OPEN state machine, one breaker per external service, shared across all tasks:

```typescript
interface CircuitBreakerConfig {
  failureThreshold: number; // failures to trip (default: 5)
  failureWindow: number; // ms window for counting failures (default: 60_000)
  cooldown: number; // ms before half-open probe (default: 30_000)
}

interface CircuitBreaker {
  state: "CLOSED" | "OPEN" | "HALF_OPEN";
  failures: number;
  lastFailure: number;
  lastTrip: number;
}

class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();

  recordFailure(service: string): void; // increment, trip if threshold
  recordSuccess(service: string): void; // reset on HALF_OPEN success
  canCall(service: string): boolean; // false if OPEN (outside cooldown)
  getStatus(): Record<string, CircuitBreaker>; // for /health endpoint
}
```

**Integration points**:

- Tool sources call `registry.recordFailure(service)` on HTTP errors, timeouts
- Tool sources call `registry.recordSuccess(service)` on successful calls
- Before tool execution in adapter.ts: `if (!registry.canCall(service))` return structured error message
- `/health` endpoint includes circuit breaker status
- mc-ctl: `./mc-ctl breakers` shows current state of all breakers

**Service mapping** (auto-derived from tool source names):

- `google` → Gmail, GSheets, GDocs, GDrive, Calendar tools
- `wordpress` → all WP tools
- `openai` → inference calls to OpenAI-compatible endpoints
- `mcp` → per-MCP-server breakers
- `browser` → Playwright tools

Prometheus counters: `circuit_breaker_trips_total{service="..."}`, `circuit_breaker_state{service="..."}`.

**Exit criteria**: breaker trips on 5 failures, blocks calls when OPEN, half-opens after cooldown, resets on success. /health shows breaker status. Tests cover full state machine lifecycle.

### S1.6 — Session repair before inference

**Files**: `src/inference/adapter.ts`, new `src/inference/session-repair.ts`, `src/inference/session-repair.test.ts`

Adapted from OpenFang's `session_repair.rs`. Promote the existing `sanitizeToolPairs()` logic from compaction-only to a pre-inference pass that runs before every `inferWithTools` call:

```typescript
interface RepairStats {
  orphanedResults: number; // ToolResults removed (no matching ToolUse)
  syntheticErrors: number; // Error results inserted for unmatched ToolUse
  duplicatesRemoved: number; // Duplicate ToolResults deduped
  messagesMerged: number; // Consecutive same-role messages merged
}

function repairSession(messages: Message[]): {
  messages: Message[];
  stats: RepairStats;
} {
  // 1. Build ToolUse→ToolResult map by tool_use_id
  // 2. Remove orphaned ToolResults (no matching ToolUse in history)
  // 3. For unmatched ToolUse blocks, insert synthetic: { role: 'tool', content: 'Error: tool execution result was not received' }
  // 4. Deduplicate ToolResults with same tool_use_id (keep first)
  // 5. Merge consecutive same-role messages (concat with \n\n)
  // Return cleaned messages + stats
}
```

Prometheus counter: `session_repairs_total{type="orphan|synthetic|dedup|merge"}`.

**Integration**: Call `repairSession()` at the top of the `inferWithTools` loop in adapter.ts, before building the request. The stats inform but don't gate — repair is always applied.

**Exit criteria**: repair correctly handles all 4 edge cases in tests. Existing `sanitizeToolPairs()` can be deprecated (superset). Stats emitted to Prometheus.

### S1.7 — Three-window spending quotas

**Files**: new `src/intelligence/metering.ts`, `src/intelligence/metering.test.ts`

Adapted from OpenFang's `metering.rs`. Track aggregate token spending at three windows, with pre-call gating:

```typescript
interface SpendingQuota {
  hourly: number; // max tokens per hour (default: 500_000)
  daily: number; // max tokens per day (default: 5_000_000)
  monthly: number; // max tokens per month (default: 100_000_000)
}

interface MeterEntry {
  window: "hourly" | "daily" | "monthly";
  tokens: number;
  resetAt: number; // epoch ms
}

class SpendingMeter {
  record(tokens: number, runner: string): void; // add to all 3 windows
  canSpend(estimatedTokens: number): { allowed: boolean; blockedBy?: string };
  getUsage(): Record<string, MeterEntry>; // for /metrics endpoint
}
```

**Integration**:

- Before each LLM call in adapter.ts: `if (!meter.canSpend(estimatedTokens))` return structured error
- After each LLM call: `meter.record(usage.total_tokens, runnerType)`
- `/metrics` endpoint exposes current usage at all 3 windows
- mc-ctl: `./mc-ctl spending` shows current usage vs quotas

**Defaults** (tunable via env vars):

- `QUOTA_HOURLY=500000` — ~$0.50/hr at Qwen rates, enough for ~15 tasks
- `QUOTA_DAILY=5000000` — ~$5/day, reasonable for single-user
- `QUOTA_MONTHLY=100000000` — ~$100/month hard cap

**Note**: Quotas are advisory until we have production baseline data (S5 classifier calibration will provide token-per-task metrics). Initially set high to observe, then tighten based on actual patterns.

**Exit criteria**: meter blocks calls when any window is exhausted, resets correctly at window boundaries, /metrics shows usage. Tests cover window rotation and edge cases.
