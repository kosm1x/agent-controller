# /loop unlimited task — R1 audit (2026-08-27): FAIL, 2 Critical, folded same session

- C1: the feature was unreachable on Telegram — `telegram.ts` `message:text` returns on `startsWith("/")` before `messageHandler`. The sibling `/rituales` regex makes the slash optional; that IS the tell. Fold: `LOOP_RE = /^\/?loop\b…/`.
- C2: lifting the SDK 15-min timer left the router's 11/20-min abandon timer, which deletes `pendingReplies[taskId]` — the ONLY holder of the `AbortController`. After it fired, "Para" was a no-op and the result was discarded. Fold: `armPendingTimers({unlimited})` never abandons; a 10-min "Sigo en /loop" interval is the progress surface.
- Warnings folded: day-log ordering (W1), sandbox-invariant suspension documented (W2), Telegram/WhatsApp-only gate (W3), `[Grupo:]` header (W4), claude-sdk timer test (W5), already-aborted signal (W6), nudge (W7), `[MODO /loop]` filter rule (R1), resume leg cap (R2).
- Method that found C2: for "the only remaining bound is X" claims, list every timer on the path and what it DELETES.
