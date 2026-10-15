import { useEffect, useState } from 'react';
import { getRealNews, type RealNewsItem } from '../data/api';
import type { NewsItem } from '../data/api';
import type { Connection } from '../../shared/types';
import { api, onServerEvent, useHealth } from '../lib/server';

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.max(0, Math.floor(diff / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const sentimentColor = (s: string | null) => (s === 'bullish' ? 'var(--up)' : s === 'bearish' ? 'var(--down)' : 'var(--dim)');
const sentimentLabel = (s: string | null) => (s === 'bullish' ? '▲' : s === 'bearish' ? '▼' : '—');

function RealItem({ item }: { item: RealNewsItem }) {
  const [expanded, setExpanded] = useState(false);
  const hasSummary = !!item.summary;
  return (
    <li className={`news-item${expanded ? ' expanded' : ''}`} onClick={() => hasSummary && setExpanded((v) => !v)} style={{ cursor: hasSummary ? 'pointer' : 'default' }}>
      <div className="news-row">
        <time className="news-time">{relTime(item.publishedAt)}</time>
        <span className="news-sentiment" style={{ color: sentimentColor(item.sentiment) }} title={`${item.sentiment ?? 'unscored'}${item.tags.includes('lexicon-sentiment') ? ' (headline lexicon)' : ''}`}>
          {sentimentLabel(item.sentiment)}
        </span>
        <span className="news-source">{item.source}</span>
        <span className="news-headline">
          {item.url ? <a href={item.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>{item.headline}</a> : item.headline}
        </span>
      </div>
      {expanded && hasSummary && <div className="news-summary">{item.summary}</div>}
      {(item.commodities.length > 0 || item.tags.length > 0) && (
        <div className="news-tags">
          {item.commodities.slice(0, 6).map((c) => <span key={c} className="news-tag-cid">{c}</span>)}
          {item.tags.filter((t) => t !== 'lexicon-sentiment').slice(0, 3).map((t) => <span key={t} className="news-tag-topic">{t}</span>)}
        </div>
      )}
    </li>
  );
}

function MockItem({ item, loadedAt }: { item: NewsItem; loadedAt: Date }) {
  const d = new Date(loadedAt.getTime() - item.minutesAgo * 60_000);
  return (
    <li className="news-item">
      <div className="news-row">
        <time className="news-time">{d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</time>
        <span className="news-sentiment" style={{ color: 'var(--dim)' }}>—</span>
        <span className={`tag tag-${item.tag.toLowerCase()}`}>{item.tag}</span>
        <span className="news-headline">{item.headline}</span>
      </div>
    </li>
  );
}

type Filter = 'all' | 'bullish' | 'bearish' | 'selected';

export default function NewsFeed({ items: mockItems, loadedAt, selected }: { items: NewsItem[]; loadedAt: Date; selected?: string }) {
  const health = useHealth();
  const [feed, setFeed] = useState<{ items: RealNewsItem[]; sources: string[]; demo: boolean; errors?: Record<string, string> } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [source, setSource] = useState('');
  const [sources, setSources] = useState<Connection[]>([]);
  const [n, setN] = useState(0);

  useEffect(() => {
    if (!health) { setSources([]); return; }
    api.get<Connection[]>('/connections?kind=news').then((c) => setSources(c.filter((x) => x.enabled))).catch(() => setSources([]));
  }, [!!health, health?.connections.length]);

  useEffect(() => onServerEvent((e) => { if (e.type === 'connections') setN((x) => x + 1); }), []);
  useEffect(() => {
    let live = true;
    const load = () => getRealNews(source || undefined).then((f) => { if (live) { setFeed(f); setErr(null); } }, (e: Error) => live && setErr(e.message));
    load();
    const t = window.setInterval(load, 5 * 60_000);
    return () => { live = false; window.clearInterval(t); };
  }, [source, n, health === undefined]);

  const items = feed?.items ?? [];
  const displayed = items.filter((it) => {
    if (filter === 'all') return true;
    if (filter === 'selected') return !!selected && it.commodities.includes(selected);
    return it.sentiment === filter;
  });
  const failing = Object.entries(feed?.errors ?? {});

  return (
    <div className="news-wrap">
      <div className="news-filters">
        {(['all', 'bullish', 'bearish', 'selected'] as Filter[]).map((f) => (
          <button key={f} className={`news-filter-btn${filter === f ? ' active' : ''}`} onClick={() => setFilter(f)}
            style={f === 'bullish' && filter === f ? { color: 'var(--up)' } : f === 'bearish' && filter === f ? { color: 'var(--down)' } : undefined}>
            {f === 'all' ? 'ALL' : f === 'bullish' ? '▲ BULL' : f === 'bearish' ? '▼ BEAR' : selected ?? 'SEL'}
          </button>
        ))}
        <select className="news-source-sel" value={source} onChange={(e) => setSource(e.target.value)} title="News source">
          <option value="">{feed?.demo ? 'Demo feed' : `All sources (${sources.length})`}</option>
          {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <span className="news-filter-count">{displayed.length}</span>
      </div>
      {failing.length > 0 && <div className="news-warn" title={failing.map(([, e]) => e).join('\n')}>{failing.length} source{failing.length > 1 ? 's' : ''} failing (hover)</div>}
      <ul className="news">
        {feed ? displayed.map((item) => <RealItem key={item.id} item={item} />) : err ? mockItems.map((n) => <MockItem key={n.id} item={n} loadedAt={loadedAt} />) : null}
      </ul>
      {!feed && !err && <div className="news-loading">Loading news…</div>}
      {feed?.demo && <div className="news-loading">Demo headlines. Connect real feeds in <code>SETTINGS</code> → News (CNBC, USDA, EIA and any RSS work without a key).</div>}
    </div>
  );
}
