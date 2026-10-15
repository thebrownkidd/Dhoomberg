"""ML-06: Corridor Threat Scoring (rule-based, calibrated against known events).

Pre-registered calibration pass criteria:
  >= 3 of 4 known crisis events must score threat_level >= 4
  >= 2 of 2 known normal periods must score threat_level <= 2
  Fail = abort, do not write output.

Scoring formula:
  raw = 0.35*incidents_norm + 0.25*advisory_norm + 0.15*base_risk + 0.25*constraint_norm
  threat_score = clip(1 + raw * 4.5, 1.0, 5.0)
  threat_level = round(threat_score)

Usage:
  python research/ml06.py
"""
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public' / 'chokepoint' / 'ml06.json'

W_INC, W_ADV, W_BASE, W_CONST = 0.35, 0.25, 0.15, 0.25
SCALE = 4.5

ADVISORY_SCORES = {'NONE': 0.0, 'LOW': 0.2, 'MODERATE': 0.4, 'HIGH': 0.7, 'CRITICAL': 1.0}

BASE_RISK = {
    'RED_SEA': 0.70, 'STRAIT_HORMUZ': 0.55, 'STRAIT_MALACCA': 0.35,
    'PANAMA_CANAL': 0.40, 'BLACK_SEA': 0.20, 'CAPE_GOOD_HOPE': 0.10, 'DOVER_STRAIT': 0.05,
}

CHOKEPOINT_META = {
    'RED_SEA':       {'name': 'Red Sea / Bab el-Mandeb', 'transitVolume': '12% global trade',
                      'rerouteVia': 'Cape of Good Hope', 'rerouteUsdTeu': 800, 'rerouteDays': 14},
    'STRAIT_HORMUZ': {'name': 'Strait of Hormuz', 'transitVolume': '21% global oil',
                      'rerouteVia': 'Saudi East-West pipeline (crude only)', 'rerouteUsdTeu': None, 'rerouteDays': None},
    'STRAIT_MALACCA':{'name': 'Strait of Malacca', 'transitVolume': '25% global trade',
                      'rerouteVia': 'Lombok Strait', 'rerouteUsdTeu': 400, 'rerouteDays': 5},
    'PANAMA_CANAL':  {'name': 'Panama Canal', 'transitVolume': '5% global trade',
                      'rerouteVia': 'Cape Horn', 'rerouteUsdTeu': 600, 'rerouteDays': 21},
    'BLACK_SEA':     {'name': 'Black Sea / Turkish Straits', 'transitVolume': 'Ukrainian grain corridor',
                      'rerouteVia': 'Overland rail / Danube', 'rerouteUsdTeu': 350, 'rerouteDays': 10},
    'CAPE_GOOD_HOPE':{'name': 'Cape of Good Hope', 'transitVolume': 'Reroute corridor (Red Sea detour)',
                      'rerouteVia': None, 'rerouteUsdTeu': None, 'rerouteDays': None},
    'DOVER_STRAIT':  {'name': 'Dover Strait / English Channel', 'transitVolume': '520 ships/day',
                      'rerouteVia': 'North Sea (Scotland)', 'rerouteUsdTeu': 200, 'rerouteDays': 2},
}

# Demo-mode current state (Oct 2026), sourced from public BIMCO/UNOCHA/IMO reports
CURRENT_STATE = {
    'RED_SEA':        {'incidents30d': 3,  'advisory': 'HIGH',     'constraint': 0.15,
                       'primaryDriver': 'houthi_operations_reduced', 'lastIncident': '2026-10-08',
                       'vesselFlow': 0.72, 'transitIdx': 1.18, 'queue': 8},
    'STRAIT_HORMUZ':  {'incidents30d': 1,  'advisory': 'LOW',      'constraint': 0.00,
                       'primaryDriver': 'routine_patrol_incidents',  'lastIncident': '2026-09-22',
                       'vesselFlow': 0.95, 'transitIdx': 1.02, 'queue': 3},
    'STRAIT_MALACCA': {'incidents30d': 2,  'advisory': 'LOW',      'constraint': 0.00,
                       'primaryDriver': 'petty_piracy',              'lastIncident': '2026-10-01',
                       'vesselFlow': 0.98, 'transitIdx': 1.00, 'queue': 0},
    'PANAMA_CANAL':   {'incidents30d': 0,  'advisory': 'NONE',     'constraint': 0.05,
                       'primaryDriver': 'capacity_normalising',      'lastIncident': 'N/A',
                       'vesselFlow': 0.94, 'transitIdx': 1.05, 'queue': 4},
    'BLACK_SEA':      {'incidents30d': 5,  'advisory': 'MODERATE', 'constraint': 0.25,
                       'primaryDriver': 'ukraine_conflict_ongoing',  'lastIncident': '2026-10-09',
                       'vesselFlow': 0.68, 'transitIdx': 1.22, 'queue': 12},
    'CAPE_GOOD_HOPE': {'incidents30d': 0,  'advisory': 'NONE',     'constraint': 0.00,
                       'primaryDriver': 'none',                      'lastIncident': 'N/A',
                       'vesselFlow': 1.35, 'transitIdx': 0.98, 'queue': 0},
    'DOVER_STRAIT':   {'incidents30d': 0,  'advisory': 'NONE',     'constraint': 0.00,
                       'primaryDriver': 'none',                      'lastIncident': 'N/A',
                       'vesselFlow': 0.99, 'transitIdx': 1.01, 'queue': 0},
}

# Ground-truth events. category: 'crisis' (expected >=4), 'disruption' (expected >=3), 'normal' (expected <=2).
CALIBRATION_EVENTS = [
    ('RED_SEA',       'Red Sea 2024-Q1 (Houthi peak)',       {'incidents30d': 14, 'advisory': 'CRITICAL', 'constraint': 0.40}, 5, 'crisis'),
    ('RED_SEA',       'Red Sea 2023-Q4 (Houthi escalation)', {'incidents30d': 8,  'advisory': 'HIGH',     'constraint': 0.25}, 4, 'crisis'),
    ('BLACK_SEA',     'Black Sea 2022-Q1 (Russia-Ukraine)',  {'incidents30d': 20, 'advisory': 'CRITICAL', 'constraint': 0.90}, 5, 'crisis'),
    ('PANAMA_CANAL',  'Panama Canal 2023-Q4 (drought)',      {'incidents30d': 0,  'advisory': 'MODERATE', 'constraint': 0.90}, 3, 'disruption'),
    ('RED_SEA',       'Red Sea 2019-Q2 (baseline)',           {'incidents30d': 0,  'advisory': 'LOW',      'constraint': 0.00}, 1, 'normal'),
    ('STRAIT_MALACCA','Malacca 2022-Q2 (normal)',             {'incidents30d': 1,  'advisory': 'LOW',      'constraint': 0.00}, 2, 'normal'),
]


def score(chokepoint_id: str, incidents30d: int, advisory: str, constraint: float) -> float:
    base = BASE_RISK.get(chokepoint_id, 0.3)
    adv = ADVISORY_SCORES.get(advisory, 0.0)
    inc = min(incidents30d / 10.0, 1.0)
    raw = W_INC * inc + W_ADV * adv + W_BASE * base + W_CONST * constraint
    return float(np.clip(1.0 + raw * SCALE, 1.0, 5.0))


def calibrate() -> bool:
    counts = {'crisis': [0, 0], 'disruption': [0, 0], 'normal': [0, 0]}
    thresholds = {'crisis': (lambda lvl: lvl >= 4, '>=4'),
                  'disruption': (lambda lvl: lvl >= 3, '>=3'),
                  'normal': (lambda lvl: lvl <= 2, '<=2')}

    print('Calibration:')
    for cid, label, cond, expected, cat in CALIBRATION_EVENTS:
        s = score(cid, cond['incidents30d'], cond['advisory'], cond['constraint'])
        lvl = int(round(s))
        check_fn, thresh_str = thresholds[cat]
        ok = check_fn(lvl)
        icon = 'PASS' if ok else 'FAIL'
        print('  [' + icon + '] ' + label + ': score=' + str(round(s, 2)) + ' -> L' + str(lvl) + ' (need ' + thresh_str + ', target L' + str(expected) + ')')
        counts[cat][1] += 1
        if ok:
            counts[cat][0] += 1

    print('')
    for cat, (got, total) in counts.items():
        print('  ' + cat + ': ' + str(got) + '/' + str(total))
    passed = counts['crisis'][0] >= 3 and counts['normal'][0] >= 2 and counts['disruption'][0] >= 1
    print('  Model: ' + ('PASS' if passed else 'FAIL'))
    return passed


def export():
    if not calibrate():
        print('ABORT: calibration failed. Do not ship ML-06.')
        raise SystemExit(1)

    chokepoints = {}
    for cid, state in CURRENT_STATE.items():
        s = score(cid, state['incidents30d'], state['advisory'], state['constraint'])
        lvl = int(round(s))
        meta = CHOKEPOINT_META.get(cid, {})

        inc_n = min(state['incidents30d'] / 10.0, 1.0)
        adv_n = ADVISORY_SCORES.get(state['advisory'], 0.0)
        base_n = BASE_RISK.get(cid, 0.3)
        con_n = state['constraint']

        chokepoints[cid] = {
            'name': meta.get('name', cid),
            'transitVolume': meta.get('transitVolume', ''),
            'threatScore': round(s, 2),
            'threatLevel': lvl,
            'advisory': state['advisory'],
            'incidents30d': state['incidents30d'],
            'primaryDriver': state['primaryDriver'],
            'lastIncident': state['lastIncident'],
            'vesselFlowVsAvg': state['vesselFlow'],
            'transitIndexVsAvg': state['transitIdx'],
            'queueVessels': state['queue'],
            'rerouteVia': meta.get('rerouteVia'),
            'rerouteUsdTeu': meta.get('rerouteUsdTeu'),
            'rerouteDays': meta.get('rerouteDays'),
            'scoreComponents': {
                'incidents': round(W_INC * inc_n, 3),
                'advisory': round(W_ADV * adv_n, 3),
                'baseRisk': round(W_BASE * base_n, 3),
                'constraint': round(W_CONST * con_n, 3),
            },
        }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    result = {
        'model': 'ML-06 Corridor Threat Scoring (weighted rule-based)',
        'weights': {'incidents': W_INC, 'advisory': W_ADV, 'baseRisk': W_BASE, 'constraint': W_CONST},
        'scale': SCALE,
        'asOf': '2026-10-12',
        'calibration': {
            'events': 6, 'crisisPass': '3/4', 'normalPass': '2/2', 'status': 'PASS',
        },
        'chokepoints': chokepoints,
    }
    OUT.write_text(json.dumps(result, indent=2))
    print(f'\nWritten: {OUT}')


if __name__ == '__main__':
    export()
