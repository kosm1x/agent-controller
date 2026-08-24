/**
 * `/rituales` — phone-side ritual control (usability plan Phase 5.5).
 *
 *   /rituales                      list active rituals + next fire (MX)
 *   /rituales pausa <n|nombre>     code ritual → ritual_controls.paused;
 *                                  schedule   → scheduled_tasks.active = 0
 *   /rituales reanuda <n|nombre>   the reverse
 *   /rituales silencio hasta <hora>  global mute: deliveries are deferred
 *                                  into the next Morning Sync, runs continue
 *   /rituales silencio off         clear the mute
 *
 * Numbers come from the listing (code rituals in config order, then DB
 * schedules by id) — stable unless a schedule is created in between; names
 * match by unique case/accent-insensitive prefix. Pure functions take `now`
 * so tests pin the clock.
 */

import { rituals as codeRituals, RITUALS_TIMEZONE } from "./config.js";
import { describeCron, formatFire, nextCronFire } from "./cron-next.js";
import { listSchedules, setScheduleActive, type ScheduledTaskRow } from "./dynamic.js";
import {
  GLOBAL_MUTE_ID,
  activeMuteUntil,
  getDeferral,
  isRitualPaused,
  pendingDeferrals,
  setMutedUntil,
  setRitualPaused,
} from "./ritual-controls.js";

export interface RitualEntry {
  n: number;
  id: string;
  kind: "ritual" | "schedule";
  name: string;
  cron: string;
  timezone: string;
  /** false = paused (code ritual) or inactive (schedule). */
  active: boolean;
  next: Date | null;
}

/** Inactive schedules older than this are history, not something to resume. */
const INACTIVE_SHOW_DAYS = 30;

function scheduleVisible(s: ScheduledTaskRow, now: Date): boolean {
  if (s.active === 1) return true;
  // Recently run OR recently created (R2 audit W4: a never-run schedule paused
  // from the phone must stay resumable from the phone).
  const stamp = s.last_run_at ?? s.created_at;
  if (!stamp) return false;
  const age = now.getTime() - Date.parse(stamp + "Z");
  return age <= INACTIVE_SHOW_DAYS * 86_400_000;
}

export function listRitualEntries(now = new Date()): RitualEntry[] {
  const out: RitualEntry[] = [];
  for (const r of codeRituals) {
    if (!r.enabled) continue;
    const tz = r.timezone ?? RITUALS_TIMEZONE;
    const active = !isRitualPaused(r.id);
    out.push({
      n: out.length + 1,
      id: r.id,
      kind: "ritual",
      name: r.title,
      cron: r.cron,
      timezone: tz,
      active,
      next: active ? nextCronFire(r.cron, now, tz) : null,
    });
  }
  // Active schedules first, then the recently-inactive ones — an inactive row
  // ageing out of the window only shifts the trailing numbers (R1 audit W7).
  const visible = listSchedules(false)
    .filter((s) => scheduleVisible(s, now))
    .sort((a, b) => (b.active - a.active) || a.id - b.id);
  for (const s of visible) {
    const active = s.active === 1;
    out.push({
      n: out.length + 1,
      id: s.schedule_id,
      kind: "schedule",
      name: s.name,
      cron: s.cron_expr,
      timezone: RITUALS_TIMEZONE,
      active,
      next: active ? nextCronFire(s.cron_expr, now, RITUALS_TIMEZONE) : null,
    });
  }
  return out;
}

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

export function findEntry(entries: RitualEntry[], target: string): RitualEntry | "ambiguous" | null {
  const t = target.trim();
  if (/^\d+$/.test(t)) return entries.find((e) => e.n === Number(t)) ?? null;
  const ft = fold(t);
  if (!ft) return null;
  // Prefix of the name/id, or of any word in the name ("posthumanismo"
  // finds "Transición al Posthumanismo — Reflexión").
  const hits = entries.filter((e) => {
    const name = fold(e.name);
    return (
      name.startsWith(ft) ||
      fold(e.id).startsWith(ft) ||
      name.split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(ft))
    );
  });
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    const exact = hits.filter((e) => fold(e.name) === ft || fold(e.id) === ft);
    return exact.length === 1 ? exact[0] : "ambiguous";
  }
  return null;
}

// --- time parsing -----------------------------------------------------------

function wallClock(at: Date, tz: string): { y: number; m: number; d: number; hh: number; mm: number } {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(at);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? "0");
  return { y: g("year"), m: g("month"), d: g("day"), hh: g("hour") % 24, mm: g("minute") };
}

/** The UTC instant of `hh:mm` on `at`'s wall-clock day in `tz` (+`dayOffset` days). */
export function zonedInstant(at: Date, tz: string, hh: number, mm: number, dayOffset = 0): Date {
  const w = wallClock(at, tz);
  const guess = Date.UTC(w.y, w.m - 1, w.d + dayOffset, hh, mm);
  const shown = wallClock(new Date(guess), tz);
  const shownUtc = Date.UTC(shown.y, shown.m - 1, shown.d, shown.hh, shown.mm);
  return new Date(guess + (guess - shownUtc));
}

/**
 * "15:00" · "15" · "3pm" · "3 pm" · "mañana" (= 06:00 next day, before the
 * first ritual). An hour at or before now rolls to tomorrow.
 */
export function parseUntil(raw: string, now: Date, tz = RITUALS_TIMEZONE): Date | null {
  const s = fold(raw).replace(/^(las?|el)\s+/, "");
  if (s === "manana") return zonedInstant(now, tz, 6, 0, 1);
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|h|hrs)?$/.exec(s);
  if (!m) return null;
  let hh = Number(m[1]);
  const mm = Number(m[2] ?? "0");
  if (m[3] === "pm" && hh < 12) hh += 12;
  if (m[3] === "am" && hh === 12) hh = 0;
  if (hh > 23 || mm > 59) return null;
  let at = zonedInstant(now, tz, hh, mm);
  if (at.getTime() <= now.getTime()) at = zonedInstant(now, tz, hh, mm, 1);
  return at;
}

// --- commands ---------------------------------------------------------------

export const RITUALES_RE = /^\/?rituales\b/i;

export type RitualesCommand =
  | { kind: "list" }
  | { kind: "pause"; target: string }
  | { kind: "resume"; target: string }
  | { kind: "mute"; until: string }
  | { kind: "unmute" }
  | { kind: "full"; id: number }
  | { kind: "help" };

export function parseRitualesCommand(text: string): RitualesCommand | null {
  const m = RITUALES_RE.exec(text.trim());
  if (!m) return null;
  const rest = text.trim().slice(m[0].length).trim();
  if (!rest) return { kind: "list" };
  let mm: RegExpExecArray | null;
  if ((mm = /^(?:pausa|pausar|pause)\s+(.+)$/i.exec(rest))) return { kind: "pause", target: mm[1] };
  if ((mm = /^(?:reanuda|reanudar|resume|activa|activar)\s+(.+)$/i.exec(rest)))
    return { kind: "resume", target: mm[1] };
  if ((mm = /^(?:completo|completa|full)\s+#?(\d+)\s*$/i.exec(rest))) return { kind: "full", id: Number(mm[1]) };
  if (/^silencio\s+(?:off|fin|quitar|no)\s*$/i.test(rest)) return { kind: "unmute" };
  if ((mm = /^silencio\s+(?:hasta\s+)?(.+)$/i.exec(rest))) return { kind: "mute", until: mm[1] };
  return { kind: "help" };
}

const HELP =
  "Comandos: /rituales · /rituales pausa <n> · /rituales reanuda <n> · /rituales silencio hasta <hora> · /rituales silencio off · /rituales completo <id>";

function fmtMx(at: Date): string {
  return formatFire(at, RITUALS_TIMEZONE);
}

export function renderList(entries: RitualEntry[], now = new Date()): string {
  const lines = entries.map((e) => {
    const when = e.kind === "ritual" && e.timezone !== RITUALS_TIMEZONE
      ? `${describeCron(e.cron)} ${e.timezone === "America/New_York" ? "NY" : e.timezone}`
      : describeCron(e.cron);
    const state = !e.active
      ? "PAUSADO"
      : e.next
        ? `→ ${fmtMx(e.next)}`
        : "→ sin próxima corrida";
    return `${e.n}. ${e.name} — ${when} ${state}`;
  });
  const mute = activeMuteUntil(GLOBAL_MUTE_ID, now);
  const head = "🗓 Rituales (hora MX)";
  const tail = mute ? `\n🔇 Silencio hasta ${fmtMx(new Date(mute))} — lo que llegue va al Morning Sync.` : "";
  const pending = pendingDeferrals();
  const queued =
    pending.length > 0
      ? `\n📬 Diferidos pendientes (${pending.length}): ${pending.map((d) => `${d.title} → /rituales completo ${d.id}`).join(" · ")}`
      : "";
  return `${head}\n${lines.join("\n")}${tail}${queued}\n\n${HELP}`;
}

/** Execute a `/rituales …` text; returns the reply, or null when not a command. */
export function handleRitualesCommand(text: string, now = new Date()): string | null {
  const cmd = parseRitualesCommand(text);
  if (!cmd) return null;
  switch (cmd.kind) {
    case "list":
      return renderList(listRitualEntries(now), now);
    case "help":
      return HELP;
    case "pause":
    case "resume": {
      const entries = listRitualEntries(now);
      const hit = findEntry(entries, cmd.target);
      if (hit === "ambiguous") return `"${cmd.target}" coincide con varios. Usa el número de /rituales.`;
      if (!hit) return `No encuentro "${cmd.target}". Manda /rituales para ver la lista.`;
      const on = cmd.kind === "resume";
      if (hit.kind === "ritual") setRitualPaused(hit.id, !on);
      else setScheduleActive(hit.id, on);
      // Echo the NAME, not the number: the listing re-sorts after a pause
      // (R2 audit W1 — "reanuda 12" resumed a different schedule).
      return on ? `Reanudado: ${hit.name}.` : `Pausado: ${hit.name}. Reanuda con /rituales reanuda ${hit.name.split(/\s[—–-]\s/)[0]}.`;
    }
    case "full": {
      const d = getDeferral(cmd.id);
      if (!d) return `No hay ningún mensaje guardado con id ${cmd.id}. Manda /rituales para ver los pendientes.`;
      return `📄 ${d.title}\n\n${d.text}`;
    }
    case "mute": {
      const until = parseUntil(cmd.until, now);
      if (!until) return "Hora no válida. Ej: /rituales silencio hasta 15:00 (o 3pm, o mañana).";
      setMutedUntil(GLOBAL_MUTE_ID, until);
      return `🔇 Silencio hasta ${fmtMx(until)}. Los rituales siguen corriendo; lo que llegue se incluye en el Morning Sync.`;
    }
    case "unmute":
      setMutedUntil(GLOBAL_MUTE_ID, null);
      return "🔔 Silencio desactivado.";
  }
}
