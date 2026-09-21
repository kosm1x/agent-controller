import { describe, expect, it } from "vitest";
import {
  buildQuestions,
  buildToolOwners,
  evaluate,
  isSpanish,
  judge,
  looksSensitive,
  parseAnswers,
  parseGroupDescriptions,
  percentile,
  pickThreshold,
  selectGroups,
  turnCoverage,
  type PassRule,
  type ReplayRow,
  type ScopeFor,
} from "./jev-scope-replay.js";
import {
  CLASSIFIER_SYSTEM_PROMPT,
  VALID_GROUPS,
} from "../messaging/scope-classifier.js";

const TOOLS: Record<string, string[]> = {
  coding: ["shell_exec", "file_edit"],
  google: ["gmail_send"],
  browser: ["shell_exec", "browser_open"],
};
const toolsFor = (active: Set<string>): string[] => [
  "core_tool",
  ...new Set([...active].flatMap((g) => TOOLS[g] ?? [])),
];
const owners = buildToolOwners(Object.keys(TOOLS), toolsFor);
const scopeFor: ScopeFor = (_message, groups) => ({
  groups,
  tools: toolsFor(groups),
});

const row = (
  called: string[],
  nouls: Record<string, number> | undefined,
  liveGroups: string[] = [],
  extra: Partial<ReplayRow> = {},
): ReplayRow => ({
  message: "m",
  called,
  liveGroups,
  liveTools: toolsFor(new Set(liveGroups)),
  spanish: true,
  nouls,
  ...extra,
});

describe("parseGroupDescriptions", () => {
  it("reads the `- group: description` lines and ignores unknown groups", () => {
    const parsed = parseGroupDescriptions(
      "GROUPS\n- coding: Edit code. NOT reading docs.\n- bogus: nope\n  - google: Gmail\nOutput: coding",
      new Set(["coding", "google"]),
    );
    expect([...parsed.keys()]).toEqual(["coding", "google"]);
    expect(parsed.get("coding")).toBe("Edit code. NOT reading docs.");
  });

  it("finds a description for every valid group in the production prompt", () => {
    const parsed = parseGroupDescriptions(
      CLASSIFIER_SYSTEM_PROMPT,
      VALID_GROUPS,
    );
    expect([...VALID_GROUPS].filter((g) => !parsed.has(g))).toEqual([]);
  });
});

describe("buildQuestions / parseAnswers", () => {
  const questions = buildQuestions(
    new Map([
      ["coding", "Edit code — is coding, NOT jarvis_write."],
      ["google", "Gmail."],
    ]),
  );

  it("asks one noul per group plus a ranking choice", () => {
    expect(Object.keys(questions).sort()).toEqual([
      "g_coding",
      "g_google",
      "rank",
    ]);
    expect(Object.keys(questions.rank.criteria)).toEqual([
      "none",
      "coding",
      "google",
    ]);
  });

  it("passes the production description through verbatim, negations included", () => {
    expect(questions.g_coding.criteria.true).toBe(
      "Edit code — is coding, NOT jarvis_write.",
    );
    expect(questions.rank.criteria.coding).toBe(
      "Edit code — is coding, NOT jarvis_write.",
    );
  });

  it("reads the probabilities and the rank pick back", () => {
    const body = {
      answers: {
        g_coding: { noul: 0.9 },
        g_google: { noul: 0.1 },
        rank: { choice: "coding" },
      },
    };
    expect(parseAnswers(body, ["coding", "google"])).toEqual({
      nouls: { coding: 0.9, google: 0.1 },
      rank: "coding",
    });
  });

  it("rejects a body with a missing or out-of-range answer", () => {
    expect(
      parseAnswers({ answers: { g_coding: { noul: 0.9 } } }, [
        "coding",
        "google",
      ]),
    ).toBeNull();
    expect(
      parseAnswers({ answers: { g_coding: { noul: 1.4 } } }, ["coding"]),
    ).toBeNull();
    expect(parseAnswers({ error: "rate limited" }, ["coding"])).toBeNull();
  });
});

describe("buildToolOwners / turnCoverage", () => {
  it("excludes baseline tools and records every owning group", () => {
    expect(owners.baseline.has("core_tool")).toBe(true);
    expect(owners.owners.has("core_tool")).toBe(false);
    expect([...owners.owners.get("shell_exec")!].sort()).toEqual([
      "browser",
      "coding",
    ]);
  });

  it("covers a turn whose owned tools are all in scope", () => {
    expect(
      turnCoverage(
        ["shell_exec"],
        new Set(toolsFor(new Set(["browser"]))),
        owners,
      ),
    ).toBe("covered");
  });

  it("misses when one called tool is out of scope", () => {
    expect(
      turnCoverage(
        ["shell_exec", "gmail_send"],
        new Set(toolsFor(new Set(["coding"]))),
        owners,
      ),
    ).toBe("missed");
  });

  it("does not score a turn that called only unowned tools", () => {
    expect(turnCoverage(["core_tool", "ToolSearch"], new Set(), owners)).toBe(
      "no_group_needed",
    );
  });
});

describe("evaluate / pickThreshold", () => {
  const rows = [
    row(["file_edit"], { coding: 0.8, google: 0.1, browser: 0.1 }, ["coding"], {
      rank: "coding",
    }),
    row(
      ["gmail_send"],
      { coding: 0.1, google: 0.4, browser: 0.1 },
      ["google"],
      {
        rank: "none",
      },
    ),
    row(["gmail_send"], { coding: 0.1, google: 0.9, browser: 0.6 }, [], {
      rank: "browser",
    }),
    row(["core_tool"], { coding: 0.1, google: 0.1, browser: 0.1 }, []),
    row(["file_edit"], undefined, ["coding"]),
  ];

  it("scores only answered turns that needed a group", () => {
    const e = evaluate(rows, 0.5, owners, scopeFor);
    expect(e.answered).toBe(4);
    expect(e.scored).toBe(3);
    expect(e.covered).toBe(2);
    expect(e.meanGroups).toBeCloseTo(3 / 4);
    expect(e.meanTools).toBeCloseTo((3 + 1 + 4 + 1) / 4);
    expect(e.rankHits).toBe(1);
  });

  it("scores Jev on the scope the production scoper builds, and counts the injected groups", () => {
    const injecting: ScopeFor = (_m, groups) => {
      const active = new Set([...groups, "google", "not_asked"]);
      return { groups: active, tools: toolsFor(active) };
    };
    const e = evaluate(rows, 0.5, owners, injecting);
    expect(e.covered).toBe(3);
    // google injected on all 4 answered rows; `not_asked` is never counted.
    expect(e.meanGroups).toBeCloseTo((2 + 1 + 2 + 1) / 4);
  });

  it("picks the largest threshold that still meets the bar", () => {
    expect(
      pickThreshold(rows, [0.2, 0.3, 0.4, 0.5], 0.95, owners, scopeFor),
    ).toBe(0.4);
    expect(pickThreshold(rows, [0.95], 0.95, owners, scopeFor)).toBeNull();
  });

  it("treats the threshold as inclusive", () => {
    expect([...selectGroups({ coding: 0.4 }, 0.4)]).toEqual(["coding"]);
  });
});

describe("judge", () => {
  const RULE: PassRule = {
    coverage: 0.95,
    extraGroups: 1,
    p95Ms: 800,
    minAnswerRate: 0.9,
    minHeldScored: 10,
  };
  const GRID = [0.3, 0.5, 0.7];
  const good = (latencyMs = 200): ReplayRow =>
    row(["file_edit"], { coding: 0.9, google: 0.1, browser: 0.1 }, ["coding"], {
      latencyMs,
    });
  const failed = (latencyMs: number): ReplayRow =>
    row(["file_edit"], undefined, ["coding"], {
      latencyMs,
      error: "TimeoutError",
    });
  const many = (n: number, make: () => ReplayRow): ReplayRow[] =>
    Array.from({ length: n }, make);

  it("passes a fully answered, fast, covered run", () => {
    const v = judge(many(40, good), GRID, RULE, owners, scopeFor);
    expect(v.checks.filter((c) => !c.ok)).toEqual([]);
    expect(v.pass).toBe(true);
    expect(v.threshold).toBe(0.7);
    expect(v.tuneRows).toBe(20);
    expect(v.held?.scored).toBe(20);
    expect(v.liveMeanGroups).toBe(1);
  });

  it("fails when too few requests came back, however good the survivors look", () => {
    const v = judge(
      [...many(30, good), ...many(10, () => failed(300))],
      GRID,
      RULE,
      owners,
      scopeFor,
    );
    expect(v.answerRate).toBeCloseTo(0.75);
    expect(v.pass).toBe(false);
  });

  it("keeps the latency of a timed-out request in the p95", () => {
    const v = judge(
      [...many(37, good), ...many(3, () => failed(5000))],
      GRID,
      RULE,
      owners,
      scopeFor,
    );
    expect(v.answerRate).toBeGreaterThanOrEqual(RULE.minAnswerRate);
    expect(v.p95Ms).toBe(5000);
    expect(v.pass).toBe(false);
  });

  it("fails a run that stopped early, however good the remnant looks", () => {
    const rows = many(40, good);
    expect(judge(rows, GRID, RULE, owners, scopeFor, null).pass).toBe(true);
    const v = judge(rows, GRID, RULE, owners, scopeFor, "401 — key refused");
    expect(v.checks.filter((c) => !c.ok).map((c) => c.text)).toEqual([
      "run stopped early: 401 — key refused",
    ]);
    expect(v.pass).toBe(false);
  });

  it("reports the coverage the threshold reached on the tune half", () => {
    const v = judge(many(40, good), GRID, RULE, owners, scopeFor);
    expect(v.checks.map((c) => c.text)).toContain(
      "threshold 0.7 reaches 100.0% ≥ 95.0% on the tune half (20 rows)",
    );
  });

  it("fails a held-out half too small to mean anything", () => {
    const v = judge(many(12, good), GRID, RULE, owners, scopeFor);
    expect(v.held?.scored).toBe(6);
    expect(v.pass).toBe(false);
  });

  it("fails on held-out coverage even when the tune half is perfect", () => {
    const miss = (): ReplayRow =>
      row(
        ["gmail_send"],
        { coding: 0.9, google: 0.1, browser: 0.1 },
        ["google"],
        {
          latencyMs: 200,
        },
      );
    const rows = many(40, good).map((r, i) =>
      i % 2 === 1 && i < 8 ? miss() : r,
    );
    const v = judge(rows, GRID, RULE, owners, scopeFor);
    expect(v.threshold).toBe(0.7);
    expect(v.held?.covered).toBe(16);
    expect(v.pass).toBe(false);
  });

  it("fails on bloat: more groups than live + the allowance", () => {
    const bloated = (): ReplayRow =>
      row(
        ["file_edit"],
        { coding: 0.9, google: 0.9, browser: 0.9 },
        ["coding"],
        {
          latencyMs: 200,
        },
      );
    const v = judge(many(40, bloated), GRID, RULE, owners, scopeFor);
    expect(v.held?.meanGroups).toBe(3);
    expect(v.pass).toBe(false);
  });

  it("ignores English rows and fails with no verdict when nothing was sent", () => {
    const english = many(40, () => ({ ...good(), spanish: false }));
    expect(judge(english, GRID, RULE, owners, scopeFor).pass).toBe(false);
    expect(
      judge(
        many(40, () => row(["file_edit"], undefined)),
        GRID,
        RULE,
        owners,
        scopeFor,
      ).pass,
    ).toBe(false);
  });
});

describe("looksSensitive", () => {
  it("drops a login block whatever the secret's label is spelled like", () => {
    // Corpus replay 2026-09-21: "Pswd:" got past the keyword list and was sent.
    const secret = "Xy" + "7" + "kQ9" + "zz";
    expect(looksSensitive(`Login: alguien\n\nPswd:  ${secret}`)).toBe(true);
    expect(
      looksSensitive(`entra a mi liga\n\nLogin: alguien\n\nPswd: ${secret}`),
    ).toBe(true);
    expect(looksSensitive(`usuario = pedro`)).toBe(true);
    expect(looksSensitive(`psw ${secret}`)).toBe(true);
  });

  it("drops any label: value line whose value is one opaque token", () => {
    const secret = "Xy" + "7" + "kQ9" + "zz";
    expect(looksSensitive(`PIN del portal: ${secret}`)).toBe(true);
    expect(looksSensitive(`nota\nLlave=${secret}\nfin`)).toBe(true);
    // Not opaque: prose, a URL, a path, a date, a plain number.
    expect(looksSensitive("Tema: cierre del trimestre")).toBe(false);
    expect(looksSensitive("Fuente: https://example.com/a1b2c3")).toBe(false);
    expect(looksSensitive("Archivo: /root/claude/x1/notes.md")).toBe(false);
    expect(looksSensitive("Fecha: 2026-09-21")).toBe(false);
    expect(looksSensitive("leagueId: 123456789")).toBe(false);
    expect(looksSensitive("Proyecto: uncharted")).toBe(false);
  });

  it.each([
    "usa este token: abcd1234efgh",
    "mi clave es Verano2026",
    "el password del server es abc123",
    "key " + "a1B2".repeat(10),
    // AWS's documentation example, split so secret scanners stay quiet.
    "AKIA" + "IOSFODNN7" + "EXAMPLE",
    "xoxb-2345-7890-abcd",
    "postgres://user:s3cr3t@db:5432/app",
    "-----BEGIN RSA PRIVATE KEY-----",
    "cobra a la tarjeta 4111111111111111",
    "cobra a la tarjeta 4111 1111 1111 1111",
    "la tarjeta es 4111-1111-1111-1111",
    "entra con usuario pedro y clave Verano2026",
    "usuario admin / pass: hunter2",
    "la contra del server es abc12345",
  ])("drops %s", (text) => {
    expect(looksSensitive(text)).toBe(true);
  });

  it("lets ordinary chat through", () => {
    expect(looksSensitive("revisa el correo y agenda la junta")).toBe(false);
    expect(looksSensitive("corre los tests y haz push")).toBe(false);
    expect(looksSensitive("busca palabras clave para el task-42 en ASIA")).toBe(
      false,
    );
    expect(
      looksSensitive("dame las palabras clave principales del sitio"),
    ).toBe(false);
    expect(looksSensitive("estoy en contra de esa propuesta")).toBe(false);
  });
});

describe("isSpanish / percentile", () => {
  it("separates Spanish chat from English", () => {
    expect(isSpanish("revisa el correo de hoy")).toBe(true);
    expect(isSpanish("¿listo?")).toBe(true);
    expect(isSpanish("check the deploy log and fix it")).toBe(false);
  });

  it("returns the nearest-rank percentile", () => {
    const v = [5, 1, 3, 2, 4];
    expect(percentile(v, 50)).toBe(3);
    expect(percentile(v, 95)).toBe(5);
    expect(percentile([], 50)).toBeNaN();
  });
});
