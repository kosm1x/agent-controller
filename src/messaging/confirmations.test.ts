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
