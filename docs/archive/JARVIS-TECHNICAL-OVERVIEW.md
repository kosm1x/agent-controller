# Jarvis: A Personal AI Agent Orchestrator

**Technical Overview for Agent Framework Developers**

_March 2026 | v2.28 | 138 commits | 41K lines TypeScript_

---

## What is Jarvis?

Jarvis is a single-process AI agent orchestrator that classifies incoming tasks by complexity and routes them to the simplest runner capable of solving them. It exposes a unified HTTP API, but its primary interface is a Telegram bot that acts as a personal strategic assistant — scheduling meetings, managing projects, browsing the web, writing emails, publishing blog posts, generating media, and improving itself overnight.

It runs on a single VPS (8GB RAM, KVM2) with no cloud dependencies beyond LLM inference endpoints. The entire system — HTTP server, task dispatcher, tool registry, memory backend, scheduled rituals, and messaging layer — lives in one TypeScript process backed by SQLite.

**The core thesis**: most agent tasks don't need multi-step orchestration. A single LLM call with the right tools solves 90%+ of real-world requests. Jarvis enforces this through a complexity classifier that defaults to the lightest runner and only escalates when measurably necessary.

---

## Table of Contents

1. [Philosophy & Design Principles](#1-philosophy--design-principles)
2. [Architecture](#2-architecture)
3. [The Five Runners](#3-the-five-runners)
4. [Inference Layer](#4-inference-layer)
5. [Tool System](#5-tool-system)
6. [Memory & Knowledge](#6-memory--knowledge)
7. [Messaging & Persona](#7-messaging--persona)
8. [Rituals & Proactive Behavior](#8-rituals--proactive-behavior)
9. [Self-Improvement Loop](#9-self-improvement-loop)
10. [Reliability Engineering](#10-reliability-engineering)
11. [Current State & Known Gaps](#11-current-state--known-gaps)
12. [Comparison with Other Frameworks](#12-comparison-with-other-frameworks)
13. [Future Development](#13-future-development)
14. [Running Jarvis](#14-running-jarvis)

---

## 1. Philosophy & Design Principles

### Complexity Gradient

Borrowed directly from Anthropic's [Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) guide. The architecture maps to five workflow patterns:

| Pattern              | Jarvis Implementation                                                |
| -------------------- | -------------------------------------------------------------------- |
| Routing              | Classifier scores task complexity (0-10) → dispatcher selects runner |
| Prompt Chaining      | Fast runner: sequential tool calls in a loop                         |
| Orchestrator-Workers | Swarm runner: decompose into parallel subtasks                       |
| Evaluator-Optimizer  | Heavy runner (Prometheus): Plan → Execute → Reflect → Replan         |
| Parallelization      | Swarm DAG with dependency resolution                                 |

The key rule: **never use a heavier runner than necessary**. A web search + summary doesn't need Plan-Execute-Reflect. The classifier enforces this automatically.

### Agent-Computer Interface (ACI) Design

Tool definitions are treated as prompts, not schemas. They get more engineering time than handler code. Principles:

- **Descriptions for a literal reader**: include when to use, when NOT to use, boundaries with similar tools, edge cases
- **Parameter names are documentation**: `due_date` over `date`, `objective_id` over `parent_id`
- **Enums over free strings**: constrain the model's output space with `z.enum()`
- **Poka-yoke patterns**: design interfaces where mistakes are impossible (e.g., require absolute paths if the model confuses relative/absolute)

### Ground Truth at Every Step

Agent progress is validated through tool results, never through LLM self-assessment. The Prometheus reflector scores goals based on actual outcomes (API responses, file contents, DB state), not the model's opinion of itself.

### Vendor Agnosticism

Zero LLM vendor SDKs. The inference layer is raw `fetch()` calls to OpenAI-compatible endpoints. Switching providers means changing three environment variables, not rewriting code. Currently running Qwen 3.5 Plus (primary), GLM-5 (fallback), and DeepSeek V3.2 (tertiary) — all via DashScope's OpenAI-compatible API at a fraction of US provider costs.

### Minimal Dependencies

The entire runtime has 6 core + 2 optional messaging dependencies:

```
hono, @hono/node-server, better-sqlite3, @modelcontextprotocol/sdk,
node-cron, @opendataloader/pdf
+ grammy (Telegram), @whiskeysockets/baileys (WhatsApp)
```

No LangChain. No LlamaIndex. No vector database SDK. Complexity is earned, not inherited.

---

## 2. Architecture

```
                           ┌──────────────────┐
                           │   Telegram Bot    │
                           │   (Grammy)        │
                           └────────┬─────────┘
                                    │
                           ┌────────▼─────────┐
                           │  Message Router   │
                           │  (System Prompt   │
                           │   + Thread Mgmt)  │
                           └────────┬─────────┘
                                    │
┌───────────────┐          ┌────────▼─────────┐          ┌───────────────┐
│  HTTP API     │─────────▶│   Dispatcher     │◀────────▶│  Event Bus    │
│  (Hono:8080)  │          │   + Classifier   │          │  (SQLite)     │
└───────────────┘          └────────┬─────────┘          └───────┬───────┘
                                    │                            │
                    ┌───────────────┼───────────────┐    ┌───────▼───────┐
                    │               │               │    │  Reaction     │
              ┌─────▼──┐    ┌──────▼───┐    ┌──────▼┐   │  Engine       │
              │  Fast   │    │  Heavy   │    │ Swarm  │   └───────────────┘
              │ Runner  │    │(Promethe-│    │ Runner │
              │         │    │  us)     │    │        │
              └─────┬───┘    └────┬─────┘    └───┬────┘
                    │             │               │
              ┌─────▼─────────────▼───────────────▼────┐
              │           Tool Registry                 │
              │  ┌─────────┐ ┌───────┐ ┌────────────┐  │
              │  │ Builtin │ │Google │ │    MCP      │  │
              │  │(41 tools│ │(14)   │ │  (51+)      │  │
              │  └─────────┘ └───────┘ └────────────┘  │
              │  ┌─────────┐ ┌───────┐                  │
              │  │ Memory  │ │Skills │                  │
              │  │(3 tools)│ │(2)    │                  │
              │  └─────────┘ └───────┘                  │
              └────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
        ┌─────▼─────┐  ┌─────▼─────┐  ┌──────▼──────┐
        │  SQLite   │  │ Hindsight │  │   External  │
        │  (WAL)    │  │ (Semantic │  │   APIs      │
        │           │  │  Memory)  │  │             │
        └───────────┘  └───────────┘  └─────────────┘
```

### Data Flow

1. A message arrives via Telegram (or HTTP API)
2. The **Message Router** builds a dynamic system prompt, hydrates conversation history, injects user facts and memory recall, then submits a task
3. The **Classifier** scores complexity (0-10) based on keyword patterns, task history, and priority
4. The **Dispatcher** routes to the appropriate runner (fast/heavy/swarm/nanoclaw/a2a)
5. The runner executes with access to scoped tools from the **Tool Registry**
6. Results flow back through the Event Bus → Message Router → Telegram reply
7. The **Reaction Engine** listens for failures and decides: suppress, retry, adjust, or escalate

### Storage

Everything is SQLite (WAL mode, better-sqlite3). Tables:

| Table           | Purpose                                                                           |
| --------------- | --------------------------------------------------------------------------------- |
| `tasks`         | Full task lifecycle (pending → classifying → queued → running → completed/failed) |
| `runs`          | Individual execution records with token usage, duration, trace                    |
| `task_outcomes` | Adaptive classifier training data (classified_as, ran_on, tools_used, success)    |
| `conversations` | Memory bank (tiered trust, tagged, multi-bank)                                    |
| `user_facts`    | Structured personal data (category/key/value, never forgotten)                    |
| `skills`        | Reusable multi-step procedures (name, steps, tools, use_count)                    |
| `projects`      | First-class project entities with URLs, credentials, configs                      |
| `schedules`     | User-created recurring cron tasks                                                 |
| `learnings`     | Reflection outputs from Prometheus                                                |
| `agents`        | Registered agent directory (for A2A)                                              |

---

## 3. The Five Runners

### Fast Runner (90%+ of traffic)

In-process LLM + tool loop. No containers, no planning overhead.

- **Complexity score**: 0-2
- **Max rounds**: 20 (22 for coding tasks)
- **Token budget**: 28K (30K coding)
- **Timeout**: 5 minutes total
- **Pattern**: Send system prompt + tools → LLM responds with tool calls → execute → append results → repeat until LLM responds with text only
- **When it shines**: "What's the weather?", "Send this email", "Search for X and summarize", "Create a task"

### NanoClaw Runner (Isolated Execution)

Docker container with full filesystem + shell access. Uses a sentinel protocol — the container runs an LLM loop internally with access to bash, file operations, and network.

- **Complexity score**: 3-5
- **Timeout**: 2 minutes per container
- **Concurrency**: limited by `MAX_CONCURRENT_CONTAINERS`
- **When it shines**: Code generation, scraping, persistent file manipulation, anything requiring isolation

### Heavy Runner — Prometheus (Plan-Execute-Reflect)

Multi-step reasoning with a formal planning phase, parallel goal execution, and reflective evaluation.

- **Complexity score**: 6-8
- **Max iterations**: 90
- **Timeout**: 15 minutes
- **Loop**: Planner → Executor (parallel goals) → Reflector → Orchestrator (replan or finish)
- **When it shines**: "Analyze this codebase and write a report", "Review all 68 blog posts and audit them into a spreadsheet", weekly strategic reviews

The Reflector scores each goal based on actual tool results, not LLM narrative. If a goal fails, the Orchestrator replans with the failure context injected.

### Swarm Runner (Parallel Fan-Out)

Decomposes large tasks into a DAG of subtasks, executes them in parallel (each subtask routes through the classifier independently), and synthesizes results.

- **Complexity score**: 9+
- **Timeout**: 15 minutes per swarm
- **When it shines**: "Audit all modules in the project", "Review all open PRs", multi-component analysis

Subtasks get sibling context — they know what parallel work is happening and can see completed sibling outputs (truncated).

### A2A Runner (Agent-to-Agent)

Delegates to external agents via the A2A (Agent-to-Agent) JSON-RPC protocol. Multi-turn conversations stored in `a2a_contexts` table.

- **When it shines**: Collaborative problem-solving with specialized external agents

---

## 4. Inference Layer

### Provider Chain

Three-provider failover with no SDK dependencies:

```
Primary (qwen3.5-plus) → Fallback (glm-5) → Tertiary (deepseek-v3.2)
```

All use DashScope's OpenAI-compatible API. Switching to OpenAI, Anthropic, or any OpenAI-compatible endpoint requires changing 3 env vars.

### Provider Health Tracking

`ProviderMetrics` maintains a rolling window (50 calls, 10-minute TTL) per provider:

- Tracks average latency, P95, success rate
- `isDegraded()` triggers preemptive skip (avg >15s or success <50%, minimum 10 samples)
- **Time-windowed recovery**: degraded providers auto-recover as old entries expire — prevents permanent death spirals
- All stats exposed via `GET /health` endpoint

### Token Budget Enforcement

Each runner type has a token ceiling:

| Runner | Token Budget | Max Rounds |
| ------ | ------------ | ---------- |
| Fast   | 28,000       | 20         |
| Coding | 30,000       | 22         |
| Heavy  | 80,000       | 90         |

When budget is exceeded, the system forces a wrap-up: it builds a lean context (system prompt + first user message + last 6 messages with truncated tool results) and makes one final toolless LLM call to produce a coherent response.

### Compression

When conversation context approaches the model's limit (configurable, default 128K), a compression pass summarizes older messages while preserving recent context. Trigger threshold: 85% of context window.

---

## 5. Tool System

### Architecture

A plugin-based `ToolSourceManager` with 5 source adapters, each implementing the `ToolSource` interface (initialize, registerTools, healthCheck, teardown):

```
ToolSourceManager
  ├── BuiltinToolSource  (41 tools)
  ├── GoogleToolSource   (14 tools, conditional on OAuth)
  ├── McpToolSource      (51+ tools, dynamic from mcp-servers.json)
  ├── MemoryToolSource   (3 tools, conditional on Hindsight)
  └── SkillsToolSource   (2 tools)
```

Initialization is fault-tolerant: one source failing (e.g., Google OAuth expired) doesn't block others. Total: **111 tools** registered in production.

### Tool Categories

**File & Code Operations** (8 tools)
`file_read`, `file_write`, `file_edit` (string-replacement with unique match enforcement), `grep` (content search), `glob` (file discovery), `list_dir`, `shell_exec` (sandboxed: 23 blocked destructive commands, write path restrictions), `http_fetch`

**Web & Research** (5 tools)
`web_search` (Brave API), `web_read` (Jina Reader → Markdown), `exa_search` (semantic search), `rss_read`, `pdf_read` (inline for short PDFs, file-based for long ones, keyword search)

**Google Workspace** (14 tools)
`gmail_send/search`, `gdrive_list/create/share`, `calendar_list/create/update`, `gsheets_read/write`, `gdocs_read/write`, `gslides_create`, `gtasks_create`. All via raw fetch with OAuth2 token refresh — no Google SDK.

**Media Generation** (3 tools)
`gemini_image` (text-to-image via Imagen), `hf_generate` (HuggingFace: image/speech/video/music via Spaces + Inference API), `hf_spaces` (discover running Spaces)

**Personal Data** (6 tools)
`user_fact_set/list/delete` (structured facts, always injected into prompt), `project_list/get/update` (first-class project entities with credentials)

**Memory** (3 tools, conditional)
`memory_search/store/reflect` via Hindsight semantic memory or SQLite keyword fallback

**Content Management** (10 tools, conditional)
WordPress: `wp_list_posts`, `wp_read_post`, `wp_publish`, `wp_media_upload`, `wp_pages`, `wp_categories`, `wp_plugins`, `wp_settings`, `wp_delete`, `wp_raw_api`

**Productivity** (22+ tools via MCP)
Full CRUD on a personal goal hierarchy (visions → goals → objectives → tasks → journal) via MCP bridge. Scheduling: `schedule_task`, `list_schedules`, `delete_schedule`.

**Browser Automation** (10 tools via MCP)
LightPanda headless browser (Zig-based, ~24MB RAM): `goto`, `markdown`, `links`, `evaluate`, `click`, `fill`, `scroll`, `semantic_tree`, `interactiveElements`, `structuredData`

**Self-Improvement** (2 internal tools)
`evolution_get_data` (aggregate tool effectiveness, runner performance), `evolution_deactivate_skill` (remove underperforming skills)

### Dynamic Tool Scoping

Sending 111 tool definitions to the LLM would consume ~15K tokens per call — 50%+ of the prompt budget on a 30K-ceiling model. Instead, Jarvis uses keyword-based activation:

- **Core** (always on, 13 tools): user facts, web search, skills, browser basics, memory
- **COMMIT write** (11 tools): activated by "tarea", "meta", "crea", "actualiz" etc.
- **Google** (14 tools): activated by "email", "calendar", "drive" etc.
- **Browser interactive** (8 tools): activated by "naveg", "sitio", "click" etc.
- **Coding** (7 tools): activated by "code", "deploy", "grep" etc.
- **Schedule** (2 tools): activated by "schedule", "report" etc.

Scope is determined by scanning the current user message + last 2 user messages in the thread. Result: prompt reduced from 28K to ~14K tokens for simple messages (50% reduction).

This system is tunable — the self-improvement loop (Section 9) can propose mutations to scope patterns and evaluate them automatically.

### Safety Guardrails

- **Sandboxed shell**: 23 blocked commands (rm -rf, mkfs, etc.), write path restrictions (/root/claude/, /tmp/, /workspace/ only)
- **Confirmation gates**: Destructive tools flagged with `requiresConfirmation` (gmail_send, gdrive_share, delete_item)
- **Read-before-write**: WordPress enforces `wp_read_post` before `wp_publish` (server-side content length guard prevents publishing empty/truncated content)
- **Deduplication**: Google Sheets `gsheets_write` auto-dedup by column A in append mode
- **Rate limiting**: memory store limited to 5 per task

---

## 6. Memory & Knowledge

### Dual-Backend Architecture

```
┌─────────────────────┐     ┌─────────────────────┐
│   SQLite Backend    │     │  Hindsight Backend   │
│   (always on)       │     │  (optional)          │
│                     │     │                      │
│  - Keyword search   │     │  - Semantic search   │
│  - Source of truth  │     │  - Embeddings        │
│  - Circuit breaker  │     │  - Reflection        │
│    fallback         │     │  - PostgreSQL        │
└─────────────────────┘     └──────────────────────┘
```

All writes go to SQLite first (dual-write pattern). Hindsight gets an async fire-and-forget copy. If Hindsight goes down (circuit breaker: 3 failures → 60s cooldown), everything falls back to SQLite seamlessly.

### Memory Banks

Three separate knowledge domains, each with independent context:

| Bank             | Purpose                          | Example Content                                |
| ---------------- | -------------------------------- | ---------------------------------------------- |
| `mc-operational` | Task execution learnings         | "gsheets_write needs 2D array, not flat"       |
| `mc-jarvis`      | User conversations & preferences | "User prefers morning briefings at 7 AM"       |
| `mc-system`      | Infrastructure events & rituals  | "Overnight tuning improved scope accuracy 12%" |

### Trust Tiers

Memories have confidence levels that affect retention and retrieval priority:

| Tier | Name        | Source                       | Retention |
| ---- | ----------- | ---------------------------- | --------- |
| 1    | Verified    | User explicitly confirmed    | Longest   |
| 2    | Inferred    | Reflector or ritual analysis | Long      |
| 3    | Provisional | LLM during task execution    | Medium    |
| 4    | Unverified  | Direct tool result           | Shortest  |

### User Facts

Separate from memory banks, `user_facts` is a structured key-value store (category/key/value) that is **always injected into every Jarvis prompt**. This handles the "Jarvis forgot my birthday" problem — facts like timezone, name, role, and preferences are never lost to context window limits.

### Known Gap: Memory at Scale

The SQLite keyword search is basic (LIKE queries, no FTS). Hindsight provides semantic search but adds latency (~2-3s per query) and has proven fragile in production (socket drops, empty results with certain model backends). The memory system works well for ~500 entries but hasn't been tested at 10K+. This is an area where we'd welcome input on approaches that balance retrieval quality with latency constraints.

---

## 7. Messaging & Persona

### Telegram Integration

Jarvis's primary interface is a Telegram bot (@PiotrTheBot) using Grammy in long-polling mode. Features:

- **Text messages**: Routed through the full pipeline (classify → dispatch → respond)
- **Photos**: Downloaded as base64 → multimodal content array → vision-capable model (Qwen 3.5 Plus handles this natively)
- **Voice/Audio**: Transcribed via Whisper API → processed as text
- **Documents**: PDFs extracted inline, HTML converted via Jina Reader, images routed to vision
- **Image persistence**: Images survive across conversation turns within a session (thread buffer stores `ThreadEntry[]` with optional `imageUrl`)

### Dynamic Prompt Assembly

The system prompt is not static. It's rebuilt per-message based on:

1. **Core identity** (bilingual, action-oriented persona)
2. **Current date/time** (Mexico City timezone)
3. **Available tools** (only tools in the current scope get described — prevents hallucinated tool calls)
4. **User facts** (injected from the `user_facts` table)
5. **Memory recall** (top relevant memories from Hindsight/SQLite)
6. **Conversation history** (last 8 turns, 800 char cap per turn)
7. **Tool-first reminders** (pattern-matched against user input: if the user asks "what tasks do I have?", inject a mandatory reminder to call the task list tool)
8. **Conditional protocol sections** (WordPress, Google, COMMIT, coding — only included when those tool groups are active)

### Thread Management

- Thread buffer: 8 turns maximum
- Response cap: 800 chars per stored turn
- Poison filter: detects learned helplessness patterns ("no puedo continuar", configuration errors) and flushes them
- Scope accumulation fix: only scans current + last 2 user messages (prevents old keywords from permanently activating 60+ tools)

---

## 8. Rituals & Proactive Behavior

### Scheduled Rituals

Pre-configured tasks that run on cron schedules (node-cron, Mexico City timezone):

| Ritual              | Schedule            | Runner | What It Does                                             |
| ------------------- | ------------------- | ------ | -------------------------------------------------------- |
| Signal Intelligence | 6:00 AM daily       | Fast   | Pre-digest trending topics                               |
| Morning Briefing    | 7:00 AM daily       | Fast   | Calendar, priority tasks, news digest → email + Telegram |
| Nightly Close       | 10:00 PM daily      | Fast   | Day review, wins/failures, learnings → email + Telegram  |
| Skill Evolution     | 11:00 PM daily      | Fast   | Analyze task outcomes, propose/deactivate skills         |
| Evolution Log       | 11:59 PM daily      | Fast   | Append daily metrics + accomplishments to log            |
| Weekly Review       | Sunday 8:00 PM      | Heavy  | Full strategic review: goals, projects, week analysis    |
| Overnight Tuning    | 1:00 AM Tue/Thu/Sat | Custom | Self-improvement loop (see Section 9)                    |

All rituals are idempotent (check if already ran today before executing). Results broadcast to Telegram.

### Proactive Scanner

Runs 4x/day (8AM, noon, 4PM, 8PM), throttled to max 2 nudges/day:

- Detects stale goals (no progress in 14 days)
- Deadline alerts
- Streak protection (evening nudge at 6PM if daily habit at risk)
- Objective completion detection (all child tasks done → suggest marking complete)

### Dynamic Scheduling

Users can create custom schedules via natural language:

> "Send me a daily AI news report at 8am to my email"

This becomes a `schedule_task` tool call with cron expression, tool list, and delivery method — stored in SQLite, polled every minute.

---

## 9. Self-Improvement Loop

### Overnight Tuning System

Inspired by the [autoresearch](https://github.com/autoresearch/autoresearch) pattern. Runs on configurable nights (default: Tue/Thu/Sat at 1 AM).

**The loop:**

```
1. Baseline evaluation (49 seed test cases)
   └── Composite score: tool selection (50%) + scope accuracy (30%) + classification (20%)
2. Meta-agent proposes ONE mutation
   └── Reads worst-performing cases + experiment history
   └── Outputs: what to change, why, expected improvement
3. Sandbox evaluation
   └── In-memory config overrides (no production impact)
   └── Targeted re-evaluation on affected test cases
4. Keep or discard
   └── Score improved? → Keep variant for human review
   └── No improvement? → Discard, try next
5. Repeat (max 25 experiments, $25 cost cap, stall detection)
```

**What it tunes:**

- Tool descriptions (ACI quality)
- Scope patterns (keyword activation accuracy)
- Classification scoring weights

**Safety:**

- Sandbox isolation: mutations never touch production config during evaluation
- Cost cap: $25/run max
- Human review gate: `mc-ctl tuning promote` required to apply changes to production
- Stall detection: stops early if 3+ consecutive experiments show no improvement

### Skill Evolution

Separate from overnight tuning, the nightly **Skill Evolution** ritual:

1. Analyzes completed tasks from the day
2. Identifies reusable patterns (3+ similar tool sequences)
3. Proposes new skills or deactivates underperforming ones
4. Skills are stored in SQLite and injected into relevant prompts

---

## 10. Reliability Engineering

### 7-Layer Hallucination Defense

LLMs don't always do what you tell them. They narrate tool calls without executing them, claim to have read files they didn't, and confuse tool names. Jarvis has accumulated 7 defense layers through production incidents:

| Layer | Defense                      | What It Catches                                                               |
| ----- | ---------------------------- | ----------------------------------------------------------------------------- |
| 1a    | Generic WRITE_TOOLS detector | "I sent the email" (but didn't call gmail_send)                               |
| 1b    | Read hallucination detector  | "I reviewed the file" (but didn't call file_read)                             |
| 2     | Wrap-up tool inventory       | Injects "these tools were actually called: [...]" before final response       |
| 3     | First-round nudge            | Discards planning text on round 1, forces tool execution                      |
| 4     | Hallucination retry          | If detected and >15% token budget remaining → retry with conversation context |
| 5     | Mechanical replacement       | If <15% budget → regex-replace claims with "[action not completed]"           |
| 6     | Tool name repair             | Fuzzy-match misspelled tool names → closest registered tool                   |
| 7     | Tool alias table             | 12 hardcoded common misnaming patterns (e.g., gsheets_update → gsheets_write) |

### Loop Guards

- **Analysis paralysis**: 5+ consecutive read-only rounds → force wrap-up (catches endless exploration)
- **Persistent failure**: 4+ consecutive all-error rounds → inject advisory message
- **Stale loop**: 5+ consecutive small-result rounds → break (catches 404-loop pattern)
- **Repeat detector**: Detects identical tool calls across rounds

### Reaction Engine

Event-driven failure handling:

1. **Suppression**: 3+ same-classification failures in 24h → stop retrying
2. **Transient retry**: timeout/ECONNRESET/429/503 → identical resubmit (max 2)
3. **Adjusted retry**: first non-transient failure → resubmit with error context prepended
4. **Escalate**: retries exhausted → Telegram notification
5. **Stuck detection**: polls every 60s for tasks running >15min with no progress

### Content Protection

- WordPress publish guard: compares file length against original before publishing (catches silent file_edit failures)
- Google Sheets dedup: column-A dedup in append mode prevents duplicate rows
- Gmail mechanical correction: auto-fixes owner email address variants
- Narration stripping: `content: null` on tool-call messages saves 1-2K tokens/round

---

## 11. Current State & Known Gaps

### By the Numbers (March 29, 2026)

| Metric                        | Value                            |
| ----------------------------- | -------------------------------- |
| Source files                  | 159                              |
| Test files                    | 61                               |
| Tests passing                 | 623/623                          |
| Lines of TypeScript           | ~41,000                          |
| Git commits                   | 138                              |
| Development period            | 17 days (March 12-29, 2026)      |
| Tools registered              | 111                              |
| Tasks processed (last 4 days) | 463 (372 completed, 80% success) |
| Daily budget                  | $30                              |
| Runtime memory                | <200MB typical                   |

### Known Gaps & Open Problems

**Memory retrieval quality**: SQLite keyword search is crude (LIKE queries). Hindsight adds semantic search but has proven fragile (socket drops, circuit breaker trips). Neither approach handles temporal queries well ("what did I say about X last Tuesday?"). FTS5 or a lightweight embedding approach could improve this significantly without adding infrastructure.

**Single-process, single-VPS**: No horizontal scaling, no redundancy. Process crash = total outage until manual restart (no systemd unit, manual tsx process). Fine for a personal assistant, blocking for multi-user.

**Provider ceiling**: Running on DashScope (Chinese LLM providers) keeps costs very low ($30/day for 400+ tasks) but introduces constraints — 30K token context ceiling at 60s timeout, no streaming, vision only on primary model. The system is designed around these constraints (dynamic scoping, token budgets, lean wrap-up) but would behave differently with higher-ceiling providers.

**Thread truncation corrupts state**: When conversation threads are truncated for token budget, tool result messages can become orphaned from their tool_call messages. DeepSeek V3 rejects these with HTTP 400. The wrap-up path handles this, but some information is lost.

**Confirmation gates are advisory**: `requiresConfirmation` is logged but not enforced in the fast-runner loop — there's no blocking mechanism to pause execution and wait for user approval. The system relies on the LLM obeying the system prompt instruction to ask before executing destructive tools.

**Skill discovery is nascent**: The system can save and list skills, and nightly evolution proposes new ones, but skill _injection_ into prompts is limited. Skills aren't yet automatically triggered by matching user requests.

**No streaming**: Responses are returned as complete text blocks. For long-running tasks, the user sees nothing until completion. A streaming path would significantly improve UX.

**Overnight tuning needs more seed data**: 49 test cases cover the basics but miss edge cases in bilingual scoping, multi-step workflows, and provider-specific quirks.

---

## 12. Comparison with Other Frameworks

This is not a competitive comparison — it's a positioning map for developers evaluating approaches.

| Dimension              | Jarvis                              | LangGraph                 | CrewAI                   | OpenAI Agents SDK       | Claude Agent SDK       |
| ---------------------- | ----------------------------------- | ------------------------- | ------------------------ | ----------------------- | ---------------------- |
| **Philosophy**         | Personal agent, complexity gradient | Graph-based workflows     | Role-playing multi-agent | Minimal, tool-focused   | Orchestration patterns |
| **Language**           | TypeScript                          | Python                    | Python                   | Python                  | Python                 |
| **LLM coupling**       | None (raw fetch)                    | LangChain ecosystem       | LiteLLM/various          | OpenAI only             | Anthropic only         |
| **Persistence**        | SQLite (builtin)                    | Checkpointers (pluggable) | None (stateless)         | None                    | None                   |
| **Memory**             | Dual-backend (SQLite + Hindsight)   | External (user provides)  | External                 | External                | External               |
| **Tool system**        | 5-source plugin + MCP               | LangChain tools           | CrewAI tools             | OpenAI function calling | Claude tool_use        |
| **Multi-agent**        | 5 runner types + A2A                | Graph nodes               | Crews & agents           | Handoffs                | Orchestrator pattern   |
| **Self-improvement**   | Overnight tuning loop               | None                      | None                     | None                    | None                   |
| **Proactive behavior** | Rituals + scanner + nudges          | None                      | None                     | None                    | None                   |
| **Production use**     | Single-user, 17 days                | Enterprise                | Enterprise               | Various                 | Various                |
| **Maturity**           | Alpha (personal project)            | Mature                    | Mature                   | New (2025)              | New (2025)             |

### What Jarvis does differently

1. **Complexity gradient as first-class concept**: Most frameworks give you one execution model and you build routing yourself. Jarvis has 5 runner types with an adaptive classifier that learns from outcomes.

2. **Self-improvement loop**: No other framework ships with a built-in overnight tuning system that evaluates tool descriptions, scope patterns, and classification accuracy against test cases.

3. **Dynamic tool scoping**: Rather than sending all tools every time (token waste) or requiring manual tool selection (developer burden), Jarvis activates tools based on conversation keywords.

4. **Full personal assistant infrastructure**: Rituals, proactive scanning, scheduled tasks, memory with trust tiers — these aren't library features, they're opinionated choices for a production personal agent.

### What others do better

1. **Ecosystem & community**: LangGraph and CrewAI have massive ecosystems, documentation, and community support. Jarvis is a solo project.

2. **Streaming & real-time**: OpenAI's SDK has native streaming. Jarvis returns complete responses.

3. **Multi-user / multi-tenant**: All major frameworks are designed for multi-user applications. Jarvis is single-user by design.

4. **Observability**: LangSmith (LangGraph), OpenAI's dashboard — Jarvis has basic logging and an admin CLI but no visual dashboard.

5. **Testing infrastructure**: LangGraph has built-in evaluation tools. Jarvis's overnight tuning is custom-built and has limited test coverage for the tuning system itself.

---

## 13. Future Development

### Near-Term (Active Planning)

**Streaming responses**: Add SSE streaming from the inference layer through the message router. The HTTP API already has an SSE endpoint for task progress — extending it to inference output is the natural next step.

**Systemd integration**: Replace the manual tsx process with a proper systemd unit for automatic restart, log management, and boot persistence.

**FTS5 for memory**: Replace LIKE-based keyword search with SQLite FTS5 for dramatically better recall without adding infrastructure.

**Open-source preparation**: License, sanitized env examples, Docker-first deployment guide. Currently on the roadmap (tracked as a task, due April 8).

### Medium-Term (Under Consideration)

**Multi-model routing per runner**: Use cheaper models (Qwen) for fast tasks and stronger models (Claude/GPT-4o) for heavy/swarm tasks, selected at classification time.

**Eval-driven development**: Expand the 49 seed test cases to 200+ covering bilingual edge cases, multi-step workflows, and provider-specific behaviors. Run evals on every commit.

**Streaming tool execution**: For long-running tools (web scraping, code analysis), stream partial results to the user rather than blocking.

**Conversation branching**: Allow the user to fork conversations ("go back to when we were discussing X") without losing current thread context.

### Long-Term (Vision)

**Multi-user architecture**: Tenant isolation, per-user memory banks, shared tool registry. This requires fundamental changes to the single-process design.

**Federated agent network**: Multiple Jarvis instances communicating via A2A protocol, each specialized (one for coding, one for research, one for communications). The A2A runner already exists — the infrastructure problem is agent discovery and trust.

**Continuous learning from production**: Currently, the overnight tuning loop uses curated test cases. A production-feedback loop that automatically generates test cases from real task outcomes (especially failures) would close the improvement cycle.

---

## 14. Running Jarvis

### Prerequisites

- Node.js 22+
- SQLite3
- Docker (optional, for NanoClaw runner)
- At least one OpenAI-compatible LLM endpoint

### Quick Start

```bash
git clone https://github.com/kosm1x/agent-controller.git
cd agent-controller
npm install
cp env.example .env
# Edit .env with your LLM provider credentials

# Initialize database
npm run build

# Development
npm run dev          # tsx watch with hot reload

# Production
npm run build && node dist/index.js

# With Docker
docker compose up -d                           # Core only
docker compose --profile litellm up -d         # + LiteLLM model routing
docker compose --profile hindsight up -d       # + Semantic memory
```

### Admin CLI

```bash
./mc-ctl status              # Health check
./mc-ctl stats               # Full metrics dashboard
./mc-ctl tasks --status=running   # List running tasks
./mc-ctl task <id>           # Task detail + runs
./mc-ctl db "SELECT ..."    # Raw SQLite access
./mc-ctl tuning status       # Overnight tuning results
./mc-ctl tuning promote      # Apply tuning improvements
```

### Environment Variables (Key Ones)

```bash
# Required
MC_API_KEY=your-api-key
INFERENCE_PRIMARY_URL=https://your-llm-endpoint/v1
INFERENCE_PRIMARY_KEY=sk-xxx
INFERENCE_PRIMARY_MODEL=model-name

# Optional fallback providers
INFERENCE_FALLBACK_URL=...
INFERENCE_TERTIARY_URL=...

# Telegram (optional)
TELEGRAM_BOT_TOKEN=...
TELEGRAM_OWNER_CHAT_ID=...

# Features (all default to false)
RITUALS_ENABLED=true
HINDSIGHT_ENABLED=true
TUNING_ENABLED=true
BUDGET_ENABLED=true
BUDGET_DAILY_LIMIT_USD=30
```

---

## Contributing & Feedback

This is a personal project shared for discussion with fellow agent developers. The codebase is opinionated and built for a specific use case (single-user personal assistant), but the patterns — complexity-gradient routing, dynamic tool scoping, overnight self-improvement, hallucination defense layers — may be useful in other contexts.

Areas where input would be particularly valuable:

- **Memory architecture**: Better approaches to hybrid keyword/semantic search with trust-tiered retention
- **Hallucination defense**: Novel detection patterns beyond the 7 layers described above
- **Tool scoping**: More principled approaches than keyword matching (embedding-based? classifier-based?)
- **Eval methodology**: How to build comprehensive test suites for bilingual, multi-tool agent systems
- **Provider abstraction**: Patterns for handling provider-specific quirks (thinking tokens, vision routing, context limits) without polluting the inference layer

All 623 tests pass. The system processes 400+ tasks/day on $30 budget. It's alpha-quality software that works surprisingly well for its primary user.

---

_Built with TypeScript, SQLite, stubbornness, and too much coffee._
_138 commits in 17 days. All human-AI pair programming._
