// Chart studies: indicator instances, model overlay and rule-signal markers.
import { useEffect, useMemo, useRef, useState } from 'react';
import { computeIndicator, INDICATORS, type IndicatorMeta } from '../../shared/indicators';
import { BUILTIN_MODELS, runBuiltinModel } from '../../shared/models';
import type { BacktestResult, ForecastResult, Rule } from '../../shared/types';
import { getPriceHistory, type Bar } from '../data/api';
import { api, useHealth } from '../lib/server';

export type Study = { uid: string; id: string; params: Record<string, number | string> };
export type StudyMeta = Pick<IndicatorMeta, 'id' | 'name' | 'pane' | 'outputs' | 'params'> & { group: string; levels?: number[]; needsOther?: boolean; description: string };
export type ChartConfig = { studies: Study[]; model: string | null; horizon: number; signalRule: string | null };

export const COLORS = ['#4fc3f7', '#c792ea', '#3ddc84', '#ff79c6', '#f1fa8c', '#8be9fd', '#ffb86c'];
const KEY = 'dhoomberg_chart';
const DEFAULT: ChartConfig = { studies: [{ uid: 'ma30', id: 'sma', params: { period: 30 } }], model: null, horizon: 20, signalRule: null };

export function loadChartConfig(): ChartConfig {
  try { return { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return DEFAULT; }
}
export function saveChartConfig(c: ChartConfig) {
  try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* ignore */ }
}

export function studyLabel(s: Study, meta?: StudyMeta) {
  const vals = (meta?.params ?? []).map((p) => s.params[p.key] ?? p.default);
  return `${meta?.name ?? s.id}${vals.length ? `(${vals.join(',')})` : ''}${s.params.vs ? ` vs ${s.params.vs}` : ''}`;
}

/** Built-in + Python indicator metadata. */
export function useStudyCatalog(): StudyMeta[] {
  const health = useHealth();
  const [py, setPy] = useState<StudyMeta[]>([]);
  useEffect(() => {
    if (!health) { setPy([]); return; }
    api.get<{ python: StudyMeta[] }>('/indicators').then((r) => setPy(r.python)).catch(() => setPy([]));
  }, [health?.python.plugins, !!health]);
  return useMemo(() => [...INDICATORS, ...py], [py]);
}

/** Computes every study over the full history (so warm-up is right), keyed by study uid. */
export function useStudyValues(instrument: string, history: Bar[] | null, studies: Study[], catalog: StudyMeta[]) {
  const [remote, setRemote] = useState<Record<string, Record<string, (number | null)[]>>>({});
  const [others, setOthers] = useState<Record<string, Bar[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const needOther = studies.map((s) => s.params.vs).filter((v): v is string => typeof v === 'string' && !!v);
  useEffect(() => {
    for (const vs of needOther) {
      if (others[vs]) continue;
      getPriceHistory(vs).then((h) => setOthers((o) => ({ ...o, [vs]: h }))).catch((e) => setErrors((x) => ({ ...x, [vs]: e.message })));
    }
  }, [needOther.join()]);

  const pyKey = studies.filter((s) => s.id.startsWith('py:')).map((s) => `${s.uid}:${JSON.stringify(s.params)}`).join('|');
  useEffect(() => {
    if (!history) return;
    for (const s of studies.filter((x) => x.id.startsWith('py:'))) {
      api.get<{ dates: string[]; outputs: Record<string, (number | null)[]> }>(`/indicator?instrument=${encodeURIComponent(instrument)}&id=${encodeURIComponent(s.id)}&params=${encodeURIComponent(JSON.stringify(s.params))}`)
        .then((r) => {
          const idx = new Map(r.dates.map((d, i) => [d, i]));
          const aligned = Object.fromEntries(Object.entries(r.outputs).map(([k, v]) => [k, history.map((b) => { const i = idx.get(b.date); return i === undefined ? null : v[i]; })]));
          setRemote((x) => ({ ...x, [s.uid]: aligned }));
          setErrors((x) => { const { [s.uid]: _, ...rest } = x; return rest; });
        })
        .catch((e) => setErrors((x) => ({ ...x, [s.uid]: e.message })));
    }
  }, [instrument, history?.length, pyKey]);

  const local = useMemo(() => {
    const out: Record<string, Record<string, (number | null)[]>> = {};
    if (!history) return out;
    const closes = history.map((b) => b.close);
    for (const s of studies) {
      if (s.id.startsWith('py:') || !catalog.some((m) => m.id === s.id)) continue;
      let other: number[] | undefined;
      if (typeof s.params.vs === 'string' && s.params.vs) {
        const oh = others[s.params.vs];
        if (!oh) continue;
        const m = new Map(oh.map((b) => [b.date, b.close]));
        let last = NaN;
        other = history.map((b) => (last = m.get(b.date) ?? last));
      }
      try { out[s.uid] = computeIndicator(s.id, closes, s.params, other); } catch { /* reported in UI via missing values */ }
    }
    return out;
  }, [history, studies, catalog, others]);

  return { values: { ...local, ...remote }, errors };
}

/** Forecast overlay: built-ins run in the browser, Python/HTTP models on the server. */
export function useModel(instrument: string, history: Bar[] | null, model: string | null, horizon: number) {
  const [res, setRes] = useState<ForecastResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    setRes(null); setErr(null);
    if (!model || !history || history.length < 30) return;
    const n = ++seq.current;
    setBusy(true);
    const p = model.startsWith('builtin:')
      ? runBuiltinModel(model.slice(8), history, horizon)
      : api.get<ForecastResult>(`/forecast?instrument=${encodeURIComponent(instrument)}&model=${encodeURIComponent(model)}&horizon=${horizon}`);
    p.then((r) => n === seq.current && setRes(r), (e: Error) => n === seq.current && setErr(e.message)).finally(() => n === seq.current && setBusy(false));
  }, [instrument, model, horizon, history?.length]);
  return { res, err, busy };
}

export function useModelOptions(): { id: string; name: string }[] {
  const health = useHealth();
  const [remote, setRemote] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!health) { setRemote([]); return; }
    api.get<{ id: string; name: string }[]>('/models').then((m) => setRemote(m.filter((x) => !x.id.startsWith('builtin:')))).catch(() => setRemote([]));
  }, [!!health, health?.python.plugins, health?.connections.length]);
  return [...BUILTIN_MODELS.map((m) => ({ id: `builtin:${m.id}`, name: m.name })), ...remote];
}

/** Historical fire points of a saved rule, from the server's backtester. */
export function useSignals(ruleId: string | null) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [bt, setBt] = useState<BacktestResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const health = useHealth();
  useEffect(() => {
    if (!health) return;
    api.get<Rule[]>('/rules').then(setRules).catch(() => setRules([]));
  }, [!!health]);
  useEffect(() => {
    setBt(null); setErr(null);
    const r = rules.find((x) => x.id === ruleId);
    if (!r) return;
    api.post<BacktestResult>('/rules/backtest', { rule: r, horizonBars: 5 }).then(setBt, (e: Error) => setErr(e.message));
  }, [ruleId, rules]);
  return { rules, bt, err };
}
