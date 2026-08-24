/**
 * Thread pins — Phase 4.1/2.3 of docs/planning/jarvis-usability-plan-2026-08-22.md
 * ("Continuity and recovery").
 *
 * The 2026-08-22 review found Jarvis forgetting its own work inside one
 * thread: a P&L it computed was gone 2 turns later (#11954), the demo it
 * built that morning was "not built" (#12384). The thread BUFFER carries
 * raw exchanges but they compete with 14 other turns for attention; a pin
 * is a distilled fact injected FIRST in every subsequent turn.
 *
 * Pinned:
 *  - every URL that appears in an exchange (Jarvis-created previews,
 *    user-shared links) — the "built today" ledger;
 *  - figures the OPERATOR explicitly confirmed ("Confirmo", "ok con esos
 *    números") — extracted from the assistant reply being confirmed with
 *    the P3 claim detector.
 *
 * 2.3: confirmed figures also bind to each subsequently submitted task
 * (`bindTaskConfirmedFigures`), and `declareReadbackGate` embeds them in
 * the read-back payload so the Sheets/Docs verifier can fail a write that
 * CONTRADICTS what the operator confirmed — not just one that differs from
 * what the model claims it wrote.
 *
 * In-memory, same lifecycle model as the thread buffer (a restart clears
 * pins along with the buffer they distill — consistent, not durable).
 */

import { extractFigures } from "../lib/v8-4/numbers.js";

export interface ThreadPin {
  kind: "url" | "figure";
  /** URL, or the figure's raw text (`$1.2M`, `34%`). */
  value: string;
  /** For figures: the reply line the figure came from (its label). */
  label?: string;
  ts: number;
}

export interface ConfirmedFigure {
  raw: string;
  label: string;
}

/** Pins ride along for a day — the "built today" ledger horizon. */
export const PIN_TTL_MS = 24 * 60 * 60 * 1000;
/** Newest-wins cap PER KIND per thread. Separate caps so a URL-heavy day
 *  can never evict the confirmed figures the 2.3 gate depends on (R1 audit
 *  W6). */
export const PIN_CAP = 12;
/** Task bindings expire with the pin horizon. */
const TASK_TTL_MS = PIN_TTL_MS;

const pinsByThread = new Map<string, ThreadPin[]>();
const confirmedByTask = new Map<
  string,
  { figures: ConfirmedFigure[]; ts: number }
>();

/** Operator confirmation of the previous reply's numbers (plan 2.3:
 *  `Confirmo`, `ok con esos números`). Anchored to the message START — a
 *  passing "ok" later in a long message is not a confirmation. */
export const CONFIRM_RE =
  /^\s*(confirmo|confirmado|correcto|exacto|así es|asi es|de acuerdo|ok con es[oa]s (números|numeros|cifras|datos)|me parece bien|está bien así|esta bien asi)\b/i;

const URL_RE = /https?:\/\/[^\s)>\]"'«»]+/g;

function prune(tk: string, now: number): ThreadPin[] {
  const pins = (pinsByThread.get(tk) ?? []).filter(
    (p) => now - p.ts <= PIN_TTL_MS,
  );
  // A long-lived daemon must not keep one empty array per sender forever
  // (R1 audit R3): drop the key when nothing survives.
  if (pins.length === 0) {
    pinsByThread.delete(tk);
  } else {
    pinsByThread.set(tk, pins);
  }
  return pins;
}

function addPin(tk: string, pin: ThreadPin): void {
  // Global opportunistic sweep (R2 audit W5): prune() only cleans the key
  // it touches; without this, one empty entry per past sender survives
  // until restart. Mirrors the sweep in bindTaskConfirmedFigures.
  for (const [key, list] of pinsByThread) {
    if (key !== tk && list.every((p) => pin.ts - p.ts > PIN_TTL_MS)) {
      pinsByThread.delete(key);
    }
  }
  const pins = prune(tk, pin.ts);
  const existing = pins.findIndex(
    (p) => p.kind === pin.kind && p.value === pin.value,
  );
  if (existing >= 0) pins.splice(existing, 1); // refresh: newest wins
  pins.push(pin);
  // Per-kind cap: evict the oldest pin of THIS kind only, so URLs can
  // never crowd out confirmed figures (R1 audit W6).
  const ofKind = pins.filter((p) => p.kind === pin.kind);
  if (ofKind.length > PIN_CAP) {
    const oldest = pins.findIndex((p) => p.kind === pin.kind);
    if (oldest >= 0) pins.splice(oldest, 1);
  }
  pinsByThread.set(tk, pins);
}

/** Capture pins from a completed exchange ("User: …\nJarvis: …"). Called
 *  from pushToThread — the single seam every delivered exchange crosses. */
export function pinFromExchange(
  tk: string,
  exchange: string,
  now: number = Date.now(),
): void {
  for (const url of exchange.match(URL_RE) ?? []) {
    // Trailing punctuation is sentence syntax, not the URL.
    addPin(tk, { kind: "url", value: url.replace(/[.,;:!?]+$/, ""), ts: now });
  }
}

/** When the operator's message confirms the previous reply, pin that
 *  reply's figures. Returns how many were pinned (0 = not a confirmation
 *  or nothing to pin). */
export function pinConfirmedFigures(
  tk: string,
  userText: string,
  lastAssistantText: string | undefined,
  now: number = Date.now(),
): number {
  if (!lastAssistantText || !CONFIRM_RE.test(userText)) return 0;
  const figures = extractFigures(lastAssistantText);
  let pinned = 0;
  for (const fig of figures) {
    const lineStart = lastAssistantText.lastIndexOf("\n", fig.index) + 1;
    const lineEnd = lastAssistantText.indexOf("\n", fig.index);
    const label = lastAssistantText
      .slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
      .trim()
      .slice(0, 120);
    addPin(tk, { kind: "figure", value: fig.raw, label, ts: now });
    pinned++;
  }
  return pinned;
}

export function getPins(tk: string, now: number = Date.now()): ThreadPin[] {
  return prune(tk, now);
}

/** The prompt block injected FIRST among the variable-half additions of
 *  every turn in this thread. Empty string when nothing is pinned. */
export function pinnedThreadSection(
  tk: string,
  now: number = Date.now(),
): string {
  const pins = prune(tk, now);
  if (pins.length === 0) return "";
  const lines: string[] = [
    "## FIJADO EN ESTE HILO (hecho/confirmado hoy — no lo contradigas ni lo reportes como inexistente)",
  ];
  for (const p of pins) {
    if (p.kind === "url") {
      lines.push(`- URL creada o compartida en este hilo: ${p.value}`);
    } else {
      lines.push(
        `- Cifra CONFIRMADA por el usuario: ${p.value}${p.label ? ` — «${p.label}»` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

/** 2.3: bind the thread's currently confirmed figures to a task, so the
 *  read-back verifier can diff a Sheets/Docs write against them. */
export function bindTaskConfirmedFigures(
  taskId: string,
  tk: string,
  now: number = Date.now(),
): void {
  const figures = prune(tk, now)
    .filter((p) => p.kind === "figure")
    .map((p) => ({ raw: p.value, label: p.label ?? "" }));
  // Sweep expired bindings opportunistically — the map must not grow with
  // every task in a long-lived daemon.
  for (const [id, entry] of confirmedByTask) {
    if (now - entry.ts > TASK_TTL_MS) confirmedByTask.delete(id);
  }
  if (figures.length === 0) return;
  confirmedByTask.set(taskId, { figures, ts: now });
}

export function getTaskConfirmedFigures(
  taskId: string,
  now: number = Date.now(),
): ConfirmedFigure[] {
  const entry = confirmedByTask.get(taskId);
  if (!entry || now - entry.ts > TASK_TTL_MS) return [];
  return entry.figures;
}

/** 2.3 mismatch predicate — deliberately CONSERVATIVE. A written text
 *  contradicts a confirmed figure only when:
 *   1. the confirmed raw value does NOT appear in the text, and
 *   2. a distinctive word (≥5 chars) from the confirmed figure's label
 *      appears on a line of the text, and
 *   3. that same line carries some other number.
 *  Anything short of all three is not a contradiction (different sheet,
 *  different topic, label absent) — the gate must fail only on the #11959
 *  class: the confirmed model's own line rewritten with a different value. */
export function confirmedMismatch(
  text: string,
  confirmed: ConfirmedFigure[],
): { figure: ConfirmedFigure; line: string } | null {
  if (!text || confirmed.length === 0) return null;
  const lines = text.split(/\r?\n/);
  for (const fig of confirmed) {
    const digits = fig.raw.replace(/[^\d.,]/g, "");
    if (digits.length === 0) continue;
    if (text.includes(digits)) continue; // the confirmed value is present
    const labelTokens = fig.label
      .toLowerCase()
      .split(/[^a-záéíóúüñ0-9]+/i)
      .filter((w) => w.length >= 5 && !/^\d+$/.test(w));
    if (labelTokens.length === 0) continue;
    for (const line of lines) {
      const lower = line.toLowerCase();
      if (!labelTokens.some((t) => lower.includes(t))) continue;
      if (/\d/.test(line) && !line.includes(digits)) {
        return { figure: fig, line: line.trim().slice(0, 120) };
      }
    }
  }
  return null;
}

/** Test-only. */
export function _resetThreadPins(): void {
  pinsByThread.clear();
  confirmedByTask.clear();
}

/** Test-only: live key count — the sweep's observable (R3 audit W1: the
 *  first sweep test asserted through getPins, whose own prune made it pass
 *  with the sweep deleted). */
export function _threadPinKeyCount(): number {
  return pinsByThread.size;
}
