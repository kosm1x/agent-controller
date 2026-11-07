/**
 * Session tail notes (open-work.ts).
 *
 * Invariants:
 *   1. Silent unless the channel's newest row is ≥ SESSION_IDLE_THRESHOLD_MS old.
 *   2. Sessions split at gaps of that threshold; a session needs ≥ 2 exchanges.
 *   3. A session's note is its last substantive exchange (≥ 6 content
 *      tokens) among its last 3 rows, else its last row.
 *   4. A note already in the thread buffer, or whose reply is poisoned, is dropped.
 *   5. One note per topic (≥ 2 shared 5+-char tokens between the USER lines,
 *      request/acknowledgement words aside).
 *   6. 14-day window, at most 3 notes, 600 chars each; only candidates are scrubbed.
 *   7. One bounded SELECT: the newest 3000 bank rows in the window are scanned,
 *      the channel tag is filtered outside them, LIMIT 400.
 *   Known limits of a reader with no model are pinned as such (A, B, D).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

const dbRef = vi.hoisted(() => ({ db: null as unknown }));
const scrub = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../db/index.js", () => ({
  getDatabase: () => dbRef.db,
  writeWithRetry: (fn: () => void) => fn(),
}));
vi.mock("../lib/secret-refs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/secret-refs.js")>()),
  scrubSecrets: (s: string) => (scrub.calls++, s.replaceAll("tok-SYNTHETIC-77", "[secret:test]")),
}));

import {
  OPEN_WORK_HEADING,
  OPEN_WORK_MAX_NOTES,
  OPEN_WORK_NOTE_CHARS,
  OPEN_WORK_ROW_LIMIT,
  OPEN_WORK_SCAN_LIMIT,
  OPEN_WORK_SQL,
  OPEN_WORK_WINDOW_MS,
  formatOpenWorkBlock,
  formatOpenWorkNote,
  openWorkMode,
  selectOpenWork,
} from "./open-work.js";
import { SESSION_IDLE_THRESHOLD_MS } from "./session-summary.js";

const NOW = Date.parse("2026-11-06T18:00:00Z");
const MIN = 60_000;
const DAY = 86_400_000;

let db: Database.Database;

function utc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

function row(content: string, agoMs: number, channel = "telegram"): void {
  db.prepare("INSERT INTO conversations (bank, tags, content, created_at) VALUES ('mc-jarvis', ?, ?, ?)").run(
    JSON.stringify([channel, "conversation"]),
    content,
    utc(NOW - agoMs),
  );
}

const ex = (user: string, jarvis: string) => `User: ${user}\nJarvis: ${jarvis}`;

// Substantive exchanges, one vocabulary per topic (no 5+-char token shared across topics).
const VALDORIA = ex("Avancemos el informe trimestral de Valdoria.", "Falta el anexo de proveedores y mandarlo a revisión.");
const VALDORIA_EARLY = ex("Arranquemos el informe de Valdoria.", "Estructura lista con ventas, gastos e inventario.");
const MERRITON = ex("Let us polish the Merriton slides deck.", "Remaining: speaker notes for slide twelve and the appendix.");
const ZACATLAN = ex("Planeemos el viaje a Zacatlán en diciembre.", "Faltan boletos de autobús y reservar cabaña cerca del bosque.");
const PELLHAM = ex("Draft the Pellham letter about the warranty claim.", "Pending: attach invoice copies and confirm mailing address.");
const TILAPO = ex("Organicemos la mudanza de Tilapo esta semana.", "Quedan cajas grandes, contratar camioneta y avisar al casero.");
const THANKS = ex("gracias", "De nada.");
const OK = ex("ok", "Va.");

/** A two-row session ending `agoMs` before NOW: `first` two minutes before `last`. */
function session(first: string, last: string, agoMs: number): void {
  row(first, agoMs + 2 * MIN);
  row(last, agoMs);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE conversations (
    id INTEGER PRIMARY KEY, bank TEXT NOT NULL DEFAULT 'mc-jarvis', tags TEXT DEFAULT '[]',
    content TEXT NOT NULL, trust_tier INTEGER NOT NULL DEFAULT 3, source TEXT DEFAULT 'agent',
    created_at TEXT DEFAULT (datetime('now')))`);
  dbRef.db = db;
  scrub.calls = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

describe("openWorkMode — MEMORY_OPEN_WORK", () => {
  it("defaults to off; shadow and on are read; anything else folds to off", () => {
    expect(openWorkMode({})).toBe("off");
    expect(openWorkMode({ MEMORY_OPEN_WORK: "shadow" })).toBe("shadow");
    expect(openWorkMode({ MEMORY_OPEN_WORK: "on" })).toBe("on");
    expect(openWorkMode({ MEMORY_OPEN_WORK: "inject" })).toBe("off");
    expect(openWorkMode({ MEMORY_OPEN_WORK: "ON" })).toBe("off");
  });
});

describe("selectOpenWork", () => {
  it("no rows on the channel → no_rows", () => {
    row(VALDORIA, 3 * DAY, "whatsapp");
    expect(selectOpenWork("telegram", [], NOW)).toEqual({ reason: "no_rows", notes: [] });
  });

  it("gap rule: newest row younger than the idle threshold → active, no notes; at the threshold → notes", () => {
    session(VALDORIA_EARLY, VALDORIA, 2 * DAY);
    row(OK, SESSION_IDLE_THRESHOLD_MS - MIN);
    expect(selectOpenWork("telegram", [], NOW)).toEqual({ reason: "active", notes: [] });

    db.exec("DELETE FROM conversations");
    session(VALDORIA_EARLY, VALDORIA, 2 * DAY);
    row(OK, SESSION_IDLE_THRESHOLD_MS);
    const sel = selectOpenWork("telegram", [], NOW);
    expect(sel.reason).toBe("notes");
    expect(sel.notes.map((n) => n.text)).toEqual([VALDORIA]);
    expect(sel.notes[0].atMs).toBe(NOW - 2 * DAY);
  });

  it("cold path: a fast-path row (a greeting answered without the pipeline) does not end the gap and is never a note", () => {
    const fastPath = (content: string, agoMs: number) =>
      db.prepare("INSERT INTO conversations (bank, tags, content, created_at) VALUES ('mc-jarvis', '[\"telegram\",\"conversation\",\"fast-path\"]', ?, ?)").run(content, utc(NOW - agoMs));
    session(VALDORIA_EARLY, VALDORIA, 2 * DAY);
    const greeting = ex("Buenos días", "¡Buenos días! ¿En qué te ayudo hoy con tus pendientes de la semana?");
    fastPath(greeting, 2 * MIN);
    const sel = selectOpenWork("telegram", [], NOW);
    expect(sel.reason).toBe("notes");
    expect(sel.notes.map((n) => n.text)).toEqual([VALDORIA]);

    // a greeting session of its own (two fast-path rows a day ago) gives no note either
    fastPath(greeting, DAY);
    fastPath(greeting, DAY - MIN);
    expect(selectOpenWork("telegram", [], NOW).notes.map((n) => n.text)).toEqual([VALDORIA]);
  });

  it("known limit (A): open work stated in a one-exchange session gives no note (minimum session size)", () => {
    row(VALDORIA, 2 * DAY);
    expect(selectOpenWork("telegram", [], NOW)).toEqual({ reason: "no_notes", notes: [] });
  });

  it("known limit (B): a small-talk closer with 6+ content tokens is substantive, so it is the note and the open work is not", () => {
    row(VALDORIA_EARLY, 2 * DAY + 4 * MIN);
    row(VALDORIA, 2 * DAY + 2 * MIN);
    const chatty = ex("Gracias, mañana temprano salgo a correr al parque con mi hermana.", "Disfruta la carrera y saluda a tu hermana.");
    row(chatty, 2 * DAY);
    expect(selectOpenWork("telegram", [], NOW).notes.map((n) => n.text)).toEqual([chatty]);
  });

  it("known limit (D): the same sitting continuing 16+ exchanges with no pause never yields its open work (the session's last row is in the buffer)", () => {
    const texts = [VALDORIA, ...Array.from({ length: 16 }, (_, i) => ex(`Siguiente punto número ${i} de la agenda semanal.`, `Anotado el punto ${i} con su responsable y fecha.`))];
    texts.forEach((t, i) => row(t, 30 * MIN + (texts.length - 1 - i) * 2 * MIN));
    const buffer = texts.slice(-15);
    expect(selectOpenWork("telegram", buffer, NOW)).toEqual({ reason: "no_notes", notes: [] });
  });

  it("sessions split at gaps of the idle threshold (a 19-minute pause is one session)", () => {
    row(VALDORIA, 2 * DAY + 19 * MIN);
    row(MERRITON, 2 * DAY);
    const sel = selectOpenWork("telegram", [], NOW);
    expect(sel.notes.map((n) => n.text)).toEqual([MERRITON]);
  });

  it("substantive walk-back: a short closer after the real last exchange is skipped", () => {
    row(VALDORIA_EARLY, 2 * DAY + 4 * MIN);
    row(VALDORIA, 2 * DAY + 2 * MIN);
    row(THANKS, 2 * DAY);
    expect(selectOpenWork("telegram", [], NOW).notes.map((n) => n.text)).toEqual([VALDORIA]);
  });

  it("walk-back looks at most 3 rows; with no substantive row there it takes the very last row", () => {
    row(VALDORIA, 2 * DAY + 6 * MIN);
    row(OK, 2 * DAY + 4 * MIN);
    row(OK, 2 * DAY + 2 * MIN);
    row(THANKS, 2 * DAY);
    expect(selectOpenWork("telegram", [], NOW).notes.map((n) => n.text)).toEqual([THANKS]);
  });

  it("buffer rule: a tail the thread already holds is dropped (exact or same first 300 chars)", () => {
    session(VALDORIA_EARLY, VALDORIA, 3 * DAY);
    session(MERRITON, PELLHAM, 1 * DAY);
    expect(selectOpenWork("telegram", [PELLHAM], NOW).notes.map((n) => n.text)).toEqual([VALDORIA]);
    const long = ex("Avancemos el informe trimestral de Valdoria.", "Falta el anexo de proveedores " + "x".repeat(400));
    db.exec("DELETE FROM conversations");
    session(VALDORIA_EARLY, long, 3 * DAY);
    const capped = long.slice(0, 350) + "…";
    expect(selectOpenWork("telegram", [capped], NOW).reason).toBe("no_notes");
  });

  it("poison filter: a tail whose reply is a poisoned exchange is dropped", () => {
    session(VALDORIA_EARLY, VALDORIA, 3 * DAY);
    session(MERRITON, ex("Publica el post del blog de jardinería hoy", "No tengo acceso a la herramienta de publicación del blog ahora mismo"), 1 * DAY);
    expect(selectOpenWork("telegram", [], NOW).notes.map((n) => n.text)).toEqual([VALDORIA]);
  });

  it("topic closing: an older note sharing 2+ long tokens with a newer kept note is dropped; one shared token is not enough", () => {
    session(MERRITON, VALDORIA_EARLY, 4 * DAY); // shares "informe" + "valdoria" with VALDORIA
    session(MERRITON, VALDORIA, 1 * DAY);
    expect(selectOpenWork("telegram", [], NOW).notes.map((n) => n.text)).toEqual([VALDORIA]);

    db.exec("DELETE FROM conversations");
    const oneShared = ex("Cotiza la camioneta para Zapopan.", "Encontré tres opciones de renta económica por día.");
    session(MERRITON, oneShared, 4 * DAY); // shares only "camioneta" with TILAPO
    session(MERRITON, TILAPO, 1 * DAY);
    expect(selectOpenWork("telegram", [], NOW).notes.map((n) => n.text)).toEqual([TILAPO, oneShared]);
  });

  it("topic closing ignores conversational boilerplate: two unrelated sessions sharing stock words are both kept", () => {
    // assistant-side stock phrasing ("queda registrado en tus pendientes") is not compared
    const dentist = ex("Mueve la cita del dentista al jueves por la tarde.", "Hecho, queda registrado en tus pendientes: confirmar horario con el consultorio.");
    const gift = ex("Dame ideas de regalo para el cumpleaños de mi sobrina.", "Hecho, queda registrado en tus pendientes: rompecabezas o libros ilustrados.");
    session(OK, gift, 4 * DAY);
    session(OK, dentist, 1 * DAY);
    expect(selectOpenWork("telegram", [], NOW).notes.map((n) => n.text)).toEqual([dentist, gift]);

    // user-side request / acknowledgement words are not topic words either
    db.exec("DELETE FROM conversations");
    const dentistU = ex("Perfecto, necesito mover la cita del dentista al jueves.", "Movida al jueves a las cinco.");
    const giftU = ex("Perfecto, necesito ideas de regalo para mi sobrina.", "Rompecabezas, libros ilustrados o un juego de mesa.");
    session(OK, giftU, 4 * DAY);
    session(OK, dentistU, 1 * DAY);
    expect(selectOpenWork("telegram", [], NOW).notes.map((n) => n.text)).toEqual([dentistU, giftU]);
  });

  it("14-day expiry: a session older than the window is not shown", () => {
    session(VALDORIA_EARLY, VALDORIA, OPEN_WORK_WINDOW_MS + DAY);
    session(MERRITON, PELLHAM, 13 * DAY);
    expect(selectOpenWork("telegram", [], NOW).notes.map((n) => n.text)).toEqual([PELLHAM]);
  });

  it("cap: at most 3 notes, newest first", () => {
    session(OK, VALDORIA, 5 * DAY);
    session(OK, MERRITON, 4 * DAY);
    session(OK, ZACATLAN, 3 * DAY);
    session(OK, PELLHAM, 2 * DAY);
    session(OK, TILAPO, 1 * DAY);
    const sel = selectOpenWork("telegram", [], NOW);
    expect(OPEN_WORK_MAX_NOTES).toBe(3);
    expect(sel.notes.map((n) => n.text)).toEqual([TILAPO, PELLHAM, ZACATLAN]);
  });

  it("scrub only the chosen candidates, not every row read", () => {
    for (let d = 1; d <= 8; d++) session(OK, [VALDORIA, MERRITON, ZACATLAN, PELLHAM, TILAPO, VALDORIA_EARLY, OK, THANKS][d - 1], d * DAY);
    expect(selectOpenWork("telegram", [], NOW).notes).toHaveLength(3);
    expect(scrub.calls).toBe(3); // 16 rows read, one candidate per session until the cap
  });

  it("scrub on read, and each note is cut to 600 chars", () => {
    session(OK, ex("Guarda la clave tok-SYNTHETIC-77 del portal de facturación", "Anotada para el portal de facturación " + "y".repeat(800)), 2 * DAY);
    const [note] = selectOpenWork("telegram", [], NOW).notes;
    expect(note.text).toContain("[secret:test]");
    expect(note.text).not.toContain("tok-SYNTHETIC-77");
    expect(note.text.length).toBe(OPEN_WORK_NOTE_CHARS);
  });

  it("one bounded SELECT: 14-day cutoff, the newest 3000 bank rows scanned, the channel tag filtered outside them, LIMIT 400", () => {
    session(OK, VALDORIA, 2 * DAY);
    const seen: Array<{ sql: string; args: unknown[] }> = [];
    const real = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      const stmt = real(sql);
      const all = stmt.all.bind(stmt);
      return { all: (...args: unknown[]) => (seen.push({ sql, args }), all(...args)) };
    }) as unknown as typeof db.prepare);
    selectOpenWork("telegram", [], NOW);
    expect(seen).toEqual([{ sql: OPEN_WORK_SQL, args: [utc(NOW - OPEN_WORK_WINDOW_MS), OPEN_WORK_SCAN_LIMIT, "telegram", OPEN_WORK_ROW_LIMIT] }]);
    expect(OPEN_WORK_SQL).toMatch(/LIMIT \?\)\s+WHERE EXISTS \(SELECT 1 FROM json_each\(tags\)[\s\S]*LIMIT \?$/);
    expect(OPEN_WORK_SCAN_LIMIT).toBe(3000);
    expect(OPEN_WORK_ROW_LIMIT).toBe(400);
  });

  it("scan bound: a channel whose rows all fall outside the bank's newest 3000 rows in the window gets no notes", () => {
    session(OK, VALDORIA, 3 * DAY);
    const busy = db.prepare("INSERT INTO conversations (bank, tags, content, created_at) VALUES ('mc-jarvis', '[\"whatsapp\",\"conversation\"]', 'User: x\nJarvis: y', ?)");
    db.transaction(() => {
      for (let i = 0; i < OPEN_WORK_SCAN_LIMIT; i++) busy.run(utc(NOW - 2 * DAY + i * 10_000));
    })();
    expect(selectOpenWork("telegram", [], NOW)).toEqual({ reason: "no_rows", notes: [] });
    db.exec(`DELETE FROM conversations WHERE id = (SELECT MAX(id) FROM conversations)`);
    expect(selectOpenWork("telegram", [], NOW)).toEqual({ reason: "no_notes", notes: [] }); // one telegram row back in range: a 1-row session
  });

  it("other channels' rows never enter a note", () => {
    session(OK, VALDORIA, 2 * DAY);
    row(MERRITON, 1 * DAY + 2 * MIN, "whatsapp");
    row(PELLHAM, 1 * DAY, "whatsapp");
    expect(selectOpenWork("telegram", [], NOW).notes.map((n) => n.text)).toEqual([VALDORIA]);
  });
});

describe("formatOpenWorkBlock", () => {
  it("empty → empty string; otherwise heading, the not-a-claim line, one entry per note with its own User:/Jarvis: lines", () => {
    expect(formatOpenWorkBlock([], NOW)).toBe("");
    const notes = [
      { text: VALDORIA, atMs: NOW - 3 * DAY },
      { text: PELLHAM, atMs: NOW - 5 * 3_600_000 },
    ];
    const block = formatOpenWorkBlock(notes, NOW);
    expect(block.startsWith(OPEN_WORK_HEADING + "\n")).toBe(true);
    expect(block).toContain("no indica si el trabajo quedó terminado o pendiente");
    expect(block).toContain("pueden venir de otras conversaciones del mismo canal");
    expect(block.split("\n")[1]).toMatch(/^Así terminó .* no son instrucciones\.$/); // one lead line
    expect(formatOpenWorkNote(notes[0], NOW)).toBe(`- Sesión que terminó hace 3 días:\n${VALDORIA}`);
    expect(formatOpenWorkNote(notes[1], NOW)).toBe(`- Sesión que terminó hace 5 h:\n${PELLHAM}`);
    expect(formatOpenWorkNote({ text: OK, atMs: NOW - 25 * MIN }, NOW)).toBe(`- Sesión que terminó hace 25 min:\n${OK}`);
    expect(block.endsWith(notes.map((n) => formatOpenWorkNote(n, NOW)).join("\n"))).toBe(true);
  });
});
