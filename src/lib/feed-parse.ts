/**
 * Dependency-free RSS / Atom parser — replaces the rss2json proxy, which
 * intermittently could not download feeds the host itself fetches fine.
 *
 * Handles RSS 2.0 (`<rss><channel><item>`), RSS 1.0 (`<rdf:RDF>`, items are
 * channel siblings) and Atom (`<feed><entry>`). CDATA, the five XML entities
 * and numeric entities are decoded; attributes and self-closing tags are
 * understood. indexOf scans, linear on adversarial input (rss_read runs it
 * on any URL's body, on the main event loop). Tolerant: it never throws,
 * returns whatever it can read, and returns null when the document is not a
 * feed at all (HTML page, JSON, garbage) so callers can report "not an
 * RSS/Atom feed".
 */

export interface FeedItem {
  title: string;
  link: string;
  /** Raw date string as published (RSS pubDate / Atom published|updated). */
  pubDate: string;
  /** Entity-decoded description (often HTML): description|content:encoded, summary|content. */
  description: string;
  author: string;
}

export interface Feed {
  format: "rss" | "atom";
  title: string;
  description: string;
  link: string;
  items: FeedItem[];
}

interface Element {
  attrs: string;
  inner: string;
  start: number;
  end: number;
}

// Every scan below is an indexOf walk that stops at the first opener with no
// close (the remainder stays text). Lazy-regex spans (`<x>[\s\S]*?</x>`) retry
// from every unclosed opener and went quadratic on a 5 MB adversarial body —
// minutes of blocked event loop (qa B1).

// CDATA bodies are swapped for \u0000<n>\u0000 placeholders before any tag
// matching, so markup inside CDATA can never be mistaken for feed structure.
// NULs are stripped from the input first, so only our placeholders carry one.
const PLACEHOLDER_RE = /\u0000(\d+)\u0000/g;
// Named entities are case-sensitive (`&Amp;` is not `&amp;`); only the hex
// prefix and digits of a character reference are case-insensitive.
const ENTITY_RE = /&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|lt|gt|amp|quot|apos);/g;
const NAMED: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

/** Decode XML entities in one pass (so `&amp;lt;` stays `&lt;`). */
export function decodeEntities(s: string): string {
  return s.replace(ENTITY_RE, (whole, ent: string) => {
    if (ent[0] !== "#") return NAMED[ent] ?? whole;
    const code =
      ent[1] === "x" || ent[1] === "X"
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10);
    if (
      !Number.isFinite(code) ||
      code <= 0 ||
      code > 0x10ffff ||
      (code >= 0xd800 && code <= 0xdfff)
    ) {
      return whole;
    }
    return String.fromCodePoint(code);
  });
}

/** rss_read's and google_news's cap on a feed body. */
export const MAX_FEED_BYTES = 5 * 1024 * 1024;

/** Read a response body, refusing anything past `maxBytes`. */
export async function readCappedBody(
  res: Response,
  maxBytes = MAX_FEED_BYTES,
): Promise<Uint8Array> {
  const declared = Number(res.headers?.get("content-length"));
  if (declared > maxBytes) {
    void res.body?.cancel().catch(() => {});
    throw new Error(`feed larger than ${maxBytes} bytes`);
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => {});
      throw new Error(`feed larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Decode a feed body: a byte-order mark wins (WHATWG / XML), then the
 * Content-Type charset, then the XML declaration's `encoding`, else UTF-8
 * (an unknown label falls through to the next source).
 */
export function decodeFeedBody(
  bytes: Uint8Array,
  contentType?: string | null,
): string {
  const bom =
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
      ? "utf-8"
      : bytes[0] === 0xff && bytes[1] === 0xfe
        ? "utf-16le"
        : bytes[0] === 0xfe && bytes[1] === 0xff
          ? "utf-16be"
          : undefined;
  if (bom) return new TextDecoder(bom).decode(bytes); // strips the BOM
  const fromHeader = /charset\s*=\s*["']?([\w.:-]+)/i.exec(
    contentType ?? "",
  )?.[1];
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 200));
  const fromDecl = /^\s*<\?xml\s[^>]*?encoding\s*=\s*["']([\w.:-]+)["']/i.exec(
    head,
  )?.[1];
  for (const label of [fromHeader, fromDecl]) {
    if (!label) continue;
    try {
      return new TextDecoder(label, { fatal: false }).decode(bytes);
    } catch {
      // unknown label — try the next source
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

function isSpace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r";
}

/**
 * `<name …>…</name>` / `<name …/>` blocks in src, in order (no same-name
 * nesting). Stops at an opener with no `>` or no close tag.
 */
function elements(src: string, name: string, limit = Infinity): Element[] {
  const open = `<${name}`;
  const close = `</${name}`;
  const out: Element[] = [];
  let pos = 0;
  while (out.length < limit) {
    const o = src.indexOf(open, pos);
    if (o === -1) break;
    const next = src[o + open.length] ?? "";
    if (next !== ">" && next !== "/" && !isSpace(next)) {
      pos = o + open.length; // `<items`, `<item:x` — a different tag
      continue;
    }
    const gt = src.indexOf(">", o + open.length);
    if (gt === -1) break;
    const attrs = src.slice(o + open.length, gt);
    if (attrs.endsWith("/")) {
      out.push({ attrs: attrs.slice(0, -1), inner: "", start: o, end: gt + 1 });
      pos = gt + 1;
      continue;
    }
    // `</name` then optional whitespace then `>`
    let c = src.indexOf(close, gt + 1);
    let closeEnd = -1;
    while (c !== -1) {
      let i = c + close.length;
      while (isSpace(src[i] ?? "")) i++;
      if (src[i] === ">") {
        closeEnd = i + 1;
        break;
      }
      c = src.indexOf(close, i);
    }
    if (closeEnd === -1) break; // unclosed — keep what was read so far
    out.push({ attrs, inner: src.slice(gt + 1, c), start: o, end: closeEnd });
    pos = closeEnd;
  }
  return out;
}

function attr(attrs: string, key: string): string | undefined {
  // `key` is a fixed literal (rel, href, isPermaLink). Scans one tag's
  // attribute text; every attempt ends at the next quote, so it stays linear.
  const m = new RegExp(`(?:^|\\s)${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(
    attrs,
  );
  return m ? decodeEntities(m[1] ?? m[2]) : undefined;
}

/** Remove whole `<name>…</name>` blocks (e.g. items, before reading channel fields). */
function without(src: string, names: string[]): string {
  let out = src;
  for (const name of names) {
    let kept = "";
    let pos = 0;
    for (const el of elements(out, name)) {
      kept += out.slice(pos, el.start);
      pos = el.end;
    }
    out = kept + out.slice(pos);
  }
  return out;
}

/**
 * Strip NULs, mask CDATA sections and drop comments in one left-to-right
 * pass; an unclosed `<![CDATA[` or `<!--` leaves the rest as plain text.
 */
function mask(input: string, cdata: string[]): string {
  const src = input.includes("\u0000") ? input.replaceAll("\u0000", "") : input;
  const parts: string[] = [];
  let pos = 0;
  let nextCdata = src.indexOf("<![CDATA[");
  let nextComment = src.indexOf("<!--");
  for (;;) {
    if (nextCdata !== -1 && nextCdata < pos)
      nextCdata = src.indexOf("<![CDATA[", pos);
    if (nextComment !== -1 && nextComment < pos)
      nextComment = src.indexOf("<!--", pos);
    const isCdata =
      nextCdata !== -1 && (nextComment === -1 || nextCdata < nextComment);
    const at = isCdata ? nextCdata : nextComment;
    if (at === -1) break;
    const end = isCdata
      ? src.indexOf("]]>", at + 9)
      : src.indexOf("-->", at + 4);
    if (end === -1) break;
    parts.push(src.slice(pos, at));
    if (isCdata)
      parts.push(`\u0000${cdata.push(src.slice(at + 9, end)) - 1}\u0000`);
    pos = end + 3;
  }
  parts.push(src.slice(pos));
  return parts.join("");
}

/** Root element name after BOM, whitespace, `<?…?>` and `<!DOCTYPE …>`. */
function rootName(src: string): string | undefined {
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) {
    while (isSpace(src[i] ?? "")) i++;
    if (src.startsWith("<?", i)) {
      const e = src.indexOf("?>", i + 2);
      if (e === -1) return undefined;
      i = e + 2;
    } else if (src.slice(i, i + 9).toUpperCase() === "<!DOCTYPE") {
      const e = src.indexOf(">", i + 9);
      if (e === -1) return undefined;
      i = e + 1;
    } else {
      break;
    }
  }
  const re = /<([\w:.-]+)/y;
  re.lastIndex = i;
  return re.exec(src)?.[1];
}

export function parseFeed(input: string): Feed | null {
  if (typeof input !== "string" || input.length === 0) return null;

  const cdata: string[] = [];
  const masked = mask(input, cdata);

  // Text of an element: entities decoded outside CDATA, CDATA kept verbatim.
  const text = (raw: string | undefined): string =>
    raw === undefined
      ? ""
      : decodeEntities(raw)
          .replace(PLACEHOLDER_RE, (_, i: string) => cdata[Number(i)] ?? "")
          .trim();
  const first = (src: string, ...names: string[]): string => {
    for (const name of names) {
      const v = text(elements(src, name, 1)[0]?.inner);
      if (v) return v;
    }
    return "";
  };

  // Root element decides the format; anything else is not a feed.
  const root = rootName(masked);
  const localRoot = root?.split(":").pop();

  if (root === "rss" || root === "rdf:RDF") {
    const channel = elements(masked, "channel", 1)[0]?.inner ?? "";
    const meta = without(channel, ["item", "image", "textinput", "textInput"]);
    const items = elements(masked, "item").map(({ inner }) => {
      let link = first(inner, "link");
      if (!link) {
        const guid = elements(inner, "guid", 1)[0];
        const g = text(guid?.inner);
        if (
          /^https?:\/\//i.test(g) &&
          attr(guid.attrs, "isPermaLink") !== "false"
        ) {
          link = g;
        }
      }
      return {
        title: first(inner, "title"),
        link,
        pubDate: first(inner, "pubDate", "dc:date"),
        description: first(inner, "description", "content:encoded"),
        author: first(inner, "author", "dc:creator"),
      };
    });
    return {
      format: "rss",
      title: first(meta, "title"),
      description: first(meta, "description"),
      link: first(meta, "link"),
      items,
    };
  }

  if (localRoot === "feed" && root) {
    // Atom elements may be prefixed (`atom:entry`) when the root is.
    const p = root.includes(":") ? `${root.split(":")[0]}:` : "";
    const altLink = (src: string): string => {
      const links = elements(src, `${p}link`);
      const alt =
        links.find((l) => {
          const rel = attr(l.attrs, "rel");
          return rel === undefined || rel === "alternate";
        }) ?? links[0];
      return alt ? (attr(alt.attrs, "href") ?? text(alt.inner)) : "";
    };
    const meta = without(masked, [`${p}entry`]);
    const items = elements(masked, `${p}entry`).map(({ inner }) => {
      const author = elements(inner, `${p}author`, 1)[0];
      return {
        title: first(inner, `${p}title`),
        link: altLink(without(inner, [`${p}source`])),
        pubDate: first(inner, `${p}published`, `${p}updated`),
        description: first(inner, `${p}summary`, `${p}content`),
        author: author
          ? first(author.inner, `${p}name`) || text(author.inner)
          : "",
      };
    });
    return {
      format: "atom",
      title: first(meta, `${p}title`),
      description: first(meta, `${p}subtitle`),
      link: altLink(meta),
      items,
    };
  }

  return null;
}
