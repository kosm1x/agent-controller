/**
 * Smoke: verify jarvis_file_delete is now in scope for delete intents on
 * NorthStar nouns. Does NOT actually delete anything — just checks tools
 * produced by the scope pipeline.
 */

import {
  scopeToolsForMessage,
  DEFAULT_SCOPE_PATTERNS,
} from "../src/messaging/scope.js";

const cases = [
  "elimina la tarea de prueba",
  "borra esa meta que ya no aplica",
  "quita el objetivo de Q2 por favor",
  "delete that task from my list",
  "remove goal A",
  "esa meta ya no sirve, elimínala",
  "ese objetivo está obsoleto, bórralo",
  // Negative controls (must NOT pull the delete tool):
  "me regalas un poema de Rumi",
  "hola Jarvis",
];

const OPTS = {
  hasGoogle: true,
  hasWordpress: false,
  hasMemory: true,
  hasCrm: false,
};

console.log("--- regex-fallback path ---");
for (const msg of cases) {
  const tools = scopeToolsForMessage(msg, [], DEFAULT_SCOPE_PATTERNS, OPTS);
  const hasDelete = tools.includes("jarvis_file_delete");
  console.log(`${hasDelete ? "DELETE" : "-----"}  ${msg}`);
}

console.log("\n--- classifier path (simulating LLM output) ---");
const classifierCases: [string, string[]][] = [
  ["elimina la tarea de prueba", ["destructive", "northstar_read"]],
  ["borra esa meta que ya no aplica", ["destructive", "northstar_read"]],
  ["borra esta imagen", ["destructive"]],
  ["elimínala", []], // classifier returns empty, needs referential inheritance
];
for (const [msg, groups] of classifierCases) {
  const tools = scopeToolsForMessage(
    msg,
    [],
    DEFAULT_SCOPE_PATTERNS,
    OPTS,
    new Set(groups),
  );
  const hasDelete = tools.includes("jarvis_file_delete");
  console.log(
    `${hasDelete ? "DELETE" : "-----"}  [${groups.join(",")}]  ${msg}`,
  );
}
