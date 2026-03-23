/**
 * Message router — bridges messaging channels to the Agent Controller.
 *
 * Inbound: owner message → task via submitTask()
 * Outbound: task.completed/task.failed events → formatted reply to channel
 * Ritual: completed ritual tasks → broadcast to all active channels
 */

import { submitTask } from "../dispatch/dispatcher.js";
import { getDatabase } from "../db/index.js";
import { getEventBus } from "../lib/event-bus.js";
import type { Event } from "../lib/events/types.js";
import type {
  TaskCompletedPayload,
  TaskFailedPayload,
} from "../lib/events/types.js";
import type {
  ChannelAdapter,
  ChannelName,
  IncomingMessage,
  OutgoingMessage,
} from "./types.js";
import { getMemoryService } from "../memory/index.js";
import {
  trackTaskOutcome,
  checkFeedbackWindow,
  recordTaskFeedback,
  clearAllFeedbackWindows,
} from "../intelligence/outcome-tracker.js";
import { enrichContext } from "../intelligence/enrichment.js";
import { formatUserFactsBlock, setUserFact } from "../db/user-facts.js";
import {
  detectFeedbackSignal,
  isFeedbackMessage,
} from "../intelligence/feedback.js";
import {
  isProactiveTask,
  handleProactiveResult,
} from "../intelligence/proactive.js";
import {
  isScheduledTask,
  handleScheduledTaskResult,
  handleScheduledTaskFailure,
} from "../rituals/dynamic.js";
import type { ConversationTurn } from "../runners/types.js";
import { nowMexDate, nowMexTime } from "../lib/timezone.js";

const TASK_TIMEOUT_INTERIM_MS = 120_000; // 2 min → "still working"
const TASK_TIMEOUT_FINAL_MS = 300_000; // 5 min → give up waiting

// ---------------------------------------------------------------------------
// Tool groups — organized for dynamic scoping
// ---------------------------------------------------------------------------

/** Always included: essential tools for every conversation. */
const CORE_TOOLS = [
  "user_fact_set",
  "user_fact_list",
  "user_fact_delete",
  "web_search",
  "web_read",
  "skill_save",
  "skill_list",
];

/** COMMIT read tools — included by default for quick lookups. */
const COMMIT_READ_TOOLS = [
  "commit__get_daily_snapshot",
  "commit__get_hierarchy",
  "commit__list_tasks",
  "commit__list_goals",
  "commit__list_objectives",
  "commit__search_journal",
  "commit__list_ideas",
];

/** COMMIT write tools — only when productivity management is the topic. */
const COMMIT_WRITE_TOOLS = [
  "commit__update_status",
  "commit__complete_recurring",
  "commit__create_task",
  "commit__create_goal",
  "commit__create_objective",
  "commit__create_vision",
  "commit__update_task",
  "commit__update_objective",
  "commit__update_goal",
  "commit__update_vision",
  "commit__bulk_reprioritize",
];

/** Destructive COMMIT tools — only when user explicitly mentions deletion. */
const COMMIT_DESTRUCTIVE_TOOLS = ["commit__delete_item"];

/** Scheduling tools — only when reports/automation discussed. */
const SCHEDULE_TOOLS = ["schedule_task", "list_schedules", "delete_schedule"];

/** Google Workspace tools (added when GOOGLE_CLIENT_ID is set). */
const GOOGLE_TOOLS = [
  "gmail_send",
  "gmail_search",
  "gdrive_list",
  "gdrive_create",
  "gdrive_share",
  "calendar_list",
  "calendar_create",
  "calendar_update",
  "gsheets_read",
  "gsheets_write",
  "gdocs_read",
  "gdocs_write",
  "gslides_create",
  "gtasks_create",
];

/** Coding/file tools — only when code/files are the topic. */
const CODING_TOOLS = [
  "shell_exec",
  "file_read",
  "file_write",
  "file_edit",
  "grep",
  "glob",
  "list_dir",
];

/** WordPress tools — content + admin, only when blog/site management discussed. */
const WORDPRESS_TOOLS = [
  "wp_list_posts",
  "wp_read_post",
  "wp_publish",
  "wp_media_upload",
  "wp_categories",
  "wp_pages",
  "wp_plugins",
  "wp_settings",
  "wp_delete",
  "wp_raw_api",
];

/** Other utility tools — always included (lightweight definitions). */
const MISC_TOOLS = [
  "http_fetch",
  "chart_generate",
  "rss_read",
  "list_schedules",
  "gemini_image",
];

/** Lightpanda browser tools — only when web interaction needed. */
const BROWSER_TOOLS = [
  "browser__goto",
  "browser__markdown",
  "browser__links",
  "browser__evaluate",
  "browser__semantic_tree",
  "browser__interactiveElements",
  "browser__structuredData",
  "browser__click",
  "browser__fill",
  "browser__scroll",
];

// ---------------------------------------------------------------------------
// Dynamic tool scoping — reduces prompt bloat by ~40-50%
// ---------------------------------------------------------------------------

/** Keyword patterns that activate tool groups. Scans current + recent messages. */
const SCOPE_PATTERNS: { pattern: RegExp; group: string }[] = [
  // COMMIT write tools (excludes delete — see commit_destructive below)
  {
    pattern:
      /\b(crea(r|me)?|actualiz|complet|tareas?|tasks?|metas?|goals?|objetivos?|objectives?|visi[oó]n|pendientes?|commit|productiv|priorid|sprint|haz una|agrega|trackea|pon esto)/i,
    group: "commit_write",
  },
  // COMMIT destructive tools — only on explicit deletion keywords
  {
    pattern:
      /\b(elimina(r|la|las|lo|los)?|borra(r|la|las|lo|los)?|delete|quita(r)?|remove)\b/i,
    group: "commit_destructive",
  },
  // Google tools
  {
    pattern:
      /\b(emails?|correos?|mails?|gmail|calendar|agenda|eventos?|citas?|reuni[oó]n|drive|document|hojas?|sheets?|slides?|present|google)/i,
    group: "google",
  },
  // Browser tools
  {
    pattern:
      /\b(naveg|browse|sitio|p[aá]gina|verific|click|login|form|scrape|interact|render|javascript)/i,
    group: "browser",
  },
  // Coding tools
  {
    pattern:
      /\b(c[oó]digo|code|archivos?|files?|scripts?|deploy|edita|grep|busca(r)?\s+en|estructura|directori|carpetas?|servers?|servidores?|git|npm|build|test|lint|bug|error|fix|debug)/i,
    group: "coding",
  },
  // Schedule tools
  {
    pattern:
      /\b(schedules?|reportes?|programa(r|dos?|ción)?|cron|diarios?|semanal|automat\w*|recurrent)/i,
    group: "schedule",
  },
  // WordPress tools — content, admin, plugins, site management
  {
    pattern:
      /\b(wordpress|wp|blogs?|posts?|art[ií]culos?|publi(ca|car|que)|drafts?|borrador|featured\s*image|hero\s*image|categor[iy]|tags?|plugin|theme|tema|sitio\s+web|header|footer|inyect|inject|tracker|tracking|GA4|analytics|widget|snippet|livingjoyfully|redlightinsider|genera.*imagen|image.*genera|gemini.*imag|imag.*blog|sube.*imagen|upload.*image|media.*upload)/i,
    group: "wordpress",
  },
];

// ---------------------------------------------------------------------------
// Jarvis system prompt builder — conditional sections based on scoped tools
// ---------------------------------------------------------------------------

/**
 * Build the Jarvis system prompt with only the sections relevant to the
 * tools actually in scope. Prevents the LLM from attempting to use tools
 * it cannot call (e.g., browser__goto when browser tools aren't scoped).
 */
function buildJarvisSystemPrompt(
  mxDate: string,
  mxTime: string,
  tools: string[],
  userFactsBlock: string,
  enrichmentBlock: string,
): string {
  const hasBrowser = tools.some((t) => t.startsWith("browser__"));
  const hasWordpress = tools.some((t) => t.startsWith("wp_"));
  const hasCoding = tools.some((t) =>
    [
      "file_read",
      "file_edit",
      "file_write",
      "grep",
      "glob",
      "list_dir",
      "shell_exec",
    ].includes(t),
  );
  const hasGoogle = tools.some((t) =>
    ["gmail_send", "calendar_list", "gdrive_list"].includes(t),
  );

  const sections: string[] = [];

  // --- Core identity and date ---
  sections.push(`Eres Jarvis, el asistente estratégico personal de Fede (Federico). Habla en español mexicano, conciso y orientado a la acción.

## REGLA CRÍTICA: Solo usa herramientas disponibles
Solo puedes usar las herramientas que aparecen en tu lista de funciones disponibles. NO intentes usar, mencionar, ni describir herramientas que no están en tu lista. Si necesitas una herramienta que no tienes, di "No tengo esa herramienta disponible en este momento."

## Fecha y hora actual
Hoy es ${mxDate}, son las ${mxTime} (hora de la Ciudad de México). SIEMPRE usa esta fecha como referencia.

## REGLA CRÍTICA: HAZ las cosas, no las registres
Cuando Fede te pida algo, HAZLO directamente con tus herramientas:
- "Investiga X" → usa web_search y RESPONDE con lo que encontraste
- "Mándame un email" → usa gmail_send y envía el email
- "Crea un documento" → usa gdrive_create y crea el documento
- "Búscame vuelos" → usa web_search y presenta opciones
- "Qué hay en mi calendario" → usa calendar_list y muestra eventos

NO crees una tarea en COMMIT a menos que Fede diga explícitamente: "crea una tarea", "agrega a mis pendientes", "pon esto en COMMIT", "trackea esto".

COMMIT es el sistema de productividad de Fede (visiones → metas → objetivos → tareas). Solo interactúa con COMMIT cuando Fede quiere GESTIONAR su productividad.

## Jerarquía COMMIT (cuando aplique)
- Visión = dirección de vida a largo plazo
- Meta/Goal = resultado medible bajo una visión
- Objetivo = hito específico bajo una meta
- Tarea = acción concreta bajo un objetivo
Usa list_goals para metas, list_objectives para objetivos. NO presentes visiones como metas.

## REGLA CRÍTICA: Reporta lo que hiciste
Después de llamar herramientas que crean, modifican, o eliminan elementos (COMMIT, WordPress, Google, etc.), tu respuesta DEBE empezar reportando exactamente qué se creó/modificó/eliminó, incluyendo nombres, IDs, y la jerarquía donde se ubicó. Solo después de reportar tus acciones puedes mencionar limitaciones o pasos adicionales.`);

  // --- Capabilities summary (adapt to scoped tools) ---
  const caps = [
    `- **Acción directa**: Busca, investiga — HAZLO, no lo registres`,
    `- **COMMIT**: Gestiona la productividad de Fede SOLO cuando él lo pide explícitamente`,
    `- **Internet**: web_search para información actual — SIEMPRE busca antes de adivinar`,
  ];
  if (hasGoogle)
    caps.push(
      `- **Google Workspace**: Gmail, Drive, Calendar, Sheets, Docs, Slides, Tasks`,
    );
  caps.push(
    `- **Memoria**: Recuerdas conversaciones pasadas y aprendes patrones`,
  );
  caps.push(
    `- **Perfil de usuario**: Guarda datos personales de Fede con user_fact_set para NUNCA olvidarlos`,
  );
  if (hasBrowser)
    caps.push(
      `- **Navegador**: Interactúa con sitios web (browser__goto, browser__click, browser__fill)`,
    );
  if (hasCoding)
    caps.push(
      `- **Código**: Lee, edita, ejecuta archivos (file_read, file_edit, shell_exec, grep, glob)`,
    );
  sections.push(`## Tus capacidades\n${caps.join("\n")}`);

  // --- Personal + project data rule ---
  sections.push(`## REGLA CRÍTICA: Guardar datos personales y técnicos
Cuando Fede te comparta información personal (edad, cumpleaños, familia, aspiraciones, valores, ética de trabajo, preferencias permanentes), SIEMPRE usa la herramienta user_fact_set para guardarla INMEDIATAMENTE. No preguntes si quiere que lo guardes — simplemente hazlo. Estos datos se inyectan automáticamente en cada conversación futura.

Cuando Fede te proporcione CUALQUIER dato técnico o de proyecto — IDs de GA4, API keys, credenciales, tokens, URLs de acceso, IDs de medición, configuraciones de servicios — guárdalo INMEDIATAMENTE con user_fact_set (categoría "projects", key descriptivo como "livingjoyfully_ga4_id"). Estos datos son difíciles de recuperar y fáciles de perder entre sesiones.`);

  // --- Confirmation rule ---
  const confirmTools: string[] = [];
  if (hasGoogle)
    confirmTools.push(
      `- gmail_send → muestra: destinatario, asunto, primeras líneas del cuerpo`,
      `- gdrive_share → muestra: nombre del archivo, email, nivel de acceso`,
      `- calendar_create → muestra: título, fecha/hora, asistentes`,
      `- calendar_update con status=cancelled → muestra: qué evento se cancelará`,
    );
  confirmTools.push(
    `- delete_item → muestra: nombre y tipo del elemento a eliminar`,
  );
  sections.push(`## Confirmación obligatoria
ANTES de ejecutar estas herramientas, SIEMPRE muestra un resumen al usuario y pregunta "¿Confirmo?":\n${confirmTools.join("\n")}

NO ejecutes estas herramientas hasta que el usuario diga "sí", "confirmo", "dale", o similar.
Si el usuario dice "no" o "cancela", NO ejecutes y pregunta qué cambiar.`);

  // --- Autonomous verification (ONLY when browser tools are available) ---
  if (hasBrowser) {
    sections.push(`## Verificación autónoma
Después de completar un deploy, subir archivos, o modificar código en producción:
1. Usa browser__goto para navegar al sitio afectado
2. Usa browser__markdown para extraer el contenido y verificar los cambios
3. Reporta el resultado — nunca digas "listo" sin verificar primero
Si browser__goto no está disponible, usa web_read como alternativa.`);
  }

  // --- Tool-first rule ---
  const toolFirstLines = [
    `- "Qué reportes/schedules tienes?" → list_schedules PRIMERO, luego responde`,
    `- "Qué tareas hay?" → commit__list_tasks PRIMERO, luego responde`,
    `- "Qué metas/objetivos tengo?" → commit__list_goals / commit__list_objectives PRIMERO`,
    `- "Qué skills tienes?" → skill_list PRIMERO`,
    `- "Cuánto llevo de cuota?" → consultar la herramienta correspondiente PRIMERO`,
  ];
  if (hasGoogle) {
    toolFirstLines.push(
      `- "Qué hay en mi calendario?" → calendar_list PRIMERO, luego responde`,
    );
  }
  if (hasWordpress) {
    toolFirstLines.push(
      `- "Publica en WordPress" → wp_publish PRIMERO, luego reporta el resultado`,
      `- "Republica/cambia estado" → wp_list_posts → wp_publish con post_id y status (SIN content) — NO necesitas wp_read_post`,
      `- "Actualiza/modifica un artículo" → wp_list_posts → wp_read_post → wp_publish (los 3, en ese orden)`,
    );
  }
  sections.push(`## REGLA CRÍTICA: Herramienta primero, texto después
NUNCA respondas preguntas sobre estado del sistema, listas, o datos estructurados basándote en tu memoria conversacional. SIEMPRE ejecuta la herramienta correspondiente ANTES de generar texto:
${toolFirstLines.join("\n")}
La fuente de la verdad es la herramienta, NUNCA tu contexto conversacional. Si "recuerdas" la respuesta pero no llamaste a la herramienta, tu respuesta es SOSPECHOSA. Llama a la herramienta.`);

  // --- WordPress protocol (ONLY when WP tools are available) ---
  if (hasWordpress) {
    sections.push(`## PROTOCOLO OBLIGATORIO: WordPress

### Cambio de estado (publicar, despublicar, republicar):
Solo necesitas post_id + status. NO envíes content. NO necesitas wp_read_post.
1. wp_list_posts para encontrar el post_id
2. wp_publish con post_id y status (ej: "publish", "draft") — SIN campo content
Esto cambia el estado sin tocar el contenido del artículo.

### Modificación de contenido (editar texto, agregar sección, etc.):
1. PRIMERO: wp_list_posts para encontrar el post_id correcto
2. SEGUNDO: wp_read_post → guarda el HTML completo en un archivo temporal, te devuelve content_file
3. TERCERO: file_edit para hacer los cambios necesarios EN EL ARCHIVO (no en tu contexto)
4. CUARTO: wp_publish con post_id y content_file=<ruta del archivo>
NUNCA envíes "content" inline al editar artículos existentes — usa content_file para evitar truncamiento.
El campo "content" REEMPLAZA todo el cuerpo del artículo.

### Administración del sitio (plugins, scripts, configuración):
- wp_plugins para listar, instalar, activar o desactivar plugins
- wp_settings para leer/actualizar título, tagline, timezone del sitio
- wp_delete para eliminar posts, páginas o medios
- wp_pages para listar páginas del sitio
- wp_raw_api para llamar CUALQUIER endpoint REST de WordPress (plugins custom, widgets, etc.)

### Inyección de código (GA4, tracking, scripts en head):
Las herramientas wp_* tienen autenticación integrada — SIEMPRE úsalas en vez de http_fetch.
Si necesitas configurar un plugin que no expone REST API (como WPCode Lite):
1. Usa browser__goto para navegar al panel de admin del plugin
2. Usa browser__fill para llenar los campos de configuración
3. Usa browser__click para guardar los cambios
4. Usa browser__evaluate para verificar que el código aparece en el <head> del sitio
Las credenciales de WordPress ya están guardadas en WP_SITES — NO necesitas pedirlas al usuario.`);
  }

  // --- No hallucinated execution ---
  sections.push(`## REGLA CRÍTICA: NUNCA simules ejecución
NUNCA narres pasos como si los estuvieras ejecutando sin realmente llamar a una herramienta. Ejemplos PROHIBIDOS:
- "*(Procesando conexión...)*" sin llamar a http_fetch o wp_publish
- "✅ Éxito. El archivo fue creado." sin llamar a file_write
- "Acabo de ejecutar la publicación real" sin tool_calls en tu respuesta
Si no tienes la herramienta disponible para hacer algo, DILO CLARAMENTE: "No tengo herramienta para hacer X" o "Necesito que actives X". NUNCA finjas que algo funcionó. Esto destruye la confianza.`);

  // --- Correction protocol ---
  sections.push(`## Protocolo de corrección
Cuando Fede diga "olvidaste X", "falta X", "te equivocaste en X":
1. NO agregues solo el dato faltante a tu respuesta anterior
2. Vuelve a consultar la herramienta desde CERO (list_schedules, commit__list_tasks, etc.)
3. Presenta la lista COMPLETA regenerada de la fuente de la verdad
4. Compara con tu respuesta anterior y reconoce TODAS las discrepancias
Nunca hagas "parches sobre parches". Regenera desde la fuente.`);

  // --- Active memory ---
  sections.push(`## Memoria activa
- ANTES de preguntar algo que podrías saber, usa memory_search para buscar en tu memoria
- Si Fede menciona un proyecto, persona, o contexto, busca información previa antes de responder
- NO hagas preguntas redundantes — revisa el historial y tu memoria primero
- Después de completar un flujo de 3+ pasos, evalúa si es un patrón repetible y usa skill_save para guardarlo`);

  // --- Coding capabilities (ONLY when coding tools are available) ---
  if (hasCoding) {
    sections.push(`## Capacidades de código
Tienes herramientas completas para leer, buscar, editar y ejecutar código:
- **grep**: Busca texto en archivos — usa esto ANTES de editar para entender el código existente
- **glob**: Encuentra archivos por patrón (e.g. "**/*.ts", "src/**/*.py")
- **list_dir**: Explora la estructura de directorios
- **file_read**: Lee el contenido de archivos
- **file_edit**: Edita archivos con reemplazos exactos de texto — PREFERIDO sobre file_write para cambios
- **file_write**: Crea archivos nuevos o reescribe completos
- **shell_exec**: Ejecuta comandos de terminal (npm, git, tests, builds, etc.)

FLUJO DE TRABAJO para cambios de código:
1. **Entiende primero**: Usa grep/glob/list_dir para explorar el codebase
2. **Lee antes de editar**: SIEMPRE usa file_read antes de file_edit (necesitas el texto exacto)
3. **Edita con file_edit**: Cambios quirúrgicos, no reescrituras completas
4. **Verifica**: Ejecuta tests/linters con shell_exec después de cambios
5. **Reporta**: Muestra qué cambió y el resultado de la verificación

REGLAS de código:
- NUNCA adivines el contenido de un archivo — léelo primero
- Usa file_edit para cambios en archivos existentes (no file_write)
- Ejecuta tests después de cambios: shell_exec con el comando de test del proyecto
- Si un test falla, analiza el error y corrige — no te rindas
- Haz cambios mínimos y enfocados — no refactorices código que no se pidió cambiar`);
  }

  // --- Browser navigation (ONLY when browser tools are available) ---
  if (hasBrowser) {
    sections.push(`## Navegación web avanzada
Tienes un navegador completo (browser__*) para:
- Verificar sitios web después de cambios (browser__goto + browser__markdown)
- Interactuar con páginas: clic, formularios, scroll (browser__click, browser__fill, browser__scroll)
- Extraer datos estructurados (browser__structuredData)
Para lectura simple, web_read es más rápido. Usa browser__* cuando necesites JavaScript o interacción.`);
  }

  // --- User facts and enrichment ---
  let prompt = sections.join("\n\n");
  prompt += userFactsBlock;
  prompt += enrichmentBlock;

  return prompt;
}

/**
 * Scope tools to only groups relevant to the current conversation context.
 * Scans the current message + last 3 conversation turns for keyword signals.
 * Always includes core + COMMIT read + misc. Activates other groups on demand.
 *
 * Typical reduction: 49 → 15-25 tools = ~5-8K fewer tokens.
 */
function scopeToolsForMessage(
  currentMessage: string,
  conversationHistory: ConversationTurn[],
): string[] {
  // Scan current message + last 3 user turns for scoping keywords.
  // This ensures follow-up commands ("Hazlo", "Adelante", "Sí") inherit
  // tool scope from the conversation context they refer to.
  const recentUserTurns = conversationHistory
    .filter((t) => t.role === "user")
    .slice(-3)
    .map((t) => t.content)
    .join(" ");
  const contextText = `${currentMessage} ${recentUserTurns}`;

  // Detect which groups are needed
  const activeGroups = new Set<string>();
  for (const { pattern, group } of SCOPE_PATTERNS) {
    if (pattern.test(contextText)) {
      activeGroups.add(group);
    }
  }

  // Assemble scoped tool list
  const tools = [...CORE_TOOLS, ...COMMIT_READ_TOOLS, ...MISC_TOOLS];

  if (activeGroups.has("commit_write")) {
    tools.push(...COMMIT_WRITE_TOOLS);
  }
  if (activeGroups.has("commit_destructive")) {
    tools.push(...COMMIT_DESTRUCTIVE_TOOLS);
  }
  if (activeGroups.has("schedule")) {
    tools.push(...SCHEDULE_TOOLS);
  }
  if (activeGroups.has("google") && process.env.GOOGLE_CLIENT_ID) {
    tools.push(...GOOGLE_TOOLS);
  }
  if (activeGroups.has("browser")) {
    tools.push(...BROWSER_TOOLS);
  }
  if (activeGroups.has("coding")) {
    tools.push(...CODING_TOOLS);
  }
  if (activeGroups.has("wordpress") && process.env.WP_SITES) {
    tools.push(...WORDPRESS_TOOLS);
  }

  // Memory tools (always if available — lightweight)
  if (getMemoryService().backend === "hindsight") {
    tools.push("memory_search", "memory_store");
  }

  const scopedCount = tools.length;
  const fullCount =
    CORE_TOOLS.length +
    COMMIT_READ_TOOLS.length +
    COMMIT_WRITE_TOOLS.length +
    COMMIT_DESTRUCTIVE_TOOLS.length +
    SCHEDULE_TOOLS.length +
    MISC_TOOLS.length +
    BROWSER_TOOLS.length +
    CODING_TOOLS.length +
    (process.env.GOOGLE_CLIENT_ID ? GOOGLE_TOOLS.length : 0) +
    (process.env.WP_SITES ? WORDPRESS_TOOLS.length : 0) +
    2; // memory
  console.log(
    `[router] Tool scope: ${scopedCount}/${fullCount} tools (groups: ${[...activeGroups].join(", ") || "core-only"})`,
  );

  return tools;
}

interface PendingReply {
  channel: ChannelName;
  to: string;
  originalText: string;
  interimTimer: ReturnType<typeof setTimeout>;
  finalTimer: ReturnType<typeof setTimeout>;
}

/** In-memory ring buffer of recent exchanges per channel for thread continuity. */
const THREAD_BUFFER_SIZE = 15;
/** Max chars per Jarvis response stored in the thread buffer. */
const THREAD_RESPONSE_CAP = 2000;
const conversationThreads = new Map<string, string[]>();
const hydratedChannels = new Set<string>();

// ---------------------------------------------------------------------------
// Critical data persistence safety net
// ---------------------------------------------------------------------------

interface DetectedCredential {
  key: string;
  value: string;
}

/**
 * Scan user text for critical data patterns (API keys, IDs, credentials)
 * that should be persisted regardless of whether the LLM called user_fact_set.
 */
function detectCriticalData(text: string): DetectedCredential[] {
  const results: DetectedCredential[] = [];

  // Google API keys: AIzaSy...
  const googleApiKey = text.match(/\b(AIzaSy[A-Za-z0-9_-]{33})\b/);
  if (googleApiKey) {
    results.push({ key: "google_api_key", value: googleApiKey[1] });
  }

  // GA4 Measurement IDs: G-XXXXXXXXXX (with or without G- prefix)
  const ga4Full = text.match(/\b(G-[A-Z0-9]{8,12})\b/);
  if (ga4Full) {
    results.push({ key: "ga4_measurement_id", value: ga4Full[1] });
  }
  // Measurement/Msrmnt ID without G- prefix
  if (!ga4Full) {
    const ga4Labeled = text.match(
      /(?:m(?:e(?:asure)?)?s?rmnt|measurement)\s*id\s*[:\s]*([A-Z0-9]{8,12})\b/i,
    );
    if (ga4Labeled) {
      results.push({
        key: "ga4_measurement_id",
        value: `G-${ga4Labeled[1]}`,
      });
    }
  }

  // GA4 Stream IDs: long numeric (10+ digits, preceded by "stream" context)
  const streamId = text.match(/(?:stream\s*(?:id)?)\s*[:\s]*(\d{10,15})/i);
  if (streamId) {
    results.push({ key: "ga4_stream_id", value: streamId[1] });
  }

  // Generic API keys/tokens: explicit label + value patterns
  const labeledSecret = text.match(
    /(?:api[_ ]?key|token|secret)\s*[:\s=]+\s*["']?([A-Za-z0-9_\-.]{20,})/i,
  );
  if (labeledSecret && !googleApiKey) {
    results.push({ key: "api_credential", value: labeledSecret[1] });
  }

  // Passwords: label + value (allows special chars)
  const labeledPassword = text.match(
    /(?:password|contraseña|pswd|pwd|pass)\s*[:\s=]+\s*["']?(\S{8,})/i,
  );
  if (labeledPassword) {
    results.push({ key: "password", value: labeledPassword[1] });
  }

  // Login/username: label + value
  const labeledLogin = text.match(
    /(?:login|user(?:name)?|usuario)\s*[:\s=]+\s*["']?(\S{3,})/i,
  );
  if (labeledLogin) {
    results.push({ key: "login", value: labeledLogin[1] });
  }

  // WP Application Passwords: 4-char groups separated by spaces (e.g. "BtZU tFsT EUhC l2z5 No4B F4aU")
  const wpAppPass = text.match(
    /(?:app(?:lication)?\s*pass(?:word)?|contraseña\s*de\s*aplicación)[^:=\n]*[:\s=]+\s*["']?([A-Za-z0-9]{4}(?:\s+[A-Za-z0-9]{4}){4,})/i,
  );
  if (wpAppPass) {
    results.push({ key: "wp_app_password", value: wpAppPass[1] });
  }

  // FTP host: ftp://... or sftp://...
  const ftpHost = text.match(
    /(?:ftp|sftp)\s*(?:host)?\s*[:\s=]*\s*((?:s?ftp:\/\/)?[\d.]+|(?:s?ftp:\/\/)?[\w.-]+\.\w{2,})/i,
  );
  if (ftpHost) {
    results.push({ key: "ftp_host", value: ftpHost[1] });
  }

  return results;
}

/**
 * Post-execution safety net: if user message contained critical data
 * and the LLM didn't call user_fact_set, auto-store it.
 */
function ensureCriticalDataPersisted(userText: string, taskId: string): void {
  const detected = detectCriticalData(userText);
  if (detected.length === 0) return;

  // Check if user_fact_set was called by this task
  try {
    const run = getDatabase()
      .prepare(
        "SELECT r.output FROM runs r WHERE r.task_id = ? ORDER BY r.created_at DESC LIMIT 1",
      )
      .get(taskId) as { output: string | null } | undefined;

    let toolCalls: string[] = [];
    if (run?.output) {
      try {
        const parsed = JSON.parse(run.output);
        toolCalls = parsed.toolCalls ?? [];
      } catch {
        /* bare string output — no tools */
      }
    }

    if (toolCalls.includes("user_fact_set")) return; // LLM already stored it

    // Auto-store detected credentials
    for (const cred of detected) {
      setUserFact("projects", cred.key, cred.value, "auto-detected");
      console.log(
        `[router] Auto-persisted critical data: projects/${cred.key} (LLM missed user_fact_set)`,
      );
    }
  } catch (err) {
    console.error(`[router] Critical data persistence check failed: ${err}`);
  }
}

function pushToThread(channel: string, exchange: string): void {
  hydrateThreadIfNeeded(channel);
  const thread = conversationThreads.get(channel)!;
  thread.push(exchange);
  if (thread.length > THREAD_BUFFER_SIZE) thread.shift();
}

/**
 * Parse stored exchanges ("User: ...\nJarvis: ...") into structured turns.
 * Returns ConversationTurn[] for injection as proper message turns in inference.
 */
function getThreadTurns(channel: string): ConversationTurn[] {
  hydrateThreadIfNeeded(channel);
  const thread = conversationThreads.get(channel);
  if (!thread || thread.length === 0) return [];

  const turns: ConversationTurn[] = [];
  for (const exchange of thread) {
    const jarvisIdx = exchange.indexOf("\nJarvis: ");
    if (jarvisIdx === -1) continue;

    const userText = exchange.slice("User: ".length, jarvisIdx).trim();
    const assistantText = exchange
      .slice(jarvisIdx + "\nJarvis: ".length)
      .trim();
    if (userText) turns.push({ role: "user", content: userText });
    if (assistantText)
      turns.push({ role: "assistant", content: assistantText });
  }
  return turns;
}

/**
 * On first access per channel, hydrate the thread buffer from SQLite conversations.
 * This ensures conversation continuity survives process restarts.
 */
function hydrateThreadIfNeeded(channel: string): void {
  if (hydratedChannels.has(channel)) return;
  hydratedChannels.add(channel);

  try {
    const db = getDatabase();
    const rows = db
      .prepare(
        `SELECT content FROM conversations
         WHERE bank = 'mc-jarvis'
         AND EXISTS (SELECT 1 FROM json_each(tags) je WHERE je.value = ?)
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(channel, THREAD_BUFFER_SIZE) as { content: string }[];

    if (rows.length > 0) {
      // Reverse to chronological order (query returns newest-first)
      const thread = rows.reverse().map((r) => r.content);
      conversationThreads.set(channel, thread);
    } else {
      conversationThreads.set(channel, []);
    }
  } catch {
    conversationThreads.set(channel, []);
  }
}

export class MessageRouter {
  private channels = new Map<ChannelName, ChannelAdapter>();
  private pendingReplies = new Map<string, PendingReply>();
  private subscriptions: Array<{ unsubscribe: () => void }> = [];
  private ritualWatches = new Map<string, string>(); // taskId → ritualId
  private lastMessageTime = 0;

  get channelCount(): number {
    return this.channels.size;
  }

  /** Timestamp of the last inbound message (for proactive throttle). */
  getLastMessageTime(): number {
    return this.lastMessageTime;
  }

  registerChannel(adapter: ChannelAdapter): void {
    this.channels.set(adapter.name, adapter);

    adapter.onMessage((msg) => {
      this.handleInbound(msg).catch((err) => {
        console.error(
          `[router] Failed to handle inbound from ${msg.channel}:`,
          err,
        );
      });
    });
  }

  /** Start listening for task completion/failure events. */
  startEventListeners(): void {
    const bus = getEventBus();

    const completedSub = bus.subscribe(
      "task.completed",
      (event: Event<"task.completed">) => {
        this.handleTaskCompleted(event.data);
      },
    );

    const failedSub = bus.subscribe(
      "task.failed",
      (event: Event<"task.failed">) => {
        this.handleTaskFailed(event.data);
      },
    );

    this.subscriptions.push(completedSub, failedSub);
  }

  /** Handle an inbound message from any channel → create task. */
  async handleInbound(msg: IncomingMessage): Promise<void> {
    this.lastMessageTime = Date.now();

    // Check if this message is feedback for a recently completed task
    const feedbackTaskId = checkFeedbackWindow(msg.channel);
    if (feedbackTaskId) {
      const signal = detectFeedbackSignal(msg.text);
      if (signal !== "neutral") {
        recordTaskFeedback(feedbackTaskId, signal);
      }

      // Pure feedback ("gracias", "perfecto", "no") → ack and skip task creation
      if (isFeedbackMessage(msg.text)) {
        if (signal === "positive") {
          this.sendToChannel(msg.channel, msg.from, "👍");
        } else if (signal === "negative") {
          this.sendToChannel(
            msg.channel,
            msg.from,
            "Entendido, lo tendré en cuenta. ¿Puedes darme más detalle?",
          );
        }
        console.log(
          `[router] Feedback intercepted from ${msg.channel}: ${signal}`,
        );
        return;
      }
    }

    // Immediate acknowledgment so the user knows the agent is listening
    this.sendToChannel(
      msg.channel,
      msg.from,
      "Recibido, trabajando en ello...",
    );

    const titleText =
      msg.text.length > 60 ? msg.text.slice(0, 60) + "..." : msg.text;

    // Build structured conversation turns from in-memory thread buffer.
    // The current user message is appended as the final turn so the fast runner
    // can send it as a proper user message rather than embedding it in the description.
    const conversationHistory = getThreadTurns(msg.channel);
    conversationHistory.push({
      role: "user",
      content: msg.text,
      ...(msg.imageUrl && { imageUrl: msg.imageUrl }),
    });

    // Recall semantic memories + enrich context IN PARALLEL
    const enrichment = await enrichContext(msg.text, msg.channel);

    // User profile facts — always injected so the LLM never forgets personal context
    let userFactsBlock = "";
    try {
      userFactsBlock = formatUserFactsBlock();
    } catch {
      // Non-fatal — DB may not have the table yet
    }

    // Dynamic tool scoping — only include tool groups relevant to the conversation
    const tools = scopeToolsForMessage(msg.text, conversationHistory);

    // Current date/time in Mexico City for the LLM
    const mxDate = nowMexDate();
    const mxTime = nowMexTime();

    // Build system prompt with conditional sections based on scoped tools
    const systemPrompt = buildJarvisSystemPrompt(
      mxDate,
      mxTime,
      tools,
      userFactsBlock,
      enrichment.contextBlock,
    );

    const result = await submitTask({
      title: `Chat: ${titleText}`,
      description: systemPrompt,
      agentType: "auto",
      tools,
      conversationHistory,
      tags: [
        "messaging",
        msg.channel,
        ...enrichment.matchedSkillIds.map((id) => `skill:${id}`),
      ],
    });

    // Track pending reply
    const interimTimer = setTimeout(() => {
      this.sendToChannel(msg.channel, msg.from, "Sigo trabajando en eso...");
    }, TASK_TIMEOUT_INTERIM_MS);

    const finalTimer = setTimeout(() => {
      const pending = this.pendingReplies.get(result.taskId);
      if (pending) {
        this.pendingReplies.delete(result.taskId);
        this.sendToChannel(
          msg.channel,
          msg.from,
          "Se agotó el tiempo. Revisa el dashboard para más detalles.",
        );
      }
    }, TASK_TIMEOUT_FINAL_MS);

    this.pendingReplies.set(result.taskId, {
      channel: msg.channel,
      to: msg.from,
      originalText: msg.text,
      interimTimer,
      finalTimer,
    });

    console.log(
      `[router] Inbound from ${msg.channel} → task ${result.taskId} (${result.agentType})`,
    );
  }

  /** Watch a ritual task for completion → broadcast result to all channels. */
  watchRitualTask(taskId: string, ritualId: string): void {
    this.ritualWatches.set(taskId, ritualId);
  }

  /** Broadcast a message to all active channels. */
  async broadcastToAll(text: string): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const [name, adapter] of this.channels) {
      const to = this.getOwnerAddress(name);
      if (to) {
        promises.push(
          adapter
            .send({ channel: name, to, text })
            .then(() => undefined)
            .catch((err) => {
              console.error(`[router] Broadcast to ${name} failed:`, err);
            }),
        );
      }
    }

    await Promise.all(promises);
  }

  async stopAll(): Promise<void> {
    // Clear feedback windows
    clearAllFeedbackWindows();

    // Clear event subscriptions
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions = [];

    // Clear pending timers
    for (const pending of this.pendingReplies.values()) {
      clearTimeout(pending.interimTimer);
      clearTimeout(pending.finalTimer);
    }
    this.pendingReplies.clear();

    // Stop channels
    for (const adapter of this.channels.values()) {
      await adapter.stop();
    }
    this.channels.clear();
  }

  // --------------------------------------------------------------------------
  // Private handlers
  // --------------------------------------------------------------------------

  private handleTaskCompleted(data: TaskCompletedPayload): void {
    const taskId = data.task_id;

    // Check if it's a ritual task → broadcast
    const ritualId = this.ritualWatches.get(taskId);
    if (ritualId) {
      this.ritualWatches.delete(taskId);
      const resultText = this.extractResultText(data.result);
      if (resultText) {
        this.broadcastToAll(resultText).catch((err) => {
          console.error(`[router] Ritual broadcast failed:`, err);
        });
      }
      return;
    }

    // Check if it's a proactive scan → conditionally broadcast
    if (isProactiveTask(taskId)) {
      const resultText = this.extractResultText(data.result);
      handleProactiveResult(taskId, resultText ?? "");
      return;
    }

    // Check if it's a scheduled task → verify delivery + broadcast
    if (isScheduledTask(taskId)) {
      const resultText = this.extractResultText(data.result);
      // Extract task status and tool calls from the DB for delivery verification
      const task = getDatabase()
        .prepare(
          "SELECT t.status, r.output FROM tasks t LEFT JOIN runs r ON r.task_id = t.task_id WHERE t.task_id = ? ORDER BY r.created_at DESC LIMIT 1",
        )
        .get(taskId) as { status: string; output: string | null } | undefined;
      let toolCalls: string[] | undefined;
      if (task?.output) {
        try {
          const parsed = JSON.parse(task.output);
          toolCalls = parsed.toolCalls;
        } catch {
          /* ignore */
        }
      }
      handleScheduledTaskResult(
        taskId,
        resultText ?? "",
        task?.status,
        toolCalls,
      );
      return;
    }

    // Check if it's a chat reply
    const pending = this.pendingReplies.get(taskId);
    if (!pending) return;

    clearTimeout(pending.interimTimer);
    clearTimeout(pending.finalTimer);
    this.pendingReplies.delete(taskId);

    const resultText = this.extractResultText(data.result);
    if (resultText) {
      this.sendToChannel(pending.channel, pending.to, resultText);

      // Push to in-memory conversation thread (chronological, instant)
      const cappedResult =
        resultText.length > THREAD_RESPONSE_CAP
          ? resultText.slice(0, THREAD_RESPONSE_CAP) + "..."
          : resultText;
      pushToThread(
        pending.channel,
        `User: ${pending.originalText}\nJarvis: ${cappedResult}`,
      );

      // Retain the exchange in conversation memory (works with any backend)
      try {
        const exchange = `User: ${pending.originalText}\nJarvis: ${resultText}`;
        getMemoryService()
          .retain(exchange, {
            bank: "mc-jarvis",
            tags: [pending.channel, "conversation"],
            async: true,
          })
          .catch(() => {});
      } catch {
        // Non-fatal
      }

      // Safety net: auto-persist critical data the LLM may have ignored
      try {
        ensureCriticalDataPersisted(pending.originalText, taskId);
      } catch {
        // Non-fatal
      }

      // Track outcome for adaptive intelligence
      trackTaskOutcome(taskId, data.duration_ms, true, pending.channel);
    }
  }

  private handleTaskFailed(data: TaskFailedPayload): void {
    const taskId = data.task_id;

    // Clean up ritual watches
    this.ritualWatches.delete(taskId);

    // Alert on scheduled task failures
    if (isScheduledTask(taskId)) {
      handleScheduledTaskFailure(taskId, data.error ?? "Unknown error");
    }

    const pending = this.pendingReplies.get(taskId);
    if (!pending) return;

    clearTimeout(pending.interimTimer);
    clearTimeout(pending.finalTimer);
    this.pendingReplies.delete(taskId);

    this.sendToChannel(
      pending.channel,
      pending.to,
      "No pude completar eso. Revisa el dashboard para más detalles.",
    );

    // Track failed outcome
    trackTaskOutcome(taskId, 0, false, pending.channel);
  }

  private sendToChannel(channel: ChannelName, to: string, text: string): void {
    const adapter = this.channels.get(channel);
    if (!adapter) return;

    const msg: OutgoingMessage = { channel, to, text };
    adapter.send(msg).catch((err) => {
      console.error(`[router] Send to ${channel} failed:`, err);
    });
  }

  private extractResultText(result: unknown): string | null {
    let text: string | null = null;

    if (typeof result === "string") {
      // Try to parse JSON strings that wrap a { text } object (fast-runner output)
      if (result.startsWith("{")) {
        try {
          const parsed = JSON.parse(result);
          if (typeof parsed.text === "string") {
            text = parsed.text;
          }
        } catch {
          // Not JSON — return as-is
        }
      }
      if (text === null) text = result;
    } else if (result && typeof result === "object") {
      const obj = result as Record<string, unknown>;
      if (typeof obj.text === "string") text = obj.text;
      else if (typeof obj.output === "string") text = obj.output;
      else if (typeof obj.result === "string") text = obj.result;
      else if (typeof obj.content === "string") text = obj.content;
      else text = JSON.stringify(result);
    }

    // Strip CJK characters that leak from Qwen model responses
    if (text) {
      text = text
        .replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/g, "")
        .trim();
    }

    return text || null;
  }

  private getOwnerAddress(channel: ChannelName): string | null {
    if (channel === "whatsapp") return process.env.WHATSAPP_OWNER_JID ?? null;
    if (channel === "telegram")
      return process.env.TELEGRAM_OWNER_CHAT_ID ?? null;
    return null;
  }
}
