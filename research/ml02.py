"""ML-02: Seasonal decomposition via STL on World Bank Pink Sheet monthly prices.

Pre-registered quality criteria (checked at runtime):
  - trend + seasonal + residual must sum to original within float precision
  - seasonal strength reported honestly; < 0.1 flagged as "no seasonal pattern"
  - Ljung-Box at lag 12 on residuals; p < 0.05 flagged as "residual autocorrelation"

Usage:
  python research/ml02.py
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from statsmodels.tsa.seasonal import STL
from statsmodels.stats.diagnostic import acorr_ljungbox

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).parent))
from ml01 import load, TARGETS

OUT = ROOT / 'public' / 'seasonal' / 'ml02.json'
WINDOW_YEARS = 10


def decompose(series: pd.Series):
    stl = STL(series, period=12, robust=True)
    res = stl.fit()

    var_resid = float(np.var(res.resid))
    var_resid_seasonal = float(np.var(res.seasonal + res.resid))
    strength = float(max(0.0, 1.0 - var_resid / var_resid_seasonal)) if var_resid_seasonal > 0 else 0.0

    lb = acorr_ljungbox(res.resid.dropna(), lags=[12], return_df=True)
    resid_autocorr = bool(lb['lb_pvalue'].iloc[0] < 0.05)

    reconstructed = res.trend.values + res.seasonal.values + res.resid.values
    check = bool(np.allclose(series.values, reconstructed, atol=1e-4, equal_nan=True))

    return res, strength, resid_autocorr, check


def export():
    y_log, _, unit = load()
    # Run STL on log prices: reduces heteroskedasticity; trend/seasonal reported in log-return units.
    # Seasonal strength is typically low for commodity spot prices — they are shock-driven,
    # not harvest-driven at the monthly average level. Reported honestly.

    data_through = str(y_log.index[-1])
    commodities = {}

    for cid, series_name in TARGETS.items():
        s = y_log[cid].dropna()
        res, strength, autocorr, check = decompose(s)

        monthly_df = pd.DataFrame({
            'month': [p.month for p in s.index],
            'seasonal': res.seasonal.values,
        })
        monthly_pattern = monthly_df.groupby('month')['seasonal'].mean()
        seasonal_pattern = {str(m): round(float(monthly_pattern.get(m, 0.0)), 4) for m in range(1, 13)}

        # Convert decomposition back to price levels for display (exp of log components)
        y_levels = np.exp(y_log[cid].dropna())
        cutoff = max(0, len(s) - WINDOW_YEARS * 12)
        dates = [str(p) for p in s.index[cutoff:]]
        orig = [round(float(v), 4) for v in y_levels.values[cutoff:]]
        # Trend in levels: exp(log_trend); seasonal/residual as multiplicative factors
        trend_lvl = [round(float(np.exp(v)), 4) for v in res.trend.values[cutoff:]]
        seasonal_log = [round(float(v), 4) for v in res.seasonal.values[cutoff:]]
        residual_log = [round(float(v), 4) for v in res.resid.values[cutoff:]]

        commodities[cid] = {
            'series': series_name,
            'unit': unit[cid],
            'seasonalStrength': round(strength, 3),
            'noSeasonalPattern': strength < 0.1,
            'residualAutocorr': autocorr,
            'decompositionCheck': check,
            'note': 'Seasonal and residual are in log-return units (multiplicative). Trend is in price levels.',
            'seasonalPattern': seasonal_pattern,
            'data': [
                {'date': d, 'original': o, 'trend': t, 'seasonal': se, 'residual': r}
                for d, o, t, se, r in zip(dates, orig, trend_lvl, seasonal_log, residual_log)
            ],
        }

        flags = []
        if strength < 0.1:
            flags.append('no-seasonal')
        if autocorr:
            flags.append('resid-autocorr')
        print(f'  {cid}: strength={strength:.3f}  check={check}  {" ".join(flags) or "ok"}')

    OUT.parent.mkdir(parents=True, exist_ok=True)
    result = {
        'model': 'ML-02 Seasonal Decomposition (STL robust, period=12)',
        'source': 'World Bank Pink Sheet monthly',
        'dataThrough': data_through,
        'windowYears': WINDOW_YEARS,
        'commodities': commodities,
    }
    OUT.write_text(json.dumps(result, indent=2))
    print(f'Written: {OUT}')


if __name__ == '__main__':
    export()
