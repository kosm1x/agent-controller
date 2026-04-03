/**
 * LLM Benchmark — Tests model quality for Jarvis chat tasks.
 *
 * Runs 20 test prompts against the configured inference adapter and logs:
 * model, prompt, tools_called, response snippet, latency_ms.
 *
 * Usage: npx tsx scripts/benchmark.ts
 *
 * Override model via env vars:
 *   INFERENCE_PRIMARY_URL=... INFERENCE_PRIMARY_KEY=... INFERENCE_PRIMARY_MODEL=... npx tsx scripts/benchmark.ts
 */

import { writeFileSync } from "node:fs";
import { infer } from "../src/inference/adapter.js";
import { toolRegistry } from "../src/tools/registry.js";
import { getConfig } from "../src/config.js";

// ---------------------------------------------------------------------------
// Test prompts (4 categories × 5 each)
// ---------------------------------------------------------------------------

interface TestCase {
  category: string;
  prompt: string;
  /** Tool names that SHOULD be called (empty = expect text-only). */
  expectTools: string[];
  /** Tool names that should NOT be called. */
  rejectTools: string[];
}

const TESTS: TestCase[] = [
  // --- Category 1: Web search (should use web_search) ---
  {
    category: "web_search",
    prompt: "¿Cuál es el tipo de cambio del dólar hoy?",
    expectTools: ["web_search"],
    rejectTools: ["jarvis_file_write"],
  },
  {
    category: "web_search",
    prompt: "Busca las noticias más recientes sobre inteligencia artificial",
    expectTools: ["web_search"],
    rejectTools: ["jarvis_file_write"],
  },
  {
    category: "web_search",
    prompt: "¿Cómo va el clima en la Ciudad de México esta semana?",
    expectTools: ["web_search"],
    rejectTools: ["jarvis_file_write"],
  },
  {
    category: "web_search",
    prompt: "Investiga cuánto cuesta un vuelo a Madrid en abril",
    expectTools: ["web_search"],
    rejectTools: ["jarvis_file_write"],
  },
  {
    category: "web_search",
    prompt: "¿Qué restaurantes buenos hay cerca de Polanco?",
    expectTools: ["web_search"],
    rejectTools: ["jarvis_file_write"],
  },

  // --- Category 2: NorthStar management (should call correct NorthStar tools) ---
  {
    category: "northstar_mgmt",
    prompt: "Muéstrame mis metas activas",
    expectTools: ["jarvis_file_read"],
    rejectTools: ["jarvis_file_write", "web_search"],
  },
  {
    category: "northstar_mgmt",
    prompt: "¿Qué tareas tengo pendientes?",
    expectTools: ["jarvis_file_read"],
    rejectTools: ["jarvis_file_write"],
  },
  {
    category: "northstar_mgmt",
    prompt: "Crea una tarea: revisar el presupuesto de marketing",
    expectTools: ["jarvis_file_write"],
    rejectTools: [],
  },
  {
    category: "northstar_mgmt",
    prompt: "Dame un resumen de mi día en NorthStar",
    expectTools: ["jarvis_file_read"],
    rejectTools: [],
  },
  {
    category: "northstar_mgmt",
    prompt: "Muéstrame la jerarquía completa de mis visiones",
    expectTools: ["jarvis_file_read"],
    rejectTools: [],
  },

  // --- Category 3: DO vs TRACK (should NOT create NorthStar task) ---
  {
    category: "do_not_track",
    prompt:
      "Mándame un resumen del artículo sobre productividad que encontraste",
    expectTools: ["web_search"],
    rejectTools: ["jarvis_file_write"],
  },
  {
    category: "do_not_track",
    prompt: "Redacta un email para Juan sobre la reunión del viernes",
    expectTools: [],
    rejectTools: ["jarvis_file_write"],
  },
  {
    category: "do_not_track",
    prompt: "¿Qué hora es en Tokio?",
    expectTools: [],
    rejectTools: ["jarvis_file_write"],
  },
  {
    category: "do_not_track",
    prompt: "Ayúdame a escribir un mensaje de cumpleaños para mi mamá",
    expectTools: [],
    rejectTools: ["jarvis_file_write"],
  },
  {
    category: "do_not_track",
    prompt: "Investiga qué es la metodología OKR y explícamela",
    expectTools: ["web_search"],
    rejectTools: ["jarvis_file_write"],
  },

  // --- Category 4: Memory/thread continuity (two-part prompts) ---
  {
    category: "continuity",
    prompt: "Te acuerdas que te pedí buscar vuelos a Madrid? Dame más opciones",
    expectTools: ["web_search"],
    rejectTools: ["jarvis_file_write"],
  },
  {
    category: "continuity",
    prompt: "Sobre lo del presupuesto, ¿ya lo revisaste?",
    expectTools: [],
    rejectTools: ["jarvis_file_write"],
  },
  {
    category: "continuity",
    prompt: "Mejor cambia esa tarea que creaste a prioridad alta",
    expectTools: ["jarvis_file_read"],
    rejectTools: [],
  },
  {
    category: "continuity",
    prompt: "¿Qué hablamos la última vez?",
    expectTools: [],
    rejectTools: ["jarvis_file_write"],
  },
  {
    category: "continuity",
    prompt: "Sigue con lo que estabas haciendo",
    expectTools: [],
    rejectTools: ["jarvis_file_write"],
  },
];

// ---------------------------------------------------------------------------
// System prompt (mirrors router.ts)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `Eres Jarvis, el asistente estratégico personal de Fede (Federico). Habla en español mexicano, conciso y orientado a la acción.

## Fecha y hora actual
Hoy es lunes, 17 de marzo de 2026, son las 12:00 PM (hora de la Ciudad de México).

## REGLA CRÍTICA: HAZ las cosas, no las registres
Cuando Fede te pida algo, HAZLO directamente con tus herramientas:
- "Investiga X" → usa web_search y RESPONDE con lo que encontraste
- "Mándame un email" → usa gmail_send y envía el email
- "Crea un documento" → usa gdrive_create y crea el documento
- "Búscame vuelos" → usa web_search y presenta opciones
- "Qué hay en mi calendario" → usa calendar_list y muestra eventos

NO crees una tarea en NorthStar a menos que Fede diga explícitamente: "crea una tarea", "agrega a mis pendientes", "trackea esto".

## Confirmación obligatoria
ANTES de ejecutar estas herramientas, SIEMPRE muestra un resumen al usuario y pregunta "¿Confirmo?":
- gmail_send → muestra: destinatario, asunto, primeras líneas del cuerpo
- gdrive_share → muestra: nombre del archivo, email, nivel de acceso
- calendar_create → muestra: título, fecha/hora, asistentes
- calendar_update con status=cancelled → muestra: qué evento se cancelará
- delete_item → muestra: nombre y tipo del elemento a eliminar

NO ejecutes estas herramientas hasta que el usuario diga "sí", "confirmo", "dale", o similar.

## Tus capacidades
- **Acción directa**: Busca, investiga, envía emails, crea documentos, agenda eventos
- **NorthStar**: Gestiona la productividad de Fede SOLO cuando él lo pide explícitamente
- **Internet**: web_search para información actual — SIEMPRE busca antes de adivinar
- **Google Workspace**: Gmail, Drive, Calendar, Sheets, Docs, Slides, Tasks
- **Memoria**: Recuerdas conversaciones pasadas y aprendes patrones`;

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface BenchmarkResult {
  category: string;
  prompt: string;
  toolsCalled: string[];
  expectedTools: string[];
  rejectedTools: string[];
  pass: boolean;
  failReason?: string;
  responseSnippet: string;
  latencyMs: number;
}

async function runBenchmark(): Promise<void> {
  const config = getConfig();
  const model = config.inferencePrimaryModel;
  console.log(`\n=== LLM Benchmark ===`);
  console.log(`Model: ${model}`);
  console.log(`Provider: ${config.inferencePrimaryUrl}`);
  console.log(`Tests: ${TESTS.length}\n`);

  // Get available tool definitions for the LLM
  const toolNames = [
    "web_search",
    "web_read",
    "jarvis_file_read",
    "jarvis_file_write",
    "gmail_send",
    "gmail_search",
    "calendar_list",
    "calendar_create",
    "calendar_update",
    "gdrive_list",
    "gdrive_create",
    "gdrive_share",
  ];
  const toolDefs = toolRegistry.getDefinitions(toolNames);

  const results: BenchmarkResult[] = [];

  for (let i = 0; i < TESTS.length; i++) {
    const test = TESTS[i];
    const start = Date.now();

    try {
      // Single inference call (no tool execution — we just want to see what tools the LLM picks)
      const response = await infer({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: test.prompt },
        ],
        tools: toolDefs,
        temperature: 0,
      });

      const latencyMs = Date.now() - start;
      const toolsCalled = (response.tool_calls ?? []).map(
        (tc) => tc.function.name,
      );
      const responseSnippet = (response.content ?? "").slice(0, 150);

      // Evaluate
      let pass = true;
      let failReason: string | undefined;

      // Check expected tools
      for (const expected of test.expectTools) {
        if (!toolsCalled.includes(expected)) {
          pass = false;
          failReason = `Missing expected tool: ${expected}`;
          break;
        }
      }

      // Check rejected tools
      if (pass) {
        for (const rejected of test.rejectTools) {
          if (toolsCalled.includes(rejected)) {
            pass = false;
            failReason = `Called rejected tool: ${rejected}`;
            break;
          }
        }
      }

      const result: BenchmarkResult = {
        category: test.category,
        prompt: test.prompt,
        toolsCalled,
        expectedTools: test.expectTools,
        rejectedTools: test.rejectTools,
        pass,
        failReason,
        responseSnippet,
        latencyMs,
      };
      results.push(result);

      const status = pass ? "✅" : "❌";
      console.log(
        `${status} [${i + 1}/${TESTS.length}] ${test.category}: "${test.prompt.slice(0, 50)}..."`,
      );
      if (toolsCalled.length > 0) {
        console.log(`   Tools: ${toolsCalled.join(", ")}`);
      }
      if (!pass) {
        console.log(`   FAIL: ${failReason}`);
      }
      console.log(`   ${latencyMs}ms`);
    } catch (err) {
      const latencyMs = Date.now() - start;
      console.log(
        `❌ [${i + 1}/${TESTS.length}] ${test.category}: ERROR — ${err instanceof Error ? err.message : err}`,
      );
      results.push({
        category: test.category,
        prompt: test.prompt,
        toolsCalled: [],
        expectedTools: test.expectTools,
        rejectedTools: test.rejectTools,
        pass: false,
        failReason: `Error: ${err instanceof Error ? err.message : err}`,
        responseSnippet: "",
        latencyMs,
      });
    }
  }

  // Summary
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  const avgLatency = Math.round(
    results.reduce((sum, r) => sum + r.latencyMs, 0) / total,
  );

  console.log(`\n=== Summary ===`);
  console.log(`Model: ${model}`);
  console.log(
    `Score: ${passed}/${total} (${Math.round((passed / total) * 100)}%)`,
  );
  console.log(`Avg latency: ${avgLatency}ms`);

  // Per-category breakdown
  const categories = [...new Set(results.map((r) => r.category))];
  for (const cat of categories) {
    const catResults = results.filter((r) => r.category === cat);
    const catPassed = catResults.filter((r) => r.pass).length;
    console.log(`  ${cat}: ${catPassed}/${catResults.length}`);
  }

  // Write results to file
  const output = {
    model,
    provider: config.inferencePrimaryUrl,
    timestamp: new Date().toISOString(),
    score: `${passed}/${total}`,
    avgLatencyMs: avgLatency,
    results,
  };

  const outPath = `/root/claude/mission-control/scripts/benchmark-${model.replace(/[^a-zA-Z0-9.-]/g, "_")}-${Date.now()}.json`;
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nResults saved to: ${outPath}`);
}

runBenchmark().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
