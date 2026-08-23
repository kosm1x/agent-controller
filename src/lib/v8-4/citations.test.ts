/**
 * Citation existence check: extraction (references section + DOI/arXiv
 * anywhere; title entries only when academic-looking), resolution verdicts
 * by kind with a fake fetch, positive-missing drops + one note line,
 * unreachable kept, shadow mode untouched, cache, overall budget.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// R3 C-6 pin: the RESOLVED (DNS) validator must be the one in use. A DNS
// name that the sync validator would pass is blocked here; if citations.ts
// ever falls back to the sync `validateOutboundUrl`, the probe is fetched.
vi.mock("../url-safety.js", async (orig) => {
  const real = await orig<typeof import("../url-safety.js")>();
  return {
    ...real,
    validateOutboundUrlResolved: async (url: string) =>
      /dns-rebind\.example/.test(url)
        ? "Blocked: resolves to private address"
        : real.validateOutboundUrl(url),
  };
});
import {
  _resetCitationCache,
  applyDrops,
  checkCitations,
  citationMode,
  extractCitations,
  resolveCitation,
  titlesMatch,
  type FetchLike,
} from "./citations.js";

afterEach(() => _resetCitationCache());

const REPORT = [
  "## Hallazgos",
  "La evidencia [1] muestra X; ver también [2] y [3]. El dato de INEGI [4] lo confirma.",
  "",
  "## Referencias",
  "[1] Smith, J., & Lee, K. (2021). Deep learning for protein folding. Nature, 596, 583–589. https://doi.org/10.1038/s41586-021-03819-2",
  "[2] Doe, A. et al. (2019). Swarm intelligence in startup evaluation. Journal of Venture Studies, vol. 12, pp. 1–20.",
  "[3] Pérez, M. (2020). Completely invented paper about nothing. Proceedings of Fake Conf.",
  "[4] INEGI (2019). Censo Económico 2019, tabulados básicos por municipio.",
  "[5] arXiv:2301.00001",
  "[6] https://example.com/missing-page",
  "",
  "## Cierre",
  "Fin.",
].join("\n");

function fakeFetch(
  table: Record<string, { status: number; body?: string }>,
): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const hit = Object.entries(table).find(([k]) => url.includes(k));
    const res = hit?.[1] ?? { status: 500 };
    return { status: res.status, text: async () => res.body ?? "" };
  }) as FetchLike & { calls: string[] };
  f.calls = calls;
  return f;
}

describe("extractCitations", () => {
  it("finds DOI/arXiv anywhere, URLs and academic titles only inside a references section", () => {
    const cites = extractCitations(REPORT);
    expect(cites.map((c) => [c.kind, c.label])).toEqual([
      ["doi", "[1]"],
      ["arxiv", "[5]"],
      ["title", "[2]"],
      ["title", "[3]"],
      ["url", "[6]"],
    ]);
    expect(cites.find((c) => c.kind === "doi")?.key).toBe(
      "10.1038/s41586-021-03819-2",
    );
    expect(cites.find((c) => c.label === "[2]")?.key).toBe(
      "Swarm intelligence in startup evaluation",
    );
    // The INEGI tabulado is not academic → never sent to Crossref.
    expect(cites.some((c) => c.key.includes("Censo"))).toBe(false);
  });

  it("returns nothing for a reply with casual links and no references section", () => {
    expect(
      extractCitations("Mira https://example.com/blog y dime qué opinas."),
    ).toEqual([]);
  });
});

describe("resolveCitation", () => {
  it("DOI: Crossref 200 resolves; Crossref 404 defers to doi.org (302 → resolved, 404 → missing)", async () => {
    const ok = fakeFetch({ "api.crossref.org/works/10.1": { status: 200 } });
    expect(await resolveCitation({ kind: "doi", key: "10.1000/abc" }, ok)).toBe(
      "resolved",
    );
    const datacite = fakeFetch({
      "api.crossref.org": { status: 404 },
      "doi.org/10.5281": { status: 302 },
    });
    expect(
      await resolveCitation({ kind: "doi", key: "10.5281/zenodo.1" }, datacite),
    ).toBe("resolved");
    const fake = fakeFetch({
      "api.crossref.org": { status: 404 },
      "doi.org/": { status: 404 },
    });
    expect(
      await resolveCitation({ kind: "doi", key: "10.9999/nope" }, fake),
    ).toBe("missing");
  });

  it("arXiv: entry present → resolved, empty feed → missing; URL: 404 missing, 403 unreachable; title via Crossref match", async () => {
    const arx = fakeFetch({
      "id_list=2301.00001": {
        status: 200,
        body: "<feed><entry><id>http://arxiv.org/abs/2301.00001v1</id></entry></feed>",
      },
      "id_list=9999.99999": { status: 200, body: "<feed></feed>" },
    });
    expect(
      await resolveCitation({ kind: "arxiv", key: "2301.00001" }, arx),
    ).toBe("resolved");
    expect(
      await resolveCitation({ kind: "arxiv", key: "9999.99999" }, arx),
    ).toBe("missing");

    const urls = fakeFetch({
      "example.com/gone": { status: 404 },
      "example.com/wall": { status: 403 },
    });
    expect(
      await resolveCitation(
        { kind: "url", key: "https://example.com/gone" },
        urls,
      ),
    ).toBe("missing");
    expect(
      await resolveCitation(
        { kind: "url", key: "https://example.com/wall" },
        urls,
      ),
    ).toBe("unreachable");

    const cr = fakeFetch({
      "query.bibliographic=Swarm": {
        status: 200,
        body: JSON.stringify({
          message: {
            items: [
              { title: ["Swarm Intelligence in Startup Evaluation: A Study"] },
            ],
          },
        }),
      },
      "query.bibliographic=Completely": {
        status: 200,
        body: JSON.stringify({
          message: { items: [{ title: ["Unrelated"] }] },
        }),
      },
    });
    expect(
      await resolveCitation(
        { kind: "title", key: "Swarm intelligence in startup evaluation" },
        cr,
      ),
    ).toBe("resolved");
    // A confident title (APA/Vancouver/quoted) with non-matching Crossref
    // candidates is positively missing; a fallback-extracted title never is.
    expect(
      await resolveCitation(
        { kind: "title", key: "Completely invented paper about nothing", confident: true },
        cr,
      ),
    ).toBe("missing");
    expect(
      await resolveCitation(
        { kind: "title", key: "Completely invented paper about nothing", confident: false },
        cr,
      ),
    ).toBe("unreachable");
  });

  it("caches verdicts per key and treats a thrown fetch as unreachable", async () => {
    const f = fakeFetch({
      "doi.org/": { status: 302 },
      "api.crossref.org": { status: 404 },
    });
    await resolveCitation({ kind: "doi", key: "10.1/x" }, f);
    await resolveCitation({ kind: "doi", key: "10.1/x" }, f);
    expect(f.calls).toHaveLength(2); // crossref + doi.org once; second call cached
    const boom: FetchLike = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(
      await resolveCitation({ kind: "url", key: "https://nx.invalid/" }, boom),
    ).toBe("unreachable");
  });
});

describe("titlesMatch", () => {
  it("is accent/case/punctuation-insensitive with containment or ≥0.6 token Jaccard", () => {
    expect(
      titlesMatch(
        "Deep learning for protein folding",
        "Deep Learning for Protein Folding.",
      ),
    ).toBe(true);
    expect(
      titlesMatch(
        "Evaluación de startups con enjambres",
        "evaluacion de startups con enjambres: un estudio",
      ),
    ).toBe(true);
    expect(
      titlesMatch(
        "Swarm intelligence in startup evaluation",
        "Unrelated work on bees",
      ),
    ).toBe(false);
  });
});

describe("checkCitations / applyDrops", () => {
  it("drops positively-missing entries and their [n] markers, keeps unreachable, appends one note", async () => {
    const f = fakeFetch({
      "api.crossref.org/works/10.1038": { status: 200 },
      "query.bibliographic=Swarm": {
        status: 200,
        body: JSON.stringify({
          message: {
            items: [{ title: ["Swarm intelligence in startup evaluation"] }],
          },
        }),
      },
      "query.bibliographic=Completely": {
        status: 200,
        body: JSON.stringify({
          message: { items: [{ title: ["Something else entirely"] }] },
        }),
      },
      "id_list=2301.00001": {
        status: 200,
        body: "<entry><id>http://arxiv.org/abs/2301.00001</id></entry>",
      },
      "example.com/missing-page": { status: 404 },
    });
    const r = await checkCitations(REPORT, { fetchImpl: f });
    expect(r).toMatchObject({
      total: 5,
      resolved: 3,
      missing: 2,
      unreachable: 0,
    });
    expect(r!.dropped).toEqual([
      "Completely invented paper about nothing",
      "https://example.com/missing-page",
    ]);
    expect(r!.text).not.toContain("[3] Pérez");
    expect(r!.text).not.toContain("[6] https://example.com/missing-page");
    expect(r!.text).toContain("ver también [2] y.");
    expect(r!.text).toContain("[1] Smith");
    expect(r!.text).toMatch(
      /⚠️ Quité 2 referencias que no existen .*«Completely invented paper about nothing», «https:\/\/example.com\/missing-page»\.$/,
    );
  });

  it("shadow mode reports without editing; no citations → null; overall budget → unreachable, kept", async () => {
    const f = fakeFetch({ "example.com/missing-page": { status: 404 } });
    const shadow = await checkCitations(
      "## Referencias\n- https://example.com/missing-page",
      {
        fetchImpl: f,
        mode: "shadow",
      },
    );
    expect(shadow).toMatchObject({ missing: 1 });
    expect(shadow!.text).toBe(
      "## Referencias\n- https://example.com/missing-page",
    );
    expect(
      await checkCitations("Sin referencias aquí.", { fetchImpl: f }),
    ).toBeNull();

    const slow: FetchLike = () => new Promise(() => {});
    const r = await checkCitations(
      "## Referencias\n- https://example.com/slow",
      {
        fetchImpl: slow,
        overallMs: 20,
      },
    );
    expect(r).toMatchObject({ total: 1, unreachable: 1, missing: 0 });
    expect(r!.text).toContain("example.com/slow");
  });

  it("R1 C6: never probes loopback / private / metadata hosts — the fetch is not even attempted", async () => {
    const f = fakeFetch({});
    const text = [
      "## Fuentes",
      "- http://127.0.0.1:8098/v1/sandboxes",
      "- http://169.254.169.254/latest/meta-data/iam/",
      "- http://localhost:8100/rest/v1/users?select=*",
      "- http://10.0.0.5/exec",
    ].join("\n");
    const r = await checkCitations(text, { fetchImpl: f });
    expect(f.calls).toEqual([]);
    expect(r).toMatchObject({ total: 4, unreachable: 4, missing: 0 });
    expect(r!.text).toBe(text);
  });

  it("R1 C7: APA entries query the TITLE, not the venue; an empty Crossref answer keeps the entry", async () => {
    const cites = extractCitations(
      "## References\n[1] Vaswani, A., Shazeer, N. (2017). Attention Is All You Need. Advances in Neural Information Processing Systems, vol. 30, pp. 5998-6008.",
    );
    expect(cites).toHaveLength(1);
    expect(cites[0]!.key).toBe("Attention Is All You Need");
    const f = fakeFetch({
      "query.bibliographic": { status: 200, body: JSON.stringify({ message: { items: [] } }) },
    });
    expect(await resolveCitation(cites[0]!, f)).toBe("unreachable");
  });

  it("R1 C7/W6: [n] markers inside code survive a drop; an inline 'Fuentes escaneadas:' line is not a section", async () => {
    const text = [
      "Ver [2] y arr[2] fuera de código.",
      "```js",
      "const x = arr[2] + arr[1];",
      "```",
      "",
      "## Referencias",
      "[1] https://example.com/ok",
      "[2] https://example.com/gone",
    ].join("\n");
    const f = fakeFetch({ "example.com/gone": { status: 404 }, "example.com/ok": { status: 200 } });
    const r = await checkCitations(text, { fetchImpl: f });
    expect(r!.text).toContain("const x = arr[2] + arr[1];");
    expect(r!.text.startsWith("Ver y arr fuera de código.")).toBe(true);
    expect(r!.text).not.toContain("[2] https://example.com/gone");

    expect(
      extractCitations("**Fuentes escaneadas:** 18 | **Señales:** 14\n- El mercado creció 40% según https://internal.example/report"),
    ).toEqual([]);
  });

  it("R2 C-2: Vancouver entries query the TITLE; '## Fuentes consultadas' is a references heading", () => {
    const cites = extractCitations(
      "## Fuentes consultadas\n1. He K, Zhang X, Ren S, Sun J. Deep residual learning for image recognition. Proceedings of the IEEE Conference. 2016:770-8.",
    );
    expect(cites).toHaveLength(1);
    expect(cites[0]).toMatchObject({ key: "Deep residual learning for image recognition", confident: true });
  });

  it("R3 C-1: a Spanish periodical entry is never droppable — Crossref does not index it", async () => {
    const cites = extractCitations(
      "## Fuentes\n[1] García, L. (2024). Panorama del retail mexicano. Revista Expansión, pp. 12-18.\n[2] Doe, A. et al. (2019). Swarm intelligence in startup evaluation. Journal of Venture Studies, vol. 12, pp. 1–20.",
    );
    expect(cites.map((c) => [c.key, c.confident])).toEqual([
      ["Panorama del retail mexicano", false],
      ["Swarm intelligence in startup evaluation", true],
    ]);
    const f = fakeFetch({
      "query.bibliographic": { status: 200, body: JSON.stringify({ message: { items: [{ title: ["Unrelated"] }] } }) },
    });
    expect(await resolveCitation(cites[0]!, f)).toBe("unreachable");
    expect(await resolveCitation(cites[1]!, f)).toBe("missing");
  });

  it("R3 C-6 pins: every request carries redirect:'manual'; a DNS name resolving to a private address is never fetched", async () => {
    const inits: Array<Record<string, unknown> | undefined> = [];
    const f: FetchLike = async (_url, init) => {
      inits.push(init as Record<string, unknown>);
      return { status: 200, text: async () => "" };
    };
    await resolveCitation({ kind: "url", key: "https://example.com/ok-page" }, f);
    expect(inits).toHaveLength(1);
    expect(inits[0]?.redirect).toBe("manual");
    const calls: string[] = [];
    const g: FetchLike = async (url) => {
      calls.push(url);
      return { status: 200, text: async () => "" };
    };
    expect(
      await resolveCitation({ kind: "url", key: "http://dns-rebind.example:19555/leak" }, g),
    ).toBe("unreachable");
    expect(calls).toEqual([]);
  });

  it("R4 W4-4: 'et al.' / vol./pp. in a Spanish periodical is not a Crossref venue — never droppable", () => {
    const cites = extractCitations(
      "## Fuentes\n[1] García, M., et al. (2022). Tendencias del consumo. Revista Expansión, 30, pp. 5-9.\n[2] López, R. (2023). Mercado inmobiliario. Revista Obras, vol. 12, no. 4, pp. 3-11.",
    );
    expect(cites.map((c) => c.confident)).toEqual([false, false]);
  });

  it("R2 C-3: redirects are followed manually and re-validated — a public 302 to loopback is never fetched", async () => {
    const calls: string[] = [];
    const f: FetchLike = async (url) => {
      calls.push(url);
      if (url.startsWith("https://example.com/hop")) {
        return {
          status: 302,
          text: async () => "",
          headers: { get: (n: string) => (n === "location" ? "http://127.0.0.1:19555/leak" : null) },
        };
      }
      return { status: 200, text: async () => "" };
    };
    expect(await resolveCitation({ kind: "url", key: "https://example.com/hop" }, f)).toBe("unreachable");
    expect(calls).toEqual(["https://example.com/hop"]);
    // doi.org 302 = registered DOI; the publisher is never visited.
    const doi: FetchLike = async (url) => {
      calls.push(url);
      if (url.includes("api.crossref.org")) return { status: 404, text: async () => "" };
      return { status: 302, text: async () => "", headers: { get: () => "https://publisher.example/paper" } };
    };
    calls.length = 0;
    expect(await resolveCitation({ kind: "doi", key: "10.5555/reg" }, doi)).toBe("resolved");
    expect(calls.some((u) => u.includes("publisher.example"))).toBe(false);
  });

  it("applyDrops is a no-op without drops and never touches markdown links like [1](url)", () => {
    expect(applyDrops("x", [])).toBe("x");
    const out = applyDrops("ver [1](https://a) y [1]\n[1] gone", [
      { kind: "url", key: "https://gone", line: "[1] gone", lineIndex: 1, label: "[1]" },
    ]);
    expect(out.startsWith("ver [1](https://a) y")).toBe(true);
  });

  it("reads the mode flag (enforce by default)", () => {
    expect(citationMode({})).toBe("enforce");
    expect(citationMode({ CITATION_CHECK: "shadow" })).toBe("shadow");
    expect(citationMode({ CITATION_CHECK: "off" })).toBe("off");
  });
});
