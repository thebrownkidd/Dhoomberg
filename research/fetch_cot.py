"""Download CFTC Commitment of Traders (disaggregated futures-only) reports.

Source:  CFTC public website — annual ZIP files containing pipe-delimited text.
URL:     https://www.cftc.gov/files/dea/history/fut_disagg_txt_{YEAR}.zip
History: 2006-2016 bulk + annual from 2017 onward.

Output:  research/data/raw/demand/cot.json
  Format: {
    "<COMMODITY_KEY>": {
      "name": str,
      "dates": ["YYYY-MM-DD", ...],
      "mmLong": [int, ...],
      "mmShort": [int, ...],
      "openInterest": [int, ...]
    },
    ...
  }

Managed-money columns in disaggregated report:
  M_Money_Positions_Long_All   — managed money (hedge fund/CTA) long contracts
  M_Money_Positions_Short_All  — managed money short contracts
  Open_Interest_All            — total open interest

Usage:
  python research/fetch_cot.py
"""
import csv, io, json, time, urllib.request, zipfile
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / 'research' / 'data' / 'raw' / 'demand'
OUT.mkdir(parents=True, exist_ok=True)

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': '*/*',
}

# Map CFTC market name substrings to our commodity IDs
# Key = substring that must appear in the CFTC 'Market_and_Exchange_Names' field
MARKET_MAP = {
    'GOLD - COMMODITY EXCHANGE':         'GOLD',
    'SILVER - COMMODITY EXCHANGE':       'SILVER',
    'COPPER-GRADE #1':                   'COPPER',
    'CRUDE OIL, LIGHT SWEET':            'WTI',
    'BRENT CRUDE':                       'BRENT',
    'NATURAL GAS - NEW YORK':            'NATGAS_US',
    'CORN - CHICAGO BOARD':              'MAIZE',
    'WHEAT - CHICAGO BOARD':             'WHEAT_SRW',
    'WHEAT-HRW - CHICAGO BOARD':         'WHEAT',
    'SOYBEANS - CHICAGO BOARD':          'SOYBEANS',
    'SOYBEAN OIL - CHICAGO BOARD':       'SOYOIL',
    'SOYBEAN MEAL - CHICAGO BOARD':      'SOYMEAL',
    'SUGAR NO. 11 - ICE':                'SUGAR',
    'COFFEE C - ICE':                    'COFFEE',
    'COCOA - ICE':                       'COCOA',
    'COTTON NO. 2 - ICE':                'COTTON',
    'PLATINUM - NEW YORK MERCANTILE':    'PLATINUM',
}


def fetch_year(year):
    url = f'https://www.cftc.gov/files/dea/history/fut_disagg_txt_{year}.zip'
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def parse_zip(data):
    """Extract rows from a CFTC disaggregated futures ZIP file."""
    rows = []
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for fname in z.namelist():
            if fname.endswith('.txt') or fname.endswith('.csv'):
                with z.open(fname) as f:
                    reader = csv.DictReader(io.TextIOWrapper(f, encoding='latin-1'))
                    for row in reader:
                        rows.append(row)
    return rows


def match_market(name):
    for key, cid in MARKET_MAP.items():
        if key.upper() in name.upper():
            return cid
    return None


def run():
    records = {}  # {cid: {date: {mmL, mmS, oi}}}

    # 2006-2016 historical bulk file
    ranges = [('hist_2006_2016', '2006-2016')]
    # Annual from 2017
    for yr in range(2017, 2027):
        ranges.append((str(yr), str(yr)))

    for tag, label in ranges:
        if tag == 'hist_2006_2016':
            url_tag = 'hist_2006_2016'
        else:
            url_tag = tag
        url = f'https://www.cftc.gov/files/dea/history/fut_disagg_txt_{url_tag}.zip'
        print(f'CFTC  {label} ...', end=' ', flush=True)
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            rows = parse_zip(data)
            count = 0
            for row in rows:
                market = row.get('Market_and_Exchange_Names', '')
                cid = match_market(market)
                if cid is None:
                    continue
                date_str = row.get('Report_Date_as_YYYY_MM_DD', '').strip()
                if not date_str:
                    continue
                try:
                    mm_long = int(row.get('M_Money_Positions_Long_All', 0) or 0)
                    mm_short = int(row.get('M_Money_Positions_Short_All', 0) or 0)
                    oi = int(row.get('Open_Interest_All', 0) or 0)
                except (ValueError, TypeError):
                    continue
                if cid not in records:
                    records[cid] = {}
                records[cid][date_str] = {'mmL': mm_long, 'mmS': mm_short, 'oi': oi}
                count += 1
            print(f'OK  {count} rows matched')
        except urllib.error.HTTPError as e:
            print(f'HTTP {e.code}')
        except Exception as e:
            print(f'ERR {e}')
        time.sleep(1.5)

    # Convert to sorted lists
    out = {}
    for cid, dmap in records.items():
        sorted_dates = sorted(dmap.keys())
        out[cid] = {
            'name': cid,
            'dates': sorted_dates,
            'mmLong': [dmap[d]['mmL'] for d in sorted_dates],
            'mmShort': [dmap[d]['mmS'] for d in sorted_dates],
            'openInterest': [dmap[d]['oi'] for d in sorted_dates],
        }

    dest = OUT / 'cot.json'
    dest.write_text(json.dumps(out), encoding='utf-8')
    total = sum(len(v['dates']) for v in out.values())
    print(f'\nWritten: {dest}  ({len(out)} commodities, {total} total rows)')
    print('Next: python research/ml_demand.py')


if __name__ == '__main__':
    run()
