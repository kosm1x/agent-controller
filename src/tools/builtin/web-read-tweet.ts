/**
 * X/Twitter status reader for web_read.
 *
 * Jina Reader blocks anonymous x.com reads (403 AbuseAlleviationError), so
 * status links are read from api.fxtwitter.com, then the public syndication
 * endpoint. Returns null when both fail so the caller can fall back to Jina.
 */

const TWEET_TIMEOUT_MS = 10_000;

const TWEET_HOSTS = new Set([
  "x.com",
  "twitter.com",
  "mobile.twitter.com",
  "mobile.x.com",
  "fxtwitter.com",
  "vxtwitter.com",
  "fixupx.com",
]);

// /<handle>/status/<id> or /i/web/status/<id>, optional trailing segments
const STATUS_PATH_RE =
  /^\/(?:i\/web|[A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,25})(?:\/|$)/;

interface FxAuthor {
  name?: string;
  screen_name?: string;
}

interface FxTweet {
  url?: string;
  text?: string;
  author?: FxAuthor;
  created_at?: string;
  likes?: number;
  retweets?: number;
  replies?: number;
  views?: number | null;
  replying_to?: string | null;
  quote?: FxTweet;
  media?: { all?: { type?: string; url?: string }[] };
  community_note?: { text?: string } | null;
  article?: {
    title?: string;
    preview_text?: string;
    content?: { blocks?: { type?: string; text?: string }[] };
  };
}

interface SyndicationTweet {
  __typename?: string;
  text?: string;
  created_at?: string;
  favorite_count?: number;
  conversation_count?: number;
  note_tweet?: unknown;
  in_reply_to_screen_name?: string;
  user?: FxAuthor;
  quoted_tweet?: SyndicationTweet;
  mediaDetails?: { media_url_https?: string }[];
}

/** Returns the numeric status id for an X/Twitter status URL, else null. */
export function parseTweetId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!TWEET_HOSTS.has(host)) return null;
  return STATUS_PATH_RE.exec(parsed.pathname)?.[1] ?? null;
}

async function getJson(url: string): Promise<unknown> {
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "AgentController/1.0",
      },
      signal: AbortSignal.timeout(TWEET_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function byline(a: FxAuthor | undefined): string {
  return `**${a?.name ?? "unknown"}** (@${a?.screen_name ?? "unknown"})`;
}

const BLOCK_PREFIX: Record<string, string> = {
  "header-one": "# ",
  "header-two": "## ",
  "header-three": "### ",
  "unordered-list-item": "- ",
  blockquote: "> ",
  "code-block": "    ",
};

/** Renders an X Article (Draft.js blocks) to Markdown. */
function renderArticle(article: NonNullable<FxTweet["article"]>): string {
  const out: string[] = [`## ${article.title ?? "Article"}`];
  const blocks = article.content?.blocks ?? [];
  let n = 0;
  for (const b of blocks) {
    const text = b.text ?? "";
    if (b.type !== "ordered-list-item") n = 0;
    if (b.type === "atomic" || !text.trim()) continue; // embedded media
    const prefix =
      b.type === "ordered-list-item"
        ? `${++n}. `
        : (BLOCK_PREFIX[b.type ?? ""] ?? "");
    out.push(prefix + (prefix ? text.replace(/\n/g, `\n${prefix}`) : text));
  }
  if (blocks.length === 0 && article.preview_text)
    out.push(article.preview_text);
  return out.join("\n\n");
}

function renderFx(t: FxTweet): string {
  const parts = [`${byline(t.author)} · ${t.created_at ?? ""}`, t.url ?? ""];
  if (t.replying_to) parts.push(`Replying to @${t.replying_to}`);
  if (t.text) parts.push(t.text);
  if (t.quote) {
    parts.push(
      `> Quoting ${byline(t.quote.author)}:\n> ${(t.quote.text ?? "").replace(/\n/g, "\n> ")}`,
    );
  }
  if (t.article) parts.push(renderArticle(t.article));
  const media = (t.media?.all ?? []).map((m) => m.url).filter(Boolean);
  if (media.length) parts.push(`Media: ${media.join(" ")}`);
  if (t.community_note?.text)
    parts.push(`Community note: ${t.community_note.text}`);
  parts.push(
    `Likes ${t.likes ?? 0} · Reposts ${t.retweets ?? 0} · Replies ${t.replies ?? 0}` +
      (t.views != null ? ` · Views ${t.views}` : ""),
  );
  return parts.filter(Boolean).join("\n\n");
}

function renderSyndication(t: SyndicationTweet, url: string): string {
  const parts = [`${byline(t.user)} · ${t.created_at ?? ""}`, url];
  if (t.in_reply_to_screen_name)
    parts.push(`Replying to @${t.in_reply_to_screen_name}`);
  parts.push(t.text ?? "");
  if (t.note_tweet) parts.push("_(long post — the source truncates the text)_");
  if (t.quoted_tweet) {
    parts.push(
      `> Quoting ${byline(t.quoted_tweet.user)}:\n> ${(t.quoted_tweet.text ?? "").replace(/\n/g, "\n> ")}`,
    );
  }
  const media = (t.mediaDetails ?? [])
    .map((m) => m.media_url_https)
    .filter(Boolean);
  if (media.length) parts.push(`Media: ${media.join(" ")}`);
  parts.push(
    `Likes ${t.favorite_count ?? 0} · Replies ${t.conversation_count ?? 0}`,
  );
  return parts.filter(Boolean).join("\n\n");
}

/** Reads a tweet by id: fxtwitter first, syndication second; null if both fail. */
export async function readTweet(
  id: string,
): Promise<{ content: string; source: "fxtwitter" | "syndication" } | null> {
  // Third-party JSON: a render throw on an unexpected shape = source failed
  const fx = (await getJson(`https://api.fxtwitter.com/status/${id}`)) as {
    code?: number;
    tweet?: FxTweet;
  } | null;
  if (fx?.code === 200 && typeof fx.tweet?.text === "string") {
    try {
      return { content: renderFx(fx.tweet), source: "fxtwitter" };
    } catch (err) {
      console.log(
        `[web-read] tweet ${id}: fxtwitter render failed (${err instanceof Error ? err.message : String(err)}), trying syndication`,
      );
    }
  }

  const syn = (await getJson(
    `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=a`,
  )) as SyndicationTweet | null;
  if (syn?.__typename === "Tweet" && typeof syn.text === "string") {
    try {
      const handle = syn.user?.screen_name ?? "i/web";
      return {
        content: renderSyndication(syn, `https://x.com/${handle}/status/${id}`),
        source: "syndication",
      };
    } catch (err) {
      console.log(
        `[web-read] tweet ${id}: syndication render failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  console.log(
    `[web-read] tweet ${id}: fxtwitter and syndication failed, falling back to Jina`,
  );
  return null;
}
