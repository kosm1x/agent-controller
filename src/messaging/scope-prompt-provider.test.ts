/**
 * Queue 3j R2 W2: `classifyScopeGroups` tells its observer which classifier
 * answered — the label each eval-gate scope_prompt row records
 * (`details.provider`). Jev and the adapter are mocked (never a real call).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const { jevEnabled, jevClassify, adapterInfer } = vi.hoisted(() => ({
  jevEnabled: vi.fn(),
  jevClassify: vi.fn(),
  adapterInfer: vi.fn(),
}));
vi.mock("./scope-classifier-jev.js", () => ({
  jevScopeEnabled: jevEnabled,
  classifyScopeGroupsWithJev: jevClassify,
}));
vi.mock("../inference/adapter.js", () => ({ infer: adapterInfer }));

import { classifyScopeGroups } from "./scope-classifier.js";

afterEach(() => {
  vi.resetAllMocks();
});

describe("classifyScopeGroups onAnswer provider label", () => {
  it("Jev answers: the observer hears \"jev\" once and Sonnet is never called", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    jevEnabled.mockReturnValue(true);
    jevClassify.mockResolvedValue(new Set(["coding"]));
    const onAnswer = vi.fn();
    const groups = await classifyScopeGroups("hola", undefined, undefined, onAnswer);
    expect(groups?.has("coding")).toBe(true);
    expect(onAnswer.mock.calls).toEqual([["jev"]]);
    expect(adapterInfer).not.toHaveBeenCalled();
  });

  it("Jev withholds and Sonnet throws: the observer hears \"none\" and the answer is null", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    jevEnabled.mockReturnValue(true);
    jevClassify.mockResolvedValue(null);
    adapterInfer.mockRejectedValue(new Error("synthetic provider error"));
    const onAnswer = vi.fn();
    expect(await classifyScopeGroups("hola", undefined, undefined, onAnswer)).toBeNull();
    expect(onAnswer.mock.calls).toEqual([["none"]]);
  });
});
