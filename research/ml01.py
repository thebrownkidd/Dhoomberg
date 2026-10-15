"""ML-01 commodity price forecast: data, features, models, leakage-safe backtest, export.

Usage:
  python research/ml01.py dev      # iterate here: origins 2006-01..2018-12, targets <= 2018-12
  python research/ml01.py final    # run once: origins 2019-01 onward
  python research/ml01.py export   # fit on all data, write public/forecast/ml01.json
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import Ridge

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / 'research' / 'data' / 'raw' / 'pinksheet.xlsx'
OUT = ROOT / 'public' / 'forecast' / 'ml01.json'

TARGETS = {
    # Energy
    'BRENT':      'Crude oil, Brent',
    'WTI':        'Crude oil, WTI',
    'DUBAI':      'Crude oil, Dubai',
    'COAL_AU':    'Coal, Australian',
    'NATGAS_US':  'Natural gas, US',
    'NATGAS_EU':  'Natural gas, Europe',
    # Vegetable oils & oilseeds
    'PALM':       'Palm oil',
    'SOYOIL':     'Soybean oil',
    'SOYBEANS':   'Soybeans',
    'SOYMEAL':    'Soybean meal',
    'COCONUT':    'Coconut oil',
    'GNUT_OIL':   'Groundnut oil',
    # Grains (BARLEY/SORGHUM excluded: Pink Sheet discontinued 2021, OOS period synthetic)
    'WHEAT':      'Wheat, US HRW',
    'WHEAT_SRW':  'Wheat, US SRW',
    'MAIZE':      'Maize',
    'RICE':       'Rice, Thai 5%',
    # Softs
    'SUGAR':      'Sugar, world',
    'SUGAR_US':   'Sugar, US',
    'COCOA':      'Cocoa',
    'COFFEE':     'Coffee, Arabica',
    'COFFEE_ROB': 'Coffee, Robusta',
    'COTTON':     'Cotton, A Index',
    'RUBBER':     'Rubber, RSS3',
    # Livestock & protein (SHRIMP excluded: Pink Sheet discontinued Nov 2024, OOS period synthetic)
    'BEEF':       'Beef',
    'CHICKEN':    'Chicken',
    'FISHMEAL':   'Fish meal',
    # Fertilizers
    'DAP':        'DAP',
    'TSP':        'TSP',
    'UREA':       'Urea',
    'POTASH':     'Potassium chloride',
    'PHOSPHATE':  'Phosphate rock',
    # Base metals
    'ALU':        'Aluminum',
    'COPPER':     'Copper',
    'NICKEL':     'Nickel',
    'ZINC':       'Zinc',
    'LEAD':       'Lead',
    'TIN':        'Tin',
    'IRON':       'Iron ore, cfr spot',
    # Precious metals
    'GOLD':       'Gold',
    'SILVER':     'Silver',
    'PLATINUM':   'Platinum',
    # Other
    'BANANA':     'Banana, US',
    'ORANGE':     'Orange',
    'TEA':        'Tea, avg 3 auctions',
    'TOBACCO':    'Tobacco, US import u.v.',
    'TIMBER_MY':  'Logs, Malaysian',
}
EXOG = {'brent': 'Crude oil, Brent', 'urea': 'Urea', 'natgas': 'Natural gas, US', 'copper': 'Copper', 'gold': 'Gold'}
# Daily front-month futures (Yahoo Finance). Commodities absent here get fgap=NaN (handled in build_panel).
# GC=GC=F (gold), NG=NG=F (natural gas), SI=SI=F, HG=HG=F, PL=PL=F — all downloaded with proper daily history.
FUTURES = {
    'SUGAR': ['SB'], 'COFFEE': ['KC'], 'COCOA': ['CC'], 'MAIZE': ['ZC'], 'WHEAT': ['KE'],
    'WHEAT_SRW': ['ZW'], 'SOYOIL': ['ZL'], 'PALM': ['ZL'], 'SOYBEANS': ['ZS'], 'SOYMEAL': ['ZM'],
    'BRENT': ['BZ', 'CL'], 'WTI': ['CL'], 'COTTON': ['CT'], 'RICE': ['ZR'], 'ALU': ['ALI'],
    'NATGAS_US': ['NG'], 'COPPER': ['HG'], 'GOLD': ['GC'], 'SILVER': ['SI'], 'PLATINUM': ['PL'],
}
HORIZONS = list(range(1, 13))
REPORT_H = [1, 3, 6, 12]
START = pd.Period('1980-01', 'M')
FIRST_OOS = pd.Period('1995-01', 'M')      # OOS predictions start here to warm up interval calibration
DEV = (pd.Period('2006-01', 'M'), pd.Period('2018-12', 'M'))
FINAL_START = pd.Period('2019-01', 'M')
CALIB_MONTHS = int(__import__('os').environ.get('CALIB', 120))
COVER_LO, COVER_HI = 0.10, 0.90


def load():
    raw = pd.read_excel(RAW, sheet_name='Monthly Prices', header=None)
    hdr = raw.iloc[4].tolist()
    units = raw.iloc[5].tolist()
    idx = pd.PeriodIndex([str(d).replace('M', '-') for d in raw.iloc[6:, 0]], freq='M')

    def _find_col(name):
        """Fuzzy column lookup: exact, then strip trailing ** and spaces."""
        target = name.strip()
        for i, h in enumerate(hdr):
            if isinstance(h, str) and h.strip() == target:
                return i
        target_norm = target.rstrip('* ').strip()
        for i, h in enumerate(hdr):
            if isinstance(h, str) and h.strip().rstrip('* ').strip() == target_norm:
                return i
        raise ValueError(f'Pink Sheet column not found: {name!r}')

    def col(name):
        i = _find_col(name)
        return pd.Series(pd.to_numeric(raw.iloc[6:, i], errors='coerce').values, index=idx)

    prices = pd.DataFrame({k: col(v) for k, v in TARGETS.items()})
    exog = pd.DataFrame({k: col(v) for k, v in EXOG.items()})
    unit = {k: str(units[_find_col(v)]).strip('()') for k, v in TARGETS.items()}

    prices, exog = prices.loc[START:], exog.loc[START:]

    # Supplement exog with USD/JPY (dollar-strength proxy) from Yahoo daily file
    _usdj = ROOT / 'research' / 'data' / 'raw' / 'yahoo' / 'USDJPY.json'
    if _usdj.exists():
        try:
            _d = json.loads(_usdj.read_text())['chart']['result'][0]
            _ts = pd.to_datetime(_d['timestamp'], unit='s', utc=True).tz_convert('America/New_York').tz_localize(None).normalize()
            _s = pd.Series(np.array(_d['indicators']['quote'][0]['close'], dtype=float), index=_ts).dropna()
            _s = _s[_s > 0]
            _monthly = np.log(_s).groupby(_s.index.to_period('M')).last()
            exog['usdj'] = _monthly.reindex(prices.index).ffill().bfill()
        except Exception as _e:
            print(f'Warning: USDJPY skipped ({_e})')

    # Supplement exog with FRED demand indicators (INDPRO, NAPM/ISM PMI, FAO FFPI)
    _demand_dir = ROOT / 'research' / 'data' / 'raw' / 'demand'
    _demand_series = [
        ('indpro',   'INDPRO'),       # US industrial production — demand for metals/energy
        ('napm',     'NAPM'),         # ISM Manufacturing PMI — leading industrial demand
        ('fao_ffpi', 'FAO_FFPI'),     # FAO Food Price Index — agricultural demand
    ]
    for _key, _fname in _demand_series:
        _f = _demand_dir / f'{_fname}.json'
        if not _f.exists():
            continue
        try:
            _d = json.loads(_f.read_text())
            _s = pd.Series(
                _d['values'],
                index=pd.PeriodIndex(_d['dates'], freq='M'),
                dtype=float,
            ).dropna()
            _s = _s[_s > 0]
            exog[_key] = np.log(_s).reindex(prices.index).ffill().bfill()
        except Exception as _e:
            print(f'Warning: {_fname} skipped ({_e})')

    # Fill short gaps (up to 12 months) — some series start later or have quarterly reporting
    gaps = prices.isna().sum()
    if gaps.any():
        print('Gap-filling (months):', {k: int(v) for k, v in gaps[gaps > 0].items()})
    prices = prices.ffill(limit=12).bfill(limit=3)

    # Drop any series still >30% NaN after filling (too short or discontinued)
    frac = prices.isna().mean()
    drop = frac[frac > 0.3].index.tolist()
    if drop:
        print(f'WARNING: dropping {drop} (>30% NaN after ffill)')
        prices = prices.drop(columns=drop)

    return np.log(prices), np.log(exog.ffill()), unit


def daily_futures(sym):
    d = json.loads((ROOT / 'research' / 'data' / 'raw' / 'yahoo' / f'{sym}.json').read_text())['chart']['result'][0]
    ts = pd.to_datetime(d['timestamp'], unit='s', utc=True).tz_convert('America/New_York').tz_localize(None).normalize()
    s = pd.Series(np.array(d['indicators']['quote'][0]['close'], dtype=float), index=ts).dropna()
    return np.log(s[s > 0])


def futures_monthly(index, through=None):
    """Per commodity: fgap = last daily log close of month t minus that month's average log close; fr1 = month-end return.
    Only daily prices dated inside month t are used for origin t.
    All TARGETS columns are present; commodities without futures data have NaN (f_avail=0 in build_panel)."""
    all_cols = list(TARGETS.keys())
    gap = pd.DataFrame(np.nan, index=index, columns=all_cols)
    fr1 = pd.DataFrame(np.nan, index=index, columns=all_cols)
    for c, syms in FUTURES.items():
        if c not in all_cols:
            continue
        g = pd.Series(np.nan, index=index); r = pd.Series(np.nan, index=index)
        for sym in reversed(syms):                       # first symbol wins where both exist
            s = daily_futures(sym)
            if through is not None:
                s = s[s.index <= through]
            m = s.groupby(s.index.to_period('M'))
            last, avg = m.last(), m.mean()
            g.update((last - avg).reindex(index)); r.update(last.diff().reindex(index))
        gap[c], fr1[c] = g, r
    # Restrict to columns that are actually in the loaded price data
    return gap, fr1


def build_panel(y, ex, fgap=None, ffr1=None):
    """One row per (origin month t, commodity). Every feature uses data at or before t only."""
    r = lambda s, k: s - s.shift(k)
    ret = y.diff()
    rows = []
    for c in y.columns:
        s = y[c]
        f = pd.DataFrame(index=y.index)
        f['r1'], f['r3'], f['r6'], f['r12'] = r(s, 1), r(s, 3), r(s, 6), r(s, 12)
        f['r1_lag1'] = f['r1'].shift(1)
        f['dev12'] = s - s.rolling(12).mean()
        f['dev60'] = s - s.rolling(60).mean()
        f['dev120'] = s - s.rolling(120).mean()
        f['vol12'] = ret[c].rolling(12).std()
        for e in ex.columns:
            f[f'{e}_r1'], f[f'{e}_r3'] = r(ex[e], 1), r(ex[e], 3)
        f['xs_r1'] = ret.drop(columns=c).mean(axis=1)          # other commodities' average move
        f['xs_r3'] = (y - y.shift(3)).drop(columns=c).mean(axis=1)
        for h in HORIZONS:
            # Same-calendar-month h-step change averaged over the previous 10 years (all <= t).
            past = [s.shift(12 * k - h) - s.shift(12 * k) for k in range(max(1, -(-h // 12)), 11)]
            f[f'seas{h}'] = pd.concat(past, axis=1).mean(axis=1)
            f[f'tgt{h}'] = s.shift(-h) - s
        if fgap is not None:
            f['f_avail'] = fgap[c].notna().astype(float)
            f['fgap'] = fgap[c].fillna(0.0)
            f['fr1'] = ffr1[c].fillna(0.0)
        f['commodity'] = c
        f['month'] = f.index.month
        rows.append(f)
    panel = pd.concat(rows).reset_index(names='origin')
    return panel


FUT_FEATS = ['fgap', 'fr1', 'f_avail']
BASE_FEATS = FUT_FEATS + ['r1', 'r1_lag1', 'r3', 'r6', 'r12', 'dev12', 'dev60', 'dev120', 'vol12', 'xs_r1', 'xs_r3'] + \
    [f'{e}_{k}' for e in EXOG for k in ('r1', 'r3')]


def feats(h):
    return BASE_FEATS + [f'seas{h}']


class Ridge_:
    name = 'ridge'
    def fit(self, X, y):
        self.mu, self.sd = X.mean(0), X.std(0) + 1e-9
        self.m = Ridge(alpha=50.0).fit((X - self.mu) / self.sd, y)
        return self
    def predict(self, X):
        return self.m.predict((X - self.mu) / self.sd)


class GBM_:
    name = 'gbm'
    def fit(self, X, y):
        self.m = HistGradientBoostingRegressor(max_depth=3, learning_rate=0.03, max_iter=300,
                                               min_samples_leaf=80, l2_regularization=1.0, random_state=0).fit(X, y)
        return self
    def predict(self, X):
        return self.m.predict(X)


LEAN_FEATS = ['fgap', 'fr1', 'f_avail', 'r1', 'r1_lag1', 'xs_r1']


class Lean_:
    """Small ridge on the few features with a clear mechanism; less estimation noise at long horizons."""
    name = 'lean'
    cols = None
    def fit(self, X, y):
        self.mu, self.sd = X[:, self.cols].mean(0), X[:, self.cols].std(0) + 1e-9
        self.m = Ridge(alpha=10.0).fit((X[:, self.cols] - self.mu) / self.sd, y)
        return self
    def predict(self, X):
        return self.m.predict((X[:, self.cols] - self.mu) / self.sd)


MODELS = [Ridge_, GBM_, Lean_]
PRIMARY = 'final'


def oos_predictions(panel, origins_until):
    """Expanding-window, refit every January. A training row (s, h) is used at origin t only if s + h <= t."""
    preds = []
    origins = sorted(o for o in panel['origin'].unique() if FIRST_OOS <= o <= origins_until)
    years = sorted({o.year for o in origins})
    for h in HORIZONS:
        fs, tgt = feats(h), f'tgt{h}'
        data = panel.dropna(subset=fs)
        for yr in years:
            fit_at = pd.Period(f'{yr}-01', 'M')
            train = data[(data['origin'] + h <= fit_at - 1) & data[tgt].notna()]
            test = data[(data['origin'].dt.year == yr) & (data['origin'] <= origins_until)]
            if test.empty:
                continue
            assert (train['origin'] + h < test['origin'].min()).all(), 'training target overlaps test origin'
            X, Xt = train[fs].to_numpy(), test[fs].to_numpy()
            out = test[['origin', 'commodity', tgt, 'vol12']].rename(columns={tgt: 'actual'}).copy()
            out['h'] = h
            Lean_.cols = [fs.index(c) for c in LEAN_FEATS]
            for M in MODELS:
                out[M.name] = M().fit(X, train[tgt].to_numpy()).predict(Xt)
            out['ens'] = out[['ridge', 'gbm']].mean(axis=1)
            preds.append(out)
    return pd.concat(preds, ignore_index=True)


SHRINK_GRID = np.linspace(0, 1, 21)
# Per-horizon weight on the model vs naive, chosen on the DEV period only (see `dev` output) and frozen.
SHRINK_W = {1: 1.0, 2: 0.95, 3: 0.95, 4: 0.9, 5: 0.85, 6: 0.8, 7: 0.6, 8: 0.45, 9: 0.3, 10: 0.2, 11: 0.25, 12: 0.25}


def fit_shrink(p, col, lo, hi):
    d = p[(p['origin'] >= lo) & (p['origin'] + p['h'] <= hi)].dropna(subset=['actual'])
    w = {}
    for h in HORIZONS:
        g = d[d['h'] == h]
        err = [np.abs(g['actual'] - k * g[col]).mean() for k in SHRINK_GRID]
        w[h] = round(float(SHRINK_GRID[int(np.argmin(err))]), 2)
    return w


def shrink(p, col, w):
    p = p.reset_index(drop=True)
    p['w'] = p['h'].map(w)
    p['final'] = p['w'] * p[col]
    return p


def add_intervals(p, col):
    """Conformal-style band: quantiles of past standardized OOS errors whose targets were realized by t."""
    p = p.reset_index(drop=True)
    oi = np.array([o.ordinal for o in p['origin']])
    z = ((p['actual'] - p[col]) / p['vol12']).to_numpy()
    hs = p['h'].to_numpy()
    lo, hi = np.full(len(p), np.nan), np.full(len(p), np.nan)
    for h in HORIZONS:
        mh = hs == h
        for t in np.unique(oi[mh]):
            known = mh & (oi + h <= t) & (oi > t - CALIB_MONTHS - h) & ~np.isnan(z)
            if known.sum() < 200:
                continue
            q = np.quantile(z[known], [COVER_LO, COVER_HI])
            sel = mh & (oi == t)
            lo[sel], hi[sel] = q
    p['zlo'], p['zhi'] = lo, hi
    return p


def dm_test(loss_model, loss_naive, h):
    """Diebold-Mariano with Harvey-Leybourne-Newbold correction; one-sided H1: model better."""
    d = loss_naive - loss_model
    n = len(d)
    dbar = d.mean()
    gamma = [np.sum((d[k:] - dbar) * (d[:n - k] - dbar)) / n for k in range(h)]
    var = (gamma[0] + 2 * sum(gamma[1:])) / n
    if var <= 0:
        return np.nan
    stat = dbar / np.sqrt(var) * np.sqrt((n + 1 - 2 * h + h * (h - 1) / n) / n)
    return 1 - stats.t.cdf(stat, df=n - 1)


def evaluate(p, lo, hi, label):
    p = p[(p['origin'] >= lo) & (p['origin'] <= hi) & (p['origin'] + p['h'] <= hi_target(hi, label))]
    p = p.dropna(subset=['actual'])
    rows = []
    for h in REPORT_H:
        g = p[p['h'] == h]
        row = {'h': h, 'n': len(g), 'origins': g['origin'].nunique()}
        naive_ae = g['actual'].abs()
        row['naive_mape'] = (np.abs(np.exp(-g['actual']) - 1)).mean() * 100
        for m in [M.name for M in MODELS] + ['ens', 'final']:
            ae = (g['actual'] - g[m]).abs()
            row[f'{m}_mape'] = (np.abs(np.exp(g[m] - g['actual']) - 1)).mean() * 100
            row[f'{m}_skill'] = (1 - ae.mean() / naive_ae.mean()) * 100
            dt = pd.DataFrame({'o': g['origin'], 'm': ae, 'n': naive_ae}).groupby('o').mean()
            row[f'{m}_dm_p'] = dm_test(dt['m'].to_numpy(), dt['n'].to_numpy(), h)
        gi = g.dropna(subset=['zlo'])
        inside = (gi['actual'] >= gi[PRIMARY] + gi['zlo'] * gi['vol12']) & (gi['actual'] <= gi[PRIMARY] + gi['zhi'] * gi['vol12'])
        row['coverage80'] = inside.mean() * 100
        row['w_mean'] = g['w'].mean()
        rows.append(row)
    res = pd.DataFrame(rows).set_index('h')
    pd.set_option('display.width', 250)
    print(f'\n=== {label} ===')
    print(res.round(3).to_string())
    per = []
    for c, g in p[p['h'].isin(REPORT_H)].groupby(['commodity', 'h']):
        per.append({'commodity': c[0], 'h': c[1], 'skill': (1 - (g['actual'] - g[PRIMARY]).abs().mean() / g['actual'].abs().mean()) * 100})
    print(pd.DataFrame(per).pivot(index='commodity', columns='h', values='skill').round(1).to_string())
    return res


def hi_target(hi, label):
    return hi if label.startswith('DEV') else pd.Period('2100-01', 'M')


def export(y, panel, unit):
    """Fit on all realized targets, forecast from the latest month, attach FINAL-period test metrics."""
    oos = pd.read_pickle(ROOT / 'research' / 'data' / 'final_oos.pkl')
    last = y.index[-1]
    lo_k, hi_k = FINAL_START, last
    horizons = []
    for h in HORIZONS:
        g = oos[(oos['h'] == h) & (oos['origin'] >= lo_k) & (oos['origin'] + h <= hi_k)].dropna(subset=['actual'])
        ae, nae = (g['actual'] - g['final']).abs(), g['actual'].abs()
        dt = pd.DataFrame({'o': g['origin'], 'm': ae, 'n': nae}).groupby('o').mean()
        gi = g.dropna(subset=['zlo'])
        cov = ((gi['actual'] >= gi['final'] + gi['zlo'] * gi['vol12']) &
               (gi['actual'] <= gi['final'] + gi['zhi'] * gi['vol12'])).mean() * 100
        skill = (1 - ae.mean() / nae.mean()) * 100
        dm = dm_test(dt['m'].to_numpy(), dt['n'].to_numpy(), h)
        per = {c: round((1 - (gc['actual'] - gc['final']).abs().mean() / gc['actual'].abs().mean()) * 100, 1)
               for c, gc in g.groupby('commodity')}
        horizons.append({'h': h, 'skill': round(skill, 1), 'dmP': round(float(dm), 4), 'coverage80': round(cov, 1),
                         'mape': round(float(np.abs(np.exp(g['final'] - g['actual']) - 1).mean() * 100), 2),
                         'naiveMape': round(float(np.abs(np.exp(-g['actual']) - 1).mean() * 100), 2),
                         'pass': bool(skill > 0 and dm < 0.05 and 75 <= cov <= 85), 'n': int(len(g)),
                         'perCommodity': per})

    commodities = {}
    active = list(y.columns)
    out_rows = {c: [] for c in active}
    for h in HORIZONS:
        fs, tgt = feats(h), f'tgt{h}'
        data = panel.dropna(subset=fs)
        train = data[(data['origin'] + h <= last) & data[tgt].notna()]
        now = data[data['origin'] == last].set_index('commodity')
        Lean_.cols = [fs.index(c) for c in LEAN_FEATS]
        model = Lean_().fit(train[fs].to_numpy(), train[tgt].to_numpy())
        pred = SHRINK_W[h] * model.predict(now[fs].to_numpy())
        o = oos[(oos['h'] == h) & (oos['origin'] + h <= last) & (oos['origin'] > last - CALIB_MONTHS - h)]
        z = ((o['actual'] - o['final']) / o['vol12']).dropna().to_numpy()
        zlo, zhi = np.quantile(z, [COVER_LO, COVER_HI])
        for c, f in zip(now.index, pred):
            base, vol = y.loc[last, c], now.loc[c, 'vol12']
            out_rows[c].append({'date': str(last + h), 'p10': float(np.exp(base + f + zlo * vol)),
                                'p50': float(np.exp(base + f)), 'p90': float(np.exp(base + f + zhi * vol))})
    for c in active:
        hist = y[c].iloc[-60:]
        commodities[c] = {
            'series': TARGETS[c].strip(), 'unit': unit[c],
            'history': [{'date': str(d), 'close': round(float(np.exp(v)), 4)} for d, v in hist.items()],
            'forecast': [{k: (round(v, 4) if isinstance(v, float) else v) for k, v in r.items()} for r in out_rows[c]],
        }
    doc = {
        'model': 'Ridge + futures nowcast (ML-01 v1)',
        'source': 'World Bank Pink Sheet (monthly avg, nominal USD) + Yahoo Finance front-month futures',
        'dataThrough': str(last),
        'testPeriod': f'{FINAL_START}..{last}',
        'criteria': 'skill > 0 vs naive, Diebold-Mariano p < 0.05, 80% band coverage 75-85%',
        'horizons': horizons,
        'commodities': commodities,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, indent=1))
    print('wrote', OUT, '| data through', last, '| passing horizons:', [x['h'] for x in horizons if x['pass']])


def main(stage):
    y, ex, unit = load()
    last = y.index[-1]
    fgap, ffr1 = futures_monthly(y.index)
    # Align futures columns to loaded price columns (some targets may have been dropped)
    fgap = fgap.reindex(columns=y.columns)
    ffr1 = ffr1.reindex(columns=y.columns)
    if __import__('os').environ.get('PLACEBO'):
        rng = np.random.default_rng(0)
        for c in fgap.columns:                          # scramble futures info across time, keep availability
            ok = fgap[c].notna().to_numpy()
            perm = rng.permutation(np.where(ok)[0])
            fgap.loc[ok, c] = fgap[c].to_numpy()[perm]; ffr1.loc[ok, c] = ffr1[c].to_numpy()[perm]
    panel = build_panel(y, ex, fgap, ffr1)
    if stage == 'dev':
        oos = oos_predictions(panel, DEV[1])
        w = fit_shrink(oos, 'lean', *DEV)
        print('SHRINK_W (paste into script) =', w)
        p = add_intervals(shrink(oos, 'lean', w), PRIMARY)
        evaluate(p, DEV[0], DEV[1], 'DEV 2006-01..2018-12')
    elif stage == 'final':
        assert len(SHRINK_W) == len(HORIZONS), 'freeze SHRINK_W from the dev run first'
        p = add_intervals(shrink(oos_predictions(panel, last), 'lean', SHRINK_W), PRIMARY)
        evaluate(p, FINAL_START, last, f'FINAL {FINAL_START}..{last}')
        p.to_pickle(ROOT / 'research' / 'data' / 'final_oos.pkl')
    elif stage == 'export':
        export(y, panel, unit)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'dev')
