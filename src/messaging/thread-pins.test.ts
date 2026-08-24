import { describe, it, expect, beforeEach } from "vitest";
import {
  pinFromExchange,
  pinConfirmedFigures,
  getPins,
  pinnedThreadSection,
  bindTaskConfirmedFigures,
  getTaskConfirmedFigures,
  confirmedMismatch,
  CONFIRM_RE,
  PIN_TTL_MS,
  PIN_CAP,
  _resetThreadPins,
  _threadPinKeyCount,
} from "./thread-pins.js";

describe("thread-pins (Phase 4.1 / 2.3)", () => {
  beforeEach(() => {
    _resetThreadPins();
  });

  describe("pinFromExchange — URL ledger", () => {
    it("pins URLs from both sides of an exchange, stripping trailing punctuation", () => {
      pinFromExchange(
        "tg",
        "User: mira https://ejemplo.com/doc.\nJarvis: Publicado en https://ant-colony.187.77.25.101.nip.io.",
      );
      const values = getPins("tg").map((p) => p.value);
      expect(values).toContain("https://ejemplo.com/doc");
      expect(values).toContain("https://ant-colony.187.77.25.101.nip.io");
    });

    it("re-pinning the same URL refreshes instead of duplicating", () => {
      pinFromExchange("tg", "Jarvis: https://a.com/x", 1000);
      pinFromExchange("tg", "Jarvis: https://a.com/x", 2000);
      const pins = getPins("tg", 2000);
      expect(pins.filter((p) => p.value === "https://a.com/x")).toHaveLength(1);
      expect(pins[0].ts).toBe(2000);
    });

    it("expires pins after PIN_TTL_MS and caps at PIN_CAP newest-first", () => {
      pinFromExchange("tg", "Jarvis: https://old.com/x", 0);
      expect(getPins("tg", PIN_TTL_MS + 1)).toHaveLength(0);

      for (let i = 0; i < PIN_CAP + 5; i++) {
        pinFromExchange("tg2", `Jarvis: https://site.com/p${i}`, 5000 + i);
      }
      const pins = getPins("tg2", 6000);
      expect(pins).toHaveLength(PIN_CAP);
      expect(pins[pins.length - 1].value).toBe(
        `https://site.com/p${PIN_CAP + 4}`,
      );
      expect(pins.some((p) => p.value === "https://site.com/p0")).toBe(false);
    });

    it("threads are isolated", () => {
      pinFromExchange("tg-a", "Jarvis: https://a.com");
      expect(getPins("tg-b")).toHaveLength(0);
    });

    it("URL flood cannot evict confirmed figures (per-kind caps, R1 W6)", () => {
      pinConfirmedFigures("tg", "Confirmo", "Margen: 34%", 1000);
      for (let i = 0; i < PIN_CAP + 10; i++) {
        pinFromExchange("tg", `Jarvis: https://site.com/u${i}`, 2000 + i);
      }
      const pins = getPins("tg", 3000);
      expect(pins.filter((p) => p.kind === "figure")).toHaveLength(1);
      expect(pins.filter((p) => p.kind === "url")).toHaveLength(PIN_CAP);
    });
  });

  describe("CONFIRM_RE", () => {
    const yes = [
      "Confirmo",
      "confirmado",
      "Correcto",
      "ok con esos números",
      "Ok con esas cifras",
      "Así es",
      "de acuerdo",
    ];
    const no = [
      "no confirmo",
      "¿confirmo?",
      "el modelo es correcto",
      "dame los números",
      "hola",
      "",
    ];
    for (const t of yes) {
      it(`matches "${t}"`, () => expect(CONFIRM_RE.test(t)).toBe(true));
    }
    for (const t of no) {
      it(`does NOT match "${t}"`, () => expect(CONFIRM_RE.test(t)).toBe(false));
    }
  });

  describe("pinConfirmedFigures", () => {
    const reply =
      "Modelo final:\n- Utilidad neta: $1.2M\n- Margen: 34%\nTodo listo.";

    it("pins the previous reply's figures with their line as label", () => {
      const n = pinConfirmedFigures("tg", "Confirmo", reply);
      expect(n).toBeGreaterThanOrEqual(2);
      const figs = getPins("tg").filter((p) => p.kind === "figure");
      const raws = figs.map((f) => f.value);
      expect(raws).toContain("$1.2M");
      expect(raws).toContain("34%");
      expect(figs.find((f) => f.value === "34%")?.label).toContain("Margen");
    });

    it("does nothing when the message is not a confirmation", () => {
      expect(pinConfirmedFigures("tg", "y el margen?", reply)).toBe(0);
      expect(getPins("tg")).toHaveLength(0);
    });

    it("does nothing without a previous assistant reply", () => {
      expect(pinConfirmedFigures("tg", "Confirmo", undefined)).toBe(0);
    });
  });

  describe("pinnedThreadSection", () => {
    it("empty string when nothing is pinned", () => {
      expect(pinnedThreadSection("tg")).toBe("");
    });

    it("renders URLs and confirmed figures under the FIJADO header", () => {
      pinFromExchange("tg", "Jarvis: https://demo.nip.io listo");
      pinConfirmedFigures("tg", "Confirmo", "Utilidad neta: $1.2M");
      const block = pinnedThreadSection("tg");
      expect(block).toContain("## FIJADO EN ESTE HILO");
      expect(block).toContain("https://demo.nip.io");
      expect(block).toContain("$1.2M");
      expect(block).toContain("CONFIRMADA");
    });
  });

  describe("task binding (2.3)", () => {
    it("binds only figure pins and expires with the TTL", () => {
      pinFromExchange("tg", "Jarvis: https://a.com", 1000);
      pinConfirmedFigures("tg", "Confirmo", "Margen: 34%", 1000);
      bindTaskConfirmedFigures("task-1", "tg", 1000);
      const figs = getTaskConfirmedFigures("task-1", 1000);
      expect(figs).toHaveLength(1);
      expect(figs[0].raw).toBe("34%");
      expect(getTaskConfirmedFigures("task-1", 1000 + PIN_TTL_MS + 1)).toEqual(
        [],
      );
    });

    it("no binding recorded when the thread has no confirmed figures", () => {
      bindTaskConfirmedFigures("task-2", "tg");
      expect(getTaskConfirmedFigures("task-2")).toEqual([]);
    });
  });

  describe("confirmedMismatch (2.3 predicate — conservative)", () => {
    const confirmed = [{ raw: "34%", label: "Margen bruto: 34%" }];

    it("fires when the label's line carries a DIFFERENT number (#11959 class)", () => {
      const hit = confirmedMismatch(
        "Resumen 2027\nMargen bruto | 28%\nVentas | 900",
        confirmed,
      );
      expect(hit).not.toBeNull();
      expect(hit!.figure.raw).toBe("34%");
      expect(hit!.line).toContain("28%");
    });

    it("silent when the confirmed value is present anywhere", () => {
      expect(
        confirmedMismatch("Margen bruto | 34%\nVentas | 900", confirmed),
      ).toBeNull();
    });

    it("silent when the label never appears (different artifact/topic)", () => {
      expect(
        confirmedMismatch("Inventario | 500\nPedidos | 120", confirmed),
      ).toBeNull();
    });

    it("silent when the label's line has no number at all", () => {
      expect(
        confirmedMismatch("Margen bruto pendiente de revisión", confirmed),
      ).toBeNull();
    });

    it("silent with no confirmed figures or empty text", () => {
      expect(confirmedMismatch("Margen | 28%", [])).toBeNull();
      expect(confirmedMismatch("", confirmed)).toBeNull();
    });
  });
});

describe("R2 audit W5 — global key sweep", () => {
  it("addPin sweeps OTHER threads' fully-expired keys (map size — R3 W1)", () => {
    _resetThreadPins();
    for (let i = 0; i < 50; i++) {
      pinFromExchange(`sender-${i}`, `Jarvis: https://a.com/x${i}`, 1000);
    }
    expect(_threadPinKeyCount()).toBe(50);
    // A single fresh pin far in the future sweeps every stale key. The
    // assertion is the MAP SIZE, not getPins — getPins prunes the key it
    // touches, which made the first version of this test unfalsifiable.
    pinFromExchange("fresh", "Jarvis: https://b.com/y", 1000 + PIN_TTL_MS + 1);
    expect(_threadPinKeyCount()).toBe(1);
    expect(getPins("fresh", 1000 + PIN_TTL_MS + 2)).toHaveLength(1);
  });
});
