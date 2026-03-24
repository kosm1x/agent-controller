import { describe, it, expect } from "vitest";
import {
  detectsHallucinatedExecution,
  hasUserConfirmedDeletion,
} from "./fast-runner.js";

describe("detectsHallucinatedExecution", () => {
  it("returns false when tools were called", () => {
    expect(
      detectsHallucinatedExecution(
        "✅ EXITOSAMENTE publicado en /wp-content/uploads/img.png",
        ["wp_publish"],
      ),
    ).toBe(false);
  });

  it("detects structural hallucination (success + concrete claim + no tools)", () => {
    expect(
      detectsHallucinatedExecution(
        "✅ Imagen subida exitosamente a https://example.com/wp-content/uploads/img.png",
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

  // --- Layer 2: Partial hallucination (WP-specific) ---
  it("detects partial hallucination: claims WP publish but only called wp_list_posts", () => {
    expect(
      detectsHallucinatedExecution(
        "El artículo fue publicado exitosamente en el blog.",
        ["wp_list_posts"],
      ),
    ).toBe(true);
  });

  it("detects partial hallucination: claims image uploaded but no wp_media_upload", () => {
    expect(
      detectsHallucinatedExecution(
        "La imagen fue subida correctamente al sitio.",
        ["wp_list_posts", "wp_read_post"],
      ),
    ).toBe(true);
  });

  it("detects partial hallucination: claims article updated without wp_publish", () => {
    expect(
      detectsHallucinatedExecution(
        "Artículo actualizado con éxito. Los cambios están en línea.",
        ["wp_list_posts", "wp_read_post", "file_edit"],
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

  it("returns false when wp_media_upload was actually called", () => {
    expect(
      detectsHallucinatedExecution(
        "La imagen fue subida correctamente al sitio.",
        ["wp_media_upload"],
      ),
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

  it("detects narrated processing even when some tools were called", () => {
    expect(
      detectsHallucinatedExecution(
        "*(Publicando artículo en WordPress...)*\n\nListo, el artículo está publicado.",
        ["wp_list_posts"],
      ),
    ).toBe(true);
  });

  it("returns false for non-WP text even with no WP write tools", () => {
    expect(
      detectsHallucinatedExecution(
        "Aquí están los artículos del blog. ¿Cuál quieres editar?",
        ["wp_list_posts"],
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
