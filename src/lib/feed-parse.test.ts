/**
 * Tests for the local RSS / Atom parser that replaced the rss2json proxy.
 */

import { describe, it, expect } from "vitest";
import { parseFeed, decodeEntities, decodeFeedBody } from "./feed-parse.js";

// Trimmed from the live Google News search feed (2026-09-25): the real
// channel preamble + 2 items, article ids shortened.
const GOOGLE_NEWS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><generator>NFE/5.0</generator><title>"breaking OR crisis OR emergency" - Google News</title><link>https://news.google.com/search?q=breaking+OR+crisis+OR+emergency&amp;hl=en-US&amp;gl=US&amp;ceid=US:en</link><language>en-US</language><webMaster>news-webmaster@google.com</webMaster><lastBuildDate>Fri, 25 Sep 2026 18:10:28 GMT</lastBuildDate><image><title>Google News</title><url>https://lh3.googleusercontent.com/-DR60l-K8vnyi99NZovm9HlXyZwQ85GMDxiwJWzoasZYCUrPuUM_P_4Rb7ei03j-0nRs0c4F=w256</url><link>https://news.google.com/</link><height>256</height><width>256</width></image><description>Google News</description><item><title>Fall Related Emergency Visits for Older Adults Continue to Climb - countynewscenter.com</title><link>https://news.google.com/rss/articles/CBMinwFBVV95cUxObDNTMW1VT3pC?oc=5</link><guid isPermaLink="false">CBMinwFBVV95cUxObDNTMW1VT3pC</guid><pubDate>Fri, 25 Sep 2026 13:53:48 GMT</pubDate><description>&lt;a href="https://news.google.com/rss/articles/CBMinwFBVV95cUxObDNTMW1VT3pC?oc=5" target="_blank"&gt;Fall Related Emergency Visits for Older Adults Continue to Climb&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;countynewscenter.com&lt;/font&gt;</description><source url="https://www.countynewscenter.com">countynewscenter.com</source></item><item><title>Ketanji Brown Jackson criticizes supreme court’s handling of emergency docket - The Guardian</title><link>https://news.google.com/rss/articles/CBMiogFBVV95cUxQZ3MtNXd1?oc=5</link><guid isPermaLink="false">CBMiogFBVV95cUxQZ3MtNXd1</guid><pubDate>Fri, 25 Sep 2026 16:11:00 GMT</pubDate><description>&lt;a href="https://news.google.com/rss/articles/CBMiogFBVV95cUxQZ3MtNXd1?oc=5" target="_blank"&gt;Ketanji Brown Jackson criticizes supreme court’s handling of emergency docket&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;The Guardian&lt;/font&gt;</description><source url="https://www.theguardian.com">The Guardian</source></item></channel></rss>`;

// Shape of the GitHub releases Atom feed.
const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-US">
  <id>tag:github.com,2008:https://github.com/nodejs/node/releases</id>
  <link type="application/atom+xml" rel="self" href="https://github.com/nodejs/node/releases.atom"/>
  <link type="text/html" rel="alternate" href="https://github.com/nodejs/node/releases"/>
  <title>Release notes from node</title>
  <subtitle>Node.js releases</subtitle>
  <updated>2026-09-23T16:53:01Z</updated>
  <entry>
    <id>tag:github.com,2008:Repository/27193779/v22.23.3</id>
    <updated>2026-09-23T18:21:37Z</updated>
    <link rel="self" href="https://example.com/self"/>
    <link rel="alternate" type="text/html" href="https://github.com/nodejs/node/releases/tag/v22.23.3"/>
    <title>2026-09-23, Version 22.23.3 &#39;Jod&#39; (LTS)</title>
    <content type="html">&lt;h3&gt;Notable Changes&lt;/h3&gt;</content>
    <author><name>aduh95</name></author>
  </entry>
  <entry>
    <published>2026-09-20T10:00:00Z</published>
    <updated>2026-09-21T10:00:00Z</updated>
    <link href="https://github.com/nodejs/node/releases/tag/v24.0.0"></link>
    <title type="html">Version &amp;lt;24&amp;gt;</title>
    <summary>Short summary</summary>
    <content type="html">Long content</content>
  </entry>
</feed>`;

const CDATA_RSS = `<?xml version="1.0"?>
<!-- a comment with <item> inside -->
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title><![CDATA[BBC News]]></title>
    <description><![CDATA[BBC News - News Front Page]]></description>
    <link>https://www.bbc.co.uk/news</link>
    <item>
      <title><![CDATA[Tom & Jerry <b>return</b>]]></title>
      <link>https://example.com/a?x=1&amp;y=2</link>
      <dc:creator><![CDATA[Jane Doe]]></dc:creator>
      <pubDate>Fri, 25 Sep 2026 10:00:00 +0200</pubDate>
      <content:encoded><![CDATA[<p>Body with </item> and <title>fake</title></p>]]></content:encoded>
    </item>
    <item>
      <title>It&#x27;s &quot;quoted&quot; &amp; &#8364;5 &lt;tag&gt; &amp;lt;kept&amp;gt;</title>
      <guid>https://example.com/b</guid>
      <description>Mixed <![CDATA[<i>raw &amp;</i>]]> and &amp;</description>
      <enclosure url="https://example.com/b.mp3" length="1" type="audio/mpeg"/>
    </item>
  </channel>
</rss>`;

describe("parseFeed — RSS 2.0", () => {
  it("parses a real Google News search feed", () => {
    const feed = parseFeed(GOOGLE_NEWS);
    expect(feed).not.toBeNull();
    expect(feed!.format).toBe("rss");
    // channel title, not the <image><title>
    expect(feed!.title).toBe('"breaking OR crisis OR emergency" - Google News');
    expect(feed!.link).toBe(
      "https://news.google.com/search?q=breaking+OR+crisis+OR+emergency&hl=en-US&gl=US&ceid=US:en",
    );
    expect(feed!.description).toBe("Google News");
    expect(feed!.items).toHaveLength(2);
    expect(feed!.items[0]).toEqual({
      title:
        "Fall Related Emergency Visits for Older Adults Continue to Climb - countynewscenter.com",
      link: "https://news.google.com/rss/articles/CBMinwFBVV95cUxObDNTMW1VT3pC?oc=5",
      pubDate: "Fri, 25 Sep 2026 13:53:48 GMT",
      description:
        '<a href="https://news.google.com/rss/articles/CBMinwFBVV95cUxObDNTMW1VT3pC?oc=5" target="_blank">Fall Related Emergency Visits for Older Adults Continue to Climb</a>&nbsp;&nbsp;<font color="#6f6f6f">countynewscenter.com</font>',
      author: "",
    });
    expect(feed!.items[1].title).toContain("supreme court’s handling");
  });

  it("handles CDATA, namespaced tags, comments and markup inside CDATA", () => {
    const feed = parseFeed(CDATA_RSS)!;
    expect(feed.title).toBe("BBC News");
    expect(feed.description).toBe("BBC News - News Front Page");
    expect(feed.link).toBe("https://www.bbc.co.uk/news");
    expect(feed.items).toHaveLength(2);
    const [a, b] = feed.items;
    expect(a.title).toBe("Tom & Jerry <b>return</b>");
    expect(a.link).toBe("https://example.com/a?x=1&y=2");
    expect(a.author).toBe("Jane Doe");
    expect(a.pubDate).toBe("Fri, 25 Sep 2026 10:00:00 +0200");
    // content:encoded is the description fallback; the </item> inside CDATA
    // must not end the item
    expect(a.description).toBe(
      "<p>Body with </item> and <title>fake</title></p>",
    );
    expect(b.title).toBe(`It's "quoted" & €5 <tag> &lt;kept&gt;`);
    // permalink guid stands in for a missing <link>
    expect(b.link).toBe("https://example.com/b");
    // entities decoded outside CDATA only
    expect(b.description).toBe("Mixed <i>raw &amp;</i> and &");
  });

  it("parses RSS 1.0 (RDF) items that sit beside the channel", () => {
    const feed = parseFeed(
      `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel rdf:about="x"><title>RDF feed</title><link>https://example.org</link></channel><item rdf:about="https://example.org/1"><title>One</title><link>https://example.org/1</link><dc:date>2026-09-01T00:00:00Z</dc:date></item></rdf:RDF>`,
    )!;
    expect(feed.format).toBe("rss");
    expect(feed.title).toBe("RDF feed");
    expect(feed.items).toEqual([
      {
        title: "One",
        link: "https://example.org/1",
        pubDate: "2026-09-01T00:00:00Z",
        description: "",
        author: "",
      },
    ]);
  });

  it("returns an empty item list for a feed with no items", () => {
    const feed = parseFeed(
      `<rss version="2.0"><channel><title>Empty</title></channel></rss>`,
    );
    expect(feed).toEqual({
      format: "rss",
      title: "Empty",
      description: "",
      link: "",
      items: [],
    });
  });

  it("keeps the complete items of a truncated document", () => {
    const cut = GOOGLE_NEWS.slice(0, GOOGLE_NEWS.lastIndexOf("<item>") + 40);
    const feed = parseFeed(cut)!;
    expect(feed.items).toHaveLength(1);
  });
});

describe("parseFeed — Atom", () => {
  it("parses feed and entries, preferring the alternate link", () => {
    const feed = parseFeed(ATOM)!;
    expect(feed.format).toBe("atom");
    expect(feed.title).toBe("Release notes from node");
    expect(feed.description).toBe("Node.js releases");
    expect(feed.link).toBe("https://github.com/nodejs/node/releases");
    expect(feed.items).toHaveLength(2);
    expect(feed.items[0]).toEqual({
      title: "2026-09-23, Version 22.23.3 'Jod' (LTS)",
      link: "https://github.com/nodejs/node/releases/tag/v22.23.3",
      pubDate: "2026-09-23T18:21:37Z",
      description: "<h3>Notable Changes</h3>",
      author: "aduh95",
    });
    // no-rel link, published over updated, summary over content
    expect(feed.items[1]).toEqual({
      title: "Version &lt;24&gt;",
      link: "https://github.com/nodejs/node/releases/tag/v24.0.0",
      pubDate: "2026-09-20T10:00:00Z",
      description: "Short summary",
      author: "",
    });
  });

  it("handles a prefixed Atom namespace", () => {
    const feed = parseFeed(
      `<atom:feed xmlns:atom="http://www.w3.org/2005/Atom"><atom:title>P</atom:title><atom:entry><atom:title>E</atom:title><atom:link href="https://e.x/1"/></atom:entry></atom:feed>`,
    )!;
    expect(feed.title).toBe("P");
    expect(feed.items[0].title).toBe("E");
    expect(feed.items[0].link).toBe("https://e.x/1");
  });
});

describe("parseFeed — not a feed", () => {
  it("returns null for an HTML page", () => {
    expect(
      parseFeed(
        `<!DOCTYPE html>\n<html><head><title>News</title></head><body><item>x</item><rss></rss></body></html>`,
      ),
    ).toBeNull();
  });

  it("returns null for JSON (e.g. an API error body)", () => {
    expect(
      parseFeed(`{"status":"error","message":"Cannot download this RSS feed"}`),
    ).toBeNull();
  });

  it("returns null for garbage and empty input, never throws", () => {
    for (const junk of [
      "",
      "garbage",
      "<<<>>>",
      "\u0000\u00001\u0000",
      "<rss",
      "<![CDATA[",
      "<feed><entry><title>",
    ]) {
      expect(() => parseFeed(junk)).not.toThrow();
    }
    expect(parseFeed("")).toBeNull();
    expect(parseFeed("garbage")).toBeNull();
    expect(parseFeed("<<<>>>")).toBeNull();
    expect(parseFeed(undefined as unknown as string)).toBeNull();
  });
});

describe("decodeEntities", () => {
  it("decodes the XML five and numeric entities in one pass", () => {
    expect(decodeEntities("&lt;&gt;&amp;&quot;&apos;&#39;&#x27;&#X41;")).toBe(
      `<>&"'''A`,
    );
    expect(decodeEntities("&amp;lt;")).toBe("&lt;");
  });

  it("leaves unknown and invalid entities alone", () => {
    expect(decodeEntities("&nbsp; &#0; &#x110000; &bogus;")).toBe(
      "&nbsp; &#0; &#x110000; &bogus;",
    );
  });

  it("matches named entities case-sensitively, hex references in any case", () => {
    expect(decodeEntities("&Amp; &LT; &QUOT; &amp;")).toBe(
      "&Amp; &LT; &QUOT; &",
    );
    expect(decodeEntities("&#X41;&#x4a;&#xaB;&#XAb;")).toBe("AJ««");
  });

  it("does not decode surrogate code points into lone surrogates", () => {
    expect(decodeEntities("&#xD800;&#55296;&#xDFFF;&#x1F600;")).toBe(
      "&#xD800;&#55296;&#xDFFF;\u{1F600}",
    );
  });
});

describe("parseFeed — NUL bytes in the input", () => {
  it("never lets literal placeholder text pull in a CDATA block", () => {
    const feed = parseFeed(
      `<rss><channel><item><title>A \u00000\u0000 B</title><description><![CDATA[secret]]></description></item></channel></rss>`,
    )!;
    expect(feed.items[0].title).toBe("A 0 B");
    expect(feed.items[0].description).toBe("secret");
  });
});

describe("decodeFeedBody", () => {
  const latin1 = (s: string) => Uint8Array.from(Buffer.from(s, "latin1"));

  it("decodes by the Content-Type charset", () => {
    expect(
      decodeFeedBody(latin1("<rss>Café</rss>"), "text/xml; charset=iso-8859-1"),
    ).toBe("<rss>Café</rss>");
  });

  it("falls back to the XML declaration's encoding", () => {
    expect(
      decodeFeedBody(
        latin1(`<?xml version="1.0" encoding='ISO-8859-1'?><rss>España</rss>`),
        "application/rss+xml",
      ),
    ).toBe(`<?xml version="1.0" encoding='ISO-8859-1'?><rss>España</rss>`);
  });

  it("lets the header win over the declaration, and skips unknown labels", () => {
    const utf8 = new TextEncoder().encode(
      `<?xml version="1.0" encoding="ISO-8859-1"?><rss>ñ</rss>`,
    );
    expect(decodeFeedBody(utf8, 'text/xml; charset="utf-8"')).toContain("ñ");
    expect(
      decodeFeedBody(latin1("<rss>ñ</rss>"), "text/xml; charset=x-bogus"),
    ).toBe("<rss>\ufffd</rss>");
  });

  it("lets a byte-order mark win over a contradicting header and declaration", () => {
    const xml = `<?xml version="1.0" encoding="ISO-8859-1"?><rss><channel><item><title>Año ñ</title></item></channel></rss>`;
    const utf8Bom = Uint8Array.from([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode(xml),
    ]);
    const decoded = decodeFeedBody(utf8Bom, "text/xml; charset=ISO-8859-1");
    expect(decoded).toBe(xml);
    expect(parseFeed(decoded)!.items[0].title).toBe("Año ñ");

    const utf16le = Uint8Array.from(Buffer.from("\ufeff" + xml, "utf16le"));
    const decoded16 = decodeFeedBody(utf16le, "text/xml; charset=utf-8");
    expect(decoded16).toBe(xml);
    expect(parseFeed(decoded16)!.items[0].title).toBe("Año ñ");

    const utf16be = Uint8Array.from(
      Buffer.from("\ufeff" + xml, "utf16le").swap16(),
    );
    expect(decodeFeedBody(utf16be)).toBe(xml);
  });

  it("defaults to UTF-8", () => {
    expect(decodeFeedBody(new TextEncoder().encode("<rss>ñ</rss>"))).toBe(
      "<rss>ñ</rss>",
    );
  });
});

// qa B1: lazy-regex spans retried from every unclosed opener (quadratic).
// Each shape is sized so the OLD parser takes seconds — a regression fails
// red in bounded time instead of hanging CI — while the indexOf scans stay
// far under BOUND_MS. Measured 2026-09-25 on the VPS (tsx), old → new:
//   unclosed CDATA        600 KB  5.4 s → 3 ms
//   unclosed comment      300 KB  7.6 s → 3 ms
//   unclosed <item x>     280 KB  2.4 s → 3 ms (a continue-not-break
//                         mutant in elements(): 7.6 s)
//   <item with no >       250 KB  5.4 s → 1 ms
//   unclosed <entry>      300 KB  5.4 s → 3 ms
//   <entry><link/> x N    700 KB  4.7 s → 15 ms
// The last four shapes were linear in the old code too (guards, 500 KB).
// 300 ms is 20x the slowest new time and 8x under the fastest old one.
describe("parseFeed — adversarial input stays linear", () => {
  const BOUND_MS = 300;
  const rep = (kb: number, prefix: string, unit: string, suffix = "") =>
    prefix +
    unit.repeat(
      Math.floor((kb * 1024 - prefix.length - suffix.length) / unit.length),
    ) +
    suffix;
  const SHAPES: Record<string, string> = {
    "unclosed CDATA": rep(600, "<rss><channel>", "<![CDATA[x"),
    "unclosed comment": rep(300, "<rss><channel>", "<!--x"),
    "unclosed <item x>": rep(
      280,
      "<rss><channel>",
      "<item x>",
      "</channel></rss>",
    ),
    "<item with no >": rep(250, "<rss><channel>", '<item a="b" '),
    "unclosed <entry>": rep(300, "<feed>", "<entry>"),
    "repeated <entry><link/>": rep(700, "<feed>", '<entry><link href="x"/>'),
    "close-tag lookalikes": rep(500, "<rss><channel><item>", "</item "),
    "unclosed declarations": rep(500, "", "<?x "),
    "unclosed DOCTYPE": rep(500, "", "<!DOCTYPE "),
    "long numeric entity": rep(500, "<rss><channel><title>&#", "1", "</title>"),
  };

  for (const [name, doc] of Object.entries(SHAPES)) {
    it(`${name} (${Math.round(doc.length / 1024)} KB) parses in bounded time`, () => {
      const t = performance.now();
      expect(() => parseFeed(doc)).not.toThrow();
      expect(performance.now() - t).toBeLessThan(BOUND_MS);
    });
  }

  // Real-cap guard: a valid 5 MB feed (rss_read's MAX_BYTES). Linear in the
  // old code as well (899 ms old → ~300 ms new), so it cannot hang.
  it("a valid 5 MB feed of 87k items parses in bounded time", () => {
    const doc = rep(
      5 * 1024,
      "<rss><channel>",
      "<item><title>t &amp; u</title><link>https://x/</link></item>",
      "</channel></rss>",
    );
    const t = performance.now();
    expect(parseFeed(doc)!.items).toHaveLength(87_380);
    expect(performance.now() - t).toBeLessThan(3_000);
  }, 30_000);
});
