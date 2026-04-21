/**
 * JSON parsing from LLM output — string-literal-aware balanced-brace extraction.
 * Handles CoT prose preambles that wrap a JSON payload.
 */

/**
 * Extract the first balanced JSON value (array or object) from a raw string.
 * Returns null if no well-formed JSON is found.
 */
export function extractFirstJson<T = unknown>(raw: string): T | null {
  const candidates: Array<{ open: string; close: string; start: number }> = [];
  const arrStart = raw.indexOf("[");
  const objStart = raw.indexOf("{");
  if (arrStart !== -1)
    candidates.push({ open: "[", close: "]", start: arrStart });
  if (objStart !== -1)
    candidates.push({ open: "{", close: "}", start: objStart });
  candidates.sort((a, b) => a.start - b.start);

  for (const { open, close, start } of candidates) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    let done = false;
    for (let i = start; i < raw.length && !done; i++) {
      const ch = raw[i];
      if (inStr) {
        if (esc) {
          esc = false;
        } else if (ch === "\\") {
          esc = true;
        } else if (ch === '"') {
          inStr = false;
        }
        continue;
      }
      if (ch === '"') {
        inStr = true;
        continue;
      }
      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          const slice = raw.slice(start, i + 1);
          try {
            return JSON.parse(slice) as T;
          } catch {
            done = true;
          }
        }
      }
    }
  }
  return null;
}

export interface DecompositionParseResult {
  units: Array<{
    title: string;
    summary: string;
    predicted_difficulties: string[];
    prerequisites: number[];
  }>;
}

/** Parse+validate decomposition output. Throws on malformed shape. */
export function parseDecomposition(
  raw: string,
  ceilingUnits: number,
): DecompositionParseResult {
  const parsed = extractFirstJson<unknown>(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Decomposition LLM output did not contain a JSON array");
  }
  if (parsed.length === 0) {
    throw new Error("Decomposition returned 0 units — need at least 2");
  }
  const bounded = parsed.slice(0, ceilingUnits);
  const units = bounded.map((u, i) => {
    if (typeof u !== "object" || u === null) {
      throw new Error(`Unit ${i} is not an object`);
    }
    const obj = u as Record<string, unknown>;
    const title = typeof obj.title === "string" ? obj.title.trim() : "";
    const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
    if (!title || !summary) {
      throw new Error(`Unit ${i} missing title or summary`);
    }
    const diffs = Array.isArray(obj.predicted_difficulties)
      ? obj.predicted_difficulties
          .filter((d): d is string => typeof d === "string")
          .map((d) => d.trim())
          .filter((d) => d.length > 0)
      : [];
    const prereqs = Array.isArray(obj.prerequisites)
      ? obj.prerequisites
          .filter(
            (p): p is number => typeof p === "number" && Number.isFinite(p),
          )
          .map((p) => Math.trunc(p))
          .filter((p) => p >= 0 && p < i)
      : [];
    return {
      title,
      summary,
      predicted_difficulties: diffs,
      prerequisites: prereqs,
    };
  });
  return { units };
}

export interface QuizParseResult {
  questions: Array<{
    question: string;
    expected_answer: string;
    difficulty: "easy" | "medium" | "hard";
  }>;
}

export function parseQuiz(raw: string, maxN: number): QuizParseResult {
  const parsed = extractFirstJson<unknown>(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Quiz LLM output did not contain a JSON array");
  }
  const qs = parsed.slice(0, maxN).map((q, i) => {
    if (typeof q !== "object" || q === null) {
      throw new Error(`Question ${i} is not an object`);
    }
    const obj = q as Record<string, unknown>;
    const question =
      typeof obj.question === "string" ? obj.question.trim() : "";
    const expected_answer =
      typeof obj.expected_answer === "string" ? obj.expected_answer.trim() : "";
    if (!question || !expected_answer) {
      throw new Error(`Question ${i} missing question or expected_answer`);
    }
    const rawDiff =
      typeof obj.difficulty === "string" ? obj.difficulty.toLowerCase() : "";
    const difficulty: "easy" | "medium" | "hard" =
      rawDiff === "easy" || rawDiff === "hard" ? rawDiff : "medium";
    return { question, expected_answer, difficulty };
  });
  if (qs.length === 0) {
    throw new Error("Quiz returned 0 questions");
  }
  return { questions: qs };
}

export interface SummaryParseResult {
  concepts: Array<{
    concept: string;
    evidence_quote: string;
    mastery_estimate: number;
  }>;
}

export function parseSummary(raw: string): SummaryParseResult {
  const parsed = extractFirstJson<unknown>(raw);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("Summary LLM output did not contain a JSON object/array");
  }
  const concepts = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as Record<string, unknown>).concepts)
      ? ((parsed as Record<string, unknown>).concepts as unknown[])
      : null;
  if (!Array.isArray(concepts)) {
    throw new Error('Summary missing "concepts" array');
  }
  const out = concepts
    .map((c) => {
      if (typeof c !== "object" || c === null) return null;
      const obj = c as Record<string, unknown>;
      const concept =
        typeof obj.concept === "string" ? normalizeConcept(obj.concept) : "";
      const evidence_quote =
        typeof obj.evidence_quote === "string" ? obj.evidence_quote.trim() : "";
      const rawMastery =
        typeof obj.mastery_estimate === "number"
          ? obj.mastery_estimate
          : Number.NaN;
      const mastery = Number.isFinite(rawMastery)
        ? Math.max(0, Math.min(1, rawMastery))
        : 0;
      if (!concept) return null;
      return { concept, evidence_quote, mastery_estimate: mastery };
    })
    .filter(
      (
        c,
      ): c is {
        concept: string;
        evidence_quote: string;
        mastery_estimate: number;
      } => c !== null,
    );
  return { concepts: out };
}

export interface GradingParseResult {
  quality: number;
  feedback: string;
  flagged_misconceptions: string[];
}

export function parseGrading(raw: string): GradingParseResult {
  const parsed = extractFirstJson<unknown>(raw);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("Grading LLM output did not contain a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const rawQ = typeof obj.quality === "number" ? obj.quality : Number.NaN;
  const quality = Number.isFinite(rawQ)
    ? Math.max(0, Math.min(5, Math.round(rawQ)))
    : 0;
  const feedback = typeof obj.feedback === "string" ? obj.feedback.trim() : "";
  const flagged = Array.isArray(obj.flagged_misconceptions)
    ? obj.flagged_misconceptions
        .filter((m): m is string => typeof m === "string")
        .map((m) => m.trim())
        .filter((m) => m.length > 0)
    : [];
  return { quality, feedback, flagged_misconceptions: flagged };
}

/**
 * Normalize a concept key: NFC, lowercase, trim, collapse whitespace, strip
 * trailing pluralization `s` (but keep 2+ letter concepts intact).
 * Prevents "React" vs "react" vs "React " duplicates in learner_model.
 */
export function normalizeConcept(raw: string): string {
  const trimmedRaw = raw.normalize("NFC").trim();
  // Acronym guard: pre-lowercase, treat 2-6 char ALL-CAPS tokens as atomic
  // (HTTPS, TCP, UDP, CORS) so they don't collapse into a different concept.
  // Also catch the pluralized acronym pattern (APIs, URLs, DBs, GPUs) — strip
  // the trailing `s` on the original case, then lowercase the acronym — so
  // both "API" and "APIs" and "apis" end up as the same "api" key.
  const isAcronym =
    /^[A-Z][A-Z0-9]{1,5}$/.test(trimmedRaw) &&
    !/^(THE|AND|NOT|YOU|FOR)$/.test(trimmedRaw);
  if (isAcronym) return trimmedRaw.toLowerCase();
  const isPluralizedAcronym = /^[A-Z]{2,5}s$/.test(trimmedRaw);
  if (isPluralizedAcronym) return trimmedRaw.slice(0, -1).toLowerCase();

  const nfc = trimmedRaw.toLowerCase().replace(/\s+/g, " ");
  if (nfc.length <= 2) return nfc;
  // Protected endings: words in scientific/technical English where trailing
  // `s` is structural, not plural. status→statu and analysis→analysi would
  // be wrong collisions.
  const endsInProtected = /(?:ss|is|us|ous|ics|sis|ias)$/i.test(nfc);
  if (nfc.endsWith("s") && !endsInProtected) {
    return nfc.slice(0, -1);
  }
  return nfc;
}
