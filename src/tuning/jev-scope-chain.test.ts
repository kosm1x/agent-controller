import { describe, expect, it } from "vitest";
import { CLASSIFIER_SYSTEM_PROMPT } from "../messaging/scope-classifier.js";
import type { PassRule, ToolOwners } from "./jev-scope-replay.js";
import {
  buildChainQuestions,
  buildChainState,
  evaluateChain,
  judgeChain,
  parseClassifierGuidance,
  parseExchanges,
  recentContextOf,
  recentUserMessagesOf,
  simulateChain,
  type ChainDeps,
  type ChainTurn,
  type TurnScope,
} from "./jev-scope-chain.js";

const MIN = 60_000;

function turn(id: number, over: Partial<ChainTurn> = {}): ChainTurn {
  return {
    id,
    atMs: id * MIN,
    raw: `mensaje ${id}`,
    message: `mensaje ${id}`,
    called: ["tool_a"],
    liveGroups: ["a"],
    liveTools: ["tool_a"],
    spanish: true,
    history: [],
    sendable: true,
    ...over,
  };
}

const owners: ToolOwners = {
  baseline: new Set(),
  owners: new Map([
    ["tool_a", new Set(["a"])],
    ["tool_b", new Set(["b"])],
  ]),
};
const asked = new Set(["a", "b"]);

/** Sticky union like the router: semantic ∪ prior, base = semantic alone. */
const deps: ChainDeps = {
  decide: (semantic, prior, regexFallback) => {
    if (semantic === null) {
      const groups = regexFallback();
      return { groups, base: groups };
    }
    if (semantic.size === 0 && prior)
      return { groups: new Set(prior), base: new Set(prior) };
    return {
      groups: new Set([...semantic, ...(prior ?? [])]),
      base: new Set(semantic),
    };
  },
  regexGroups: () => new Set(["regex"]),
  scope: (_m, _r, groups) => [...groups].map((g) => `tool_${g}`),
  ttlMs: 45 * MIN,
};

describe("parseExchanges", () => {
  it("splits rows into user and assistant turns, oldest first", () => {
    expect(
      parseExchanges(
        ["User: hola\nJarvis: qué tal", "User: b\nJarvis: c"],
        () => false,
      ),
    ).toEqual([
      { role: "user", content: "hola" },
      { role: "assistant", content: "qué tal" },
      { role: "user", content: "b" },
      { role: "assistant", content: "c" },
    ]);
  });

  it("keeps the user text and drops a poisoned reply", () => {
    expect(
      parseExchanges(["User: hola\nJarvis: BAD"], (t) => t === "BAD"),
    ).toEqual([{ role: "user", content: "hola" }]);
  });

  it("skips a row without a Jarvis part", () => {
    expect(parseExchanges(["User: sola"], () => false)).toEqual([]);
  });
});

describe("recentContextOf", () => {
  const history = [
    { role: "user" as const, content: "viejo" },
    { role: "assistant" as const, content: "y".repeat(200) },
  ];

  it("is the router's string: the thread WITH the current message appended, last two, 150 chars each", () => {
    // router.ts builds it exactly like this.
    const conversationHistory = [
      ...history,
      { role: "user" as const, content: "x".repeat(200) },
    ];
    const live = conversationHistory
      .slice(-2)
      .map((t) => `${t.role}: ${t.content.slice(0, 150)}`)
      .join("\n");
    const { text, omitted } = recentContextOf(history, "x".repeat(200));
    expect(text).toBe(live);
    expect(text).toBe(
      `assistant: ${"y".repeat(150)}\nuser: ${"x".repeat(150)}`,
    );
    expect(text).not.toContain("viejo");
    expect(omitted).toBe(0);
  });

  it("is the message alone on an empty thread", () => {
    expect(recentContextOf([], "hola").text).toBe("user: hola");
  });

  it("omits a sensitive turn WHOLE, however many lines its slice spans", () => {
    const secret = "aquí va:\nAEC1XBsecretosecreto\nfin";
    const { text, omitted } = recentContextOf(
      [{ role: "assistant", content: secret }],
      "ok",
      (t) => t.includes("AEC1XB"),
    );
    expect(text).toBe("assistant: [omitted]\nuser: ok");
    expect(text).not.toContain("secreto");
    expect(omitted).toBe(1);
  });
});

describe("recentUserMessagesOf", () => {
  it("is the last 4 user messages INCLUDING the current one, plus google/wp words of the last 2 replies", () => {
    const history = [
      ...[1, 2, 3, 4, 5].map((n) => ({
        role: "user" as const,
        content: `u${n}`,
      })),
      { role: "assistant" as const, content: "revisé tu Gmail ayer" },
      { role: "assistant" as const, content: "nada que ver" },
      { role: "assistant" as const, content: "el post de WordPress quedó" },
    ];
    expect(recentUserMessagesOf(history, "actual")).toEqual([
      "u3",
      "u4",
      "u5",
      "actual",
      "post WordPress",
    ]);
  });
});

describe("parseClassifierGuidance", () => {
  it("pulls the RULES bullets and the annotated examples of the production prompt", () => {
    const { rules, examples } = parseClassifierGuidance(
      CLASSIFIER_SYSTEM_PROMPT,
    );
    expect(rules.length).toBeGreaterThanOrEqual(8);
    expect(rules.some((r) => r.includes("Short follow-ups"))).toBe(true);
    expect(rules.some((r) => r.includes("Journal/editorial"))).toBe(true);
    expect(examples.length).toBeGreaterThanOrEqual(3);
    expect(examples.every((e) => e.startsWith("["))).toBe(true);
    // Every bullet under RULES: made it across — none silently dropped.
    const lines = CLASSIFIER_SYSTEM_PROMPT.split("\n");
    const after = lines.slice(
      lines.findIndex((l) => l.trim() === "RULES:") + 1,
    );
    const end = after.findIndex((l) => !l.startsWith("- "));
    expect(rules.length).toBe(end === -1 ? after.length : end);
  });

  it("returns nothing for a prompt without the block", () => {
    expect(parseClassifierGuidance("no rules here")).toEqual({
      rules: [],
      examples: [],
    });
  });
});

describe("buildChainQuestions / buildChainState", () => {
  it("asks one noul per group with the description verbatim", () => {
    const q = buildChainQuestions(new Map([["coding", "shell, files, git"]]));
    expect(Object.keys(q)).toEqual(["g_coding"]);
    expect(q.g_coding.type).toBe("noul");
    expect(q.g_coding.criteria).toMatchObject({ true: "shell, files, git" });
    expect(q.g_coding.instructions).toContain("recent_context");
    expect(q.g_coding.instructions).toContain("classifier_rules");
  });

  it("carries only the message, the context and the guidance", () => {
    expect(
      buildChainState("m", "user: x", { rules: ["r"], examples: ["e"] }),
    ).toEqual({
      message: "m",
      recent_context: "user: x",
      classifier_rules: ["r"],
      classifier_examples: ["e"],
    });
  });
});

describe("simulateChain", () => {
  const answers = (map: Record<number, string[] | null>) => (t: ChainTurn) =>
    map[t.id] === null ? null : new Set(map[t.id] ?? []);

  it("hands the previous turn's BASE as the prior, never its union", () => {
    const scopes = simulateChain(
      [turn(1), turn(2), turn(3)],
      answers({ 1: ["a"], 2: ["b"], 3: ["c"] }),
      deps,
    );
    expect(scopes.map((s) => s.groups.sort())).toEqual([
      ["a"],
      ["a", "b"],
      ["b", "c"], // not a+b+c: turn 2's base was b alone
    ]);
  });

  it("drops the prior once it is older than the TTL", () => {
    const scopes = simulateChain(
      [turn(1), turn(2, { atMs: 1 * MIN + 45 * MIN + 1 })],
      answers({ 1: ["a"], 2: ["b"] }),
      deps,
    );
    expect(scopes[1].groups).toEqual(["b"]);
  });

  it("keeps the prior at exactly the TTL", () => {
    const scopes = simulateChain(
      [turn(1), turn(2, { atMs: 1 * MIN + 45 * MIN })],
      answers({ 1: ["a"], 2: ["b"] }),
      deps,
    );
    expect(scopes[1].groups.sort()).toEqual(["a", "b"]);
  });

  it("wipes the prior at a restart between two turns", () => {
    const scopes = simulateChain(
      [turn(1), turn(2)],
      answers({ 1: ["a"], 2: ["b"] }),
      { ...deps, restartsMs: [1.5 * MIN] },
    );
    expect(scopes[1].groups).toEqual(["b"]);
  });

  it("ignores a restart that happened before the prior was set", () => {
    const scopes = simulateChain(
      [turn(1), turn(2)],
      answers({ 1: ["a"], 2: ["b"] }),
      { ...deps, restartsMs: [0.5 * MIN] },
    );
    expect(scopes[1].groups.sort()).toEqual(["a", "b"]);
  });

  it("leaves the prior untouched across a turn that was never sent, and refreshes its clock", () => {
    const scopes = simulateChain(
      [
        turn(1),
        turn(2, { sendable: false, atMs: 40 * MIN }),
        turn(3, { atMs: 80 * MIN }),
      ],
      answers({ 1: ["a"], 2: null, 3: ["b"] }),
      deps,
    );
    expect(scopes[1].groups).toEqual(["regex"]);
    // Prior is still turn 1's base (not "regex"), and still young: 80−40 ≤ 45.
    expect(scopes[2].groups.sort()).toEqual(["a", "b"]);
  });

  it("does not resurrect a prior the TTL had already killed when an unsent turn refreshes the clock", () => {
    const scopes = simulateChain(
      [
        turn(1),
        turn(2, { sendable: false, atMs: 50 * MIN }),
        turn(3, { atMs: 60 * MIN }),
      ],
      answers({ 1: ["a"], 2: null, 3: ["b"] }),
      deps,
    );
    // Live wrote a fresh prior at turn 2; Jev has none to write, and turn 1's
    // was dead by then (50−1 > 45) — it must not come back at turn 3.
    expect(scopes[2].groups).toEqual(["b"]);
  });

  it("does not carry a prior across a restart through an unsent turn", () => {
    const scopes = simulateChain(
      [turn(1), turn(2, { sendable: false }), turn(3)],
      answers({ 1: ["a"], 2: null, 3: ["b"] }),
      { ...deps, restartsMs: [1.5 * MIN] },
    );
    expect(scopes[2].groups).toEqual(["b"]);
  });

  it("hands the scoper the recent messages with the current one included", () => {
    const seen: string[][] = [];
    simulateChain(
      [
        turn(1, {
          raw: "crudo",
          history: [{ role: "user", content: "antes" }],
        }),
      ],
      answers({ 1: ["a"] }),
      { ...deps, scope: (_m, recent) => (seen.push(recent), []) },
    );
    expect(seen).toEqual([["antes", "crudo"]]);
  });

  it("falls to the regex detector when the classifier gave no answer", () => {
    const scopes = simulateChain([turn(1)], answers({ 1: null }), deps);
    expect(scopes[0]).toEqual({ groups: ["regex"], tools: ["tool_regex"] });
  });

  it("reports the groups the scoper injected", () => {
    const scopes = simulateChain([turn(1)], answers({ 1: ["a"] }), {
      ...deps,
      scope: (_m, _r, groups) => {
        groups.add("injected");
        return ["tool_a"];
      },
    });
    expect(scopes[0].groups.sort()).toEqual(["a", "injected"]);
  });
});

describe("evaluateChain", () => {
  it("scores only included turns that needed a group, counting asked groups", () => {
    const turns = [
      turn(1),
      turn(2, { called: ["tool_b"] }),
      turn(3, { called: [] }),
      turn(4, { spanish: false }),
    ];
    const scopes: TurnScope[] = [
      { groups: ["a", "unasked"], tools: ["tool_a"] },
      { groups: ["a"], tools: ["tool_a"] },
      { groups: [], tools: [] },
      { groups: ["a"], tools: ["tool_a"] },
    ];
    const e = evaluateChain(turns, scopes, (t) => t.spanish, owners, asked);
    expect(e).toMatchObject({ rows: 3, scored: 2, covered: 1, coverage: 0.5 });
    expect(e.meanGroups).toBeCloseTo(2 / 3);
  });
});

describe("judgeChain", () => {
  const rule: PassRule = {
    coverage: 0.95,
    extraGroups: 1,
    p95Ms: 800,
    minAnswerRate: 0.9,
    minHeldScored: 3,
  };
  const good: TurnScope = { groups: ["a"], tools: ["tool_a"] };
  const bad: TurnScope = { groups: ["b"], tools: ["tool_b"] };
  const answered = (n: number): ChainTurn[] =>
    Array.from({ length: n }, (_, i) =>
      turn(i + 1, { nouls: { a: 1 }, latencyMs: 100 }),
    );
  const judge = (
    turns: ChainTurn[],
    scopesAt: (t: number) => TurnScope[],
    over: { stopped?: string | null; live?: TurnScope[] } = {},
  ) =>
    judgeChain(
      turns,
      [0.3, 0.5],
      scopesAt,
      over.live ?? turns.map(() => good),
      (t) => t.sendable,
      rule,
      owners,
      asked,
      over.stopped ?? null,
    );

  it("passes a classifier that covers both halves and picks the LARGEST passing threshold", () => {
    const turns = answered(8);
    const v = judge(turns, () => turns.map(() => good));
    expect(v.pass).toBe(true);
    expect(v.threshold).toBe(0.5);
    expect(v.checks).toHaveLength(7);
  });

  it("picks the threshold on the first half only, then judges the second", () => {
    const turns = answered(8);
    // T=0.5 fails the first half; T=0.3 covers the first half but not the second.
    const v = judge(turns, (t) =>
      turns.map((_, i) => (t === 0.5 ? bad : i < 4 ? good : bad)),
    );
    expect(v.threshold).toBe(0.3);
    expect(v.tune?.coverage).toBe(1);
    expect(v.held?.coverage).toBe(0);
    expect(v.pass).toBe(false);
  });

  it("fails when no threshold reaches the bar on the first half", () => {
    const turns = answered(8);
    const v = judge(turns, () => turns.map(() => bad));
    expect(v.threshold).toBeNull();
    expect(v.pass).toBe(false);
    expect(v.checks).toHaveLength(4);
  });

  it("fails an early stop even when everything else is green", () => {
    const turns = answered(8);
    const v = judge(turns, () => turns.map(() => good), { stopped: "401" });
    expect(v.pass).toBe(false);
    expect(v.checks[0]).toMatchObject({ ok: false });
  });

  it("fails a low answer rate, counted over every sent request", () => {
    const turns = answered(8);
    turns[0] = turn(1, { latencyMs: 100, error: "TimeoutError" });
    const v = judge(turns, () => turns.map(() => good));
    expect(v.answerRate).toBeCloseTo(7 / 8);
    expect(v.pass).toBe(false);
  });

  it("fails a slow p95, failed requests included", () => {
    const turns = answered(8);
    turns[7] = turn(8, { latencyMs: 5000, error: "TimeoutError" });
    const v = judge(turns, () => turns.map(() => good));
    expect(v.p95Ms).toBe(5000);
    expect(v.checks[2]).toMatchObject({ ok: false });
  });

  it("fails too few scored turns in the second half", () => {
    const turns = answered(8).map((t, i) =>
      i >= 6 ? { ...t, called: [] } : t,
    );
    const v = judge(turns, () => turns.map(() => good));
    expect(v.held?.scored).toBe(2);
    expect(v.pass).toBe(false);
  });

  it("fails a scope more than one group wider than live through the same chain", () => {
    const turns = answered(8);
    const wide: TurnScope = { groups: ["a", "b"], tools: ["tool_a", "tool_b"] };
    const narrowLive: TurnScope = { groups: [], tools: [] };
    const v = judge(turns, () => turns.map(() => wide), {
      live: turns.map(() => narrowLive),
    });
    expect(v.liveMeanGroups).toBe(0);
    expect(v.held?.meanGroups).toBe(2);
    expect(v.pass).toBe(false);
    // One wider is allowed.
    expect(
      judge(turns, () => turns.map(() => wide), {
        live: turns.map(() => good),
      }).pass,
    ).toBe(true);
  });

  it("fails closed on an empty first half, an unscored second half and nothing sent", () => {
    const english = answered(8).map((t) => ({ ...t, spanish: false }));
    const none = judge(english, () => english.map(() => good));
    expect(none.threshold).toBeNull();
    expect(none.pass).toBe(false);

    const toolless = answered(8).map((t, i) =>
      i >= 4 ? { ...t, called: [] } : t,
    );
    const unscored = judge(toolless, () => toolless.map(() => good));
    expect(unscored.held?.scored).toBe(0);
    expect(Number.isNaN(unscored.held?.coverage)).toBe(true);
    expect(unscored.checks[5]).toMatchObject({ ok: false });
    expect(unscored.pass).toBe(false);

    const unsent = Array.from({ length: 8 }, (_, i) => turn(i + 1));
    // p95 of nothing is NaN, and NaN must not pass the latency check.
    const p95 = judge(unsent, () => unsent.map(() => good));
    expect(Number.isNaN(p95.p95Ms)).toBe(true);
    expect(p95.checks[2]).toMatchObject({ ok: false });
    const silent = judge(unsent, () => unsent.map(() => good));
    expect(silent.answerRate).toBe(0);
    expect(silent.checks[1]).toMatchObject({ ok: false });
    expect(silent.pass).toBe(false);
  });

  it("leaves unsendable and non-Spanish turns out of both halves", () => {
    const turns = answered(8);
    turns[5] = turn(6, { sendable: false, called: ["tool_b"] });
    turns[6] = turn(7, {
      spanish: false,
      called: ["tool_b"],
      nouls: { a: 1 },
      latencyMs: 100,
    });
    const v = judge(turns, () => turns.map(() => good));
    expect(v.held?.rows).toBe(2);
    expect(v.held?.coverage).toBe(1);
  });
});
