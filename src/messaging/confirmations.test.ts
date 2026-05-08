/**
 * Tests for pending tool confirmation system.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  storePendingConfirmation,
  getPendingConfirmation,
  clearPendingConfirmation,
  detectConfirmationResponse,
} from "./confirmations.js";

describe("pendingConfirmations", () => {
  const tk = "whatsapp:group@g.us:sender@s.whatsapp.net";

  afterEach(() => {
    clearPendingConfirmation(tk);
  });

  it("stores and retrieves a pending confirmation", () => {
    storePendingConfirmation(tk, "gmail_send", { to: "a@b.com" }, "send email");
    const pending = getPendingConfirmation(tk);
    expect(pending).not.toBeNull();
    expect(pending!.toolName).toBe("gmail_send");
    expect(pending!.args.to).toBe("a@b.com");
    expect(pending!.summary).toBe("send email");
  });

  it("returns null when no pending exists", () => {
    expect(getPendingConfirmation("nonexistent")).toBeNull();
  });

  it("clears a pending confirmation", () => {
    storePendingConfirmation(tk, "gmail_send", {}, "test");
    clearPendingConfirmation(tk);
    expect(getPendingConfirmation(tk)).toBeNull();
  });

  it("overwrites existing pending for same thread", () => {
    storePendingConfirmation(tk, "gmail_send", { to: "a@b.com" }, "first");
    storePendingConfirmation(tk, "gdrive_delete", { id: "xyz" }, "second");
    const pending = getPendingConfirmation(tk);
    expect(pending!.toolName).toBe("gdrive_delete");
    expect(pending!.summary).toBe("second");
  });
});

describe("detectConfirmationResponse", () => {
  // --- Confirmations (lax mode = default) ---
  it.each([
    "sí",
    "si",
    "dale",
    "hazlo",
    "procede",
    "adelante",
    "ok",
    "confirmo",
    "envíalo",
    "mándalo",
    "yes",
    "go ahead",
    "confirm",
    "send it",
    "claro",
    "por favor",
    // F5 fix — imperative-clitic forms previously missing
    "súbelo",
    "súbela",
    "súbelos",
    "súbelas",
    "créalo",
    "créala",
    "lánzalo",
    "lánzala",
    "tráelo",
    "tráela",
    "guárdalo",
    "guárdala",
    "agrégalo",
    "agrégala",
    "añádelo",
    "cámbialo",
    "modifícalo",
    "escríbelo",
    "actualízalo",
    "prográmalo",
    "descárgalo",
    "compártelo",
    "publícalo",
    "notifícalo",
    "bórralo", // borrar (already in fast-runner regex; now covered here too)
    "elimínalo",
    "actívalo",
    "desactívalo",
  ])("detects '%s' as confirm (lax)", (text) => {
    expect(detectConfirmationResponse(text)).toBe("confirm");
  });

  // --- Declines ---
  it.each([
    "no",
    "cancela",
    "cancelado",
    "alto",
    "para ya",
    "detente",
    "stop",
    "nope",
    "nel",
    "mejor no",
    "olvídalo",
    "don't",
    "never mind",
  ])("detects '%s' as decline", (text) => {
    expect(detectConfirmationResponse(text)).toBe("decline");
  });

  // C4 fix (round 2): bare `para` is the Spanish preposition, not a decline.
  // Regression-guard so a future "let's add common words back" doesn't
  // resurrect the false-decline class.
  it.each(["para mí", "para allá", "para que veas", "para él"])(
    "rejects '%s' as decline (C4 — Spanish preposition)",
    (text) => {
      expect(detectConfirmationResponse(text)).toBeNull();
    },
  );

  // --- Neither ---
  it("returns null for ambiguous/unrelated messages", () => {
    expect(detectConfirmationResponse("qué hora es")).toBeNull();
    expect(detectConfirmationResponse("busca en google algo")).toBeNull();
  });

  it("returns null for long messages (>60 chars)", () => {
    expect(
      detectConfirmationResponse(
        "sí pero antes quiero que revises el contenido del correo porque no estoy seguro de que esté bien redactado",
      ),
    ).toBeNull();
  });

  it("strips WhatsApp group prefix before matching", () => {
    expect(
      detectConfirmationResponse(
        "[Grupo: 120363406840386770, De: 11274322710552]\nsí",
      ),
    ).toBe("confirm");
  });

  it("strips WhatsApp group prefix for decline", () => {
    expect(
      detectConfirmationResponse(
        "[Grupo: 120363406840386770, De: 11274322710552]\nno",
      ),
    ).toBe("decline");
  });

  // --- F5 audit fix: strict mode for destructive ops ---
  describe("strict mode (destructive-hint carve-out)", () => {
    it.each([
      "sí",
      "si",
      "claro",
      "ok",
      "yes",
      "confirmo",
      "confirm",
      "approved",
    ])("detects '%s' as confirm in strict mode", (text) => {
      expect(detectConfirmationResponse(text, { strict: true })).toBe(
        "confirm",
      );
    });

    // C2 fix: destructive-aligned clitics MUST confirm in strict mode.
    // The reply verb matches the op type (e.g. "Bórralo" → delete tool).
    it.each([
      "bórralo",
      "bórrala",
      "bórralos",
      "bórralas",
      "elimínalo",
      "elimínala",
      "elimínalos",
      "elimínalas",
      "quítalo",
      "quítala",
      "remuévelo",
      "desactívalo",
      "deshabilítalo",
    ])("destructive clitic '%s' confirms in strict mode", (text) => {
      expect(detectConfirmationResponse(text, { strict: true })).toBe(
        "confirm",
      );
    });

    // Op-indifferent action verbs DO confirm in strict mode — they mean
    // "go ahead with whatever you proposed" regardless of op type. Refined
    // round-2 audit: dropping them was a regression on the deletion two-step
    // where users naturally reply "Dale" to "¿Confirmo la eliminación?".
    it.each(["dale", "hazlo", "procede", "adelante", "ejecuta"])(
      "op-indifferent action verb '%s' confirms in strict mode",
      (text) => {
        expect(detectConfirmationResponse(text, { strict: true })).toBe(
          "confirm",
        );
      },
    );

    it.each([
      // Non-destructive clitic forms must NOT confirm a destructive op —
      // verb/op-type mismatch (e.g. "Súbelo" replying to a delete prompt).
      "súbelo", // upload verb to delete op = mismatch
      "lánzalo", // launch verb to delete op = mismatch
      "créalo", // create verb to delete op = mismatch
      "envíalo", // send verb to delete op = mismatch
      "guárdalo", // save verb to delete op = mismatch
    ])(
      "rejects non-destructive clitic '%s' in strict mode (verb/op mismatch)",
      (text) => {
        expect(detectConfirmationResponse(text, { strict: true })).toBeNull();
      },
    );

    // C1 fix: bare `va` and `go` were removed from GENERIC_CONFIRM_SRC.
    // These over-fired on common incidental utterances. Cover the regression
    // explicitly so a future loosening doesn't quietly bring them back.
    it.each(["va para allá", "va a casa", "go away", "go to hell", "go home"])(
      "rejects incidental '%s' in strict mode (C1 regression guard)",
      (text) => {
        expect(detectConfirmationResponse(text, { strict: true })).toBeNull();
      },
    );

    // Note: "si quieres" still passes strict because `s[ií]` is followed by
    // whitespace — that's a definitional ambiguity ("yes, if you want" vs
    // "if you want"). Acceptable false-positive: declines via "no" still
    // win, and the user's "si quieres" reads as conditional consent in any
    // confirmation flow context.

    it("declines still match in strict mode (declines are conservative)", () => {
      expect(detectConfirmationResponse("no", { strict: true })).toBe(
        "decline",
      );
      expect(detectConfirmationResponse("cancela", { strict: true })).toBe(
        "decline",
      );
    });

    it("strict mode tightens length threshold (30 chars)", () => {
      // 29 chars — passes
      expect(
        detectConfirmationResponse("sí adelante con la operación", {
          strict: true,
        }),
      ).toBe("confirm");
      // 50+ chars — rejected even with leading "sí"
      expect(
        detectConfirmationResponse(
          "sí pero antes verifica que no haya errores en el archivo",
          { strict: true },
        ),
      ).toBeNull();
    });
  });

  // --- F5 audit fix: reply vocabulary by op family ---
  // W1 round-2 audit fix: this is NOT a true producer/consumer coupling test
  // (it doesn't run the LLM-side prompts through any producer code path).
  // It pins a representative reply corpus per op family so the consumer regex
  // stays comprehensive. A real coupling test would extract LLM-prompt strings
  // from tool descriptions and assert each elicits at least one matching reply.
  // Tracked as W1 in `docs/audit/v7.6-gatekeepers.md`.
  describe("reply vocabulary by op family", () => {
    const cases: Array<{ llmPrompt: string; replies: string[] }> = [
      {
        llmPrompt: "¿Subo el archivo?",
        replies: ["sí", "súbelo", "dale", "adelante", "hazlo"],
      },
      {
        llmPrompt: "¿Creo el evento?",
        replies: ["sí", "créalo", "ok", "dale"],
      },
      {
        llmPrompt: "¿Lanzo el experimento?",
        replies: ["sí", "lánzalo", "adelante", "procede"],
      },
      {
        llmPrompt: "¿Envío el correo?",
        replies: ["sí", "envíalo", "mándalo", "ok", "dale"],
      },
      {
        llmPrompt: "¿Guardo la nota?",
        replies: ["sí", "guárdalo", "guárdala", "dale"],
      },
      {
        llmPrompt: "¿Publico el post?",
        replies: ["sí", "publícalo", "dale"],
      },
      {
        llmPrompt: "¿Borro la tarea?",
        replies: ["sí", "bórrala", "elimínalas", "dale"],
      },
      {
        llmPrompt: "¿Actualizo el status?",
        replies: ["sí", "actualízalo", "dale"],
      },
    ];

    for (const { llmPrompt, replies } of cases) {
      for (const reply of replies) {
        it(`'${llmPrompt}' → '${reply}' confirms`, () => {
          expect(detectConfirmationResponse(reply)).toBe("confirm");
        });
      }
    }
  });

  // --- R2 round-2 audit fix: syntactic guards on regex source ---
  // Trip CI if a future "just add the verb back" diff re-introduces the
  // bugs the round-2 audit caught.
  describe("regex source syntactic guards (round-2 audit R2)", () => {
    it("strict mode does NOT contain non-destructive clitic stems", async () => {
      const { buildConfirmRegex } = await import("./confirmation-verbs.js");
      const src = buildConfirmRegex("strict").source;
      // Non-destructive clitic stems that must NOT appear in strict mode.
      // If any future diff adds them back, this test fails.
      const nonDestructiveStems = [
        "s[uú]b", // subir
        "cr[eé]", // crear
        "l[aá]nz", // lanzar
        "tr[aá]", // traer
        "gu[aá]rd", // guardar
        "agr[eé]g", // agregar
        "modif[ií]c", // modificar
        "escr[ií]b", // escribir
        "actual[ií]z", // actualizar
        "env[ií]", // enviar
        "m[aá]nd", // mandar
      ];
      for (const stem of nonDestructiveStems) {
        expect(src).not.toContain(stem);
      }
    });

    it("strict mode DOES contain destructive-aligned clitic stems", async () => {
      const { buildConfirmRegex } = await import("./confirmation-verbs.js");
      const src = buildConfirmRegex("strict").source;
      const destructiveStems = ["b[oó]rr", "elim[ií]n", "qu[ií]t"];
      for (const stem of destructiveStems) {
        expect(src).toContain(stem);
      }
    });

    it("decline regex does NOT contain bare 'para' (C4 — Spanish preposition)", async () => {
      const { buildDeclineRegex } = await import("./confirmation-verbs.js");
      const src = buildDeclineRegex().source;
      // Bare `para` would be `|para|` (alternation-bounded); the compound
      // `para\s+ya` is allowed.
      expect(src).not.toMatch(/\|para\|/);
      expect(src).toMatch(/para\\s\+ya/);
    });
  });
});
