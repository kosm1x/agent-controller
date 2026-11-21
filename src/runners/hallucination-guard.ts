/**
 * The claimed-action guard of the fast runner: the write-capable tool names,
 * the classifier that tells a transient tool error from a permanent one, and
 * the detector that decides whether a reply claims an action that no tool
 * call of the turn performed.
 *
 * Constants and pure functions over their arguments, with no runner state. A
 * leaf module: it imports nothing, and it must never import the fast runner,
 * which imports these names and re-exports them for its existing callers.
 */

/**
 * Tools that perform write/mutate actions — if the response claims success
 * for any of these categories but the tool was never called, it's hallucinated.
 */
export const WRITE_TOOLS = new Set([
  // WordPress
  "wp_publish",
  "wp_media_upload",
  "wp_delete",
  "wp_raw_api",
  "wp_plugins",
  "wp_settings",
  // Google Workspace (must stay in sync with write tools in GOOGLE_TOOLS)
  "gmail_send",
  "gsheets_write",
  "gdrive_create",
  "gdrive_share",
  "gdrive_delete",
  "gdrive_move",
  "gdrive_upload",
  "gdrive_download",
  "calendar_create",
  "calendar_update",
  "gdocs_write",
  "gdocs_replace",
  "gslides_create",
  "gtasks_create",
  // v7.6 gws dispatch: classified as write-capable because the `method`
  // param can be create/update/patch/delete. The hallucination guard will
  // flag any success claim that didn't actually invoke it. For read-only
  // LLM calls (method=list/get), the false-positive cost is minimal — the
  // tool still runs, it just gets tracked in the write-capable set.
  "google_workspace_cli",
  // v7.7.2 Layer 4b retry-swap fix: jarvis_propose_directive is not
  // strictly a "write" tool, but it IS a tool where narrating success
  // without calling it is a hallucination. Including it here lets the
  // fast-runner hallucination retry (`retryCalledWrite`) swap in the retry
  // output when the LLM finally calls the tool on the second pass. Same
  // rationale as google_workspace_cli above — the set tracks
  // "narrate = must-call".
  "jarvis_propose_directive",
  // File system
  "file_write",
  "file_edit",
  "file_delete",
  // Jarvis knowledge base
  "jarvis_file_write",
  "jarvis_file_update",
  "jarvis_file_delete",
  // Git / GitHub
  "git_commit",
  "git_push",
  "gh_repo_create",
  "gh_create_pr",
  "jarvis_dev",
  "vps_deploy",
  "jarvis_apply_proposal",
  // Other
  "schedule_task",
  "run_schedule",
  "delete_schedule",
  "user_fact_set",
  "user_fact_delete",
  "skill_save",
  "memory_store",
  "memory_forget",
  "shell_exec",
  // F1 finance writes (v7.0 Phase β)
  "market_watchlist_add",
  "market_watchlist_remove",
  "market_watchlist_reseed",
  // v7.13 KB ingestion writes (Phase β S5)
  "kb_ingest_pdf_structured",
  "kb_batch_insert",
  // F7 alpha combination write (Phase β S6) — persists to signal_weights + signal_isq
  "alpha_run",
  // F7.5 strategy backtester write (Phase β S10) — persists to backtest_runs/paths/overfit
  "backtest_run",
  // F8 paper trading write (Phase β S11) — persists to paper_fills/portfolio/balance + trade_theses
  "paper_rebalance",
  // F8.1a PM alpha write (β-addendum) — persists to pm_signal_weights
  "pm_alpha_run",
  // F8.1b PM paper trading write (β-addendum) — persists to pm_paper_fills/portfolio/balance + trade_theses
  "pm_paper_rebalance",
  // v7.10 file conversion — writes converted output to /tmp or /workspace.
  // Narrating "I converted the file to X" without the tool call is a
  // hallucination the WRITE_TOOLS guard catches.
  "file_convert",
  // v7.12 diagram generation — writes SVG/HTML output to /tmp or /workspace.
  // Same hallucination-guard rationale.
  "diagram_generate",
  // v7.14 infographic generation — writes SVG output via AntV SSR.
  "infographic_generate",
  // v7.1 chart rendering + patterns — render writes PNG to /tmp or /workspace;
  // patterns writes a row to chart_patterns (and may internally render first).
  "market_chart_render",
  "market_chart_patterns",
  // v7.11 teaching — state-mutating tools that insert into learning_plans,
  // learning_plan_units, learner_model, learning_sessions. learner_model_status
  // is read-only and NOT listed here.
  "learning_plan_create",
  "learning_plan_advance",
  "learning_plan_quiz",
  "learning_plan_explain_back",
  "learning_plan_summarize",
]);

/**
 * CCP4: Classify tool errors as transient (worth retrying) vs permanent
 * (should escalate to user). Prevents blind retry of auth failures, missing
 * resources, and permission errors.
 */
export function classifyToolError(
  errorText: string,
): "transient" | "permanent" {
  // Permanent: auth expired, permission denied, not found, invalid args
  if (
    /token.*expir|invalid.?grant|\b401\b|\b403\b|permission.?denied|not.?found|\b404\b|invalid.?argument|does not exist|no.?such/i.test(
      errorText,
    )
  ) {
    return "permanent";
  }
  // Transient: timeouts, rate limits, server errors, network issues
  if (
    /timeout|\b429\b|rate.?limit|too many|\b5\d{2}\b|econnreset|enotfound|fetch.?fail|abort/i.test(
      errorText,
    )
  ) {
    return "transient";
  }
  // Default: treat unknown errors as transient (give it one more shot)
  return "transient";
}

/**
 * Patterns that indicate the response claims a write/mutate action was performed.
 * Generic — covers all tool categories, not just WordPress.
 */
const WRITE_CLAIM_PATTERNS = [
  // Spanish first-person past tense write verbs
  /(?:escribí|actualicé|publiqué|subí|eliminé|borré|envié|configuré|instalé|activé|desactivé|limpié|creé|modifiqué|edité|guardé|programé|completé|empujé|commiteé|comiteé|hice\s+(?:push|commit))\s/i,
  // Tool-mediated subjects (unambiguous — these can't be "state descriptions")
  /(?:sheet|hoja|filas?|celdas?|email|correo|tarea|meta|goal|objetivo|evento|calendario).*(?:actualizada?s?|escrit[oa]s?|completad[oa]s?|enviad[oa]s?|eliminad[oa]s?|creada?s?|publicada?s?|guardada?s?|modificada?s?|subida?s?)/i,
  // Passive voice with explicit verb (catches "artículo fue publicado", "imagen fue subida")
  /(?:fue|fueron|ha sido|han sido)\s+(?:actualizada?s?|escrit[oa]s?|completad[oa]s?|enviad[oa]s?|eliminad[oa]s?|creada?s?|publicada?s?|guardada?s?|modificada?s?|subida?s?)/i,
  // Past participle + success adverb (catches "subida correctamente", "publicado exitosamente")
  /(?:actualizada?|escrit[oa]|completad[oa]|enviad[oa]|eliminad[oa]|creada?|publicada?|guardada?|modificada?|subida?)\s+(?:exitosamente|correctamente|con éxito|successfully)/i,
  // Quantity + action claims ("50 celdas actualizadas", "5 filas escritas")
  /\d+\s+(?:celdas?|filas?|rows?|cells?|entries?|registros?|artículos?|archivos?|eventos?)\s+(?:actualizada?s?|escrit[oa]s?|written|updated|created|deleted|sent|saved)/i,
  // English first-person claims
  /I\s+(?:wrote|updated|published|uploaded|deleted|sent|created|saved|edited|configured|installed|scheduled|cleaned|modified|pushed|committed)\s/i,
  // English passive claims
  /(?:has been|was|were)\s+(?:written|updated|published|uploaded|deleted|sent|created|saved|edited|configured|installed|scheduled)/i,
  // "Acción realizada" / "Acciones realizadas" (common hallucination opener)
  /accione?s?\s+realizada?s?/i,
];

/**
 * Detect hallucinated tool execution — LLM narrates actions without calling tools.
 *
 * Three detection layers:
 * 1. Full hallucination: success marker + write claim + zero tools
 * 2. Partial hallucination: claims write success but no write tool was called
 * 3. Narration patterns (processing steps, FTP claims, etc.)
 *
 * Returns true if the response looks like it's simulating execution.
 */
export function detectsHallucinatedExecution(
  text: string,
  toolsCalled: string[],
  userMessage?: string,
  failedWriteTools?: string[],
): boolean {
  const claimsWrite = WRITE_CLAIM_PATTERNS.some((p) => p.test(text));

  // --- Layer 0: Failed write tools ---
  // If a write tool was attempted and FAILED (returned error), and the response
  // claims success (✅), it's always a hallucination. The LLM tried, failed,
  // and narrates success — even passive voice ("Marcada como completed") is a
  // false claim here, not a legitimate status observation.
  if (failedWriteTools && failedWriteTools.length > 0) {
    const hasSuccessMarker =
      /✅|🚀|EXITOSAMENTE|SUCCESSFULLY|COMPLETADO|STATUS:\s*DONE\b/i.test(text);
    if (hasSuccessMarker) {
      console.log(
        `[fast-runner] Failed-write hallucination: write tools [${failedWriteTools.join(", ")}] failed but response claims success`,
      );
      return true;
    }
  }

  // --- Layer 1: Full hallucination (zero tools + write claim) ---
  // If no tools called at all and response claims a write action, it's hallucinated.
  if (toolsCalled.length === 0) {
    const hasSuccessMarker =
      /✅|🚀|EXITOSAMENTE|SUCCESSFULLY|COMPLETADO|STATUS:\s*DONE\b/i.test(text);
    if (hasSuccessMarker && claimsWrite) return true;

    // Also catch legacy concrete claims (URLs, file paths, FTP)
    const claimsLegacyConcrete =
      /https?:\/\/\S+\.(png|jpg|jpeg|gif|webp|html|php)/i.test(text) ||
      /\/(?:wp-content|tmp|var|home|workspace)\//i.test(text) ||
      /(?:vía|via|through)\s+(?:FTP|SSH|SFTP)/i.test(text) ||
      /\*[^*]*\.\.\.\*/.test(text);
    if (hasSuccessMarker && claimsLegacyConcrete) return true;

    // Layer 1b: Read hallucination — claims to have read/verified/reviewed
    // specific content without calling any tools. The LLM fabricates findings
    // from thread context or imagination instead of actually reading.
    const claimsRead =
      /(?:he revisado|revisando el contenido|leyendo el (?:archivo|contenido|artículo))/i.test(
        text,
      ) ||
      /(?:I (?:read|reviewed|checked|inspected|examined) the (?:file|article|content|post|page))/i.test(
        text,
      ) ||
      /\*?\((?:Leyendo|Buscando|Revisando|Analizando|Reading|Searching|Reviewing|Analyzing)[^)]*\)\*?/i.test(
        text,
      );
    const claimsVerificationResult =
      /(?:ENLACE (?:NO )?ENCONTRADO|LINK (?:NOT )?FOUND|no contiene (?:ningún )?enlace|does not contain (?:any )?link)/i.test(
        text,
      ) || /(?:❌|✅)\s*(?:ENLACE|LINK|VERIFICAD)/i.test(text);
    if (claimsRead && claimsVerificationResult) {
      console.log(
        `[fast-runner] Read hallucination: claims to have read/verified content but toolsCalled is empty`,
      );
      return true;
    }
  }

  // --- Layer 2: Partial hallucination (generic — all write tools) ---
  // LLM called SOME tools (e.g. gsheets_read, wp_list_posts) but narrated write
  // actions (gsheets_write, wp_publish, gmail_send) without calling them.
  // EXCEPTION: if the user asked to verify/check/confirm, the LLM is REPORTING
  // what it found using read tools — descriptive language about state is expected.
  // Risk carve-out (v7.6 Spine 1 G5): first-person past-tense write verbs
  // ("escribí", "actualicé", "I wrote") are NEVER reporting state — they're
  // claiming the LLM personally performed an action. They override both the
  // verification and read-request exemptions. Mirror of the W1 risk-carve-out
  // pattern shipped in confirmations.ts; high-risk operator-typed verbs
  // bypass ergonomic-relief gates.
  //
  // Negation guard (round-1 audit C1, round-2 audit W1, 2026-05-08): the ES
  // regex MUST exclude common Spanish negation forms preceding a 1st-person
  // past-tense verb. Coverage:
  //   - "no escribí"            → `no`
  //   - "ni escribí ni borré"   → `ni`        (correlative; round-2 W1)
  //   - "nunca actualicé"       → `nunca`
  //   - "tampoco subí"          → `tampoco`
  //   - "jamás envié"           → `jam[aá]s`
  //   - "ni siquiera escribí"   → `siquiera`  (siquiera carries the negation
  //                                          when ni precedes it earlier)
  // JS variable-width lookbehind handles `(?<!\bno\s+)` on Node ≥22 (V8 ≥6.2,
  // shipped 2018). Repo `engines.node` floor is "22.0.0".
  // The EN side is structurally safe — the literal `I\s+` anchor doesn't
  // match "I didn't" or "I never". \b start anchor on both regexes prevents
  // within-word false positives.
  const FIRST_PERSON_WRITE_RE =
    /(?<!\b(?:no|ni|nunca|tampoco|jam[aá]s|siquiera)\s+)\b(?:escribí|actualicé|publiqué|subí|eliminé|borré|envié|configuré|instalé|activé|desactivé|limpié|creé|modifiqué|edité|guardé|programé|completé|marqué|empujé|commiteé|comiteé|hice\s+(?:push|commit))\s/i;
  const FIRST_PERSON_WRITE_EN_RE =
    /\bI\s+(?:wrote|updated|published|uploaded|deleted|sent|created|saved|edited|pushed|committed)\s/i;
  const calledAnyWriteTool = toolsCalled.some((t) => WRITE_TOOLS.has(t));
  const isVerificationRequest = userMessage
    ? /\b(verifica|verificar|confirma|confirmar|revisa|revisar|check|verify|confirm|comprueba|comprobar|existen|existe|están|registrad[oa]s?|ves|aparece|no las veo|no lo veo|puedes ver)\b/i.test(
        userMessage,
      )
    : false;
  // Read/list/query/diagnostic requests: the LLM is reporting state, not claiming writes
  const isReadRequest = userMessage
    ? /\b(lista|listar|list|cu[aá]les|muestra|mostrar|show|dame|dime|qu[eé]\s+(hay|tareas?|metas?|objetivos?|visio)|report[ae]|describe|consulta|status|estado|diagnos|fallo|fail|error|histor|qué\s+pas[oó]|why\s+did|what\s+happened)\b/i.test(
        userMessage,
      )
    : false;

  // First-person carve-out: even on verify/read requests, a first-person past-
  // tense write claim with no write tool called is a hallucination.
  const hasFirstPersonWriteClaim =
    !calledAnyWriteTool &&
    toolsCalled.length > 0 &&
    (FIRST_PERSON_WRITE_RE.test(text) || FIRST_PERSON_WRITE_EN_RE.test(text));
  if (hasFirstPersonWriteClaim) {
    console.log(
      `[fast-runner] First-person hallucination: write claim ("escribí"/"I wrote" class) but no write tool called. Tools: [${toolsCalled.join(", ")}]`,
    );
    return true;
  }

  if (
    !calledAnyWriteTool &&
    toolsCalled.length > 0 &&
    !isVerificationRequest &&
    !isReadRequest
  ) {
    const claimsAction =
      // First-person past tense (always hallucination)
      FIRST_PERSON_WRITE_RE.test(text) ||
      FIRST_PERSON_WRITE_EN_RE.test(text) ||
      // Git-specific claims (Spanish + English)
      /(?:PUSH|COMMIT)\s+EXITOSO/i.test(text) ||
      /(?:push|commit)\s+\w*\s*(?:exitosamente|correctamente|con éxito|successfully)/i.test(
        text,
      ) ||
      /(?:cambios|changes)\s+\S*\s*(?:subidos?|pushed|enviados?)\s+(?:a|to)\s+(?:GitHub|origin|remote)/i.test(
        text,
      ) ||
      // Passive + success adverb (claim, not observation)
      /(?:fue|fueron|ha sido|han sido)\s+\w+\s*(?:exitosamente|correctamente|con éxito|successfully)/i.test(
        text,
      ) ||
      /(?:was|were|has been|have been)\s+\w+\s*(?:successfully|correctly)/i.test(
        text,
      ) ||
      /(?:publicad[oa]|enviad[oa]|subid[oa]|creada?|eliminad[oa]|compartid[oa]|guardad[oa]|programad[oa]|configurad[oa]|sincronizad[oa])\s+(?:exitosamente|correctamente|con éxito|successfully)/i.test(
        text,
      ) ||
      // Status change claims — must have first-person anchor or active voice
      // "marqué como completada" or "la marcamos como done" = hallucination
      // "está marcada como completada" = observation from read tool (allowed)
      /(?:marqué|marcamos|marc[oó])\s+(?:como\s+)?(?:complet|hech|done|termin)/i.test(
        text,
      ) ||
      // Passive participle with ✅ prefix — action claim, not observation.
      // "✅ Marcada como completed" = hallucinated write (no tool called)
      // "✅ Eliminada (no existe)" = hallucinated delete
      // vs "La tarea está marcada como completada" = read observation (no ✅)
      /✅[^.\n]{0,30}(?:Marcad[ao]s?|Eliminad[ao]s?|Actualizada?s?|Cambiad[ao]s?|Borrad[ao]s?|Cread[ao]s?|Modificad[ao]s?|Completad[ao]s?|Compartid[ao]s?|Enviad[ao]s?|Publicad[ao]s?|Guardad[ao]s?)/i.test(
        text,
      ) ||
      // "Acciones Ejecutadas" header — narrated action table
      /accione?s?\s+ejecutadas?/i.test(text) ||
      // NOTE: "status[:\s]+completed" was removed (v6.4 OH2) — it's a data label
      // from diagnostic tools (task_history, list_schedules), not a write claim.
      // Real status-change claims are caught by first-person ("marqué como completada")
      // and ✅-participle patterns.
      // Quantity claims ("50 celdas actualizadas")
      /\d+\s+(?:celdas?|filas?|rows?|cells?)\s+(?:actualizada?s?|escrit[oa]s?|written|updated)/i.test(
        text,
      ) ||
      // "Acciones realizadas" opener
      /accione?s?\s+realizada?s?/i.test(text);
    if (claimsAction) {
      console.log(
        `[fast-runner] Partial hallucination: write claim but no write tool called. Tools: [${toolsCalled.join(", ")}]`,
      );
      return true;
    }
  }

  // --- Layer 3: Impossible narration (always fire) ---
  // Narrating fake process steps (FTP connections, handshakes, ellipsis progress)
  // is always hallucinated — no tool produces these outputs.
  const impossibleNarration = [
    /\*?\((?:Procesando|Ejecutando|Conectando|Subiendo|Descargando|Verificando|Generando|Escaneando|Publicando|Guardando)[^)]*\.\.\.\)\*?/i,
    /\*?\((?:Processing|Executing|Connecting|Uploading|Downloading|Verifying|Generating|Scanning|Publishing|Saving)[^)]*\.\.\.\)\*?/i,
    /(?:Conexión exitosa|Handshake completado|Upload exitoso)/i,
    /(?:Conexión\s+(?:FTP|SSH|SFTP)).*(?:exitosa|establecida|OK)/i,
    /(?:FTP\s+connection|SSH\s+connection|SFTP\s+connection).*(?:successful|established|OK)/i,
  ];
  if (impossibleNarration.some((p) => p.test(text))) return true;

  // --- Layer 4: Domain-specific claim mismatch ---
  // Claims about git/PR/branch/push/commit are only valid if git tools were called.
  // Jarvis can write a file to KB (jarvis_file_write) and claim "PR CREADO" —
  // the write tool call makes Layer 2 pass, but the claim domain (git) doesn't
  // match the tool domain (KB). This catches that specific hallucination pattern.
  const GIT_TOOLS = new Set([
    "git_status",
    "git_diff",
    "git_commit",
    "git_push",
    "gh_repo_create",
    "gh_create_pr",
  ]);
  const calledAnyGitTool = toolsCalled.some((t) => GIT_TOOLS.has(t));
  if (!calledAnyGitTool) {
    const claimsGitAction =
      /\bPR\s+CREAD[OA]\b/i.test(text) ||
      /\bPR\s+(?:created|opened|submitted)\b/i.test(text) ||
      /\b(?:branch|rama)\s+(?:cread[oa]|created|pushed)\b/i.test(text) ||
      /\b(?:PUSH|COMMIT)\s+(?:EXITOSO|exitosamente|correctamente|successfully)\b/i.test(
        text,
      ) ||
      /\bhttps:\/\/github\.com\/\S+\/pull\/\d+/i.test(text) ||
      /\bgh\s+pr\s+create\b/i.test(text);
    if (claimsGitAction) {
      console.log(
        `[fast-runner] Git claim hallucination: claims PR/branch/push but no git tool called. Tools: [${toolsCalled.join(", ")}]`,
      );
      return true;
    }
  }

  // --- Layer 4b: Directive-cooldown claim mismatch ---
  // SG4 enforces a 48h cooldown on jarvis_propose_directive. The LLM "knows"
  // the safeguard exists and will sometimes narrate specific cooldown timing
  // ("próxima propuesta en ~15h", "33h ago", "Next allowed in 14.6h") without
  // actually calling the tool to verify. That's a hallucination even when the
  // numbers happen to be close — the process is wrong. Flag and retry so the
  // LLM is forced to call jarvis_propose_directive and echo its real response.
  const calledProposeDirective = toolsCalled.includes(
    "jarvis_propose_directive",
  );
  if (!calledProposeDirective) {
    // Unit token matching minutes / hours / days, spelled-out or short form,
    // Spanish or English: `h`, `hr`, `hrs`, `hour`, `hours`, `hora`, `horas`,
    // `m`, `min`, `mins`, `minuto`, `minutos`, `d`, `day`, `days`, `día`, `días`.
    const NUM = String.raw`\d+(?:[.,]\d+)?`; // allow comma or dot decimal separator
    const UNIT = String.raw`(?:h(?:ours?|rs?|oras?)?|m(?:in(?:ut(?:es?|os?))?)?|d(?:ays?|[ií]as?)?)`;
    const NUM_UNIT = new RegExp(`\\b${NUM}\\s*${UNIT}\\b`, "i");
    const PROP_KEYS = /\b(?:propuesta|directiv|cooldown)/i; // keyword anchor for co-occurrence checks
    // Helper: does the text contain both a numeric-time claim and a
    // propuesta/directiva/cooldown keyword within ~80 chars of each other?
    const hasNearbyNumericTime = (() => {
      const numMatch = NUM_UNIT.exec(text);
      if (!numMatch) return false;
      const propMatch = PROP_KEYS.exec(text);
      if (!propMatch) return false;
      const distance = Math.abs((numMatch.index ?? 0) - (propMatch.index ?? 0));
      return distance <= 120;
    })();

    const claimsDirectiveCooldown =
      // Explicit cooldown-state phrases (these are always hallucinations
      // without the tool call, regardless of numeric co-occurrence):
      /\bcooldown\s+(?:active|activo|activa)\b/i.test(text) ||
      /\b(?:pr[oó]xima|next)\s+(?:propuesta|proposal)\s+(?:disponible\s+)?(?:en|in)\s+~?\d/i.test(
        text,
      ) ||
      /\bpropuesta\s+(?:de\s+directiva\s+)?en\s+(?:cola|cooldown)\b/i.test(
        text,
      ) ||
      /\bnext\s+allowed\s+in\s+\d/i.test(text) ||
      /\blast\s+proposal\s+was\s+\d/i.test(text) ||
      // Spanish "faltan/restan/quedan X unidad" near propuesta/cooldown/directiv
      /\b(?:quedan|faltan|restan)\s+\d+(?:[.,]\d+)?\s*(?:h(?:oras?)?|m(?:in(?:utos?)?)?|d(?:[ií]as?)?)\b[^.\n]{0,80}\b(?:propuesta|cooldown|directiv)/i.test(
        text,
      ) ||
      /\b(?:propuesta|cooldown|directiv)[^.\n]{0,80}\b(?:quedan|faltan|restan)\s+\d+(?:[.,]\d+)?\s*(?:h(?:oras?)?|m(?:in(?:utos?)?)?|d(?:[ií]as?)?)\b/i.test(
        text,
      ) ||
      // English "available in X units" / "in X units" near proposal/cooldown
      /\b(?:available|allowed|ready)\s+(?:in|again\s+in)\s+\d+(?:[.,]\d+)?\s*(?:h(?:ours?|rs?)?|m(?:in(?:utes?)?)?|d(?:ays?)?)\b[^.\n]{0,80}\b(?:proposal|cooldown|directive)/i.test(
        text,
      ) ||
      /\b(?:proposal|cooldown|directive)[^.\n]{0,80}\b(?:available|allowed|ready)\s+(?:in|again\s+in)\s+\d+(?:[.,]\d+)?\s*(?:h(?:ours?|rs?)?|m(?:in(?:utes?)?)?|d(?:ays?)?)\b/i.test(
        text,
      ) ||
      // Fallback: numeric-time claim + propuesta/directiv/cooldown keyword
      // within ~120 chars. Catches paraphrases like "handle en 2 días, check
      // el estado de la propuesta" and "the directive window reopens in 45 min".
      hasNearbyNumericTime;

    if (claimsDirectiveCooldown) {
      console.log(
        `[fast-runner] Directive cooldown hallucination: narrates SG4 state but jarvis_propose_directive not called. Tools: [${toolsCalled.join(", ")}]`,
      );
      return true;
    }
  }

  // --- Layer 3b: Completion claims (only fire when NO write tools called) ---
  // "acabo de actualizar", "he verificado", "just updated" are legitimate when
  // the LLM actually called write tools. Only flag when tools weren't called.
  if (!calledAnyWriteTool) {
    const completionClaims = [
      /(?:he verificado|acabo de verificar|confirmado en tiempo real)/i,
      /acabo de (?:ejecutar|publicar|subir|crear|guardar|actualizar|inyectar|instalar|configurar)/i,
      /(?:ya está|ya queda)\s+(?:live|publicado|en línea|activo|guardado)/i,
      /(?:just (?:executed|published|uploaded|created|saved|updated|verified))/i,
      /(?:is now live|is now published|has been published)/i,
    ];
    if (completionClaims.some((p) => p.test(text))) return true;
  }

  return false;
}
