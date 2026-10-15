import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getInstruments,
  getNews,
  getPriceHistory,
  getWatchlist,
  getForecast,
  subscribeTicks,
  type Bar,
  type ForecastPoint,
  type InstrumentInfo,
  type NewsItem,
  type Quote,
} from './data/api';
import CommandBar, { type CmdResult } from './components/CommandBar';
import TickerTape from './components/TickerTape';
import Panel from './components/Panel';
import Watchlist from './components/Watchlist';
import PriceChart from './components/PriceChart';
import ChokepointBoard from './components/ChokepointBoard';
import RiskAlerts from './components/RiskAlerts';
import NewsFeed from './components/NewsFeed';
import DemandPanel from './components/DemandPanel';
import Blotter from './components/Blotter';
import StatusBar from './components/StatusBar';
import Settings, { TABS, type TabId } from './pages/Settings';
import { addAlert, removeAlerts, checkAlerts, requestNotifyPermission, fireNotification, getAlerts, type PriceAlert } from './lib/alerts';
import { exportAllCSV, exportForecastCSV, exportHistoryCSV, exportJSON } from './lib/export';
import { api, onServerEvent, serverOnline, useHealth } from './lib/server';
import { assign, loadLayout, PANELS, saveLayout, SLOTS, type Layout, type PanelKey } from './lib/layout';
import { loadChartConfig, saveChartConfig, type ChartConfig } from './components/ChartStudies';
import { INDICATORS } from '../shared/indicators';
import { BUILTIN_MODELS } from '../shared/models';
import type { Approval, Connection, OrderRecord, PluginManifest, Rule } from '../shared/types';

export type LiveQuote = Quote & { tick: 'up' | 'down' | null; tickId: number };
export type CompareState = { idA: string; idB: string; histA: Bar[]; histB: Bar[] } | null;

const FUNCTIONS: Record<string, PanelKey> = {
  WL: 'watch', WATCH: 'watch', WATCHLIST: 'watch',
  PRICE: 'chart', GP: 'chart', CHART: 'chart',
  SHIP: 'choke', CHOKE: 'choke', ROUTE: 'choke',
  RISK: 'risk',
  DEMAND: 'demand', DEM: 'demand', DMD: 'demand',
  NEWS: 'news', N: 'news',
  BLOTTER: 'blotter', BLTR: 'blotter', ORDERS: 'blotter', POSITIONS: 'blotter', POS: 'blotter',
};

const HELP_DETAIL: Record<string, string> = {
  SETTINGS: 'SETTINGS [DATA|NEWS|MODELS|RULES|ACTIONS|BROKERS|KEYS|AUDIT …]  — open the settings page',
  CONNECT: 'CONNECT <plugin>  e.g. CONNECT FRED, CONNECT SLACK, CONNECT ALPACA — opens the right settings tab',
  SOURCE: 'SOURCE <ID> <connection>:<symbol>  e.g. SOURCE BRENT YAHOO:BZ=F — re-point an instrument to a real feed',
  IND: 'IND ADD <RSI|MACD|BBANDS|SMA…> [params]  ·  IND REMOVE <name>  ·  IND CLEAR  — e.g. IND ADD BBANDS 20 2',
  MODEL: 'MODEL <HOLT|HW|DRIFT|PY:NAME|connection> [bars]  ·  MODEL OFF  — forecast overlay vs naive',
  RULE: 'RULE NEW  ·  RULES  ·  BACKTEST <rule name>  — no-code signal builder',
  APPROVE: 'APPROVE <approval id>  ·  REJECT <approval id>  ·  APPROVALS',
  BUY: 'BUY|SELL <qty> <ID> [LMT <price>] [ON <broker>]  — manual order through the risk guard',
  HALT: 'HALT [reason] — cancel open orders everywhere and block new ones  ·  RESUME',
  ALERT: 'ALERT <ID> ABOVE|BELOW <PRICE>  ·  ALERTS  ·  ALERT CLEAR <ID>|ALL',
  WATCH: 'WATCH <ID>  ·  UNWATCH <ID>',
  EXPORT: 'EXPORT <ID> [CSV|JSON] [HISTORY|FORECAST|ALL]',
  COMPARE: 'COMPARE <A> [VS] <B>  ·  COMPARE OFF',
  NOTIFY: 'NOTIFY ON — browser notifications for alerts, rule fires and approvals',
};
const HELP_TEXT = 'SETTINGS · CONNECT · SOURCE · IND · MODEL · RULE · BACKTEST · BUY/SELL · APPROVE · HALT · ALERT · WATCH · EXPORT · COMPARE · NOTIFY — HELP <cmd> for syntax';

const WATCH_KEY = 'dhoomberg_watchlist';
const REMOVED_KEY = 'dhoomberg_unwatched';
const readJson = <T,>(k: string, d: T): T => { try { return JSON.parse(localStorage.getItem(k) ?? 'null') ?? d; } catch { return d; } };
const writeJson = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

function parseHash(): { settings: TabId | null } {
  const m = /^#\/settings(?:\/([a-z]+))?/.exec(window.location.hash);
  if (!m) return { settings: null };
  const tab = (TABS.find((t) => t.id === m[1])?.id ?? 'data') as TabId;
  return { settings: tab };
}

export default function App() {
  const health = useHealth();
  const [instruments, setInstruments] = useState<InstrumentInfo[]>([]);
  const [quotes, setQuotes] = useState<Record<string, LiveQuote>>({});
  const [watchOrder, setWatchOrder] = useState<string[]>(() => readJson<string[]>(WATCH_KEY, []));
  const [selected, setSelected] = useState('SUGAR');
  const [history, setHistory] = useState<Bar[] | null>(null);
  const [focus, setFocus] = useState<PanelKey>('chart');
  const [news, setNews] = useState<NewsItem[]>([]);
  const [loadedAt] = useState(() => new Date());
  const [lastTick, setLastTick] = useState<Date | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [compare, setCompare] = useState<CompareState>(null);
  const [priceAlerts, setPriceAlerts] = useState<PriceAlert[]>(() => getAlerts());
  const [layout, setLayoutState] = useState<Layout>(loadLayout);
  const [route, setRoute] = useState(parseHash);
  const [chartCfg, setChartCfgState] = useState<ChartConfig>(loadChartConfig);
  const [instVersion, setInstVersion] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const watchRef = useRef<string[]>([]);

  const setLayout = (l: Layout) => { setLayoutState(l); saveLayout(l); };
  const setChartCfg = (c: ChartConfig) => { setChartCfgState(c); saveChartConfig(c); };
  const updateChart = (fn: (c: ChartConfig) => ChartConfig) => setChartCfgState((prev) => { const next = fn(prev); saveChartConfig(next); return next; });
  const openSettings = (tab: TabId = 'data') => { window.location.hash = `#/settings/${tab}`; };
  const closeSettings = () => { history_replace(''); setRoute({ settings: null }); };

  useEffect(() => {
    const f = () => setRoute(parseHash());
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);

  // Instruments (server or demo); new ones join the watchlist unless the user removed them.
  useEffect(() => {
    getInstruments().then((list) => {
      setInstruments(list);
      setWatchOrder((cur) => {
        const removed = new Set(readJson<string[]>(REMOVED_KEY, []));
        const ids = list.map((i) => i.id);
        const keep = cur.filter((id) => ids.includes(id));
        const next = [...keep, ...ids.filter((id) => !keep.includes(id) && !removed.has(id))];
        writeJson(WATCH_KEY, next);
        return next;
      });
    }).catch((e: Error) => setLoadError(e.message));
  }, [health === undefined, !!health, instVersion]);

  useEffect(() => onServerEvent((e) => {
    if (e.type === 'connections') setInstVersion((v) => v + 1);
    if (e.type === 'audit' && e.entry.kind === 'rule_fired') fireNotification(`Rule fired: ${String(e.entry.detail.rule ?? '')}`, `${e.entry.detail.bar ?? ''} @ ${e.entry.detail.price ?? ''}`);
    if (e.type === 'audit' && e.entry.kind === 'approval_requested') {
      const a = e.entry.detail.approval as Approval;
      fireNotification('Approval needed', `${a.intent.side.toUpperCase()} ${a.intent.qty} ${a.intent.instrument} · APPROVE ${a.id}`);
    }
  }), []);

  useEffect(() => {
    watchRef.current = watchOrder;
    if (!watchOrder.length) return;
    Promise.all([getWatchlist(watchOrder), getNews()])
      .then(([wl, nw]) => {
        const map = Object.fromEntries(wl.map((q) => [q.id, q]));
        setQuotes((prev) => Object.fromEntries(watchOrder.filter((id) => map[id]).map((id) => [id, { ...map[id], tick: prev[id]?.tick ?? null, tickId: prev[id]?.tickId ?? 0 }])));
        setNews(nw);
        setLoadError(null);
      })
      .catch((e: Error) => setLoadError(e.message));
  }, [watchOrder, !!health]);

  useEffect(() => {
    return subscribeTicks((id, price) => {
      setQuotes((prev) => {
        const cur = prev[id];
        if (!cur || cur.last === price) return prev;
        const fired = checkAlerts(id, price);
        for (const a of fired) if (a.notify) fireNotification(`Dhoomberg Alert: ${a.commodityName}`, `${a.commodityName} ${a.direction} ${a.threshold}`);
        if (fired.length) setPriceAlerts(getAlerts());
        return { ...prev, [id]: { ...cur, last: price, tick: price > cur.last ? 'up' : 'down', tickId: cur.tickId + 1, high52: Math.max(cur.high52, price), low52: Math.min(cur.low52, price) } };
      });
      setLastTick(new Date());
    }, () => watchRef.current);
  }, [!!health]);

  useEffect(() => {
    let current = true;
    setHistory(null);
    setCompare(null);
    getPriceHistory(selected).then((h) => current && setHistory(h)).catch((e: Error) => setLoadError(e.message));
    return () => { current = false; };
  }, [selected, instVersion]);

  useEffect(() => {
    document.getElementById(`panel-${focus}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focus]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const list = useMemo(() => watchOrder.map((id) => quotes[id]).filter(Boolean), [watchOrder, quotes]);

  const findCommodity = useCallback((text: string) => {
    const t = text.toUpperCase();
    return list.find((q) => q.id === t || q.code === t) ?? instruments.find((q) => q.id === t || q.code.toUpperCase() === t) ?? list.find((q) => q.name.toUpperCase().startsWith(t));
  }, [list, instruments]);

  const setWatch = (ids: string[], removedDelta?: { add?: string; remove?: string }) => {
    setWatchOrder(ids);
    writeJson(WATCH_KEY, ids);
    if (removedDelta) {
      const r = new Set(readJson<string[]>(REMOVED_KEY, []));
      if (removedDelta.add) r.add(removedDelta.add);
      if (removedDelta.remove) r.delete(removedDelta.remove);
      writeJson(REMOVED_KEY, [...r]);
    }
  };

  const runCommand = useCallback((raw: string): CmdResult | Promise<CmdResult> => {
    const original = raw.replace(/<?GO>?$/i, '').trim();
    const text = original.toUpperCase();
    if (!text) return null;
    const parts = text.split(/\s+/);
    const origParts = original.split(/\s+/);
    const [first, ...rest] = parts;
    const needServer = async <T,>(fn: () => Promise<T>): Promise<T> => {
      if (!(await serverOnline())) throw new Error('This needs the local server. Run: npm start');
      return fn();
    };
    const wrap = (p: Promise<CmdResult>): Promise<CmdResult> => p.catch((e: Error) => ({ kind: 'error', msg: e.message }));

    if (FUNCTIONS[first] && rest.length === 0) {
      setFocus(FUNCTIONS[first]);
      if (route.settings) closeSettings();
      return { kind: 'ok', msg: `${first} <GO>` };
    }

    if (first === 'HELP') return { kind: 'info', msg: rest[0] && HELP_DETAIL[rest[0] === 'SELL' ? 'BUY' : rest[0]] ? HELP_DETAIL[rest[0] === 'SELL' ? 'BUY' : rest[0]] : HELP_TEXT };

    if (first === 'SETTINGS' || first === 'SET' && rest.length === 0) {
      const t = TABS.find((x) => x.id.toUpperCase() === rest[0] || x.label.toUpperCase().startsWith(rest[0] ?? '~'));
      openSettings((t?.id ?? 'data') as TabId);
      return { kind: 'ok', msg: `Settings · ${t?.label ?? 'Data Sources'}` };
    }

    if (first === 'CONNECT') {
      return wrap(needServer(async () => {
        const { plugins } = await api.get<{ plugins: PluginManifest[] }>('/plugins');
        const q = rest.join(' ').toLowerCase();
        const p = plugins.find((x) => x.id === q || x.name.toLowerCase().startsWith(q)) ?? plugins.find((x) => x.name.toLowerCase().includes(q));
        const tab: TabId = !p ? 'data' : p.kind === 'datasource' ? 'data' : p.kind === 'news' ? 'news' : p.kind === 'model' ? 'models' : p.kind === 'action' ? 'actions' : 'brokers';
        openSettings(tab);
        return p ? { kind: 'ok', msg: `${p.name}: click Connect in ${TABS.find((t) => t.id === tab)!.label}` } : { kind: 'info', msg: `No plugin matches "${q}". Showing all data sources.` };
      }));
    }

    if (first === 'SOURCE') {
      const [id, spec] = rest;
      if (!id || !spec?.includes(':')) return { kind: 'error', msg: HELP_DETAIL.SOURCE };
      const [connQ, ...symParts] = origParts[2].split(':');
      const symbol = symParts.join(':');
      return wrap(needServer(async () => {
        const conns = await api.get<Connection[]>('/connections?kind=datasource');
        const c = conns.find((x) => x.id === connQ || x.name.toUpperCase() === connQ.toUpperCase() || x.pluginId === connQ.toLowerCase());
        if (!c) throw new Error(`No data source "${connQ}". Connect one first (CONNECT ${connQ}).`);
        const inst = instruments.find((i) => i.id === id);
        await api.post('/instruments', { id, name: inst?.name ?? id, code: inst?.code ?? id.slice(0, 6), unit: inst?.unit ?? '', dp: inst?.dp ?? 2, multiplier: inst?.multiplier ?? 1, connectionId: c.id, symbol });
        const bars = await api.get<Bar[]>(`/series/${id}`);
        setSelected(id);
        setInstVersion((v) => v + 1);
        return { kind: 'ok', msg: `${id} ← ${c.name}:${symbol} · ${bars.length} bars, last ${bars.at(-1)?.close}` };
      }));
    }

    if (first === 'IND') {
      const sub = rest[0];
      if (sub === 'CLEAR') { updateChart((cfg) => ({ ...cfg, studies: [] })); return { kind: 'ok', msg: 'Indicators cleared' }; }
      const isAdd = sub === 'ADD';
      const name = isAdd ? rest[1] : sub === 'REMOVE' || sub === 'RM' ? rest[1] : sub;
      if (!name) return { kind: 'error', msg: HELP_DETAIL.IND };
      if (sub === 'REMOVE' || sub === 'RM') {
        updateChart((cfg) => ({ ...cfg, studies: cfg.studies.filter((s) => s.id.toUpperCase() !== name && s.id.toUpperCase() !== `PY:${name}`) }));
        return { kind: 'ok', msg: `Removed ${name}` };
      }
      const meta = INDICATORS.find((m) => m.id.toUpperCase() === name || m.name.toUpperCase().replace(/\s/g, '') === name);
      const pyId = name.startsWith('PY:') ? name.toLowerCase() : null;
      if (!meta && !pyId) return { kind: 'error', msg: `Unknown indicator ${name}. Built-in: ${INDICATORS.map((m) => m.id.toUpperCase()).join(' ')}; Python: PY:<name>` };
      const nums = rest.slice(isAdd ? 2 : 1).map(Number).filter((x) => Number.isFinite(x));
      const params: Record<string, number | string> = meta ? Object.fromEntries(meta.params.map((p, i) => [p.key, nums[i] ?? p.default])) : {};
      if (meta?.needsOther) params.vs = rest.find((x) => instruments.some((i) => i.id === x) && x !== name) ?? (selected === 'GOLD' ? 'SILVER' : 'GOLD');
      const uid = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      updateChart((cfg) => ({ ...cfg, studies: [...cfg.studies, { uid, id: meta?.id ?? pyId!, params }] }));
      setFocus('chart');
      return { kind: 'ok', msg: `${meta?.name ?? pyId}(${Object.values(params).join(',')}) added` };
    }

    if (first === 'MODEL') {
      if (rest[0] === 'OFF' || !rest[0]) { updateChart((cfg) => ({ ...cfg, model: null })); return { kind: 'ok', msg: 'Model overlay off' }; }
      const q = rest[0].toLowerCase();
      const builtin = BUILTIN_MODELS.find((m) => m.id === q || m.name.toLowerCase().startsWith(q));
      const id = builtin ? `builtin:${builtin.id}` : q.startsWith('py:') ? q : rest[0];
      const h = Number(rest[1]);
      updateChart((cfg) => ({ ...cfg, model: id, horizon: Number.isFinite(h) && h > 0 ? Math.min(60, h) : cfg.horizon }));
      setFocus('chart');
      return { kind: 'ok', msg: `Forecast: ${builtin?.name ?? id}. Skill vs naive shown on the chart.` };
    }

    if (first === 'RULE' || first === 'RULES') {
      openSettings('rules');
      if (first === 'RULES') {
        return wrap(needServer(async () => {
          const rules = await api.get<Rule[]>('/rules');
          return { kind: 'info', msg: rules.length ? rules.map((r) => `${r.enabled ? '●' : '○'} ${r.name} [${r.mode}]`).join(' · ') : 'No rules yet. RULE NEW' };
        }));
      }
      return { kind: 'ok', msg: 'Rule builder: click New rule' };
    }

    if (first === 'BACKTEST') {
      const q = origParts.slice(1).join(' ').toLowerCase();
      if (!q) return { kind: 'error', msg: 'BACKTEST <rule name>' };
      return wrap(needServer(async () => {
        const rules = await api.get<Rule[]>('/rules');
        const r = rules.find((x) => x.id.toLowerCase() === q || x.name.toLowerCase().includes(q));
        if (!r) throw new Error(`No rule matching "${q}"`);
        updateChart((cfg) => ({ ...cfg, signalRule: r.id }));
        setFocus('chart');
        return { kind: 'ok', msg: `Showing historical fires of "${r.name}" on the chart` };
      }));
    }

    if (first === 'APPROVALS') { setFocus('blotter'); return { kind: 'ok', msg: 'Blotter · approvals' }; }
    if (first === 'APPROVE' || first === 'REJECT') {
      const id = origParts[1];
      if (!id) return { kind: 'error', msg: HELP_DETAIL.APPROVE };
      return wrap(needServer(async () => {
        if (first === 'REJECT') { await api.post(`/approvals/${id}/reject`); return { kind: 'ok', msg: `${id} rejected` }; }
        const r = await api.post<{ order: OrderRecord }>(`/approvals/${id}/approve`);
        return r.order.status === 'rejected' ? { kind: 'error', msg: `Approved, but the risk guard rejected it: ${r.order.reason}` } : { kind: 'ok', msg: `Order ${r.order.status}${r.order.fillPrice ? ` @ ${r.order.fillPrice}` : ''}` };
      }));
    }

    if (first === 'BUY' || first === 'SELL') {
      const qty = Number(rest[0]);
      const id = rest[1];
      if (!(qty > 0) || !id) return { kind: 'error', msg: HELP_DETAIL.BUY };
      const lmtIdx = rest.indexOf('LMT');
      const onIdx = rest.indexOf('ON');
      const limit = lmtIdx >= 0 ? Number(rest[lmtIdx + 1]) : undefined;
      const brokerQ = onIdx >= 0 ? origParts[onIdx + 2] : undefined;
      return wrap(needServer(async () => {
        const brokers = (await api.get<Connection[]>('/connections?kind=broker')).filter((b) => b.enabled);
        if (!brokers.length) throw new Error('No broker connected. SETTINGS BROKERS → Paper trading');
        const b = brokerQ ? brokers.find((x) => x.id === brokerQ || x.name.toUpperCase() === brokerQ.toUpperCase()) : brokers[0];
        if (!b) throw new Error(`No broker "${brokerQ}"`);
        const o = await api.post<OrderRecord>('/orders', { connectionId: b.id, instrument: findCommodity(id)?.id ?? id, side: first.toLowerCase(), qty, orderType: limit ? 'limit' : 'market', limitPrice: limit, tif: 'day' });
        setFocus('blotter');
        return o.status === 'rejected' || o.status === 'error'
          ? { kind: 'error', msg: `${o.status.toUpperCase()}: ${o.reason}` }
          : { kind: 'ok', msg: `${o.mode.toUpperCase()} ${first} ${qty} ${o.instrument} ${o.status}${o.fillPrice ? ` @ ${o.fillPrice}` : ''} (${b.name})` };
      }));
    }

    if (first === 'HALT') return wrap(needServer(async () => { await api.post('/halt', { reason: origParts.slice(1).join(' ') || 'HALT command' }); return { kind: 'error', msg: 'TRADING HALTED. Open orders cancelled. RESUME to re-enable.' }; }));
    if (first === 'RESUME') return wrap(needServer(async () => { await api.post('/resume'); return { kind: 'ok', msg: 'Trading resumed' }; }));

    // ── Alerts: server rules when online, local browser alerts otherwise ──────
    if (first === 'ALERT') {
      if (rest[0] === 'CLEAR') {
        if (rest[1] === 'ALL') { removeAlerts(); setPriceAlerts([]); return { kind: 'ok', msg: 'Local alerts cleared. Server rules: SETTINGS RULES' }; }
        removeAlerts(rest[1]); setPriceAlerts(getAlerts());
        return { kind: 'ok', msg: `Local alerts cleared for ${rest[1]}` };
      }
      const [cid, dir, priceStr] = rest;
      if (!cid || (dir !== 'ABOVE' && dir !== 'BELOW') || !priceStr) return { kind: 'error', msg: HELP_DETAIL.ALERT };
      const match = findCommodity(cid);
      if (!match) return { kind: 'error', msg: `Unknown instrument: ${cid}` };
      const threshold = parseFloat(priceStr);
      if (isNaN(threshold)) return { kind: 'error', msg: `Invalid price: ${priceStr}` };
      requestNotifyPermission();
      return wrap((async (): Promise<CmdResult> => {
        if (await serverOnline()) {
          const actions = (await api.get<Connection[]>('/connections?kind=action')).filter((c) => c.enabled).map((c) => ({ type: 'notify', connectionId: c.id }));
          await api.post('/rules', {
            name: `${match.id} ${dir.toLowerCase()} ${threshold}`, enabled: true, mode: 'notify', cooldownMin: 240, cadence: { type: 'tick' },
            when: { kind: 'group', mode: 'all', items: [{ kind: 'cond', left: { type: 'price', instrument: match.id }, op: dir === 'ABOVE' ? 'crosses_above' : 'crosses_below', right: { type: 'const', value: threshold } }] },
            actions,
          });
          return { kind: 'ok', msg: `Server rule set: ${match.id} crosses ${dir.toLowerCase()} ${threshold} → browser${actions.length ? ` + ${actions.length} channel(s)` : ''}. Runs with the tab closed.` };
        }
        addAlert({ commodityId: match.id, commodityName: match.name, direction: dir.toLowerCase() as 'above' | 'below', threshold, notify: true });
        setPriceAlerts(getAlerts());
        return { kind: 'ok', msg: `Browser alert set: ${match.name} ${dir.toLowerCase()} ${threshold} (only while this tab is open; start the server for persistent rules)` };
      })());
    }
    if (first === 'ALERTS') {
      const active = getAlerts().filter((a) => !a.firedAt);
      return { kind: 'info', msg: `${active.length ? active.map((a) => `${a.commodityId} ${a.direction} ${a.threshold}`).join(' · ') : 'No browser alerts'}. Server rules: RULES` };
    }

    if (first === 'WATCH' && rest.length > 0) {
      const match = findCommodity(rest[0]);
      if (!match) return { kind: 'error', msg: `Unknown instrument: ${rest[0]}` };
      setWatch([...new Set([...watchOrder, match.id])], { remove: match.id });
      return { kind: 'ok', msg: `${match.name} added to watchlist` };
    }
    if (first === 'UNWATCH' && rest.length > 0) {
      const match = findCommodity(rest[0]);
      if (!match) return { kind: 'error', msg: `${rest[0]} not in watchlist` };
      setWatch(watchOrder.filter((id) => id !== match.id), { add: match.id });
      return { kind: 'ok', msg: `${match.name} removed from watchlist` };
    }

    if (first === 'EXPORT') {
      const [cidRaw, fmtRaw = 'CSV', scopeRaw = 'ALL'] = rest;
      if (!cidRaw) return { kind: 'error', msg: HELP_DETAIL.EXPORT };
      const match = findCommodity(cidRaw);
      if (!match) return { kind: 'error', msg: `Unknown instrument: ${cidRaw}` };
      const id = match.id;
      return wrap((async (): Promise<CmdResult> => {
        const hist = await getPriceHistory(id);
        const fc = await getForecast(id).catch(() => null);
        if (fmtRaw === 'JSON') { exportJSON(id, { history: hist, forecast: fc?.forecast ?? null }); return { kind: 'ok', msg: `Downloaded ${id}.json` }; }
        if (scopeRaw === 'FORECAST') {
          if (!fc) throw new Error(`No ML-01 forecast for ${id}`);
          exportForecastCSV(id, fc.forecast as ForecastPoint[]);
        } else if (scopeRaw === 'HISTORY' || !fc) exportHistoryCSV(id, hist);
        else exportAllCSV(id, hist, fc.forecast as ForecastPoint[]);
        return { kind: 'ok', msg: `Downloaded ${id} ${scopeRaw.toLowerCase()} CSV` };
      })());
    }

    if (first === 'COMPARE') {
      if (rest[0] === 'OFF') { setCompare(null); return { kind: 'ok', msg: 'Compare mode off' }; }
      const [cidA, cidB] = rest.filter((t) => t !== 'VS' && t !== '/');
      if (!cidA || !cidB) return { kind: 'error', msg: HELP_DETAIL.COMPARE };
      const a = findCommodity(cidA), b = findCommodity(cidB);
      if (!a) return { kind: 'error', msg: `Unknown instrument: ${cidA}` };
      if (!b) return { kind: 'error', msg: `Unknown instrument: ${cidB}` };
      return wrap(Promise.all([getPriceHistory(a.id), getPriceHistory(b.id)]).then(([hA, hB]) => {
        setCompare({ idA: a.id, idB: b.id, histA: hA, histB: hB });
        setFocus('chart');
        return { kind: 'ok' as const, msg: `Comparing ${a.name} vs ${b.name}` };
      }));
    }

    if (first === 'NOTIFY') {
      if (rest[0] === 'ON') return wrap(requestNotifyPermission().then((ok) => (ok ? { kind: 'ok', msg: 'Browser notifications on' } : { kind: 'error', msg: 'Permission denied: enable notifications in browser settings' })));
      return { kind: 'error', msg: HELP_DETAIL.NOTIFY };
    }

    if (first === 'REFRESH') { window.location.reload(); return { kind: 'ok', msg: 'Refreshing…' }; }

    if (first === 'SET' && rest[0] === 'SLACK') {
      const url = origParts[2];
      if (!url?.startsWith('https://hooks.slack.com/')) return { kind: 'error', msg: 'SET SLACK https://hooks.slack.com/…' };
      return wrap(needServer(async () => {
        const c = await api.post<Connection>('/connections', { pluginId: 'slack', name: 'Slack', config: { webhookUrl: url } });
        const t = await api.post<{ ok: boolean; message: string }>(`/connections/${c.id}/test`);
        return t.ok ? { kind: 'ok', msg: 'Slack connected (stored encrypted on the server). Test message sent.' } : { kind: 'error', msg: `Saved, but the test failed: ${t.message}` };
      }));
    }

    const match = findCommodity(parts[0]);
    if (match) {
      setSelected(match.id);
      if (route.settings) closeSettings();
      const fnCode = parts[1];
      setFocus(fnCode && FUNCTIONS[fnCode] ? FUNCTIONS[fnCode] : 'chart');
      return { kind: 'ok', msg: `${match.code} ${match.name} <GO>` };
    }

    return { kind: 'error', msg: `Unknown command "${text}". Type HELP.` };
  }, [list, watchOrder, findCommodity, instruments, route.settings, selected]);

  // Deep links: ?cmd=COCOA;IND ADD RSI;MODEL HOLT runs commands once the watchlist is loaded.
  const ranDeepLink = useRef(false);
  useEffect(() => {
    if (ranDeepLink.current || !list.length) return;
    const cmds = new URLSearchParams(window.location.search).get('cmd');
    if (!cmds) return;
    ranDeepLink.current = true;
    (async () => {
      for (const c of cmds.split(';').map((s) => s.trim()).filter(Boolean)) {
        await runCommand(c);
        await new Promise((r) => setTimeout(r, 150));
      }
    })();
  }, [list.length, runCommand]);

  const sel = quotes[selected];
  const activeAlerts = priceAlerts.filter((a) => !a.firedAt);
  const swap = (slot: (typeof SLOTS)[number], p: PanelKey) => setLayout(assign(layout, slot, p));

  const body: Record<PanelKey, { meta?: React.ReactNode; title?: string; node: React.ReactNode }> = {
    watch: { meta: `${list.length} instruments${activeAlerts.length ? ` · ${activeAlerts.length} alerts` : ''}`, node: <Watchlist quotes={list} selected={selected} onSelect={(id) => { setSelected(id); setFocus('chart'); }} /> },
    chart: {
      title: compare ? `Compare: ${compare.idA} vs ${compare.idB}` : undefined,
      meta: compare ? 'Indexed to 100' : sel ? `${sel.code} · ${sel.unit}` : undefined,
      node: sel ? <PriceChart quote={sel} history={history} compare={compare} config={chartCfg} onConfig={setChartCfg} /> : <div className="empty">Loading…</div>,
    },
    choke: { meta: 'ML-06 · ML-08', node: <ChokepointBoard /> },
    risk: { meta: 'ML-09', node: <RiskAlerts /> },
    demand: { meta: 'Macro · COT · Food · Energy', node: <DemandPanel /> },
    news: { meta: health ? 'Live sources' : 'Demo feed', node: <NewsFeed items={news} loadedAt={loadedAt} selected={selected} /> },
    blotter: { meta: health ? (health.halted ? 'HALTED' : 'Orders · approvals · P&L') : 'Server off', node: <Blotter selected={selected} onSettings={() => openSettings('brokers')} /> },
  };

  return (
    <div className="app">
      <CommandBar inputRef={inputRef} onSubmit={runCommand} onSettings={() => (route.settings ? closeSettings() : openSettings())} settingsOpen={!!route.settings} halted={!!health?.halted} />
      <TickerTape quotes={list} />
      {loadError && <div className="load-error" onClick={() => setLoadError(null)}>{loadError}</div>}
      {route.settings ? (
        <Settings tab={route.settings} onTab={(t) => openSettings(t)} onClose={closeSettings} layout={layout} onLayout={setLayout} selected={selected} />
      ) : (
        <main className="grid">
          {SLOTS.map((slot) => {
            const p = layout[slot];
            const b = body[p];
            return (
              <Panel key={slot} id={p} slot={slot} fn={PANELS[p].fn} title={b.title ?? PANELS[p].title} meta={b.meta} active={focus === p} onActivate={setFocus} onSwap={swap}>
                {b.node}
              </Panel>
            );
          })}
        </main>
      )}
      <StatusBar lastTick={lastTick} onSettings={() => openSettings()} />
    </div>
  );
}

function history_replace(hash: string) {
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
}
