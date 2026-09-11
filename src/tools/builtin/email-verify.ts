/**
 * email_verify — SMTP mailbox verification without sending mail.
 *
 * TypeScript closed-box port (and hardening) of reacherhq/check-if-email-exists:
 * syntax → MX → governed SMTP RCPT TO probe → verdict. Engine lives in
 * `src/email-verify/`; this file is only the LLM-facing surface.
 */

import { defineTool } from "../define-tool.js";
import { errMsg } from "../../lib/err-msg.js";
import { getSharedVerifier, type VerifyResult } from "../../email-verify/index.js";

const MAX_BATCH = 100;
/** `verbose` rows are ~420 bytes each; above this many addresses the compact form is forced. */
const MAX_VERBOSE = 10;

function compact(r: VerifyResult): Record<string, unknown> {
  return {
    email: r.email,
    verdict: r.verdict,
    reason: r.reason,
    ...(r.syntax.suggestion ? { suggestion: r.syntax.suggestion } : {}),
    ...(r.mx.provider ? { provider: r.mx.provider } : {}),
    ...(r.smtp?.catchAll ? { catch_all: true } : {}),
    ...(r.misc.roleAccount ? { role_account: true } : {}),
    ...(r.note ? { note: r.note } : {}),
  };
}

export const emailVerifyTool = defineTool({
  name: "email_verify",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  deferred: true,
  triggerPhrases: [
    "verifica este correo",
    "¿existe este email?",
    "valida esta lista de correos",
    "check if this email exists",
    "limpia la lista antes de enviar",
  ],
  description: `Check whether email addresses exist WITHOUT sending mail: syntax → MX → SMTP "RCPT TO" probe of the recipient's mail server. Verdict per address:
- safe: mailbox accepted, nothing lowers confidence
- risky: deliverable but catch-all domain, role account (info@, ventas@…), full inbox, or disposable domain
- invalid: bad syntax, no mail server, or the server rejected the mailbox
- unknown: no trustworthy answer (greylisted, our IP refused, host unreachable, daily cap, circuit open) — "not proven bad"

USE WHEN: cleaning an outreach list before a campaign (drop invalid, review risky); user asks if an address is real / will bounce; fixing typos (a "suggestion" field appears for domains near a known provider).
DO NOT USE WHEN: only format validation is needed — pass skip_smtp:true (no mail server contacted); the user wants to SEND mail (this never sends); the list exceeds ${MAX_BATCH} addresses — split it.

EDGE CASES:
- Every probe leaves this server's mail IP; a daily cap and a circuit breaker apply. On daily_cap_reached, circuit_open or misconfigured, stop and tell the user — never retry in a loop. A call is bounded to 4 min; leftover rows say batch_deadline (re-run just those).
- reason "greylisted" usually resolves when re-run 10-15 min later.
- Own mail domain addresses return unknown (own-host) by design.
- safe/risky/invalid are cached 24 h per address; unknown is re-probed and costs budget.
- Rows are keyed by "email" in domain-interleaved order, not input order.`,
  parameters: {
    type: "object",
    properties: {
      emails: {
        type: "array",
        items: { type: "string" },
        description: `Email addresses to verify (1-${MAX_BATCH}). Duplicates are removed.`,
      },
      skip_smtp: {
        type: "boolean",
        description: "true = syntax + MX + disposable/role lists only; never connects to a mail server. Default false.",
      },
      catch_all_probe: {
        type: "boolean",
        description: "false = skip the random-address catch-all check (one fewer RCPT TO per domain; catch-all domains then look 'safe'). Default true.",
      },
      verbose: {
        type: "boolean",
        description: `true = full detail per address (MX hosts, SMTP reply code/text, timings); honoured only for lists of ${MAX_VERBOSE} addresses or fewer. Default false = compact rows.`,
      },
    },
    required: ["emails"],
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const raw = args.emails;
    const emails = (Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [])
      .filter((e): e is string => typeof e === "string" && e.trim().length > 0);
    if (emails.length === 0) return JSON.stringify({ error: "emails must contain at least one address" });
    if (emails.length > MAX_BATCH) {
      return JSON.stringify({ error: `too many addresses (${emails.length}); max ${MAX_BATCH} per call — split the list` });
    }

    try {
      const verifier = getSharedVerifier();
      const { results, summary } = await verifier.verifyMany(emails, {
        skipSmtp: args.skip_smtp === true,
        catchAllProbe: args.catch_all_probe !== false,
      });
      const budget = verifier.governor.usage();
      const halted = results.find(
        (r) => ["daily_cap_reached", "circuit_open", "batch_deadline"].includes(r.reason) || r.reason.startsWith("misconfigured"),
      );
      return JSON.stringify({
        summary,
        budget,
        ...(halted ? { halted: halted.reason } : {}),
        results: args.verbose === true && results.length <= MAX_VERBOSE ? results : results.map(compact),
        ...(args.verbose === true && results.length > MAX_VERBOSE ? { note: `verbose ignored above ${MAX_VERBOSE} addresses` } : {}),
      });
    } catch (err) {
      return JSON.stringify({ error: `email verification failed: ${errMsg(err)}` });
    }
  },
});
