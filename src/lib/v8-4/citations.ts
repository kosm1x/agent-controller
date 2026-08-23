/**
 * Citation existence check — usability plan Phase 3.3 (2026-08-23).
 *
 * #11685: a research deliverable cited five papers that do not exist. A
 * citation is a claim that a source exists; the harness resolves each one
 * ONCE (DOI via Crossref/doi.org, arXiv via its export API, URLs via HEAD,
 * title+year entries via a Crossref bibliographic query) and DROPS the
 * entries that are positively missing, with one line telling the reader.
 *
 * Three verdicts, deliberately: `resolved` (exists), `missing` (404 / no
 * record / no Crossref match — dropped), `unreachable` (403, 429, 5xx,
 * timeout, DNS — KEPT; a bot wall is not a fabrication). Runs only when the
 * text has a references section or a DOI/arXiv id, never on casual links.
 * Budget: every lookup in parallel, 6 s each, 15 s overall; results cached
 * in-process for a day. `CITATION_CHECK=off|shadow|enforce` (default
 * enforce); shadow records the verdicts without touching the text.
 */

import { validateOutboundUrlResolved } from "../url-safety.js";

export type CitationKind = "doi" | "arxiv" | "url" | "title";
export type Verdict = "resolved" | "missing" | "unreachable";

export interface Citation {
  kind: CitationKind;
  /** Lookup key (DOI, arXiv id, URL, or the title). */
  key: string;
  /** The reference-entry line this came from (when inside a references section). */
  line?: string;
  /** 0-based index of that line in the text. */
  lineIndex?: number;
  /** `[n]` label of the entry, when the entry is numbered that way. */
  label?: string;
  /**
   * Title-kind only: the title came from a high-confidence shape (APA
   * "(Year). Title.", Vancouver "Authors. Title. Journal.", quoted/italic).
   * A longest-fragment fallback is never droppable (R2 audit C-2).
   */
  confident?: boolean;
}

export interface CitationReport {
  text: string;
  total: number;
  resolved: number;
  missing: number;
  unreachable: number;
  dropped: string[];
  ms: number;
}

export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    redirect?: "manual" | "follow" | "error";
  },
) => Promise<{
  status: number;
  text(): Promise<string>;
  headers?: { get(name: string): string | null };
}>;

const PER_LOOKUP_MS = 6_000;
const OVERALL_MS = 8_000;
const MAX_CITATIONS = 25;
const CACHE_TTL_MS = 24 * 3600_000;
const CACHE_MAX = 2000;
const MAILTO = "jarvis@eurekamd.net";

const DOI_RE = /\b10\.\d{4,9}\/[^\s"'<>)\]]+/g;
const ARXIV_RE =
  /\barXiv:\s?(\d{4}\.\d{4,5})(?:v\d+)?\b|\barxiv\.org\/abs\/(\d{4}\.\d{4,5})/gi;
const URL_RE = /https?:\/\/[^\s<>)"'\]]+/g;
/**
 * A references heading is the heading word ALONE on its line (optionally
 * `#`/bold/colon) — "**Fuentes escaneadas:** 18" is content, not a section
 * start (R1 audit W6).
 */
const REF_HEADING_RE =
  /^\s*(?:#{1,6}\s*)?\**\s*(referencias|references|bibliograf[ií]a|fuentes|sources|papers?)(?:\s+(?:consultadas|citadas|utilizadas|usadas|principales|bibliogr[aá]ficas|cited|used|consulted))?\s*:?\s*\**\s*$/i;
const ENTRY_RE = /^\s*(?:\[(\d+)\]|(\d+)[.)]|[-*•])\s+(.+)$/;
const YEAR_RE = /\b(19|20)\d{2}\b/;
/**
 * A title-only entry is checked against Crossref ONLY when it looks like an
 * academic work (author list, et al., journal/volume/pages vocabulary) —
 * Crossref does not index INEGI tabulados or a newspaper, and "no match"
 * there must never drop a legitimate non-academic source.
 */
const ACADEMIC_RE =
  /\bet al\b|\bvol\.?\s*\d|\bpp?\.\s*\d|\b(journal|proceedings|conference|review|nature|science|lancet|nejm|jama|cell|plos|ieee|acm|springer|elsevier|wiley|psychology|medicine|revista)\b|^[A-ZÁÉÍÓÚ][a-záéíóúñ]+,\s+[A-Z]\.(?:\s?[A-Z]\.)?(?:,|\s+(?:&|y|and))/i;

export function citationMode(
  env: NodeJS.ProcessEnv = process.env,
): "off" | "shadow" | "enforce" {
  const v = (env.CITATION_CHECK ?? "enforce").trim().toLowerCase();
  return v === "off" || v === "shadow" ? v : "enforce";
}

function cleanDoi(d: string): string {
  return d.replace(/[.,;:]+$/, "");
}

function cleanUrl(u: string): string {
  return u.replace(/[.,;:]+$/, "");
}

const VENUE_RE =
  /\b(journal|proceedings|conference|transactions|review|letters|advances in|annals|bulletin|vol\.?|pp?\.|press|publishing|editorial|revista|arxiv|preprint)\b/i;

/**
 * Title of a reference entry. APA/Harvard first — the sentence right after
 * "(Year)." is the title, the next one the venue (R1 audit C7: the longest
 * fragment was the JOURNAL name, so real papers were queried wrongly and
 * dropped). Then a quoted/italic span; then the longest non-venue sentence.
 */
export function titleOf(
  entry: string,
): { title: string; confident: boolean } | null {
  const apa = /\((?:19|20)\d{2}[a-z]?\)\.?\s*([^.]{12,200})\./.exec(entry);
  if (apa && !VENUE_RE.test(apa[1]!))
    return { title: apa[1]!.trim(), confident: true };
  // Vancouver: "He K, Zhang X, Ren S. Title. Journal. 2016;12:1-5." — the
  // author list carries initials; the title is the next sentence.
  const vancouver =
    /^(?:[^.]*\b[A-Z]{1,2}\b[^.]*?)\.\s+([^.]{12,200})\.\s/.exec(entry);
  if (vancouver && !VENUE_RE.test(vancouver[1]!))
    return { title: vancouver[1]!.trim(), confident: true };
  const quoted =
    /[«“"]([^»”"]{12,200})[»”"]/.exec(entry) ??
    /\*([^*]{12,200})\*/.exec(entry);
  if (quoted) return { title: quoted[1]!.trim(), confident: true };
  const parts = entry
    .replace(/\(.*?\)/g, " ")
    .split(/[.;]\s+/)
    .map((p) => p.trim())
    .filter(
      (p) =>
        p.split(/\s+/).length >= 4 && !/^https?:/.test(p) && !VENUE_RE.test(p),
    );
  if (parts.length === 0) return null;
  return {
    title: parts.sort((a, b) => b.length - a.length)[0]!.slice(0, 200),
    confident: false,
  };
}

/**
 * Only a venue Crossref indexes can make a Crossref no-match a positive
 * "missing": English academic vocabulary or a DOI-bearing publisher. A
 * Spanish "Revista", a newspaper or a magazine is a real source Crossref
 * simply does not know (R3 audit C-1) — those titles are never droppable.
 */
const CROSSREF_VENUE_RE =
  /\b(journal|proceedings|conference|transactions|symposium|workshop|review of|annals|bulletin|nature|science|lancet|nejm|jama|cell|plos|ieee|acm|springer|elsevier|wiley|arxiv|preprint|letters|vol\.?\s*\d+\s*\(?\d*\)?\s*,?\s*(?:no\.|pp?\.))/i;

/** Venues Crossref does not index even when the entry carries vol./pp. (R4 W4-4). */
const NON_CROSSREF_VENUE_RE =
  /\b(revista|peri[oó]dico|diario|magazine|newsletter|blog|gaceta|semanario|suplemento)\b/i;

/** Citations in `text` — only from a references section, plus any DOI/arXiv anywhere. */
export function extractCitations(text: string): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();
  const push = (c: Citation) => {
    const k = `${c.kind}:${c.key.toLowerCase()}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(c);
  };
  for (const m of text.matchAll(DOI_RE))
    push({ kind: "doi", key: cleanDoi(m[0]) });
  for (const m of text.matchAll(ARXIV_RE))
    push({ kind: "arxiv", key: (m[1] ?? m[2])! });

  const lines = text.split("\n");
  let inRefs = false;
  for (const [lineIndex, line] of lines.entries()) {
    if (REF_HEADING_RE.test(line)) {
      inRefs = true;
      continue;
    }
    if (!inRefs) continue;
    if (/^\s*#{1,6}\s/.test(line)) {
      inRefs = false;
      continue;
    }
    const e = ENTRY_RE.exec(line);
    if (!e) continue;
    const label = e[1] ? `[${e[1]}]` : undefined;
    const body = e[3]!;
    const doi = new RegExp(DOI_RE.source).exec(body);
    const arx = new RegExp(ARXIV_RE.source, "i").exec(body);
    if (doi) {
      // Already pushed above; attach the line so it can be dropped.
      const existing = out.find(
        (c) => c.kind === "doi" && c.key === cleanDoi(doi[0]),
      );
      if (existing) Object.assign(existing, { line, lineIndex, label });
      continue;
    }
    if (arx) {
      const existing = out.find(
        (c) => c.kind === "arxiv" && c.key === (arx[1] ?? arx[2]),
      );
      if (existing) Object.assign(existing, { line, lineIndex, label });
      continue;
    }
    const url = new RegExp(URL_RE.source).exec(body);
    if (url) {
      push({ kind: "url", key: cleanUrl(url[0]), line, lineIndex, label });
      continue;
    }
    if (YEAR_RE.test(body) && ACADEMIC_RE.test(body)) {
      const t = titleOf(body);
      if (t)
        push({
          kind: "title",
          key: t.title,
          line,
          lineIndex,
          label,
          confident:
            t.confident &&
            CROSSREF_VENUE_RE.test(body) &&
            !NON_CROSSREF_VENUE_RE.test(body),
        });
    }
  }
  return out.slice(0, MAX_CITATIONS);
}

// ── resolution ────────────────────────────────────────────────────────────

const cache = new Map<string, { verdict: Verdict; at: number }>();

/** @internal test hook */
export function _resetCitationCache(): void {
  cache.clear();
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function titlesMatch(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  const ta = new Set(na.split(" ").filter((w) => w.length > 2));
  const tb = new Set(nb.split(" ").filter((w) => w.length > 2));
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  const union = ta.size + tb.size - inter;
  return union > 0 && inter / union >= 0.6;
}

async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([p, t]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function statusVerdict(status: number): Verdict {
  if (status >= 200 && status < 300) return "resolved";
  if (status >= 300 && status < 400) return "unreachable"; // redirect without a usable target
  if (status === 404 || status === 410) return "missing";
  return "unreachable";
}

/**
 * Hosts the harness will never probe on the model's behalf (R1 audit C6 /
 * R2 audit C-3): scheme, literal-IP and DNS-RESOLVED checks, and every
 * redirect hop re-validated — `fetch` never follows on its own.
 */
export async function citationUrlBlocked(url: string): Promise<string | null> {
  return validateOutboundUrlResolved(url);
}

const MAX_REDIRECTS = 3;

async function fetchStatus(
  f: FetchLike,
  url: string,
  method: "HEAD" | "GET",
  follow = true,
): Promise<{ status: number; body: string }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const blocked = await citationUrlBlocked(current);
    if (blocked) throw new Error(`blocked: ${blocked}`);
    const res = await f(current, {
      method,
      headers: { "user-agent": `mission-control/1.0 (mailto:${MAILTO})` },
      signal: AbortSignal.timeout(PER_LOOKUP_MS),
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers?.get("location");
      if (!follow || !loc) return { status: res.status, body: "" };
      current = new URL(loc, current).toString();
      continue;
    }
    return {
      status: res.status,
      body: method === "GET" ? await res.text() : "",
    };
  }
  // Too many hops: treat as reachable-but-unverifiable, never as missing.
  return { status: 399, body: "" };
}

export async function resolveCitation(
  c: Citation,
  f: FetchLike,
): Promise<Verdict> {
  const cacheKey = `${c.kind}:${c.confident ? "c:" : ""}${c.key.toLowerCase()}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.verdict;
  let verdict: Verdict = "unreachable";
  try {
    if (c.kind === "doi") {
      const r = await fetchStatus(
        f,
        `https://api.crossref.org/works/${encodeURIComponent(c.key)}?mailto=${MAILTO}`,
        "HEAD",
      );
      verdict = statusVerdict(r.status);
      if (verdict !== "resolved") {
        // Not every DOI is Crossref (DataCite, mEDRA…): the resolver is
        // authoritative — 302 = exists, 404 = no such DOI, else unreachable.
const h = await fetchStatus(
          f,
          `https://doi.org/${encodeURI(c.key)}`,
          "HEAD",
          false, // doi.org 302 = the DOI is registered; we never visit the publisher
        );
        verdict =
          h.status >= 300 && h.status < 400 ? "resolved" : statusVerdict(h.status);
      }
    } else if (c.kind === "arxiv") {
      const r = await fetchStatus(
        f,
        `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(c.key)}`,
        "GET",
      );
      if (r.status >= 200 && r.status < 300) {
        verdict = /<entry>[\s\S]*?<id>https?:\/\/arxiv\.org\/abs\//.test(r.body)
          ? "resolved"
          : "missing";
      } else verdict = statusVerdict(r.status);
    } else if (c.kind === "url") {
      let r = await fetchStatus(f, c.key, "HEAD");
      if (r.status === 405 || r.status === 501)
        r = await fetchStatus(f, c.key, "GET");
      verdict = statusVerdict(r.status);
    } else {
      const r = await fetchStatus(
        f,
        `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(c.key)}&rows=3&select=title&mailto=${MAILTO}`,
        "GET",
      );
      if (r.status >= 200 && r.status < 300) {
        const items =
          (
            JSON.parse(r.body) as {
              message?: { items?: Array<{ title?: string[] }> };
            }
          ).message?.items ?? [];
        // Crossref answers a bibliographic query with its nearest works; a
        // positive "missing" needs candidates that all fail to match — an
        // empty answer is kept (conservative against dropping a real paper).
        const matched = items.some((it) =>
          (it.title ?? []).some((t) => titlesMatch(t, c.key)),
        );
        verdict = matched
          ? "resolved"
          : items.length === 0 || !c.confident
            ? "unreachable"
            : "missing";
      } else verdict = statusVerdict(r.status);
    }
  } catch {
    verdict = "unreachable";
  }
  if (cache.size >= CACHE_MAX)
    cache.delete(cache.keys().next().value as string);
  cache.set(cacheKey, { verdict, at: Date.now() });
  return verdict;
}

/** Escape for use inside a RegExp. */
function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function codeRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let open: number | null = null;
  for (const m of text.matchAll(/^\s*(```|~~~)/gm)) {
    if (open === null) open = m.index ?? 0;
    else {
      out.push([open, (m.index ?? 0) + m[0].length]);
      open = null;
    }
  }
  if (open !== null) out.push([open, text.length]);
  for (const m of text.matchAll(/`[^`\n]+`/g)) {
    const i = m.index ?? 0;
    if (!out.some(([a, b]) => i >= a && i < b)) out.push([i, i + m[0].length]);
  }
  return out;
}

/** Remove dropped entries (their exact line) and their `[n]` markers outside code; append one note line. */
export function applyDrops(text: string, dropped: readonly Citation[]): string {
  if (dropped.length === 0) return text;
  const lines = text.split("\n");
  const drop = new Set(
    dropped.map((c) => c.lineIndex).filter((i): i is number => i !== undefined),
  );
  let out = lines.filter((_, i) => !drop.has(i)).join("\n");
  const labels = dropped.map((c) => c.label).filter((l): l is string => !!l);
  if (labels.length > 0) {
    const ranges = codeRanges(out);
    const re = new RegExp(
      `\\s?\\[(?:${labels.map((l) => esc(l.slice(1, -1))).join("|")})\\](?!\\()`,
      "g",
    );
    out = out.replace(re, (m, offset: number) =>
      ranges.some(([a, b]) => offset >= a && offset < b) ? m : "",
    );
  }
  const names = dropped
    .slice(0, 3)
    .map((c) => `«${c.key.slice(0, 60)}»`)
    .join(", ");
  const more = dropped.length > 3 ? ` y ${dropped.length - 3} más` : "";
  return `${out.trimEnd()}\n\n⚠️ Quité ${dropped.length} referencia${dropped.length === 1 ? "" : "s"} que no existe${dropped.length === 1 ? "" : "n"} (DOI/URL/Crossref sin registro): ${names}${more}.`;
}

export async function checkCitations(
  text: string,
  opts: {
    fetchImpl?: FetchLike;
    mode?: "shadow" | "enforce";
    overallMs?: number;
  } = {},
): Promise<CitationReport | null> {
  const citations = extractCitations(text);
  if (citations.length === 0) return null;
  const f = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const start = Date.now();
  const verdicts = await withTimeout(
    Promise.all(citations.map((c) => resolveCitation(c, f))),
    opts.overallMs ?? OVERALL_MS,
    citations.map<Verdict>(() => "unreachable"),
  );
  const dropped = citations.filter((_, i) => verdicts[i] === "missing");
  const report: CitationReport = {
    text,
    total: citations.length,
    resolved: verdicts.filter((v) => v === "resolved").length,
    missing: dropped.length,
    unreachable: verdicts.filter((v) => v === "unreachable").length,
    dropped: dropped.map((c) => c.key),
    ms: Date.now() - start,
  };
  if ((opts.mode ?? "enforce") === "enforce")
    report.text = applyDrops(text, dropped);
  return report;
}
