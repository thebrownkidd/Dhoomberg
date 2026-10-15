import { api } from './server';

export type PanelKey = 'watch' | 'chart' | 'choke' | 'risk' | 'demand' | 'news' | 'blotter';
export const SLOTS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7'] as const;
export type Slot = (typeof SLOTS)[number];
export type Layout = Record<Slot, PanelKey>;

export const DEFAULT_LAYOUT: Layout = { s1: 'watch', s2: 'chart', s3: 'choke', s4: 'risk', s5: 'news', s6: 'demand', s7: 'blotter' };

export const PANELS: Record<PanelKey, { fn: string; title: string }> = {
  watch: { fn: 'WL', title: 'Watchlist' },
  chart: { fn: 'GP', title: 'Price History' },
  choke: { fn: 'SHIP', title: 'Chokepoints + Suppliers' },
  risk: { fn: 'RISK', title: 'Lane Risk + Signals' },
  demand: { fn: 'DEMAND', title: 'Demand Signals' },
  news: { fn: 'NEWS', title: 'Wire' },
  blotter: { fn: 'BLTR', title: 'Blotter' },
};

export const SLOT_HINT: Record<Slot, string> = { s1: 'Left column', s2: 'Main', s3: 'Top right', s4: 'Middle centre', s5: 'Middle right', s6: 'Bottom centre', s7: 'Bottom right' };

const KEY = 'dhoomberg_layout';

export function loadLayout(): Layout {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (v && SLOTS.every((s) => v[s] in PANELS)) return v;
  } catch { /* ignore */ }
  return DEFAULT_LAYOUT;
}

export function saveLayout(l: Layout) {
  try { localStorage.setItem(KEY, JSON.stringify(l)); } catch { /* ignore */ }
  api.get<Record<string, unknown>>('/workspace').then((w) => api.put('/workspace', { ...w, layout: l })).catch(() => {});
}

/** Puts `panel` into `slot`, swapping with wherever it was, so every panel stays visible once. */
export function assign(l: Layout, slot: Slot, panel: PanelKey): Layout {
  const from = SLOTS.find((s) => l[s] === panel);
  const next = { ...l, [slot]: panel };
  if (from && from !== slot) next[from] = l[slot];
  return next;
}
