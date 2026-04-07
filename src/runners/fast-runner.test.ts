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
        ["jarvis_file_read"],
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

  // --- Layer 2 extended: passive participle + ✅ ---
  it("detects ✅ Marcada como completed (passive claim, no write tools called)", () => {
    expect(
      detectsHallucinatedExecution(
        '✅ **Marcada como `completed`** | "S7 - Descomponer prompts"',
        ["jarvis_file_read", "browser__goto"],
      ),
    ).toBe(true);
  });

  it("detects ✅ Eliminada (passive delete claim)", () => {
    expect(
      detectsHallucinatedExecution(
        '✅ **Eliminada (no existe en roadmap):** `76890a25` — "S5 - Inference"',
        ["jarvis_file_read"],
      ),
    ).toBe(true);
  });

  it("detects Acciones Ejecutadas header", () => {
    expect(
      detectsHallucinatedExecution(
        "### Acciones Ejecutadas:\n| ✅ Actualizada | tarea X |",
        ["jarvis_file_read"],
      ),
    ).toBe(true);
  });

  it("allows passive observation WITHOUT ✅ (read-tool status listing)", () => {
    expect(
      detectsHallucinatedExecution(
        "La tarea está marcada como completada en NorthStar.",
        ["jarvis_file_read"],
      ),
    ).toBe(false);
  });

  // --- Layer 3b: Completion claims only fire without write tools ---
  it("allows 'acabo de actualizar' when write tools were called", () => {
    expect(
      detectsHallucinatedExecution(
        "Acabo de actualizar los 3 estados de las tareas en NorthStar.",
        ["jarvis_file_read", "jarvis_file_write"],
      ),
    ).toBe(false);
  });

  it("allows 'he verificado' when write tools were called", () => {
    expect(
      detectsHallucinatedExecution(
        "He verificado y actualizado las tareas. Todas marcadas como completadas.",
        ["jarvis_file_read", "file_write"],
      ),
    ).toBe(false);
  });

  it("allows 'just updated' when write tools were called", () => {
    expect(
      detectsHallucinatedExecution(
        "I just updated the task status to completed.",
        ["jarvis_file_write"],
      ),
    ).toBe(false);
  });

  it("detects 'acabo de actualizar' when NO write tools were called", () => {
    expect(
      detectsHallucinatedExecution(
        "Acabo de actualizar los 3 estados de las tareas en NorthStar.",
        ["jarvis_file_read"],
      ),
    ).toBe(true);
  });

  it("still detects impossible FTP narration even with write tools", () => {
    expect(
      detectsHallucinatedExecution(
        "Conexión FTP establecida con éxito. Archivo subido al servidor.",
        ["file_write"],
      ),
    ).toBe(true);
  });

  it("still detects (Procesando...) narration even with write tools", () => {
    expect(
      detectsHallucinatedExecution(
        "*(Publicando artículo en WordPress...)*\n\nEl artículo está publicado.",
        ["wp_publish"],
      ),
    ).toBe(true);
  });

  // --- Layer 0: Failed write tools ---
  it("detects failed-write hallucination: update_task failed but claims ✅ Marcada", () => {
    expect(
      detectsHallucinatedExecution(
        '✅ **Marcada como `completed`** | "S7 - Descomponer prompts"',
        ["jarvis_file_read", "shell_exec"],
        undefined,
        ["file_write"],
      ),
    ).toBe(true);
  });

  it("detects failed-write hallucination: passive voice with success marker", () => {
    expect(
      detectsHallucinatedExecution(
        "## ✅ **Sincronización Completada: V4.0 100% Alineado**",
        ["jarvis_file_read"],
        undefined,
        ["file_write"],
      ),
    ).toBe(true);
  });

  it("allows response without success marker when write tools failed", () => {
    expect(
      detectsHallucinatedExecution(
        "No pude actualizar la tarea porque el servidor devolvió error.",
        ["jarvis_file_read"],
        undefined,
        ["file_write"],
      ),
    ).toBe(false);
  });

  it("allows success when write tool failed first but succeeded on retry within same execution", () => {
    // file_delete: first call → CONFIRMATION_REQUIRED (error),
    // second call after unlock → success. Tool appears in BOTH
    // failedToolCalls and toolsCalled. Should NOT trigger guard.
    expect(
      detectsHallucinatedExecution(
        "✅ Eliminadas 5 tareas completadas con más de 8 días.",
        ["jarvis_file_read", "file_delete"],
        undefined,
        // failedWriteTools now excludes tools that also succeeded
        [],
      ),
    ).toBe(false);
  });
});

describe("write-claim false positive fixes (v6.4 OH2)", () => {
  it("allows 'Status: completed' data label from task_history (not a write claim)", () => {
    expect(
      detectsHallucinatedExecution(
        "| Ejecución | Status | Rounds |\n| Apr 3 | `completed` | 4 |\n| Apr 7 | `completed_with_concerns` | 3 |",
        ["task_history"],
      ),
    ).toBe(false);
  });

  it("allows 'status: done' in diagnostic table from read tools", () => {
    expect(
      detectsHallucinatedExecution(
        "## Diagnóstico\n\nStatus: completed_with_concerns\nExit reason: provider_failure\nRounds: 3",
        ["task_history", "list_schedules"],
      ),
    ).toBe(false);
  });

  it("allows diagnostic report with failure analysis (user asked about failures)", () => {
    expect(
      detectsHallucinatedExecution(
        "Detectar fallos consecutivos permite identificar patrones de inestabilidad. El reporte fue completado con concerns.",
        ["task_history"],
        "Qué pasó con el reporte que falló?",
      ),
    ).toBe(false);
  });

  it("allows failure diagnosis with 'error' in user message", () => {
    expect(
      detectsHallucinatedExecution(
        "El reporte fue enviado exitosamente el día 5 pero falló el día 6.",
        ["task_history"],
        "Diagnóstico del error en el reporte diario",
      ),
    ).toBe(false);
  });

  it("still catches first-person write claims even from diagnostic tools", () => {
    expect(
      detectsHallucinatedExecution(
        "Actualicé la tarea en NorthStar con el nuevo estado.",
        ["task_history"],
      ),
    ).toBe(true);
  });

  it("still catches ✅ Marcada claim from diagnostic tools", () => {
    expect(
      detectsHallucinatedExecution(
        "✅ **Marcada como `completed`** — Tarea actualizada",
        ["task_history"],
      ),
    ).toBe(true);
  });
});

describe("git hallucination detection", () => {
  it("detects PUSH EXITOSO claim without git_push called", () => {
    expect(
      detectsHallucinatedExecution(
        "## ✅ **PUSH EXITOSO**\nCambios subidos a GitHub.",
        ["git_status"],
      ),
    ).toBe(true);
  });

  it("detects 'I pushed the changes' without git_push called", () => {
    expect(
      detectsHallucinatedExecution(
        "I pushed the changes to the remote repository.",
        ["git_status"],
      ),
    ).toBe(true);
  });

  it("detects 'cambios subidos a GitHub' without git_push called", () => {
    expect(
      detectsHallucinatedExecution(
        "Los cambios subidos a GitHub correctamente.",
        ["git_status"],
      ),
    ).toBe(true);
  });

  it("detects 'hice push' without git_push called", () => {
    expect(
      detectsHallucinatedExecution(
        "Ya hice push de los archivos al repositorio.",
        ["git_status"],
      ),
    ).toBe(true);
  });

  it("detects 'commit exitosamente' without git_commit called", () => {
    expect(
      detectsHallucinatedExecution(
        "Commit realizado exitosamente con los archivos nuevos.",
        ["git_status"],
      ),
    ).toBe(true);
  });

  it("allows push claim when git_push was actually called", () => {
    expect(
      detectsHallucinatedExecution(
        "## ✅ **PUSH EXITOSO**\nCambios subidos a GitHub.",
        ["git_status", "git_push"],
      ),
    ).toBe(false);
  });

  it("allows commit claim when git_commit was actually called", () => {
    expect(
      detectsHallucinatedExecution("## ✅ **COMMIT EXITOSO**\nHash: ba2005e", [
        "git_commit",
      ]),
    ).toBe(false);
  });
});

describe("Layer 4: domain-specific claim mismatch (git claims without git tools)", () => {
  it("detects 'PR CREADO' when only jarvis_file_write called", () => {
    expect(
      detectsHallucinatedExecution(
        "✅ PROPUESTA GUARDADA + PR CREADO\n\n## ARCHIVO CREADO\n- Path: projects/braid/propuesta.md",
        ["jarvis_file_write"],
      ),
    ).toBe(true);
  });

  it("detects 'PR created' in English when only jarvis_file_write called", () => {
    expect(
      detectsHallucinatedExecution(
        "PR created successfully. Changes are ready for review.",
        ["jarvis_file_write"],
      ),
    ).toBe(true);
  });

  it("detects 'branch creada' without git tools", () => {
    expect(
      detectsHallucinatedExecution(
        "Branch creada: jarvis/feat/braid-enhancer. Lista para push.",
        ["jarvis_file_write", "jarvis_file_read"],
      ),
    ).toBe(true);
  });

  it("detects 'PUSH EXITOSO' when KB write tools called but no git tools", () => {
    expect(
      detectsHallucinatedExecution(
        "✅ PUSH EXITOSO\nRama main sincronizada con origin/main",
        ["jarvis_file_write", "web_read"],
      ),
    ).toBe(true);
  });

  it("detects fabricated GitHub PR URL without git tools", () => {
    expect(
      detectsHallucinatedExecution(
        "PR abierto: https://github.com/kosm1x/agent-controller/pull/42",
        ["jarvis_file_write"],
      ),
    ).toBe(true);
  });

  it("detects 'gh pr create' claim without git tools", () => {
    expect(
      detectsHallucinatedExecution(
        "Ejecuté gh pr create con título 'feat: BRAID integration'",
        ["jarvis_file_write"],
      ),
    ).toBe(true);
  });

  it("allows PR CREADO when gh_create_pr was actually called", () => {
    expect(
      detectsHallucinatedExecution(
        "✅ PR CREADO\nhttps://github.com/kosm1x/agent-controller/pull/1",
        ["git_commit", "git_push", "gh_create_pr"],
      ),
    ).toBe(false);
  });

  it("allows branch claim when git_push was called", () => {
    expect(
      detectsHallucinatedExecution(
        "Branch creada y pushed: jarvis/feat/braid-enhancer",
        ["git_status", "git_commit", "git_push"],
      ),
    ).toBe(false);
  });

  it("does not false-positive on mentioning PRs without claiming creation", () => {
    expect(
      detectsHallucinatedExecution(
        "Para crear el PR necesito que autorices el branch. ¿Autorizas?",
        ["jarvis_file_write"],
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

  // --- Direct deletion commands (no two-step needed) ---
  it("returns true for direct 'elimina lo que no está' command", () => {
    expect(
      hasUserConfirmedDeletion([
        {
          role: "user",
          content:
            "Revisa contra el roadmap. Elimina lo que no esté y marca como completado lo que ya está.",
        },
      ]),
    ).toBe(true);
  });

  it("returns true for direct 'borra las que no existen'", () => {
    expect(
      hasUserConfirmedDeletion([
        {
          role: "user",
          content: "Borra las que no existen en el roadmap.",
        },
      ]),
    ).toBe(true);
  });

  it("returns true for direct 'delete the ones that'", () => {
    expect(
      hasUserConfirmedDeletion([
        {
          role: "user",
          content: "Delete the ones that are not in the roadmap.",
        },
      ]),
    ).toBe(true);
  });

  it("returns true for clitic 'eliminala' in user message", () => {
    expect(
      hasUserConfirmedDeletion([
        {
          role: "user",
          content: "Si la tarea no está en el roadmap, eliminala.",
        },
      ]),
    ).toBe(true);
  });

  it("returns true when user says 'Procede' after assistant asks", () => {
    expect(
      hasUserConfirmedDeletion([
        {
          role: "assistant",
          content: "¿Confirmas que elimine la tarea 76890a25?",
        },
        { role: "user", content: "Procede con la actualización" },
      ]),
    ).toBe(true);
  });

  it("does not match vague mentions of elimination without target", () => {
    expect(
      hasUserConfirmedDeletion([
        { role: "user", content: "¿Se puede eliminar?" },
      ]),
    ).toBe(false);
  });

  // --- Direct delete + task noun (no two-step needed) ---
  it("returns true for 'delete completed tasks'", () => {
    expect(
      hasUserConfirmedDeletion([
        { role: "user", content: "Delete completed tasks" },
      ]),
    ).toBe(true);
  });

  it("returns true for 'elimina las tareas completadas'", () => {
    expect(
      hasUserConfirmedDeletion([
        { role: "user", content: "Elimina las tareas completadas" },
      ]),
    ).toBe(true);
  });

  it("returns true for 'borra las tareas viejas'", () => {
    expect(
      hasUserConfirmedDeletion([
        { role: "user", content: "Borra las tareas viejas" },
      ]),
    ).toBe(true);
  });

  it("returns true for 'delete the old goals'", () => {
    expect(
      hasUserConfirmedDeletion([
        { role: "user", content: "Delete the old goals" },
      ]),
    ).toBe(true);
  });

  // --- Two-step with CONFIRMATION_REQUIRED in assistant response ---
  it("returns true when assistant relayed CONFIRMATION_REQUIRED and user confirmed", () => {
    expect(
      hasUserConfirmedDeletion([
        { role: "user", content: "Limpia las tareas completadas" },
        {
          role: "assistant",
          content:
            "Encontré 5 tareas completadas. CONFIRMATION_REQUIRED — ¿las elimino?",
        },
        { role: "user", content: "Sí" },
      ]),
    ).toBe(true);
  });

  // --- Two-step with English "shall I delete" ---
  it("returns true when assistant asks 'shall I delete' and user confirms", () => {
    expect(
      hasUserConfirmedDeletion([
        { role: "user", content: "Clean up old tasks" },
        {
          role: "assistant",
          content: "I found 3 completed tasks. Shall I delete them?",
        },
        { role: "user", content: "Yes" },
      ]),
    ).toBe(true);
  });

  // --- Two-step with intervening pronoun (quieres que los elimine) ---
  it("returns true when assistant asks 'quieres que los elimine' and user confirms", () => {
    expect(
      hasUserConfirmedDeletion([
        { role: "user", content: "Hay tareas viejas" },
        {
          role: "assistant",
          content: "Encontré 4 tareas completadas. ¿Quieres que los elimine?",
        },
        { role: "user", content: "Dale" },
      ]),
    ).toBe(true);
  });

  // --- User says 'do it' ---
  it("returns true when user says 'do it' after deletion ask", () => {
    expect(
      hasUserConfirmedDeletion([
        { role: "user", content: "Remove old objectives" },
        {
          role: "assistant",
          content: "Found 2 archived objectives. Want me to delete them?",
        },
        { role: "user", content: "Do it" },
      ]),
    ).toBe(true);
  });
});
