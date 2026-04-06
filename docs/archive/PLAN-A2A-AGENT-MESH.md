# A2A Agent Mesh — Jarvis ↔ CRM Integration

**Status**: PLANNED (not built)
**Estimated effort**: ~3.5 hours
**Cost per query**: ~$0.004 (one DashScope call)
**Prerequisites**: CRM dashboard server running (port 3000), Jarvis running (port 8080)

## Context

Jarvis (agent-controller) has a complete, production-ready A2A implementation — server, client, runner, types, mapper, agent card, tests — but zero external agents connected. CRM has 71 tools and a dashboard server on port 3000 but no task submission endpoint. This plan connects them: Jarvis delegates CRM questions to the CRM agent via A2A, and the CRM agent uses its own LLM + tools to answer.

## Architecture

```
User (Telegram)
  │
  ▼
Jarvis (mission-control:8080)
  │ scope detects "pipeline", "cuota", "propuesta", "CRM"
  │ activates crm_query tool
  │
  ▼
crm_query tool sends A2A JSON-RPC to CRM
  │ POST http://localhost:3000/a2a
  │ {"jsonrpc":"2.0","method":"sendMessage","params":{"message":...}}
  │
  ▼
CRM A2A endpoint (crm-azteca:3000/a2a)
  │ builds system prompt + 51-63 tools (role-based)
  │ runs inferWithTools (GLM-5 primary → qwen3.5-plus fallback)
  │ CRM LLM calls consultar_pipeline, consultar_cuota, etc.
  │
  ▼
A2A response flows back to Jarvis
  │ artifacts: [{parts: [{type: "text", text: "Pipeline: ..."}]}]
  │
  ▼
Jarvis formats and sends to Telegram
```

## Implementation Steps

### Step 1: CRM A2A Endpoint (~1.5hr)

**File**: `crm/src/dashboard/a2a.ts` (new)

Add a JSON-RPC 2.0 handler that:

1. Parses incoming `sendMessage` request
2. Extracts text from `message.parts[0].text`
3. Picks a persona for execution (configurable, default: `per-002` Ana Martínez, Director — sees most data)
4. Builds system prompt via the same path as agent-runner (global.md + role.md + org tree + date/time)
5. Gets tools via `getToolsForRole(persona.rol)`
6. Applies `filterToolsByIntent(message, tools)` for efficiency
7. Builds `ToolContext` via `buildToolContext(persona.id)`
8. Calls `inferWithTools(messages, tools, executor, maxRounds)` — same inference adapter the agent-runner uses
9. Returns result as A2A task with artifact

**Key functions to import** (all existing, no new code):

- `buildToolContext`, `getToolsForRole`, `executeTool` from `crm/src/tools/index.ts`
- `filterToolsByIntent` from `crm/src/tools/intent-filter.ts`
- `inferWithTools` from `crm/src/inference-adapter.ts`
- `getUserProfile`, `formatProfileSection` from `crm/src/tools/perfil.ts`
- `getPersonById`, `getDirectReports` from `crm/src/hierarchy.ts`

**System prompt assembly**: Reuse `scripts/simulator/prompt-builder.ts` pattern (already built for the simulator — reads from host-side `crm/groups/*.md` paths).

**Agent card**: Serve at `/.well-known/agent.json`:

```json
{
  "name": "CRM Azteca",
  "description": "Agentic CRM for media ad sales. 71 tools: pipeline, quotas, proposals, briefings, packages, insights, approvals, relationships.",
  "url": "http://localhost:3000",
  "version": "1.0.0",
  "capabilities": {
    "streaming": false,
    "pushNotifications": false,
    "stateTransitionHistory": false
  },
  "skills": [
    {
      "id": "pipeline",
      "name": "Pipeline Management",
      "tags": ["pipeline", "propuestas", "deals"]
    },
    {
      "id": "quotas",
      "name": "Quota Tracking",
      "tags": ["cuota", "meta", "logro"]
    },
    {
      "id": "briefings",
      "name": "Sales Briefings",
      "tags": ["briefing", "resumen", "equipo"]
    },
    {
      "id": "insights",
      "name": "Commercial Insights",
      "tags": ["insights", "overnight", "oportunidad"]
    },
    {
      "id": "packages",
      "name": "Media Packages",
      "tags": ["paquete", "medios", "inventario"]
    }
  ],
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain"]
}
```

**Mount in dashboard server**: Add routes to `crm/src/dashboard/server.ts`:

- `GET /.well-known/agent.json` → serve agent card (no auth)
- `POST /a2a` → JSON-RPC handler (API key auth via `X-Api-Key` header, checked against `CRM_A2A_KEY` env var)

**Authentication**: Simple API key (not JWT). The A2A endpoint is machine-to-machine, not user-facing. Store key in `.env` as `CRM_A2A_KEY`.

### Step 2: Jarvis `crm_query` Tool (~1hr)

**File**: `src/tools/builtin/crm-query.ts` (new, in mission-control)

A builtin tool that delegates to the CRM via A2A:

```typescript
const TOOL_CRM_QUERY: ToolDefinition = {
  type: "function",
  function: {
    name: "crm_query",
    description: `Query the CRM system (Pulso/Azteca) for sales data. Use this when the user asks about:
- Pipeline status, proposals, deals
- Quota attainment, weekly targets
- Client accounts, contacts
- Sales activities, briefings
- Media packages, inventory
- Overnight insights, cross-sell opportunities

The CRM has its own AI agent with 71 specialized tools. Your message will be processed by the CRM agent, which will call the appropriate tools and return structured results.

Do NOT use this for: web search, email, calendar, general questions. Those are your own tools.`,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural language query in Spanish. Be specific about what you need (account name, time period, metric).",
        },
        persona_role: {
          type: "string",
          enum: ["ae", "gerente", "director", "vp"],
          description:
            "Role perspective for the query. Director sees most data. Default: director.",
        },
      },
      required: ["query"],
    },
  },
};
```

**Handler implementation**:

1. Send A2A `sendMessage` to `CRM_A2A_URL` (env var, default `http://localhost:3000`)
2. Poll `getTask` with exponential backoff (1s → 15s, 2min timeout — CRM inference takes ~15-30s)
3. Extract text from artifact parts
4. Return formatted result

**Alternative**: Use the existing `A2ARpcClient` from `src/a2a/client.ts` directly — it already handles card caching, auth headers, and polling. The tool handler would be ~20 lines.

### Step 3: Scope Integration (~30min)

**File**: `src/messaging/scope.ts` (modify)

Add CRM keywords to trigger `crm_query` activation:

```typescript
// New scope group
export const CRM_QUERY_TOOLS = ["crm_query"];

// Add to DEFAULT_SCOPE_PATTERNS
{
  pattern: /\b(pipeline|propuestas?|cuota|quota|briefing|crm|pulso|azteca|cuentas?|inventario|paquete|descarga|factur)/i,
  group: "crm_query",
}
```

Add to `scopeToolsForMessage()`:

```typescript
if (activeGroups.has("crm_query")) {
  tools.push(...CRM_QUERY_TOOLS);
}
```

Register in tool source (e.g., `src/tools/sources/builtin.ts`).

### Step 4: Environment Configuration

**CRM `.env`**:

```bash
CRM_A2A_KEY=<generated-secret>
```

**Mission Control `.env`**:

```bash
CRM_A2A_URL=http://localhost:3000
CRM_A2A_KEY=<same-secret>
```

## Files to Create

| File                             | Repo            | Purpose                           |
| -------------------------------- | --------------- | --------------------------------- |
| `crm/src/dashboard/a2a.ts`       | crm-azteca      | A2A JSON-RPC handler + agent card |
| `src/tools/builtin/crm-query.ts` | mission-control | Jarvis tool that delegates to CRM |

## Files to Modify

| File                           | Repo            | Change                                            |
| ------------------------------ | --------------- | ------------------------------------------------- |
| `crm/src/dashboard/server.ts`  | crm-azteca      | Mount `/.well-known/agent.json` and `/a2a` routes |
| `src/messaging/scope.ts`       | mission-control | Add `crm_query` scope group + pattern             |
| `src/tools/sources/builtin.ts` | mission-control | Register `crm_query` tool                         |
| `.env`                         | both            | Add `CRM_A2A_KEY` and `CRM_A2A_URL`               |

## What This Does NOT Include (Future Work)

- **CRM → Jarvis** (reverse delegation): Requires agent-runner changes inside Docker. The CRM agent would need to recognize "I need web search" and call Jarvis via A2A. Deferred.
- **Pipesong integration**: Pipesong is Python/FastAPI on a separate server (TensorDock). Adding A2A would mean a `/a2a` FastAPI route wrapping STT/TTS. Separate effort.
- **Smart classifier routing**: Auto-detecting CRM tasks at the classifier level (not just scope). Would bypass the need for `crm_query` tool entirely — Jarvis would route the whole task to CRM. More ambitious, deferred.
- **Streaming**: CRM inference takes 15-30s. Streaming would require SSE support in the dashboard server. Not critical for v1.
- **Multi-turn context**: The A2A protocol supports `contextId` for multi-turn conversations. v1 treats each query as stateless. Multi-turn would require session management on the CRM side.

## Verification Plan

1. Start CRM dashboard → verify `GET /.well-known/agent.json` returns agent card
2. Send A2A `sendMessage` via curl → verify CRM runs inference and returns result
3. Start Jarvis → send "como va el pipeline" via Telegram → verify `crm_query` tool activates
4. Verify CRM response flows back and Jarvis formats it for Telegram
5. Test with quota query, proposal creation, briefing request
6. Verify scope: non-CRM messages ("send an email") do NOT trigger `crm_query`
7. Test auth: request without `X-Api-Key` header returns 401
8. Full test suites pass in both repos

## Cost Analysis

- Each CRM A2A query = 1 DashScope inference call (~$0.004)
- Expected daily volume: 5-15 CRM queries via Jarvis
- Daily cost: $0.02-$0.06 — negligible within the $30/day budget
