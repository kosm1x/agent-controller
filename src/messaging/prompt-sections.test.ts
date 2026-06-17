/**
 * Tests for prompt-sections.ts — detectToolFlags and conditional sections.
 */

import { describe, it, expect } from "vitest";
import {
  detectToolFlags,
  identitySection,
  timeContextLine,
  fileSystemSection,
  capabilitiesSection,
  wordpressSection,
  codingSection,
  browserSection,
  researchSection,
  confirmationSection,
  toolFirstSection,
  availableSkillsSection,
  cohortSection,
} from "./prompt-sections.js";
import { listFirstPartySkills, listSkillsForTools } from "../skills/catalog.js";
import type { CohortMember } from "../cohort/self-defining.js";

// ---------------------------------------------------------------------------
// detectToolFlags
// ---------------------------------------------------------------------------

describe("detectToolFlags", () => {
  it("detects browser tools by prefix", () => {
    const flags = detectToolFlags(["browser__goto", "browser__markdown"]);
    expect(flags.hasBrowser).toBe(true);
    expect(flags.hasWordpress).toBe(false);
  });

  it("detects wordpress tools by prefix", () => {
    const flags = detectToolFlags(["wp_list_posts", "wp_publish"]);
    expect(flags.hasWordpress).toBe(true);
    expect(flags.hasBrowser).toBe(false);
  });

  it("detects coding tools by name match", () => {
    const flags = detectToolFlags(["file_read", "grep"]);
    expect(flags.hasCoding).toBe(true);
  });

  it("detects google tools by name match", () => {
    const flags = detectToolFlags(["gmail_send", "calendar_list"]);
    expect(flags.hasGoogle).toBe(true);
  });

  it("detects NorthStar via jarvis_file_read", () => {
    const flags = detectToolFlags(["jarvis_file_read"]);
    expect(flags.hasNorthStar).toBe(true);
  });

  it("detects research tools by name match", () => {
    const flags = detectToolFlags(["gemini_upload", "gemini_research"]);
    expect(flags.hasResearch).toBe(true);
  });

  it("returns all false for empty tool list", () => {
    const flags = detectToolFlags([]);
    expect(flags.hasBrowser).toBe(false);
    expect(flags.hasWordpress).toBe(false);
    expect(flags.hasCoding).toBe(false);
    expect(flags.hasGoogle).toBe(false);
    expect(flags.hasNorthStar).toBe(false);
    expect(flags.hasResearch).toBe(false);
  });

  it("returns all false for unrecognized tools", () => {
    const flags = detectToolFlags(["web_search", "user_fact_set"]);
    expect(flags.hasCoding).toBe(false);
    expect(flags.hasGoogle).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Conditional sections — verify they include/exclude content based on flags
// ---------------------------------------------------------------------------

describe("conditional prompt sections", () => {
  it("identitySection is static (no date/time) so the prompt cache can hit", () => {
    // Efficiency audit fix: date/time are injected into the user message
    // via timeContextLine(), not into the system prompt. Embedding mxTime
    // in the system prompt broke Anthropic prompt caching — every second
    // the prefix changed and every call missed the cache.
    const s1 = identitySection();
    const s2 = identitySection();
    expect(s1).toBe(s2); // byte-identical
    expect(s1).toContain("Jarvis");
    expect(s1).not.toMatch(/\d{4}-\d{2}-\d{2}/); // no dates (excluding cache-history comment, which is stripped from output)
    expect(s1).not.toMatch(/\d{2}:\d{2}/); // no times
  });

  it("identitySection community-manager section mentions audit-awareness (v7.7 Spine 1 Phase 2b)", () => {
    // Regression guard: if a future "this prose is verbose" cleanup removes
    // this paragraph, the LLM stops being aware of the write-gate and reply
    // quality degrades (more false-fails as the LLM stops self-policing).
    // Phase 2b R1-I2 from the audit log.
    const s = identitySection();
    expect(s).toMatch(/[Aa]uditoría automática del reply/);
    expect(s).toMatch(/cuando dudes, defiere al equipo/i);
  });

  it("timeContextLine emits the date + time in a compact single-line form", () => {
    const line = timeContextLine("2026-04-22", "14:30");
    expect(line).toContain("2026-04-22");
    expect(line).toContain("14:30");
    expect(line).toContain("CDMX");
    expect(line.split("\n").length).toBe(1); // exactly one line
  });

  it("fileSystemSection mentions NorthStar and jarvis files", () => {
    const s = fileSystemSection();
    expect(s).toContain("NorthStar");
    expect(s).toContain("jarvis_file_read");
  });

  it("capabilitiesSection includes Google when flag set", () => {
    const flags = detectToolFlags(["gmail_send", "calendar_list"]);
    const s = capabilitiesSection(flags);
    expect(s).toContain("Google Workspace");
    expect(s).toContain("gmail_read");
  });

  it("capabilitiesSection excludes Google when flag not set", () => {
    const flags = detectToolFlags(["web_search"]);
    const s = capabilitiesSection(flags);
    expect(s).not.toContain("Google Workspace");
  });

  it("capabilitiesSection includes coding when flag set", () => {
    const flags = detectToolFlags(["file_read", "shell_exec"]);
    const s = capabilitiesSection(flags);
    expect(s).toContain("Código");
  });

  it("confirmationSection includes gmail_send when google active", () => {
    const flags = detectToolFlags(["gmail_send"]);
    const s = confirmationSection(flags);
    expect(s).toContain("gmail_send");
  });

  it("confirmationSection frames confirmation as NOT a block (anti-confabulation)", () => {
    // Prevents the "gmail está bloqueado en modo don't ask" false refusal
    // (2026-06-16): the model must never read "confirmación obligatoria" as a
    // system-level permission gate.
    const flags = detectToolFlags(["gmail_send"]);
    const s = confirmationSection(flags);
    expect(s).toContain("NO es un bloqueo");
    expect(s.toLowerCase()).toContain("don't ask");
  });

  it("identitySection routes a genuine scope-miss to a recoverable ask, not a dead-end", () => {
    // 2026-06-17 root cause A: when a needed tool is genuinely OUT of scope, the
    // model confabulated a "don't ask block" and punted ("hazlo tú manualmente")
    // instead of naming the missing capability so its scope re-activates. The
    // persona must offer the escape-hatch, and the old dead-end must be gone.
    const s = identitySection();
    expect(s).toContain("reactiva su scope");
    expect(s).toContain("usa shell_exec");
    expect(s).not.toContain(
      "No tengo esa herramienta disponible en este momento",
    );
  });

  it("toolFirstSection includes WP rules when wordpress active", () => {
    const flags = detectToolFlags(["wp_publish"]);
    const s = toolFirstSection(flags);
    expect(s).toContain("wp_publish");
    expect(s).toContain("wp_list_posts");
  });

  it("toolFirstSection excludes WP rules when wordpress inactive", () => {
    const flags = detectToolFlags(["web_search"]);
    const s = toolFirstSection(flags);
    expect(s).not.toContain("wp_publish");
  });

  it("wordpressSection mentions all WP protocols", () => {
    const s = wordpressSection();
    expect(s).toContain("wp_read_post");
    expect(s).toContain("content_file");
    expect(s).toContain("wp_plugins");
  });

  it("codingSection mentions file_edit workflow", () => {
    const s = codingSection();
    expect(s).toContain("file_edit");
    expect(s).toContain("grep");
  });

  it("codingSection includes Karpathy coding principles", () => {
    const s = codingSection();
    expect(s).toContain("ANTES DE CODIFICAR");
    expect(s).toContain("trazarse directamente al request");
  });

  it("codingSection includes agent-skills methodology", () => {
    const s = codingSection();
    expect(s).toContain("causa raíz primero");
    expect(s).toContain("hard-cut");
    expect(s).toContain("invariante");
  });

  it("browserSection mentions browser__click", () => {
    const s = browserSection();
    expect(s).toContain("browser__click");
  });

  it("researchSection mentions gemini_upload workflow", () => {
    const s = researchSection();
    expect(s).toContain("gemini_upload");
    expect(s).toContain("gemini_research");
    expect(s).toContain("48h");
  });
});

// ---------------------------------------------------------------------------
// availableSkillsSection (v7.6 Spine 5)
// ---------------------------------------------------------------------------

describe("availableSkillsSection", () => {
  it("returns empty string when registry is empty (cache-stable omission)", () => {
    expect(availableSkillsSection([])).toBe("");
  });

  it("renders header + bullet list when registry is populated", () => {
    const s = availableSkillsSection([
      { surface: "test-a", label: "Test A", source: "html-compose" },
      { surface: "test-b", label: "Test B", source: "svg-diagram" },
    ]);
    expect(s).toContain("## Skills disponibles");
    expect(s).toContain("test-a");
    expect(s).toContain("test-b");
    expect(s).toContain("Test A");
    expect(s).toContain("Test B");
    expect(s).toContain("(html-compose)");
    expect(s).toContain("(svg-diagram)");
  });

  it("renders the production catalog with all 6 first-party surfaces visible", () => {
    const s = availableSkillsSection(listFirstPartySkills());
    expect(s).toContain("## Skills disponibles");
    expect(s).toContain("html-compose-skill-gate");
    expect(s).toContain("html-compose-house-style");
    expect(s).toContain("html-compose-visual-styles");
    expect(s).toContain("svg-diagram-palette-dark");
    expect(s).toContain("svg-diagram-palette-light");
    expect(s).toContain("svg-diagram-layout-rules");
  });

  it("does NOT inline full skill content (only surface + label)", () => {
    // Content stays in tool descriptions; the section is an index, not a
    // duplicate. Spot-check a few content fragments that should NOT appear.
    const s = availableSkillsSection(listFirstPartySkills());
    expect(s).not.toContain("HARD CONSTRAINTS");
    expect(s).not.toContain("FRAME RATE");
    expect(s).not.toContain("EDITORIAL");
    expect(s).not.toContain("Layout rules");
  });

  it("omits the section entirely when no parent tool is in scope (round-1 H1 fix)", () => {
    // Identity-section rule violation guard: section must NOT advertise a
    // skill whose parent tool isn't loaded.
    const s = availableSkillsSection(
      listSkillsForTools(["web_search", "memory_store"]),
    );
    expect(s).toBe("");
  });

  it("renders only html-compose surfaces when only video_html_compose is in scope", () => {
    const s = availableSkillsSection(
      listSkillsForTools(["video_html_compose"]),
    );
    expect(s).toContain("html-compose-skill-gate");
    expect(s).not.toContain("svg-diagram-palette-dark");
    expect(s).not.toContain("svg-diagram-layout-rules");
  });

  it("renders only svg-diagram surfaces when only diagram_generate is in scope", () => {
    const s = availableSkillsSection(listSkillsForTools(["diagram_generate"]));
    expect(s).toContain("svg-diagram-palette-dark");
    expect(s).not.toContain("html-compose-skill-gate");
    expect(s).not.toContain("html-compose-house-style");
  });
});

// ---------------------------------------------------------------------------
// cohortSection (V8.1 Phase A — Conway Pattern 2 grounding)
// ---------------------------------------------------------------------------

describe("cohortSection", () => {
  const member = (
    kind: CohortMember["member_kind"],
    label: string,
    salience: number,
  ): CohortMember => ({
    id: salience,
    member_id: `${kind}:${label}`,
    member_kind: kind,
    label,
    source_ref: `ref/${label}`,
    salience,
    signals: {},
    first_seen_at: "2026-05-01T00:00:00.000Z",
    last_rolled_at: "2026-05-20T00:00:00.000Z",
    active: true,
  });

  it("returns empty string for an empty cohort (cache-stable omission)", () => {
    expect(cohortSection([], true)).toBe("");
  });

  it("renders the header + grounding instruction when populated", () => {
    const s = cohortSection([member("project", "EurekaMD", 9)], true);
    expect(s).toContain("## Cohorte activa del operador");
    // The grounding directive is the whole point — must be present.
    expect(s).toContain("No inventes proyectos");
  });

  it("maps each member_kind to its Spanish label", () => {
    const s = cohortSection(
      [
        member("project", "EurekaMD", 9),
        member("objective", "Cerrar piloto CRM", 7),
        member("thread", "Rotación de claves AV", 3),
      ],
      true,
    );
    expect(s).toContain("- [proyecto] EurekaMD");
    expect(s).toContain("- [objetivo] Cerrar piloto CRM");
    expect(s).toContain("- [hilo] Rotación de claves AV");
  });

  it("preserves the input order (salience-DESC as getCohort returns it)", () => {
    const s = cohortSection(
      [
        member("project", "Alta", 9),
        member("objective", "Media", 5),
        member("thread", "Baja", 1),
      ],
      true,
    );
    expect(s.indexOf("Alta")).toBeLessThan(s.indexOf("Media"));
    expect(s.indexOf("Media")).toBeLessThan(s.indexOf("Baja"));
  });

  // SECURITY GATE — operator-private data must never reach a public channel.
  it("returns empty string when ownerChannel is false, even with members", () => {
    const members = [
      member("project", "Solera Properties", 9),
      member("objective", "biomarcadores cardiovasculares", 8),
    ];
    const s = cohortSection(members, false);
    expect(s).toBe("");
    // The private labels must appear nowhere in the output.
    expect(s).not.toContain("Solera");
    expect(s).not.toContain("biomarcadores");
  });

  it("renders the cohort when ownerChannel is true", () => {
    const s = cohortSection([member("project", "EurekaMD", 9)], true);
    expect(s).toContain("EurekaMD");
  });
});
