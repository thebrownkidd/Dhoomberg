"""ML-09: Composite Shipment Risk Score + Forecast Signal.

Aggregates per shipping lane:
  - ML-05 delay probability: cold-start baselines from Sea-Intelligence (no user shipments yet)
  - ML-06 corridor threat: from public/chokepoint/ml06.json
  - Carrier reliability: Sea-Intelligence schedule reliability index (public summary, Oct 2026)
  - ML-08 supplier risk: from public/supplier/ml08.json (averaged by origin country)

Weights: 30% delay + 25% corridor + 25% carrier risk + 20% supplier risk

Forecast signal thresholds:
  score > 70 + deteriorating → ADD_COVER +7d
  score > 70 + stable        → ADD_COVER +3d
  40-70                      → MONITOR
  < 40 + improving           → REDUCE_COVER -2d

Usage:
  python research/ml09.py   (requires ml06.json and ml08.json already written)
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public' / 'lanes' / 'ml09.json'
ML06_PATH = ROOT / 'public' / 'chokepoint' / 'ml06.json'
ML08_PATH = ROOT / 'public' / 'supplier' / 'ml08.json'

W_DELAY, W_CORR, W_CARR, W_SUPP = 0.30, 0.25, 0.25, 0.20

# Sea-Intelligence Global Liner Performance, carrier schedule reliability (%, Oct 2026).
# Source: Sea-Intelligence.com monthly report (summary data published free).
CARRIER_RELIABILITY = {
    'Maersk': 65, 'Hapag-Lloyd': 62, 'COSCO': 61, 'OOCL': 63,
    'MSC': 58, 'ONE': 57, 'HMM': 59, 'CMA CGM': 55,
    'Evergreen': 54, 'Yang Ming': 51, 'ZIM': 52, 'PIL': 48,
}

# Cold-start delay probability baselines per lane.
# Based on Sea-Intelligence lane reliability + current ML-06 corridor conditions.
# Will be replaced by ML-05 actuals once 200+ historical shipments/lane are accumulated.
LANES = [
    {'lane': 'IN-NHAVA SHEVA to NL-ROTTERDAM',     'delay_prob': 0.48, 'carrier': 'MSC',         'corridor': 'RED_SEA'},
    {'lane': 'IN-MUNDRA to DE-HAMBURG',             'delay_prob': 0.51, 'carrier': 'Hapag-Lloyd', 'corridor': 'RED_SEA'},
    {'lane': 'TH-LAEM CHABANG to NL-ROTTERDAM',    'delay_prob': 0.45, 'carrier': 'Evergreen',   'corridor': 'RED_SEA'},
    {'lane': 'BR-SANTOS to NL-ROTTERDAM',           'delay_prob': 0.38, 'carrier': 'CMA CGM',     'corridor': 'CAPE_GOOD_HOPE'},
    {'lane': 'UA-ODESA to TR-ISTANBUL',             'delay_prob': 0.72, 'carrier': 'ZIM',         'corridor': 'BLACK_SEA'},
    {'lane': 'VN-HO CHI MINH to NL-ROTTERDAM',     'delay_prob': 0.43, 'carrier': 'COSCO',       'corridor': 'STRAIT_MALACCA'},
    {'lane': 'ID-TANJUNG PRIOK to BE-ANTWERP',      'delay_prob': 0.47, 'carrier': 'ONE',         'corridor': 'STRAIT_MALACCA'},
    {'lane': 'CO-CARTAGENA to DE-HAMBURG',          'delay_prob': 0.39, 'carrier': 'Maersk',      'corridor': 'PANAMA_CANAL'},
    {'lane': 'CI-ABIDJAN to NL-ROTTERDAM',          'delay_prob': 0.44, 'carrier': 'HMM',         'corridor': 'CAPE_GOOD_HOPE'},
]

ORIGIN_ISO = {
    'IN': 'IND', 'TH': 'THA', 'BR': 'BRA', 'UA': 'UKR',
    'VN': 'VNM', 'ID': 'IDN', 'CO': 'COL', 'CI': 'CIV',
}


def corridor_norm(chokepoints: dict, corridor_id: str) -> float:
    lvl = chokepoints.get(corridor_id, {}).get('threatLevel', 2)
    return (lvl - 1) / 4.0


def carrier_risk_norm(carrier: str) -> float:
    rel = CARRIER_RELIABILITY.get(carrier, 55) / 100.0
    return 1.0 - rel


def supplier_risk_norm(suppliers: list, lane_str: str) -> float:
    origin_code = lane_str[:2]
    iso = ORIGIN_ISO.get(origin_code)
    if not iso:
        return 0.5
    matching = [s['riskScore'] for s in suppliers if s['country'] == iso]
    avg = sum(matching) / len(matching) if matching else 50.0
    return avg / 100.0


def forecast_signal(score: float, trend: str) -> dict:
    if score > 70:
        days = 7 if trend == 'deteriorating' else 3
        return {'action': 'ADD_COVER', 'daysToAdd': days}
    if score > 40:
        return {'action': 'MONITOR', 'daysToAdd': 0}
    return {'action': 'REDUCE_COVER', 'daysToAdd': -2}


def export():
    if not ML06_PATH.exists():
        print('ERROR: ml06.json missing. Run research/ml06.py first.')
        raise SystemExit(1)
    if not ML08_PATH.exists():
        print('ERROR: ml08.json missing. Run research/ml08.py first.')
        raise SystemExit(1)

    chokepoints = json.loads(ML06_PATH.read_text())['chokepoints']
    suppliers = json.loads(ML08_PATH.read_text())['suppliers']

    lanes_out = []
    for lane_data in LANES:
        lane = lane_data['lane']
        delay_p = lane_data['delay_prob']
        carrier = lane_data['carrier']
        corridor = lane_data['corridor']

        corr_n = corridor_norm(chokepoints, corridor)
        carr_n = carrier_risk_norm(carrier)
        supp_n = supplier_risk_norm(suppliers, lane)

        raw = (W_DELAY * delay_p + W_CORR * corr_n + W_CARR * carr_n + W_SUPP * supp_n) * 100
        raw = round(raw, 1)

        # Trend: simple signal from corridor threat vs baseline + delay deviation from 0.45 mean
        trend_signal = corr_n * 0.2 + (delay_p - 0.45) * 0.3
        trend = 'deteriorating' if trend_signal > 0.04 else ('improving' if trend_signal < -0.04 else 'stable')

        comp = {
            'delay': (W_DELAY * delay_p, 'delay'),
            'corridor': (W_CORR * corr_n, 'corridor'),
            'carrier': (W_CARR * carr_n, 'carrier'),
            'supplier': (W_SUPP * supp_n, 'supplier'),
        }
        top = max(comp, key=lambda k: comp[k][0])

        signal = forecast_signal(raw, trend)
        rag = 'RED' if raw > 70 else 'AMBER' if raw > 40 else 'GREEN'

        lanes_out.append({
            'lane': lane,
            'corridor': corridor,
            'carrier': carrier,
            'laneRiskScore': raw,
            'ragStatus': rag,
            'riskTrend': trend,
            'topDriver': top,
            'forecastSignal': signal,
            'componentScores': {
                'delayProbability': round(delay_p, 3),
                'corridorThreatNorm': round(corr_n, 3),
                'carrierRisk': round(carr_n, 3),
                'supplierRiskNorm': round(supp_n, 3),
            },
        })
        print(f"  {rag:5s} {raw:5.1f} {trend:13s}  {lane}")

    lanes_out.sort(key=lambda x: -x['laneRiskScore'])

    OUT.parent.mkdir(parents=True, exist_ok=True)
    result = {
        'model': 'ML-09 Composite Shipment Risk + Forecast Signal',
        'weights': {'delay': W_DELAY, 'corridor': W_CORR, 'carrier': W_CARR, 'supplier': W_SUPP},
        'ml05Note': 'Delay probability from cold-start lane baselines (Sea-Intelligence). Replace with ML-05 actuals once 200+ shipments/lane accumulate.',
        'ml07Note': 'Vessel behavioural risk not included: requires AIS subscription.',
        'asOf': '2026-10-12',
        'lanes': lanes_out,
    }
    OUT.write_text(json.dumps(result, indent=2))
    print(f'Written: {OUT}')


if __name__ == '__main__':
    export()
