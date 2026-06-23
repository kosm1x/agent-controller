import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getXRouter, XPostRouter } from "./index.js";

const saved: Record<string, string | undefined> = {};
const X_KEYS = Object.keys(process.env).filter((k) => k.startsWith("X_"));

beforeEach(() => {
  for (const k of X_KEYS) saved[k] = process.env[k];
  for (const k of Object.keys(process.env))
    if (k.startsWith("X_")) delete process.env[k];
  process.env.X_AUTH_TOKEN__iooking4ward = "a";
  process.env.X_CT0__iooking4ward = "b";
  process.env.X_AUTH_TOKEN__mexiconecesario = "c";
  process.env.X_CT0__mexiconecesario = "d";
});

afterEach(() => {
  for (const k of Object.keys(process.env))
    if (k.startsWith("X_")) delete process.env[k];
  for (const [k, v] of Object.entries(saved))
    if (v !== undefined) process.env[k] = v;
});

describe("getXRouter", () => {
  it("returns a router for an EXACT configured handle", () => {
    expect(getXRouter("iooking4ward")).toBeInstanceOf(XPostRouter);
  });

  it("returns a router for a fuzzy near-miss (the l↔I typo class)", () => {
    // Was the prod failure: model passed 'lookin4ward' → must still route.
    expect(getXRouter("lookin4ward")).toBeInstanceOf(XPostRouter);
    expect(getXRouter("looking4ward")).toBeInstanceOf(XPostRouter);
  });

  it("returns null for a truly-unknown handle (so noAccountError lists the real accounts)", () => {
    expect(getXRouter("garbage")).toBeNull();
  });

  it("returns null when no accounts are configured", () => {
    for (const k of Object.keys(process.env))
      if (k.startsWith("X_")) delete process.env[k];
    expect(getXRouter("iooking4ward")).toBeNull();
    expect(getXRouter()).toBeNull();
  });
});
