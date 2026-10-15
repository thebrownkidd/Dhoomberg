"""Fetch commodity news from free sources and write public/news/news.json.

Sources (in priority order):
  1. Alpha Vantage News & Sentiment API  — commodity-ticker-specific, free key required
  2. CNBC Commodities RSS                — metals/energy focus, no key
  3. USDA NASS press releases RSS        — agricultural reports, no key
  4. EIA Today In Energy RSS             — energy reports, no key

Output: public/news/news.json
  Format: {"asOf": str, "items": [NewsItem, ...]}

  NewsItem: {
    "id": str,           unique hash
    "headline": str,
    "summary": str,
    "source": str,       "Alpha Vantage" | "CNBC" | "USDA" | "EIA"
    "url": str,
    "publishedAt": str,  ISO 8601
    "commodities": [str, ...],  e.g. ["BRENT", "WTI"]
    "sentiment": "bullish" | "bearish" | "neutral" | null,
    "sentimentScore": float | null,   -1..1
    "tags": [str, ...],  e.g. ["energy", "opec", "crude"]
  }

Usage:
  python research/fetch_news.py [--av-key YOUR_KEY]
  Set ALPHA_VANTAGE_KEY env var or pass --av-key flag.
"""
import argparse
import hashlib
import json
import os
import sys
import time
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
from pathlib import Path
from email.utils import parsedate_to_datetime

ROOT = Path(__file__).resolve().parents[1]
OUT  = ROOT / 'public' / 'news' / 'news.json'

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json,text/xml,application/rss+xml,*/*',
}

MAX_AGE_DAYS = 14   # drop items older than this
MAX_ITEMS    = 100  # total items in output

# Commodity ticker → our internal ID (for Alpha Vantage tickers)
AV_TICKER_MAP = {
    'CORN': 'MAIZE', 'SOYB': 'SOYBEANS', 'WEAT': 'WHEAT',
    'CANE': 'SUGAR', 'JO': 'ORANGE', 'PALL': 'PLATINUM',
    'GLD': 'GOLD', 'SLV': 'SILVER', 'CPER': 'COPPER',
    'USO': 'WTI', 'BNO': 'BRENT', 'UNG': 'NATGAS_US',
    'PDBC': 'BRENT',
}

# Keyword → commodity IDs for RSS tagging
KEYWORD_COMMODITY = {
    'crude oil': ['BRENT', 'WTI', 'DUBAI'],
    'brent': ['BRENT'], 'wti': ['WTI'],
    'natural gas': ['NATGAS_US', 'NATGAS_EU'],
    'gold': ['GOLD'], 'silver': ['SILVER'], 'platinum': ['PLATINUM'],
    'copper': ['COPPER'], 'aluminum': ['ALU'], 'aluminium': ['ALU'],
    'nickel': ['NICKEL'], 'zinc': ['ZINC'], 'iron ore': ['IRON'],
    'wheat': ['WHEAT', 'WHEAT_SRW'], 'corn': ['MAIZE'], 'maize': ['MAIZE'],
    'soybean': ['SOYBEANS', 'SOYOIL', 'SOYMEAL'], 'soy': ['SOYBEANS'],
    'sugar': ['SUGAR'], 'cocoa': ['COCOA'], 'coffee': ['COFFEE', 'COFFEE_ROB'],
    'cotton': ['COTTON'], 'rubber': ['RUBBER'], 'palm oil': ['PALM'],
    'fertilizer': ['UREA', 'DAP', 'TSP', 'POTASH'],
    'coal': ['COAL_AU'], 'rice': ['RICE'],
    'beef': ['BEEF'], 'chicken': ['CHICKEN'],
    'opec': ['BRENT', 'WTI', 'DUBAI'],
    'usda': ['WHEAT', 'MAIZE', 'SOYBEANS', 'RICE', 'COTTON'],
    'wasde': ['WHEAT', 'MAIZE', 'SOYBEANS', 'RICE', 'COTTON', 'SUGAR'],
    'eia': ['BRENT', 'WTI', 'NATGAS_US'],
}


def uid(text: str) -> str:
    return hashlib.md5(text.encode()).hexdigest()[:12]


def tag_commodities(text: str) -> list[str]:
    text_lower = text.lower()
    found = set()
    for kw, cids in KEYWORD_COMMODITY.items():
        if kw in text_lower:
            found.update(cids)
    return sorted(found)


def parse_rfc2822(s: str) -> str:
    """Parse RSS pubDate (RFC 2822) → ISO 8601 UTC string."""
    try:
        dt = parsedate_to_datetime(s)
        return dt.astimezone(timezone.utc).isoformat()
    except Exception:
        return datetime.now(timezone.utc).isoformat()


def is_recent(iso_str: str) -> bool:
    try:
        dt = datetime.fromisoformat(iso_str.replace('Z', '+00:00'))
        return datetime.now(timezone.utc) - dt < timedelta(days=MAX_AGE_DAYS)
    except Exception:
        return True


# ── Source 1: Alpha Vantage ────────────────────────────────────────────────────

def fetch_alpha_vantage(api_key: str) -> list[dict]:
    items = []
    # Commodity-focused tickers + general commodities topic
    tickers = 'CORN,WEAT,GLD,SLV,USO,UNG,CPER'
    url = (f'https://www.alphavantage.co/query?function=NEWS_SENTIMENT'
           f'&tickers={tickers}&topics=commodities,energy,finance'
           f'&limit=50&apikey={api_key}')
    print('Alpha Vantage ...', end=' ', flush=True)
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read())
        feed = data.get('feed', [])
        if not feed:
            note = data.get('Information', data.get('Note', 'empty'))
            print(f'SKIP ({note[:60]})')
            return []
        for art in feed:
            pub = art.get('time_published', '')
            # AV format: 20241010T143000
            try:
                dt = datetime.strptime(pub[:15], '%Y%m%dT%H%M%S').replace(tzinfo=timezone.utc)
                iso = dt.isoformat()
            except ValueError:
                iso = datetime.now(timezone.utc).isoformat()
            if not is_recent(iso):
                continue
            # AV ticker sentiment
            cids = set()
            overall = art.get('overall_sentiment_label', 'neutral').lower()
            score = float(art.get('overall_sentiment_score', 0))
            for ts in art.get('ticker_sentiment', []):
                tk = ts.get('ticker', '')
                if tk in AV_TICKER_MAP:
                    cids.add(AV_TICKER_MAP[tk])
            headline = art.get('title', '')
            cids.update(tag_commodities(headline + ' ' + art.get('summary', '')))
            items.append({
                'id': uid(headline + iso),
                'headline': headline,
                'summary': art.get('summary', '')[:300],
                'source': art.get('source', 'Alpha Vantage'),
                'url': art.get('url', ''),
                'publishedAt': iso,
                'commodities': sorted(cids),
                'sentiment': overall if overall in ('bullish', 'bearish', 'neutral') else 'neutral',
                'sentimentScore': round(score, 3),
                'tags': [],
            })
        print(f'OK  {len(items)} articles')
    except Exception as e:
        print(f'ERR {e}')
    return items


# ── Source 2–4: RSS feeds ──────────────────────────────────────────────────────

RSS_FEEDS = [
    ('CNBC Commodities', 'https://www.cnbc.com/id/19832390/device/rss/rss.html', ['energy', 'metals']),
    ('USDA News',        'https://www.nass.usda.gov/rss/News.xml',               ['agriculture', 'usda']),
    ('EIA Today',        'https://www.eia.gov/rss/todayinenergy.xml',            ['energy', 'eia']),
]


def fetch_rss(name: str, url: str, default_tags: list[str]) -> list[dict]:
    items = []
    print(f'RSS   {name} ...', end=' ', flush=True)
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read()
        root = ET.fromstring(raw)
        ns = ''
        channel = root.find('channel') or root
        entries = channel.findall('item')
        if not entries:  # Atom format fallback
            ns = '{http://www.w3.org/2005/Atom}'
            entries = root.findall(f'{ns}entry')
        count = 0
        for item in entries:
            def g(tag):
                el = item.find(tag) or item.find(f'{ns}{tag}')
                return (el.text or '').strip() if el is not None else ''
            title  = g('title')
            link   = g('link') or g('id')
            desc   = g('description') or g('summary')
            pub    = g('pubDate') or g('published') or g('updated')
            iso    = parse_rfc2822(pub) if pub else datetime.now(timezone.utc).isoformat()
            if not is_recent(iso):
                continue
            cids = tag_commodities(title + ' ' + desc)
            items.append({
                'id': uid(title + iso),
                'headline': title,
                'summary': desc[:300],
                'source': name,
                'url': link,
                'publishedAt': iso,
                'commodities': cids,
                'sentiment': None,
                'sentimentScore': None,
                'tags': default_tags,
            })
            count += 1
        print(f'OK  {count} items')
    except Exception as e:
        print(f'ERR {e}')
    return items


# ── Main ──────────────────────────────────────────────────────────────────────

def run(av_key: str | None):
    all_items: list[dict] = []

    if av_key:
        all_items.extend(fetch_alpha_vantage(av_key))
        time.sleep(1.0)

    for name, url, tags in RSS_FEEDS:
        all_items.extend(fetch_rss(name, url, tags))
        time.sleep(0.5)

    # Deduplicate by id
    seen = set()
    unique = []
    for item in all_items:
        if item['id'] not in seen:
            seen.add(item['id'])
            unique.append(item)

    # Sort newest first, keep MAX_ITEMS
    unique.sort(key=lambda x: x['publishedAt'], reverse=True)
    unique = unique[:MAX_ITEMS]

    doc = {
        'asOf': datetime.now(timezone.utc).isoformat(),
        'sources': {
            'alphaVantage': bool(av_key),
            'cnbc': True,
            'usda': True,
            'eia': True,
        },
        'items': unique,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, indent=1), encoding='utf-8')
    print(f'\nWritten: {OUT}  ({len(unique)} items)')
    if not av_key:
        print('Tip: set ALPHA_VANTAGE_KEY env var or pass --av-key for commodity-ticker-specific news.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--av-key', default=os.environ.get('ALPHA_VANTAGE_KEY', ''))
    args = parser.parse_args()
    run(args.av_key or None)
