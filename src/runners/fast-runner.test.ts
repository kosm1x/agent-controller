import { describe, it, expect } from "vitest";
import {
  detectsHallucinatedExecution,
  hasUserConfirmedDeletion,
} from "./fast-runner.js";

describe("detectsHallucinatedExecution", () => {
  // --- Layer 1: Full hallucination (zero tools) ---
  it("returns false when write tools were called", () => {
    expect(
      detectsHallucinatedExecution(
        "✅ Escribí 5 filas en la Google Sheet exitosamente",
        ["gsheets_write"],
      ),
    ).toBe(false);
  });

  it("detects full hallucination: success + write claim + zero tools", () => {
    expect(
      detectsHallucinatedExecution(
        "✅ Escribí 5 filas completas en la Google Sheet de auditoría.",
        [],
      ),
    ).toBe(true);
  });

  it("detects full hallucination: claims Sheet update with zero tools", () => {
    expect(
      detectsHallucinatedExecution(
        "✅ Sheet Actualizada - Filas 10-12 Escritas\n\nAcción realizada: Escribí directamente en la Google Sheet.",
        [],
      ),
    ).toBe(true);
  });

  it("detects legacy concrete claim (URL + success marker + zero tools)", () => {
    expect(
      detectsHallucinatedExecution(
        "✅ Imagen subida a https://example.com/wp-content/uploads/img.png",
        [],
      ),
    ).toBe(true);
  });

  it("detects narrated processing pattern", () => {
    expect(
      detectsHallucinatedExecution("*(Procesando conexión FTP...)*", []),
    ).toBe(true);
  });

  it("detects Spanish narrated completion", () => {
    expect(
      detectsHallucinatedExecution(
        "Acabo de publicar el artículo en el blog.",
        [],
      ),
    ).toBe(true);
  });

  it("returns false for normal text without tools", () => {
    expect(
      detectsHallucinatedExecution(
        "Puedo ayudarte con eso. ¿Qué tarea quieres crear?",
        [],
      ),
    ).toBe(false);
  });

  it("detects FTP/SSH narration", () => {
    expect(
      detectsHallucinatedExecution(
        "Conexión FTP establecida con éxito. Archivo subido.",
        [],
      ),
    ).toBe(true);
  });

  // --- Layer 2: Partial hallucination (generic write tools) ---
  it("detects partial hallucination: claims Sheet write but only called gsheets_read", () => {
    expect(
      detectsHallucinatedExecution(
        "Actualicé la Sheet con los datos de los 5 artículos.",
        ["gsheets_read", "wp_list_posts"],
      ),
    ).toBe(true);
  });

  it("detects partial hallucination: claims WP publish with success adverb", () => {
    expect(
      detectsHallucinatedExecution(
        "El artículo fue publicado exitosamente en el blog.",
        ["wp_list_posts"],
      ),
    ).toBe(true);
  });

  it("detects partial hallucination: claims image uploaded with success adverb", () => {
    expect(
      detectsHallucinatedExecution(
        "La imagen fue subida correctamente al sitio.",
        ["wp_list_posts", "wp_read_post"],
      ),
    ).toBe(true);
  });

  it("detects partial hallucination: first-person email claim", () => {
    expect(
      detectsHallucinatedExecution(
        "Envié el reporte a fede@eurekamd.net con los datos.",
        ["web_search"],
      ),
    ).toBe(true);
  });

  it("detects partial hallucination: first-person task creation", () => {
    expect(
      detectsHallucinatedExecution(
        "Creé una tarea bajo el objetivo de optimización.",
        ["commit__list_tasks"],
      ),
    ).toBe(true);
  });

  it("allows passive observation from read tools (not hallucination)", () => {
    expect(
      detectsHallucinatedExecution(
        "Las filas 40-42 están actualizadas con datos de los artículos 324, 330.",
        ["gsheets_read"],
      ),
    ).toBe(false);
  });

  it("detects partial hallucination: quantity + action (50 celdas actualizadas)", () => {
    expect(
      detectsHallucinatedExecution("50 celdas actualizadas con datos reales.", [
        "gsheets_read",
      ]),
    ).toBe(true);
  });

  it("detects 'Acciones realizadas' opener without write tools", () => {
    expect(
      detectsHallucinatedExecution(
        "Acciones realizadas:\n1. Limpié las filas\n2. Escribí los datos",
        ["gsheets_read"],
      ),
    ).toBe(true);
  });

  it("returns false when wp_publish was actually called", () => {
    expect(
      detectsHallucinatedExecution(
        "El artículo fue publicado exitosamente en el blog.",
        ["wp_list_posts", "wp_publish"],
      ),
    ).toBe(false);
  });

  it("returns false when gsheets_write was actually called", () => {
    expect(
      detectsHallucinatedExecution(
        "Escribí 5 filas en la Sheet de auditoría.",
        ["gsheets_read", "gsheets_write"],
      ),
    ).toBe(false);
  });

  it("returns false when gmail_send was actually called", () => {
    expect(
      detectsHallucinatedExecution("Email enviado exitosamente.", [
        "gmail_send",
      ]),
    ).toBe(false);
  });

  it("detects partial hallucination in English", () => {
    expect(
      detectsHallucinatedExecution(
        "The article was published successfully to the blog.",
        ["wp_list_posts"],
      ),
    ).toBe(true);
  });

  it("detects English first-person write claim", () => {
    expect(
      detectsHallucinatedExecution("I wrote the data to the spreadsheet.", [
        "gsheets_read",
      ]),
    ).toBe(true);
  });

  it("detects narrated processing even when some tools were called", () => {
    expect(
      detectsHallucinatedExecution(
        "*(Publicando artículo en WordPress...)*\n\nListo, el artículo está publicado.",
        ["wp_list_posts"],
      ),
    ).toBe(true);
  });

  it("returns false for non-write text even with only read tools", () => {
    expect(
      detectsHallucinatedExecution(
        "Aquí están los artículos del blog. ¿Cuál quieres editar?",
        ["wp_list_posts"],
      ),
    ).toBe(false);
  });

  it("returns false for read-only summary without write claims", () => {
    expect(
      detectsHallucinatedExecution(
        "Encontré 5 artículos publicados. Aquí están los títulos y URLs.",
        ["wp_list_posts", "gsheets_read"],
      ),
    ).toBe(false);
  });
});

describe("hasUserConfirmedDeletion", () => {
  it("returns true when assistant asked and user confirmed (Spanish)", () => {
    expect(
      hasUserConfirmedDeletion([
        { role: "user", content: "Borra la tarea de Pipecat" },
        {
          role: "assistant",
          content: '¿Confirmo la eliminación de "Levantar entorno Pipecat"?',
        },
        { role: "user", content: "Sí" },
      ]),
    ).toBe(true);
  });

  it("returns true when assistant asked and user said dale", () => {
    expect(
      hasUserConfirmedDeletion([
        { role: "user", content: "Elimina esas tareas" },
        {
          role: "assistant",
          content: "Voy a eliminar las siguientes tareas. ¿Confirmas?",
        },
        { role: "user", content: "Dale" },
      ]),
    ).toBe(true);
  });

  it("returns false when no assistant asked about deletion", () => {
    expect(hasUserConfirmedDeletion([{ role: "user", content: "Sí" }])).toBe(
      false,
    );
  });

  it("returns false when assistant asked but user did not confirm", () => {
    expect(
      hasUserConfirmedDeletion([
        { role: "user", content: "Borra la tarea vieja" },
        {
          role: "assistant",
          content: "¿Quieres que elimine la tarea? ¿Confirmo?",
        },
        { role: "user", content: "No, espera" },
      ]),
    ).toBe(false);
  });

  it("returns false on empty history", () => {
    expect(hasUserConfirmedDeletion([])).toBe(false);
  });

  it("returns true with English delete_item mention", () => {
    expect(
      hasUserConfirmedDeletion([
        { role: "user", content: "Delete the old tasks" },
        {
          role: "assistant",
          content: "I'll use delete_item to remove these. Confirm?",
        },
        { role: "user", content: "Yes" },
      ]),
    ).toBe(true);
  });

  it("returns true when user says 'bórrala'", () => {
    expect(
      hasUserConfirmedDeletion([
        { role: "user", content: "Quiero limpiar tareas viejas" },
        {
          role: "assistant",
          content: "Encontré 3 tareas obsoletas. ¿Las borro?",
        },
        { role: "user", content: "Bórrala" },
      ]),
    ).toBe(true);
  });
});
