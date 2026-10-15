# Functional Requirements — News Feed Module
**Dhoomberg Terminal | FMCG & Supply Chain Intelligence**
*Version 0.1 — October 2026*

---

## Overview

The News Feed Module surfaces commodity-relevant headlines, scheduled report releases, and user-defined alerts in a unified feed. It provides real-time context alongside price and demand signals, enabling procurement and supply-chain teams to act on market-moving events as they happen.

Data flows from three source types:
- **PUBLIC** — free RSS feeds and open APIs, no user action needed beyond optional key registration
- **USER-SUPPLIED** — keyword watchlists and alert thresholds configured by the user
- **CALCULATED** — synthetic feed items derived on-platform from alerts and tagging logic

**Backend architecture:** All external sources are fetched by `research/fetch_news.py`, which writes a static file at `public/news/news.json`. The React front-end reads that file. In production the script runs on a cron schedule. In DEMO_MODE (no API key present) the script uses bundled mock data.

---

## Feature List

---

### F-NEWS-001 — Real-Time Commodity Headlines

**Description:** Live headline feed of commodity-relevant news articles, fetched from Alpha Vantage News & Sentiment API. Each item shows headline, source, publication time, sentiment label, and affected ticker(s). Supports filtering by commodity ticker. Falls back to DEMO_MODE mock data when no API key is configured.

**Data Source:** PUBLIC (key required; DEMO_MODE mock when absent)
| Feed | API / Endpoint | Status |
|---|---|---|
| Alpha Vantage News & Sentiment | `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=CORN,WHEAT&apikey=KEY` | ✅ Live, free key, 25 req/day limit |
| Reuters commodities RSS | Previously free RSS, now requires sign-in | ❌ Unavailable |
| Bloomberg news | No free RSS or public API | ❌ Unavailable |

**Notes:**
- Alpha Vantage ticker symbols for commodities use equity proxy tickers (e.g., `CORN` maps to Teucrium Corn Fund; underlying commodity sentiment is inferred). Validate coverage against the TARGETS list before release.
- 25 req/day at free tier. With polling every ~60 min (24 req/day) this fits within the limit for a single deployment. Multi-user or higher-frequency setups require a paid plan.
- DEMO_MODE: when `ALPHA_VANTAGE_KEY` is absent from environment, `fetch_news.py` writes a static mock payload from `research/mock_data/news_mock.json`. The UI renders identically; a "DEMO DATA" badge is shown in the feed header.

---

### F-NEWS-002 — Scheduled Report Release Calendar

**Description:** Calendar view and feed entries for upcoming scheduled commodity report releases: USDA WASDE, EIA Weekly Petroleum Status Report, CFTC Commitments of Traders (COT), and FAO Food Price Index (FFPI). Each entry shows report name, releasing body, scheduled date/time, and a link to the source. Past releases show the published report link and a headline summary if available.

**Data Source:** PUBLIC (no key required)
| Feed | Source / Endpoint | Status |
|---|---|---|
| USDA WASDE release calendar | `https://www.usda.gov/oce/commodity/wasde/` — dates published on page; parsed manually or scraped | ⚠️ No machine-readable calendar API; release dates must be hard-coded or HTML-scraped |
| EIA Weekly Petroleum Status Report | `https://www.eia.gov/petroleum/supply/weekly/` — released every Wednesday 10:30 ET | ✅ Release schedule is fixed; dates can be generated programmatically |
| CFTC COT report | `https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm` — released every Friday 15:30 ET | ✅ Release schedule is fixed; dates can be generated programmatically |
| FAO Food Price Index (FFPI) | `https://www.fao.org/worldfoodsituation/foodpricesindex/en/` — released monthly (first Friday) | ✅ Release schedule is fixed; dates can be generated programmatically |

**Notes:**
- WASDE is the highest-impact release for agricultural commodities (grains, oilseeds, sugar, cotton). Release dates shift slightly each year and must be sourced from USDA's published release schedule PDF.
- EIA and CFTC follow fixed weekly cadences; the calendar can be generated entirely in code without scraping.
- FAO FFPI covers the five commodity sub-indices: cereals, vegetable oils, dairy, meat, sugar. Relevant to finished FMCG cost modelling.
- Calendar items are written into `public/news/news.json` as type `"calendar"` items, distinguished from headline type `"article"` items.

---

### F-NEWS-003 — RSS Feed Ingestion

**Description:** Ingests three public RSS feeds on each cron run, parses entries into normalized article objects, and merges them into the unified `news.json` feed alongside Alpha Vantage headlines. Each article carries its source label so the UI can filter by feed origin.

**Data Source:** PUBLIC (no key required)
| Feed | RSS Endpoint | Status |
|---|---|---|
| USDA NASS press releases | `https://www.nass.usda.gov/rss/News.xml` | ✅ Live, no key |
| EIA Today In Energy | `https://www.eia.gov/rss/todayinenergy.xml` | ✅ Live, no key |
| CNBC Commodities (metals / energy focus) | `https://www.cnbc.com/id/19832390/device/rss/rss.html` | ✅ Live, no key |
| Reuters commodities RSS | Previously free; now requires account sign-in | ❌ Unavailable |
| Bloomberg RSS | No free RSS feed available | ❌ Unavailable |

**Notes:**
- RSS parsing is handled by `fetch_news.py` using Python's `feedparser` library (no additional key or registration needed).
- CNBC RSS covers metals and energy prominently; agricultural commodity coverage is lighter. Supplement with USDA NASS for agri news.
- EIA Today In Energy publishes daily analytical articles on energy markets — useful for crude, natural gas, and power price context.
- Deduplication: items already present in `news.json` (matched on URL or GUID) are not re-inserted on subsequent cron runs.

---

### F-NEWS-004 — News-to-Commodity Tagging

**Description:** Each ingested article (from Alpha Vantage, RSS, or synthetic sources) is tagged with one or more commodity IDs from the TARGETS list. Tags drive filtering in the feed UI and link news items to the relevant commodity's Price Module view. Tagging runs as a post-processing step in `fetch_news.py`.

**Data Source:** CALCULATED (keyword matching over article title and summary)

**Tagging logic (v0.1 — keyword dictionary):**
| Commodity ID | Keywords matched (case-insensitive, partial) |
|---|---|
| BRENT | brent, north sea, ipo crude |
| WTI | wti, west texas, crude oil, opec |
| GOLD | gold, bullion, xau |
| WHEAT | wheat, gluten, flour |
| MAIZE | maize, corn, feed grain |
| SUGAR | sugar, sucrose, cane |
| COPPER | copper, xcu, red metal |
| PALM\_OIL | palm oil, cpo, palm kernel |
| SOYBEAN | soybean, soy, soymeal, soyoil |
| NATURAL\_GAS | natural gas, lng, henry hub |

**Notes:**
- Multiple commodity IDs may be assigned to a single article.
- Articles with no keyword match are tagged `GENERAL` and remain visible in the unfiltered feed.
- A future ML-based tagger (v0.2) should replace the keyword dictionary; validate out-of-sample before deploying per project ML rigor guidelines.

---

### F-NEWS-005 — Sentiment Scoring

**Description:** Displays a sentiment label and score alongside each headline sourced from Alpha Vantage. Alpha Vantage returns a `overall_sentiment_label` (Bullish / Somewhat-Bullish / Neutral / Somewhat-Bearish / Bearish) and a numeric `overall_sentiment_score` per article. The UI renders a colour-coded badge (green / grey / red) next to each headline.

**Data Source:** PUBLIC — provided directly by Alpha Vantage News & Sentiment API response payload

| Field | Alpha Vantage key | Example value |
|---|---|---|
| Sentiment label | `overall_sentiment_label` | `"Bullish"` |
| Sentiment score | `overall_sentiment_score` | `0.312` |
| Ticker-level sentiment | `ticker_sentiment[].ticker_sentiment_label` | `"Somewhat-Bullish"` |

**Notes:**
- Sentiment scores are Alpha Vantage's own model output; Dhoomberg does not re-score. Display only, with a tooltip noting the source.
- RSS-sourced articles (F-NEWS-003) do not carry sentiment scores. Show a `—` badge for those items.
- Do not assert predictive accuracy of sentiment scores in the UI; label them "Source: Alpha Vantage" per project ML rigor guidelines.

---

### F-NEWS-006 — Alert-Linked Synthetic Headlines

**Description:** When a platform alert fires (price threshold crossed or demand alert triggered), a synthetic news item is injected into the feed with the alert detail, timestamp, and affected commodity. This ensures the feed acts as a single chronological record of both external events and internal signals.

**Data Source:** CALCULATED — generated by the alert engine, not fetched from an external source

**Synthetic item schema:**
| Field | Value |
|---|---|
| `type` | `"alert"` |
| `source` | `"Dhoomberg Alert"` |
| `title` | e.g., `"WHEAT price crossed ₹2,800/MT threshold (↑3.2%)"` |
| `commodity_tags` | e.g., `["WHEAT"]` |
| `sentiment_label` | `null` — not applicable |
| `timestamp` | ISO 8601 UTC of alert fire time |
| `alert_id` | Reference to the originating alert record |

**Notes:**
- Alert items are visually distinguished in the feed (icon, border colour) so users can scan at a glance.
- Alert items are written directly into `news.json` by the alert engine, not by `fetch_news.py`.
- Synthetic items must not be overwritten on subsequent cron runs of `fetch_news.py`; the merge logic must preserve items with `type == "alert"`.

---

### F-NEWS-007 — User-Configurable Keyword Filters

**Description:** Users can add and remove keyword watch terms (e.g., "India", "Brent", "palm oil", "El Niño") to filter the news feed. When a keyword filter is active, only articles whose title or summary contains at least one active keyword are shown. Multiple keywords are OR-combined. Keyword list persists in user preferences.

**Data Source:** USER-SUPPLIED (keyword list stored in user preferences)

**UI behaviour:**
| Interaction | Result |
|---|---|
| Add keyword | Appended to active filter list; feed re-filters immediately |
| Remove keyword | Removed from list; feed re-filters immediately |
| Clear all | All items shown; no active filter |
| Keyword pill badge count | Shows number of matching articles in current feed window |

**Notes:**
- Keyword matching is client-side (applied to already-loaded `news.json` content) — no additional API calls needed.
- Keywords are stored in `localStorage` under `dhoomberg.newsKeywords` and restored on page load.
- Keyword matching is case-insensitive and matches partial words (e.g., "palm" matches "palm oil", "palm kernel").
- A maximum of 20 active keyword filters is enforced to prevent UI clutter.

---

## API Status Summary

| API / Feed | Key Required | Cost | Daily Limit | Tested Status | Recommended Use |
|---|---|---|---|---|---|
| Alpha Vantage News & Sentiment | Yes (free registration) | Free | 25 req/day | ⚠️ Untested — key needed | Real-time headlines + sentiment (F-NEWS-001, F-NEWS-005) |
| USDA NASS RSS | No | Free | Unlimited | ✅ Live | Agricultural press releases (F-NEWS-003) |
| EIA Today In Energy RSS | No | Free | Unlimited | ✅ Live | Energy market articles (F-NEWS-003) |
| CNBC Commodities RSS | No | Free | Unlimited | ✅ Live | Metals and energy headlines (F-NEWS-003) |
| Reuters commodities RSS | Requires sign-in | Free account | — | ❌ Unavailable | Not usable — sign-in wall |
| Bloomberg news | No free tier | Paid | — | ❌ Unavailable | Not usable |
| USDA WASDE calendar | No | Free | — | ⚠️ No API — HTML scrape / manual | Report release dates (F-NEWS-002) |
| EIA weekly report schedule | No | Free | — | ✅ Fixed cadence — generatable | Report release dates (F-NEWS-002) |
| CFTC COT schedule | No | Free | — | ✅ Fixed cadence — generatable | Report release dates (F-NEWS-002) |
| FAO FFPI schedule | No | Free | — | ✅ Fixed cadence — generatable | Report release dates (F-NEWS-002) |

---

## Data Integration Architecture

```
[Alpha Vantage News API] ─────────────────────┐
[USDA NASS RSS] ──────────────────────────────┤
[EIA Today In Energy RSS] ────────────────────► [research/fetch_news.py]
[CNBC Commodities RSS] ───────────────────────┤       (cron job)
[WASDE / EIA / CFTC / FAO calendars] ─────────┘
                                                        │
[Alert Engine] ──────────────────────────────────────── ┤  (synthetic items)
                                                        │
                                                        ▼
                                               [public/news/news.json]
                                                        │
                                                        ▼
                                          [React News Feed Component]
                                                        │
                                     ┌──────────────────┼──────────────────┐
                                     ▼                  ▼                  ▼
                              [Headline Feed]   [Report Calendar]   [Alert Feed]
                              (F-NEWS-001/003)   (F-NEWS-002)       (F-NEWS-006)
```

**DEMO_MODE flag:**
When `ALPHA_VANTAGE_KEY` is absent, `fetch_news.py` copies `research/mock_data/news_mock.json` to `public/news/news.json` unchanged. All other sources (RSS, calendar) are still fetched live unless `DEMO_MODE=true` is set explicitly, in which case mock data is used for all sources.

---

## Open Items

- [ ] Register Alpha Vantage free API key and test `NEWS_SENTIMENT` endpoint with commodity tickers (CORN, WHEAT, NG, etc.)
- [ ] Confirm Alpha Vantage ticker coverage for non-equity commodities (crude, palm oil, sugar) — may need equity proxy mapping
- [ ] Build `research/mock_data/news_mock.json` with representative mock articles for DEMO_MODE
- [ ] Scrape or manually source USDA WASDE 2026–2027 release date schedule and encode in `fetch_news.py`
- [ ] Decide deduplication strategy for RSS items that also appear in Alpha Vantage results (title similarity vs. URL match)
- [ ] Design `news.json` schema versioning so front-end can handle schema additions without breaking changes
- [ ] Define alert engine interface: how does it write synthetic items to `news.json` without racing the cron job?
- [ ] Validate CNBC RSS availability and check ToS for automated ingestion
- [ ] Evaluate upgrading Alpha Vantage plan if 25 req/day proves insufficient for demo usage
- [ ] Implement ML-based commodity tagger (v0.2) to replace keyword dictionary in F-NEWS-004; pre-register evaluation metrics before training
