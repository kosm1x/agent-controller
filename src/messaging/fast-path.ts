/**
 * Fast-path for simple conversational messages.
 *
 * Skips the full pipeline (enrichment, scope, dispatcher, runner) for messages
 * that clearly don't need tools: greetings, farewells, personal reflections.
 * Direct infer() call with Jarvis persona → response in ~2s.
 *
 * Conservative: false negatives (routing through full pipeline) are acceptable;
 * false positives (fast-pathing a tool-needing message) are NOT.
 */

import { infer } from "../inference/adapter.js";
import type { ChatMessage } from "../inference/adapter.js";
import type { ConversationTurn } from "../runners/types.js";

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Greetings, farewells, and casual small talk — safe to fast-path. */
const SAFE_PATTERNS = [
  /^(hola|hey|buenas?|buenos?\s+(d[ií]as?|tardes?|noches?))[\s!.,]*$/i,
  /^(qu[eé]\s+tal|c[oó]mo\s+(est[aá]s|andas|vas|te\s+va))[\s!?.,]*$/i,
  /^(qu[eé]\s+onda|qu[eé]\s+hay|qu[eé]\s+cuentas)[\s!?.,]*$/i,
  /^(adi[oó]s|bye|hasta\s+(luego|ma[nñ]ana|pronto)|nos\s+vemos)[\s!.,]*$/i,
  /^(buen\s+d[ií]a|ya\s+me\s+voy|me\s+retiro)[\s!.,]*$/i,
  /^(hello|hi|good\s+(morning|afternoon|evening|night))[\s!.,]*$/i,
  /^(thanks?|thank\s+you|cheers)[\s!.,]*$/i,
];

/** Keywords that indicate the message needs tools — disqualifies fast-path. */
const TOOL_TRIGGERS = [
  /\b(hora|tiempo|fecha|calendario|agenda|schedule|cron)\b/i,
  /\b(tareas?|metas?|objetivos?|goals?|tasks?|visio\w+|visions?|journal|diario)\b/i,
  /\b(busca|search|publica|publish|env[ií]a|send|crea|create|genera)\b/i,
  /\b(correos?|emails?|gmail|drive|sheets?|wordpress|wp|blogs?)\b/i,
  /\b(recuerda|remember|guarda|save|anota|registra)\b/i,
  /\b(lee|read|lista|list|muestra|show|analiza|analyze|revisa|check|verifica|audita)\b/i,
  /\b(programas?|configura|setup|instala|deploy)\b/i,
  /\b(procede|ejecuta|hazlo|adelante|dale|confir\w+|s[ií]guele|int[eé]ntalo|reint[eé]ntalo)\b/i,
  /\b(elimina\w*|borra\w*|delete|quita\w*|actualiza\w*|marca\w*|update)\b/i,
  /\b(im[aá]gen(es)?|images?|fotos?|photos?|videos?|audios?|m[uú]sica|music|pdfs?)\b/i,
  /\b(proyectos?|projects?|artículos?|articles?|enlaces?|links?)\b/i,
  /\b(hugging\s?face|gemini|hf_|wp_|gsheets)\b/i,
];

/**
 * Check if a message is safe for the conversational fast-path.
 *
 * Returns true ONLY for messages that clearly don't need tools.
 * Must not have images (those need vision pipeline).
 */
export function isConversationalFastPath(text: string): boolean {
  const trimmed = text.trim();
  const wordCount = trimmed.split(/\s+/).length;

  // Only very short messages qualify
  if (wordCount > 8) return false;

  // Tool triggers always disqualify
  if (TOOL_TRIGGERS.some((p) => p.test(trimmed))) return false;

  // Explicit safe patterns
  if (SAFE_PATTERNS.some((p) => p.test(trimmed))) return true;

  // Fallback: short (≤8 words), no tool triggers, no question mark.
  // These are conversational statements that don't need the full pipeline.
  // Tool triggers already filtered at line 61, so this is safe.
  if (wordCount <= 8 && !trimmed.endsWith("?")) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

const FAST_PATH_SYSTEM = `Eres Jarvis, el asistente estratégico personal de Fede (Federico). Habla en español mexicano, conciso y cálido. Responde a este saludo o comentario casual de forma natural y breve (1-2 oraciones). No ofrezcas ayuda proactivamente a menos que sea natural en la conversación.`;

/**
 * Generate a quick conversational response using a direct infer() call.
 * No tools, no enrichment, no dispatcher — just the Jarvis persona.
 */
export async function fastPathRespond(
  text: string,
  threadTurns: ConversationTurn[],
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: FAST_PATH_SYSTEM },
  ];

  // Include last 2 exchanges (4 turns) for continuity
  const recentTurns = threadTurns.slice(-4);
  for (const turn of recentTurns) {
    messages.push({ role: turn.role, content: turn.content });
  }

  messages.push({ role: "user", content: text });

  const result = await infer(
    { messages, temperature: 0.7 },
    { providerName: "fallback" }, // flash model for speed, no streaming
  );

  return result.content || "👋";
}
