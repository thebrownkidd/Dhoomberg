"""Download/convert all supplementary data for ML models.

Sources:
  FRED  - DHHNGSP  (Henry Hub natural gas, daily, USD/mmbtu, 1997-)
  FRED  - GOLDAMGBD228NLBD (Gold AM fix London, USD/troy oz, 1968-)
  Yahoo - DX=F  (USD Index futures, daily)
  Yahoo - SI=F  (Silver futures, daily)  - explicit period1/period2
  Yahoo - HG=F  (Copper futures, daily)  - explicit period1/period2

Output: research/data/raw/yahoo/{sym}.json in Yahoo v8 format so
        daily_futures() in ml01.py can read them without changes.
"""
import calendar, csv, json, time, urllib.request, urllib.error, io
from datetime import date, datetime, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / 'research' / 'data' / 'raw' / 'yahoo'
OUT.mkdir(parents=True, exist_ok=True)

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json,text/csv',
}

P_START = int(datetime(2000, 1, 1, tzinfo=timezone.utc).timestamp())
P_END   = int(datetime(2027, 1, 1, tzinfo=timezone.utc).timestamp())


# ── helpers ──────────────────────────────────────────────────────────────────

def to_yahoo_json(timestamps, closes):
    """Wrap arrays in the Yahoo v8 chart JSON envelope."""
    return {
        "chart": {
            "result": [{
                "timestamp": [int(t) for t in timestamps],
                "indicators": {"quote": [{"close": [float(c) if c is not None else None for c in closes]}]}
            }]
        }
    }


def yahoo_fetch(symbol, period1=P_START, period2=P_END):
    url = (f'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}'
           f'?interval=1d&period1={period1}&period2={period2}')
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def fred_csv(series_id):
    url = f'https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}'
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode('utf-8')


def fred_to_yahoo(series_id, out_name, label=None):
    dest = OUT / f'{out_name}.json'
    label = label or series_id
    print(f'FRED  {label} -> {out_name}.json ...', end=' ', flush=True)
    try:
        raw = fred_csv(series_id)
        reader = csv.DictReader(io.StringIO(raw))
        ts, closes = [], []
        for row in reader:
            val = row.get(series_id) or list(row.values())[-1]
            if not val or val.strip() in ('.', ''):
                continue
            try:
                dt = datetime.strptime(row['DATE'].strip(), '%Y-%m-%d').replace(tzinfo=timezone.utc)
                ts.append(int(dt.timestamp()))
                closes.append(float(val))
            except (ValueError, KeyError):
                continue
        if not ts:
            print('FAIL (empty)')
            return
        dest.write_text(json.dumps(to_yahoo_json(ts, closes)), encoding='utf-8')
        d0 = datetime.utcfromtimestamp(ts[0]).strftime('%Y-%m')
        d1 = datetime.utcfromtimestamp(ts[-1]).strftime('%Y-%m')
        print(f'OK  {len(ts)} days  {d0}..{d1}')
    except Exception as e:
        print(f'ERR {e}')


def yahoo_to_file(symbol, out_name):
    dest = OUT / f'{out_name}.json'
    print(f'Yahoo {symbol} -> {out_name}.json ...', end=' ', flush=True)
    try:
        data = yahoo_fetch(symbol)
        res = (data.get('chart') or {}).get('result') or []
        if not res:
            print('FAIL (no result)')
            return
        r = res[0]
        ts = r.get('timestamp', [])
        closes = (r.get('indicators') or {}).get('quote', [{}])[0].get('close', [])
        if not ts:
            print('FAIL (empty timestamps)')
            return
        dest.write_text(json.dumps(data), encoding='utf-8')
        d0 = datetime.utcfromtimestamp(ts[0]).strftime('%Y-%m')
        d1 = datetime.utcfromtimestamp(ts[-1]).strftime('%Y-%m')
        # check if daily
        if len(ts) > 1:
            avg_gap = (ts[-1] - ts[0]) / (len(ts) - 1) / 86400
            granularity = f'~{avg_gap:.0f}d gap'
        else:
            granularity = '1 obs'
        print(f'OK  {len(ts)} obs  {d0}..{d1}  ({granularity})')
    except Exception as e:
        print(f'ERR {e}')


# ── main ──────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    # Yahoo: GC=F replaces bad monthly GC.json (gold, daily 2000-)
    yahoo_to_file('GC=F', 'GC')
    time.sleep(1.5)

    # Yahoo: NG=F replaces bad monthly NG.json (natural gas, daily 2000-)
    yahoo_to_file('NG=F', 'NG')
    time.sleep(1.5)

    # Yahoo: USDJPY=X — USD strength proxy for EXOG (daily 2000-)
    yahoo_to_file('USDJPY=X', 'USDJPY')
    time.sleep(1.5)

    # These were already downloaded correctly by fetch_yahoo.py:
    # SI.json (SI=F 6637 obs), HG.json (HG=F 6637 obs), PL.json (PL=F 6808 obs)

    print('\nDone.')
