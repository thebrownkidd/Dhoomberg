"""ML-08: Supply Chain Risk Scoring.

Four dimensions (weights 30/25/25/20):
  1. Concentration  (30%): synthetic spend data — replace with user ERP
  2. Financial      (25%): synthetic credit scores — replace with D&B
  3. Geopolitical   (25%): World Bank WGI 2023 + ACLED event count (approximated)
  4. Climate        (20%): ND-GAIN 2022 country index

Deterministic weighted scoring, no training required.
Synthetic dimensions are clearly labelled in the output.

Usage:
  python research/ml08.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public' / 'supplier' / 'ml08.json'

W_CONC, W_FIN, W_GEO, W_CLIM = 0.30, 0.25, 0.25, 0.20

# World Bank WGI Political Stability & Absence of Violence, 2023
# Percentile rank 0-100 (higher = more stable). Source: WB WGI 2023 report.
WGI_POLSTAB = {
    'BRA': 38, 'IND': 29, 'IDN': 48, 'CIV': 35, 'GHA': 56,
    'UKR': 8,  'RUS': 24, 'THA': 38, 'VNM': 52, 'COL': 25,
    'NLD': 82, 'DEU': 85,
}

# ND-GAIN Country Index, 2022 (0-100, higher = more resilient to climate risk).
# Source: Notre Dame Global Adaptation Initiative, gain.nd.edu
ND_GAIN = {
    'BRA': 54.1, 'IND': 48.8, 'IDN': 51.2, 'CIV': 38.5, 'GHA': 43.2,
    'UKR': 55.8, 'RUS': 57.0, 'THA': 55.4, 'VNM': 49.6, 'COL': 50.3,
    'NLD': 74.8, 'DEU': 73.2,
}

# ACLED conflict events within 200km of major production zones, approx 90-day count Oct 2026.
# Source: ACLED public dashboard (acleddata.com) — approximate counts, not API query.
ACLED_90D = {
    'BRA': 4,  'IND': 12, 'IDN': 3,  'CIV': 8,  'GHA': 1,
    'UKR': 95, 'RUS': 88, 'THA': 5,  'VNM': 2,  'COL': 22,
    'NLD': 0,  'DEU': 0,
}

# Synthetic suppliers (would come from user ERP in production).
# spend_pct: fraction of total raw material spend on this supplier
# credit_score: 0-100 (higher=safer credit); proxy for D&B score
# dpo_trend: payment behaviour trend
SUPPLIERS = [
    {'id': 'SUP-001', 'name': 'Agrofarm Brasil S.A.',        'country': 'BRA', 'commodity': 'SUGAR',
     'spend_pct': 0.34, 'credit_score': 68, 'dpo_trend': 'stable'},
    {'id': 'SUP-002', 'name': 'Ivory Coast Cocoa Corp.',      'country': 'CIV', 'commodity': 'COCOA',
     'spend_pct': 0.52, 'credit_score': 55, 'dpo_trend': 'worsening'},
    {'id': 'SUP-003', 'name': 'Kyiv Grain Exports Ltd.',      'country': 'UKR', 'commodity': 'WHEAT',
     'spend_pct': 0.29, 'credit_score': 42, 'dpo_trend': 'worsening'},
    {'id': 'SUP-004', 'name': 'Indoplant Resources',          'country': 'IDN', 'commodity': 'PALM',
     'spend_pct': 0.18, 'credit_score': 74, 'dpo_trend': 'stable'},
    {'id': 'SUP-005', 'name': 'Vietnam Coffee Consortium',    'country': 'VNM', 'commodity': 'COFFEE',
     'spend_pct': 0.22, 'credit_score': 78, 'dpo_trend': 'stable'},
    {'id': 'SUP-006', 'name': 'Andean Cotton Group',          'country': 'COL', 'commodity': 'COTTON',
     'spend_pct': 0.15, 'credit_score': 64, 'dpo_trend': 'stable'},
    {'id': 'SUP-007', 'name': 'Gold Grain India',             'country': 'IND', 'commodity': 'RICE',
     'spend_pct': 0.41, 'credit_score': 70, 'dpo_trend': 'stable'},
    {'id': 'SUP-008', 'name': 'Thailand Rice Exports Co.',    'country': 'THA', 'commodity': 'RICE',
     'spend_pct': 0.35, 'credit_score': 73, 'dpo_trend': 'stable'},
    {'id': 'SUP-009', 'name': 'Rhin Valley Aluminium NV',     'country': 'NLD', 'commodity': 'ALU',
     'spend_pct': 0.12, 'credit_score': 88, 'dpo_trend': 'stable'},
    {'id': 'SUP-010', 'name': 'Cerrado Soy Trading',          'country': 'BRA', 'commodity': 'SOYOIL',
     'spend_pct': 0.27, 'credit_score': 66, 'dpo_trend': 'stable'},
    {'id': 'SUP-011', 'name': 'Ghana Farms Co-op',            'country': 'GHA', 'commodity': 'COCOA',
     'spend_pct': 0.28, 'credit_score': 60, 'dpo_trend': 'stable'},
    {'id': 'SUP-012', 'name': 'Pampa Wheat Exporters',        'country': 'BRA', 'commodity': 'WHEAT',
     'spend_pct': 0.20, 'credit_score': 72, 'dpo_trend': 'stable'},
]


def concentration_score(spend_pct: float) -> float:
    return float(min(100.0, spend_pct / 0.40 * 100.0))


def financial_score(credit: float, dpo_trend: str) -> float:
    base = 100.0 - credit
    penalty = 15.0 if dpo_trend == 'worsening' else 0.0
    return float(min(100.0, base + penalty))


def geopolitical_score(country: str) -> float:
    wgi = WGI_POLSTAB.get(country, 50)
    acled = ACLED_90D.get(country, 5)
    wgi_risk = 100.0 - wgi
    acled_risk = min(100.0, acled)   # cap at 100
    return float(0.6 * wgi_risk + 0.4 * acled_risk)


def climate_score(country: str) -> float:
    ndgain = ND_GAIN.get(country, 50.0)
    return float(max(0.0, 100.0 - ndgain))


def rag(score: float) -> str:
    return 'RED' if score >= 70 else 'AMBER' if score >= 40 else 'GREEN'


def export():
    scored = []
    for s in SUPPLIERS:
        conc = concentration_score(s['spend_pct'])
        fin  = financial_score(s['credit_score'], s['dpo_trend'])
        geo  = geopolitical_score(s['country'])
        clim = climate_score(s['country'])
        total = W_CONC * conc + W_FIN * fin + W_GEO * geo + W_CLIM * clim

        dims = {'concentration': round(conc, 1), 'financial': round(fin, 1),
                'geopolitical': round(geo, 1), 'climate': round(clim, 1)}
        top = max(dims, key=lambda k: dims[k])

        scored.append({
            'id': s['id'],
            'name': s['name'],
            'country': s['country'],
            'commodity': s['commodity'],
            'riskScore': round(total, 1),
            'ragStatus': rag(total),
            'topDriver': top,
            'dimensions': dims,
            'spendPct': round(s['spend_pct'] * 100, 1),
            'creditScore': s['credit_score'],
            'dpoTrend': s['dpo_trend'],
        })
        print(f"  {s['id']} {s['name'][:30]:30s}: {rag(total)} {total:.0f}  top={top}")

    scored.sort(key=lambda x: -x['riskScore'])

    OUT.parent.mkdir(parents=True, exist_ok=True)
    result = {
        'model': 'ML-08 Supply Chain Risk Scoring',
        'weights': {'concentration': W_CONC, 'financial': W_FIN, 'geopolitical': W_GEO, 'climate': W_CLIM},
        'dataSources': {
            'concentration': 'SYNTHETIC (demo) — replace with user ERP spend data',
            'financial': 'SYNTHETIC (demo) — replace with D&B / Moody\'s credit scores',
            'geopolitical': 'World Bank WGI 2023 political stability + ACLED 90-day event count (approximated from public ACLED portal)',
            'climate': 'ND-GAIN Country Index 2022 (Notre Dame Global Adaptation Initiative)',
        },
        'asOf': '2026-10-12',
        'suppliers': scored,
    }
    OUT.write_text(json.dumps(result, indent=2))
    print(f'Written: {OUT}')


if __name__ == '__main__':
    export()
