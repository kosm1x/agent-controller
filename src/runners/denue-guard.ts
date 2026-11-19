/**
 * When the fast runner's DENUE guard fires and which variant it gets: the
 * text the check reads (only what the user or the schedule author wrote,
 * without an attached file's extracted text), the literal DENUE-mention test,
 * and the choice between the full recipe, the advisory and no guard. The
 * guard messages themselves stay in the fast runner.
 *
 * Pure functions over their arguments, with no runner state. It imports only
 * the extracted-file marker and must never import the fast runner, which
 * imports these names and re-exports them for its existing callers.
 */

import { EXTRACTED_FILE_MARKER } from "../messaging/extracted-file.js";

/**
 * Pick which DENUE high-stakes guard message variant to inject. When neither
 * `shell_exec` nor `http_fetch` are scoped, the long routing recipe is useless
 * and Jarvis thrashes via browser/web_read alternatives that can't pass auth
 * headers. The "advisory" variant tells him to ask the operator to reformulate
 * with an explicit shell/coding signal instead of attempting a partial answer
 * from training data. See feedback_jarvis_kb_directive_loading.md for the
 * 2026-05-06 incident chain that drove this fix.
 */
/**
 * Text the DENUE guard is evaluated on: only what the user (or the schedule
 * author) wrote. `detectionText` first — the router sets it to the full,
 * untruncated inbound message, dynamic schedules to the schedule's own
 * prompt; else the last user turn; else title+description (rituals and other
 * system-authored tasks, whose description IS their prompt). A chat's
 * description is persona + injected context (`## Proyectos activos` names
 * DENUE — the guard fired on ~100 % of chat turns from 2026-09-10) and a
 * schedule's carries the run-time sent-before block, so neither may count.
 */
export function denueGuardText(input: {
  title: string;
  description: string;
  detectionText?: string;
  conversationHistory?: readonly { role: string; content: string }[];
}): string {
  if (input.detectionText !== undefined)
    return withoutExtractedFile(input.detectionText);
  const lastUser = [...(input.conversationHistory ?? [])]
    .reverse()
    .find((t) => t.role === "user");
  return lastUser
    ? withoutExtractedFile(lastUser.content)
    : `${input.title}\n${input.description}`;
}

/**
 * Telegram appends an attached document's extracted text to the caption
 * after `EXTRACTED_FILE_MARKER` (`src/messaging/channels/telegram.ts`,
 * `contentBlock`): file content, not the user's words, so the DENUE check
 * stops there. A voice note's `Transcripción:` block IS the user's words and
 * is kept.
 */
function withoutExtractedFile(text: string): string {
  const at = text.indexOf(EXTRACTED_FILE_MARKER);
  return at === -1 ? text : text.slice(0, at);
}

/**
 * Operator rule (2026-09-29): "if I don't mention DENUE, the analyzer is not
 * activated." The guard fires on a literal DENUE mention only — not on the
 * classifier's broader high-stakes list (oportunidades, top N, scoring…),
 * which still drives model tier. A follow-up turn that does not repeat the
 * word gets no guard.
 */
export function mentionsDenue(text: string): boolean {
  // "denue" not preceded by a letter (denue_api, DENUEs, denue2026, #denue);
  // two or more letters after it make an ordinary Spanish word (denuevo,
  // denuedo, denuesto) while one plural `s` still counts. `redenue` and an
  // accented `denué` (either Unicode form) do not match.
  return /(?<!\p{L})denue(?!\p{M})(?!\p{L}{2})/iu.test(text);
}

/**
 * "none" for an external request (jarvis-pull), and for a non-interactive
 * task (scheduled, ritual) without either tool:
 * the advisory promises a router re-run that only interactive chat gets, so
 * there it just turned the task into a one-line failure (Pharma schedule,
 * 2026-09-29). `interactive` undefined counts as interactive.
 */
export function highStakesGuardVariant(
  tools: readonly string[] | undefined,
  interactive?: boolean,
  external?: boolean,
): "advisory" | "full" | "none" {
  // External caller (jarvis-pull): the advisory promises a router re-run
  // that never happens on that path.
  if (external) return "none";
  const hasShell = !!tools?.includes("shell_exec");
  const hasFetch = !!tools?.includes("http_fetch");
  if (hasShell || hasFetch) return "full";
  return interactive === false ? "none" : "advisory";
}
