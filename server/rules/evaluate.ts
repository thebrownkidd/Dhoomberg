// Pure condition evaluation over aligned series. Operands resolve to either a historical
// series (price, indicator) or a point-in-time scalar (news, LLM, model, demand, COT).
import type { Condition, Group, Operand, Operator } from '../../shared/types';

export type Resolved = { series: (number | null)[] | null; scalar: number | null; historical: boolean; label: string };

export function valueAt(r: Resolved, i: number): number | null {
  if (r.series) return r.series[i] ?? null;
  return r.scalar;
}

export type CondEval = { result: boolean | null; left: number | null; right: number | null; label: string };

export function evalCondition(c: Condition, L: Resolved, R: Resolved, i: number, prev?: { left: number | null; right: number | null }): CondEval {
  const l = valueAt(L, i), r = valueAt(R, i);
  const label = `${L.label} ${opLabel(c.op)} ${R.label}${c.op === 'between' ? ` and ${c.upper}` : ''}`;
  const out = (result: boolean | null): CondEval => ({ result, left: l, right: r, label });
  if (l === null) return out(null);
  switch (c.op) {
    case '>': return out(r === null ? null : l > r);
    case '<': return out(r === null ? null : l < r);
    case '>=': return out(r === null ? null : l >= r);
    case '<=': return out(r === null ? null : l <= r);
    case 'between': return out(r === null || c.upper === undefined ? null : l >= r && l <= c.upper);
    case 'crosses_above':
    case 'crosses_below': {
      const pl = L.series ? (i > 0 ? L.series[i - 1] : null) : prev?.left ?? null;
      const pr = R.series ? (i > 0 ? R.series[i - 1] : null) : R.historical ? r : prev?.right ?? r;
      if (r === null || pl === null || pr === null) return out(null);
      return out(c.op === 'crosses_above' ? pl <= pr && l > r : pl >= pr && l < r);
    }
    case 'pct_change_gt':
    case 'pct_change_lt': {
      const n = Math.max(1, c.lookback ?? 1);
      if (!L.series || i - n < 0) return out(null);
      const base = L.series[i - n];
      if (base === null || base === 0 || r === null) return out(null);
      const ch = (l / base - 1) * 100;
      return { result: c.op === 'pct_change_gt' ? ch > r : ch < r, left: ch, right: r, label: `${L.label} % change over ${n} bars ${c.op === 'pct_change_gt' ? '>' : '<'} ${R.label}%` };
    }
  }
}

export function opLabel(op: Operator): string {
  return { '>': '>', '<': '<', '>=': '≥', '<=': '≤', crosses_above: 'crosses above', crosses_below: 'crosses below', pct_change_gt: '% change >', pct_change_lt: '% change <', between: 'between' }[op];
}

export function operandLabel(o: Operand): string {
  switch (o.type) {
    case 'const': return String(o.value);
    case 'price': return `${o.instrument} price`;
    case 'indicator': return `${o.instrument} ${o.indicator.toUpperCase()}(${Object.values(o.params).join(',')})${o.output && o.output !== 'value' ? `.${o.output}` : ''}`;
    case 'model': return `${o.instrument} ${o.model} ${o.horizon}-bar forecast % chg`;
    case 'news': return `${o.instrument} news ${o.field.replace('_', ' ')} (${o.windowHours}h)`;
    case 'llm': return `${o.instrument} LLM bias`;
    case 'demand': return `${o.series} (demand)`;
    case 'cot': return `${o.instrument} COT net long %`;
  }
}

/** Walks the rule tree; `leaf` evaluates a condition at a path like "0.2.1". */
export function evalGroup(g: Group, leaf: (c: Condition, path: string) => CondEval, path = ''): { result: boolean; details: CondEval[] } {
  const details: CondEval[] = [];
  const results = g.items.map((item, idx) => {
    const p = path ? `${path}.${idx}` : String(idx);
    if (item.kind === 'group') {
      const r = evalGroup(item, leaf, p);
      details.push(...r.details);
      return r.result;
    }
    const r = leaf(item, p);
    details.push(r);
    return r.result === true;
  });
  const result = results.length > 0 && (g.mode === 'all' ? results.every(Boolean) : results.some(Boolean));
  return { result, details };
}

export function conditions(g: Group): Condition[] {
  return g.items.flatMap((i) => (i.kind === 'group' ? conditions(i) : [i]));
}

export function primaryInstrument(g: Group): string | null {
  for (const c of conditions(g)) for (const o of [c.left, c.right]) if ('instrument' in o && o.instrument) return o.instrument;
  return null;
}
