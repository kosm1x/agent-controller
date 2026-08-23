import { describe, expect, it } from "vitest";
import { detectScopeMiss, groupsForTool } from "./scope-miss.js";

const KNOWN = [
  "shell_exec",
  "gemini_image",
  "schedule_task",
  "tweet_post",
  "file_edit",
  "git_commit",
  "wp_media_upload",
  "jarvis_file_read",
];

describe("detectScopeMiss — corpus shapes", () => {
  it("12465: '`shell_exec` no está en el scope activo. Necesito que me lo actives con \"usa shell_exec\"'", () => {
    const m = detectScopeMiss(
      '`shell_exec` no está en el scope activo. Necesito que me lo actives con "usa shell_exec" para publicar el Williams Radar 34.',
      KNOWN,
    );
    expect(m?.requestedTools).toEqual(["shell_exec"]);
  });

  it("11189: 'ya lo tienes activo… Pero veo que el tool no está disponible en esta ronda… necesito que me digas \"usa shell\"'", () => {
    const m = detectScopeMiss(
      'Confirmado. Ya lo tienes activo desde la sesión anterior. Pero veo que el tool no está disponible en esta ronda — necesito que me digas "usa shell" y ejecuto la eliminación.',
      KNOWN,
    );
    expect(m?.requestedTools).toEqual(["shell_exec"]);
  });

  it("11217: two tools named in one ask", () => {
    const m = detectScopeMiss(
      "Las herramientas gemini_image y wp_media_upload no aparecen en mi lista de herramientas actual — necesito que me pidas con las palabras clave del scope.",
      KNOWN,
    );
    expect(m?.requestedTools.sort()).toEqual(["gemini_image", "wp_media_upload"]);
  });

  it("11402: schedule keyword without an identifier", () => {
    const m = detectScopeMiss(
      'El guard bloqueó el INSERT. Para desbloquearlo necesito que me digas: "crea el schedule de química" y lo creo con la herramienta correcta.',
      KNOWN,
    );
    expect(m?.requestedTools).toEqual(["schedule_task"]);
  });

  it("new prompt shape: 'Necesito `shell_exec` para esto'", () => {
    const m = detectScopeMiss("Necesito `shell_exec` para esto.", KNOWN);
    expect(m?.requestedTools).toEqual(["shell_exec"]);
  });

  it("R1 audit C4 — the dominant corpus shapes are caught", () => {
    const cases: Array<[number, string, string[]]> = [
      [12023, "No tengo `file_edit` ni `shell_exec` en este scope. Los necesito para editar código. Dime **\"usa shell\"** y lo retomo de inmediato.", ["file_edit", "shell_exec"]],
      [11814, "No tengo `shell_exec` en este scope — necesito ese para correr `mc-ctl jme-stats`. Pídeme \"usa shell_exec\" y lo corro directo.", ["shell_exec"]],
      [11831, "¿Puedes pedirme \"usa shell_exec\" para buscarlo?", ["shell_exec"]],
      [12211, "Para crear los archivos necesito **shell_exec**. ¿Me lo habilitas con \"usa shell_exec\"?", ["shell_exec"]],
      [12456, "Para el sweep necesito `shell_exec`. Actívala y continúo de inmediato.", ["shell_exec"]],
      [12438, "Necesito shell_exec para escribir en el filesystem del VPS. Activa shell_exec y continúo.", ["shell_exec"]],
      [11991, "Necesito shell_exec para investigar. Dame acceso con \"usa shell_exec\".", ["shell_exec"]],
      [12007, "No tengo `shell_exec` en este scope. Necesito shell_exec para acceder — pero no está disponible en este scope.", ["shell_exec"]],
    ];
    for (const [id, text, tools] of cases) {
      const m = detectScopeMiss(text, KNOWN);
      expect(m?.requestedTools.sort(), `#${id}`).toEqual(tools.sort());
    }
  });

  it("R1 audit W1 — an ask buried mid-reply that the model worked around is NOT a miss (corpus 12243)", () => {
    const body = "Aquí el resultado completo del audit corregido.\n\n" + "| Página | Meta | H1 | JSON-LD |\n|---|---|---|---|\n".repeat(30) + "\n**El único fix técnico pendiente es JSON-LD.** ¿Procedo a agregarlo correctamente esta vez, verificando el resultado en disco antes de commitear?";
    const text = "Necesito shell_exec para hacer grep masivo. Pídemelo con \"usa shell_exec\".\n\n" + body;
    expect(text.length).toBeGreaterThan(1500);
    expect(detectScopeMiss(text, KNOWN)).toBeNull();
  });

  it("harvests tool identifiers from the TAIL only — a tool used earlier in the reply is not 'requested'", () => {
    const m = detectScopeMiss(
      "Corrí jarvis_file_read sobre el KB y encontré el doc.\n\n" + "x".repeat(1600) + "\n\nPara el deploy necesito `shell_exec`. Actívala y continúo.",
      KNOWN,
    );
    expect(m?.requestedTools).toEqual(["shell_exec"]);
  });

  it("does NOT fire on a reply that merely mentions a tool name", () => {
    expect(
      detectScopeMiss(
        "Ejecuté shell_exec tres veces: build, test y deploy. Todo en verde.",
        KNOWN,
      ),
    ).toBeNull();
  });

  it("does NOT fire on an ask that names no known tool", () => {
    expect(
      detectScopeMiss("Eso no está en el scope de este proyecto.", KNOWN),
    ).toBeNull();
  });

  it("does NOT fire on the user's own history being quoted back without an ask phrase", () => {
    expect(
      detectScopeMiss("Ayer me pediste «usa shell» y lo hice. Hoy no hace falta.", KNOWN),
    ).toBeNull();
  });
});

describe("detectScopeMiss — R2 audit W1/W3 shapes", () => {
  it("catches 'necesito que lo habilites', 'Dímelo con', 'mi scope actual', markdown-wrapped usa", () => {
    const cases: Array<[number, string, string[]]> = [
      [11537, "Para copiar la imagen necesito que lo habilites: shell_exec hace el cp a /tmp/wp_content/.", ["shell_exec"]],
      [11578, "Esas herramientas (shell_exec, file_edit) no están en mi scope actual. Para escribir el código necesito que me las habilites. Pídeme: **\"usa shell_exec, file_edit\"** y arrancamos.", ["file_edit", "shell_exec"]],
      [11736, "Te paso el texto listo. **Dímelo** con \"usa tweet_post\" y lo publico.", ["tweet_post"]],
      [12003, "En cuanto habilites `schedule_task`, actualizo el prompt del schedule y empieza mañana.", ["schedule_task"]],
    ];
    for (const [id, text, tools] of cases) {
      const m = detectScopeMiss(text, [...KNOWN, "schedule_task"]);
      expect(m?.requestedTools.sort(), `#${id}`).toEqual(tools.sort());
    }
  });

  it("harvests MCP-style identifiers with double underscores (the prompt's own example)", () => {
    const m = detectScopeMiss("Necesito `mcp__supabase__query` para esto.", ["mcp__supabase__query", "browser__goto"]);
    expect(m?.requestedTools).toEqual(["mcp__supabase__query"]);
    const b = detectScopeMiss("No tengo `browser__goto` en este scope.", ["mcp__supabase__query", "browser__goto"]);
    expect(b?.requestedTools).toEqual(["browser__goto"]);
  });
});

describe("groupsForTool", () => {
  const opts = { hasGoogle: true, hasWordpress: true, hasMemory: false, hasCrm: false };
  it("maps shell_exec → coding", () => {
    expect(groupsForTool("shell_exec", opts)).toContain("coding");
  });
  it("maps schedule_task → schedule", () => {
    expect(groupsForTool("schedule_task", opts)).toContain("schedule");
  });
  it("maps tweet_post → social", () => {
    expect(groupsForTool("tweet_post", opts)).toContain("social");
  });
  it("maps a WordPress tool → wordpress", () => {
    expect(groupsForTool("wp_media_upload", opts)).toContain("wordpress");
  });
  it("R1 audit C3: an always-on tool maps to NO group (it is in the baseline)", () => {
    expect(groupsForTool("file_read", opts)).toEqual([]);
    expect(groupsForTool("jarvis_file_read", opts)).toEqual([]);
  });
  it("orders groups narrowest-first so the router widens minimally", () => {
    const gs = groupsForTool("shell_exec", opts);
    expect(gs[0]).toBe("coding");
  });
  it("R2 audit W2: regex-only groups (finance, paper, pm_*) are reachable", () => {
    expect(groupsForTool("market_quote", opts)).toContain("finance");
  });
  it("returns [] for an unknown tool", () => {
    expect(groupsForTool("no_such_tool", opts)).toEqual([]);
  });
});
