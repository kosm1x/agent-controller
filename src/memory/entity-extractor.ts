/**
 * Auto Entity Detection (v6.5 M3) — keyword-based entity extraction from conversations.
 *
 * Extracts people, projects, status changes, and decisions from conversation text
 * using heuristic patterns. No LLM call — pure regex/keyword matching.
 * Results feed into the temporal knowledge graph (M1) as auto-detected triples.
 *
 * Adapted from mempalace's entity_detector.py + general_extractor.py patterns.
 */

import { listProjects } from "../db/projects.js";
import { nowMexIsoDate } from "../lib/timezone.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractedTriple {
  subject: string;
  predicate: string;
  object: string;
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/**
 * Names that are not (or not only) active registry rows but must always be
 * recognised — also the whole set when the registry read fails. Every other
 * project name comes from the live `projects` table via getProjectTerms(), so
 * the list cannot drift (the old hardcoded list still carried `crm-azteca`
 * months after the 2026-06-20 cutover to `pulso-aura-upfront`).
 */
const STATIC_PROJECT_SLUGS = [
  "agent-controller",
  "mission-control",
  "jarvis",
  "northstar",
  // Odd casing is deliberate: it is the subject string the existing
  // knowledge_triples rows use (96 rows), so supersede/joins keep working.
  "eurekamD",
];

/**
 * Registry aliases the extractor ignores. A 2,000-row replay showed these
 * attributing NFL surnames (Caleb/Javonte/Kyren Williams), "systemd journal"
 * and "en el radar" to williams-entry-radar. They stay in projects.config for
 * dispatcher routing — only extraction skips them.
 */
const EXTRACTOR_ALIAS_STOPLIST = new Set(["williams", "radar", "journal"]);

/** A matchable term (slug, name or alias) and the slug a hit is attributed to. */
interface ProjectTerm {
  slug: string;
  pattern: RegExp;
}

/**
 * Word-boundary match, hyphen = optional hyphen/space ("cuatro flor" hits
 * `cuatro-flor`). `\b` is only added on an edge that is a word char, so names
 * ending in ")" or "." can still match.
 */
function termPattern(term: string): RegExp {
  const body = term
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/-/g, "[- ]?");
  const lead = /^\w/.test(term) ? "\\b" : "";
  const trail = /\w$/.test(term) ? "\\b" : "";
  return new RegExp(`${lead}${body}${trail}`, "i");
}

const STATIC_TERMS: ProjectTerm[] = STATIC_PROJECT_SLUGS.map((slug) => ({
  slug,
  pattern: termPattern(slug),
}));

// 30 s TTL, same trade-off as dispatcher's getForeignProjectNames(): a small
// table that changes rarely, read synchronously on every extraction.
const PROJECT_TERMS_TTL_MS = 30_000;
let projectTermsCache: { at: number; terms: ProjectTerm[] } | null = null;
let registryFailureLogged = false;

/**
 * Static core + active registry rows (slug, name, config.aliases; lowercase,
 * < 4 chars dropped). A name/alias hit is attributed to the row's slug.
 * Never throws — on a registry read failure returns the static core.
 */
function getProjectTerms(): ProjectTerm[] {
  if (
    projectTermsCache &&
    Date.now() - projectTermsCache.at < PROJECT_TERMS_TTL_MS
  ) {
    return projectTermsCache.terms;
  }
  try {
    const seen = new Set(STATIC_PROJECT_SLUGS.map((s) => s.toLowerCase()));
    const terms = [...STATIC_TERMS];
    for (const p of listProjects("active")) {
      const aliases = Array.isArray(p.config?.aliases) ? p.config.aliases : [];
      for (const raw of [p.slug, p.name, ...aliases]) {
        if (typeof raw !== "string") continue;
        const term = raw.trim().toLowerCase();
        if (term.length < 4 || EXTRACTOR_ALIAS_STOPLIST.has(term)) continue;
        if (seen.has(term)) continue;
        seen.add(term);
        terms.push({ slug: p.slug, pattern: termPattern(term) });
      }
    }
    projectTermsCache = { at: Date.now(), terms };
    return terms;
  } catch (err) {
    if (!registryFailureLogged) {
      registryFailureLogged = true;
      console.warn(
        "[entity-extractor] projects registry unavailable, using static slugs:",
        err instanceof Error ? err.message : String(err),
      );
    }
    return STATIC_TERMS;
  }
}

/** Test-only: drop the registry cache and the log-once flag. */
export function _resetProjectTermsCacheForTests(): void {
  projectTermsCache = null;
  registryFailureLogged = false;
}

/** Status-change verbs (Spanish + English). */
const STATUS_PATTERNS: Array<{ pattern: RegExp; predicate: string }> = [
  {
    pattern:
      /(?:complet[oóeé]|terminé|terminó|finished|completed|done with)\s+(.{5,60})/i,
    predicate: "completed",
  },
  {
    pattern:
      /(?:empec[eé]|empezó|started|comenzó|inicié|launched)\s+(.{5,60})/i,
    predicate: "started",
  },
  {
    pattern: /(?:falló|failed|broke|rompió|crashed|error en)\s+(.{5,60})/i,
    predicate: "failed",
  },
  {
    pattern:
      /(?:deploy[eé]|deployed|desplegué|subí a producción|pushed to)\s+(.{5,60})/i,
    predicate: "deployed",
  },
  {
    pattern:
      /(?:bloqueado|blocked by|stuck on|waiting for|esperando)\s+(.{5,60})/i,
    predicate: "blocked_by",
  },
  {
    pattern:
      /(?:cancelé|cancelled|canceled|abandoned|abandoné|dropped)\s+(.{5,60})/i,
    predicate: "cancelled",
  },
];

/** Decision verbs. */
const DECISION_PATTERNS: Array<{ pattern: RegExp; predicate: string }> = [
  {
    pattern:
      /(?:decid[ií]|decided|chose|eleg[ií]|elegimos|switched to|moved to|migrated to|cambié a)\s+(.{5,80})/i,
    predicate: "decided",
  },
  {
    pattern:
      /(?:vamos con|let's go with|we'll use|usaremos|adoptamos|adopted)\s+(.{5,60})/i,
    predicate: "adopted",
  },
];

/** Project mention: "proyecto X" / "project X" — captures 1-4 capitalized words. Case-sensitive on names. */
const PROJECT_MENTION =
  /(?:[Pp]royecto|[Pp]roject)\s+['"]?([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+){0,3})['"]?(?=\s|[.,;:!?]|$)/g;

/** Person mention: "@name" or "con/de/para Name". */
const PERSON_MENTION =
  /(?:@(\w{2,20})|(?:con|de|para|from|with)\s+([A-ZÀ-Ú][a-zà-ú]{2,15}(?:\s+[A-ZÀ-Ú][a-zà-ú]{2,15})?))/g;

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Extract entity triples from conversation text. No LLM call — pure heuristics.
 * Returns 0-N triples suitable for addTriple().
 */
export function extractEntities(text: string): ExtractedTriple[] {
  if (!text || text.length < 20) return [];

  const triples: ExtractedTriple[] = [];
  const seen = new Set<string>();

  const addUnique = (t: ExtractedTriple) => {
    const key = `${t.subject.toLowerCase()}|${t.predicate}|${t.object.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    triples.push(t);
  };

  // 1. Detect known project slugs mentioned in text
  const matchedSlugs = new Set<string>();
  for (const { slug, pattern: slugPattern } of getProjectTerms()) {
    if (matchedSlugs.has(slug)) continue;
    if (slugPattern.test(text)) {
      matchedSlugs.add(slug);
      // Check for status changes about this project
      for (const { pattern, predicate } of STATUS_PATTERNS) {
        const match = text.match(pattern);
        if (match) {
          addUnique({
            subject: slug,
            predicate: `status_${predicate}`,
            object: match[1].trim().replace(/[.,;:!?]+$/, ""),
          });
        }
      }
    }
  }

  // 2. Detect "proyecto/project X" mentions
  let projMatch: RegExpExecArray | null;
  PROJECT_MENTION.lastIndex = 0;
  while ((projMatch = PROJECT_MENTION.exec(text)) !== null) {
    const projectName = projMatch[1].trim();
    if (projectName.length > 2 && projectName.length < 30) {
      addUnique({
        subject: projectName.toLowerCase(),
        predicate: "mentioned_in_conversation",
        object: nowMexIsoDate(),
      });
    }
  }

  // 3. Status changes (generic — subject inferred from context)
  for (const { pattern, predicate } of STATUS_PATTERNS) {
    const match = text.match(pattern);
    if (match && triples.length === 0) {
      // Only add generic status if no project-specific one was found
      const object = match[1].trim().replace(/[.,;:!?]+$/, "");
      if (object.length > 4) {
        addUnique({
          subject: "current_task",
          predicate: `status_${predicate}`,
          object,
        });
      }
    }
  }

  // 4. Decisions
  for (const { pattern, predicate } of DECISION_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const object = match[1].trim().replace(/[.,;:!?]+$/, "");
      if (object.length > 4) {
        addUnique({
          subject: "user",
          predicate,
          object,
        });
      }
    }
  }

  // 5. Person mentions
  PERSON_MENTION.lastIndex = 0;
  let personMatch: RegExpExecArray | null;
  while ((personMatch = PERSON_MENTION.exec(text)) !== null) {
    const name = (personMatch[1] ?? personMatch[2]).trim();
    // Filter out common Spanish preposition false positives
    if (
      name.length > 2 &&
      !/^(Los|Las|Una|Uno|Que|Este|Esta|Todo|Toda|Pero|Más|Sin|Por)$/i.test(
        name,
      )
    ) {
      addUnique({
        subject: name.toLowerCase(),
        predicate: "mentioned_in_conversation",
        object: nowMexIsoDate(),
      });
    }
  }

  return triples;
}
