"""Download demand-side indicators for ML models and the Demand panel.

Sources:
  FRED - INDPRO          US Industrial Production Index (monthly, 1919-)
  FRED - NAPM            ISM Manufacturing PMI (monthly, 1948-)
  FRED - WTISTUS         EIA US crude oil inventories in thousand barrels (weekly, 1982-)
  FRED - UMCSENT         U Michigan Consumer Sentiment (monthly, 1952-)
  FRED - USALOLITONOSTSAM  OECD Composite Leading Indicator, US (monthly, 1955-)
  FAO  - FFPI            FAO Food Price Index + sub-indices (monthly, 1990-)

Output: research/data/raw/demand/{SERIES}.json
  Format: {"dates": ["YYYY-MM", ...], "values": [float, ...], "name": str, "source": str}

Usage:
  python research/fetch_demand.py
"""
import csv, io, json, time, urllib.request, urllib.error
from datetime import datetime, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / 'research' / 'data' / 'raw' / 'demand'
OUT.mkdir(parents=True, exist_ok=True)

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/csv,application/json,*/*',
}

FRED_SERIES = [
    ('INDPRO',              'US Industrial Production (2017=100)',   'FRED'),
    ('NAPM',                'ISM Manufacturing PMI',                 'FRED'),
    ('WTISTUS',             'US Crude Oil Inventories (k bbl)',      'FRED'),
    ('UMCSENT',             'U Michigan Consumer Sentiment',         'FRED'),
    ('USALOLITONOSTSAM',    'OECD CLI United States',                'FRED'),
]


def fred_download(series_id, name, source):
    dest = OUT / f'{series_id}.json'
    print(f'FRED  {series_id} ...', end=' ', flush=True)
    url = f'https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}'
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode('utf-8')
        reader = csv.DictReader(io.StringIO(raw))
        # FRED CSV header can be "DATE" or "observation_date"
        dates, values = [], []
        for row in reader:
            date_str = row.get('DATE') or row.get('observation_date') or ''
            val_str = list(row.values())[-1] if len(row) > 1 else ''
            if not date_str or not val_str or val_str.strip() in ('.', '', 'NA'):
                continue
            try:
                dt = datetime.strptime(date_str.strip(), '%Y-%m-%d')
                dates.append(dt.strftime('%Y-%m'))
                values.append(float(val_str))
            except ValueError:
                continue
        if not dates:
            print('FAIL (empty)')
            return
        doc = {'dates': dates, 'values': values, 'name': name, 'source': source}
        dest.write_text(json.dumps(doc), encoding='utf-8')
        print(f'OK  {len(dates)} months  {dates[0]}..{dates[-1]}')
    except Exception as e:
        print(f'ERR {e}')


def fao_ffpi():
    """Download FAO Food Price Index from FAOSTAT API or CSV fallback."""
    dest = OUT / 'FAO_FFPI.json'
    print('FAO   FFPI ...', end=' ', flush=True)
    # FAOSTAT API for food price indices (CP domain)
    urls = [
        # API endpoint (may return 521)
        'https://fenixservices.fao.org/faostat/api/v1/en/data/CP?area=*&element=5&item=23676,23677,23678,23679,23680,23681&year=*&type=reporter&output_type=csv',
        # Direct CSV from known file path (FAO updates filename with month/year)
        'https://www.fao.org/fileadmin/templates/worldfood/Reports_and_docs/Food_price_indices_data_jul25.xlsx',
    ]
    # Try JSON from the simpler endpoint
    api_url = 'https://fenixservices.fao.org/faostat/api/v1/en/data/CP?area=World&element=5&item=23676&year=*&output_type=json&page_size=5000'
    try:
        req = urllib.request.Request(api_url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read())
        items = data.get('data', [])
        if items:
            dates, values = [], []
            for row in sorted(items, key=lambda x: x.get('Year', '')):
                yr = row.get('Year')
                mon = row.get('Months_Code', '').replace('M', '')
                val = row.get('Value')
                if yr and mon and val is not None:
                    try:
                        dates.append(f'{yr}-{int(mon):02d}')
                        values.append(float(val))
                    except (ValueError, TypeError):
                        continue
            if dates:
                doc = {'dates': dates, 'values': values, 'name': 'FAO Food Price Index (2014-2016=100)', 'source': 'FAO FAOSTAT'}
                dest.write_text(json.dumps(doc), encoding='utf-8')
                print(f'OK  {len(dates)} months  {dates[0]}..{dates[-1]}')
                return
        print('FAIL (no data in API response)')
    except urllib.error.HTTPError as e:
        print(f'HTTP {e.code} - trying alternative ...')
    except Exception as e:
        print(f'ERR {e}')

    # Fallback: try the world food situation CSV
    try:
        csv_url = 'https://www.fao.org/worldfoodsituation/foodpricesindex/en/'
        # The actual data CSV is typically linked from this page; hardcode known URLs
        csv_direct = 'https://www.fao.org/fileadmin/templates/worldfood/Reports_and_docs/Food_Price_Indices_data_Jul25.csv'
        req = urllib.request.Request(csv_direct, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode('utf-8-sig')
        reader = csv.DictReader(io.StringIO(raw))
        dates, values = [], []
        for row in reader:
            yr = row.get('Year', '').strip()
            mon = row.get('Month', '').strip()
            val = row.get('Food Price Index', row.get('FFPI', '')).strip()
            if yr.isdigit() and mon.isdigit() and val:
                try:
                    dates.append(f'{yr}-{int(mon):02d}')
                    values.append(float(val))
                except ValueError:
                    continue
        if dates:
            doc = {'dates': dates, 'values': values, 'name': 'FAO Food Price Index (2014-2016=100)', 'source': 'FAO'}
            dest.write_text(json.dumps(doc), encoding='utf-8')
            print(f'OK (CSV fallback)  {len(dates)} months')
            return
        print('FAIL (CSV fallback empty)')
    except Exception as e:
        print(f'ERR CSV fallback: {e}')


if __name__ == '__main__':
    for series_id, name, source in FRED_SERIES:
        fred_download(series_id, name, source)
        time.sleep(1.0)
    fao_ffpi()
    print('\nDone. Files written to:', OUT)
    print('Next: python research/ml_demand.py')
