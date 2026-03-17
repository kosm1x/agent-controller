/**
 * Message router — bridges messaging channels to the Agent Controller.
 *
 * Inbound: owner message → task via submitTask()
 * Outbound: task.completed/task.failed events → formatted reply to channel
 * Ritual: completed ritual tasks → broadcast to all active channels
 */

import { submitTask } from "../dispatch/dispatcher.js";
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
import {
  detectFeedbackSignal,
  isFeedbackMessage,
} from "../intelligence/feedback.js";
import {
  isProactiveTask,
  handleProactiveResult,
} from "../intelligence/proactive.js";

const TASK_TIMEOUT_INTERIM_MS = 120_000; // 2 min → "still working"
const TASK_TIMEOUT_FINAL_MS = 300_000; // 5 min → give up waiting

/** Core tools always available for chat tasks. */
const COMMIT_TOOLS = [
  "commit__get_daily_snapshot",
  "commit__get_hierarchy",
  "commit__list_tasks",
  "commit__list_goals",
  "commit__list_objectives",
  "commit__search_journal",
  "commit__list_ideas",
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
  "commit__delete_item",
  "commit__bulk_reprioritize",
  "skill_save",
  "skill_list",
  "web_search",
];

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

interface PendingReply {
  channel: ChannelName;
  to: string;
  originalText: string;
  interimTimer: ReturnType<typeof setTimeout>;
  finalTimer: ReturnType<typeof setTimeout>;
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

    // Recall memories + enrich context IN PARALLEL (saves 200-400ms)
    const [memoriesBlock, enrichment] = await Promise.all([
      (async (): Promise<string> => {
        try {
          const memories = await getMemoryService().recall(msg.text, {
            bank: "mc-jarvis",
            tags: [msg.channel, "conversation"],
            maxResults: 10,
          });
          if (memories.length > 0) {
            return (
              "\n\n## Conversación reciente\n" +
              memories.map((m) => `- ${m.content}`).join("\n")
            );
          }
        } catch {
          // Non-fatal
        }
        return "";
      })(),
      enrichContext(msg.text, msg.channel),
    ]);

    const tools = [...COMMIT_TOOLS];
    if (getMemoryService().backend === "hindsight") {
      tools.push("memory_search", "memory_store");
    }
    if (process.env.GOOGLE_CLIENT_ID) {
      tools.push(...GOOGLE_TOOLS);
    }

    // Current date/time in Mexico City for the LLM
    const now = new Date();
    const mxDate = now.toLocaleDateString("es-MX", {
      timeZone: "America/Mexico_City",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const mxTime = now.toLocaleTimeString("es-MX", {
      timeZone: "America/Mexico_City",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });

    const result = await submitTask({
      title: `Chat: ${titleText}`,
      description: `Eres Jarvis, el asistente estratégico personal de Fede. Tu rol va más allá de gestionar tareas — eres un aliado inteligente que ayuda en TODO: investigación, decisiones, análisis, aprendizaje, productividad, y lo que Fede necesite. Responde de manera concisa, orientada a la acción, en español mexicano.

## Fecha y hora actual
Hoy es ${mxDate}, son las ${mxTime} (hora de la Ciudad de México). SIEMPRE usa esta fecha y hora como referencia. NO inventes ni adivines la fecha.

## Tus capacidades
- **COMMIT (productividad)**: Gestiona visiones, metas, objetivos y tareas con las herramientas commit__
- **Internet**: Usa web_search para buscar información actual, noticias, datos, investigación — SIEMPRE busca antes de adivinar
- **Memoria**: Recuerda conversaciones pasadas, aprende patrones, y guarda procedimientos como skills
- **Análisis**: Ayuda a tomar decisiones, evaluar opciones, analizar información

## Jerarquía COMMIT (NO confundas niveles)
- Visión = dirección de vida a largo plazo
- Meta/Goal = resultado medible bajo una visión
- Objetivo = hito específico bajo una meta
- Tarea = acción concreta bajo un objetivo

Cuando el usuario pregunte por "metas" o "goals", usa list_goals. NO presentes visiones como metas.
Usa el marco Eisenhower cuando priorices: Crítico (urgente+importante), Urgente, Importante, Delegable.

## Principios
- Si no sabes algo, BUSCA con web_search antes de responder
- Si completaste un proceso multi-paso útil, ofrece guardarlo como skill
- Sé proactivo: si notas algo relevante en los datos, menciónalo
- COMMIT es la base, pero el usuario puede pedir CUALQUIER cosa${enrichment.contextBlock}${memoriesBlock}

Mensaje del usuario:
${msg.text}`,
      agentType: "auto",
      tools,
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

    // Check if it's a chat reply
    const pending = this.pendingReplies.get(taskId);
    if (!pending) return;

    clearTimeout(pending.interimTimer);
    clearTimeout(pending.finalTimer);
    this.pendingReplies.delete(taskId);

    const resultText = this.extractResultText(data.result);
    if (resultText) {
      this.sendToChannel(pending.channel, pending.to, resultText);

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

      // Track outcome for adaptive intelligence
      trackTaskOutcome(taskId, data.duration_ms, true, pending.channel);
    }
  }

  private handleTaskFailed(data: TaskFailedPayload): void {
    const taskId = data.task_id;

    // Clean up ritual watches
    this.ritualWatches.delete(taskId);

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
    if (typeof result === "string") return result;
    if (result && typeof result === "object") {
      const obj = result as Record<string, unknown>;
      if (typeof obj.text === "string") return obj.text;
      if (typeof obj.output === "string") return obj.output;
      if (typeof obj.result === "string") return obj.result;
      if (typeof obj.content === "string") return obj.content;
      return JSON.stringify(result);
    }
    return null;
  }

  private getOwnerAddress(channel: ChannelName): string | null {
    if (channel === "whatsapp") return process.env.WHATSAPP_OWNER_JID ?? null;
    if (channel === "telegram")
      return process.env.TELEGRAM_OWNER_CHAT_ID ?? null;
    return null;
  }
}
