# Jarvis SEO capability — findings for a future step-up (2026-09-23)

**Status:** reference only. No work is scheduled. This file exists so that, if
the operator starts an SEO push, the next session begins from measured facts
instead of re-reviewing. Source review: `every-app/open-seo` v0.1.9 (tip
`0ffff93`, 2026-09-19), compared against Jarvis `src/tools/builtin/seo-*`.

## 1. Verdict on 2026-09-23

Nothing adopted, nothing changed. Jarvis's SEO tools have no demand today (see §3). Two routes were rejected:

- **Running open-seo or its MCP:** this needs a second paid vendor (DataForSEO) and an exception to the 2026-09-15 Claude-only ruling.
- **Porting its skills:** this would only improve tools that nobody calls.

Per the 2026-09-18 ruling, unused tools are **not** removed.

**Reopen trigger:** the operator names a site (e.g. trustr.mx,
thewilliamsradar.com, gilda.mx) and asks for search growth or rank monitoring.

## 2. What Jarvis has today

All tools in the `seo` scope group (`SEO_TOOLS` in `src/messaging/scope.ts`):

| Tool | Data source | Limitation |
| --- | --- | --- |
| `seo_page_audit` | `web_read` (Jina, stealth fallback). 0–100 rubric, writes `seo_audits` | One URL at a time; no crawl, link graph or duplicates |
| `seo_keyword_research` | `web_search` SERP titles → LLM extraction, intent, GEO flag, clusters | **No search volume, difficulty or CPC.** Candidates are inferred, not measured |
| `seo_content_brief`, `seo_meta_generate`, `seo_schema_generate`, `seo_llms_txt_generate` | LLM + `seo-references/` (E-E-A-T, GEO signals, intent taxonomy, meta formulas, schema templates) | Generation only. open-seo has no equivalent, so this is our strength |
| `seo_robots_audit` | `safeFetch` of robots.txt; AI-bot rules | Single file |
| `seo_telemetry` | PageSpeed Insights (`GOOGLE_PAGESPEED_KEY`) + Search Console via `google/auth.js` `getAccessToken()` | 28-day window per call. Only 3 snapshots stored, so there is no history |
| `ai_overview_track` | Stealth-browser SERP fetch; AI Overview detection + top-10 organic | Point-in-time; not scheduled |
| `ads_audit` (ads group) | — | — |

**Missing entirely:**

- search volume and keyword difficulty
- rank tracking over time
- backlinks and referring domains
- competitor and domain overview
- a site-wide crawl audit
- local SEO (Maps, business listings)
- LLM-mention visibility

## 3. Measured demand (mc.db, read-only, 2026-09-23)

`task_trace_events` only goes back about 30 days (earliest row 2026-08-24). For a longer horizon use `scope_telemetry`, which starts 2026-06-25.

- **Tool calls, last 30 days:** 0 calls to any `seo_*` tool or `ads_audit` (1,559 turns in the window).
- **Tool calls, since 2026-06-25:** 2 turns called an SEO or ads tool (both in August), out of 3,706 turns. 7 turns called a WordPress tool.
- **Scope activation:** the `seo` group was active on 59 turns in the last 30 days, but only on turns that switched on every group. That is broad-turn scoping, not SEO demand.
- **Stored rows, all time:** `seo_audits` 20 (2026-04-29 → 2026-08-14), `seo_telemetry_snapshots` 3, `ai_overview_tracking` 2.

Re-run these counts before acting on this file. If demand has appeared, the
numbers above are stale.

## 4. What open-seo offers

TanStack Start app on Cloudflare D1 or Postgres. It can be self-hosted (Docker or Cloudflare) or used hosted at $10/mo; the hosted plan adds a 28% markup on DataForSEO calls. **Every data feature is DataForSEO.** New DataForSEO accounts get $1 of free credit, and the minimum top-up is $50. Verify per-call prices on dataforseo.com before quoting a budget.

### DataForSEO endpoints it uses (from `src/server/lib/dataforseo/`)

| Need | Endpoint |
| --- | --- |
| Search volume | `/v3/keywords_data/google_ads/search_volume/live`, `.../keywords_for_keywords/live` |
| Keyword metrics / ideas | `/v3/dataforseo_labs/google/keyword_overview/live`, `keyword_ideas`, `keyword_suggestions`, `related_keywords` |
| Live SERP (rank checks) | `/v3/serp/google/organic/live/advanced` (+ `task_post` for batches) |
| What a domain ranks for | `/v3/dataforseo_labs/google/ranked_keywords/live`, `relevant_pages`, `domain_rank_overview` |
| Competitors | `/v3/dataforseo_labs/google/serp_competitors/live` |
| Backlinks | `/v3/backlinks/summary/live`, `backlinks`, `referring_domains`, `history`, `domain_pages_summary` |
| Local | `/v3/serp/google/maps/live/advanced`, `local_finder`, `/v3/business_data/google/*` |
| AI visibility | `/v3/ai_optimization/llm_mentions/*` |
| Lighthouse | `/v3/on_page/lighthouse/live/json` (Jarvis already has PageSpeed for free) |

### MCP server

About 25 tools in `src/server/mcp/tools/`: projects, keyword research and saved keywords, SERP, domain overview, backlinks, rank-tracker CRUD and runs, Search Console, GA4, local SEO, reports, site audit.

### Skills

`plugins/openseo/skills/`: 10 skills, 1,296 lines — `seo-audit`, `seo-report`, `keyword-research`, `keyword-clustering`, `competitor-analysis`, `competitive-landscape`, `link-prospecting`, `local-seo`, `seo-coach`, `seo-project-setup`.

**Evidence rules worth porting into `seo-references/`** (from `seo-audit`):

1. **Every ranking claim needs a live SERP check made during this task.** Record the query, country, language and date, how many organic results came back, and the matching URL.
2. **Count organic listings yourself.** A provider `rank` counts every result block. Report positions as "#11 (page 2)".
3. **A failed lookup is "unknown", not "not ranked".** A page that doesn't appear is reported as "not in the first 20 results", never as "does not rank".
4. **One snapshot is not a baseline.** When two same-day checks disagree, report both; that is variation, not a trend.
5. **Provider traffic and keyword counts are estimates**, not measured visits. Search Console is first-party; missing Search Console access is a coverage gap, not a blocker.
6. **Shortlist 5–10 opportunities across at least 3 kinds before recommending 1–3.** The kinds are: an underperforming page, demand with no page, and a winning page to protect.
7. **Read at least two pages per page family** (the best and a typical one) and compare them with the leading results for the target query.

### Their own site-audit research

`docs/site-audit-pm-research.md` in their repo is the most reusable artifact, and it is candid. It says their audit is "a crawler and a Lighthouse integration, but not an audit product" (no rule engine yet). The lessons carry over to any crawler we would build:

- **About 6 check families carry the value, not 300:**
  - broken internal links and redirect chains
  - duplicate titles and descriptions (a group-by is the workhorse; body hashes catch only mirrors)
  - title/meta length, H1 and heading order
  - canonical and indexability, including the `X-Robots-Tag` and `Link: rel=canonical` **header** fallbacks
  - orphan pages
  - thin content and crawl depth
- **Validate EVERY discovered URL against SSRF**, not just the start URL (their open gap). For us: `validateOutboundUrl`/`safeFetch` from `src/lib/url-safety.ts` on every enqueue.
- **Seed from the sitemap LAST.** Seeding it first eats the page budget before link discovery finishes.
- **Report orphans only when the crawl completed.** On a truncated crawl, nearly every page lacks observed inlinks.
- **Report a broken link only for targets actually fetched** or HEAD-checked.
- **Fetch with `redirect: "manual"`** and record each hop.
- **Detect client-rendered shells** (near-empty body plus a heavy script payload). Flag "HTML checks incomplete" instead of reporting false missing-title or thin-content issues.
- **Datacenter IPs get bot-blocked.** Budget for block detection from day 1.
- **Reference implementations for thresholds:** SEOnaut, LibreCrawl.

## 5. If the trigger fires — recommended order

Operator rulings needed first:

- **(R1)** A second paid vendor (DataForSEO) under the Claude-only ruling.
- **(R2)** A $50 top-up and a monthly cap.
- **(R3)** Which site or sites are in scope.

1. **Data first.** The real gap is measured demand and rank history, not more
   generation. Write a direct TypeScript DataForSEO client for the ~5 endpoints
   that matter:
   - `search_volume`
   - `keyword_overview`
   - `serp/google/organic/live/advanced`
   - `ranked_keywords`
   - `backlinks/summary`

   Log cost per call. Prefer this over wiring open-seo's MCP: no new service, no 28% hosted markup, and no third party holding the operator's project data. It also follows the TS-runtime principle. Re-evaluate the MCP only if more than about 10 endpoints are needed.
2. **Give `seo_keyword_research` real numbers.** Keep the LLM clustering and intent layer (our strength); attach volume and difficulty from step 1 instead of inferred candidates.
3. **Rank tracking.** A scheduled SERP check per (site, keyword, locale) through the existing scheduler, plus a history table. Apply evidence rules 1–4 in the tool output itself, not only in prompts.
4. **Evidence rules** → a new `seo-references/evidence-rules.ts`, consumed by the audit and report paths.
5. **Site-wide crawl** — only if a named site needs it. Extend `seo_page_audit` with a bounded BFS crawl and the 6 check families. Build in the lessons in §4 (SSRF per URL, sitemap-last, completed-crawl orphans, manual redirects, shell detection).

Do not build: 300-check parity, E-E-A-T scoring beyond the existing reference, crawl visualizations, or GA4 (no consumer).

## 6. Bookmarked, not needed

- open-seo's hosted UI.
- Its rank-tracking billing and cost profiles (`scripts/*-cost-profile.ts`).
- Local SEO and business listings: only relevant if gilda.mx salons come back (0 active today).
- LLM-mention visibility (`ai_optimization/llm_mentions`): `ai_overview_track` covers the Google side for free.
