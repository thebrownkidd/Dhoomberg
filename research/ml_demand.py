"""ML-Demand: Process demand-side indicators into UI-ready JSON.

Reads:
  research/data/raw/demand/INDPRO.json        FRED US Industrial Production
  research/data/raw/demand/NAPM.json          FRED ISM Manufacturing PMI
  research/data/raw/demand/WTISTUS.json       FRED EIA crude inventories
  research/data/raw/demand/UMCSENT.json       FRED U Michigan Consumer Sentiment
  research/data/raw/demand/USALOLITONOSTSAM.json  FRED OECD CLI
  research/data/raw/demand/FAO_FFPI.json      FAO Food Price Index
  research/data/raw/demand/cot.json           CFTC COT disaggregated

Writes:
  public/demand/demand.json

Usage:
  python research/ml_demand.py
"""
import json
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / 'research' / 'data' / 'raw' / 'demand'
OUT = ROOT / 'public' / 'demand' / 'demand.json'

HISTORY_MONTHS = 60  # 5 years in UI sparklines
COT_CROWDED_PCT = 15.0  # net long > 15% of OI = crowded

# Demand shock alert thresholds (pre-registered)
PMI_CONTRACT_THRESHOLD = 48.5    # ISM PMI below this = contraction
PMI_CONTRACT_STREAK = 2          # consecutive months
INDPRO_YOY_WEAK = -0.5           # INDPRO year-on-year % below this = weak
UMCSENT_DROP = -5.0              # 3-month sentiment drop triggers alert
COT_CROWDED_LONG = 15.0          # % of OI
COT_CROWDED_SHORT = -15.0        # negative = net short

# COT commodity labels for UI
COT_LABELS = {
    'GOLD': 'Gold (COMEX)', 'SILVER': 'Silver (COMEX)', 'COPPER': 'Copper (COMEX)',
    'WTI': 'WTI Crude (NYMEX)', 'BRENT': 'Brent Crude (ICE)',
    'NATGAS_US': 'Natural Gas (NYMEX)', 'MAIZE': 'Corn (CBOT)',
    'WHEAT_SRW': 'Wheat SRW (CBOT)', 'WHEAT': 'Wheat HRW (CBOT)',
    'SOYBEANS': 'Soybeans (CBOT)', 'SOYOIL': 'Soybean Oil (CBOT)',
    'SOYMEAL': 'Soybean Meal (CBOT)', 'SUGAR': 'Sugar No.11 (ICE)',
    'COFFEE': 'Coffee C (ICE)', 'COCOA': 'Cocoa (ICE)',
    'COTTON': 'Cotton No.2 (ICE)', 'PLATINUM': 'Platinum (NYMEX)',
}

# Which commodities are most affected by which demand signals
SIGNAL_COMMODITIES = {
    'pmi_contraction': ['ALU', 'COPPER', 'NICKEL', 'ZINC', 'IRON', 'LEAD', 'TIN'],
    'indpro_weak': ['ALU', 'COPPER', 'NICKEL', 'BRENT', 'WTI', 'COAL_AU'],
    'sentiment_drop': ['SUGAR', 'COCOA', 'COFFEE', 'COTTON', 'RUBBER'],
    'fao_spike': ['WHEAT', 'MAIZE', 'RICE', 'SUGAR', 'PALM', 'SOYOIL'],
}


def load_fred(series_id):
    f = RAW / f'{series_id}.json'
    if not f.exists():
        return None
    d = json.loads(f.read_text())
    s = pd.Series(d['values'], index=pd.PeriodIndex(d['dates'], freq='M'), dtype=float)
    return s, d['name'], d['source']


def series_stats(s, window=HISTORY_MONTHS):
    """Return recent stats and history for a numeric series."""
    s = s.dropna()
    if s.empty:
        return None
    latest_val = float(s.iloc[-1])
    latest_date = str(s.index[-1])
    mom = float(s.iloc[-1] - s.iloc[-2]) if len(s) >= 2 else 0.0
    yoy = float(s.iloc[-1] - s.iloc[-13]) if len(s) >= 13 else 0.0
    hist = s.iloc[-window:]
    history = [{'date': str(d), 'value': round(float(v), 2)} for d, v in hist.items()]
    return {
        'latest': round(latest_val, 2),
        'latestDate': latest_date,
        'mom': round(mom, 3),
        'yoy': round(yoy, 3),
        'history': history,
    }


def process_napm(s):
    """ISM PMI: add expanding flag and streak count."""
    stats = series_stats(s)
    if stats is None:
        return None
    latest = stats['latest']
    stats['threshold'] = 50
    stats['expanding'] = latest >= 50
    # Count consecutive months above/below 50
    recent = s.dropna().iloc[-12:]
    streak = 0
    direction = latest >= 50
    for v in reversed(recent.values):
        if (v >= 50) == direction:
            streak += 1
        else:
            break
    stats['streak'] = streak
    stats['streakDirection'] = 'expanding' if direction else 'contracting'
    return stats


def process_wtistus(s):
    """EIA crude inventories: weekly → monthly last, add weekly change."""
    # s may be weekly; resample to monthly
    if s.index.freqstr == 'W-FRI' or len(s) > 2 * 12 * 30:
        # weekly data: get last obs per month
        s_daily = s.copy()
        s_daily.index = pd.DatetimeIndex([p.to_timestamp() for p in s_daily.index])
        s_m = s_daily.resample('ME').last()
        s_m.index = s_m.index.to_period('M')
        s = s_m.dropna()
    stats = series_stats(s)
    if stats is None:
        return None
    # Latest weekly change: compare last two observations of original series
    try:
        raw = RAW / 'WTISTUS.json'
        d = json.loads(raw.read_text())
        vals = d['values']
        if len(vals) >= 2:
            stats['weekChange'] = round(float(vals[-1] - vals[-2]), 0)
            stats['weekChangePct'] = round((vals[-1] - vals[-2]) / vals[-2] * 100, 2) if vals[-2] else 0.0
            stats['direction'] = 'draw' if vals[-1] < vals[-2] else 'build'
        else:
            stats['weekChange'] = 0
            stats['weekChangePct'] = 0.0
            stats['direction'] = 'flat'
    except Exception:
        pass
    return stats


def process_cot():
    f = RAW / 'cot.json'
    if not f.exists():
        return {}
    raw = json.loads(f.read_text())
    out = {}
    for cid, rec in raw.items():
        if not rec['dates']:
            continue
        dates = rec['dates']
        mm_long = rec['mmLong']
        mm_short = rec['mmShort']
        oi = rec['openInterest']
        # Latest week
        net = mm_long[-1] - mm_short[-1]
        oi_latest = oi[-1]
        net_pct = (net / oi_latest * 100) if oi_latest else 0.0
        week_change = (mm_long[-1] - mm_short[-1]) - (mm_long[-2] - mm_short[-2]) if len(dates) >= 2 else 0
        crowded_long = net_pct >= COT_CROWDED_LONG
        crowded_short = net_pct <= COT_CROWDED_SHORT
        # 12-week history of net position
        hist = [
            {'date': dates[i], 'netLong': int(mm_long[i] - mm_short[i]), 'oi': int(oi[i])}
            for i in range(max(0, len(dates) - 12), len(dates))
        ]
        out[cid] = {
            'name': COT_LABELS.get(cid, cid),
            'latestDate': dates[-1],
            'netLong': int(net),
            'openInterest': int(oi_latest),
            'netLongPct': round(net_pct, 1),
            'weekChange': int(week_change),
            'crowdedLong': crowded_long,
            'crowdedShort': crowded_short,
            'history': hist,
        }
    return out


def compute_alerts(napm_stats, indpro_stats, umcsent_stats, fao_stats, cot):
    alerts = []

    if napm_stats:
        pmi = napm_stats['latest']
        streak = napm_stats.get('streak', 0)
        direction = napm_stats.get('streakDirection', '')
        if pmi < PMI_CONTRACT_THRESHOLD and direction == 'contracting' and streak >= PMI_CONTRACT_STREAK:
            alerts.append({
                'id': 'pmi_contraction',
                'type': 'PMI_CONTRACTION',
                'severity': 'RED' if pmi < 46 else 'AMBER',
                'title': 'Manufacturing PMI in contraction',
                'message': f'ISM PMI at {pmi:.1f} — contracting for {streak} consecutive months. Reduces demand for base metals, energy, packaging.',
                'commodities': SIGNAL_COMMODITIES['pmi_contraction'],
                'value': round(pmi, 1),
                'threshold': PMI_CONTRACT_THRESHOLD,
            })

    if indpro_stats:
        yoy_pct = indpro_stats['yoy'] / indpro_stats['latest'] * 100 if indpro_stats['latest'] else 0
        if yoy_pct < INDPRO_YOY_WEAK:
            alerts.append({
                'id': 'indpro_weak',
                'type': 'INDPRO_WEAK',
                'severity': 'AMBER',
                'title': 'Industrial production contracting year-on-year',
                'message': f'US INDPRO {yoy_pct:+.1f}% YoY. Signals reduced input material demand across metals and energy.',
                'commodities': SIGNAL_COMMODITIES['indpro_weak'],
                'value': round(yoy_pct, 2),
                'threshold': INDPRO_YOY_WEAK,
            })

    if umcsent_stats and len(umcsent_stats.get('history', [])) >= 3:
        hist = umcsent_stats['history']
        drop_3m = hist[-1]['value'] - hist[-3]['value']
        if drop_3m < UMCSENT_DROP:
            alerts.append({
                'id': 'sentiment_drop',
                'type': 'CONSUMER_SENTIMENT_DROP',
                'severity': 'AMBER',
                'title': 'Consumer sentiment falling',
                'message': f'Michigan Consumer Sentiment dropped {drop_3m:.1f} pts over 3 months. Reduces end-demand for softs and discretionary commodities.',
                'commodities': SIGNAL_COMMODITIES['sentiment_drop'],
                'value': round(umcsent_stats['latest'], 1),
                'threshold': umcsent_stats['latest'] - UMCSENT_DROP,
            })

    if fao_stats:
        yoy_pct = fao_stats['yoy'] / fao_stats['latest'] * 100 if fao_stats['latest'] else 0
        if yoy_pct > 5.0:
            alerts.append({
                'id': 'fao_spike',
                'type': 'FAO_FOOD_PRICE_SPIKE',
                'severity': 'RED' if yoy_pct > 15 else 'AMBER',
                'title': 'FAO Food Price Index rising sharply',
                'message': f'FAO FFPI at {fao_stats["latest"]:.0f}, {yoy_pct:+.1f}% YoY. Food price inflation signal for agricultural commodities.',
                'commodities': SIGNAL_COMMODITIES['fao_spike'],
                'value': round(fao_stats['latest'], 1),
                'threshold': 0,
            })

    # COT crowded alerts
    for cid, rec in cot.items():
        if rec.get('crowdedLong'):
            alerts.append({
                'id': f'cot_crowded_{cid}',
                'type': 'COT_CROWDED_LONG',
                'severity': 'AMBER',
                'title': f'Speculative {rec["name"]} longs crowded',
                'message': f'Managed money net long = {rec["netLongPct"]:.1f}% of open interest. Crowded positioning increases reversal risk.',
                'commodities': [cid],
                'value': rec['netLongPct'],
                'threshold': COT_CROWDED_LONG,
            })
        elif rec.get('crowdedShort'):
            alerts.append({
                'id': f'cot_crowded_short_{cid}',
                'type': 'COT_CROWDED_SHORT',
                'severity': 'AMBER',
                'title': f'Speculative {rec["name"]} shorts crowded',
                'message': f'Managed money net short = {rec["netLongPct"]:.1f}% of open interest. Crowded shorts risk a squeeze rally.',
                'commodities': [cid],
                'value': rec['netLongPct'],
                'threshold': COT_CROWDED_SHORT,
            })

    return alerts


def run():
    # Load each series
    print('Loading demand data...')

    indpro_raw = load_fred('INDPRO')
    napm_raw = load_fred('NAPM')
    wtistus_raw = load_fred('WTISTUS')
    umcsent_raw = load_fred('UMCSENT')
    oecd_raw = load_fred('USALOLITONOSTSAM')
    fao_raw = load_fred('FAO_FFPI')

    def report(name, raw):
        if raw:
            s, lbl, src = raw
            print(f'  {name}: {len(s)} months, through {str(s.dropna().index[-1]) if not s.dropna().empty else "n/a"}')
        else:
            print(f'  {name}: NOT FOUND (run fetch_demand.py)')

    report('INDPRO', indpro_raw)
    report('NAPM', napm_raw)
    report('WTISTUS', wtistus_raw)
    report('UMCSENT', umcsent_raw)
    report('OECD CLI', oecd_raw)
    report('FAO FFPI', fao_raw)

    # Process each series
    series = {}

    if indpro_raw:
        s, name, src = indpro_raw
        st = series_stats(s)
        if st:
            st['name'] = name
            st['source'] = src
            st['unit'] = 'Index (2017=100)'
            series['INDPRO'] = st

    if napm_raw:
        s, name, src = napm_raw
        st = process_napm(s)
        if st:
            st['name'] = name
            st['source'] = src
            st['unit'] = 'Index (50=neutral)'
            series['NAPM'] = st

    if wtistus_raw:
        s, name, src = wtistus_raw
        st = process_wtistus(s)
        if st:
            st['name'] = name
            st['source'] = src
            st['unit'] = 'Thousand Barrels'
            series['WTISTUS'] = st

    if umcsent_raw:
        s, name, src = umcsent_raw
        st = series_stats(s)
        if st:
            st['name'] = name
            st['source'] = src
            st['unit'] = 'Index (1966=100)'
            series['UMCSENT'] = st

    if oecd_raw:
        s, name, src = oecd_raw
        st = series_stats(s)
        if st:
            st['name'] = name
            st['source'] = src
            st['unit'] = 'Index (100=trend)'
            series['OECD_CLI'] = st

    if fao_raw:
        s, name, src = fao_raw
        st = series_stats(s)
        if st:
            st['name'] = name
            st['source'] = src
            st['unit'] = 'Index (2014-2016=100)'
            series['FAO_FFPI'] = st

    # Process COT
    print('Processing COT...')
    cot = process_cot()
    print(f'  COT: {len(cot)} commodities')

    # Compute alerts
    napm_stats = series.get('NAPM')
    indpro_stats = series.get('INDPRO')
    umcsent_stats = series.get('UMCSENT')
    fao_stats = series.get('FAO_FFPI')
    alerts = compute_alerts(napm_stats, indpro_stats, umcsent_stats, fao_stats, cot)
    print(f'  Alerts generated: {len(alerts)}')

    doc = {
        'model': 'ML-Demand v0.1',
        'source': 'FRED, CFTC, FAO',
        'asOf': str(pd.Period.now('M')),
        'series': series,
        'cot': cot,
        'alerts': alerts,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, indent=1))
    print(f'Written: {OUT}')
    print(f'  {len(series)} series, {len(cot)} COT contracts, {len(alerts)} alerts')


if __name__ == '__main__':
    run()
