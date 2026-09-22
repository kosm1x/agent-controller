import { describe, expect, it } from "vitest";
import { mustNotLeave, withholdReasons } from "./client.js";
import { sensitiveReasons } from "../tuning/jev-scope-replay.js";
import {
  parseExchange,
  tallyWithholds,
  type Exchange,
} from "./withheld-replay.js";

describe("withholdReasons", () => {
  it("names each rule that fires and agrees with mustNotLeave", () => {
    const cases: [string, string[]][] = [
      ["escríbele a ana@ejemplo.mx por favor", ["email"]],
      ["Password: hunter2!x", ["keyword", "pass_contra", "label_value"]],
      ["Xy7kQ9zz", ["bare_token"]],
      ["la contraseña es lo de siempre", ["keyword"]],
      ["quiero un resumen del día en 3 puntos", []],
    ];
    for (const [text, expected] of cases) {
      expect(withholdReasons(text), text).toEqual(expected);
      expect(mustNotLeave(text), text).toBe(expected.length > 0);
    }
  });

  it("sensitiveReasons covers every rule name the replay can print", () => {
    expect(sensitiveReasons("AKIA" + "ABCDEFGHIJ" + "KLMNOP")).toContain(
      "known_prefix",
    );
    expect(sensitiveReasons("4111 1111 " + "1111 1111")).toContain(
      "card_digits",
    );
    expect(sensitiveReasons("usuario: pepe")).toContain("login_label");
    expect(sensitiveReasons("la clave es Verano2026")).toContain("clave");
    expect(sensitiveReasons("mi contra de siempre")).toContain("pass_contra");
    expect(sensitiveReasons("a".repeat(32))).toEqual(["long_run"]);
    expect(sensitiveReasons("palabras clave para SEO")).toEqual([]);
  });
});

describe("parseExchange", () => {
  it("splits the router's persisted turn and rejects anything else", () => {
    expect(
      parseExchange("User: hola\nsegunda línea\nJarvis: qué tal\nbien"),
    ).toEqual({
      user: "hola\nsegunda línea",
      jarvis: "qué tal\nbien",
    });
    expect(parseExchange("Reflection: nothing")).toBeNull();
  });
});

describe("tallyWithholds", () => {
  it("attributes a withhold to the message or to the previous reply, per channel", () => {
    const ex: Exchange[] = [
      {
        channel: "a",
        user: "resume el día",
        jarvis: "claro, escribe a ana@ejemplo.mx",
      },
      { channel: "b", user: "otro canal, limpio", jarvis: "ok" },
      { channel: "a", user: "gracias, sigue", jarvis: "listo" }, // withheld by a's previous reply
      { channel: "b", user: "Password: hunter2!x", jarvis: "no" }, // its own message
      { channel: "a", user: "y ahora?", jarvis: "listo" }, // a's previous turn is clean
      { channel: "b", user: "sigue", jarvis: "ok" }, // b's previous USER text is not a part (only after a poisoned exchange, not replayed)
      { channel: "c", user: "hola", jarvis: "manda a b@c.mx" },
      { channel: "c", user: "ya", jarvis: "ok" }, // withheld by c's previous reply
    ];
    const t = tallyWithholds(ex);
    expect(t).toMatchObject({
      turns: 8,
      withheld: 3,
      contextOnly: 2,
      byPart: { message: 1, prev_jarvis: 2 },
    });
    expect(t.byRule.email).toEqual({ message: 0, prev_jarvis: 2 });
    expect(t.byRule.keyword).toEqual({ message: 1, prev_jarvis: 0 });
    expect(t.byRule.label_value).toEqual({ message: 1, prev_jarvis: 0 });
  });
});
