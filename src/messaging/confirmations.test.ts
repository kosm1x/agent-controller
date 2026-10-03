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
    "alto",
    "para ya",
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

  // C4 fix (round 2): bare `para` is the Spanish preposition, not a decline.
  // Regression-guard so a future "let's add common words back" doesn't
  // resurrect the false-decline class.
  it.each(["para mí", "para allá", "para que veas", "para él"])(
    "rejects '%s' as decline (C4 — Spanish preposition)",
    (text) => {
      expect(detectConfirmationResponse(text)).toBeNull();
    },
  );

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

    // Op-indifferent action verbs DO confirm in strict mode — they mean
    // "go ahead with whatever you proposed" regardless of op type. Refined
    // round-2 audit: dropping them was a regression on the deletion two-step
    // where users naturally reply "Dale" to "¿Confirmo la eliminación?".
    it.each(["dale", "hazlo", "procede", "adelante", "ejecuta"])(
      "op-indifferent action verb '%s' confirms in strict mode",
      (text) => {
        expect(detectConfirmationResponse(text, { strict: true })).toBe(
          "confirm",
        );
      },
    );

    it.each([
      // Non-destructive clitic forms must NOT confirm a destructive op —
      // verb/op-type mismatch (e.g. "Súbelo" replying to a delete prompt).
      "súbelo", // upload verb to delete op = mismatch
      "lánzalo", // launch verb to delete op = mismatch
      "créalo", // create verb to delete op = mismatch
      "envíalo", // send verb to delete op = mismatch
      "guárdalo", // save verb to delete op = mismatch
    ])(
      "rejects non-destructive clitic '%s' in strict mode (verb/op mismatch)",
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

  // --- F5 audit fix: reply vocabulary by op family ---
  // W1 round-2 audit fix: this is NOT a true producer/consumer coupling test
  // (it doesn't run the LLM-side prompts through any producer code path).
  // It pins a representative reply corpus per op family so the consumer regex
  // stays comprehensive. A real coupling test would extract LLM-prompt strings
  // from tool descriptions and assert each elicits at least one matching reply.
  // Tracked as W1 in `docs/audit/v7.6-gatekeepers.md`.
  describe("reply vocabulary by op family", () => {
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

  // --- R2 round-2 audit fix: syntactic guards on regex source ---
  // Trip CI if a future "just add the verb back" diff re-introduces the
  // bugs the round-2 audit caught.
  describe("regex source syntactic guards (round-2 audit R2)", () => {
    it("strict mode does NOT contain non-destructive clitic stems", async () => {
      const { buildConfirmRegex } = await import("./confirmation-verbs.js");
      const src = buildConfirmRegex("strict").source;
      // Non-destructive clitic stems that must NOT appear in strict mode.
      // If any future diff adds them back, this test fails.
      const nonDestructiveStems = [
        "s[uú]b", // subir
        "cr[eé]", // crear
        "l[aá]nz", // lanzar
        "tr[aá]", // traer
        "gu[aá]rd", // guardar
        "agr[eé]g", // agregar
        "modif[ií]c", // modificar
        "escr[ií]b", // escribir
        "actual[ií]z", // actualizar
        "env[ií]", // enviar
        "m[aá]nd", // mandar
      ];
      for (const stem of nonDestructiveStems) {
        expect(src).not.toContain(stem);
      }
    });

    it("strict mode DOES contain destructive-aligned clitic stems", async () => {
      const { buildConfirmRegex } = await import("./confirmation-verbs.js");
      const src = buildConfirmRegex("strict").source;
      const destructiveStems = ["b[oó]rr", "elim[ií]n", "qu[ií]t"];
      for (const stem of destructiveStems) {
        expect(src).toContain(stem);
      }
    });

    it("decline regex does NOT contain bare 'para' (C4 — Spanish preposition)", async () => {
      const { buildDeclineRegex } = await import("./confirmation-verbs.js");
      const src = buildDeclineRegex().source;
      // Bare `para` would be `|para|` (alternation-bounded); the compound
      // `para\s+ya` is allowed.
      expect(src).not.toMatch(/\|para\|/);
      expect(src).toMatch(/para\\s\+ya/);
    });
  });
});

// ---------------------------------------------------------------------------
// Durable approval records (2026-09-12) — real :memory: DB, not mocked.
// ---------------------------------------------------------------------------

import { beforeEach, vi } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import {
  _resetPendingConfirmationsForTests,
  argsSha256,
  resolvePendingConfirmation,
} from "./confirmations.js";

interface Row {
  id: number;
  tool: string;
  args_sha256: string;
  decision: string;
  approver: string | null;
  decided_at: string | null;
  requested_at: string;
}

function rows(tk: string): Row[] {
  return getDatabase()
    .prepare(
      "SELECT id, tool, args_sha256, decision, approver, decided_at, requested_at FROM tool_approvals WHERE thread_key = ? ORDER BY id",
    )
    .all(tk) as Row[];
}

describe("tool_approvals durability", () => {
  const tk = "telegram:12345";
  const args = { to: "a@b.mx", subject: "Hola", body: "x" };

  beforeEach(() => {
    initDatabase(":memory:");
    _resetPendingConfirmationsForTests();
  });

  afterEach(() => {
    _resetPendingConfirmationsForTests();
    closeDatabase();
    vi.restoreAllMocks();
  });

  it("writes a pending row bound to the args hash", () => {
    storePendingConfirmation(tk, "gmail_send", args, "gmail_send(to: a@b.mx)");
    const r = rows(tk);
    expect(r).toHaveLength(1);
    expect(r[0].decision).toBe("pending");
    expect(r[0].args_sha256).toBe(argsSha256(args));
    expect(getPendingConfirmation(tk)?.approvalId).toBe(r[0].id);
  });

  it("W-C: the stored summary keeps every key field (no 500-char cut of the rendered line)", () => {
    const wide = {
      to: "a".repeat(200),
      cc: "c".repeat(200),
      bcc: "b".repeat(200),
      subject: "s".repeat(200),
      body: "y".repeat(500),
    };
    const summary = renderConfirmationSummary("gmail_send", wide);
    expect(summary.length).toBeGreaterThan(500);
    storePendingConfirmation(tk, "gmail_send", wide, summary);
    const row = getDatabase()
      .prepare("SELECT summary FROM tool_approvals WHERE thread_key = ?")
      .get(tk) as { summary: string };
    expect(row.summary).toBe(summary);
  });

  it("argsSha256 is key-order insensitive and value sensitive", () => {
    expect(argsSha256({ a: 1, b: [1, { c: 2 }] })).toBe(argsSha256({ b: [1, { c: 2 }], a: 1 }));
    expect(argsSha256({ to: "a@b.mx" })).not.toBe(argsSha256({ to: "a@b.mx " }));
  });

  it("confirming records approver + decided_at and returns the exact operation", () => {
    storePendingConfirmation(tk, "gmail_send", args, "s");
    const approved = resolvePendingConfirmation(tk, "confirmed", "sender-42");
    expect(approved?.toolName).toBe("gmail_send");
    expect(approved?.args).toEqual(args);
    const [r] = rows(tk);
    expect(r.decision).toBe("confirmed");
    expect(r.approver).toBe("sender-42");
    expect(r.decided_at).not.toBeNull();
    expect(getPendingConfirmation(tk)).toBeNull();
  });

  it("declining closes the row and returns null", () => {
    storePendingConfirmation(tk, "gmail_send", args, "s");
    expect(resolvePendingConfirmation(tk, "declined", "sender-42")).toBeNull();
    expect(rows(tk)[0].decision).toBe("declined");
    expect(getPendingConfirmation(tk)).toBeNull();
  });

  it("survives a restart: the map is empty but the pending row rehydrates", () => {
    storePendingConfirmation(tk, "gmail_send", args, "s");
    _resetPendingConfirmationsForTests(); // simulate process restart
    const p = getPendingConfirmation(tk);
    expect(p?.toolName).toBe("gmail_send");
    expect(p?.args).toEqual(args);
    const approved = resolvePendingConfirmation(tk, "confirmed", "sender-42");
    expect(approved?.args).toEqual(args);
    expect(rows(tk)[0].decision).toBe("confirmed");
  });

  it("an expired row does not rehydrate and is closed as expired", () => {
    storePendingConfirmation(tk, "gmail_send", args, "s");
    getDatabase()
      .prepare("UPDATE tool_approvals SET requested_at = '2026-01-01T00:00:00.000Z' WHERE thread_key = ?")
      .run(tk);
    _resetPendingConfirmationsForTests();
    expect(getPendingConfirmation(tk)).toBeNull();
    expect(rows(tk)[0].decision).toBe("expired");
  });

  it("a mutated pending op never executes: hash mismatch → null + superseded", () => {
    storePendingConfirmation(tk, "gmail_send", args, "s");
    const pending = getPendingConfirmation(tk)!;
    (pending.args as Record<string, unknown>).to = "attacker@evil.mx"; // tamper in place
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolvePendingConfirmation(tk, "confirmed", "sender-42")).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(rows(tk)[0].decision).toBe("superseded");
  });

  it("a decision stamps only the row the user saw, even if an older row is still pending (W-2)", () => {
    storePendingConfirmation(tk, "gmail_send", args, "s1");
    // Simulate a lost supersede write: force the first row back to pending.
    getDatabase().prepare("UPDATE tool_approvals SET decision = 'pending' WHERE thread_key = ?").run(tk);
    storePendingConfirmation(tk, "jarvis_file_delete", { path: "NorthStar/vision.md" }, "s2");
    getDatabase().prepare("UPDATE tool_approvals SET decision = 'pending' WHERE thread_key = ?").run(tk);
    const approved = resolvePendingConfirmation(tk, "confirmed", "operator");
    expect(approved?.toolName).toBe("jarvis_file_delete");
    const r = rows(tk);
    expect(r.map((x) => [x.tool, x.decision])).toEqual([
      ["gmail_send", "pending"],
      ["jarvis_file_delete", "confirmed"],
    ]);
  });

  it("a failed durable write is visible in the journal, never silent (W-3)", () => {
    closeDatabase();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    storePendingConfirmation(tk, "gmail_send", args, "s");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("approval record not written"));
    expect(getPendingConfirmation(tk)?.approvalId).toBeUndefined();
    initDatabase(":memory:"); // afterEach closes it
  });

  it("a new pending for the same thread supersedes the previous row", () => {
    storePendingConfirmation(tk, "gmail_send", args, "s1");
    storePendingConfirmation(tk, "jarvis_file_delete", { path: "x.md" }, "s2");
    const r = rows(tk);
    expect(r.map((x) => [x.tool, x.decision])).toEqual([
      ["gmail_send", "superseded"],
      ["jarvis_file_delete", "pending"],
    ]);
  });

  it("clearPendingConfirmation with no decision closes the row as superseded", () => {
    storePendingConfirmation(tk, "gmail_send", args, "s");
    clearPendingConfirmation(tk);
    expect(rows(tk)[0].decision).toBe("superseded");
  });
});

import { renderConfirmationSummary } from "./confirmations.js";
import { formatForTelegram } from "./formatter.js";

describe("renderConfirmationSummary (audit 2026-09-30 W1)", () => {
  it("names key fields first, then the rest as compact JSON — nested values never [object Object]", () => {
    const line = renderConfirmationSummary("gmail_send", {
      body: { html: "<p>hola</p>" },
      subject: "Reporte",
      to: "a@b.com",
      cc: ["c@d.com"],
      attachments: [{ name: "r.pdf" }],
    });
    expect(line).toBe(
      'gmail_send(to: a@b.com, cc: ["c@d.com"], subject: Reporte, {"attachments":[{"name":"r.pdf"}],"body":{"html":"<p>hola</p>"}})',
    );
    expect(line).not.toContain("[object Object]");
  });

  it("delete tools show the path / id they touch", () => {
    expect(renderConfirmationSummary("wp_delete", { id: 7 })).toBe(
      "wp_delete(id: 7)",
    );
    expect(
      renderConfirmationSummary("jarvis_file_delete", { path: "notes/a.md" }),
    ).toBe("jarvis_file_delete(path: notes/a.md)");
  });

  it("google_workspace_cli shows the exact gws argv it will run", () => {
    expect(
      renderConfirmationSummary("google_workspace_cli", {
        service: "chat",
        resource: "spaces.messages",
        method: "create",
        params: { parent: "spaces/AAAA" },
        json: { text: "hola" },
      }),
    ).toBe(
      'google_workspace_cli(gws chat spaces messages create --params {"parent":"spaces/AAAA"} --json {"text":"hola"})',
    );
  });

  it("caps each key value and the whole line", () => {
    const line = renderConfirmationSummary("gmail_send", {
      to: "x".repeat(500),
      body: "y".repeat(2000),
    });
    expect(line).toContain(`to: ${"x".repeat(120)}…`);
    expect(line.length).toBe(400);
    expect(line.endsWith("…)")).toBe(true);
  });

  it("W-C: per-tool key fields come first and the line cap clips the JSON tail, never a key field", () => {
    const text = "t".repeat(110);
    const tweet = renderConfirmationSummary("tweet_post", {
      media: [{ alt: "z".repeat(600) }],
      text,
      reply_to_id: "1790000000000000000",
      account: "eurekamd",
    });
    expect(
      tweet.startsWith(
        `tweet_post(account: eurekamd, reply_to_id: 1790000000000000000, text: ${text}, {"media":`,
      ),
    ).toBe(true);
    expect(tweet.length).toBe(400);
    expect(tweet.endsWith("…)")).toBe(true);

    // Key fields beyond the cap stay whole (each value capped at 120 only).
    const mail = renderConfirmationSummary("gmail_send", {
      to: "a".repeat(200),
      cc: "c".repeat(200),
      bcc: "b".repeat(200),
      subject: "s".repeat(200),
      body: "y".repeat(500),
    });
    expect(mail).toContain(`bcc: ${"b".repeat(120)}…`);
    expect(mail).toContain(`subject: ${"s".repeat(120)}…`);
    expect(mail.endsWith(", …)")).toBe(true);

    expect(
      renderConfirmationSummary("wp_raw_api", {
        body: { status: "draft" },
        site: "radar",
        path: "/wp/v2/posts/9",
        method: "DELETE",
      }),
    ).toBe(
      'wp_raw_api(method: DELETE, path: /wp/v2/posts/9, site: radar, {"body":{"status":"draft"}})',
    );
    expect(
      renderConfirmationSummary("run_schedule", { schedule_id: "sch-1" }),
    ).toBe("run_schedule(schedule_id: sch-1)");
    expect(
      renderConfirmationSummary("delete_schedule", {
        schedule_id: "sch-2",
        reason: "x",
      }),
    ).toBe('delete_schedule(schedule_id: sch-2, {"reason":"x"})');
  });

  it("round 3 (2a): the JSON tail puts short values first, so free text is what the cap clips", () => {
    const line = renderConfirmationSummary("crm_update", {
      notes: "n".repeat(500),
      deal_id: "D-42",
    });
    expect(line.startsWith('crm_update({"deal_id":"D-42","notes":"nnn')).toBe(
      true,
    );
    expect(line.length).toBe(400);
  });

  it("round 3 (2b): per-tool key fields keep the load-bearing args ahead of free text", () => {
    expect(
      renderConfirmationSummary("jarvis_dev", {
        body: "b".repeat(500),
        action: "merge",
      }),
    ).toMatch(/^jarvis_dev\(action: merge, \{"body":"b+…\)$/);
    const cal = renderConfirmationSummary("calendar_create", {
      title: "Reunión",
      description: "d".repeat(600),
      start: "2026-10-01T10:00:00-06:00",
      end: "2026-10-01T11:00:00-06:00",
      attendees: ["externo@otra.com"],
    });
    expect(cal).toContain(
      'calendar_create(start: 2026-10-01T10:00:00-06:00, end: 2026-10-01T11:00:00-06:00, attendees: ["externo@otra.com"], {"title":"Reunión","description":"ddd',
    );
    expect(
      renderConfirmationSummary("gdrive_share", {
        file_id: "f1",
        email: "x@y.com",
        role: "writer",
      }),
    ).toBe("gdrive_share(file_id: f1, email: x@y.com, role: writer)");
    expect(
      renderConfirmationSummary("wp_plugins", {
        site: "radar",
        action: "deactivate",
        plugin: "akismet",
      }),
    ).toBe("wp_plugins(site: radar, action: deactivate, plugin: akismet)");
    expect(
      renderConfirmationSummary("wp_publish", {
        content: "c".repeat(900),
        site: "radar",
        status: "publish",
        post_id: 9,
        slug: "w40",
      }),
    ).toMatch(
      /^wp_publish\(site: radar, status: publish, post_id: 9, slug: w40, \{"content":"c+…\)$/,
    );
    // wp_raw_api has no `endpoint` param: it is not a key field.
    expect(
      renderConfirmationSummary("wp_raw_api", {
        endpoint: "x",
        method: "GET",
        path: "/p",
        site: "s",
      }),
    ).toBe('wp_raw_api(method: GET, path: /p, site: s, {"endpoint":"x"})');
  });

  it("round 3 (2c): a truncated array says how many items it holds", () => {
    const paths = Array.from({ length: 30 }, (_, i) => `notes/n${i}.md`);
    const line = renderConfirmationSummary("jarvis_files_batch_delete", {
      paths,
    });
    expect(line).toMatch(
      /^jarvis_files_batch_delete\(paths: \["notes\/n0\.md","notes\/n1\.md",.*,…\] \(30 total\)\)$/,
    );
    // An array that fits renders whole, without a count.
    expect(
      renderConfirmationSummary("jarvis_files_batch_delete", {
        paths: ["a.md", "b.md"],
      }),
    ).toBe('jarvis_files_batch_delete(paths: ["a.md","b.md"])');
  });

  it("round 3 (3): a raw newline in a gws argv word is escaped, never a line break", () => {
    const line = renderConfirmationSummary("google_workspace_cli", {
      service: "gmail",
      resource: "users.messages",
      method: "send\n*x*",
    });
    expect(line).not.toMatch(/[\r\n`]/);
    expect(line).toBe(
      'google_workspace_cli(gws gmail users messages "send\\n*x*")',
    );
    // The router shows it as inline code: one intact <code> span on Telegram.
    const html = formatForTelegram(`🔐 \`${line}\``).join("");
    expect(html).toBe(
      '🔐 <code>google_workspace_cli(gws gmail users messages "send\\n*x*")</code>',
    );
  });

  it("W-C: the line is one line with no backtick, so it can sit in inline code", () => {
    const line = renderConfirmationSummary("gmail_send", {
      to: "a`b@x.mx",
      subject: "linea1\nlinea2",
      body: "`x`",
    });
    expect(line).not.toMatch(/[`\n]/);
    expect(line).toBe(
      'gmail_send(to: "a\\u0060b@x.mx", subject: "linea1\\nlinea2", {"body":"\\u0060x\\u0060"})',
    );
  });
});

// ---------------------------------------------------------------------------
// Operator rulings 2026-10-01 — schedule card line + one expiry notice.
// ---------------------------------------------------------------------------

import { renderExpiryNotice } from "./confirmations.js";
import { toolRegistry } from "../tools/registry.js";
import type { Tool } from "../tools/types.js";

function stubTool(name: string, requiresConfirmation: boolean): Tool {
  return {
    name,
    requiresConfirmation,
    definition: {
      type: "function",
      function: { name, description: name, parameters: { type: "object", properties: {} } },
    },
    execute: async () => "{}",
  };
}

describe("renderConfirmationSummary — schedule_task (ruling 2026-10-01)", () => {
  beforeEach(() => {
    toolRegistry.register(stubTool("gmail_send", true));
    toolRegistry.register(stubTool("tweet_post", true));
    toolRegistry.register(stubTool("web_search", false));
  });

  it("names the schedule's high-risk tools and its cadence after the exact call", () => {
    const line = renderConfirmationSummary("schedule_task", {
      description: "Busca noticias",
      cron: "0 8 * * *",
      tools: ["web_search", "gmail_send"],
      delivery: "email",
      email_to: "ana@x.mx",
      name: "Reporte",
    });
    expect(line).toBe(
      'schedule_task(name: Reporte, cron: 0 8 * * *, tools: ["web_search","gmail_send"], delivery: email, email_to: ana@x.mx, {"description":"Busca noticias"}) · usará sin pedir confirmación: gmail_send (cadencia: diario 08:00)',
    );
  });

  it("names a high-risk tool even when the tools array is truncated; email delivery implies gmail_send", () => {
    const tools = [...Array.from({ length: 20 }, (_, i) => `tool_number_${i}`), "tweet_post"];
    // Registered low-risk tools (an unregistered name is itself risky).
    tools.slice(0, 20).forEach((t) =>
      toolRegistry.register({ ...stubTool(t, false), readOnlyHint: true, destructiveHint: false }),
    );
    const line = renderConfirmationSummary("schedule_task", {
      name: "R",
      cron: "*/30 * * * *",
      tools,
      delivery: "both",
    });
    expect(line).toContain("(21 total)");
    expect(line).not.toContain('"tweet_post"');
    expect(line).toMatch(
      / · usará sin pedir confirmación: tweet_post, gmail_send \(cadencia: \*\/30 \* \* \* \*\)$/,
    );
    expect(line).not.toMatch(/[`\n]/);
  });

  it("no suffix for a schedule without high-risk tools; other tools unchanged", () => {
    const line = renderConfirmationSummary("schedule_task", {
      name: "R",
      cron: "0 8 * * *",
      tools: ["web_search"],
      delivery: "telegram",
    });
    expect(line).toBe(
      'schedule_task(name: R, cron: 0 8 * * *, tools: ["web_search"], delivery: telegram)',
    );
    expect(renderConfirmationSummary("gmail_send", { to: "a@b.mx", tools: ["tweet_post"] })).toBe(
      'gmail_send(to: a@b.mx, {"tools":["tweet_post"]})',
    );
  });

  it("fold 1 W2: the suffix also names a declared tool-set carrier and an unloaded MCP name", () => {
    const line = renderConfirmationSummary("schedule_task", {
      name: "R",
      cron: "0 8 * * *",
      tools: ["web_search", "batch_decompose", "schedule_task", "xpoz__post"],
      delivery: "telegram",
    });
    expect(line).toMatch(
      / · usará sin pedir confirmación: batch_decompose \(puede usar cualquier herramienta\), schedule_task \(puede usar cualquier herramienta\), xpoz__post \(puede usar cualquier herramienta\) \(cadencia: diario 08:00\)$/,
    );
  });

  it("re-audit 2026-10-03: carriers and unregistered names are marked; a high-risk tool is not", () => {
    const line = renderConfirmationSummary("schedule_task", {
      name: "R",
      cron: "0 8 * * *",
      tools: ["gmail_send", "batch_decompose", "made_up_tool"],
      delivery: "telegram",
    });
    expect(line).toMatch(
      / · usará sin pedir confirmación: gmail_send, batch_decompose \(puede usar cualquier herramienta\), made_up_tool \(puede usar cualquier herramienta\) \(cadencia: diario 08:00\)$/,
    );
  });

  it("re-audit 2026-10-03: the risky list on the card is capped at 5 names, then 'y N más'", () => {
    const risky = Array.from({ length: 8 }, (_, i) => `unloaded_${i}`);
    const line = renderConfirmationSummary("schedule_task", {
      name: "R",
      cron: "0 8 * * *",
      tools: ["gmail_send", ...risky],
      delivery: "telegram",
    });
    const suffix = line.slice(line.indexOf(" · usará"));
    expect(suffix).toBe(
      " · usará sin pedir confirmación: gmail_send, unloaded_0 (puede usar cualquier herramienta), unloaded_1 (puede usar cualquier herramienta), unloaded_2 (puede usar cualquier herramienta), unloaded_3 (puede usar cualquier herramienta) y 4 más (cadencia: diario 08:00)",
    );
  });

  it("a backtick or newline in the cron cannot break the inline-code line", () => {
    const line = renderConfirmationSummary("schedule_task", {
      cron: "0 8 * * *`\n",
      tools: ["gmail_send"],
    });
    expect(line).not.toMatch(/[`\n]/);
  });
});

describe("approval expiry notice (ruling 2026-10-01)", () => {
  const tk = "telegram:999";
  const args = { to: "a@b.mx", body: "hola equipo, el reporte" };
  const TTL = 5 * 60 * 1000;
  const summary = "gmail_send(to: a@b.mx)";

  beforeEach(() => {
    vi.useFakeTimers();
    initDatabase(":memory:");
    _resetPendingConfirmationsForTests();
  });
  afterEach(() => {
    _resetPendingConfirmationsForTests();
    closeDatabase();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const decisions = () =>
    (getDatabase()
      .prepare("SELECT decision FROM tool_approvals WHERE thread_key = ? ORDER BY id")
      .all(tk) as Array<{ decision: string }>).map((r) => r.decision);

  it("the exact Spanish line, reusing the card's summary", () => {
    expect(renderExpiryNotice(summary)).toBe(
      "⏱ La aprobación para `gmail_send(to: a@b.mx)` venció sin respuesta. Si aún lo quieres, pídemelo de nuevo.",
    );
  });

  it("an unanswered approval gets exactly ONE notice at the TTL; the row closes as expired", () => {
    const notify = vi.fn();
    storePendingConfirmation(tk, "gmail_send", args, summary, notify);
    vi.advanceTimersByTime(TTL - 1);
    expect(notify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(renderExpiryNotice(summary));
    vi.advanceTimersByTime(10 * TTL);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(decisions()).toEqual(["expired"]);
  });

  it("a late 'sí' runs nothing and the notice left nothing pending", () => {
    const notify = vi.fn();
    storePendingConfirmation(tk, "gmail_send", args, summary, notify);
    vi.advanceTimersByTime(TTL);
    expect(getPendingConfirmation(tk)).toBeNull();
    expect(resolvePendingConfirmation(tk, "confirmed", "operator")).toBeNull();
    expect(decisions()).toEqual(["expired"]);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("no notice when confirmed, declined, cleared (unclear reply) or superseded before the TTL", () => {
    const outcomes: Array<(n: () => void) => void> = [
      () => resolvePendingConfirmation(tk, "confirmed", "op"),
      () => resolvePendingConfirmation(tk, "declined", "op"),
      () => clearPendingConfirmation(tk),
    ];
    for (const settle of outcomes) {
      const notify = vi.fn();
      storePendingConfirmation(tk, "gmail_send", args, summary, notify);
      vi.advanceTimersByTime(TTL / 2);
      settle(notify);
      vi.advanceTimersByTime(2 * TTL);
      expect(notify).not.toHaveBeenCalled();
    }
    // Superseded: only the newer card can lapse, once, at ITS own TTL.
    const first = vi.fn();
    const second = vi.fn();
    storePendingConfirmation(tk, "gmail_send", args, "s1", first);
    vi.advanceTimersByTime(TTL / 2);
    storePendingConfirmation(tk, "jarvis_file_delete", { path: "x.md" }, "s2", second);
    vi.advanceTimersByTime(TTL - 1);
    expect(second).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith(renderExpiryNotice("s2"));
  });

  it("never shown to a chat (no notifier) → no notice, row still expires", () => {
    storePendingConfirmation(tk, "gmail_send", args, summary);
    vi.advanceTimersByTime(TTL);
    expect(decisions()).toEqual(["expired"]);
  });

  it("re-reads the row at fire time: a row already decided elsewhere gets no notice", () => {
    const notify = vi.fn();
    storePendingConfirmation(tk, "gmail_send", args, summary, notify);
    getDatabase()
      .prepare("UPDATE tool_approvals SET decision = 'confirmed' WHERE thread_key = ?")
      .run(tk);
    vi.advanceTimersByTime(TTL);
    expect(notify).not.toHaveBeenCalled();
    expect(decisions()).toEqual(["confirmed"]);
  });

  it("without a durable row (DB down) the in-memory identity decides — still exactly one notice", () => {
    closeDatabase();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const notify = vi.fn();
    storePendingConfirmation(tk, "gmail_send", args, summary, notify);
    vi.advanceTimersByTime(3 * TTL);
    expect(notify).toHaveBeenCalledTimes(1);
    initDatabase(":memory:"); // afterEach closes it
  });

  it("a read after the TTL but before a late timer fires sends the same one notice", () => {
    const notify = vi.fn();
    storePendingConfirmation(tk, "gmail_send", args, summary, notify);
    vi.setSystemTime(Date.now() + TTL + 1); // clock moves, timer not run
    expect(getPendingConfirmation(tk)).toBeNull();
    expect(notify).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(TTL);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(decisions()).toEqual(["expired"]);
  });

  it("fold 1: a 'sí' in the same tick the timer is due is never both run and announced (the timer wins)", () => {
    const notify = vi.fn();
    storePendingConfirmation(tk, "gmail_send", args, summary, notify);
    vi.advanceTimersByTime(TTL); // the timer is due and fires inside this advance
    const resolved = resolvePendingConfirmation(tk, "confirmed", "op");
    expect(resolved).toBeNull();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(decisions()).toEqual(["expired"]);
  });

  it("fold 1: re-carding one chat keeps ONE live timer, and only the newest card's notice", () => {
    const notifiers = Array.from({ length: 50 }, () => vi.fn());
    notifiers.forEach((n, i) => storePendingConfirmation(tk, "gmail_send", { i }, `s${i}`, n));
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(TTL);
    expect(vi.getTimerCount()).toBe(0);
    notifiers.slice(0, -1).forEach((n) => expect(n).not.toHaveBeenCalled());
    expect(notifiers.at(-1)).toHaveBeenCalledTimes(1);
    expect(notifiers.at(-1)).toHaveBeenCalledWith(renderExpiryNotice("s49"));
  });

  it("fold 1: two chats each get one notice, through their own notifier", () => {
    const a = vi.fn();
    const b = vi.fn();
    storePendingConfirmation("telegram:1", "gmail_send", args, "sa", a);
    storePendingConfirmation("whatsapp:2", "tweet_post", { text: "x" }, "sb", b);
    expect(vi.getTimerCount()).toBe(2);
    vi.advanceTimersByTime(TTL);
    expect(a.mock.calls).toEqual([[renderExpiryNotice("sa")]]);
    expect(b.mock.calls).toEqual([[renderExpiryNotice("sb")]]);
    vi.advanceTimersByTime(TTL);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("a notifier that throws never escapes the timer", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    storePendingConfirmation(tk, "gmail_send", args, summary, () => {
      throw new Error("adapter gone");
    });
    expect(() => vi.advanceTimersByTime(TTL)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("expiry notice failed: adapter gone"));
    expect(decisions()).toEqual(["expired"]);
  });
});

// ---------------------------------------------------------------------------
// Re-audit should-fix round (2026-10-03): expiry trace + restart re-arm.
// ---------------------------------------------------------------------------

import {
  rearmPendingConfirmationsAtBoot,
  BOOT_SWEEP_MAX_ROWS,
} from "./confirmations.js";
import { getTrace } from "../observability/task-trace.js";

describe("expiry trace and boot re-arm (re-audit 2026-10-03)", () => {
  const tk = "telegram";
  const args = { to: "a@b.mx", body: "x" };
  const TTL = 5 * 60 * 1000;
  const summary = "gmail_send(to: a@b.mx)";

  beforeEach(() => {
    vi.useFakeTimers();
    initDatabase(":memory:");
    _resetPendingConfirmationsForTests();
  });
  afterEach(() => {
    _resetPendingConfirmationsForTests();
    closeDatabase();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const expiredTrace = (taskId: string) =>
    getTrace(taskId)
      .filter((e) => e.name === "confirmation.expired")
      .map((e) => ({ tool: e.tool, attrs: JSON.parse(e.attrs ?? "{}") }));
  const rowOf = (threadKey: string) =>
    getDatabase()
      .prepare("SELECT id, decision FROM tool_approvals WHERE thread_key = ? ORDER BY id DESC")
      .get(threadKey) as { id: number; decision: string };
  /** Move a row's request time `ageMs` into the past (relative to the fake clock). */
  const age = (threadKey: string, ageMs: number) =>
    getDatabase()
      .prepare("UPDATE tool_approvals SET requested_at = ? WHERE thread_key = ?")
      .run(new Date(Date.now() - ageMs).toISOString(), threadKey);

  it("trace: a notified expiry is keyed by the task that showed the card", () => {
    const notify = vi.fn();
    storePendingConfirmation(tk, "gmail_send", args, summary, notify, "task-card");
    vi.advanceTimersByTime(TTL);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(expiredTrace("task-card")).toEqual([
      {
        tool: "gmail_send",
        attrs: { tool: "gmail_send", notified: true, reason: "notified", approval_id: rowOf(tk).id },
      },
    ]);
  });

  it("trace: no notifier → reason no_notifier; already decided → reason already_decided", () => {
    storePendingConfirmation(tk, "gmail_send", args, summary, undefined, "task-silent");
    vi.advanceTimersByTime(TTL);
    expect(expiredTrace("task-silent")[0].attrs).toMatchObject({ notified: false, reason: "no_notifier" });

    const notify = vi.fn();
    storePendingConfirmation(tk, "gmail_send", args, summary, notify, "task-decided");
    getDatabase().prepare("UPDATE tool_approvals SET decision = 'confirmed' WHERE thread_key = ? AND decision = 'pending'").run(tk);
    vi.advanceTimersByTime(TTL);
    expect(notify).not.toHaveBeenCalled();
    expect(expiredTrace("task-decided")[0].attrs).toMatchObject({ notified: false, reason: "already_decided" });
  });

  it("restart inside the TTL: the boot sweep re-arms the remainder and the card's chat gets the ONE notice", () => {
    storePendingConfirmation(tk, "gmail_send", args, summary);
    age(tk, 2 * 60 * 1000);
    _resetPendingConfirmationsForTests(); // process restart: maps and timers gone
    const notify = vi.fn();
    const resolver = vi.fn((key: string) => (key === tk ? notify : null));
    expect(rearmPendingConfirmationsAtBoot(resolver)).toEqual({ armed: 1, lapsed: 0 });
    expect(resolver).toHaveBeenCalledWith(tk);
    vi.advanceTimersByTime(3 * 60 * 1000 - 1);
    expect(notify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(notify.mock.calls).toEqual([[renderExpiryNotice(summary)]]);
    vi.advanceTimersByTime(2 * TTL);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(rowOf(tk).decision).toBe("expired");
    const { id } = rowOf(tk);
    expect(expiredTrace(`approval:${id}`)[0].attrs).toMatchObject({ notified: true, reason: "notified" });
  });

  it("restart after the TTL: the sweep lapses and notifies at once", () => {
    storePendingConfirmation(tk, "gmail_send", args, summary);
    age(tk, TTL + 60_000);
    _resetPendingConfirmationsForTests();
    const notify = vi.fn();
    expect(rearmPendingConfirmationsAtBoot(() => notify)).toEqual({ armed: 0, lapsed: 1 });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(rowOf(tk).decision).toBe("expired");
    expect(getPendingConfirmation(tk)).toBeNull();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("recipient not resolvable: lapses silently at the TTL (no_notifier), logged, never a guessed chat", () => {
    const key = "email:acct:someone@x.mx";
    storePendingConfirmation(key, "gmail_send", args, summary);
    age(key, 0); // align SQLite's clock with the fake one
    _resetPendingConfirmationsForTests();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(rearmPendingConfirmationsAtBoot(() => null)).toEqual({ armed: 1, lapsed: 0 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("chat not resolvable after restart"));
    vi.advanceTimersByTime(TTL);
    expect(rowOf(key).decision).toBe("expired");
    expect(expiredTrace(`approval:${rowOf(key).id}`)[0].attrs).toMatchObject({
      notified: false,
      reason: "no_notifier",
    });
  });

  it("bounded: newest rows first, one per chat, at most `maxRows`; a resolver that throws is a silent lapse", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    for (const key of ["telegram:a", "telegram:b", "telegram:c"]) {
      storePendingConfirmation(key, "gmail_send", args, summary);
    }
    _resetPendingConfirmationsForTests();
    const resolver = vi.fn(() => {
      throw new Error("router gone");
    });
    expect(rearmPendingConfirmationsAtBoot(resolver, 2)).toEqual({ armed: 2, lapsed: 0 });
    expect(resolver.mock.calls.map((c) => c[0])).toEqual(["telegram:c", "telegram:b"]);
    expect(vi.getTimerCount()).toBe(2);
    expect(BOOT_SWEEP_MAX_ROWS).toBe(50);
  });

  it("every expiry timer (store, boot sweep, rehydrate) is unref'd — a pending approval never holds the process open", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const spy = vi.spyOn(globalThis, "setTimeout");
    storePendingConfirmation(tk, "gmail_send", args, summary);
    age(tk, 0);
    storePendingConfirmation("telegram:b", "gmail_send", args, summary);
    age("telegram:b", 0);
    _resetPendingConfirmationsForTests();
    rearmPendingConfirmationsAtBoot(() => null, 1); // re-arms telegram:b only
    expect(getPendingConfirmation(tk)?.toolName).toBe("gmail_send"); // rehydrates tk
    const timers = spy.mock.results.map((r) => r.value as { hasRef: () => boolean });
    expect(timers).toHaveLength(4);
    expect(timers.map((t) => t.hasRef())).toEqual([false, false, false, false]);
  });

  it("a tampered pending row is not re-armed (superseded)", () => {
    storePendingConfirmation(tk, "gmail_send", args, summary);
    getDatabase().prepare("UPDATE tool_approvals SET args_json = ? WHERE thread_key = ?").run(
      JSON.stringify({ to: "other@x.mx" }),
      tk,
    );
    _resetPendingConfirmationsForTests();
    const notify = vi.fn();
    expect(rearmPendingConfirmationsAtBoot(() => notify)).toEqual({ armed: 0, lapsed: 0 });
    expect(rowOf(tk).decision).toBe("superseded");
    vi.advanceTimersByTime(2 * TTL);
    expect(notify).not.toHaveBeenCalled();
  });

  it("a row rehydrated on read (beyond the sweep) expires through the same lapse path (traced)", () => {
    storePendingConfirmation(tk, "gmail_send", args, summary);
    age(tk, 0);
    _resetPendingConfirmationsForTests();
    expect(getPendingConfirmation(tk)?.toolName).toBe("gmail_send"); // rehydrates
    vi.advanceTimersByTime(TTL);
    expect(rowOf(tk).decision).toBe("expired");
    expect(expiredTrace(`approval:${rowOf(tk).id}`)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Audit A2 (stale boot notice) + A3 (notified only after the send resolves).
// ---------------------------------------------------------------------------

vi.mock("../rituals/scheduler.js", () => ({ recordRitualFailure: vi.fn() }));
import { recordRitualFailure } from "../rituals/scheduler.js";
import {
  BOOT_NOTICE_GRACE_MS,
  EXPIRY_NOTICE_MAX_ATTEMPTS,
  EXPIRY_NOTICE_RETRY_MS,
  EXPIRY_NOTICE_FAILURE_ID,
} from "./confirmations.js";

describe("audit A2/A3: boot notice once, never stale; notified only on a delivered send", () => {
  const tk = "telegram";
  const args = { to: "a@b.mx", body: "x" };
  const TTL = 5 * 60 * 1000;
  const summary = "gmail_send(to: a@b.mx)";

  beforeEach(() => {
    vi.useFakeTimers();
    initDatabase(":memory:");
    _resetPendingConfirmationsForTests();
    vi.mocked(recordRitualFailure).mockClear();
  });
  afterEach(() => {
    _resetPendingConfirmationsForTests();
    closeDatabase();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const traceOf = (taskId: string, name: string) =>
    getTrace(taskId)
      .filter((e) => e.name === name)
      .map((e) => JSON.parse(e.attrs ?? "{}") as Record<string, unknown>);
  const rowOf = (threadKey: string) =>
    getDatabase()
      .prepare("SELECT id, decision FROM tool_approvals WHERE thread_key = ? ORDER BY id DESC")
      .get(threadKey) as { id: number; decision: string };
  const age = (threadKey: string, ageMs: number) =>
    getDatabase()
      .prepare("UPDATE tool_approvals SET requested_at = ? WHERE thread_key = ?")
      .run(new Date(Date.now() - ageMs).toISOString(), threadKey);

  it("A2: a row that expired long before the restart lapses SILENTLY (stale_at_boot), no notice", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    storePendingConfirmation(tk, "gmail_send", args, summary);
    age(tk, TTL + BOOT_NOTICE_GRACE_MS + 60_000);
    _resetPendingConfirmationsForTests();
    const notify = vi.fn();
    expect(rearmPendingConfirmationsAtBoot(() => notify)).toEqual({ armed: 0, lapsed: 1 });
    expect(notify).not.toHaveBeenCalled();
    expect(rowOf(tk).decision).toBe("expired");
    expect(traceOf(`approval:${rowOf(tk).id}`, "confirmation.expired")).toEqual([
      expect.objectContaining({ notified: false, reason: "stale_at_boot" }),
    ]);
  });

  it("A2: expired while down within the grace window → ONE notice; a second boot never repeats it", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    storePendingConfirmation(tk, "gmail_send", args, summary);
    age(tk, TTL + BOOT_NOTICE_GRACE_MS - 60_000);
    _resetPendingConfirmationsForTests();
    const notify = vi.fn();
    expect(rearmPendingConfirmationsAtBoot(() => notify)).toEqual({ armed: 0, lapsed: 1 });
    expect(notify.mock.calls).toEqual([[renderExpiryNotice(summary)]]);
    _resetPendingConfirmationsForTests(); // another restart
    expect(rearmPendingConfirmationsAtBoot(() => notify)).toEqual({ armed: 0, lapsed: 0 });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(traceOf(`approval:${rowOf(tk).id}`, "confirmation.expired")).toHaveLength(1);
  });

  it("A3: an async notifier — `notified` is traced only after the send resolves", async () => {
    let resolveSend!: () => void;
    const notify = vi.fn(() => new Promise<void>((r) => (resolveSend = r)));
    storePendingConfirmation(tk, "gmail_send", args, summary, notify, "task-async");
    vi.advanceTimersByTime(TTL);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(rowOf(tk).decision).toBe("expired");
    expect(traceOf("task-async", "confirmation.expired")).toEqual([]); // not yet
    resolveSend();
    await vi.advanceTimersByTimeAsync(0);
    expect(traceOf("task-async", "confirmation.expired")).toEqual([
      { tool: "gmail_send", notified: true, reason: "notified", approval_id: rowOf(tk).id },
    ]);
  });

  it("A3: a failing send is retried with backoff, at most EXPIRY_NOTICE_MAX_ATTEMPTS, then notify_failed + recordRitualFailure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const notify = vi.fn(() => Promise.reject(new Error("adapter down")));
    storePendingConfirmation(tk, "gmail_send", args, summary, notify, "task-fail");
    vi.advanceTimersByTime(TTL);
    await vi.advanceTimersByTimeAsync(0);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(traceOf("task-fail", "confirmation.expired")).toEqual([]);
    expect(traceOf("task-fail", "confirmation.expiry_notice_failed")).toEqual([
      expect.objectContaining({ attempt: 1, will_retry: true, error: "adapter down" }),
    ]);
    await vi.advanceTimersByTimeAsync(EXPIRY_NOTICE_RETRY_MS - 1);
    expect(notify).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(notify).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2 * EXPIRY_NOTICE_RETRY_MS);
    expect(notify).toHaveBeenCalledTimes(EXPIRY_NOTICE_MAX_ATTEMPTS);
    expect(EXPIRY_NOTICE_MAX_ATTEMPTS).toBe(3);
    await vi.advanceTimersByTimeAsync(100 * EXPIRY_NOTICE_RETRY_MS); // bounded: no more attempts
    expect(notify).toHaveBeenCalledTimes(EXPIRY_NOTICE_MAX_ATTEMPTS);
    expect(vi.getTimerCount()).toBe(0);
    expect(traceOf("task-fail", "confirmation.expiry_notice_failed").map((a) => a.will_retry)).toEqual([
      true,
      true,
      false,
    ]);
    expect(traceOf("task-fail", "confirmation.expired")).toEqual([
      expect.objectContaining({ notified: false, reason: "notify_failed", attempts: 3 }),
    ]);
    await vi.waitFor(() => expect(recordRitualFailure).toHaveBeenCalledTimes(1));
    expect(recordRitualFailure).toHaveBeenCalledWith(
      EXPIRY_NOTICE_FAILURE_ID,
      expect.stringContaining("not delivered after 3 attempts: adapter down"),
      "execute",
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("giving up"));
    expect(rowOf(tk).decision).toBe("expired"); // never re-opened
  });

  it("A3: a failure then a success → one `notified` trace with attempts 2, no failure recorded", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const notify = vi
      .fn<(n: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValueOnce(undefined);
    storePendingConfirmation(tk, "gmail_send", args, summary, notify, "task-retry");
    vi.advanceTimersByTime(TTL);
    await vi.advanceTimersByTimeAsync(EXPIRY_NOTICE_RETRY_MS);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(traceOf("task-retry", "confirmation.expired")).toEqual([
      expect.objectContaining({ notified: true, reason: "notified", attempts: 2 }),
    ]);
    await vi.advanceTimersByTimeAsync(10 * EXPIRY_NOTICE_RETRY_MS);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(recordRitualFailure).not.toHaveBeenCalled();
  });

  it("A3 follow-up: a new card in the same chat cancels the old notice's pending retry (no stale notice after it)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const oldNotify = vi.fn(() => Promise.reject(new Error("blip")));
    storePendingConfirmation(tk, "gmail_send", args, summary, oldNotify, "task-old");
    // Another chat's failing notice keeps its own retry.
    const otherNotify = vi.fn(() => Promise.reject(new Error("blip")));
    storePendingConfirmation("whatsapp", "gmail_send", args, summary, otherNotify, "task-other");
    vi.advanceTimersByTime(TTL);
    await vi.advanceTimersByTimeAsync(0);
    expect(oldNotify).toHaveBeenCalledTimes(1);

    const newNotify = vi.fn();
    storePendingConfirmation(tk, "wp_delete", { id: 7 }, "wp_delete(id: 7)", newNotify, "task-new");
    await vi.advanceTimersByTimeAsync(EXPIRY_NOTICE_RETRY_MS * 3);
    expect(oldNotify).toHaveBeenCalledTimes(1); // the retry never fired
    expect(otherNotify).toHaveBeenCalledTimes(3); // unaffected
    expect(traceOf("task-old", "confirmation.expired")).toEqual([
      expect.objectContaining({ notified: false, reason: "notice_superseded" }),
    ]);
    expect(getPendingConfirmation(tk)?.toolName).toBe("wp_delete");
  });

  it("A3 follow-up: a new card while a fired retry's send is in flight → that send's failure schedules no further attempt", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let rejectInFlight: (err: Error) => void = () => {};
    const oldNotify = vi
      .fn<(n: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("blip"))
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectInFlight = reject;
          }),
      )
      .mockRejectedValue(new Error("blip"));
    storePendingConfirmation(tk, "gmail_send", args, summary, oldNotify, "task-race");
    vi.advanceTimersByTime(TTL);
    await vi.advanceTimersByTimeAsync(EXPIRY_NOTICE_RETRY_MS);
    expect(oldNotify).toHaveBeenCalledTimes(2); // attempt 2 fired, send in flight

    const newNotify = vi.fn();
    storePendingConfirmation(tk, "wp_delete", { id: 7 }, "wp_delete(id: 7)", newNotify, "task-new2");
    rejectInFlight(new Error("adapter down"));
    await vi.advanceTimersByTimeAsync(EXPIRY_NOTICE_RETRY_MS * 5); // < TTL: the new card stays
    expect(oldNotify).toHaveBeenCalledTimes(2); // attempt 3 never scheduled
    expect(traceOf("task-race", "confirmation.expiry_notice_failed")).toEqual([
      expect.objectContaining({ attempt: 1, will_retry: true }),
      expect.objectContaining({ attempt: 2, will_retry: false, superseded: true }),
    ]);
    expect(traceOf("task-race", "confirmation.expired")).toEqual([
      expect.objectContaining({ notified: false, reason: "notice_superseded", attempts: 2 }),
    ]);
    expect(recordRitualFailure).not.toHaveBeenCalled();
    expect(getPendingConfirmation(tk)?.toolName).toBe("wp_delete");
  });

  it("A3 follow-up: clearPendingConfirmation cancels the chat's pending notice retry", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const notify = vi.fn(() => Promise.reject(new Error("blip")));
    storePendingConfirmation(tk, "gmail_send", args, summary, notify, "task-clr");
    vi.advanceTimersByTime(TTL);
    await vi.advanceTimersByTimeAsync(0);
    clearPendingConfirmation(tk);
    await vi.advanceTimersByTimeAsync(EXPIRY_NOTICE_RETRY_MS * 10);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(traceOf("task-clr", "confirmation.expired")).toEqual([
      expect.objectContaining({ reason: "notice_superseded" }),
    ]);
    expect(recordRitualFailure).not.toHaveBeenCalled();
  });
});
