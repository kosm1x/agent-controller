/**
 * Fast runner — the messages it assembles for the model, pinned by digest.
 *
 * Each case runs one shape of task through `fastRunner.execute` on the
 * tool-loop path and records two things at the moment the model would be
 * called: the sha256 of `JSON.stringify` of the messages array, and the
 * ordered calls the run made to the recording stand-ins below (their names
 * as a readable list; their arguments, together with those of the
 * essentials and precedent reads, as a second sha256; an error counts as
 * its message, a function as a placeholder). The messages digest covers the
 * system and user texts the runner adds (the system texts, the status
 * suffix, the recall block header and fact lines, the task template, the
 * data-guard texts, the vision content shape and the cache flags) together
 * with the synthetic fixtures of this file.
 *
 * A deliberate change of any of those texts, or of the order or flags of the
 * messages, turns the digests red with two hashes and no readable diff. The
 * maintainer then re-derives the digests from the values the failure output
 * reports as received; the repository's rule for prompt changes applies to
 * the change itself.
 *
 * Faked for the whole file: the tool-loop and SDK calls, the config, the tool
 * registry, the dispatcher, trace, metrics, the drop counter, the evidence
 * record, telemetry, checkpoint, prompt dump, the knowledge-base, precedent,
 * essentials and recall modules, the recall deadline (no real timer), the two
 * shadow modules, the read-only tool rule, the data-guard helpers, the
 * confirmation verbs, the secret scrub, and the database (an access throws
 * and fails the test).
 */

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../inference/adapter.js";
import type { ConversationTurn, RunnerInput } from "./types.js";

interface Fixture {
  definitions: number;
  essentials: string;
  kbSingle: string;
  kbSplit: { stable: string | null; variable: string | null };
  kbDrop: boolean;
  precedent: string;
  recallQuery: string | null;
  facts: Array<{ category: string; factText: string }>;
  recall: "ok" | "timeout" | "error";
  shadowRecallThrows: boolean;
  guard: "off" | "advisory" | "full" | "none";
}

const h = vi.hoisted(() => {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const inputs: Record<string, unknown[]> = {};
  return {
    calls,
    inputs,
    rec: (name: string, args: unknown[]) => {
      calls.push({ name, args });
    },
    fx: {} as Fixture,
  };
});
const dbGuard = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("messages-digest test: database access");
  }),
);

vi.mock("../dispatch/dispatcher.js", () => ({ registerRunner: vi.fn() }));
vi.mock("../config.js", () => ({
  getConfig: vi.fn(() => ({
    inferencePrimaryProvider: "openai",
    inferencePrimaryUrl: "http://127.0.0.1:1",
    inferencePrimaryKey: "test-key",
    inferencePrimaryModel: "test-model",
    inferenceContextLimit: 200_000,
    compressionThreshold: 0.85,
    inferenceTimeoutMs: 30_000,
    inferenceMaxTokens: 4096,
    inferenceMaxRetries: 1,
  })),
}));
vi.mock("../tools/registry.js", async (importOriginal) => ({
  writeTargetKeys: (
    await importOriginal<typeof import("../tools/registry.js")>()
  ).writeTargetKeys,
  toolRegistry: {
    getDefinitions: vi.fn(),
    getDeferredCatalog: vi.fn(),
    get: vi.fn(() => undefined),
    has: vi.fn(() => false),
    findClosest: vi.fn(() => null),
  },
}));
vi.mock("../inference/adapter.js", async (importOriginal) => ({
  inferWithTools: vi.fn(),
  sdkLastline: vi.fn(() => null),
  lastlineEligible: (
    await importOriginal<typeof import("../inference/adapter.js")>()
  ).lastlineEligible,
  inferWithToolsLastline: vi.fn(),
}));
vi.mock("../inference/claude-sdk.js", () => ({
  queryClaudeSdk: vi.fn(),
  toolSearchEnabled: () => false,
}));
vi.mock("../intelligence/scope-telemetry.js", () => ({
  recordToolExecution: vi.fn(),
  recordToolRepairs: vi.fn(),
}));
vi.mock("./checkpoint.js", () => ({ writeCheckpoint: vi.fn() }));
vi.mock("../observability/task-trace.js", () => ({
  emitTraceEvent: (...a: unknown[]) => h.rec("emitTraceEvent", a),
}));
vi.mock("./prompt-dump.js", () => ({ dumpPrompt: vi.fn() }));
vi.mock("../observability/prometheus.js", () => ({
  recordFastRetryOutcome: vi.fn(),
  recordMemoryInjection: (...a: unknown[]) => h.rec("recordMemoryInjection", a),
}));
vi.mock("../observability/failure-counters.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../observability/failure-counters.js")
  >()),
  notePromptBlockDropped: (...a: unknown[]) =>
    h.rec("notePromptBlockDropped", a),
}));
vi.mock("../lib/v8-4/numbers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/v8-4/numbers.js")>()),
  recordInjectedEvidence: (...a: unknown[]) =>
    h.rec("recordInjectedEvidence", a),
}));
vi.mock("../inference/guards.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../inference/guards.js")>()),
  isReadOnlyTool: (name: string) => name.startsWith("read_"),
}));
vi.mock("../messaging/kb-injection.js", () => ({
  buildKnowledgeBaseSection: (...a: unknown[]) => {
    h.rec("buildKnowledgeBaseSection", a);
    return h.fx.kbSingle;
  },
  buildKnowledgeBaseSections: (...a: unknown[]) => {
    h.rec("buildKnowledgeBaseSections", a);
    if (h.fx.kbDrop)
      (a[4] as (block: string, reason: string) => void)(
        "synthetic-block",
        "synthetic-reason",
      );
    return { ...h.fx.kbSplit };
  },
  conditionMatches: vi.fn(() => false),
}));
vi.mock("../messaging/precedent.js", () => ({
  buildPrecedentBlock: (...a: unknown[]) => {
    h.inputs.precedent = a;
    return h.fx.precedent;
  },
}));
vi.mock("../memory/essentials.js", () => ({
  getEssentialFacts: (...a: unknown[]) => {
    h.inputs.essentials = a;
    return h.fx.essentials;
  },
}));
vi.mock("../memory/jme.js", () => ({
  queryMemory: (...a: unknown[]) => {
    h.rec("queryMemory", a);
    return h.fx.recall === "error"
      ? Promise.reject(new Error("synthetic recall failure"))
      : Promise.resolve(h.fx.facts);
  },
  orderForInjection: <T>(facts: T[]) => [...facts].reverse(),
  jmeRecallQuery: (text: string) =>
    h.fx.recallQuery === null ? null : `${h.fx.recallQuery}:${text}`,
}));
vi.mock("../lib/with-timeout.js", () => ({
  withTimeout: (p: Promise<unknown>, ms: number, label: string) => {
    h.rec("withTimeout", [ms, label]);
    return h.fx.recall === "timeout"
      ? Promise.reject(new Error(`${label} timeout`))
      : p;
  },
}));
vi.mock("../jev/shadow-kb.js", () => ({
  shadowKbRows: (...a: unknown[]) => h.rec("shadowKbRows", a),
}));
vi.mock("../jev/shadow.js", () => ({
  shadowMemoryRecall: (...a: unknown[]) => {
    h.rec("shadowMemoryRecall", a);
    if (h.fx.shadowRecallThrows) throw new Error("synthetic shadow failure");
  },
}));
vi.mock("./denue-guard.js", () => ({
  denueGuardText: (input: { title: string }) => `guard check: ${input.title}`,
  mentionsDenue: (text: string) => {
    h.rec("mentionsDenue", [text]);
    return h.fx.guard !== "off";
  },
  highStakesGuardVariant: (...a: unknown[]) => {
    h.rec("highStakesGuardVariant", a);
    return h.fx.guard;
  },
}));
vi.mock("../messaging/confirmation-verbs.js", () => ({
  buildConfirmRegex: vi.fn(() => /confirma/i),
}));
vi.mock("../lib/secret-refs.js", () => ({
  scrubSecrets: (t: string) => t,
  scrubJsonText: (t: string) => t,
  scrubStructured: (v: unknown) => v,
  SecretScrubUnavailableError: class extends Error {},
}));
vi.mock("../db/index.js", () => ({ getDatabase: dbGuard }));

import { fastRunner } from "./fast-runner.js";
import { inferWithTools } from "../inference/adapter.js";
import { toolRegistry } from "../tools/registry.js";
import { CACHE_BREAK_MARKER } from "../messaging/cache-marker.js";

const CATALOG = "[DEFERRED TOOLS] synthetic catalog";

const def = (name: string) => ({
  type: "function" as const,
  function: {
    name,
    description: `${name} (synthetic)`,
    parameters: { type: "object", properties: {}, required: [] },
  },
});

const mockInfer = vi.mocked(inferWithTools);
const mockGetDefinitions = vi.mocked(toolRegistry.getDefinitions);
const mockGetCatalog = vi.mocked(toolRegistry.getDeferredCatalog);

const inferResult = () => ({
  content: "STATUS: DONE\nReady.",
  messages: [] as ChatMessage[],
  totalUsage: { prompt_tokens: 1000, completion_tokens: 100 },
  toolRepairs: [] as Array<{ original: string; repaired: string }>,
  exitReason: "done",
  roundsCompleted: 1,
  contextPressure: 0.1,
  compactionApplied: undefined,
  model: "test-model",
});

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const argsText = (value: unknown) =>
  JSON.stringify(value, (_key, v: unknown) => {
    if (v === undefined) return "<undefined>";
    if (typeof v === "function") return "<function>";
    if (v instanceof Error) return { error: v.message };
    return v;
  });

const baseFixture = (): Fixture => ({
  definitions: 3,
  essentials: "",
  kbSingle: "",
  kbSplit: { stable: null, variable: null },
  kbDrop: false,
  precedent: "",
  recallQuery: null,
  facts: [],
  recall: "ok",
  shadowRecallThrows: false,
  guard: "off",
});

const twoFacts = [
  { category: "preference", factText: "synthetic preference fact" },
  { category: "project", factText: "synthetic project fact" },
];
const wideFacts = Array.from({ length: 8 }, (_, i) => ({
  category: "note",
  factText: `synthetic wide fact ${i} ${"lorem ".repeat(170)}`,
}));
const oneTurn: ConversationTurn[] = [
  { role: "user", content: "a synthetic question" },
];
const threeTurns: ConversationTurn[] = [
  { role: "user", content: "first synthetic question" },
  { role: "assistant", content: "first synthetic answer" },
  { role: "user", content: "second synthetic question" },
];
const splitDescription = `stable synthetic persona${CACHE_BREAK_MARKER}variable synthetic persona`;

interface Shape {
  name: string;
  input: Partial<RunnerInput>;
  fx: Partial<Fixture>;
  calls: string[];
  digests: readonly [messages: string, calls: string];
}

const SHAPES: Shape[] = [
  {
    name: "chat turn with essentials, both knowledge parts, a precedent, recalled facts and a deferred catalog",
    input: {
      description: splitDescription,
      tools: ["read_notes", "write_notes"],
      conversationHistory: threeTurns,
    },
    fx: {
      definitions: 7,
      essentials: "synthetic essentials",
      kbSplit: { stable: "synthetic stable rows", variable: "synthetic conditional rows" },
      kbDrop: true,
      precedent: "synthetic precedent block",
      recallQuery: "query",
      facts: twoFacts,
    },
    calls: [
      "buildKnowledgeBaseSections",
      "emitTraceEvent prompt.block_dropped",
      "shadowKbRows",
      "queryMemory",
      "withTimeout",
      "recordMemoryInjection",
      "shadowMemoryRecall",
      "recordInjectedEvidence",
      "mentionsDenue",
    ],
    digests: [
      "1e6836d0b2aeef0a28214248d7f818dbba9ba16c0a47275abec464102b2a83c5",
      "c40ac5eae6bd8cc85426d23d0c951440a1dacf4954a6d8743d8196d22d9fc289",
    ],
  },
  {
    name: "chat turn with every optional part absent",
    input: {
      description: "synthetic persona without a marker",
      tools: ["write_notes"],
      conversationHistory: oneTurn,
    },
    fx: {},
    calls: [
      "buildKnowledgeBaseSections",
      "shadowKbRows",
      "recordInjectedEvidence",
      "mentionsDenue",
    ],
    digests: [
      "e3a474c5f1e88393044baf7000dc91944c4d4e410882e4eb54e715e84f130c61",
      "3ab21a0f703cf784947ab9d12c5550e8f0b9c7544da87abd534e02b42d467efa",
    ],
  },
  {
    name: "chat turn whose recall misses its deadline",
    input: {
      description: splitDescription,
      tools: ["write_notes"],
      conversationHistory: oneTurn,
    },
    fx: { recallQuery: "query", facts: twoFacts, recall: "timeout" },
    calls: [
      "buildKnowledgeBaseSections",
      "shadowKbRows",
      "queryMemory",
      "withTimeout",
      "notePromptBlockDropped",
      "emitTraceEvent prompt.block_dropped",
      "recordInjectedEvidence",
      "mentionsDenue",
    ],
    digests: [
      "7c40adffce247becb4640bb42047219cf754e1c3f99a78261751116c084f6899",
      "16835b352509df8ba0a7f944f0b0649126219b250eeec49595c77dbfc54528c0",
    ],
  },
  {
    name: "chat turn whose recall fails",
    input: {
      description: splitDescription,
      tools: ["write_notes"],
      conversationHistory: oneTurn,
    },
    fx: { recallQuery: "query", recall: "error" },
    calls: [
      "buildKnowledgeBaseSections",
      "shadowKbRows",
      "queryMemory",
      "withTimeout",
      "notePromptBlockDropped",
      "emitTraceEvent prompt.block_dropped",
      "recordInjectedEvidence",
      "mentionsDenue",
    ],
    digests: [
      "7c40adffce247becb4640bb42047219cf754e1c3f99a78261751116c084f6899",
      "b993f12b1877d95bf152bb79528d5a314ae672366e615a3ad0977f51356d7261",
    ],
  },
  {
    name: "chat turn where a throw after the recall block leaves the block in",
    input: {
      description: splitDescription,
      tools: ["write_notes"],
      conversationHistory: oneTurn,
    },
    fx: { recallQuery: "query", facts: twoFacts, shadowRecallThrows: true },
    calls: [
      "buildKnowledgeBaseSections",
      "shadowKbRows",
      "queryMemory",
      "withTimeout",
      "recordMemoryInjection",
      "shadowMemoryRecall",
      "recordInjectedEvidence",
      "mentionsDenue",
    ],
    digests: [
      "00d4e175ae6d662e2f801f1c28c170743059ea9eaae31f1e7a40b71ce4361570",
      "9b7822a460a35bdda67111a715cd8a678ec7e791d56f5b7f937cb2a43b9fff2c",
    ],
  },
  {
    name: "chat turn whose recalled facts exceed the block budget and whose message exceeds the query cap",
    input: {
      description: splitDescription,
      tools: ["write_notes"],
      conversationHistory: [
        { role: "user", content: `a long synthetic question ${"ipsum ".repeat(420)}` },
      ],
    },
    fx: { recallQuery: "query", facts: wideFacts },
    calls: [
      "buildKnowledgeBaseSections",
      "shadowKbRows",
      "queryMemory",
      "withTimeout",
      "recordMemoryInjection",
      "shadowMemoryRecall",
      "recordInjectedEvidence",
      "mentionsDenue",
    ],
    digests: [
      "057aafb9395883382f6f63c26088b8cfc6a872c61de2f938b92a6d6b03c8843b",
      "64c2ffe6772a5713d257e50faa70ec1330507b22501fde97dda510a9568f8454",
    ],
  },
  {
    name: "chat turn with an image on a user turn and on an assistant turn",
    input: {
      description: splitDescription,
      tools: ["write_notes"],
      conversationHistory: [
        { role: "user", content: "look at this synthetic picture", imageUrl: "data:image/png;base64,AAAA" },
        { role: "assistant", content: "a synthetic description", imageUrl: "data:image/png;base64,BBBB" },
        { role: "user", content: "and now?" },
      ],
    },
    fx: { precedent: "synthetic precedent block" },
    calls: [
      "buildKnowledgeBaseSections",
      "shadowKbRows",
      "recordInjectedEvidence",
      "mentionsDenue",
    ],
    digests: [
      "cc16b0d852493d17258c1d062436bb0ccdccef08776d6d85f923ae64dfddcb7e",
      "db0cb56a2c7d06c8f16ba7c1c4f01d476b3bf4b223c908a140ab9e5f1bdf30db",
    ],
  },
  {
    name: "chat turn whose tools are all read-only",
    input: {
      description: splitDescription,
      tools: ["read_notes", "read_files"],
      conversationHistory: oneTurn,
    },
    fx: {
      kbSingle: "synthetic single section",
      recallQuery: "query",
      facts: twoFacts,
    },
    calls: [
      "buildKnowledgeBaseSection",
      "queryMemory",
      "withTimeout",
      "recordMemoryInjection",
      "recordInjectedEvidence",
      "mentionsDenue",
    ],
    digests: [
      "fb25a6777f6ba09e9f1dff0f1af5a3256f443d0bfb035448d15eb76db3755d4d",
      "7f25f52482545d7d2159b3162907f1daf10589310ea3a744533fae7a99fffba1",
    ],
  },
  {
    name: "chat turn from an external caller",
    input: {
      description: splitDescription,
      tools: ["read_notes"],
      conversationHistory: threeTurns,
      external: { maxRounds: 2 },
    },
    fx: {
      essentials: "synthetic essentials",
      kbSplit: { stable: "synthetic stable rows", variable: "synthetic conditional rows" },
      precedent: "synthetic precedent block",
      recallQuery: "query",
      facts: twoFacts,
    },
    calls: ["buildKnowledgeBaseSections", "recordInjectedEvidence", "mentionsDenue"],
    digests: [
      "fb18bc04ea27a45fdc66c90856547a062b1ed67cf805bd1160dd8a44a09a5314",
      "43f75f76ccf6215e77717f8df41bb653d5a78d75bd44de5812a39db694d7c6ee",
    ],
  },
  {
    name: "task without a conversation, with a deferred catalog and a marker in its description",
    input: { description: splitDescription, tools: ["write_notes"] },
    fx: { definitions: 7 },
    calls: ["mentionsDenue"],
    digests: [
      "9e6e972dcdcd61d79bad6a8ba1bdac37fb61c5f14ed166fc9d1fd0329c3ebe1a",
      "023aad22095530c25dd5333d72c597fda2d64330ea99526fe9e7dd454904842e",
    ],
  },
  {
    name: "task without a conversation and without a deferred catalog",
    input: { description: "a synthetic task description", tools: ["write_notes"] },
    fx: {},
    calls: ["mentionsDenue"],
    digests: [
      "b011efc63e440792455531ec2df74c2959fb19b1055c5d5e9250eaef4692aa11",
      "023aad22095530c25dd5333d72c597fda2d64330ea99526fe9e7dd454904842e",
    ],
  },
  {
    name: "task given the short data-guard text",
    input: { description: "a synthetic task description", tools: ["write_notes"] },
    fx: { guard: "advisory" },
    calls: ["mentionsDenue", "highStakesGuardVariant"],
    digests: [
      "d1b5598bae630e18bd02ea67dc4c6c711859c156283a7a89e9f0b9055e68c637",
      "a859439bafc57d817fe9f6d3cc23ae3d637116ab64b156ea6cc856e844d2dd42",
    ],
  },
  {
    name: "task given the long data-guard text",
    input: { description: "a synthetic task description", tools: ["write_notes"] },
    fx: { guard: "full" },
    calls: ["mentionsDenue", "highStakesGuardVariant"],
    digests: [
      "14da741d4683ecb82a9004bdb49f39703804402e4a592461399bf6aee3f26b2c",
      "a859439bafc57d817fe9f6d3cc23ae3d637116ab64b156ea6cc856e844d2dd42",
    ],
  },
  {
    name: "task where the data guard is triggered but no guard text applies",
    input: { description: "a synthetic task description", tools: ["write_notes"] },
    fx: { guard: "none" },
    calls: ["mentionsDenue", "highStakesGuardVariant"],
    digests: [
      "b011efc63e440792455531ec2df74c2959fb19b1055c5d5e9250eaef4692aa11",
      "a859439bafc57d817fe9f6d3cc23ae3d637116ab64b156ea6cc856e844d2dd42",
    ],
  },
];

let logSpy: { mockRestore: () => void };
let atModel: { messages: string; calls: Array<{ name: string; args: unknown[] }> }[];

beforeEach(() => {
  vi.clearAllMocks();
  h.calls.length = 0;
  for (const k of Object.keys(h.inputs)) delete h.inputs[k];
  atModel = [];
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  mockGetCatalog.mockImplementation(() => CATALOG);
  mockInfer.mockImplementation(async (messages) => {
    atModel.push({ messages: JSON.stringify(messages), calls: [...h.calls] });
    return inferResult();
  });
});

afterEach(() => {
  logSpy.mockRestore();
  expect(dbGuard).not.toHaveBeenCalled();
});

describe("fast runner — the assembled messages, pinned by digest", () => {
  for (const shape of SHAPES) {
    it(shape.name, async () => {
      h.fx = { ...baseFixture(), ...shape.fx };
      mockGetDefinitions.mockImplementation(() =>
        Array.from({ length: h.fx.definitions }, (_, i) => def(`tool_${i}`)),
      );
      const r = await fastRunner.execute({
        taskId: "task-md",
        runId: "run-md",
        title: "Synthetic task title",
        description: "",
        interactive: false,
        ...shape.input,
      });
      expect(r.success).toBe(true);
      expect(atModel).toHaveLength(1);
      const seen = atModel[0]!;
      expect
        .soft(
          seen.calls.map((c) =>
            c.name === "emitTraceEvent"
              ? `emitTraceEvent ${(c.args[0] as { name: string }).name}`
              : c.name,
          ),
          "calls",
        )
        .toEqual(shape.calls);
      expect.soft(sha256(seen.messages), "messages").toBe(shape.digests[0]);
      expect
        .soft(
          sha256(argsText({ ordered: seen.calls, inputs: h.inputs })),
          "call arguments",
        )
        .toBe(shape.digests[1]);
    });
  }
});
