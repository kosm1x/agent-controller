/**
 * Shared confirmation/decline verb vocabulary.
 *
 * Two parallel CONFIRM_PATTERN regexes existed before v7.6 Spine 1:
 *   - messaging/confirmations.ts (pending-tool re-execution flow)
 *   - runners/fast-runner.ts:104 (deletion confirmation flow)
 * They diverged silently — neither covered the natural Spanish imperative-clitic
 * replies users produce in response to LLM-asked confirmation questions like
 * "¿Subo el archivo?" / "¿Creo el evento?" / "¿Lanzo el experimento?". This
 * is the producer/consumer mismatch class the v7.6 gatekeeper audit was built
 * to find. See `docs/audit/v7.6-gatekeepers.md` F5.
 *
 * Both call sites now compose their own anchored regex from these shared
 * fragments. Add new verbs here when a new confirmation-eliciting tool ships.
 */

/** Generic affirmation tokens (sí, ok, yes, etc.).
 *
 * Audit C1 fix (2026-05-08): `va` and `go` were removed because they over-fire
 * on incidental utterances ("va para allá", "go away"). Both have safer
 * alternatives — `vale` (Spanish) is in lax-only via ACTION; `go ahead` is
 * already in EN. Strict mode draws only from this set, so this list MUST
 * stay unambiguous.
 */
export const GENERIC_CONFIRM_SRC =
  "s[ií]|claro|ok|okey|confirmo|yes|confirm|approved?|por\\s*favor";

/** Generic action confirmation (dale, hazlo, procede, adelante, etc.).
 *
 * `vale` lives here (not GENERIC) because it can appear mid-sentence as a
 * filler ("vale, pero antes...") — same reason `va`/`go` were removed.
 * Lax-mode only.
 */
export const ACTION_CONFIRM_SRC =
  "dale|vale|hazlo|haz(?:lo)?|procede|proced(?:elo|ela|elos|elas)|proceed|adelante|ejecuta|do\\s*it|go\\s*ahead";

/**
 * Spanish imperative + clitic forms.
 *
 * Pattern: stem + (al[oa]s? | el[oa]s? | lo | la | los | las).
 * Examples:
 *   subir   → súbelo, súbela, súbelos, súbelas
 *   crear   → créalo, créala
 *   lanzar  → lánzalo, lánzala
 *   borrar  → bórralo, bórrala, bórralos, bórralas
 *   enviar  → envíalo, envíala
 *
 * Stems are listed with accent + non-accent variants because users often
 * type without accents on mobile keyboards. The full word includes the accent.
 *
 * IMPORTANT: every verb here is one that a tool description elicits as a
 * confirmation question. When a new confirmation-requiring tool ships, audit
 * its prompt forms and extend this list.
 */
export const CLITIC_CONFIRM_SRC =
  "(?:" +
  [
    "s[uú]b", // subir
    "cr[eé]", // crear
    "l[aá]nz", // lanzar
    "tr[aá]", // traer
    "gu[aá]rd", // guardar
    "agr[eé]g", // agregar
    "a[ñn][aá]d", // añadir
    "c[aá]mbi", // cambiar
    "modif[ií]c", // modificar
    "escr[ií]b", // escribir
    "actual[ií]z", // actualizar → actualízalo
    "progr[aá]m", // programar
    "desc[aá]rg", // descargar
    "comp[aá]rt", // compartir
    "publ[ií]c", // publicar
    "notif[ií]c", // notificar
    "env[ií]", // enviar
    "m[aá]nd", // mandar
    "b[oó]rr", // borrar
    "elim[ií]n", // eliminar
    "qu[ií]t", // quitar
    "remu[eé]v", // remover → remuévelo
    "p[aá]ut", // pautar (publicar agendado)
    "habil[ií]t", // habilitar
    "deshabil[ií]t", // deshabilitar
    "act[ií]v", // activar
    "desact[ií]v", // desactivar
  ].join("|") +
  ")(?:al[oa]s?|el[oa]s?|lo|la|los|las)";

/** English imperatives that act as confirmations. */
export const EN_CONFIRM_SRC = "send\\s*it|do\\s*it|go\\s*ahead";

/**
 * Destructive-aligned clitic stems — verbs that semantically MATCH a
 * destructive operation. When the LLM asks "¿Borro la tarea?" and the user
 * replies "Bórralo", that is an unambiguous destructive confirmation: the
 * reply verb matches the proposed op type.
 *
 * Audit C2 fix (2026-05-08): strict mode initially rejected ALL clitic forms,
 * which was a UX regression — legitimate destructive confirmations like
 * `Bórralo` silently failed. The fix: strict mode now accepts clitics from
 * THIS subset only (verbs aligned with destructive semantics), so non-aligned
 * clitics like `Súbelo` (upload) still cannot accidentally confirm a delete.
 */
export const DESTRUCTIVE_CLITIC_CONFIRM_SRC =
  "(?:" +
  [
    "b[oó]rr", // borrar
    "elim[ií]n", // eliminar
    "qu[ií]t", // quitar
    "remu[eé]v", // remover
    "desact[ií]v", // desactivar
    "deshabil[ií]t", // deshabilitar
  ].join("|") +
  ")(?:al[oa]s?|el[oa]s?|lo|la|los|las)";

/** Decline verbs (Spanish + English). */
export const DECLINE_SRC =
  "no|cancela(?:do)?|para|detente|stop|nope|nel|mejor\\s*no|olv[ií]da(?:lo)?|don.?t|never\\s*mind";

/**
 * Compose a confirmation regex anchored at start-of-string + word-boundary.
 *
 * @param mode "lax" (default — full vocabulary) | "strict" (destructive ops)
 *
 * **Lax** = generic + action verbs + every clitic form + EN. Used for normal
 * pending confirmations (gmail_send, gdrive_upload, etc.).
 *
 * **Strict** = generic affirmations + destructive-aligned clitic stems only.
 * Used when the pending tool has `destructiveHint: true`. The action verbs
 * `dale/hazlo/procede` are excluded (incidental utterance risk), and only
 * clitic stems aligned with destructive semantics are accepted (so `Bórralo`
 * still confirms a delete, but `Súbelo` cannot — verb/op mismatch).
 */
export function buildConfirmRegex(mode: "lax" | "strict" = "lax"): RegExp {
  const parts =
    mode === "strict"
      ? [GENERIC_CONFIRM_SRC, DESTRUCTIVE_CLITIC_CONFIRM_SRC]
      : [
          GENERIC_CONFIRM_SRC,
          ACTION_CONFIRM_SRC,
          CLITIC_CONFIRM_SRC,
          EN_CONFIRM_SRC,
        ];
  return new RegExp(`^(?:${parts.join("|")})(?:\\s|$|[.,!?])`, "i");
}

/** Compose the decline regex. Same shape on both lax and strict — declines
 * are conservative; "no" or "cancela" mean the same thing in any context. */
export function buildDeclineRegex(): RegExp {
  return new RegExp(`^(?:${DECLINE_SRC})(?:\\s|$|[.,!?])`, "i");
}
