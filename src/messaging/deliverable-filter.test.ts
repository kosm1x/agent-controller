import { describe, expect, it } from "vitest";
import {
  PAUSE_SCHEDULE_TAG,
  sanitizeDeliverable,
} from "./deliverable-filter.js";

const MARKERS = [
  "[error_max_turns",
  "[timeout after",
  "[MODO /loop",
  "STATUS:",
  "Partial response below",
  "[Task failed]",
  "[positive feedback acknowledged]",
  "Goal completed",
  "Goal completado",
  "OAuth access token has been revoked",
  PAUSE_SCHEDULE_TAG,
];

function expectClean(text: string) {
  for (const m of MARKERS) expect(text).not.toContain(m);
}

describe("sanitizeDeliverable — harness markers", () => {
  it("strips the SDK max_turns marker + STATUS line and appends one Spanish failure line (task 12025 shape)", () => {
    const raw =
      "[error_max_turns — Reached maximum number of turns (55)] Partial response below — turn/budget limit hit before completion.\n\n" +
      "Commit 8a49b05 listo. Falta el push y verificar en producción.\n\n" +
      "STATUS: DONE_WITH_CONCERNS — SDK reported error_max_turns; content above is partial and the task did not formally complete.";
    const r = sanitizeDeliverable(raw);
    expectClean(r.text);
    expect(r.failureKind).toBe("turn_budget");
    expect(r.text.startsWith("Commit 8a49b05 listo.")).toBe(true);
    expect(r.text).toContain("Dime «sigue» para continuar.");
    expect(
      r.text.split("\n").filter((l) => l.includes("presupuesto")),
    ).toHaveLength(1);
  });

  it("a markers-only reply becomes a single failure line, never silence", () => {
    const r = sanitizeDeliverable(
      "[error_max_turns — Reached maximum number of turns (10)] Partial response below — turn/budget limit hit before completion.\n\nSTATUS: DONE_WITH_CONCERNS — partial",
    );
    expectClean(r.text);
    expect(r.text).toBe(
      "Se me acabó el presupuesto del turno antes de producir resultado. Dime «sigue» para reintentar.",
    );
  });

  it("timeout marker → timeout line", () => {
    const r = sanitizeDeliverable(
      "[timeout after 900s — partial response below]\n\nAnálisis del PDF: tres hallazgos.\n\nSTATUS: DONE_WITH_CONCERNS — query hit the 900s hard timeout, response is incomplete",
    );
    expectClean(r.text);
    expect(r.failureKind).toBe("timeout");
    expect(r.text).toMatch(/^Análisis del PDF: tres hallazgos\./);
    expect(r.text).toContain("¿Sigo desde donde quedó?");
  });

  it("echoed /loop mode line → stripped as a record, NOT a failure (2026-08-27)", () => {
    const body =
      "Revisé los tres PRs abiertos: #32 sigue esperando revisión, #33 quedó obsoleto tras #35 y lo cerré con nota, #34 ya estaba cerrado. Nada más pendiente.";
    const r = sanitizeDeliverable(
      `[MODO /loop — sin límite de turnos ni de tiempo: continúa hasta TERMINAR la tarea completa; el operador puede detenerte con «Para».]\n\n${body}`,
    );
    expectClean(r.text);
    expect(r.stripped).toContain("loop_mode_marker");
    expect(r.failureKind).toBeUndefined();
    expect(r.text).toBe(body);
  });

  it("task 12375 shape: duplicated markers, English sandbox monologue, 401 OAuth ×4 → one auth line", () => {
    const raw = [
      "[error_max_turns — Reached maximum number of turns (10)] Partial response below — turn/budget limit hit before completion.",
      "",
      "I'll check the workspace first. Let me verify the EROFS mount and the SQLite lock before continuing with the PDF.",
      "Failed to authenticate. API Error: 401 OAuth access token has been revoked",
      "Failed to authenticate. API Error: 401 OAuth access token has been revoked",
      "STATUS: DONE_WITH_CONCERNS",
      "[error_max_turns — Reached maximum number of turns (10)] Partial response below — turn/budget limit hit before completion.",
      "Failed to authenticate. API Error: 401 OAuth access token has been revoked",
      "Failed to authenticate. API Error: 401 OAuth access token has been revoked",
      "STATUS: DONE_WITH_CONCERNS",
    ].join("\n");
    const r = sanitizeDeliverable(raw);
    expectClean(r.text);
    expect(r.text).not.toContain("401");
    // The auth error is the CAUSE; the max_turns marker is the consequence.
    expect(r.failureKind).toBe("auth");
    // Exactly one Spanish failure line, last. The content guard (R1 audit
    // C2) keeps the final English sentence because nothing else remains —
    // it is flagged, not dropped (Phase 0 does not translate).
    expect(
      r.text.endsWith(
        "Se venció la sesión de autenticación (OAuth). Reintenta en unos minutos; si persiste, hay que renovar el token.",
      ),
    ).toBe(true);
    expect(r.text.match(/Se venció/g)).toHaveLength(1);
    expect(r.text.startsWith("Let me verify the EROFS")).toBe(true);
  });

  it("API Error 400 in a BLOCKED runner text → prose + api line with the code", () => {
    const r = sanitizeDeliverable(
      'Aquí va el poema:\n\nAPI Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Output blocked by content filtering policy"}}',
    );
    expect(r.failureKind).toBe("api_error");
    expect(r.text).toContain("La API devolvió un error 400. ¿Reintento?");
    expect(r.text).not.toContain("content filtering");
  });

  it("strips sub-agent goal banners and [positive feedback acknowledged] without inventing a failure", () => {
    const r = sanitizeDeliverable(
      "Goal completed ✅\n\nEl PR #42 quedó abierto con los tres cambios. Tests en verde.\n\nGoal completado ✅\n[positive feedback acknowledged]",
    );
    expectClean(r.text);
    expect(r.failureKind).toBeUndefined();
    expect(r.text).toBe(
      "El PR #42 quedó abierto con los tres cambios. Tests en verde.",
    );
  });

  it("[Task failed] placeholder alone → generic failure line", () => {
    const r = sanitizeDeliverable("[Task failed] Unknown error");
    expect(r.text).toBe("No pude completar eso. ¿Lo reintento?");
    expect(r.failureKind).toBe("task_failed");
  });

  it("consumes the schedule pause tag", () => {
    const r = sanitizeDeliverable(
      `¿Pausamos las tarjetas de química? Responde sí para pausar. ${PAUSE_SCHEDULE_TAG}`,
    );
    expect(r.text).toBe(
      "¿Pausamos las tarjetas de química? Responde sí para pausar.",
    );
    expect(r.stripped).toContain("pause_tag");
  });
});

describe("sanitizeDeliverable — narration", () => {
  it("peels glued process sentences at the start (exchange 12156 shape) and keeps the deliverable", () => {
    const raw =
      "Tengo el contexto. Ahora escribo...Tengo suficiente contexto técnico. Escribo...Tengo todo lo necesario...Tengo todo. Ahora escribo el documento.\n\n" +
      "## Plan de migración\n\nTres fases: inventario, corte, verificación. Cada fase tiene un gate medible y un rollback explícito documentado abajo.";
    const r = sanitizeDeliverable(raw);
    expect(r.text.startsWith("## Plan de migración")).toBe(true);
    expect(r.stripped.some((s) => s.startsWith("narration:"))).toBe(true);
  });

  it("peels a leading English 'I'll…' sentence when Spanish content follows (exchange 11929 shape)", () => {
    const r = sanitizeDeliverable(
      "I'll read the PDF to extract the Formatos Digitales data.\n\nSíntesis: el informe muestra tres cosas. Primera, el gasto digital creció 18%. Segunda, Meta concentra el 40%. Tercera, falta metodología.",
    );
    expect(r.text.startsWith("Síntesis:")).toBe(true);
    expect(r.englishLeading).toBe(false);
  });

  it("does NOT peel when the reply IS a short plan", () => {
    const raw = "Voy a correr el script en el VPS y te aviso. ¿Ok?";
    const r = sanitizeDeliverable(raw);
    expect(r.text).toBe(raw);
    expect(r.stripped).toEqual([]);
  });

  it("does NOT peel a content sentence that merely starts with 'Ahora'", () => {
    const raw =
      "Ahora mismo el mercado está en $44.77, cap $66.5B, P/E 18.7. El prospecto anterior usaba ~$82 — todos los escenarios cambian. Te paso la tabla corregida abajo.";
    const r = sanitizeDeliverable(raw);
    expect(r.text).toBe(raw);
  });

  it("does NOT peel a sentence with a colon (content, not narration)", () => {
    const raw =
      "Reviso tu plan: tres problemas. Primero, el retailer no aparece en el flujo. Segundo, nadie da el consent. Tercero, el CPG está descrito como receptor, no como co-constructor.";
    const r = sanitizeDeliverable(raw);
    expect(r.text).toBe(raw);
  });
});

describe("sanitizeDeliverable — invariants", () => {
  it("is idempotent", () => {
    const raw =
      "[error_max_turns — x] Partial response below — y.\n\nI'll verify. Let me check.\n\nResultado: 3 commits nuevos, HEAD c64cc0d → d9f1f4a. Todo en origin/main.\n\nSTATUS: DONE_WITH_CONCERNS";
    const once = sanitizeDeliverable(raw).text;
    const twice = sanitizeDeliverable(once).text;
    expect(twice).toBe(once);
  });

  it("leaves ordinary Spanish replies untouched", () => {
    const raw =
      "✅ Google Doc listo:\n\n**[Williams Radar W34](https://docs.google.com/document/d/abc/edit)**\n\n## Lo que contiene\n\n1. Qué es el Williams Radar\n2. S1, S2D y S2 con una metáfora";
    const r = sanitizeDeliverable(raw);
    expect(r.text).toBe(raw);
    expect(r.stripped).toEqual([]);
    expect(r.englishLeading).toBe(false);
  });

  it("flags a fully-English reply without altering it", () => {
    const raw =
      "The build is green and the PR is open. I found two flaky tests and will check them next; your file is in the workspace.";
    const r = sanitizeDeliverable(raw);
    expect(r.text).toBe(raw);
    expect(r.englishLeading).toBe(true);
  });

  it("empty input stays empty (the router's own never-silent fallback owns that case)", () => {
    const r = sanitizeDeliverable("");
    expect(r.text).toBe("");
    expect(r.failureLine).toBeUndefined();
  });
});

describe("sanitizeDeliverable — R1 audit regressions (2026-08-23, replayed from mc.db)", () => {
  it("C1: a filename dot never ends a narration sentence (task 669bebcb)", () => {
    const raw =
      "Voy a leer el index.html para tener el nav, footer y estilos exactos antes de crear las 4 páginas.Tengo todo. Aquí va:\n\n## Páginas\n\n1. Inicio — hero + CTA\n2. Servicios — tres tarjetas con precio\n3. Nosotros — equipo y misión\n4. Contacto — formulario con validación";
    const r = sanitizeDeliverable(raw);
    // The narration (including the glued "Tengo todo.") is peeled as a whole;
    // what remains starts at real content, never mid-token.
    expect(r.text.startsWith("Aquí va:")).toBe(true);
    expect(r.text).not.toMatch(/^html/);
    expect(r.text).not.toContain("index.html");
  });

  it("C1: 'Primero leo el index.' followed by glued prose is not cut at 'index.'", () => {
    const raw =
      "Primero leo el index.html completo para identificar los bloques.\n\nEncontré tres bloques reutilizables: header, cards y footer. Propongo extraerlos a parciales y generar las páginas desde ahí.";
    const r = sanitizeDeliverable(raw);
    expect(r.text.startsWith("Encontré tres bloques")).toBe(true);
  });

  it("C2: a failure-marked reply keeps its short partial answer instead of peeling it", () => {
    const r = sanitizeDeliverable(
      "[Task failed] boom\n\nVoy a revisar el reporte del cliente y te confirmo el número exacto del cierre de agosto.",
    );
    expect(r.text).toContain("Voy a revisar el reporte del cliente");
    expect(r.text.endsWith("No pude completar eso. ¿Lo reintento?")).toBe(true);
  });

  it("C3: a reply that QUOTES an API error mid-sentence is delivered verbatim with no failure claim", () => {
    const raw =
      "El deploy falló: API Error: 500 en /v1/messages del proxy. Reintenté dos veces con el mismo resultado. Propongo revisar el balanceador antes de tocar el código.";
    const r = sanitizeDeliverable(raw);
    expect(r.text).toBe(raw);
    expect(r.failureKind).toBeUndefined();
  });

  it("C3: a reply that QUOTES 'Failed to authenticate' inside prose is untouched", () => {
    const raw =
      "Revisé los logs de Gmail: 'Failed to authenticate' aparece 14 veces desde las 3am. La causa es el token vencido de la cuenta de EurekaMD, no el código.";
    const r = sanitizeDeliverable(raw);
    expect(r.text).toBe(raw);
    expect(r.failureKind).toBeUndefined();
  });

  it("C3: markers inside fenced code are never touched", () => {
    const raw =
      "Así detecta el parser el marcador:\n\n```ts\n// [Task failed] is the marker we strip\nconst STATUS_RE = /STATUS: DONE/;\n```\n\nSe aplica antes de enviar.";
    const r = sanitizeDeliverable(raw);
    expect(r.text).toBe(raw);
    expect(r.failureKind).toBeUndefined();
  });

  it("W4: the PM ritual run-log preamble before the report is dropped (task 8615)", () => {
    const raw =
      "I'll execute the PM daily rebalance ritual in sequence. Let me first load the tool schemas.Schemas loaded. Now executing Step 1 — refreshing Polymarket market data.Step 1 ✅ — 100 mercados capturados y upserted. Procediendo con Step 2 — cómputo de pesos Kelly.Step 2 ✅ — Alpha corrido. Procediendo con Step 3 — rebalance diario.---\n\n**PM diario — 2026-08-22**\n\nUniverso: 100 mercados | Pesos: +0 largos, −0 cortos-via-NO | Rechazos: 198\nEquity: $10,000.00 → $10,000.00 | Cash: $10,000.00 → $10,000.00 | Órdenes: 0 planeadas / 0 ejecutadas / 0 rechazadas";
    const r = sanitizeDeliverable(raw);
    expect(r.text.startsWith("**PM diario — 2026-08-22**")).toBe(true);
    expect(r.stripped).toContain("preamble");
    expect(r.englishLeading).toBe(false);
  });

  it("W4: a Spanish reply that merely contains '---' as a section break keeps its opening paragraph", () => {
    const raw =
      "Tres conclusiones del informe: el gasto digital creció 18%, Meta concentra el 40% y falta metodología en la página 12.\n\n---\n\n## Detalle\n\nEl crecimiento viene de retail media, no de search.";
    const r = sanitizeDeliverable(raw);
    expect(r.text).toBe(raw);
  });

  it("idempotent when the content after narration is short and a failure line is appended", () => {
    const raw =
      "[error_max_turns — x] Partial response below — y.\n\nI'll verify. Let me check.\n\nResultado: 3 commits nuevos, HEAD c64cc0d → d9f1f4a. Todo en origin/main.";
    const once = sanitizeDeliverable(raw).text;
    const twice = sanitizeDeliverable(once).text;
    expect(twice).toBe(once);
    expect(once).toContain("Resultado: 3 commits nuevos");
  });

  it("the SDK-shaped API error glued to prose with a JSON body is still caught (2026-08-21 Rumi case)", () => {
    const r = sanitizeDeliverable(
      'Aquí va el poema:API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Output blocked by content filtering policy"}}',
    );
    expect(r.failureKind).toBe("api_error");
    expect(r.text).not.toContain("content filtering");
    expect(r.text).toContain("La API devolvió un error 400. ¿Reintento?");
  });
});

describe("sanitizeDeliverable — V8.4 read-back lines are harness lines (Phase 2, R1 audit W6)", () => {
  it("the ledger's trailing lines do not count as content, so a short model sentence before them survives", () => {
    const raw =
      "Voy a escribir el archivo.\n\n✔ Verificado: KB projects/demo/x.md (sha 1234, 40 chars, 2026-08-23 02:00:00)\n⚠️ No quedó: KB projects/demo/y.md escrito — KB projects/demo/y.md: no existe tras la escritura\n⏳ Sin releer (no alcancé a verificar): KB projects/demo/z.md escrito\nGates: 1/1 met";
    const r = sanitizeDeliverable(raw);
    expect(r.text).toBe(raw);
    expect(r.stripped).toEqual([]);
  });
});
