"""ML-04: Leading indicators — Granger causality + OOS cross-correlation.

Pre-registered protocol:
  Discovery period: 2000-01 to 2018-12  (all choices fixed here)
  OOS confirmation: 2019-01 to 2026-09  (run once, reported honestly)

Pass criteria per (indicator, lag):
  1. Granger F-test p < BONF_ALPHA  (Bonferroni for n_lags tested)
  2. OOS Pearson |r| >= OOS_CORR_MIN  (2019-09 holdout, never used for discovery)

If nothing passes for a commodity, we report "no significant leading indicators" — not a fabricated list.

Usage:
  python research/ml04.py
"""
import json
import sys
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats
from statsmodels.tsa.stattools import grangercausalitytests

warnings.filterwarnings('ignore', category=FutureWarning)

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).parent))
from ml01 import load, TARGETS, futures_monthly

OUT = ROOT / 'public' / 'indicators' / 'ml04.json'

DISCOVERY_END = pd.Period('2018-12', 'M')
OOS_START = pd.Period('2019-01', 'M')
MAX_LAG = 6
BONF_ALPHA = 0.05 / MAX_LAG   # ~0.0083
OOS_CORR_MIN = 0.15

INDICATOR_META = {
    'fgap':     ('Futures nowcast gap',       'End-of-month futures close minus monthly average. Converts stale monthly-avg prices into a timely correction.'),
    'fr1':      ('Futures return',            'Month-end futures log return. Captures momentum in forward prices.'),
    'xs_r1':    ('Cross-commodity momentum',  'Average return of all other tracked commodities. Measures broad macro sentiment.'),
    'brent':    ('Brent crude return',        'Log return of Brent crude. Energy is an input cost for food and freight.'),
    'natgas':   ('Natural gas return',        'Log return of US Henry Hub gas. Affects fertiliser (urea) and processing costs.'),
    'urea':     ('Urea return',               'Log return of urea (fertiliser). Leading cost input for grains.'),
    'indpro':   ('US Industrial Production',  'Log change in FRED INDPRO. Rising industrial output drives metals and energy demand.'),
    'napm':     ('ISM Manufacturing PMI',     'Log change in ISM PMI. Below 50 = contraction; strong leading indicator for base metals and energy.'),
    'fao_ffpi': ('FAO Food Price Index',      'Log change in FAO FFPI. Broad agricultural demand/supply signal for grains, oilseeds, and softs.'),
}


def granger_best_lag(predictor: pd.Series, target: pd.Series, max_lag: int) -> tuple[int, float]:
    df = pd.concat([target, predictor], axis=1).dropna()
    if len(df) < max_lag * 3 + 20:
        return 1, 1.0
    try:
        res = grangercausalitytests(df.values, maxlag=max_lag, verbose=False)
        best_lag = min(res, key=lambda lag: res[lag][0]['ssr_ftest'][1])
        return int(best_lag), float(res[best_lag][0]['ssr_ftest'][1])
    except Exception:
        return 1, 1.0


def oos_corr(predictor: pd.Series, target: pd.Series, lag: int) -> float:
    x_lag = predictor.shift(lag)
    df = pd.concat([target, x_lag], axis=1).dropna()
    df = df[df.index >= OOS_START]
    if len(df) < 15:
        return 0.0
    r, _ = stats.pearsonr(df.iloc[:, 0].values, df.iloc[:, 1].values)
    return float(r) if np.isfinite(r) else 0.0


def disc_corr(predictor: pd.Series, target: pd.Series, lag: int) -> float:
    x_lag = predictor.shift(lag)
    df = pd.concat([target, x_lag], axis=1).dropna()
    df = df[df.index <= DISCOVERY_END]
    if len(df) < 10:
        return 0.0
    r, _ = stats.pearsonr(df.iloc[:, 0].values, df.iloc[:, 1].values)
    return float(r) if np.isfinite(r) else 0.0


def run():
    y_log, exog, unit = load()
    r = y_log.diff()
    fgap, fr1 = futures_monthly(y_log.index)

    commodities = {}

    for cid in TARGETS:
        target = r[cid]

        others = [c for c in TARGETS if c != cid]
        xs = r[others].mean(axis=1)

        predictors = {
            'fgap': fgap[cid],
            'fr1': fr1[cid],
            'xs_r1': xs,
            'brent': exog['brent'].diff(),
            'natgas': exog['natgas'].diff(),
            'urea': exog['urea'].diff(),
        }
        # Add demand indicators if available (loaded via ml01.py EXOG block)
        for _key in ('indpro', 'napm', 'fao_ffpi'):
            if _key in exog.columns:
                predictors[_key] = exog[_key].diff()

        indicators = []
        for key, pred in predictors.items():
            pred_disc = pred[pred.index <= DISCOVERY_END]
            tgt_disc = target[target.index <= DISCOVERY_END]

            lag, p = granger_best_lag(pred_disc, tgt_disc, MAX_LAG)
            passes_granger = p < BONF_ALPHA

            oc = oos_corr(pred, target, lag)
            passes_oos = abs(oc) >= OOS_CORR_MIN

            dc = disc_corr(pred, target, lag)

            if passes_granger and passes_oos:
                status = 'PASS'
            elif p < 0.10:
                status = 'MARGINAL'
            else:
                continue  # skip noise

            short, description = INDICATOR_META.get(key, (key, ''))
            indicators.append({
                'indicator': key,
                'name': short,
                'description': description,
                'lagMonths': lag,
                'discoveryCorr': round(dc, 3),
                'grangerP': round(p, 4),
                'grangerThreshold': round(BONF_ALPHA, 4),
                'oosCorr': round(oc, 3),
                'oosThreshold': OOS_CORR_MIN,
                'pass': passes_granger and passes_oos,
                'status': status,
                'direction': 'positive' if oc >= 0 else 'negative',
            })

        indicators.sort(key=lambda x: (not x['pass'], -abs(x['oosCorr'])))

        n_pass = sum(1 for i in indicators if i['pass'])
        commodities[cid] = {
            'series': TARGETS[cid],
            'unit': unit[cid],
            'nPass': n_pass,
            'indicators': indicators,
        }
        label = 'no significant indicators' if n_pass == 0 else f'{n_pass} pass'
        print(f'  {cid}: {label} ({len(indicators)} reach marginal)')

    OUT.parent.mkdir(parents=True, exist_ok=True)
    result = {
        'model': 'ML-04 Leading Indicators (Granger causality + OOS correlation)',
        'discoveryPeriod': '2000-01 to 2018-12',
        'oosPeriod': '2019-01 to 2026-09',
        'bonferroniAlpha': round(BONF_ALPHA, 4),
        'oosCorrMin': OOS_CORR_MIN,
        'commodities': commodities,
    }
    OUT.write_text(json.dumps(result, indent=2))
    print(f'Written: {OUT}')


if __name__ == '__main__':
    run()
