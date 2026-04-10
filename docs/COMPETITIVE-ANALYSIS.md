# Competitive Analysis — OpenClaw vs Hermes vs Jarvis vs Devin

> Assessed 2026-04-10. Based on source code analysis (OpenClaw, Hermes), production codebase (Jarvis), and public documentation (Devin).

## Identity

|                 | **OpenClaw**                                 | **Hermes**                     | **Jarvis**                                              | **Devin**                    |
| --------------- | -------------------------------------------- | ------------------------------ | ------------------------------------------------------- | ---------------------------- |
| **What it is**  | Messaging-first personal AI assistant        | Agent orchestrator framework   | Strategic AI agent + orchestrator                       | Autonomous software engineer |
| **Primary use** | Multi-channel communication + task execution | Reliable multi-agent execution | Full-spectrum assistant (comms, coding, intel, finance) | Code generation + deployment |
| **Open source** | Yes (MIT)                                    | Yes                            | Private (kosm1x)                                        | No (Cognition, closed)       |
| **Language**    | TypeScript                                   | Python                         | TypeScript                                              | Proprietary                  |
| **Deployment**  | Local-first CLI + companion apps             | Self-hosted                    | VPS systemd service                                     | Cloud SaaS                   |

## Architecture

|                        | **OpenClaw**                         | **Hermes**                        | **Jarvis**                                                 | **Devin**                   |
| ---------------------- | ------------------------------------ | --------------------------------- | ---------------------------------------------------------- | --------------------------- |
| **Orchestration**      | Linear turn-based + ad-hoc subagents | Plan-Execute-Reflect              | 5 runners (fast/nanoclaw/heavy/swarm/a2a) + Prometheus PER | Hierarchical task planner   |
| **Planning**           | None (relies on model reasoning)     | Goal decomposition + reflection   | DAG goal graph, auto-replan, convergence detection         | Hierarchical task breakdown |
| **Multi-agent**        | Subagent trees (parent-child)        | Multi-agent with tool composition | Swarm fan-out, background agents, NanoClaw sandbox         | Single agent with sub-tasks |
| **Tool count**         | 60+ core + 97 plugin packages        | Scoped per context                | 172 (109 deferred, scope-gated)                            | ~20 built-in                |
| **Complexity routing** | None (one model handles all)         | Per-agent context                 | Classifier routes by complexity (fast → heavy → swarm)     | Single planner decides      |

## Execution & Safety

|                  | **OpenClaw**                     | **Hermes**                               | **Jarvis**                                                          | **Devin**                  |
| ---------------- | -------------------------------- | ---------------------------------------- | ------------------------------------------------------------------- | -------------------------- |
| **Sandbox**      | Optional Docker (exec + browser) | Sandboxed execution                      | NanoClaw Docker + immutable core (SG3)                              | Full cloud VM per session  |
| **Safety gates** | Approval prompts for bash        | Blocked destructive tools                | 21-tool confirmation gate, 3-tier risk, 5 safeguards                | Cloud isolation            |
| **Self-repair**  | None                             | Retry with failure classification        | Autonomous improvement loop (NanoClaw → branch → test → PR)         | Can fix its own code       |
| **Learning**     | None (skill files are manual)    | Reflection scoring + convergence penalty | Ebbinghaus decay, overnight tuning, autoresearch, lesson extraction | Learns within session only |

## Memory & Context

|                   | **OpenClaw**                      | **Hermes**            | **Jarvis**                                                             | **Devin**       |
| ----------------- | --------------------------------- | --------------------- | ---------------------------------------------------------------------- | --------------- |
| **Short-term**    | Session transcripts (append-only) | Conversation history  | Thread buffer (15 turns) + 9-section compaction                        | Session context |
| **Long-term**     | Optional plugin (LanceDB/wiki)    | Embedding persistence | pgvector KB (350+ entries) + Ebbinghaus 4-tier decay                   | None persistent |
| **Enrichment**    | Bootstrap files (static)          | Context injection     | Hybrid search (vector + FTS5) + query expansion + precedent resolution | RAG on codebase |
| **Consolidation** | None                              | Memory consolidation  | 4-phase nightly cycle (Orient → Gather → Consolidate → Prune)          | None            |
| **Cross-session** | Transcript files on disk          | Persistent embeddings | pgvector + thread hydration + KB reinforcement counting                | Session-scoped  |

## Communication

|                        | **OpenClaw**                                                              | **Hermes**     | **Jarvis**                                | **Devin**      |
| ---------------------- | ------------------------------------------------------------------------- | -------------- | ----------------------------------------- | -------------- |
| **Channels**           | 23+ (WhatsApp, Telegram, Slack, Discord, Signal, iMessage, Teams, IRC...) | None (API/CLI) | WhatsApp + Telegram + Email               | Slack + web UI |
| **Voice**              | First-class (wake words, TTS, Talk Mode)                                  | None           | TTS for video narration (edge-tts/Kokoro) | None           |
| **Device integration** | macOS/iOS/Android nodes (camera, screen, notifications)                   | None           | None                                      | Cloud browser  |

## Model Support

|                       | **OpenClaw**                                                     | **Hermes** | **Jarvis**                                                  | **Devin**              |
| --------------------- | ---------------------------------------------------------------- | ---------- | ----------------------------------------------------------- | ---------------------- |
| **Providers**         | 40+ (Anthropic, OpenAI, Google, Ollama, Qwen, DeepSeek, Groq...) | Multiple   | 3 (qwen3.5-plus primary, kimi-k2.5 wrap-up, glm-5 tertiary) | Claude (primary)       |
| **Vendor lock-in**    | Zero                                                             | Low        | Zero (raw fetch, OpenAI-compatible)                         | High (Cognition infra) |
| **Extended thinking** | Native (off → xhigh levels)                                      | N/A        | N/A (standard tool-calling)                                 | N/A                    |

## Where Each Wins

### OpenClaw

- Channel breadth (23+ platforms vs Jarvis's 2)
- Device integration (phone cameras, screen recording, system actions)
- Voice as first-class modality (wake words, Talk Mode)
- Provider diversity (40+ models, live switching mid-conversation)
- Plugin ecosystem (97 packages, extensible SDK)

### Hermes

- Structural reliability (convergence detection, drift baselines)
- Failure mode prevention (per-goal loop detection, ratio > 3.0 flagging)
- Clean academic architecture (PER with formal guards)
- Adopted into Jarvis: 3 patterns (H1 convergence, H2 drift, H3 schedule runs)

### Jarvis

- Memory system (Ebbinghaus decay, 4-phase consolidation, trust tiers, reinforcement counting — nobody else has this)
- Self-improvement (autonomous overnight tuning, NanoClaw coding sandbox, autoresearch loop)
- Operational maturity (1854 tests, 57 sessions, 172 tools, production-hardened)
- Financial capability (v7: Alpha Combination Engine IR = IC x sqrt(N), TimesFM forecasting, 5-signal layers)
- Tool sophistication (172 tools, dynamic scope gating, 7-layer hallucination defense, deferred schema loading)
- Complexity routing (classifier → 5 runner types based on task complexity)
- CRM integration (crm-azteca for media ad sales, client management)

### Devin

- Pure code generation quality (purpose-built, trained specifically for this)
- Full environment isolation (cloud VM per session, zero host risk)
- Enterprise adoption (funded, supported, SLA)
- End-to-end deployment (code → test → deploy in one session)

## The Real Comparison

These are **different species solving different problems**:

| System       | Analogy                                                                                 |
| ------------ | --------------------------------------------------------------------------------------- |
| **Devin**    | A senior developer you hire for a sprint. Excellent at code, nothing else               |
| **OpenClaw** | A personal assistant that lives in all your chat apps. Broad but shallow                |
| **Hermes**   | An engineering framework — blueprints, not a finished building                          |
| **Jarvis**   | A chief of staff that codes, researches, manages memory, trades, and improves overnight |

OpenClaw is the closest architectural relative — both are messaging-first agents with tool systems. But OpenClaw is **horizontally broad** (23 channels, 40 providers, voice, devices) while Jarvis is **vertically deep** (memory systems, self-improvement loops, financial analysis, CRM integration, hallucination defense).

Devin is purpose-built for one thing and does it better than anyone. Hermes is a research framework that contributed three valuable patterns but isn't a product.

**Jarvis is the only one building toward a learning financial analyst.** Nobody else is in that lane.

## Patterns Adopted from Each

### From Hermes → Jarvis (shipped)

| Pattern               | What                                     | Where                         |
| --------------------- | ---------------------------------------- | ----------------------------- |
| H1: Convergence Score | Per-goal loop detection (ratio > 3.0)    | `src/prometheus/reflector.ts` |
| H2: Drift Detection   | Rolling baseline comparison (± 1σ alert) | `src/prometheus/drift.ts`     |
| H3: Schedule Runs     | Audit trail for recurring tasks          | `src/rituals/dynamic.ts`      |

### From OpenClaw → Jarvis (bookmarked)

| Pattern                 | Value                                                           | Status                                                 |
| ----------------------- | --------------------------------------------------------------- | ------------------------------------------------------ |
| 23-channel breadth      | Jarvis has 2 (WhatsApp + Telegram) — sufficient for current use | Not needed                                             |
| Plugin SDK architecture | 97 packages, extensible                                         | Jarvis uses ToolSource interface — similar but simpler |
| Voice wake + Talk Mode  | First-class voice modality                                      | Pipesong covers this domain separately                 |
| Device node pairing     | Execute on phones/macs                                          | Not applicable to VPS deployment                       |
| Subagent trees          | Hierarchical parent-child spawning                              | Jarvis has background agents (v6.1) — similar          |

### From Devin → Jarvis (influenced)

| Pattern                         | What                           | Status                                                                    |
| ------------------------------- | ------------------------------ | ------------------------------------------------------------------------- |
| Full VM isolation               | Each task gets its own sandbox | Jarvis uses NanoClaw Docker containers — lighter but effective            |
| Autonomous code → test → deploy | End-to-end without human       | Jarvis's autonomous improvement loop does this (branch → fix → test → PR) |
| Hierarchical task breakdown     | Pre-plan before execution      | Prometheus PER with DAG goal graphs — same pattern                        |

## Key Differentiators Only Jarvis Has

1. **Ebbinghaus memory decay** — memories fade on a scientifically-modeled curve. No other system does this
2. **Autonomous self-improvement** — overnight tuning loop that proposes, tests, and ships code changes via PR
3. **Alpha Combination Engine** (v7) — institutional-grade signal weighting (IR = IC x sqrt(N)) for financial analysis
4. **7-layer hallucination defense** — write detection, inventory check, nudge, narration strip, retry, mechanical replace, name repair
5. **Multi-turn confirmation gate** — 21 high-risk tools require human approval; scheduled tasks bypass automatically
6. **Scope classifier** — LLM-based semantic routing with regex fallback, determines which of 172 tools the model can see per message
7. **CRM integration** — not just a coding agent or chat assistant; connected to real business operations (crm-azteca)
