"""Download additional Yahoo Finance continuous-contract JSON files.
Usage: python research/fetch_yahoo.py
"""
import json, time, urllib.request, urllib.error
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / 'research' / 'data' / 'raw' / 'yahoo'
OUT.mkdir(parents=True, exist_ok=True)

SYMBOLS = ['NG', 'HG', 'GC', 'SI', 'PL', 'OJ', 'LB']  # natgas, copper, gold, silver, platinum, OJ, lumber

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
}

for sym in SYMBOLS:
    dest = OUT / f'{sym}.json'
    if dest.exists():
        print(f'SKIP  {sym}  (already exists)')
        continue
    url = f'https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=1d&range=max'
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read())
        result = data.get('chart', {}).get('result') or []
        if not result:
            print(f'FAIL  {sym}  no result in response')
            continue
        dest.write_text(json.dumps(data), encoding='utf-8')
        n = len(result[0].get('timestamp', []))
        print(f'OK    {sym}  {n} days')
    except urllib.error.HTTPError as e:
        print(f'HTTP  {sym}  {e.code} {e.reason}')
    except Exception as e:
        print(f'ERR   {sym}  {e}')
    time.sleep(1.5)
