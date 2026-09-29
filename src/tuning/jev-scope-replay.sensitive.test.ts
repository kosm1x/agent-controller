import { describe, expect, it } from "vitest";
import { sensitiveReasons } from "./jev-scope-replay.js";

// Fake credentials only. The repo is public: anything shaped like a real
// secret-scanner hit is assembled at runtime so no literal in this file matches.
const R = "k7Qz2LmP9xRt4VwN8dHs3bFj6GcY1aEu5TiO0pKyMnB7hXsWq2ZrD9vLf4JtC6gU";
const LETTERS = "QwhRtzPkLmNxVbJyGdSaFeCuHiKoTnWqErYx"; // 36, mixed case, no digit
const GKEY = "AI" + "za" + R.slice(0, 35);
const TG = "8123456789" + ":" + R.slice(0, 35);

const CAUGHT: [label: string, text: string, rules: string[]][] = [
  ["AWS access key id", "AK" + "IA" + "IOSFODNN7EXAMPLE", ["known_prefix"]],
  [
    "AWS secret, labelled",
    "AWS_SECRET_ACCESS_KEY=" + "wJalrXUtnFEMI/K7MDENG/" + "bPxRfiCYEXAMPLEKEY",
    ["keyword"],
  ],
  ["Fireworks key", "fw" + "_" + R.slice(0, 33), ["long_run"]],
  ["Anthropic key", "sk-" + "ant-api03-" + R + "AbCd", ["known_prefix"]],
  ["Google API key", GKEY, ["known_prefix", "long_run"]],
  ["Telegram bot token", TG, ["known_prefix", "long_run"]],
  [
    "JWT",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
      ".eyJzdWIiOiIxMjM0NTY3ODkwIn0" +
      ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    ["long_run"],
  ],
  ["hex sha1", "a3f9c2e17b4d8f0a6c5e2b9d1f7a4c8e3b6d0f2a", ["long_run"]],
  ["UUID", "550e8400-e29b-41d4-a716-446655440000", ["long_run"]],
  [
    "base64 without /",
    "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5",
    ["long_run"],
  ],
  [
    "api_key in a query",
    "https://api.example.com/v1?api_key=" + GKEY,
    ["keyword", "long_run"],
  ],
  // Security direction: each must stay caught (qa-auditor W4).
  [
    "Gemini URL with ?key=",
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" +
      GKEY,
    ["known_prefix", "long_run"],
  ],
  [
    "Telegram bot URL",
    "https://api.telegram.org/bot" + TG + "/getUpdates",
    ["known_prefix"],
  ],
  [
    "Telegram bot URL in a Spanish sentence",
    "Prueba con https://api.telegram.org/bot" +
      TG +
      "/getUpdates y me dices si responde.",
    ["known_prefix"],
  ],
  [
    "Slack webhook",
    "https://hooks." +
      "slack.com/services/" +
      "T04K8PQ2LM/" +
      "B07XR9ZT3N/" +
      R.slice(0, 24),
    ["known_prefix"],
  ],
  [
    "two alphabetic segments + random",
    "abcd-EFGH-" + R.slice(0, 30),
    ["long_run"],
  ],
  ["mixed-case letters-only key", LETTERS, ["long_run"]],
  // Two segments never make a slug (pins the 3-segment threshold).
  [
    "letters segment + digits segment",
    LETTERS.slice(0, 26) + "_" + "8472901635",
    ["long_run"],
  ],
  [
    "hf_ token in prose",
    "usa " + "h" + "f_" + LETTERS.slice(0, 34) + " en el script",
    ["known_prefix"],
  ],
  [
    "44-char base64url, three segments",
    "aB3d-Ef5G-" + R.slice(30, 64),
    ["long_run"],
  ],
  [
    "Azure SAS ?sig=",
    "https://acct.blob." +
      "core.windows.net/c/b.txt?sv=2022-11-02&si" +
      "g=" +
      R.slice(0, 43),
    ["known_prefix", "long_run"],
  ],
];

// Paths, doc links and slugs from Jarvis's own answers.
const MUST_BE_CLEAN = [
  "/root/claude/jarvis-kb/workspace/farmacias-2026-09-28-1.txt",
  "projects/digital-products/entrepreneurship101.md",
  "https://docs.google.com/document/d/1VmEcWD6xBZgq6DxoRE_bJd-vM5sdQPqiEa4enWdiKRU/edit",
  "benchmarks/sonnet-tier-2026-09-29-03-43/results/03a7c9e8-A.md",
  "docs/planning/sonnet-tier-benchmark-2026-09-29.md",
  "manual-de-los-7-pasos-para-vender-cualquier-cosa-borrador-general",
  "LEARNINGS-2026-09-03-WA-DEVICE-REMOVED-2ND.md",
  "Listo: la ficha de Benito Juárez ya muestra la población 2025 en " +
    "uncharted.eurekamd.cloud/municipio/09014 y quedó en el commit 55a1897.",
];

describe("sensitiveReasons long_run", () => {
  it.each(CAUGHT)("catches %s", (_label, text, rules) => {
    const got = sensitiveReasons(text);
    expect(got.length).toBeGreaterThan(0);
    for (const rule of rules) expect(got).toContain(rule);
  });

  it.each(MUST_BE_CLEAN)("does not flag %s", (s) => {
    expect(sensitiveReasons(s)).not.toContain("long_run");
  });
});
