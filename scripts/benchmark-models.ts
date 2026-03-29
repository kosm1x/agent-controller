/**
 * v3.3 Model Benchmark — evaluates all available models on 15 test prompts.
 *
 * Measures: latency, tool selection accuracy, instruction compliance, response quality.
 * Run: set -a && source .env && set +a && npx tsx scripts/benchmark-models.ts
 */

const API_URL = process.env.INFERENCE_PRIMARY_URL + "/chat/completions";
const API_KEY = process.env.INFERENCE_PRIMARY_KEY!;

const MODELS = [
  "qwen3.5-plus",
  "qwen3-max-2026-01-23",
  "qwen3-coder-next",
  "qwen3-coder-plus",
  "glm-5",
  "glm-4.7",
  "kimi-k2.5",
  "MiniMax-M2.5",
];

// Simplified tool definitions for benchmark
const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "web_search",
      description: "Search the web for current information.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "user_fact_set",
      description:
        "Store a personal fact about the user. Categories: personal, projects, preferences.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string" },
          key: { type: "string" },
          value: { type: "string" },
        },
        required: ["category", "key", "value"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gsheets_read",
      description: "Read data from a Google Spreadsheet.",
      parameters: {
        type: "object",
        properties: {
          spreadsheet_id: { type: "string" },
          range: { type: "string" },
        },
        required: ["spreadsheet_id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gmail_send",
      description: "Send an email via Gmail.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["to", "subject", "body"],
      },
    },
  },
];

const SYSTEM_PROMPT = `Eres Jarvis, el asistente estratégico personal de Fede. Habla en español mexicano, conciso y orientado a la acción.

REGLA CRÍTICA: Solo usa herramientas disponibles. NO narres acciones — EJECUTA con tool calls.
Si el usuario te pide información que requiere buscar, USA web_search. NO inventes datos.
Si el usuario comparte información personal, guárdala con user_fact_set.`;

interface TestCase {
  id: string;
  prompt: string;
  /** What the model SHOULD do */
  expectedBehavior: string;
  /** Tool it should call (null = no tool needed) */
  expectedTool: string | null;
  /** Regex the response should match (for no-tool cases) */
  responsePattern?: RegExp;
}

const TEST_CASES: TestCase[] = [
  // --- Tool selection ---
  {
    id: "T1",
    prompt: "Busca noticias de inteligencia artificial de hoy",
    expectedBehavior: "Call web_search",
    expectedTool: "web_search",
  },
  {
    id: "T2",
    prompt: "Mi cumpleaños es el 15 de agosto",
    expectedBehavior: "Call user_fact_set to store birthday",
    expectedTool: "user_fact_set",
  },
  {
    id: "T3",
    prompt:
      "Envía un correo a juan@test.com diciendo que la reunión es mañana a las 3pm",
    expectedBehavior: "Call gmail_send",
    expectedTool: "gmail_send",
  },
  {
    id: "T4",
    prompt: "Lee la hoja de cálculo con ID abc123",
    expectedBehavior: "Call gsheets_read",
    expectedTool: "gsheets_read",
  },
  // --- Should NOT use tools ---
  {
    id: "N1",
    prompt: "Hola, buenos días",
    expectedBehavior: "Respond conversationally, no tools",
    expectedTool: null,
    responsePattern: /\b(hola|buenos|buen)\b/i,
  },
  {
    id: "N2",
    prompt: "Gracias por tu ayuda",
    expectedBehavior: "Acknowledge, no tools",
    expectedTool: null,
  },
  // --- Instruction compliance ---
  {
    id: "I1",
    prompt: "¿Qué tiempo hará mañana en Ciudad de México?",
    expectedBehavior: "Should use web_search, NOT make up weather",
    expectedTool: "web_search",
  },
  {
    id: "I2",
    prompt: "¿Cuánto vale el dólar hoy?",
    expectedBehavior: "Should use web_search for current data",
    expectedTool: "web_search",
  },
  // --- Spanish compliance ---
  {
    id: "S1",
    prompt: "Dame un resumen de qué es la IA generativa",
    expectedBehavior: "Respond in Spanish without tools",
    expectedTool: null,
    responsePattern:
      /\b(inteligencia|artificial|generativ|modelo|texto|imagen)\b/i,
  },
  // --- Complex instruction ---
  {
    id: "C1",
    prompt: "Mi nuevo número de teléfono es 55-1234-5678, guárdalo por favor",
    expectedBehavior: "Call user_fact_set with phone number",
    expectedTool: "user_fact_set",
  },
  {
    id: "C2",
    prompt: "Investiga qué es Pipecat y para qué sirve",
    expectedBehavior: "Call web_search (should not make up info)",
    expectedTool: "web_search",
  },
  // --- Edge cases ---
  {
    id: "E1",
    prompt: "¿Qué herramientas tienes disponibles?",
    expectedBehavior: "List available tools from context, no tool call needed",
    expectedTool: null,
  },
  {
    id: "E2",
    prompt: "Repite exactamente: 'Soy un asistente AI'",
    expectedBehavior: "Follow instruction literally",
    expectedTool: null,
    responsePattern: /soy un asistente ai/i,
  },
  // --- Conciseness ---
  {
    id: "Q1",
    prompt: "¿Cuánto es 2+2?",
    expectedBehavior: "Answer briefly: 4",
    expectedTool: null,
    responsePattern: /4/,
  },
  {
    id: "Q2",
    prompt: "Dime la capital de Francia en una palabra",
    expectedBehavior: "Answer: París",
    expectedTool: null,
    responsePattern: /par[ií]s/i,
  },
];

interface CallResult {
  model: string;
  testId: string;
  latencyMs: number;
  toolCalled: string | null;
  content: string;
  correct: boolean;
  error?: string;
}

async function callModel(
  model: string,
  prompt: string,
  withTools: boolean,
): Promise<{
  latencyMs: number;
  toolCalled: string | null;
  content: string;
  error?: string;
}> {
  const start = Date.now();
  try {
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      max_tokens: 300,
      temperature: 0.3,
    };
    if (withTools) body.tools = TOOLS;

    // Disable thinking for models that need it
    if (/qwen|glm/i.test(model)) {
      body.extra_body = { enable_thinking: false };
    }

    const resp = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    const latencyMs = Date.now() - start;

    if (!resp.ok) {
      const err = await resp.text().catch(() => "");
      return {
        latencyMs,
        toolCalled: null,
        content: "",
        error: `HTTP ${resp.status}: ${err.slice(0, 100)}`,
      };
    }

    const data = (await resp.json()) as Record<string, unknown>;
    const choice = (data.choices as Array<Record<string, unknown>>)?.[0];
    const message = choice?.message as Record<string, unknown> | undefined;
    const content = (message?.content as string) ?? "";
    const toolCalls = message?.tool_calls as
      | Array<{ function: { name: string } }>
      | undefined;
    const toolCalled = toolCalls?.[0]?.function?.name ?? null;

    return { latencyMs, toolCalled, content, error: undefined };
  } catch (err) {
    return {
      latencyMs: Date.now() - start,
      toolCalled: null,
      content: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function evaluate(test: TestCase, result: CallResult): boolean {
  if (result.error) return false;

  if (test.expectedTool) {
    // Should have called the expected tool
    return result.toolCalled === test.expectedTool;
  } else {
    // Should NOT have called any tool
    if (result.toolCalled) return false;
    // Check response pattern if specified
    if (test.responsePattern) {
      return test.responsePattern.test(result.content);
    }
    // Just check it produced some content
    return result.content.length > 0;
  }
}

async function main() {
  console.log(`\n=== v3.3 Model Benchmark ===`);
  console.log(`Models: ${MODELS.length} | Tests: ${TEST_CASES.length}`);
  console.log(`Total calls: ${MODELS.length * TEST_CASES.length}\n`);

  const results: CallResult[] = [];

  for (const model of MODELS) {
    process.stdout.write(`${model}: `);
    let correct = 0;
    let totalLatency = 0;

    for (const test of TEST_CASES) {
      const withTools = test.expectedTool !== null;
      const raw = await callModel(model, test.prompt, withTools);
      const result: CallResult = {
        model,
        testId: test.id,
        latencyMs: raw.latencyMs,
        toolCalled: raw.toolCalled,
        content: raw.content.slice(0, 200),
        correct: false,
        error: raw.error,
      };
      result.correct = evaluate(test, result);
      results.push(result);

      process.stdout.write(result.correct ? "✓" : "✗");
      if (result.correct) correct++;
      totalLatency += raw.latencyMs;

      // Small delay to avoid rate limits
      await new Promise((r) => setTimeout(r, 300));
    }

    const avgLatency = Math.round(totalLatency / TEST_CASES.length);
    console.log(
      ` | ${correct}/${TEST_CASES.length} (${Math.round((correct / TEST_CASES.length) * 100)}%) | avg ${avgLatency}ms`,
    );
  }

  // Summary table
  console.log("\n=== SUMMARY ===\n");
  console.log(
    "Model                      | Score    | Avg Latency | Tool Acc | No-Tool Acc | Errors",
  );
  console.log(
    "---------------------------|----------|-------------|----------|-------------|-------",
  );

  for (const model of MODELS) {
    const modelResults = results.filter((r) => r.model === model);
    const correct = modelResults.filter((r) => r.correct).length;
    const total = modelResults.length;
    const avgLatency = Math.round(
      modelResults.reduce((s, r) => s + r.latencyMs, 0) / total,
    );
    const errors = modelResults.filter((r) => r.error).length;

    // Tool accuracy (tests that expect a tool call)
    const toolTests = modelResults.filter((r) => {
      const tc = TEST_CASES.find((t) => t.id === r.testId);
      return tc?.expectedTool !== null;
    });
    const toolCorrect = toolTests.filter((r) => r.correct).length;

    // No-tool accuracy (tests that expect no tool call)
    const noToolTests = modelResults.filter((r) => {
      const tc = TEST_CASES.find((t) => t.id === r.testId);
      return tc?.expectedTool === null;
    });
    const noToolCorrect = noToolTests.filter((r) => r.correct).length;

    console.log(
      `${model.padEnd(27)}| ${correct}/${total} (${String(Math.round((correct / total) * 100)).padStart(3)}%) | ${String(avgLatency).padStart(7)}ms | ${toolCorrect}/${toolTests.length}      | ${noToolCorrect}/${noToolTests.length}         | ${errors}`,
    );
  }

  // Failures detail
  console.log("\n=== FAILURES ===\n");
  for (const r of results) {
    if (!r.correct) {
      const test = TEST_CASES.find((t) => t.id === r.testId)!;
      console.log(
        `${r.model} | ${r.testId}: Expected ${test.expectedTool ?? "no tool"}, got ${r.toolCalled ?? "no tool"}${r.error ? ` (ERR: ${r.error})` : ""} | "${r.content.slice(0, 80)}"`,
      );
    }
  }
}

main().catch(console.error);
