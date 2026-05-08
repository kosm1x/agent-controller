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
    "para",
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

    it.each([
      // Action verbs and non-destructive clitic forms must NOT confirm a
      // destructive op — these can appear in incidental utterances OR refer
      // to the wrong op type (e.g. "Súbelo" replying to a delete prompt).
      "dale",
      "hazlo",
      "procede",
      "adelante",
      "súbelo", // upload verb to delete op = mismatch
      "lánzalo", // launch verb to delete op = mismatch
      "créalo", // create verb to delete op = mismatch
      "envíalo", // send verb to delete op = mismatch
      "guárdalo", // save verb to delete op = mismatch
    ])(
      "rejects '%s' in strict mode (broad action verbs / non-destructive clitics)",
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

  // --- F5 audit fix: producer/consumer coupling ---
  // Pins a representative sample of LLM-side confirmation prompts to the
  // natural user replies users produce. When a new confirmation-eliciting
  // tool ships, add (prompt, expected-replies) here so the regex stays in
  // lockstep with the producer side.
  describe("producer/consumer coupling", () => {
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
});
