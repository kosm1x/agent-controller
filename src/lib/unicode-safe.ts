/**
 * Unicode surrogate-pair safety helpers.
 *
 * JavaScript strings are sequences of UTF-16 code units. Non-BMP characters
 * (emoji, many CJK extensions, math symbols) occupy TWO code units — a high
 * surrogate (0xD800–0xDBFF) followed by a low surrogate (0xDC00–0xDFFF).
 *
 * `.slice(0, n)` / `.substring(0, n)` cut at code-unit boundaries, not code
 * points. If `n` lands between the halves of a surrogate pair, the result
 * contains a *lone* high surrogate. When such a string is serialized to JSON
 * and sent to the Claude / Anthropic API, the server rejects it with:
 *
 *   400 invalid_request_error
 *   "The request body is not valid JSON: no low surrogate in string"
 *
 * Similarly, a lone low surrogate at the start of a slice is also invalid.
 *
 * Two helpers:
 *   - safeSlice(s, n): like s.slice(0, n), but backs off one code unit if the
 *     cut would strand a high surrogate. Guarantees no lone surrogates AT THE
 *     SEAM it creates.
 *   - sanitizeSurrogates(s): strip (or replace) any lone surrogate anywhere
 *     in the string. Use as a defense-in-depth sweep at the API boundary —
 *     catches lone surrogates introduced by any upstream code, including
 *     third-party libraries we don't control.
 */

/** Return true if `code` is in the high-surrogate range 0xD800–0xDBFF. */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Return true if `code` is in the low-surrogate range 0xDC00–0xDFFF. */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Slice `[0, n)` with surrogate-pair awareness. If the slice would end on a
 * lone high surrogate, shorten by one more code unit so the result is well-formed.
 *
 * Guarantees no lone surrogate AT THE SEAM this call creates. Does NOT remove
 * pre-existing lone surrogates elsewhere in the input — if the source may be
 * pre-poisoned (e.g. read from durable storage), pair with `sanitizeSurrogates`.
 */
export function safeSlice(s: string, n: number): string {
  if (n <= 0 || n >= s.length) return s.slice(0, n);
  // If the LAST char in the proposed slice is a high surrogate, drop it.
  const lastCode = s.charCodeAt(n - 1);
  if (isHighSurrogate(lastCode)) {
    return s.slice(0, n - 1);
  }
  return s.slice(0, n);
}

/**
 * Remove any lone surrogates from `s`. Replaces them with the Unicode
 * replacement character (U+FFFD) to preserve length-adjacent invariants in
 * downstream code without inventing a different pairing.
 *
 * Cheap: one pass, returns the original string reference when clean (common case).
 */
export function sanitizeSurrogates(s: string): string {
  // Fast path: scan once; if no lone surrogate, return the input unchanged.
  // Most strings are clean — don't allocate when we don't need to.
  const len = s.length;
  let firstBad = -1;
  for (let i = 0; i < len; i++) {
    const code = s.charCodeAt(i);
    if (isHighSurrogate(code)) {
      const next = i + 1 < len ? s.charCodeAt(i + 1) : 0;
      if (!isLowSurrogate(next)) {
        firstBad = i;
        break;
      }
      i++; // skip the paired low surrogate
    } else if (isLowSurrogate(code)) {
      firstBad = i;
      break;
    }
  }
  if (firstBad === -1) return s;

  const out: string[] = [s.slice(0, firstBad)];
  for (let i = firstBad; i < len; i++) {
    const code = s.charCodeAt(i);
    if (isHighSurrogate(code)) {
      const next = i + 1 < len ? s.charCodeAt(i + 1) : 0;
      if (isLowSurrogate(next)) {
        out.push(s.slice(i, i + 2));
        i++;
      } else {
        out.push("\uFFFD");
      }
    } else if (isLowSurrogate(code)) {
      out.push("\uFFFD");
    } else {
      out.push(s[i]);
    }
  }
  return out.join("");
}
