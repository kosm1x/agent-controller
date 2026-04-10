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
  // --- Confirmations ---
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
    "go",
    "confirm",
    "send it",
    "claro",
    "por favor",
  ])("detects '%s' as confirm", (text) => {
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
});
