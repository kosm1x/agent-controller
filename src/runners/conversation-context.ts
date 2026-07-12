/**
 * Render RunnerInput.conversationHistory for runners that build a single
 * text prompt (nanoclaw / heavy / swarm).
 *
 * The router's chat contract packs the CURRENT user message as the LAST
 * user turn of conversationHistory (see fast-runner.ts:743) — fast-runner
 * consumes it, but the prompt-blob runners historically read only
 * `title + description`, where the instruction survives as a 60-char
 * truncated title and the description is the persona/context blob.
 * Consequence (2026-07-12, task 7416): a nanoclaw-routed chat agent
 * received an unactionable prompt ("instruction was truncated, names no
 * concrete protocol") while the operator's full message sat unread in
 * conversationHistory.
 *
 * Absent/empty history renders "" — non-chat tasks (rituals, API tasks,
 * swarm subtasks) carry the full instruction in `description` and their
 * prompts are byte-identical to before.
 */
import type { ConversationTurn } from "./types.js";

export function renderConversationContext(
  history: ConversationTurn[] | undefined,
): string {
  if (!history || history.length === 0) return "";
  const lines = history.map(
    (t) => `${t.role === "user" ? "Usuario" : "Jarvis"}: ${t.content}`,
  );
  return (
    "\n\n## Conversación del hilo\n" +
    "(el ÚLTIMO mensaje del Usuario es la instrucción vigente — el título de la tarea puede estar truncado)\n\n" +
    lines.join("\n")
  );
}
