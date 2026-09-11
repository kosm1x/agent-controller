/**
 * email-verify — syntax stage.
 *
 * RFC 5321/5322 "practical" validation: dot-atom local part, ASCII hostname
 * domain with a real TLD. Quoted local parts, IP literals and IDN are
 * rejected on purpose — none appear in outreach lists and each is an
 * SMTP-probe edge case with no upside.
 */

export interface SyntaxResult {
  readonly isValid: boolean;
  /** Lowercased domain (empty when invalid). */
  readonly domain: string;
  /** Lowercased local part (empty when invalid). RFC 5321 allows case-sensitive
   *  local parts; no real provider honours that, and outreach lists mix cases. */
  readonly localPart: string;
  /** Fully lowercased `local@domain`; null when invalid. */
  readonly normalized: string | null;
  /** Why the address failed syntax; null when valid. */
  readonly reason: string | null;
}

const LOCAL_ATEXT = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^[a-z]{2,63}$/;

function invalid(reason: string): SyntaxResult {
  return { isValid: false, domain: "", localPart: "", normalized: null, reason };
}

export function checkSyntax(input: string): SyntaxResult {
  const raw = input.trim();
  if (raw.length === 0) return invalid("empty");
  if (raw.length > 254) return invalid("too long (max 254)");
  if (/[\s<>,;()[\]\\"]/.test(raw)) return invalid("contains whitespace or forbidden characters");
  // eslint-disable-next-line no-control-regex
  if (/[^\x21-\x7e]/.test(raw)) return invalid("non-ASCII characters (IDN/quoted forms unsupported)");

  const at = raw.lastIndexOf("@");
  if (at === -1) return invalid("missing @");
  if (raw.indexOf("@") !== at) return invalid("multiple @");

  const localPart = raw.slice(0, at).toLowerCase();
  const domain = raw.slice(at + 1).toLowerCase();

  if (localPart.length === 0) return invalid("empty local part");
  if (localPart.length > 64) return invalid("local part too long (max 64)");
  if (!LOCAL_ATEXT.test(localPart)) return invalid("invalid characters or dot placement in local part");

  if (domain.length === 0) return invalid("empty domain");
  if (domain.length > 253) return invalid("domain too long (max 253)");
  const labels = domain.split(".");
  if (labels.length < 2) return invalid("domain has no TLD");
  for (const label of labels) {
    if (!DOMAIN_LABEL.test(label)) return invalid(`invalid domain label "${label}"`);
  }
  if (!TLD.test(labels[labels.length - 1])) return invalid("TLD must be alphabetic (2-63 chars)");

  return { isValid: true, domain, localPart, normalized: `${localPart}@${domain}`, reason: null };
}

/** Well-known mailbox providers used for typo suggestions (MX-heavy list). */
const SUGGESTION_DOMAINS = [
  "gmail.com",
  "hotmail.com",
  "outlook.com",
  "yahoo.com",
  "yahoo.com.mx",
  "hotmail.es",
  "live.com.mx",
  "icloud.com",
  "protonmail.com",
  "prodigy.net.mx",
] as const;

/** Levenshtein distance (small strings only). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Suggest a corrected address when the domain is within 2 edits of a
 * well-known provider (and is not itself that provider). Returns null
 * when nothing close is found.
 */
export function suggestDomain(localPart: string, domain: string): string | null {
  for (const candidate of SUGGESTION_DOMAINS) {
    if (candidate === domain) return null;
    if (levenshtein(domain, candidate) <= 2) return `${localPart}@${candidate}`;
  }
  return null;
}
