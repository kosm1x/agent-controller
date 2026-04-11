/**
 * Auto Entity Detection (v6.5 M3) — keyword-based entity extraction from conversations.
 *
 * Extracts people, projects, status changes, and decisions from conversation text
 * using heuristic patterns. No LLM call — pure regex/keyword matching.
 * Results feed into the temporal knowledge graph (M1) as auto-detected triples.
 *
 * Adapted from mempalace's entity_detector.py + general_extractor.py patterns.
 */

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

/** Known project slugs — kept in sync with fast-runner PROJECT_SLUGS. */
const PROJECT_SLUGS = [
  "agent-controller",
  "mission-control",
  "jarvis",
  "cuatro-flor",
  "pipesong",
  "vlmp",
  "crm-azteca",
  "commit-ai",
  "eureka",
  "eurekamD",
  "northstar",
];

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
  for (const slug of PROJECT_SLUGS) {
    const slugPattern = new RegExp(`\\b${slug.replace(/-/g, "[- ]?")}\\b`, "i");
    if (slugPattern.test(text)) {
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
        object: new Date().toISOString().slice(0, 10),
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
        object: new Date().toISOString().slice(0, 10),
      });
    }
  }

  return triples;
}
