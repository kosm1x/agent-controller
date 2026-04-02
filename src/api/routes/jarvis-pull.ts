/**
 * Jarvis Pull endpoint — allows external systems (CRM agents) to request
 * Jarvis's analytical capabilities with role-based depth control.
 *
 * POST /api/jarvis-pull
 * Body: { query: string, role: "ae"|"gerente"|"director"|"vp", context?: string }
 * Returns: { response: string, model: string, tokens: number }
 *
 * v5.0 S4 completion: reverse A2A channel (CRM → Jarvis).
 */

import { Hono } from "hono";
import { infer } from "../../inference/adapter.js";
import { getFilesByQualifier } from "../../db/jarvis-fs.js";

const jarvisPull = new Hono();

type CrmRole = "ae" | "gerente" | "director" | "vp";

const ROLE_INSTRUCTIONS: Record<CrmRole, string> = {
  ae: "Responde en máximo 3 bullets concisos. Solo información directamente accionable para un ejecutivo de ventas. Sin análisis extenso — solo qué hacer y por qué.",
  gerente:
    "Incluye métricas clave relevantes y una recomendación concreta. Máximo 5 bullets. Enfoque en lo que el gerente necesita decidir hoy.",
  director:
    "Análisis completo con contexto de mercado, tendencias relevantes y recomendaciones estratégicas. Incluye datos de soporte cuando estén disponibles.",
  vp: "Análisis ejecutivo completo sin restricciones de formato. Incluye visión estratégica, riesgos, oportunidades y recomendaciones priorizadas.",
};

const ROLE_MAX_TOKENS: Record<CrmRole, number> = {
  ae: 300,
  gerente: 500,
  director: 1000,
  vp: 2000,
};

jarvisPull.post("/jarvis-pull", async (c) => {
  let body: { query: string; role?: CrmRole; context?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.query) {
    return c.json({ error: "Missing required field: query" }, 400);
  }

  const role: CrmRole = body.role ?? "ae";
  if (!ROLE_INSTRUCTIONS[role]) {
    return c.json(
      { error: `Invalid role: ${role}. Valid: ae, gerente, director, vp` },
      400,
    );
  }

  // Build system prompt with Jarvis knowledge base + role instructions
  let systemPrompt =
    "Eres Jarvis, asistente estratégico de inteligencia. Un agente del CRM te está solicitando análisis.\n\n";
  systemPrompt += `INSTRUCCIONES DE FORMATO (rol: ${role}):\n${ROLE_INSTRUCTIONS[role]}\n\n`;

  // Inject knowledge base for context (enforce + always-read files)
  try {
    const files = getFilesByQualifier("enforce", "always-read");
    let kbChars = 0;
    for (const f of files) {
      if (kbChars + f.content.length > 4000) break;
      systemPrompt += `---\n${f.content}\n`;
      kbChars += f.content.length;
    }
  } catch {
    // KB not available — proceed without it
  }

  const userMessage = body.context
    ? `Contexto del CRM: ${body.context}\n\nConsulta: ${body.query}`
    : body.query;

  try {
    const result = await infer({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      max_tokens: ROLE_MAX_TOKENS[role],
      temperature: 0.3,
    });

    return c.json({
      response: result.content ?? "",
      role,
      model: "jarvis",
      tokens: result.usage.prompt_tokens + result.usage.completion_tokens,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Jarvis inference failed: ${message}` }, 503);
  }
});

export { jarvisPull };
