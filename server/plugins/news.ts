import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import type { NewsItem } from '../../shared/types';
import { httpFetch, num, pluck, render, toIso } from '../http';
import { AUTH_SCHEMA, authHeaders } from './authn';
import { extractRows } from './datasources';
import { need, S, type Ctx, type NewsImpl, type PluginDef } from './types';

const KEYWORD_COMMODITY: Record<string, string[]> = {
  'crude oil': ['BRENT', 'WTI', 'DUBAI'], brent: ['BRENT'], wti: ['WTI'], 'natural gas': ['NATGAS_US', 'NATGAS_EU'], lng: ['NATGAS_EU'],
  gold: ['GOLD'], silver: ['SILVER'], platinum: ['PLATINUM'], copper: ['COPPER'], aluminum: ['ALU'], aluminium: ['ALU'],
  nickel: ['NICKEL'], zinc: ['ZINC'], 'iron ore': ['IRON'], wheat: ['WHEAT', 'WHEAT_SRW'], corn: ['MAIZE'], maize: ['MAIZE'],
  soybean: ['SOYBEANS', 'SOYOIL', 'SOYMEAL'], soy: ['SOYBEANS'], sugar: ['SUGAR'], cocoa: ['COCOA'], coffee: ['COFFEE', 'COFFEE_ROB'],
  cotton: ['COTTON'], rubber: ['RUBBER'], 'palm oil': ['PALM'], fertilizer: ['UREA', 'DAP', 'TSP', 'POTASH'], urea: ['UREA'], potash: ['POTASH'],
  coal: ['COAL_AU'], rice: ['RICE'], beef: ['BEEF'], cattle: ['BEEF'], chicken: ['CHICKEN'], poultry: ['CHICKEN'],
  opec: ['BRENT', 'WTI', 'DUBAI'], usda: ['WHEAT', 'MAIZE', 'SOYBEANS', 'RICE', 'COTTON'], wasde: ['WHEAT', 'MAIZE', 'SOYBEANS', 'RICE', 'COTTON', 'SUGAR'],
  eia: ['BRENT', 'WTI', 'NATGAS_US'], tea: ['TEA'], tin: ['TIN'], 'orange juice': ['ORANGE'],
};

const POS = ['surge', 'soar', 'rally', 'jump', 'gain', 'rise', 'rises', 'climb', 'rebound', 'record high', 'shortage', 'deficit', 'tight supply', 'strong demand', 'upgrade', 'boost', 'beats', 'higher', 'firm'];
const NEG = ['plunge', 'slump', 'fall', 'falls', 'drop', 'decline', 'slide', 'tumble', 'glut', 'surplus', 'oversupply', 'weak demand', 'downgrade', 'lower', 'crash', 'sink', 'slips', 'eases', 'bearish'];

export function tagCommodities(text: string): string[] {
  const t = text.toLowerCase();
  const out = new Set<string>();
  for (const [kw, ids] of Object.entries(KEYWORD_COMMODITY)) if (new RegExp(`\\b${kw}\\b`).test(t)) ids.forEach((i) => out.add(i));
  return [...out].sort();
}

/** Crude headline lexicon, used only when the provider gives no sentiment score. */
export function lexiconScore(text: string): number | null {
  const t = text.toLowerCase();
  const p = POS.filter((w) => new RegExp(`\\b${w}`).test(t)).length;
  const n = NEG.filter((w) => new RegExp(`\\b${w}`).test(t)).length;
  if (!p && !n) return null;
  return (p - n) / (p + n);
}

export function label(score: number | null): NewsItem['sentiment'] {
  if (score === null) return null;
  return score >= 0.15 ? 'bullish' : score <= -0.15 ? 'bearish' : 'neutral';
}

export function makeItem(p: { headline: string; summary?: string; url?: string; source: string; publishedAt: unknown; score?: number | null; tags?: string[] }): NewsItem | null {
  const headline = (p.headline ?? '').replace(/\s+/g, ' ').trim();
  if (!headline) return null;
  const summary = (p.summary ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 600);
  let score = p.score ?? null;
  const tags = [...(p.tags ?? [])];
  if (score === null || !Number.isFinite(score)) {
    score = lexiconScore(`${headline} ${summary}`);
    if (score !== null) tags.push('lexicon-sentiment');
  }
  return {
    id: createHash('md5').update(`${p.url ?? ''}|${headline}`).digest('hex').slice(0, 12),
    headline, summary, url: p.url ?? '', source: p.source,
    publishedAt: toIso(p.publishedAt, false) ?? new Date().toISOString(),
    commodities: tagCommodities(`${headline} ${summary}`),
    sentiment: label(score), sentimentScore: score, tags,
  };
}

// ── Generic JSON news API ────────────────────────────────────────────────────
type NewsMap = { url: string; rowsPath?: string; headline: string; summary?: string; link?: string; time: string; source?: string; sourceName?: string; score?: string; scoreScale?: number };

async function fetchJsonNews(ctx: Ctx, m: NewsMap, query?: string): Promise<NewsItem[]> {
  const url = render(m.url, { ...ctx.config, query: query || ctx.config.defaultQuery || 'commodities' }, 'url');
  const body = await (await httpFetch(url, { headers: { Accept: 'application/json', ...(await authHeaders(ctx.config, ctx.connectionId)) } })).json();
  const rows = extractRows(body, { rowsPath: m.rowsPath });
  return rows
    .map((r) => makeItem({
      headline: String(pluck(r, m.headline) ?? ''),
      summary: m.summary ? String(pluck(r, m.summary) ?? '') : '',
      url: m.link ? String(pluck(r, m.link) ?? '') : '',
      source: m.source ? String(pluck(r, m.source) ?? m.sourceName) : m.sourceName ?? new URL(url).host,
      publishedAt: pluck(r, m.time),
      score: m.score ? num(pluck(r, m.score)) * (m.scoreScale ?? 1) : null,
    }))
    .filter((x): x is NewsItem => !!x);
}

const genericNews: NewsImpl = {
  fetch: (ctx, q) => {
    const c = ctx.config;
    need(c, 'url', 'headlineField', 'timeField');
    return fetchJsonNews(ctx, { url: c.url, rowsPath: c.rowsPath, headline: c.headlineField, summary: c.summaryField, link: c.linkField, time: c.timeField, source: c.sourceField, sourceName: c.sourceName, score: c.scoreField, scoreScale: Number(c.scoreScale ?? 1) }, q.query);
  },
  async test(ctx) { const n = await genericNews.fetch(ctx, {}); return `${n.length} items, newest: ${n[0]?.headline ?? '—'}`; },
};

// ── RSS / Atom ───────────────────────────────────────────────────────────────
const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', textNodeName: '#text' });
const text = (v: unknown): string => (v == null ? '' : typeof v === 'object' ? String((v as Record<string, unknown>)['#text'] ?? '') : String(v));

export async function fetchRss(url: string, sourceName: string, tags: string[] = []): Promise<NewsItem[]> {
  const body = xml.parse(await (await httpFetch(url, { headers: { Accept: 'application/rss+xml, application/atom+xml, text/xml' } })).text());
  const channel = body.rss?.channel ?? body['rdf:RDF'];
  const raw = channel?.item ?? body.feed?.entry ?? [];
  const items = Array.isArray(raw) ? raw : [raw];
  return items
    .map((it: Record<string, unknown>) => {
      const link = it.link;
      const href = typeof link === 'string' ? link : Array.isArray(link) ? (link[0] as Record<string, string>)['@href'] : (link as Record<string, string> | undefined)?.['@href'];
      return makeItem({
        headline: text(it.title), summary: text(it.description ?? it.summary ?? it.content),
        url: href ?? '', source: sourceName, publishedAt: text(it.pubDate ?? it.published ?? it.updated ?? it['dc:date']), tags,
      });
    })
    .filter((x: NewsItem | null): x is NewsItem => !!x);
}

const rssNews: NewsImpl = {
  fetch: (ctx) => {
    need(ctx.config, 'url');
    return fetchRss(ctx.config.url, ctx.config.sourceName || new URL(ctx.config.url).host, String(ctx.config.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  },
  async test(ctx) { const n = await rssNews.fetch(ctx, {}); return `${n.length} items, newest: ${n[0]?.headline ?? '—'}`; },
};

// ── Presets ──────────────────────────────────────────────────────────────────
function jsonPreset(id: string, name: string, description: string, docsUrl: string, m: NewsMap, extra: Record<string, ReturnType<typeof S.str>> = {}, authType = 'none'): PluginDef {
  const impl: NewsImpl = {
    fetch: (ctx, q) => fetchJsonNews({ ...ctx, config: { authType, ...ctx.config } }, m, q.query),
    async test(ctx) { const n = await impl.fetch(ctx, {}); return `${n.length} items, newest: ${n[0]?.headline ?? '—'}`; },
  };
  return {
    id, kind: 'news', name, category: 'News APIs', description, docsUrl, source: 'builtin',
    configSchema: S.obj({ apiKey: S.secret('API key'), defaultQuery: S.str('Default search query', { default: 'commodities OR crude OR wheat OR cocoa' }), ...extra }, ['apiKey']),
    impl,
  };
}

function rssPreset(id: string, name: string, url: string, tags: string[]): PluginDef {
  const impl: NewsImpl = { fetch: () => fetchRss(url, name, tags), test: async () => `${(await fetchRss(url, name, tags)).length} items` };
  return { id, kind: 'news', name, category: 'RSS feeds', description: url, source: 'builtin', configSchema: S.obj({}), impl };
}

export const NEWS_PLUGINS: PluginDef[] = [
  {
    id: 'news_rss', kind: 'news', name: 'Any RSS / Atom feed', category: 'Generic', source: 'builtin',
    description: 'Paste any RSS or Atom URL: trade press, ministry releases, exchange notices, Google News queries.',
    configSchema: S.obj({ url: S.url('Feed URL'), sourceName: S.str('Source label'), tags: S.str('Tags (comma-separated)') }, ['url']), impl: rssNews,
  },
  {
    id: 'news_json', kind: 'news', name: 'Generic JSON news API', category: 'Generic', source: 'builtin',
    description: 'Any news API returning JSON. Map headline/summary/link/time/sentiment fields once.',
    configSchema: S.obj({
      url: S.str('URL template', { 'x-placeholder': 'https://api.example.com/news?q={query}&key={apiKey}' }), rowsPath: S.str('Items path'),
      headlineField: S.str('Headline field', { default: 'title' }), summaryField: S.str('Summary field'), linkField: S.str('Link field', { default: 'url' }),
      timeField: S.str('Published-time field', { default: 'publishedAt' }), sourceField: S.str('Source field'), sourceName: S.str('Source label'),
      scoreField: S.str('Sentiment score field (−1…1)'), scoreScale: S.num('Score multiplier', 1), defaultQuery: S.str('Default query', { default: 'commodities' }),
      ...AUTH_SCHEMA,
    }, ['url', 'headlineField', 'timeField']),
    impl: genericNews,
  },
  jsonPreset('news_alphavantage', 'Alpha Vantage News & Sentiment', 'Ticker/topic news with per-article sentiment scores.', 'https://www.alphavantage.co/documentation/#news-sentiment',
    { url: 'https://www.alphavantage.co/query?function=NEWS_SENTIMENT&topics={topics}&tickers={tickers}&limit=50&apikey={apiKey}', rowsPath: 'feed', headline: 'title', summary: 'summary', link: 'url', time: 'time_published', source: 'source', score: 'overall_sentiment_score' },
    { topics: S.str('Topics', { default: 'energy_transportation,economy_macro' }), tickers: S.str('Tickers', { default: 'USO,GLD,CORN,WEAT,CPER' }) }),
  jsonPreset('news_newsapi', 'NewsAPI.org', '80k+ sources, keyword search.', 'https://newsapi.org/docs/endpoints/everything',
    { url: 'https://newsapi.org/v2/everything?q={query}&language=en&sortBy=publishedAt&pageSize=50&apiKey={apiKey}', rowsPath: 'articles', headline: 'title', summary: 'description', link: 'url', time: 'publishedAt', source: 'source.name' }),
  {
    ...jsonPreset('news_gdelt', 'GDELT DOC 2.0', 'Global news monitoring in 65 languages, no key needed. Rate limit: 1 request per 5 s per IP; shared/cloud IPs often get HTTP 429.', 'https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/',
      { url: 'https://api.gdeltproject.org/api/v2/doc/doc?query={query}&mode=artlist&format=json&maxrecords=75&sort=datedesc', rowsPath: 'articles', headline: 'title', link: 'url', time: 'seendate', source: 'domain' }),
    configSchema: S.obj({ defaultQuery: S.str('Default query', { default: '(crude OR wheat OR cocoa OR copper) sourcelang:english' }) }),
  },
  jsonPreset('news_finnhub', 'Finnhub market news', 'General and commodity market news.', 'https://finnhub.io/docs/api/market-news',
    { url: 'https://finnhub.io/api/v1/news?category=general&token={apiKey}', rowsPath: '', headline: 'headline', summary: 'summary', link: 'url', time: 'datetime', source: 'source' }),
  jsonPreset('news_polygon', 'Polygon.io news', 'Ticker news with publisher insights.', 'https://polygon.io/docs/stocks/get_v2_reference_news',
    { url: 'https://api.polygon.io/v2/reference/news?limit=50&order=desc&apiKey={apiKey}', rowsPath: 'results', headline: 'title', summary: 'description', link: 'article_url', time: 'published_utc', source: 'publisher.name' }),
  jsonPreset('news_benzinga', 'Benzinga', 'Real-time market news (paid).', 'https://docs.benzinga.com/benzinga-apis/newsfeed-v2/get-news',
    { url: 'https://api.benzinga.com/api/v2/news?token={apiKey}&pageSize=50&displayOutput=abstract', rowsPath: '', headline: 'title', summary: 'teaser', link: 'url', time: 'created', sourceName: 'Benzinga' }),
  jsonPreset('news_marketaux', 'Marketaux', 'Global financial news with entity sentiment.', 'https://www.marketaux.com/documentation',
    { url: 'https://api.marketaux.com/v1/news/all?search={query}&language=en&api_token={apiKey}', rowsPath: 'data', headline: 'title', summary: 'description', link: 'url', time: 'published_at', source: 'source', score: 'entities[0].sentiment_score' }),
  rssPreset('rss_cnbc', 'CNBC Commodities', 'https://www.cnbc.com/id/19832390/device/rss/rss.html', ['energy', 'metals']),
  rssPreset('rss_usda', 'USDA NASS News', 'https://www.nass.usda.gov/rss/News.xml', ['agriculture', 'usda']),
  rssPreset('rss_eia', 'EIA Today in Energy', 'https://www.eia.gov/rss/todayinenergy.xml', ['energy', 'eia']),
];
